"""
Composite Map 생성 모듈
여러 웨이퍼 맵의 인덱스별 빈도를 히트맵으로 시각화
"""
import json
import os
import shutil
import struct
import time
import warnings
import threading
import zlib
import zipfile
import copy
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Sequence, Callable
import re
import numpy as np
from PIL import Image
from PIL.Image import DecompressionBombWarning

_USE_NUMBA = os.getenv(
    "COMPOSITE_USE_NUMBA",
    "1",
).strip().lower() in {"1", "true", "yes", "y", "on"}
_NUMBA_CACHE = os.getenv(
    "COMPOSITE_NUMBA_CACHE",
    "1",
).strip().lower() in {"1", "true", "yes", "y", "on"}

try:
    if not _USE_NUMBA:
        raise RuntimeError("COMPOSITE_USE_NUMBA is disabled")
    from numba import njit, prange, get_num_threads as _numba_get_num_threads

    _HAS_NUMBA = True
except Exception:
    njit = None
    prange = None
    _numba_get_num_threads = None
    _HAS_NUMBA = False

from .config import (
    IMAGES_ROOT,
    COMPOSITE_MAX_WORKERS,
    COMPOSITE_LOADER_MODE,
    COMPOSITE_BATCH_SIZE,
    POSITIONS_ROOT,
    FALLBACK_LOGIN_ID,
)
from .personal_colors import load_color_legends, _scheme_to_palette_bytes, normalize_hex_color
from .composite_colors import load_composite_color_settings

try:
    from cython_grade_counts import count_grades as _cython_count_grades
except Exception:
    _cython_count_grades = None

try:
    import pyvips as _vips
    _HAS_PYVIPS = True
except Exception:
    _vips = None
    _HAS_PYVIPS = False

if not os.environ.get("OMP_NUM_THREADS"):
    _OMP_DEFAULT_THREADS = max(4, min(8, os.cpu_count() or 8))
    os.environ["OMP_NUM_THREADS"] = str(_OMP_DEFAULT_THREADS)

_HAS_TURBOJPEG = False
try:
    from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_444, TJSAMP_420

    _TURBOJPEG = TurboJPEG()
    _HAS_TURBOJPEG = True
except Exception:
    _TURBOJPEG = None

_SAVE_BACKEND = os.getenv("COMPOSITE_SAVE_BACKEND", "turbo" if _HAS_TURBOJPEG else "pil").lower()
_SAVE_FORMAT = os.getenv("COMPOSITE_FORMAT", "JPEG" if _HAS_TURBOJPEG else "PNG").upper()
_JPEG_QUALITY = int(os.getenv("COMPOSITE_JPEG_QUALITY", "95"))
try:
    _PALETTE_PNG_COMPRESSION_LEVEL = int(os.getenv("COMPOSITE_PALETTE_PNG_COMPRESSION_LEVEL", "1"))
except ValueError:
    _PALETTE_PNG_COMPRESSION_LEVEL = 1
_PALETTE_PNG_COMPRESSION_LEVEL = max(0, min(9, _PALETTE_PNG_COMPRESSION_LEVEL))
_CACHE_COMPRESS = os.getenv("COMPOSITE_CACHE_COMPRESS", "1").strip().lower() in {"1", "true", "yes", "y", "on"}
try:
    _CACHE_COMPRESS_LEVEL = int(os.getenv("COMPOSITE_CACHE_COMPRESS_LEVEL", "1"))
except ValueError:
    _CACHE_COMPRESS_LEVEL = 1
_CACHE_COMPRESS_LEVEL = max(0, min(9, _CACHE_COMPRESS_LEVEL))
_FAST_MEDIAN = True

# Worker configuration (configurable via environment variables)
# Default: 2 render + 4 save (optimized for low-end systems)
# High-end (32-core): Set COMPOSITE_RENDER_WORKERS=16, COMPOSITE_SAVE_WORKERS=32
_RENDER_WORKERS = int(os.environ.get("COMPOSITE_RENDER_WORKERS", "2"))
_SAVE_WORKERS = int(os.environ.get("COMPOSITE_SAVE_WORKERS", "4"))

# 🔥 Fast mode: if env 미설정이면 CPU 스펙에 맞춰 상향 조정
_FAST_MODE = os.getenv("COMPOSITE_FAST_MODE", "1").strip().lower() in {"1", "true", "yes", "y", "on"}
_CPU_COUNT = os.cpu_count() or 8
if _FAST_MODE and "COMPOSITE_RENDER_WORKERS" not in os.environ:
    # Render는 CPU 코어에 비례 (최대 32)
    _RENDER_WORKERS = max(4, min(32, _CPU_COUNT))
if _FAST_MODE and "COMPOSITE_SAVE_WORKERS" not in os.environ:
    # Save는 I/O 위주라 코어*2까지 허용 (최대 64)
    _SAVE_WORKERS = max(4, min(64, _CPU_COUNT * 2))
# 저장 백엔드도 fast 모드에서 vips를 우선 사용
if _FAST_MODE and _SAVE_BACKEND == "pil" and _HAS_PYVIPS:
    _SAVE_BACKEND = "vips"

Image.MAX_IMAGE_PIXELS = None
warnings.simplefilter("ignore", DecompressionBombWarning)

# Composite 맵 저장 디렉토리 (사용자별 하위 폴더)
COMPOSITE_ROOT = IMAGES_ROOT / "composite_map"
ANONYMOUS_LOGIN_ID = FALLBACK_LOGIN_ID
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)
(COMPOSITE_ROOT / ANONYMOUS_LOGIN_ID).mkdir(parents=True, exist_ok=True)
COMPOSITE_SESSION_DIRNAME = "current"
SQUARE_MAP_CACHE_FILENAME = "square_maps_data.npz"
_GRADE_RANGE = np.arange(8, dtype=np.uint8)
_SUBSET_NAME_RE = re.compile(r"^square_(weighted_)?average_([0-7]+)\.(png|jpg|jpeg|webp)$", re.IGNORECASE)
_SELECTED_REGION_PADDING_PX = 4


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(1, value)


_SHOT_COMPOSITE_BORDER_PX = _positive_int_env("SHOT_COMPOSITE_BORDER_PX", 3)
_SHOT_COMPOSITE_OUTER_BORDER_PX = _positive_int_env(
    "SHOT_COMPOSITE_OUTER_BORDER_PX",
    _SHOT_COMPOSITE_BORDER_PX,
)


def _normalize_selected_chip_coords(
    selected_chip_coords: Optional[Sequence[Tuple[int, int]]],
) -> Optional[set[Tuple[int, int]]]:
    if not selected_chip_coords:
        return None
    normalized: set[Tuple[int, int]] = set()
    for coord in selected_chip_coords:
        try:
            if isinstance(coord, dict):
                x_abs = coord.get("x_abs", coord.get("xAbs"))
                y_abs = coord.get("y_abs", coord.get("yAbs"))
            else:
                x_abs, y_abs = coord
            normalized.add((int(x_abs), int(y_abs)))
        except (TypeError, ValueError):
            continue
    return normalized or None


def _candidate_source_positions_paths(image_rel_path: str) -> List[Path]:
    image_path = Path(image_rel_path)
    image_stem = image_path.stem
    image_parent = image_path.parent
    candidate_paths: List[Path] = []

    parent_parts = [p for p in image_parent.parts if p not in ("", ".")]
    if len(parent_parts) > 1:
        candidate_paths.append(POSITIONS_ROOT.joinpath(*parent_parts[1:]) / f"{image_stem}.json")
    elif parent_parts:
        candidate_paths.append(POSITIONS_ROOT / f"{image_stem}.json")

    legacy_path = POSITIONS_ROOT / image_parent / f"{image_stem}.json"
    if legacy_path not in candidate_paths:
        candidate_paths.append(legacy_path)
    return candidate_paths


_positions_json_cache: Dict[str, Optional[Dict[str, Any]]] = {}
_POSITIONS_JSON_CACHE_MAX = 256


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(
        f"{path.suffix}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    tmp_path.replace(path)


try:
    import orjson as _json_fast
    def _json_load_bytes(raw: bytes):
        return _json_fast.loads(raw)
except ImportError:
    import json as _json_std
    def _json_load_bytes(raw: bytes):
        return _json_std.loads(raw)


def _normalize_positions_to_chips(data: dict) -> dict:
    """positions dict(키="0","1"...) → chips list 자동 변환."""
    if isinstance(data.get("chips"), list) and data["chips"]:
        return data
    pos = data.get("positions")
    if isinstance(pos, dict) and pos:
        try:
            max_idx = max(int(k) for k in pos.keys())
            chips = [None] * (max_idx + 1)
            for k, v in pos.items():
                chips[int(k)] = v
            chips = [c if c is not None else {} for c in chips]
            data["chips"] = chips
            if "coord" not in data:
                xs = [c.get("x", 0) for c in chips if c]
                ys = [c.get("y", 0) for c in chips if c]
                if xs and ys:
                    data["coord"] = {
                        "canvas": {"width": max(xs) + 10, "height": max(ys) + 10}
                    }
        except (ValueError, TypeError):
            pass
    return data


def _load_source_positions_data(image_rel_path: str) -> Optional[Dict[str, Any]]:
    cached = _positions_json_cache.get(image_rel_path)
    if cached is not None:
        return cached

    for candidate in _candidate_source_positions_paths(image_rel_path):
        if not candidate.exists():
            continue
        try:
            data = _json_load_bytes(candidate.read_bytes())
            _normalize_positions_to_chips(data)
            # LRU eviction
            if len(_positions_json_cache) >= _POSITIONS_JSON_CACHE_MAX:
                _positions_json_cache.pop(next(iter(_positions_json_cache)), None)
            _positions_json_cache[image_rel_path] = data
            return data
        except Exception:
            return None
    return None


def _copy_positions_without_bin(
    first_image_rel_path: str,
    output_dir: Path,
    composite_images: List[str],
    keep_chip_bin: bool = False,
    selected_chip_coords: Optional[Sequence[Tuple[int, int]]] = None,
    selection_crop: Optional[Dict[str, Any]] = None,
    position_rect_overrides: Optional[Dict[Tuple[int, int], Dict[str, Any]]] = None,
    position_canvas_size: Optional[Tuple[int, int]] = None,
    position_grid_edges: Optional[Dict[str, List[int]]] = None,
) -> None:
    """
    첫 번째 이미지의 positions.json을 찾아 composite 결과 이미지들에 대응하는
    positions 파일로 복사한다.

    keep_chip_bin=True면 chip의 'b' 필드를 유지(없으면 Normal로 보정)하고,
    False면 기존처럼 제거한다.
    """
    positions_data = _load_source_positions_data(first_image_rel_path)
    if not positions_data:
        return

    try:
        positions_template = copy.deepcopy(positions_data)
        selected_coord_set = _normalize_selected_chip_coords(selected_chip_coords)
        chips = positions_data.get("chips")
        if isinstance(chips, list):
            template_chips = positions_template.get("chips", [])
            if selected_coord_set is not None:
                filtered_chips = []
                for chip in template_chips:
                    if not isinstance(chip, dict):
                        continue
                    try:
                        chip_key = (int(chip.get("x_abs")), int(chip.get("y_abs")))
                    except (TypeError, ValueError):
                        continue
                    if chip_key in selected_coord_set:
                        filtered_chips.append(chip)
                positions_template["chips"] = filtered_chips
                template_chips = filtered_chips
                positions = positions_template.get("positions")
                if isinstance(positions, dict):
                    positions_template["positions"] = {
                        key: value
                        for key, value in positions.items()
                        if isinstance(value, dict)
                        and _coord_key_from_chip(value) in selected_coord_set
                    }
            for chip in template_chips:
                if not isinstance(chip, dict):
                    continue
                if keep_chip_bin:
                    # BIN 값 유지, 없으면 Normal 보정
                    if "b" not in chip:
                        chip["b"] = "Normal"
                elif "b" in chip:
                    del chip["b"]

            if position_rect_overrides:
                def apply_rect_override(chip: Any) -> None:
                    if not isinstance(chip, dict):
                        return
                    coord_key = _coord_key_from_chip(chip)
                    override = position_rect_overrides.get(coord_key)
                    if override is not None:
                        chip["rect"] = copy.deepcopy(override)

                for chip in template_chips:
                    apply_rect_override(chip)
                positions = positions_template.get("positions")
                if isinstance(positions, dict):
                    for chip in positions.values():
                        apply_rect_override(chip)

            if position_canvas_size or position_grid_edges:
                coord = positions_template.get("coord")
                if not isinstance(coord, dict):
                    coord = {}
                    positions_template["coord"] = coord
                if position_canvas_size:
                    canvas = coord.get("canvas")
                    if not isinstance(canvas, dict):
                        canvas = {}
                        coord["canvas"] = canvas
                    canvas["width"] = int(position_canvas_size[0])
                    canvas["height"] = int(position_canvas_size[1])
                if position_grid_edges:
                    coord["grid_edges"] = copy.deepcopy(position_grid_edges)

            if selection_crop:
                _translate_positions_for_selection_crop(positions_template, selection_crop)

        output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
        positions_output_dir = POSITIONS_ROOT / output_dir_rel
        positions_output_dir.mkdir(parents=True, exist_ok=True)

        for img_filename in composite_images:
            img_stem = Path(img_filename).stem
            composite_rel_path = output_dir_rel / img_filename
            positions_data_copy = copy.deepcopy(positions_template)
            positions_data_copy["image_path"] = composite_rel_path.as_posix()
            positions_data_copy["wafer"] = img_stem
            if "step" in positions_data_copy:
                positions_data_copy["step"] = img_filename

            positions_file_path = positions_output_dir / f"{img_stem}.json"
            _atomic_write_json(positions_file_path, positions_data_copy)
            # A previous Composite view may have cached the full source positions
            # under the same output image path.  Invalidate that entry after the
            # filtered file is atomically replaced.
            _positions_json_cache.pop(composite_rel_path.as_posix(), None)
    except Exception:
        pass


def _coord_key_from_chip(chip: Any) -> Optional[Tuple[int, int]]:
    if not isinstance(chip, dict):
        return None
    try:
        x_abs = chip.get("x_abs") if chip.get("x_abs") is not None else chip.get("x")
        y_abs = chip.get("y_abs") if chip.get("y_abs") is not None else chip.get("y")
        return int(x_abs), int(y_abs)
    except (TypeError, ValueError):
        return None


def _position_number(value: float) -> Any:
    """Keep translated positions compact while preserving non-integer scale values."""
    rounded = round(float(value), 6)
    return int(rounded) if rounded.is_integer() else rounded


def _translate_positions_for_selection_crop(
    positions_data: Dict[str, Any],
    selection_crop: Dict[str, Any],
) -> None:
    """Translate filtered chip rectangles into a cropped Composite canvas."""
    coord = positions_data.get("coord")
    if not isinstance(coord, dict):
        return

    canvas = coord.get("canvas")
    if not isinstance(canvas, dict):
        canvas = {}
        coord["canvas"] = canvas

    source_width = float(selection_crop.get("source_width") or 0)
    source_height = float(selection_crop.get("source_height") or 0)
    crop_x = float(selection_crop.get("x") or 0)
    crop_y = float(selection_crop.get("y") or 0)
    crop_width = float(selection_crop.get("width") or 0)
    crop_height = float(selection_crop.get("height") or 0)
    canvas_width = float(canvas.get("width") or source_width or 1)
    canvas_height = float(canvas.get("height") or source_height or 1)
    scale_x = source_width / canvas_width if source_width > 0 and canvas_width > 0 else 1.0
    scale_y = source_height / canvas_height if source_height > 0 and canvas_height > 0 else 1.0
    origin_x = crop_x / scale_x if scale_x else crop_x
    origin_y = crop_y / scale_y if scale_y else crop_y

    def translate_rect(rect: Any) -> None:
        if not isinstance(rect, dict):
            return
        for key, offset in (("x0", origin_x), ("x1", origin_x), ("y0", origin_y), ("y1", origin_y)):
            if key not in rect:
                continue
            try:
                rect[key] = _position_number(float(rect[key]) - offset)
            except (TypeError, ValueError):
                continue
        quad = rect.get("quad")
        if isinstance(quad, list):
            for point in quad:
                if not isinstance(point, list) or len(point) < 2:
                    continue
                try:
                    point[0] = _position_number(float(point[0]) - origin_x)
                    point[1] = _position_number(float(point[1]) - origin_y)
                except (TypeError, ValueError):
                    continue

    def translate_chip(chip: Any) -> None:
        if not isinstance(chip, dict):
            return
        translate_rect(chip.get("rect"))
        # Some legacy positions use x/y/w/h instead of rect.
        if "rect" not in chip and "x" in chip and "y" in chip:
            try:
                chip["x"] = _position_number(float(chip["x"]) - origin_x)
                chip["y"] = _position_number(float(chip["y"]) - origin_y)
            except (TypeError, ValueError):
                pass

    for chip in positions_data.get("chips", []):
        translate_chip(chip)
    positions = positions_data.get("positions")
    if isinstance(positions, dict):
        for chip in positions.values():
            translate_chip(chip)

    canvas["width"] = _position_number(crop_width / scale_x if scale_x else crop_width)
    canvas["height"] = _position_number(crop_height / scale_y if scale_y else crop_height)

    grid_edges = coord.get("grid_edges")
    if isinstance(grid_edges, dict):
        for key, origin, limit in (("xs", origin_x, canvas["width"]), ("ys", origin_y, canvas["height"])):
            values = grid_edges.get(key)
            if not isinstance(values, list):
                continue
            translated = []
            for value in values:
                try:
                    translated.append(_position_number(min(max(float(value) - origin, 0), float(limit))))
                except (TypeError, ValueError):
                    continue
            grid_edges[key] = sorted(set(translated))


def _find_selected_region_crop(
    base_indices: np.ndarray,
    padding_px: int = _SELECTED_REGION_PADDING_PX,
) -> Optional[Dict[str, int]]:
    """Return a tight pixel crop around selected chip rectangles only."""
    selected_pixels = base_indices != 8
    ys, xs = np.nonzero(selected_pixels)
    if xs.size == 0 or ys.size == 0:
        return None

    height, width = base_indices.shape[:2]
    padding = max(0, int(padding_px))
    x0 = max(0, int(xs.min()) - padding)
    y0 = max(0, int(ys.min()) - padding)
    x1 = min(width, int(xs.max()) + 1 + padding)
    y1 = min(height, int(ys.max()) + 1 + padding)
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0, "padding": padding}


def _normalize_selected_shot_groups(
    selected_shot_groups: Optional[Sequence[Dict[str, Any]]],
) -> Optional[List[Dict[str, Any]]]:
    if not selected_shot_groups:
        return None
    normalized: List[Dict[str, Any]] = []
    for group in selected_shot_groups:
        if not isinstance(group, dict):
            continue
        shot_id = str(group.get("shot_id") or "").strip()
        coords: set[Tuple[int, int]] = set()
        slots: Dict[Tuple[int, int], Tuple[int, int]] = {}
        for coord in group.get("chip_coords") or group.get("selected_chip_coords") or []:
            try:
                if isinstance(coord, dict):
                    x_abs = int(coord.get("x_abs", coord.get("xAbs")))
                    y_abs = int(coord.get("y_abs", coord.get("yAbs")))
                    slot_x_raw = coord.get("slot_x", coord.get("slotX"))
                    slot_y_raw = coord.get("slot_y", coord.get("slotY"))
                else:
                    x_abs, y_abs = coord[:2]
                    x_abs = int(x_abs)
                    y_abs = int(y_abs)
                    slot_x_raw = None
                    slot_y_raw = None
            except (TypeError, ValueError):
                continue
            key = (x_abs, y_abs)
            coords.add(key)
            try:
                slot_x = int(slot_x_raw)
                slot_y = int(slot_y_raw)
                if slot_x >= 0 and slot_y >= 0:
                    slots[key] = (slot_x, slot_y)
            except (TypeError, ValueError):
                pass
        raw_shape = group.get("shot_shape") or group.get("shape")
        shot_shape = None
        if isinstance(raw_shape, dict):
            try:
                cols = int(raw_shape.get("cols"))
                rows = int(raw_shape.get("rows"))
                if cols > 0 and rows > 0:
                    shot_shape = {"cols": cols, "rows": rows}
            except (TypeError, ValueError):
                shot_shape = None
        if shot_id and coords:
            normalized.append({
                "shot_id": shot_id,
                "coords": coords,
                "slot_map": slots,
                "shot_shape": shot_shape,
            })
    return normalized or None


def _chip_pixel_rect_from_positions(
    chip: Dict[str, Any],
    positions_data: Dict[str, Any],
    width: int,
    height: int,
) -> Optional[Tuple[int, int, int, int]]:
    coord = positions_data.get("coord", {})
    canvas = coord.get("canvas", {}) if isinstance(coord, dict) else {}
    canvas_w = float(canvas.get("width") or width) if isinstance(canvas, dict) else float(width)
    canvas_h = float(canvas.get("height") or height) if isinstance(canvas, dict) else float(height)
    scale_x = width / canvas_w if canvas_w > 0 else 1.0
    scale_y = height / canvas_h if canvas_h > 0 else 1.0
    rect = chip.get("rect") if isinstance(chip, dict) else None
    x0_raw = rect.get("x0") if isinstance(rect, dict) else None
    y0_raw = rect.get("y0") if isinstance(rect, dict) else None
    x1_raw = rect.get("x1") if isinstance(rect, dict) else None
    y1_raw = rect.get("y1") if isinstance(rect, dict) else None
    if None in (x0_raw, y0_raw, x1_raw, y1_raw):
        x_raw = chip.get("x")
        y_raw = chip.get("y")
        w_raw = chip.get("w", chip.get("width"))
        h_raw = chip.get("h", chip.get("height"))
        if None in (x_raw, y_raw, w_raw, h_raw):
            return None
        x0_raw, y0_raw = x_raw, y_raw
        x1_raw = float(x_raw) + float(w_raw)
        y1_raw = float(y_raw) + float(h_raw)
    try:
        x0, y0, x1, y1 = float(x0_raw), float(y0_raw), float(x1_raw), float(y1_raw)
    except (TypeError, ValueError):
        return None
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    sx0 = max(0, min(width, int(x0 * scale_x)))
    sy0 = max(0, min(height, int(y0 * scale_y)))
    sx1 = max(0, min(width, int(x1 * scale_x + 0.9999)))
    sy1 = max(0, min(height, int(y1 * scale_y + 0.9999)))
    return (sx0, sy0, sx1, sy1) if sx1 > sx0 and sy1 > sy0 else None


def _draw_selected_shot_grid_borders(
    base_indices: np.ndarray,
    placements: Sequence[Dict[str, Any]],
    *,
    cols: int,
    rows: int,
    cell_width: int,
    cell_height: int,
    border_index: int = 10,
) -> None:
    """Draw final Shot Composite grid lines with a fixed visible pixel width."""
    if cell_width <= 0 or cell_height <= 0:
        return

    internal_px = max(1, min(_SHOT_COMPOSITE_BORDER_PX, cell_width, cell_height))
    outer_px = max(1, min(_SHOT_COMPOSITE_OUTER_BORDER_PX, cell_width, cell_height))
    height, width = base_indices.shape[:2]
    slots: Dict[Tuple[int, int], Tuple[int, int, int, int]] = {}

    for placement in placements:
        try:
            tx0, ty0, tx1, ty1 = (int(value) for value in placement["target_rect"])
        except (KeyError, TypeError, ValueError):
            continue
        if tx1 <= tx0 or ty1 <= ty0:
            continue
        local_x = tx0 // cell_width
        local_y = ty0 // cell_height
        if 0 <= local_x < cols and 0 <= local_y < rows:
            slots[(local_x, local_y)] = (
                max(0, min(width, tx0)),
                max(0, min(height, ty0)),
                max(0, min(width, tx1)),
                max(0, min(height, ty1)),
            )

    def centered_span(edge: int, line_px: int, limit: int) -> Tuple[int, int]:
        start = edge - (line_px // 2)
        end = start + line_px
        if start < 0:
            end -= start
            start = 0
        if end > limit:
            start = max(0, start - (end - limit))
            end = limit
        return start, end

    for (slot_x, slot_y), (tx0, ty0, tx1, ty1) in slots.items():
        if (slot_x - 1, slot_y) not in slots:
            base_indices[ty0:ty1, tx0:min(tx1, tx0 + outer_px)] = border_index
        if (slot_x + 1, slot_y) not in slots:
            base_indices[ty0:ty1, max(tx0, tx1 - outer_px):tx1] = border_index
        else:
            x0, x1 = centered_span(tx1, internal_px, width)
            base_indices[ty0:ty1, x0:x1] = border_index

        if (slot_x, slot_y - 1) not in slots:
            base_indices[ty0:min(ty1, ty0 + outer_px), tx0:tx1] = border_index
        if (slot_x, slot_y + 1) not in slots:
            base_indices[max(ty0, ty1 - outer_px):ty1, tx0:tx1] = border_index
        else:
            y0, y1 = centered_span(ty1, internal_px, height)
            base_indices[y0:y1, tx0:tx1] = border_index


def _build_selected_shot_geometry(
    positions_data: Dict[str, Any],
    selected_shot_groups: Sequence[Dict[str, Any]],
    width: int,
    height: int,
    show_normal_border: bool = True,
) -> Dict[str, Any]:
    """Build one canonical chip grid while preserving partial Shot positions."""
    chips_by_coord = {
        key: chip
        for chip in positions_data.get("chips", [])
        if isinstance(chip, dict)
        for key in [_coord_key_from_chip(chip)]
        if key is not None
    }
    groups: List[Dict[str, Any]] = []
    explicit_signature = None
    observed_signatures: List[Tuple[int, int]] = []
    source_chip_count = 0

    # Edge/partial Shots may have no usable rect in the selected group. Keep a
    # cell-size fallback from the source wafer so the canonical Shot canvas can
    # still be rendered with missing cells left as background.
    fallback_rects = []
    for chip in positions_data.get("chips", []):
        if not isinstance(chip, dict):
            continue
        rect = _chip_pixel_rect_from_positions(chip, positions_data, width, height)
        if rect is not None:
            fallback_rects.append(rect)

    for group in selected_shot_groups:
        requested_coords = sorted(
            set(group.get("coords") or []),
            key=lambda value: (value[1], value[0]),
        )
        group_chips = [
            (coord, chips_by_coord[coord])
            for coord in requested_coords
            if coord in chips_by_coord
        ]
        reference_coords = [coord for coord, _ in group_chips] or requested_coords
        if not reference_coords:
            continue
        min_x = min(coord[0] for coord in reference_coords)
        max_x = max(coord[0] for coord in reference_coords)
        min_y = min(coord[1] for coord in reference_coords)
        max_y = max(coord[1] for coord in reference_coords)
        observed_signature = (max_x - min_x + 1, max_y - min_y + 1)
        observed_signatures.append(observed_signature)
        raw_shape = group.get("shot_shape")
        if isinstance(raw_shape, dict):
            try:
                group_signature = (int(raw_shape["cols"]), int(raw_shape["rows"]))
            except (KeyError, TypeError, ValueError):
                group_signature = None
            if group_signature and group_signature[0] > 0 and group_signature[1] > 0:
                if explicit_signature is None:
                    explicit_signature = group_signature
                elif explicit_signature != group_signature:
                    raise ValueError(
                        "서로 다른 chip 가로×세로 Shot은 하나의 Composite Map으로 합칠 수 없습니다."
                    )

        source_rects = []
        slot_map = group.get("slot_map") if isinstance(group.get("slot_map"), dict) else {}
        for coord, chip in group_chips:
            rect = _chip_pixel_rect_from_positions(chip, positions_data, width, height)
            if rect is None:
                continue
            slot = None
            try:
                raw_slot = slot_map.get(coord)
                if raw_slot is not None:
                    slot_x, slot_y = raw_slot
                    slot = (int(slot_x), int(slot_y))
            except (TypeError, ValueError):
                slot = None
            source_rects.append((coord, chip, rect, slot))
        size_rects = [entry[2] for entry in source_rects] or fallback_rects
        if not size_rects:
            continue
        cell_width = int(round(np.median([rect[2] - rect[0] for rect in size_rects])))
        cell_height = int(round(np.median([rect[3] - rect[1] for rect in size_rects])))
        if cell_width <= 0 or cell_height <= 0:
            continue
        groups.append({
            "shot_id": group["shot_id"],
            "min_x": min_x,
            "min_y": min_y,
            "source_rects": source_rects,
            "observed_signature": observed_signature,
            "cell_width": cell_width,
            "cell_height": cell_height,
        })
        source_chip_count += len(source_rects)

    if not groups:
        raise ValueError("선택한 Shot에 원본 positions chip이 없습니다.")

    # The frontend supplies the full Shot shape from layout.parquet. For older API
    # callers, use the largest observed group so a partial group cannot shrink
    # a Composite when a complete group is part of the same request.
    signature = explicit_signature or max(observed_signatures, key=lambda value: value[0] * value[1])
    cols, rows = signature
    cell_width = int(round(np.median([group["cell_width"] for group in groups])))
    cell_height = int(round(np.median([group["cell_height"] for group in groups])))
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("선택한 Shot의 chip 크기를 계산할 수 없습니다.")
    target_width = cols * cell_width
    target_height = rows * cell_height
    base_indices = np.full((target_height, target_width), 8, dtype=np.uint8)
    output_coords: set[Tuple[int, int]] = set()
    position_rect_overrides: Dict[Tuple[int, int], Dict[str, Any]] = {}

    for group in groups:
        observed_cols, observed_rows = group["observed_signature"]
        has_slot_positions = any(entry[3] is not None for entry in group["source_rects"])
        if not has_slot_positions and (observed_cols > cols or observed_rows > rows):
            raise ValueError(
                "선택한 Shot의 chip 배치가 canonical Shot 크기를 초과합니다."
            )
        origin_x = group["min_x"] - (group["min_x"] % cols)
        origin_y = group["min_y"] - (group["min_y"] % rows)
        placements = []
        target_keys = set()
        for coord, chip, rect, slot in group["source_rects"]:
            if slot is not None and 0 <= slot[0] < cols and 0 <= slot[1] < rows:
                local_x, local_y = slot
            else:
                local_x = coord[0] - origin_x
                local_y = coord[1] - origin_y
            if not (0 <= local_x < cols and 0 <= local_y < rows):
                raise ValueError("선택한 Shot chip 좌표가 canonical Shot 범위를 벗어났습니다.")
            target_key = (local_x, local_y)
            if target_key in target_keys:
                raise ValueError("선택한 Shot에 중복 chip 위치가 있습니다.")
            target_keys.add(target_key)
            placements.append({
                "coord": coord,
                "chip": chip,
                "source_rect": rect,
                "target_rect": (
                    local_x * cell_width,
                    local_y * cell_height,
                    (local_x + 1) * cell_width,
                    (local_y + 1) * cell_height,
                ),
            })
        group["placements"] = placements

    # Output positions represent one canonical Shot. If an edge/partial Shot is
    # selected first, use the densest selected Shot as the visible template and
    # let partial Shots contribute only their existing chip pixels.
    reference_group = max(groups, key=lambda group: len(group.get("placements") or []))
    for placement in reference_group["placements"]:
        coord = placement["coord"]
        tx0, ty0, tx1, ty1 = placement["target_rect"]
        output_coords.add(coord)
        base_indices[ty0:ty1, tx0:tx1] = 0
        position_rect_overrides[coord] = {
            "x0": tx0,
            "y0": ty0,
            "x1": tx1,
            "y1": ty1,
            "quad": [[tx0, ty0], [tx1, ty0], [tx1, ty1], [tx0, ty1]],
        }

    if show_normal_border:
        _draw_selected_shot_grid_borders(
            base_indices,
            reference_group["placements"],
            cols=cols,
            rows=rows,
            cell_width=cell_width,
            cell_height=cell_height,
        )

    return {
        "groups": groups,
        "shot_count": len(groups),
        "source_chip_count": source_chip_count,
        "output_chip_count": len(output_coords),
        "missing_chip_count": max(0, len(groups) * cols * rows - source_chip_count),
        "shot_shape": {"cols": cols, "rows": rows},
        "width": target_width,
        "height": target_height,
        "base_indices": base_indices,
        "output_coords": output_coords,
        "position_rect_overrides": position_rect_overrides,
        "position_canvas_size": (target_width, target_height),
        "position_grid_edges": {
            "xs": [index * cell_width for index in range(cols + 1)],
            "ys": [index * cell_height for index in range(rows + 1)],
        },
    }


def _build_selected_chip_geometry(
    positions_data: Dict[str, Any],
    selected_coords: Sequence[Tuple[int, int]],
    width: int,
    height: int,
    show_normal_border: bool = True,
) -> Dict[str, Any]:
    """Normalize several selected Chips into one canonical Chip canvas."""
    chips_by_coord = {
        key: chip
        for chip in positions_data.get("chips", [])
        if isinstance(chip, dict)
        for key in [_coord_key_from_chip(chip)]
        if key is not None
    }
    source_rects = []
    for coord in sorted(set(selected_coords), key=lambda value: (value[1], value[0])):
        chip = chips_by_coord.get(coord)
        if chip is None:
            continue
        rect = _chip_pixel_rect_from_positions(chip, positions_data, width, height)
        if rect is not None:
            source_rects.append((coord, chip, rect))
    if not source_rects:
        raise ValueError("선택한 Chip에 원본 positions rect가 없습니다.")

    cell_width = int(round(np.median([rect[2] - rect[0] for _, _, rect in source_rects])))
    cell_height = int(round(np.median([rect[3] - rect[1] for _, _, rect in source_rects])))
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("선택한 Chip의 크기를 계산할 수 없습니다.")

    canonical_coord = source_rects[0][0]
    target_rect = (0, 0, cell_width, cell_height)
    base_indices = np.full((cell_height, cell_width), 8, dtype=np.uint8)
    base_indices[:, :] = 0
    if show_normal_border:
        base_indices[0, :] = 10
        base_indices[-1, :] = 10
        base_indices[:, 0] = 10
        base_indices[:, -1] = 10

    return {
        "placements": [
            {
                "coord": coord,
                "chip": chip,
                "source_rect": rect,
                "target_rect": target_rect,
            }
            for coord, chip, rect in source_rects
        ],
        "source_chip_count": len(source_rects),
        "output_chip_count": 1,
        "width": cell_width,
        "height": cell_height,
        "base_indices": base_indices,
        "output_coords": {canonical_coord},
        "position_rect_overrides": {
            canonical_coord: {
                "x0": 0,
                "y0": 0,
                "x1": cell_width,
                "y1": cell_height,
                "quad": [[0, 0], [cell_width, 0], [cell_width, cell_height], [0, cell_height]],
            }
        },
        "position_canvas_size": (cell_width, cell_height),
        "position_grid_edges": {
            "xs": [0, cell_width],
            "ys": [0, cell_height],
        },
    }


def _remap_selected_shot_accumulators(
    grade_counts: np.ndarray,
    has_0_7: np.ndarray,
    has_8_13: np.ndarray,
    all_invalid: np.ndarray,
    shot_geometry: Dict[str, Any],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    target_counts = np.zeros(
        (grade_counts.shape[0], shot_geometry["height"], shot_geometry["width"]),
        dtype=grade_counts.dtype,
    )
    target_has_0_7 = np.zeros((shot_geometry["height"], shot_geometry["width"]), dtype=np.bool_)
    target_has_8_13 = np.zeros((shot_geometry["height"], shot_geometry["width"]), dtype=np.bool_)
    target_all_invalid = np.ones((shot_geometry["height"], shot_geometry["width"]), dtype=np.bool_)

    for group in shot_geometry["groups"]:
        for placement in group["placements"]:
            sx0, sy0, sx1, sy1 = placement["source_rect"]
            tx0, ty0, tx1, ty1 = placement["target_rect"]
            source_width = sx1 - sx0
            source_height = sy1 - sy0
            target_width = tx1 - tx0
            target_height = ty1 - ty0
            copy_width = min(source_width, target_width)
            copy_height = min(source_height, target_height)
            if copy_width <= 0 or copy_height <= 0:
                continue
            sx1 = sx0 + copy_width
            sy1 = sy0 + copy_height
            tx1 = tx0 + copy_width
            ty1 = ty0 + copy_height
            target_counts[:, ty0:ty1, tx0:tx1] += grade_counts[:, sy0:sy1, sx0:sx1]
            target_has_0_7[ty0:ty1, tx0:tx1] |= has_0_7[sy0:sy1, sx0:sx1]
            target_has_8_13[ty0:ty1, tx0:tx1] |= has_8_13[sy0:sy1, sx0:sx1]
            target_all_invalid[ty0:ty1, tx0:tx1] &= all_invalid[sy0:sy1, sx0:sx1]

    return target_counts, target_has_0_7, target_has_8_13, target_all_invalid


def _remap_selected_chip_accumulators(
    grade_counts: np.ndarray,
    has_0_7: np.ndarray,
    has_8_13: np.ndarray,
    all_invalid: np.ndarray,
    chip_geometry: Dict[str, Any],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    target_counts = np.zeros(
        (grade_counts.shape[0], chip_geometry["height"], chip_geometry["width"]),
        dtype=grade_counts.dtype,
    )
    target_has_0_7 = np.zeros((chip_geometry["height"], chip_geometry["width"]), dtype=np.bool_)
    target_has_8_13 = np.zeros((chip_geometry["height"], chip_geometry["width"]), dtype=np.bool_)
    target_all_invalid = np.ones((chip_geometry["height"], chip_geometry["width"]), dtype=np.bool_)

    for placement in chip_geometry["placements"]:
        sx0, sy0, sx1, sy1 = placement["source_rect"]
        tx0, ty0, tx1, ty1 = placement["target_rect"]
        copy_width = min(sx1 - sx0, tx1 - tx0)
        copy_height = min(sy1 - sy0, ty1 - ty0)
        if copy_width <= 0 or copy_height <= 0:
            continue
        sx1 = sx0 + copy_width
        sy1 = sy0 + copy_height
        tx1 = tx0 + copy_width
        ty1 = ty0 + copy_height
        target_counts[:, ty0:ty1, tx0:tx1] += grade_counts[:, sy0:sy1, sx0:sx1]
        target_has_0_7[ty0:ty1, tx0:tx1] |= has_0_7[sy0:sy1, sx0:sx1]
        target_has_8_13[ty0:ty1, tx0:tx1] |= has_8_13[sy0:sy1, sx0:sx1]
        target_all_invalid[ty0:ty1, tx0:tx1] &= all_invalid[sy0:sy1, sx0:sx1]

    return target_counts, target_has_0_7, target_has_8_13, target_all_invalid


def _iter_selected_geometry_placements(geometry: Dict[str, Any]):
    if isinstance(geometry.get("groups"), list):
        for group in geometry["groups"]:
            for placement in group.get("placements") or []:
                yield placement
        return
    for placement in geometry.get("placements") or []:
        yield placement


def _accumulate_selected_geometry_from_images(
    image_paths: Sequence[str],
    geometry: Dict[str, Any],
    width: int,
    height: int,
    loader_mode: str,
    max_workers: Optional[int],
    batch_size: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, int]:
    """Accumulate only the selected Chip/Shot rects into the canonical output canvas."""
    target_height = int(geometry["height"])
    target_width = int(geometry["width"])
    grade_counts = np.zeros((8, target_height, target_width), dtype=np.uint32)
    has_0_7 = np.zeros((target_height, target_width), dtype=np.bool_)
    has_8_13 = np.zeros((target_height, target_width), dtype=np.bool_)
    all_invalid = np.ones((target_height, target_width), dtype=np.bool_)
    placements = list(_iter_selected_geometry_placements(geometry))
    placements_arr = np.array(
        [
            [
                int(placement["source_rect"][0]),
                int(placement["source_rect"][1]),
                int(placement["source_rect"][2]),
                int(placement["source_rect"][3]),
                int(placement["target_rect"][0]),
                int(placement["target_rect"][1]),
                int(placement["target_rect"][2]),
                int(placement["target_rect"][3]),
            ]
            for placement in placements
        ],
        dtype=np.int64,
    )
    use_numba_selected = (
        _HAS_NUMBA and _numba_accumulate_selected is not None and placements_arr.size > 0
    )
    processed_count = 0

    if not placements:
        return grade_counts, has_0_7, has_8_13, all_invalid, processed_count

    for batch_paths in _batched_paths(image_paths, batch_size):
        for _rel_path, raw_indices in _iter_pixel_indices(
            list(batch_paths),
            width=width,
            height=height,
            loader_mode=loader_mode,
            max_workers=max_workers,
        ):
            if raw_indices is None:
                continue
            img = raw_indices.astype(np.uint8, copy=False)
            if use_numba_selected:
                if not img.flags.c_contiguous:
                    img = np.ascontiguousarray(img, dtype=np.uint8)
                _numba_accumulate_selected(
                    img,
                    placements_arr,
                    grade_counts,
                    has_0_7,
                    has_8_13,
                    all_invalid,
                )
            else:
                for placement in placements:
                    sx0, sy0, sx1, sy1 = placement["source_rect"]
                    tx0, ty0, tx1, ty1 = placement["target_rect"]
                    copy_width = min(sx1 - sx0, tx1 - tx0)
                    copy_height = min(sy1 - sy0, ty1 - ty0)
                    if copy_width <= 0 or copy_height <= 0:
                        continue
                    sx1c = sx0 + copy_width
                    sy1c = sy0 + copy_height
                    tx1c = tx0 + copy_width
                    ty1c = ty0 + copy_height
                    crop = img[sy0:sy1c, sx0:sx1c]
                    ge14 = crop >= 14
                    ge8 = crop >= 8
                    mid = ge8 & ~ge14
                    target_slice = (slice(ty0, ty1c), slice(tx0, tx1c))
                    has_0_7[target_slice] |= (~ge8) | ge14
                    has_8_13[target_slice] |= mid
                    all_invalid[target_slice] &= ge14
                    if ge14.any():
                        grade_counts[0, ty0:ty1c, tx0:tx1c] += ge14
                    for grade_idx in range(8):
                        grade_counts[grade_idx, ty0:ty1c, tx0:tx1c] += (crop == grade_idx)
            processed_count += 1

    return grade_counts, has_0_7, has_8_13, all_invalid, processed_count


def _count_unique_devices(image_paths: List[str], max_sample: int = 64) -> int:
    """소스 이미지 positions의 top-level device 개수를 반환한다."""
    devices: set[str] = set()
    for rel_path in image_paths[:max_sample]:
        positions_data = _load_source_positions_data(rel_path)
        if not isinstance(positions_data, dict):
            continue
        device_name = str(positions_data.get("device") or "").strip()
        if not device_name:
            continue
        devices.add(device_name)
        if len(devices) >= 2:
            return len(devices)
    return len(devices)


def _first_image_with_positions(image_paths: Sequence[str]) -> Optional[str]:
    for rel_path in image_paths:
        if _load_source_positions_data(rel_path):
            return rel_path
    return image_paths[0] if image_paths else None


def _resolve_personal_scheme_data(scheme: Optional[str]) -> Dict[str, Any]:
    try:
        legends = load_color_legends()
    except Exception:
        legends = {}

    scheme_name = (scheme or ANONYMOUS_LOGIN_ID).strip() or ANONYMOUS_LOGIN_ID
    scheme_data = legends.get(scheme_name)
    if not isinstance(scheme_data, dict):
        scheme_data = legends.get(ANONYMOUS_LOGIN_ID)
    if not isinstance(scheme_data, dict):
        scheme_data = legends.get("default")
    if not isinstance(scheme_data, dict):
        scheme_data = {}
    return scheme_data


def _apply_personal_palette(
    palette_list: List[int],
    scheme: Optional[str],
) -> List[int]:
    scheme_data = _resolve_personal_scheme_data(scheme)
    if not scheme_data:
        return palette_list

    palette_bytes = _scheme_to_palette_bytes(scheme_data)
    limit = min(len(palette_bytes) // 3, 256)
    for i in range(limit):
        palette_list[i * 3:(i + 1) * 3] = palette_bytes[i * 3:(i + 1) * 3]

    # index 8 = background (개인색 적용), index 31 = invalid fill (흰색 고정)
    # composite map 배경은 index 8을 사용하므로 별도 설정 불필요
    return palette_list


def _build_chip_base_indices_from_positions(
    image_rel_path: str,
    width: int,
    height: int,
    show_normal_border: bool = True,
    selected_chip_coords: Optional[Sequence[Tuple[int, int]]] = None,
) -> Optional[np.ndarray]:
    """
    positions.json의 chip 좌표로 base_indices 배열 생성.
    chip 바깥은 전부 배경색(8)으로 채워 wafer 원형 더미 영역을 제거.

    Returns:
        (H, W) uint8 ndarray:
            - 8: chip 바깥 (배경색, 개인색 적용)
            - 0: chip 내부 (grade0 색)
            - 10: chip 테두리 (Normal 색, show_normal_border=True일 때)
        None: positions.json을 찾을 수 없는 경우
    """
    positions_data = _load_source_positions_data(image_rel_path)
    if not isinstance(positions_data, dict):
        return None

    chips = positions_data.get("chips")
    if not isinstance(chips, list) or not chips:
        return None

    # coord.canvas 기반 스케일 계산 (main.py _scaled_chip_rect와 동일 로직)
    coord = positions_data.get("coord", {})
    canvas = coord.get("canvas", {}) if isinstance(coord, dict) else {}
    canvas_w = int(canvas.get("width", width)) if isinstance(canvas, dict) else width
    canvas_h = int(canvas.get("height", height)) if isinstance(canvas, dict) else height
    if canvas_w <= 0:
        canvas_w = width
    if canvas_h <= 0:
        canvas_h = height
    scale_x = width / float(canvas_w)
    scale_y = height / float(canvas_h)

    base = np.full((height, width), 8, dtype=np.uint8)  # 전체 = 배경색 (index 8, 개인색 적용)
    selected_coord_set = _normalize_selected_chip_coords(selected_chip_coords)

    for chip in chips:
        if not isinstance(chip, dict):
            continue
        if selected_coord_set is not None and _coord_key_from_chip(chip) not in selected_coord_set:
            continue
        rect = chip.get("rect", {})
        x0_raw = rect.get("x0") if isinstance(rect, dict) else None
        y0_raw = rect.get("y0") if isinstance(rect, dict) else None
        x1_raw = rect.get("x1") if isinstance(rect, dict) else None
        y1_raw = rect.get("y1") if isinstance(rect, dict) else None
        if None in (x0_raw, y0_raw, x1_raw, y1_raw):
            x_raw = chip.get("x")
            y_raw = chip.get("y")
            w_raw = chip.get("w", chip.get("width"))
            h_raw = chip.get("h", chip.get("height"))
            if None in (x_raw, y_raw, w_raw, h_raw):
                continue
            x0_raw, y0_raw = x_raw, y_raw
            x1_raw = float(x_raw) + float(w_raw)
            y1_raw = float(y_raw) + float(h_raw)
        try:
            x0, y0, x1, y1 = float(x0_raw), float(y0_raw), float(x1_raw), float(y1_raw)
        except (TypeError, ValueError):
            continue
        if x1 < x0:
            x0, x1 = x1, x0
        if y1 < y0:
            y0, y1 = y1, y0

        sx0 = max(0, min(width, int(x0 * scale_x)))
        sy0 = max(0, min(height, int(y0 * scale_y)))
        sx1 = max(0, min(width, int(x1 * scale_x + 0.9999)))
        sy1 = max(0, min(height, int(y1 * scale_y + 0.9999)))
        if sx1 <= sx0 or sy1 <= sy0:
            continue

        base[sy0:sy1, sx0:sx1] = 0  # chip 내부 = grade0 색
        if show_normal_border:
            base[sy0, sx0:sx1] = 10        # 상단 테두리
            base[sy1 - 1, sx0:sx1] = 10   # 하단 테두리
            base[sy0:sy1, sx0] = 10        # 좌측 테두리
            base[sy0:sy1, sx1 - 1] = 10   # 우측 테두리

    return base


def _build_palette_list(source_palette: Optional[Sequence[int]]) -> List[int]:
    if source_palette:
        palette = list(source_palette)
    else:
        palette = []
    if not palette:
        # grayscale fallback
        for i in range(256):
            palette.extend([i, i, i])
    if len(palette) < 256 * 3:
        palette.extend([0, 0, 0] * (256 - len(palette) // 3))
    return palette[: 256 * 3]


def _sanitize_login_id(login_id: Optional[str]) -> str:
    candidate = (login_id or ANONYMOUS_LOGIN_ID).strip()
    if not candidate:
        candidate = ANONYMOUS_LOGIN_ID
    safe_chars = []
    for ch in candidate:
        if ch.isalnum() or ch in ("-", "_"):
            safe_chars.append(ch)
        else:
            safe_chars.append("_")
    sanitized = "".join(safe_chars).strip("_") or ANONYMOUS_LOGIN_ID
    return sanitized[:64]


def _prepare_output_dir(login_id: Optional[str]) -> Tuple[Path, str]:
    safe_login = _sanitize_login_id(login_id)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    user_dir = COMPOSITE_ROOT / safe_login
    # 🔥 이전 삭제는 /api/composite-cleanup에서 처리 — 여기서는 폴더 생성만
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir, timestamp


def _delete_existing_subset_outputs(output_dir: Path) -> None:
    """현재 output_dir의 이전 subset PNG/positions 흔적을 모두 제거한다."""
    try:
        for candidate in output_dir.iterdir():
            if not candidate.is_file():
                continue
            if _SUBSET_NAME_RE.match(candidate.name):
                try:
                    candidate.unlink()
                except Exception:
                    pass
    except Exception:
        pass

    try:
        output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
        positions_output_dir = POSITIONS_ROOT / output_dir_rel
        if positions_output_dir.exists():
            for candidate in positions_output_dir.iterdir():
                if not candidate.is_file():
                    continue
                if _SUBSET_NAME_RE.match(candidate.stem + ".png"):
                    try:
                        candidate.unlink()
                    except Exception:
                        pass
    except Exception:
        pass


def _extract_subset_grades(filename: str) -> Optional[List[int]]:
    """
    square_average_17.png -> [1, 7]
    square_weighted_average_35.png -> [3, 5]
    """
    match = _SUBSET_NAME_RE.match(filename)
    if not match:
        return None
    digits = match.group(2)
    if not digits:
        return None
    try:
        grades = sorted(set(int(ch) for ch in digits if ch.isdigit()))
    except Exception:
        return None
    return grades if grades else None


def _summarize_map(values: np.ndarray, mask: Optional[np.ndarray]) -> Dict[str, float]:
    if mask is None:
        return {}
    data = values[mask]
    if data.size == 0:
        return {}
    return {
        "min": float(np.min(data)),
        "max": float(np.max(data)),
        "mean": float(np.mean(data)),
        "std": float(np.std(data)),
    }


def _count_low_grade_occurrences(
    stacked_indices: np.ndarray,
    chunk_size: Optional[int] = None,
) -> np.ndarray:
    """
    (N, H, W) 인덱스 배열에서 grade 0~7의 등장 횟수를 계산.
    빠른 numpy vectorization 연산을 통해 np.add.at로 인한 속도 저하를 없앰.
    """
    if stacked_indices.ndim != 3:
        raise ValueError("stacked_indices must be a 3D array (N, H, W)")

    total_images, height, width = stacked_indices.shape
    if total_images == 0 or height == 0 or width == 0:
        return np.zeros((8, height, width), dtype=np.uint16)

    counts = np.zeros((8, height, width), dtype=np.uint16)
    
    # 0부터 7까지 각 숫자에 대해 boolean 마스크를 만들고 이미지 축(axis=0)을 따라 합산
    for g in range(8):
        counts[g] = (stacked_indices == g).sum(axis=0, dtype=np.uint16)
        
    return counts


if _HAS_NUMBA:
    @njit(parallel=True, fastmath=False, cache=_NUMBA_CACHE)
    def _numba_count_grades_impl(stacked_indices: np.ndarray) -> np.ndarray:
        total_images, height, width = stacked_indices.shape
        # NumPy zeros with uint32 to avoid overflow during accumulation
        counts = np.zeros((8, height, width), dtype=np.uint32)
        for y in prange(height):
            for x in range(width):
                for img_idx in range(total_images):
                    value = int(stacked_indices[img_idx, y, x])
                    if 0 <= value < 8:
                        counts[value, y, x] += 1
        return counts

    @njit(parallel=True, cache=_NUMBA_CACHE)
    def _numba_process_masks(stacked):
        """마스크 계산 + 14+→0 변환 + 8-13 only→8 변환을 단일 패스로 처리."""
        N, H, W = stacked.shape
        has_07 = np.zeros((H, W), dtype=np.bool_)
        has_813 = np.zeros((H, W), dtype=np.bool_)
        all_inv = np.ones((H, W), dtype=np.bool_)
        result = stacked.copy()

        for y in prange(H):
            for x in range(W):
                low = False
                mid = False
                inv_all = True
                inv_any = False
                for i in range(N):
                    v = result[i, y, x]
                    if v < 8:
                        low = True
                        inv_all = False
                    elif v < 14:
                        mid = True
                        inv_all = False
                    else:
                        inv_any = True
                        result[i, y, x] = 0
                has_07[y, x] = low or inv_any
                has_813[y, x] = mid
                all_inv[y, x] = inv_all

        for y in prange(H):
            for x in range(W):
                if has_813[y, x] and not has_07[y, x]:
                    for i in range(N):
                        result[i, y, x] = 8
                for i in range(N):
                    if result[i, y, x] > 13:
                        result[i, y, x] = 13

        return result, has_07, has_813, all_inv

    @njit(parallel=True, cache=_NUMBA_CACHE)
    def _numba_render_composite(base_indices, palette, value_map, mask, lut_colors, v_min, v_max):
        """6912x6912 RGB 렌더링을 단일 패스로 처리 (numpy 대비 50x 빠름)."""
        H, W = base_indices.shape
        rgb = np.empty((H, W, 3), dtype=np.uint8)
        denom = v_max - v_min
        for y in prange(H):
            for x in range(W):
                idx = base_indices[y, x]
                if mask[y, x] and denom > 0:
                    val = value_map[y, x]
                    scaled = (val - v_min) / denom
                    li = int(min(max(round(scaled * 255.0), 0), 255))
                    rgb[y, x, 0] = lut_colors[li, 0]
                    rgb[y, x, 1] = lut_colors[li, 1]
                    rgb[y, x, 2] = lut_colors[li, 2]
                else:
                    rgb[y, x, 0] = palette[idx, 0]
                    rgb[y, x, 1] = palette[idx, 1]
                    rgb[y, x, 2] = palette[idx, 2]
        return rgb

    @njit(parallel=True, cache=_NUMBA_CACHE)
    def _numba_accumulate_image(img, grade_counts, has_0_7, has_8_13, all_invalid):
        """단일 이미지의 마스크 + grade 카운트 누적을 한 패스로 처리.
        grade_counts (8,H,W), has_0_7 (H,W), has_8_13 (H,W), all_invalid (H,W) in-place 갱신."""
        H, W = img.shape
        for y in prange(H):
            for x in range(W):
                v = img[y, x]
                if v < 8:
                    grade_counts[v, y, x] += 1
                    has_0_7[y, x] = True
                    all_invalid[y, x] = False
                elif v < 14:
                    has_8_13[y, x] = True
                    all_invalid[y, x] = False
                else:
                    # invalid (>=14) → grade 0으로 카운트
                    grade_counts[0, y, x] += 1
                    has_0_7[y, x] = True

    @njit(parallel=True, cache=_NUMBA_CACHE)
    def _numba_accumulate_batch(stacked, grade_counts, has_0_7, has_8_13, all_invalid):
        """배치 이미지의 mask + grade count를 한 번의 parallel pass로 누적."""
        N, H, W = stacked.shape
        for y in prange(H):
            for x in range(W):
                batch_has_0_7 = False
                batch_has_8_13 = False
                batch_all_invalid = True
                for i in range(N):
                    v = stacked[i, y, x]
                    if v < 8:
                        grade_counts[v, y, x] += 1
                        batch_has_0_7 = True
                        batch_all_invalid = False
                    elif v < 14:
                        batch_has_8_13 = True
                        batch_all_invalid = False
                    else:
                        # invalid (>=14) → grade 0으로 카운트하되 all_invalid 판정은 유지
                        grade_counts[0, y, x] += 1
                        batch_has_0_7 = True
                if batch_has_0_7:
                    has_0_7[y, x] = True
                if batch_has_8_13:
                    has_8_13[y, x] = True
                if not batch_all_invalid:
                    all_invalid[y, x] = False

    @njit(cache=_NUMBA_CACHE)
    def _numba_accumulate_selected(img, placements, grade_counts, has_0_7, has_8_13, all_invalid):
        """선택 Chip/Shot rect만 target canvas에 누적한다."""
        for p in range(placements.shape[0]):
            sx0 = placements[p, 0]
            sy0 = placements[p, 1]
            sx1 = placements[p, 2]
            sy1 = placements[p, 3]
            tx0 = placements[p, 4]
            ty0 = placements[p, 5]
            tx1 = placements[p, 6]
            ty1 = placements[p, 7]
            copy_width = sx1 - sx0
            if tx1 - tx0 < copy_width:
                copy_width = tx1 - tx0
            copy_height = sy1 - sy0
            if ty1 - ty0 < copy_height:
                copy_height = ty1 - ty0
            if copy_width <= 0 or copy_height <= 0:
                continue
            for yy in range(copy_height):
                sy = sy0 + yy
                ty = ty0 + yy
                for xx in range(copy_width):
                    sx = sx0 + xx
                    tx = tx0 + xx
                    v = img[sy, sx]
                    if v < 8:
                        grade_counts[v, ty, tx] += 1
                        has_0_7[ty, tx] = True
                        all_invalid[ty, tx] = False
                    elif v < 14:
                        has_8_13[ty, tx] = True
                        all_invalid[ty, tx] = False
                    else:
                        grade_counts[0, ty, tx] += 1
                        has_0_7[ty, tx] = True

    _SQ_WEIGHTS = np.array([0, 1, 4, 9, 16, 25, 36, 49], dtype=np.float32)
    _WT_FACTORS = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32)

    @njit(parallel=True, cache=_NUMBA_CACHE)
    def _numba_compute_sum_maps(gc, sq_w, wt_f, img_count):
        """square_mean + weighted_mean + masks를 단일 패스로 계산 (numpy 대비 1.7x)."""
        G, H, W = gc.shape
        sq_mean = np.zeros((H, W), dtype=np.float32)
        weighted = np.zeros((H, W), dtype=np.float32)
        calc_mask = np.zeros((H, W), dtype=np.bool_)
        weighted_mask = np.zeros((H, W), dtype=np.bool_)
        inv_count = np.float32(1.0 / img_count) if img_count > 0 else np.float32(0.0)
        for y in prange(H):
            for x in range(W):
                sq_sum = np.float32(0.0)
                w_sum = np.float32(0.0)
                has = False
                for g in range(G):
                    v = np.float32(gc[g, y, x])
                    sq_sum += v * sq_w[g]
                    w_sum += v * wt_f[g]
                    if v > 0:
                        has = True
                if has:
                    calc_mask[y, x] = True
                    sq_mean[y, x] = sq_sum * inv_count
                    if w_sum > 0:
                        weighted_mask[y, x] = True
                        weighted[y, x] = sq_sum / w_sum
        return sq_mean, weighted, calc_mask, weighted_mask

    # Import-time JIT warmup can block request paths on Windows when this module is
    # first loaded by /api/composite-cleanup. Keep it opt-in only.
    if os.getenv("COMPOSITE_NUMBA_IMPORT_WARMUP", "0").strip().lower() in {"1", "true", "yes", "y", "on"}:
        try:
            _small = np.zeros((1, 2, 2), dtype=np.uint8)
            _numba_count_grades_impl(_small)
            _numba_process_masks(_small)
            _small_pal = np.zeros((256, 3), dtype=np.uint8)
            _small_lut = np.zeros((256, 3), dtype=np.uint8)
            _small_v = np.zeros((2, 2), dtype=np.float32)
            _small_m = np.zeros((2, 2), dtype=np.bool_)
            _numba_render_composite(_small[0], _small_pal, _small_v, _small_m, _small_lut, 0.0, 1.0)
            _small_img = np.zeros((2, 2), dtype=np.uint8)
            _small_stack = np.zeros((2, 2, 2), dtype=np.uint8)
            _small_gc = np.zeros((8, 2, 2), dtype=np.uint32)
            _small_h07 = np.zeros((2, 2), dtype=np.bool_)
            _small_h813 = np.zeros((2, 2), dtype=np.bool_)
            _small_inv = np.ones((2, 2), dtype=np.bool_)
            _numba_accumulate_image(_small_img, _small_gc, _small_h07, _small_h813, _small_inv)
            _numba_accumulate_batch(_small_stack, _small_gc, _small_h07, _small_h813, _small_inv)
            _small_placements = np.array([[0, 0, 2, 2, 0, 0, 2, 2]], dtype=np.int64)
            _numba_accumulate_selected(_small_img, _small_placements, _small_gc, _small_h07, _small_h813, _small_inv)
            _numba_compute_sum_maps(_small_gc, _SQ_WEIGHTS, _WT_FACTORS, 1)
            del _small, _small_pal, _small_lut, _small_v, _small_m
            del _small_img, _small_stack, _small_placements, _small_gc, _small_h07, _small_h813, _small_inv
        except Exception:
            pass
else:
    _numba_count_grades_impl = None
    _numba_process_masks = None
    _numba_render_composite = None
    _numba_accumulate_image = None
    _numba_accumulate_batch = None
    _numba_accumulate_selected = None
    _numba_compute_sum_maps = None
    _SQ_WEIGHTS = np.array([0, 1, 4, 9, 16, 25, 36, 49], dtype=np.float32)
    _WT_FACTORS = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32)

_NUMBA_WARM_LOCK = threading.Lock()
_NUMBA_WARMED = False
_NUMBA_WARM_ERROR: Optional[str] = None


def warm_numba_kernels() -> Dict[str, Any]:
    """Compile Numba kernels once so the first real composite request stays fast."""
    global _NUMBA_WARMED, _NUMBA_WARM_ERROR
    if not _HAS_NUMBA:
        return {"enabled": False, "warmed": False, "error": _NUMBA_WARM_ERROR}
    if _NUMBA_WARMED:
        return _numba_runtime_info(warmed=True)

    with _NUMBA_WARM_LOCK:
        if _NUMBA_WARMED:
            return _numba_runtime_info(warmed=True)
        started = time.perf_counter()
        try:
            small = np.zeros((2, 2, 2), dtype=np.uint8)
            small[1, 0, 0] = 15
            _numba_count_grades_impl(small)
            _numba_process_masks(small)
            small_pal = np.zeros((256, 3), dtype=np.uint8)
            small_lut = np.zeros((256, 3), dtype=np.uint8)
            small_v = np.zeros((2, 2), dtype=np.float32)
            small_m = np.zeros((2, 2), dtype=np.bool_)
            _numba_render_composite(small[0], small_pal, small_v, small_m, small_lut, 0.0, 1.0)
            small_gc = np.zeros((8, 2, 2), dtype=np.uint32)
            small_h07 = np.zeros((2, 2), dtype=np.bool_)
            small_h813 = np.zeros((2, 2), dtype=np.bool_)
            small_inv = np.ones((2, 2), dtype=np.bool_)
            _numba_accumulate_image(small[0], small_gc, small_h07, small_h813, small_inv)
            _numba_accumulate_batch(small, small_gc, small_h07, small_h813, small_inv)
            small_placements = np.array([[0, 0, 2, 2, 0, 0, 2, 2]], dtype=np.int64)
            _numba_accumulate_selected(small[0], small_placements, small_gc, small_h07, small_h813, small_inv)
            _numba_compute_sum_maps(small_gc, _SQ_WEIGHTS, _WT_FACTORS, 2)
            _NUMBA_WARMED = True
            _NUMBA_WARM_ERROR = None
            info = _numba_runtime_info(warmed=True)
            info["warmup_time"] = round(time.perf_counter() - started, 3)
            return info
        except Exception as exc:
            _NUMBA_WARM_ERROR = str(exc)
            return _numba_runtime_info(warmed=False, error=_NUMBA_WARM_ERROR)


def _numba_runtime_info(
    *,
    warmed: Optional[bool] = None,
    accumulator: Optional[str] = None,
    batch_size: Optional[int] = None,
    warmup_time: Optional[float] = None,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    threads = None
    if _HAS_NUMBA and _numba_get_num_threads is not None:
        try:
            threads = int(_numba_get_num_threads())
        except Exception:
            threads = None
    info: Dict[str, Any] = {
        "enabled": bool(_HAS_NUMBA),
        "requested": bool(_USE_NUMBA),
        "cache": bool(_NUMBA_CACHE),
        "warmed": _NUMBA_WARMED if warmed is None else bool(warmed),
        "threads": threads,
    }
    if accumulator:
        info["accumulator"] = accumulator
    if batch_size is not None:
        info["batch_size"] = int(batch_size)
    if warmup_time is not None:
        info["warmup_time"] = round(float(warmup_time), 3)
    resolved_error = error if error is not None else _NUMBA_WARM_ERROR
    if resolved_error:
        info["error"] = resolved_error
    return info


def _count_grades_with_numba(stacked_indices: np.ndarray) -> Optional[np.ndarray]:
    if _numba_count_grades_impl is None:
        return None
    counts32 = _numba_count_grades_impl(stacked_indices)
    if counts32 is None:
        return None
    # Clamp to uint16 range to stay aligned with downstream consumers
    np.minimum(counts32, np.uint32(np.iinfo(np.uint16).max), out=counts32)
    return counts32.astype(np.uint16, copy=False)


def _broadcast_grade_counts(stacked_indices: np.ndarray) -> np.ndarray:
    grade_counts_vec = (stacked_indices[..., None] == _GRADE_RANGE).sum(axis=0)
    return grade_counts_vec.transpose(2, 0, 1).astype(np.uint16, copy=False)


def _compute_grade_counts(stacked_indices: np.ndarray) -> np.ndarray:
    if stacked_indices.ndim != 3:
        raise ValueError("stacked_indices must be a 3D array (N, H, W)")
    contiguous = np.ascontiguousarray(stacked_indices, dtype=np.uint8)

    def _chunk() -> np.ndarray:
        return _count_low_grade_occurrences(contiguous)

    if _cython_count_grades is not None:
        try:
            return _cython_count_grades(contiguous)
        except Exception as exc:
            print(f"  [WARNING] Cython failed, falling back to NumPy: {exc}")
    numba_counts = _count_grades_with_numba(contiguous)
    if numba_counts is not None:
        return numba_counts
    return _chunk()


def _hex_to_rgb_tuple(value: str) -> Tuple[int, int, int]:
    value = value.lstrip("#")
    if len(value) != 6:
        return (255, 255, 255)
    r = int(value[0:2], 16)
    g = int(value[2:4], 16)
    b = int(value[4:6], 16)
    return (r, g, b)


def _resolve_scheme_background_rgb(scheme: Optional[str], section: Optional[str] = None) -> Tuple[int, int, int]:
    """Composite/Measure 배경색 결정.
    section별 배경 → 개인색 배경 → 기본색 순으로 탐색."""
    try:
        legends = load_color_legends()
    except Exception:
        legends = {}

    scheme_name = (scheme or ANONYMOUS_LOGIN_ID).strip() or ANONYMOUS_LOGIN_ID

    # 1. section별 배경색 (composite/measure 탭에서 사용자가 명시적으로 설정한 배경)
    _DEFAULT_BG = "#CCCCCC"
    if section in ("composite", "measure"):
        section_data = legends.get(section, {})
        if isinstance(section_data, dict):
            user_entry = section_data.get(scheme_name) or section_data.get(ANONYMOUS_LOGIN_ID)
            if isinstance(user_entry, dict):
                raw_bg = user_entry.get("background")
                if raw_bg and str(raw_bg).strip().upper() != _DEFAULT_BG.upper():
                    # 기본값(#CCCCCC)이 아닌 명시적 설정만 우선 사용
                    try:
                        return _hex_to_rgb_tuple(normalize_hex_color(str(raw_bg)))
                    except Exception:
                        pass

    # 2. 개인색 배경 (Fail 탭에서 설정한 background)
    scheme_data = legends.get(scheme_name)
    if not isinstance(scheme_data, dict):
        scheme_data = legends.get(ANONYMOUS_LOGIN_ID)
    if not isinstance(scheme_data, dict):
        scheme_data = legends.get("default")
    if not isinstance(scheme_data, dict):
        return (204, 204, 204)  # #CCCCCC

    raw_background = scheme_data.get("background")
    try:
        normalized = normalize_hex_color(str(raw_background or _DEFAULT_BG))
    except Exception:
        normalized = _DEFAULT_BG
    return _hex_to_rgb_tuple(normalized)


def _percentile_ranks(
    values: np.ndarray,
    value_min: Optional[float] = None,
    value_max: Optional[float] = None,
) -> np.ndarray:
    """
    주어진 값 배열을 0~100 범위로 선형 정규화(Min-Max Scaling).
    기존 Percentile(순위) 방식 대신 값의 크기를 그대로 반영하여
    0은 0%, Max는 100%가 되도록 함.
    """
    if values.size == 0:
        return np.zeros_like(values, dtype=np.float32)

    # Min-Max Scaling: (x - min) / (max - min) * 100
    # float32로 변환하여 계산
    values_f = values.astype(np.float32, copy=False)
    finite_values = values_f[np.isfinite(values_f)]
    if finite_values.size == 0:
        return np.zeros_like(values_f, dtype=np.float32)

    v_min = float(value_min if value_min is not None else finite_values.min())
    v_max = float(value_max if value_max is not None else finite_values.max())

    if v_max <= v_min:
        return np.zeros_like(values_f, dtype=np.float32)

    scaled = (values_f - v_min) / (v_max - v_min) * 100.0
    return np.clip(scaled, 0.0, 100.0, out=scaled)


def _value_range_for_map(
    map_data: Optional[np.ndarray],
    mask_arr: Optional[np.ndarray],
    clamp_min_to_zero: bool = False,
) -> Tuple[Optional[float], Optional[float]]:
    """
    계산된 맵과 마스크에서 유효한 최소/최대값을 추출한다.
    """
    if map_data is None or mask_arr is None:
        return None, None
    mask_bool = np.asarray(mask_arr, dtype=bool)
    values = map_data[mask_bool]
    if values.size == 0:
        return None, None
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return None, None
    v_min = 0.0 if clamp_min_to_zero else float(finite.min())
    v_max = float(finite.max())
    return v_min, v_max


def _interpolate_percentile_colors(
    percentiles: np.ndarray,
    color_array: np.ndarray,
    quantile_positions: Optional[np.ndarray] = None,
) -> np.ndarray:
    """
    Percentile (0~100)을 색상으로 변환

    Args:
    percentiles: 0~100 범위의 percentile 값들
    color_array: 11개의 RGB 색상 [quantile0, quantile10, ..., quantile100]
    quantile_positions: 각 색상에 해당하는 백분위 지점 (0~100 값의 배열)

    Returns:
        RGB 색상 배열
    """
    if percentiles.size == 0 or color_array.size == 0:
        return np.zeros((0, 3), dtype=np.uint8)

    colors_f = color_array.astype(np.float32, copy=False)
    if colors_f.shape[0] == 1:
        return np.repeat(colors_f, percentiles.size, axis=0).astype(np.uint8, copy=False)

    if quantile_positions is None or len(quantile_positions) != len(color_array):
        quantile_positions = np.linspace(0.0, 100.0, len(color_array), dtype=np.float32)
    else:
        quantile_positions = np.clip(
            quantile_positions.astype(np.float32, copy=False),
            0.0,
            100.0,
        )
    percentiles = np.clip(percentiles.astype(np.float32, copy=False), 0.0, 100.0)
    norm_indices = np.interp(
        percentiles,
        quantile_positions,
        np.arange(len(color_array), dtype=np.float32),
    )
    buckets = np.floor(norm_indices).astype(np.int32)
    buckets = np.clip(buckets, 0, len(color_array) - 1)
    next_idx = np.clip(buckets + 1, 0, len(color_array) - 1)
    t = (norm_indices - buckets).reshape(-1, 1)

    start_colors = colors_f[buckets]
    end_colors = colors_f[next_idx]
    blended = start_colors + (end_colors - start_colors) * t
    return np.clip(np.round(blended), 0, 255).astype(np.uint8)


def _load_pixel_indices_vips(full_path: Path, width: int, height: int) -> Optional[np.ndarray]:
    """pyvips를 사용한 고속 palette PNG 인덱스 로드.
    pyvips는 palette PNG를 RGB로 자동 확장하므로,
    역 팔레트 매핑 대신 PIL의 raw 인덱스 접근이 더 정확.
    단, 비-palette 이미지(grayscale/RGB)는 pyvips로 빠르게 처리."""
    if not _HAS_PYVIPS:
        return None
    try:
        # pyvips sequential access로 고속 로드 (palette PNG는 RGB 확장됨)
        img = _vips.Image.new_from_file(str(full_path), access='sequential')
        if img.width != width or img.height != height:
            img = img.resize(width / img.width, vscale=height / img.height, kernel='nearest')
        bands = img.bands
        if bands == 1:
            # Grayscale → 인덱스로 변환
            arr = np.ndarray(
                buffer=img.write_to_memory(),
                dtype=np.uint8,
                shape=(img.height, img.width),
            )
            return arr // 32
        # RGB/RGBA → grayscale → 인덱스 (비-palette 이미지 fallback)
        return None
    except Exception:
        return None


def _load_pixel_indices(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """Palette PNG → uint8 인덱스 배열 로드. 최소 오버헤드."""
    full_path = IMAGES_ROOT / image_rel_path

    # PIL 직접 로드 (가장 빠른 경로 — pyvips는 palette→RGB 확장이라 느림)
    try:
        with Image.open(full_path) as img:
            img.load()
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)
            if img.mode == 'P':
                pixel_indices = np.array(img, dtype=np.uint8)
            else:
                pixel_indices = np.array(img.convert('L'), dtype=np.uint8) // 32
            # 투명도 처리
            if 'A' in img.getbands():
                pixel_indices[np.array(img.getchannel('A')) == 0] = 31
    except Exception:
        return None

    return pixel_indices


def _iter_pixel_indices(
    image_paths: List[str],
    width: int,
    height: int,
    loader_mode: str,
    max_workers: Optional[int],
    progress_callback: Optional[Callable[[int, int], None]] = None
):
    """
    병렬 처리 최적화:
    - ThreadPoolExecutor는 I/O bound 작업에 효율적 (기본값)
    - chunksize로 작업 분배 효율화
    - progress_callback: 진행률 콜백 (current, total)
    """
    if not image_paths:
        return []
    normalized_mode = (loader_mode or "thread").lower()
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    worker_count = min(max(1, max_workers), len(image_paths))
    # 🔥 fast 모드에서는 워커 수를 조금 더 공격적으로 사용 (이미 상단에서 기본값 상향)
    def loader(rel_path: str) -> Optional[np.ndarray]:
        return _load_pixel_indices(rel_path, width, height)

    total = len(image_paths)
    processed = 0

    if normalized_mode in {"sequential", "none"} or worker_count <= 1:
        for rel_path in image_paths:
            result = loader(rel_path)
            processed += 1
            if progress_callback:
                progress_callback(processed, total)
            yield rel_path, result
        return

    # ThreadPoolExecutor를 기본으로 사용 (I/O bound에 효율적)
    executor_cls = ThreadPoolExecutor
    if normalized_mode in {"process", "proc", "multiprocess"}:
        executor_cls = ProcessPoolExecutor

    # chunksize 계산: 작업 분배 최적화
    # 🔥 대용량 이미지에서는 chunksize를 1로 고정 (각 이미지가 크므로)
    chunksize = 1

    with executor_cls(max_workers=worker_count) as executor:
        for rel_path, result in zip(
            image_paths,
            executor.map(loader, image_paths, chunksize=chunksize)
        ):
            processed += 1
            if progress_callback:
                progress_callback(processed, total)
            yield rel_path, result


def _batched_paths(paths: Sequence[str], batch_size: int) -> Sequence[Sequence[str]]:
    """
    Yield path slices to cap concurrent decode jobs.
    """
    if batch_size <= 0:
        batch_size = 1
    for start in range(0, len(paths), batch_size):
        yield paths[start : start + batch_size]


def _render_sum_map_image(
    base_indices: np.ndarray,
    value_map: np.ndarray,
    mask: np.ndarray,
    palette_list: List[int],
    quantiles: Sequence[float],
    color_stops: np.ndarray,
    lut_colors: Optional[np.ndarray] = None,
    value_min: Optional[float] = None,
    value_max: Optional[float] = None,
    force_full_range: bool = False,
    _base_rgb: Optional[np.ndarray] = None,
):
    rgb_palette = np.array(palette_list, dtype=np.uint8).reshape(256, 3)

    # Early exit if no calculation needed
    if not (mask.any() and len(color_stops) >= 1):
        if _base_rgb is not None:
            return _base_rgb.copy()
        return rgb_palette[base_indices]

    calc_values = value_map[mask].astype(np.float32, copy=False)
    if calc_values.size == 0:
        if _base_rgb is not None:
            return _base_rgb.copy()
        return rgb_palette[base_indices]

    if lut_colors is None:
        quantile_positions = None
        if quantiles:
            quantile_positions = np.asarray(quantiles, dtype=np.float32) * 100.0
        lut_positions = np.linspace(0.0, 100.0, 256, dtype=np.float32)
        lut_colors_local = _interpolate_percentile_colors(lut_positions, color_stops, quantile_positions)
    else:
        lut_colors_local = lut_colors

    finite_values = calc_values[np.isfinite(calc_values)]
    if finite_values.size == 0:
        if _base_rgb is not None:
            return _base_rgb.copy()
        return rgb_palette[base_indices]

    resolved_min = float(value_min if value_min is not None else finite_values.min())
    resolved_max = float(value_max if value_max is not None else finite_values.max())

    # numba 고속 렌더링 (force_full_range 전용, 50x 빠름)
    if force_full_range and _HAS_NUMBA and _numba_render_composite is not None:
        lut_colors_arr = lut_colors_local if lut_colors_local is not None else lut_colors
        if lut_colors_arr is not None:
            rgb_array = _numba_render_composite(
                base_indices, rgb_palette,
                value_map, mask.astype(np.bool_),
                lut_colors_arr.astype(np.uint8),
                resolved_min, resolved_max,
            )
            return rgb_array

    # numpy fallback
    if force_full_range:
        denom = resolved_max - resolved_min
        if denom <= 0:
            if resolved_max > 0:
                lut_idx = np.full(calc_values.shape, 255, dtype=np.uint8)
            else:
                lut_idx = np.zeros(calc_values.shape, dtype=np.uint8)
        else:
            scaled = (calc_values - resolved_min) / denom
            lut_idx = np.clip(np.rint(scaled * 255.0), 0, 255).astype(np.uint8, copy=False)
    else:
        percentiles = _percentile_ranks(
            calc_values,
            value_min=resolved_min,
            value_max=resolved_max,
        )
        lut_idx = np.clip(np.rint(percentiles * 2.55), 0, 255).astype(np.uint8, copy=False)

    # numpy composite
    if _base_rgb is not None:
        base_rgb = _base_rgb
    else:
        base_rgb = rgb_palette[base_indices]
    overlay = np.empty_like(base_rgb)
    overlay[mask] = lut_colors_local[lut_idx]
    rgb_array = np.where(mask[:, :, np.newaxis], overlay, base_rgb)

    # rgb_array is already uint8, no need for astype
    return rgb_array


# ── Palette-indexed sum map (default palette로 생성, UI에서 PLTE 패치로 개인색 표시) ──

COMPOSITE_GRADIENT_START = 24   # gradient 시작 팔레트 인덱스
COMPOSITE_GRADIENT_END = 255    # gradient 끝 팔레트 인덱스
COMPOSITE_GRADIENT_COUNT = COMPOSITE_GRADIENT_END - COMPOSITE_GRADIENT_START + 1  # 232


def _build_composite_gradient_entries(scheme: str = "default") -> List[int]:
    """composite gradient 색상을 palette 바이트로 반환 (indices 24-255 → 232*3=696 bytes)."""
    from .composite_colors import load_composite_color_settings
    settings = load_composite_color_settings(scheme)
    stops = [_hex_to_rgb_tuple(c) for c in settings.colors]

    gradient: List[int] = []
    for i in range(COMPOSITE_GRADIENT_COUNT):
        pct = i / max(COMPOSITE_GRADIENT_COUNT - 1, 1) * 100.0
        idx_f = pct / 10.0
        lo = max(0, min(10, int(idx_f)))
        hi = min(10, lo + 1)
        t = idx_f - lo
        r0, g0, b0 = stops[lo]
        r1, g1, b1 = stops[hi]
        gradient.extend([
            int(r0 + (r1 - r0) * t),
            int(g0 + (g1 - g0) * t),
            int(b0 + (b1 - b0) * t),
        ])
    return gradient


def _build_sum_map_palette(source_palette_list: List[int], gradient_scheme: str = "default") -> List[int]:
    """sum map용 전체 팔레트 (256*3=768 bytes).

    - index 0-23: source palette (Grade/border/bg 색상)
    - index 24-255: composite gradient (default 색상)
    """
    palette = list(source_palette_list[:768])
    if len(palette) < 768:
        palette.extend([0] * (768 - len(palette)))
    gradient = _build_composite_gradient_entries(gradient_scheme)
    palette[COMPOSITE_GRADIENT_START * 3:] = gradient
    return palette


def _render_sum_map_palette(
    base_indices: np.ndarray,
    value_map: np.ndarray,
    mask: np.ndarray,
    value_min: Optional[float] = None,
    value_max: Optional[float] = None,
) -> np.ndarray:
    """sum map을 palette index 배열로 렌더링 (RGB가 아닌 (H,W) uint8).

    - base 영역: base_indices 그대로 (0-23)
    - gradient 영역 (mask=True): percentile → index 24-255
    """
    result = base_indices.copy()

    if not mask.any():
        return result

    calc_values = value_map[mask].astype(np.float32, copy=False)
    finite_values = calc_values[np.isfinite(calc_values)]
    if finite_values.size == 0:
        return result

    v_min = value_min if value_min is not None else float(finite_values.min())
    v_max = value_max if value_max is not None else float(finite_values.max())

    denom = v_max - v_min
    if denom <= 0:
        grad_idx = np.full(calc_values.shape, COMPOSITE_GRADIENT_END if v_max > 0 else COMPOSITE_GRADIENT_START, dtype=np.uint8)
    else:
        scaled = (calc_values - v_min) / denom
        grad_idx = np.clip(
            np.rint(scaled * (COMPOSITE_GRADIENT_COUNT - 1) + COMPOSITE_GRADIENT_START),
            COMPOSITE_GRADIENT_START, COMPOSITE_GRADIENT_END
        ).astype(np.uint8, copy=False)

    result[mask] = grad_idx
    return result


def _save_palette_png(index_array: np.ndarray, palette_list: List[int], path: Path) -> Tuple[Path, str]:
    """palette-indexed PNG로 저장."""
    from PIL import Image as _PILImage
    path = path.with_suffix(".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    img = _PILImage.fromarray(index_array.astype(np.uint8, copy=False), mode="P")
    img.putpalette(palette_list[:768])
    img.save(str(path), format="PNG", optimize=False, compress_level=_PALETTE_PNG_COMPRESSION_LEVEL)
    rel = path.relative_to(IMAGES_ROOT).as_posix()
    return path, rel


def _trace_enabled() -> bool:
    return os.getenv("COMPOSITE_TIMING", "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _use_sum_float16() -> bool:
    return False  # fixed to float32


def _resolve_save_backend() -> Tuple[str, str]:
    return _SAVE_BACKEND, _SAVE_FORMAT

def _image_ext() -> str:
    fmt = _SAVE_FORMAT
    if fmt == "WEBP":
        return ".webp"
    if fmt == "JPEG":
        return ".jpg"
    return ".png"


def _save_image_with_backend(img, path: Path, quality: Optional[int] = None) -> Tuple[Path, str]:
    """
    Save image with selectable backend/format.
    Accepts PIL Image or numpy RGB array (H, W, 3).
    quality: JPEG 품질 오버라이드 (None이면 _JPEG_QUALITY 사용)
    Returns: (actual_path, rel_path)
    """
    backend, fmt = _resolve_save_backend()
    jpeg_q = quality if quality is not None else _JPEG_QUALITY

    target_path = path
    if fmt == "WEBP":
        target_path = path.with_suffix(".webp")
    elif fmt == "JPEG":
        target_path = path.with_suffix(".jpg")

    # 부모 디렉토리 생성 (Measure Composite 등에서 아직 없을 수 있음)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # numpy 배열이면 직접 처리 (PIL 변환 없이 최고속 저장)
    if isinstance(img, np.ndarray):
        arr = img
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=2)
        if backend == "turbo" and _HAS_TURBOJPEG and fmt == "JPEG":
            encoded = _TURBOJPEG.encode(arr, quality=jpeg_q, jpeg_subsample=TJSAMP_420, pixel_format=TJPF_RGB)
            tmp_path = target_path.with_suffix(f"{target_path.suffix}.tmp")
            tmp_path.write_bytes(encoded)
            try:
                tmp_path.replace(target_path)
            except Exception:
                if target_path.exists():
                    target_path.unlink()
                tmp_path.rename(target_path)
        elif _HAS_PYVIPS:
            h, w, c = arr.shape
            vips_img = _vips.Image.new_from_memory(arr.tobytes(), w, h, c, format="uchar")
            if fmt == "WEBP":
                vips_img.write_to_file(str(target_path), Q=100, lossless=1)
            elif fmt == "JPEG":
                vips_img.write_to_file(str(target_path), Q=jpeg_q, strip=True, optimize_coding=True)
            else:
                vips_img.write_to_file(str(target_path), compression=0)
        else:
            pil_img = Image.fromarray(arr, mode='RGB')
            if fmt == "JPEG":
                pil_img.save(target_path, format="JPEG", quality=jpeg_q, subsampling=0, optimize=True)
            elif fmt == "WEBP":
                pil_img.save(target_path, format="WEBP", quality=100, lossless=True, method=6)
            else:
                pil_img.save(target_path, format='PNG', optimize=False, compress_level=0)
        rel_path = target_path.relative_to(IMAGES_ROOT).as_posix()
        return target_path, rel_path

    # PIL Image 경로 (기존 호환)
    save_img = img
    if fmt == "JPEG" and img.mode != "RGB":
        save_img = img.convert("RGB")

    if backend == "vips" and _HAS_PYVIPS:
        arr = np.array(save_img, dtype=np.uint8)
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=2)
        h, w, c = arr.shape
        vips_img = _vips.Image.new_from_memory(arr.tobytes(), w, h, c, format="uchar")
        if fmt == "WEBP":
            vips_img.write_to_file(str(target_path), Q=100, lossless=1)
        elif fmt == "JPEG":
            vips_img.write_to_file(str(target_path), Q=jpeg_q, strip=True, optimize_coding=True)
        else:
            vips_img.write_to_file(str(target_path), compression=0)
    elif backend == "turbo" and _HAS_TURBOJPEG and fmt == "JPEG":
        arr = np.array(save_img, dtype=np.uint8)
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=2)
        encoded = _TURBOJPEG.encode(arr, quality=jpeg_q, jpeg_subsample=TJSAMP_420, pixel_format=TJPF_RGB)
        tmp_path = target_path.with_suffix(f"{target_path.suffix}.tmp")
        tmp_path.write_bytes(encoded)
        try:
            tmp_path.replace(target_path)
        except Exception:
            if target_path.exists():
                target_path.unlink()
            tmp_path.rename(target_path)
    else:
        if fmt == "WEBP":
            save_img.save(target_path, format="WEBP", quality=100, lossless=True, method=6)
        elif fmt == "JPEG":
            save_img.save(target_path, format="JPEG", quality=jpeg_q, subsampling=0, optimize=True)
        else:
            save_img.save(target_path, format='PNG', optimize=False, compress_level=0)

    rel_path = target_path.relative_to(IMAGES_ROOT).as_posix()
    return target_path, rel_path


def _save_npz_payload(
    fp,
    payload: Dict[str, np.ndarray],
    *,
    compress: bool,
    compress_level: int,
) -> None:
    """Persist npz payload with tunable compression level."""
    if not compress or compress_level <= 0:
        np.savez(fp, **payload)
        return

    with zipfile.ZipFile(
        fp,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=compress_level,
    ) as zf:
        for key, value in payload.items():
            with zf.open(f"{key}.npy", mode="w") as member:
                np.lib.format.write_array(member, np.asanyarray(value), allow_pickle=False)


def _persist_square_map_data(
    output_dir: Path,
    palette_list: Sequence[int],
    base_indices: np.ndarray,
    square_mean_map: Optional[np.ndarray] = None,
    weighted_map: Optional[np.ndarray] = None,
    calc_mask: Optional[np.ndarray] = None,
    weighted_mask: Optional[np.ndarray] = None,
    grade_counts: Optional[np.ndarray] = None,
    invalid_mask: Optional[np.ndarray] = None,
    idx_8_mask: Optional[np.ndarray] = None,
    image_count: Optional[int] = None,
    color_scheme: Optional[str] = None,
    colors: Optional[Sequence[str]] = None,
) -> None:
    """
    Cache square-map arrays for fast recoloring.
    Recolor 요청이 생성 직후 바로 들어와도 동작하도록 NPZ를 동기 저장한다.
    """
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    palette_array = np.array(palette_list, dtype=np.uint8).reshape(256, 3)
    save_payload: Dict[str, np.ndarray] = {
        "base_indices": base_indices.astype(np.uint8, copy=False),
        "palette": palette_array,
    }
    store_full_maps = (
        grade_counts is None
        or os.getenv("COMPOSITE_NPZ_STORE_FULL_MAPS", "0").strip().lower()
        in {"1", "true", "yes", "y", "on"}
    )
    if store_full_maps:
        if square_mean_map is not None:
            save_payload["square_mean"] = square_mean_map.astype(square_mean_map.dtype, copy=False)
        if weighted_map is not None:
            save_payload["square_weighted"] = weighted_map.astype(weighted_map.dtype, copy=False)
        if calc_mask is not None:
            save_payload["calc_mask"] = calc_mask.astype(bool, copy=False)
        if weighted_mask is not None:
            save_payload["weighted_mask"] = weighted_mask.astype(bool, copy=False)
    if grade_counts is not None:
        save_payload["grade_counts"] = grade_counts.astype(np.uint16, copy=False)
    if invalid_mask is not None:
        save_payload["invalid_mask"] = invalid_mask.astype(bool, copy=False)
    if idx_8_mask is not None:
        save_payload["idx_8_mask"] = idx_8_mask.astype(bool, copy=False)
    if image_count is not None:
        save_payload["source_image_count"] = np.array(image_count, dtype=np.uint32)
    if color_scheme:
        save_payload["color_scheme"] = np.array([color_scheme], dtype="U32")
    if colors:
        save_payload["colors"] = np.array(list(colors), dtype="U16")

    def _save_npz():
        tmp = cache_path.with_name(cache_path.stem + "_tmp.npz")
        try:
            # np.savez는 .npz로 끝나지 않으면 자동 추가 → _tmp.npz 사용 (추가 방지)
            _save_npz_payload(
                tmp,
                save_payload,
                compress=_CACHE_COMPRESS,
                compress_level=_CACHE_COMPRESS_LEVEL,
            )
            try:
                tmp.replace(cache_path)
            except Exception:
                try:
                    if cache_path.exists():
                        cache_path.unlink()
                    tmp.rename(cache_path)
                except Exception as rename_err:
                    logger.warning("[NPZ] rename failed (%s → %s): %s", tmp.name, cache_path.name, rename_err)
        except Exception as save_err:
            logger.warning("[NPZ] save failed (%s): %s", tmp.name, save_err)
        finally:
            # 항상 tmp 파일 정리 시도
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:
                pass
    # 🔥 동기 저장 (recolor가 생성 직후 NPZ를 참조)
    # grade_counts를 uint8로 저장하여 크기 절감 (최대 256장 → uint8 충분)
    if "grade_counts" in save_payload:
        gc = save_payload["grade_counts"]
        if gc.max() <= 255:
            save_payload["grade_counts"] = gc.astype(np.uint8, copy=False)
    _save_npz()


def _recompute_square_maps_from_counts(
    grade_counts: np.ndarray,
    only_low_mask: Optional[np.ndarray],
    invalid_mask: Optional[np.ndarray],
    idx_8_mask: Optional[np.ndarray],
    image_count: Optional[int],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    square_average / square_weighted_average를 grade별 카운트로부터 재계산.
    composite_map 폴더에 캐시된 point별 인덱스 카운트(및 optional mask)를 활용한다.
    """
    if grade_counts.ndim != 3:
        raise ValueError("grade_counts must be a 3D array (grade, H, W)")
    grade_dim = grade_counts.shape[0]
    if grade_dim == 0:
        raise ValueError("grade_counts must include at least one grade axis")

    selected_grades = list(range(min(grade_dim, 8)))
    if not selected_grades:
        raise ValueError("No grade indices available to recompute square maps")

    bool_low_mask = only_low_mask.astype(bool, copy=False) if only_low_mask is not None else None
    bool_invalid_mask = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    bool_idx8_mask = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None

    square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
        grade_counts=grade_counts,
        selected_grades=selected_grades,
        invalid_mask=bool_invalid_mask,
        idx_8_mask=bool_idx8_mask,
        only_low_mask=bool_low_mask,
        image_count=image_count,
    )
    return square_mean_map, weighted_map, calc_mask, weighted_mask


def recolor_saved_sum_maps(
    output_dir: Path,
    override_colors: Optional[Sequence[str]] = None,
    scheme: Optional[str] = None,
) -> List[Dict[str, str]]:
    """
    Reload cached square-map arrays and regenerate PNGs with updated colors.
    """
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    if not cache_path.exists():
        raise FileNotFoundError(f"Square map cache not found: {cache_path}")

    with np.load(cache_path) as data:
        cached_square_mean = data["square_mean"] if "square_mean" in data.files else None
        cached_weighted = data["square_weighted"] if "square_weighted" in data.files else None
        calc_mask = data["calc_mask"].astype(bool) if "calc_mask" in data.files else None
        weighted_mask = data["weighted_mask"].astype(bool) if "weighted_mask" in data.files else None
        base_indices = data["base_indices"].astype(np.uint8)
        palette_array = data["palette"].astype(np.uint8)
        grade_counts = data.get("grade_counts")
        invalid_mask = data.get("invalid_mask")
        idx_8_mask = data.get("idx_8_mask")
        image_count_arr = data.get("source_image_count")
        source_image_count = int(image_count_arr.item()) if image_count_arr is not None else None
        color_scheme_arr = data.get("color_scheme")
        colors_arr = data.get("colors")
    grade_counts_arr = grade_counts.astype(np.uint16, copy=False) if grade_counts is not None else None
    invalid_mask_arr = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    idx_8_mask_arr = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None
    cached_scheme = None
    if color_scheme_arr is not None:
        try:
            cached_scheme = str(np.atleast_1d(color_scheme_arr).ravel()[0])
        except Exception:
            cached_scheme = None

    chip_inner_mask = (base_indices == 0)

    if grade_counts_arr is not None:
        try:
            square_mean_map, weighted_map, calc_mask, weighted_mask = _recompute_square_maps_from_counts(
                grade_counts=grade_counts_arr,
                only_low_mask=chip_inner_mask,
                invalid_mask=invalid_mask_arr,
                idx_8_mask=idx_8_mask_arr,
                image_count=source_image_count,
            )
        except Exception:
            if cached_square_mean is None or cached_weighted is None:
                raise
            square_mean_map = cached_square_mean
            weighted_map = cached_weighted
    else:
        if cached_square_mean is None or cached_weighted is None or calc_mask is None or weighted_mask is None:
            raise ValueError("square map cache does not include full maps or grade_counts")
        square_mean_map = cached_square_mean
        weighted_map = cached_weighted
    palette_list = palette_array.reshape(-1).tolist()
    resolved_scheme = (scheme or cached_scheme or ANONYMOUS_LOGIN_ID).strip() or ANONYMOUS_LOGIN_ID
    settings = load_composite_color_settings(resolved_scheme)
    # 🔥 개인색 미적용 — default palette로 저장, UI에서 PLTE 패치로 개인색 표시
    if override_colors:
        colors_to_use: List[str] = []
        for idx, base_color in enumerate(settings.colors):
            candidate = override_colors[idx] if idx < len(override_colors) else None
            if candidate:
                try:
                    colors_to_use.append(normalize_hex_color(candidate))
                    continue
                except ValueError:
                    pass
            colors_to_use.append(base_color)
    else:
        colors_to_use = settings.colors

    # 🔥 Palette PNG로 저장 (default palette + UI에서 PLTE 패치로 개인색 표시)
    sum_palette = _build_sum_map_palette(palette_list, gradient_scheme="default")
    variants = [
        ("square_average.png", "square_mean", "Composite SqMean", square_mean_map, calc_mask),
        ("square_weighted_average.png", "weighted_square_mean", "Composite Weighted SqMean", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    subset_outputs: List[Dict[str, str]] = []

    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        # 기존 JPEG/WEBP 파일 삭제 (palette PNG로 교체)
        for old_ext in (".jpg", ".webp"):
            old_file = sum_map_path.with_suffix(old_ext)
            if old_file.exists():
                old_file.unlink(missing_ok=True)
        v_min, v_max = _value_range_for_map(data_map, mask, clamp_min_to_zero=True)
        idx_arr = _render_sum_map_palette(
            base_indices=base_indices, value_map=data_map, mask=mask,
            value_min=v_min, value_max=v_max,
        )
        actual_path, rel_path = _save_palette_png(idx_arr, sum_palette, sum_map_path)
        outputs.append({
            "path": rel_path, "type": variant_type,
            "display_name": display_name, "filename": actual_path.name,
        })

    # 최신 색상/스킴으로 NPZ 캐시도 갱신하여 추후 subset 생성 시 일관되게 사용
    try:
        _persist_square_map_data(
            output_dir=output_dir,
            palette_list=palette_list,
            base_indices=base_indices,
            square_mean_map=square_mean_map,
            weighted_map=weighted_map,
            calc_mask=calc_mask,
            weighted_mask=weighted_mask,
            grade_counts=grade_counts_arr,
            invalid_mask=invalid_mask_arr,
            idx_8_mask=idx_8_mask_arr,
            image_count=source_image_count,
            color_scheme=settings.scheme,
            colors=colors_to_use,
        )
    except Exception as exc:
        print(f"[recolor_saved_sum_maps] Failed to persist updated NPZ: {exc}")

    # Subset PNG들도 같은 색상 설정으로 재렌더링 (grade_counts가 있을 때만 가능)
    if grade_counts_arr is not None:
        subset_map_targets: Dict[Tuple[int, ...], Dict[str, str]] = {}
        for candidate in output_dir.glob("square_*average_*.*"):
            grades = _extract_subset_grades(candidate.name)
            if not grades:
                continue
            key = tuple(grades)
            bucket = subset_map_targets.setdefault(key, {})
            if "weighted" in candidate.name.lower():
                bucket["weighted"] = candidate.name
            else:
                bucket["mean"] = candidate.name

        if subset_map_targets:
            print(f"[recolor_saved_sum_maps] Re-rendering subset maps: {subset_map_targets}")

        for grade_tuple, name_map in subset_map_targets.items():
            try:
                sub_square_mean, sub_weighted, sub_calc_mask, sub_weighted_mask = _compute_maps_from_counts(
                    grade_counts=grade_counts_arr,
                    selected_grades=list(grade_tuple),
                    invalid_mask=invalid_mask_arr,
                    idx_8_mask=idx_8_mask_arr,
                    only_low_mask=chip_inner_mask,
                    image_count=source_image_count,
                    include_unselected_in_denominator=False,
                )
            except Exception as exc:
                print(f"[recolor_saved_sum_maps] Failed subset recompute for grades {grade_tuple}: {exc}")
                continue

            grade_label = ", ".join(map(str, grade_tuple))

            if "mean" in name_map:
                target = output_dir / name_map["mean"]
                render_map = sub_square_mean
                vmin, vmax = _value_range_for_map(render_map, sub_calc_mask, clamp_min_to_zero=True)
                idx_arr = _render_sum_map_palette(
                    base_indices=base_indices, value_map=render_map, mask=sub_calc_mask,
                    value_min=vmin, value_max=vmax,
                )
                for old_ext in (".jpg", ".webp"):
                    old_file = target.with_suffix(old_ext)
                    if old_file.exists():
                        old_file.unlink(missing_ok=True)
                actual_path, rel_path = _save_palette_png(idx_arr, sum_palette, target)
                entry = {
                    "path": rel_path, "type": "square_mean",
                    "display_name": f"Composite SqMean [Grade {grade_label}]",
                    "filename": actual_path.name, "selected_grades": list(grade_tuple),
                }
                outputs.append(entry)
                subset_outputs.append(entry)

            if "weighted" in name_map:
                target = output_dir / name_map["weighted"]
                render_map = sub_weighted
                vmin, vmax = _value_range_for_map(render_map, sub_weighted_mask, clamp_min_to_zero=True)
                idx_arr = _render_sum_map_palette(
                    base_indices=base_indices, value_map=render_map, mask=sub_weighted_mask,
                    value_min=vmin, value_max=vmax,
                )
                for old_ext in (".jpg", ".webp"):
                    old_file = target.with_suffix(old_ext)
                    if old_file.exists():
                        old_file.unlink(missing_ok=True)
                actual_path, rel_path = _save_palette_png(idx_arr, sum_palette, target)
                entry = {
                    "path": rel_path, "type": "weighted_square_mean",
                    "display_name": f"Composite Weighted SqMean [Grade {grade_label}]",
                    "filename": actual_path.name, "selected_grades": list(grade_tuple),
                }
                outputs.append(entry)
                subset_outputs.append(entry)

    return outputs + subset_outputs



def _save_gradient_stats(
    output_dir: Path,
    variants: List[Tuple],
    precomputed_ranges: Dict[int, Tuple[Optional[float], Optional[float]]],
) -> None:
    """Gradient 범례용 pixel 분포 통계를 JSON으로 저장 (~500 bytes).
    단일뷰에서 average map의 0~10%...90~100% 범례 퍼센트/갯수를 표시하는 데 사용.

    성능 최적화: float64 변환+정규화 대신 np.histogram(range=) 직접 사용으로
    10000×10000 이미지 기준 7.6초 → ~100ms (메모리 복사 제거)
    """
    import json as _json
    stats: Dict[str, Any] = {}
    for vi, (filename, variant_type, _, data_map, mask_arr) in enumerate(variants):
        v_min, v_max = precomputed_ranges.get(vi, (None, None))
        if v_min is None or v_max is None or v_max <= v_min:
            continue
        # np.histogram(range=)로 정규화 없이 직접 10-bin 히스토그램
        # data_map[mask_arr]의 float64 변환+정규화+clip 단계를 모두 제거
        bin_edges = np.linspace(float(v_min), float(v_max), 11)
        counts, _ = np.histogram(data_map[mask_arr], bins=bin_edges)
        total = int(counts.sum())
        if total == 0:
            continue
        ranges = []
        for i in range(10):
            c = int(counts[i])
            pct = round(c / total * 100, 1) if total > 0 else 0.0
            ranges.append({"label": f"{i*10}~{(i+1)*10}%", "percent": pct, "count": c})
        stem = Path(filename).stem
        stats[stem] = {"ranges": ranges, "total_pixels": total}

    if stats:
        json_path = output_dir / "gradient_stats.json"
        def _write():
            try:
                json_path.write_text(_json.dumps(stats, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass
        threading.Thread(target=_write, daemon=True).start()


def _save_sum_map_variants(
    all_indices: Optional[np.ndarray],
    output_dir: Path,
    palette_list: Optional[Sequence[int]] = None,
    invalid_mask: Optional[np.ndarray] = None,
    base_indices: Optional[np.ndarray] = None,
    idx_8_mask: Optional[np.ndarray] = None,
    scheme: Optional[str] = None,
    name_suffix: str = "",
    persist_cache: bool = True,
    grade_counts: Optional[np.ndarray] = None,
    only_low_mask: Optional[np.ndarray] = None,
    colors: Optional[Sequence[str]] = None,
    image_count: Optional[int] = None,
) -> List[Dict[str, str]]:
    trace = _trace_enabled()
    # all_indices가 없으면 grade_counts + base_indices + image_count 필수
    if all_indices is not None:
        if all_indices.ndim != 3:
            raise ValueError("all_indices must be (N, H, W)")
        if all_indices.shape[0] == 0:
            return []
        _, height, width = all_indices.shape
        if image_count is None:
            image_count = all_indices.shape[0]
    elif grade_counts is not None and base_indices is not None and image_count is not None:
        height, width = base_indices.shape[:2]
    else:
        raise ValueError("all_indices 또는 (grade_counts + base_indices + image_count) 필요")

    if image_count == 0:
        return []
    sum_float16 = _use_sum_float16()
    float_dtype = np.float16 if sum_float16 else np.float32

    if grade_counts is None:
        if all_indices is None:
            raise ValueError("grade_counts와 all_indices 중 하나는 필수입니다")
        grade_counts = _compute_grade_counts(all_indices)

    # 🔥 numba 단일 패스: square_mean + weighted + masks 동시 계산 (numpy 대비 1.7x)
    if _HAS_NUMBA and _numba_compute_sum_maps is not None:
        square_mean_map, weighted_map, calc_mask, weighted_mask = _numba_compute_sum_maps(
            np.ascontiguousarray(grade_counts, dtype=np.uint32),
            _SQ_WEIGHTS, _WT_FACTORS, image_count,
        )
        # only_low_mask가 있으면 추가 마스킹
        if only_low_mask is not None:
            olm = only_low_mask.astype(bool, copy=False)
            calc_mask &= olm
            weighted_mask &= olm
        if idx_8_mask is not None:
            calc_mask &= ~idx_8_mask
            weighted_mask &= ~idx_8_mask
        if invalid_mask is not None:
            calc_mask &= ~invalid_mask
            weighted_mask &= ~invalid_mask
        # numba 결과에 마스크 적용 (마스크 외부를 0으로)
        square_mean_map[~calc_mask] = 0
        weighted_map[~weighted_mask] = 0
    else:
        # numpy fallback
        grade_counts_float = grade_counts.astype(np.float32, copy=False)
        square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
        square_sums = np.sum(grade_counts_float * square_weights, axis=0, dtype=np.float32)

        if only_low_mask is not None:
            calc_mask = only_low_mask.astype(bool, copy=False).copy()
        else:
            calc_mask = grade_counts_float.sum(axis=0) > 0
            if idx_8_mask is not None:
                calc_mask &= ~idx_8_mask
            if invalid_mask is not None:
                calc_mask &= ~invalid_mask

        square_mean_map = np.zeros_like(square_sums, dtype=float_dtype)
        with np.errstate(divide='ignore', invalid='ignore'):
            square_mean_map[calc_mask] = (square_sums[calc_mask] / float(image_count)).astype(float_dtype, copy=False)

        weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32).reshape(8, 1, 1)
        weight_map = np.sum(grade_counts_float * weight_factors, axis=0, dtype=np.float32)
        weighted_mask = calc_mask & (weight_map > 0)

        weighted_map = np.zeros_like(square_sums, dtype=float_dtype)
        with np.errstate(divide='ignore', invalid='ignore'):
            weighted_map[weighted_mask] = (square_sums[weighted_mask] / weight_map[weighted_mask]).astype(float_dtype, copy=False)


    if base_indices is None:
        if all_indices is not None:
            if _FAST_MEDIAN:
                mean_map = np.mean(all_indices, axis=0, dtype=np.float32)
                base_indices = np.clip(np.rint(mean_map), 0, 13).astype(np.uint8)
            else:
                median_map = np.median(all_indices, axis=0)
                base_indices = np.clip(np.rint(median_map), 0, 13).astype(np.uint8)
        else:
            # all_indices 없이 grade_counts에서 최빈 grade 추정
            base_indices = np.argmax(grade_counts, axis=0).astype(np.uint8)
        if invalid_mask is not None:
            base_indices[invalid_mask] = 31
    else:
        base_indices = base_indices.copy()

    palette = _build_palette_list(palette_list)
    settings = load_composite_color_settings(scheme)
    resolved_colors = list(colors) if colors else settings.colors
    color_stops = np.array([_hex_to_rgb_tuple(c) for c in resolved_colors], dtype=np.float32)
    quantile_positions = None
    if settings.quantiles:
        quantile_positions = np.asarray(settings.quantiles, dtype=np.float32) * 100.0
    lut_positions = np.linspace(0.0, 100.0, 256, dtype=np.float32)
    shared_lut_colors = _interpolate_percentile_colors(lut_positions, color_stops, quantile_positions)

    # 🔥 Palette PNG로 저장 (default palette, UI에서 PLTE 패치로 개인색 표시)
    display_suffix = f" [{name_suffix.lstrip('_')}]" if name_suffix else ""
    sum_palette = _build_sum_map_palette(palette, gradient_scheme="default")
    variants = [
        (f"square_average{name_suffix}.png", "square_mean", f"Composite SqMean{display_suffix}", square_mean_map, calc_mask),
        (f"square_weighted_average{name_suffix}.png", "weighted_square_mean", f"Composite Weighted SqMean{display_suffix}", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []

    # min/max 사전 계산
    _precomputed_ranges: Dict[int, Tuple[Optional[float], Optional[float]]] = {}
    for vi, (_, _, _, data_map, mask_arr) in enumerate(variants):
        values = data_map[mask_arr]
        if values.size > 0:
            finite = values[np.isfinite(values)]
            _precomputed_ranges[vi] = (0.0, float(finite.max())) if finite.size > 0 else (None, None)
        else:
            _precomputed_ranges[vi] = (None, None)

    def _render_and_save_palette(variant_idx, data_map, mask_arr, target_path):
        """palette index 렌더링 + PNG 저장."""
        v_min, v_max = _precomputed_ranges[variant_idx]
        idx_arr = _render_sum_map_palette(
            base_indices=base_indices, value_map=data_map, mask=mask_arr,
            value_min=v_min, value_max=v_max,
        )
        # 기존 JPEG/WEBP 파일 삭제 (palette PNG로 교체)
        for old_ext in (".jpg", ".webp"):
            old_file = target_path.with_suffix(old_ext)
            if old_file.exists():
                old_file.unlink(missing_ok=True)
        actual_path, rel_path = _save_palette_png(idx_arr, sum_palette, target_path)
        return actual_path, rel_path

    # 2장 병렬 저장
    with ThreadPoolExecutor(max_workers=min(len(variants), 4)) as pool:
        futures = []
        for vi, (filename, variant_type, display_name, data_map, mask) in enumerate(variants):
            sum_map_path = output_dir / filename
            fut = pool.submit(_render_and_save_palette, vi, data_map, mask, sum_map_path)
            futures.append((fut, variant_type, display_name))

        for fut, variant_type, display_name in futures:
            actual_path, rel_path = fut.result()
            outputs.append({
                "path": rel_path,
                "type": variant_type,
                "display_name": display_name,
                "filename": actual_path.name,
            })

    # 🔥 NPZ persist — 백그라운드 스레드 (render/save 후 GIL 경쟁 없음)
    if persist_cache:
        _npz_args = dict(
            output_dir=output_dir,
            palette_list=palette,
            base_indices=base_indices,
            square_mean_map=square_mean_map,
            weighted_map=weighted_map,
            calc_mask=calc_mask,
            weighted_mask=weighted_mask,
            grade_counts=grade_counts,
            invalid_mask=invalid_mask,
            idx_8_mask=idx_8_mask,
            image_count=image_count,
            color_scheme=settings.scheme,
            colors=resolved_colors,
        )
        threading.Thread(target=_persist_square_map_data, kwargs=_npz_args, daemon=True).start()

    # 🔥 Gradient 범례용 pixel 분포 JSON 저장 (단일뷰에서 사용)
    _save_gradient_stats(output_dir, variants, _precomputed_ranges)

    return outputs


def _compute_maps_from_counts(
    grade_counts: np.ndarray,
    selected_grades: Sequence[int],
    invalid_mask: Optional[np.ndarray],
    idx_8_mask: Optional[np.ndarray],
    only_low_mask: Optional[np.ndarray] = None,
    image_count: Optional[int] = None,
    include_unselected_in_denominator: bool = False,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    선택된 grade 집합을 기준으로 square_mean / weighted_square_mean을 계산한다.
    include_unselected_in_denominator=True이면 선택되지 않은 grade를 grade 0으로 합산해
    분모(가중치)에만 반영하고, False이면 계산에서 완전히 제외한다.
    """
    if grade_counts.ndim != 3:
        raise ValueError("grade_counts 배열 형식이 올바르지 않습니다.")

    grade_dim = grade_counts.shape[0]
    if grade_dim == 0:
        raise ValueError("grade_counts must include at least one grade axis")

    valid_grades = [g for g in selected_grades if 0 <= g < grade_dim]
    if not valid_grades:
        raise ValueError("selected_grades가 비어있거나 잘못되었습니다.")

    counts_float = grade_counts.astype(np.float32, copy=True)

    all_grades = set(range(grade_dim))
    target_grades = set(valid_grades)
    grades_to_zero = list(all_grades - target_grades)

    if include_unselected_in_denominator and grades_to_zero:
        for grade_idx in grades_to_zero:
            if grade_idx == 0:
                continue
            counts_float[0, :, :] += counts_float[grade_idx, :, :]

    for grade_idx in grades_to_zero:
        counts_float[grade_idx, :, :] = 0.0

    square_weights = (np.arange(grade_dim, dtype=np.float32) ** 2).reshape(grade_dim, 1, 1)
    square_sums = np.sum(counts_float * square_weights, axis=0, dtype=np.float32)

    base_weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32)
    weight_factors = np.ones((grade_dim,), dtype=np.float32)
    limit = min(grade_dim, base_weight_factors.size)
    weight_factors[:limit] = base_weight_factors[:limit]
    weight_factors = weight_factors.reshape(grade_dim, 1, 1)
    weight_map_sum = np.sum(counts_float * weight_factors, axis=0, dtype=np.float32)

    selected_presence = counts_float.sum(axis=0) > 0
    calc_mask = selected_presence.copy()
    if only_low_mask is not None:
        calc_mask &= only_low_mask.astype(bool, copy=False)
    if idx_8_mask is not None:
        calc_mask &= ~idx_8_mask
    if invalid_mask is not None:
        calc_mask &= ~invalid_mask

    if image_count is None or image_count <= 0:
        inferred = counts_float.sum(axis=0).max()
        image_count_value = float(inferred if inferred > 0 else 1.0)
    else:
        image_count_value = float(image_count)

    square_mean_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        square_mean_map[calc_mask] = square_sums[calc_mask] / image_count_value

    weighted_mask = calc_mask & (weight_map_sum > 0)
    weighted_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        weighted_map[weighted_mask] = square_sums[weighted_mask] / weight_map_sum[weighted_mask]

    return square_mean_map, weighted_map, calc_mask, weighted_mask


def _save_shot_local_square_weighted_map(
    output_dir: Path,
    palette_list: Optional[Sequence[int]],
    invalid_mask: Optional[np.ndarray],
    base_indices: np.ndarray,
    idx_8_mask: Optional[np.ndarray],
    scheme: Optional[str],
    grade_counts: np.ndarray,
    only_low_mask: Optional[np.ndarray],
    image_count: int,
) -> List[Dict[str, str]]:
    selected_grades = list(range(min(int(grade_counts.shape[0]), 8)))
    _square_mean_map, weighted_map, _calc_mask, weighted_mask = _compute_maps_from_counts(
        grade_counts=grade_counts,
        selected_grades=selected_grades,
        invalid_mask=invalid_mask,
        idx_8_mask=idx_8_mask,
        only_low_mask=only_low_mask,
        image_count=image_count,
    )

    palette = _build_palette_list(palette_list)
    sum_palette = _build_sum_map_palette(palette, gradient_scheme="default")
    target = output_dir / "shot_local_square_weighted_average.png"
    vmin, vmax = _value_range_for_map(weighted_map, weighted_mask, clamp_min_to_zero=True)
    idx_arr = _render_sum_map_palette(
        base_indices=base_indices,
        value_map=weighted_map,
        mask=weighted_mask,
        value_min=vmin,
        value_max=vmax,
    )
    actual_path, rel_path = _save_palette_png(idx_arr, sum_palette, target)
    _save_gradient_stats(
        output_dir,
        [(actual_path.name, "shot_local_weighted_square_mean", "Shot-local Square Weighted Avg", weighted_map, weighted_mask)],
        {0: (vmin, vmax)},
    )
    return [{
        "path": rel_path,
        "type": "shot_local_weighted_square_mean",
        "display_name": "Shot-local Square Weighted Avg",
        "filename": actual_path.name,
    }]


def create_composite_heatmaps(
    image_paths: List[str],
    indices: List[int] = None,
    create_sum: bool = True,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    batch_size: Optional[int] = None,
    scheme: Optional[str] = None,
    login_id: Optional[str] = None,
    selected_chip_coords: Optional[Sequence[Tuple[int, int]]] = None,
    selected_shot_groups: Optional[Sequence[Dict[str, Any]]] = None,
    shot_local_square_weighted: bool = False,
) -> Dict[str, Any]:
    start_time = time.perf_counter()
    trace = _trace_enabled()
    timings: Dict[str, float] = {}

    def _mark(label: str, started: float):
        timings[label] = time.perf_counter() - started
    if not image_paths:
        raise ValueError("image_paths is empty")

    selected_coord_set = _normalize_selected_chip_coords(selected_chip_coords)
    normalized_shot_groups = _normalize_selected_shot_groups(selected_shot_groups)
    if normalized_shot_groups:
        grouped_coords = {
            coord
            for group in normalized_shot_groups
            for coord in group["coords"]
        }
        selected_coord_set = (selected_coord_set or set()) | grouped_coords

    selected_region_requested = selected_coord_set is not None or bool(normalized_shot_groups)
    t = time.perf_counter()
    if _HAS_NUMBA and not selected_region_requested:
        numba_warm_info = warm_numba_kernels()
        _mark("numba_warmup", t)
    else:
        numba_warm_info = _numba_runtime_info(warmed=False)

    t = time.perf_counter()
    output_dir, timestamp = _prepare_output_dir(login_id)
    _mark("prepare_output_dir", t)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None
    source_width, source_height = width, height

    loader_mode = loader_mode or COMPOSITE_LOADER_MODE
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    batch_size = batch_size or COMPOSITE_BATCH_SIZE

    # 🔥 default palette로 생성 → display 시 개인색 적용 (썸네일 API PLTE 패치)
    default_palette_list = _build_palette_list(source_palette)
    palette_list = _build_palette_list(source_palette)
    # 개인색 미적용 — /api/thumbnail의 personalized=true에서 display 시점에 적용

    if indices is None:
        indices = list(range(8))

    positions_source_path = None
    show_normal_border = True
    shot_geometry = None
    chip_geometry = None
    position_rect_overrides = None
    position_canvas_size = None
    position_grid_edges = None
    selected_chip_count_result = None

    if selected_coord_set is not None or normalized_shot_groups:
        t = time.perf_counter()
        positions_source_path = _first_image_with_positions(image_paths)
        if normalized_shot_groups and not positions_source_path:
            raise ValueError("여러 Shot Composite에는 positions 파일이 필요합니다.")
        if positions_source_path:
            first_pos = _load_source_positions_data(positions_source_path)
            if selected_coord_set is not None and isinstance(first_pos, dict):
                available_coords = {
                    _coord_key_from_chip(chip)
                    for chip in first_pos.get("chips", [])
                    if _coord_key_from_chip(chip) is not None
                }
                selected_coord_set &= available_coords
                if not selected_coord_set and not normalized_shot_groups:
                    raise ValueError("선택한 Chip/Shot이 원본 positions에 없습니다.")
            first_device = str((first_pos or {}).get("device", "")).strip() if first_pos else ""
            if first_device and len(image_paths) > 1:
                for alt_path in image_paths[1:min(4, len(image_paths))]:
                    alt_pos = _load_source_positions_data(alt_path)
                    alt_device = str((alt_pos or {}).get("device", "")).strip() if alt_pos else ""
                    if alt_device and alt_device != first_device:
                        show_normal_border = False
                        break
            if normalized_shot_groups:
                if not isinstance(first_pos, dict):
                    raise ValueError("여러 Shot Composite에는 positions 파일이 필요합니다.")
                shot_geometry = _build_selected_shot_geometry(
                    first_pos,
                    normalized_shot_groups,
                    width=width,
                    height=height,
                    show_normal_border=show_normal_border,
                )
                selected_coord_set = set(shot_geometry["output_coords"])
                position_rect_overrides = shot_geometry["position_rect_overrides"]
                position_canvas_size = shot_geometry["position_canvas_size"]
                position_grid_edges = shot_geometry["position_grid_edges"]
                selected_chip_count_result = shot_geometry["output_chip_count"]
            elif selected_coord_set is not None:
                if not isinstance(first_pos, dict):
                    raise ValueError("선택 Chip Composite에는 positions 파일이 필요합니다.")
                chip_geometry = _build_selected_chip_geometry(
                    first_pos,
                    selected_coord_set,
                    width=width,
                    height=height,
                    show_normal_border=show_normal_border,
                )
                selected_coord_set = set(chip_geometry["output_coords"])
                position_rect_overrides = chip_geometry["position_rect_overrides"]
                position_canvas_size = chip_geometry["position_canvas_size"]
                position_grid_edges = chip_geometry["position_grid_edges"]
                selected_chip_count_result = chip_geometry["source_chip_count"]
        _mark("positions_lookup", t)

    # 🔥 스트리밍 누적 방식: 전체 이미지를 메모리에 올리지 않고 1-pass로 처리
    # numba 사용 시 단일 패스로 마스크+grade 카운트 동시 처리 (2~3x 빠름)
    processed_count = 0
    _use_numba_batch = _HAS_NUMBA and _numba_accumulate_batch is not None
    _use_numba_accum = _HAS_NUMBA and _numba_accumulate_image is not None
    accumulator_mode = "numba_batch" if _use_numba_batch else ("numba_image" if _use_numba_accum else "numpy")

    t = time.perf_counter()
    # 🔥 batch_size를 max_workers*4로 증가 — 배치 라운드 수 최소화하면서 메모리 안정
    effective_batch = max(batch_size, max_workers * 4)
    if _use_numba_batch:
        try:
            target_batch_bytes = max(32, int(os.getenv("COMPOSITE_NUMBA_BATCH_MB", "512"))) * 1024 * 1024
        except ValueError:
            target_batch_bytes = 512 * 1024 * 1024
        bytes_per_image = max(1, int(width) * int(height))
        memory_capped_batch = max(1, target_batch_bytes // bytes_per_image)
        effective_batch = max(1, min(effective_batch, memory_capped_batch, len(image_paths)))

    selected_geometry = shot_geometry or chip_geometry
    if selected_geometry:
        accumulator_mode = (
            "selected_region_numba"
            if _HAS_NUMBA and _numba_accumulate_selected is not None
            else "selected_region"
        )
        grade_counts, has_0_7, has_8_13, all_invalid, processed_count = _accumulate_selected_geometry_from_images(
            image_paths,
            selected_geometry,
            width=width,
            height=height,
            loader_mode=loader_mode,
            max_workers=max_workers,
            batch_size=effective_batch,
        )
        width = int(selected_geometry["width"])
        height = int(selected_geometry["height"])
    else:
        grade_counts = np.zeros((8, height, width), dtype=np.uint32)
        has_0_7 = np.zeros((height, width), dtype=np.bool_)
        has_8_13 = np.zeros((height, width), dtype=np.bool_)
        all_invalid = np.ones((height, width), dtype=np.bool_)
        for batch_paths in _batched_paths(image_paths, effective_batch):
            if _use_numba_batch:
                batch_arrays: List[np.ndarray] = []
                for rel_path, raw_indices in _iter_pixel_indices(
                    batch_paths,
                    width=width,
                    height=height,
                    loader_mode=loader_mode,
                    max_workers=max_workers,
                ):
                    if raw_indices is None:
                        continue
                    img = raw_indices.astype(np.uint8, copy=False)
                    if not img.flags.c_contiguous:
                        img = np.ascontiguousarray(img, dtype=np.uint8)
                    batch_arrays.append(img)
                if batch_arrays:
                    stacked = np.stack(batch_arrays, axis=0)
                    _numba_accumulate_batch(stacked, grade_counts, has_0_7, has_8_13, all_invalid)
                    processed_count += int(stacked.shape[0])
                    del stacked, batch_arrays
                continue

            for rel_path, raw_indices in _iter_pixel_indices(
                batch_paths,
                width=width,
                height=height,
                loader_mode=loader_mode,
                max_workers=max_workers,
            ):
                if raw_indices is None:
                    continue
                img = raw_indices.astype(np.uint8, copy=False)

                if _use_numba_accum:
                    # numba 단일 패스: 마스크 + grade 카운트 동시 처리
                    _numba_accumulate_image(img, grade_counts, has_0_7, has_8_13, all_invalid)
                else:
                    # numpy 경로 (numba 미사용) — 벡터화
                    ge14 = img >= 14
                    ge8 = img >= 8
                    mid = ge8 & ~ge14
                    has_0_7 |= (~ge8) | ge14
                    has_8_13 |= mid
                    all_invalid &= ge14
                    # 0~7은 해당 grade로 누적, invalid(14+)는 grade 0으로 누적.
                    # 8~13은 bottom/border 계열이라 grade count에는 넣지 않는다.
                    if ge14.any():
                        grade_counts[0] += ge14
                    for grade_idx in range(8):
                        grade_counts[grade_idx] += (img == grade_idx)

                processed_count += 1
    _mark("load_and_accumulate", t)

    if processed_count == 0:
        raise ValueError("처리할 이미지가 없습니다.")

    idx_8_13_only = has_8_13 & ~has_0_7
    # uint16 변환은 NPZ persist 시점에서 수행 (여기서는 uint32 유지로 ~400ms 절약)

    composite_sample_count = processed_count
    if shot_geometry:
        composite_sample_count = processed_count * shot_geometry["shot_count"]
    elif chip_geometry:
        composite_sample_count = processed_count * chip_geometry["source_chip_count"]

    # positions 기반 정보 — _count_unique_devices는 JSON 로드가 비싸므로
    # positions_source_path 탐색과 통합. 선택 영역 geometry는 누적 전에 이미 준비한다.
    if "positions_lookup" not in timings:
        t = time.perf_counter()
        positions_source_path = _first_image_with_positions(image_paths)
        if positions_source_path:
            first_pos = _load_source_positions_data(positions_source_path)
            first_device = str((first_pos or {}).get("device", "")).strip() if first_pos else ""
            if first_device and len(image_paths) > 1:
                for alt_path in image_paths[1:min(4, len(image_paths))]:
                    alt_pos = _load_source_positions_data(alt_path)
                    alt_device = str((alt_pos or {}).get("device", "")).strip() if alt_pos else ""
                    if alt_device and alt_device != first_device:
                        show_normal_border = False
                        break
        _mark("positions_lookup", t)

    # (idx_8_13_only를 제외한 포인트 중 0-7이 있는 것)
    t = time.perf_counter()
    only_0_7_mask = has_0_7 & ~has_8_13  # (H, W) - invalid는 이미 0으로 변환되어 포함
    invalid_mask = all_invalid  # 🔥 모든 이미지가 invalid인 포인트만
    invalid_mask_bool = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    chip_area = has_0_7 | idx_8_13_only
    if invalid_mask_bool is not None:
        chip_area &= ~invalid_mask_bool

    base_indices = None
    if shot_geometry:
        width = shot_geometry["width"]
        height = shot_geometry["height"]
        base_indices = shot_geometry["base_indices"]
    elif chip_geometry:
        width = chip_geometry["width"]
        height = chip_geometry["height"]
        base_indices = chip_geometry["base_indices"]
    elif positions_source_path:
        base_indices = _build_chip_base_indices_from_positions(
            positions_source_path,
            width=width,
            height=height,
            show_normal_border=show_normal_border,
            selected_chip_coords=selected_coord_set,
        )
    if base_indices is None:
        # positions.json 없을 때 fallback: chip 영역은 grade0, 나머지는 배경색
        base_indices = np.full((height, width), 8, dtype=np.uint8)
        base_indices[chip_area] = 0

    selection_crop = None
    if selected_coord_set is not None and positions_source_path and not (shot_geometry or chip_geometry):
        selection_crop = _find_selected_region_crop(base_indices)
        if selection_crop:
            selection_crop.update({
                "source_width": width,
                "source_height": height,
            })
            crop_x = selection_crop["x"]
            crop_y = selection_crop["y"]
            crop_x1 = crop_x + selection_crop["width"]
            crop_y1 = crop_y + selection_crop["height"]
            grade_counts = grade_counts[:, crop_y:crop_y1, crop_x:crop_x1].copy()
            has_0_7 = has_0_7[crop_y:crop_y1, crop_x:crop_x1].copy()
            has_8_13 = has_8_13[crop_y:crop_y1, crop_x:crop_x1].copy()
            all_invalid = all_invalid[crop_y:crop_y1, crop_x:crop_x1].copy()
            base_indices = base_indices[crop_y:crop_y1, crop_x:crop_x1].copy()
            height, width = base_indices.shape[:2]

    # Recompute masks after a selected-region crop so every output variant uses
    # the same selected Shot/Chip dimensions.
    idx_8_13_only = has_8_13 & ~has_0_7
    invalid_mask = all_invalid
    invalid_mask_bool = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    chip_inner_mask = (base_indices == 0)
    _mark("mask_and_base_setup", t)

    heatmaps: List[Dict[str, Any]] = []
    palette_bytes = palette_list[:]
    # 🔥 heatmap PNG용 default palette bytes (개인색 미적용, 인덱스 보존)
    default_palette_bytes = default_palette_list[:]
    grade_presence = grade_counts > 0
    invalid_mask_bool = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None

    t = time.perf_counter()
    heatmap_times = []

    # 공유 palette array for sum map 렌더링 (개인색 적용)
    _palette_rgb = np.array(palette_bytes, dtype=np.uint8).reshape(256, 3) if palette_bytes else None
    del _palette_rgb

    # 🔥 사전 계산: 각 grade의 최종 마스크 (invalid 제외, chip_inner만)
    _heatmap_masks = []
    for idx in range(8):
        m = grade_presence[idx].copy()
        if invalid_mask_bool is not None:
            m &= ~invalid_mask_bool
        m &= chip_inner_mask
        _heatmap_masks.append(m)
    selection_chip_inner_pixels = int(np.count_nonzero(chip_inner_mask))
    selection_grade_pixel_counts = [int(np.count_nonzero(mask)) for mask in _heatmap_masks]
    selection_top_grades = [
        {
            "grade": idx,
            "pixel_count": count,
            "percentage": round(count / selection_chip_inner_pixels * 100, 3) if selection_chip_inner_pixels else 0.0,
        }
        for idx, count in sorted(
            enumerate(selection_grade_pixel_counts),
            key=lambda item: item[1],
            reverse=True,
        )
        if count > 0
    ]

    def _save_heatmap_task(idx: int) -> Optional[Dict[str, Any]]:
        t_hm = time.perf_counter()
        presence_mask = _heatmap_masks[idx]
        # np.where로 copy 없이 결과 생성 (47MB copy 제거)
        result = np.where(presence_mask, np.uint8(idx), base_indices)

        heatmap_path = output_dir / f"Grade_{idx}.png"
        actual_path, rel_path = _save_palette_png(result, default_palette_bytes, heatmap_path)
        total_pixels = width * height
        pixel_count = int(np.count_nonzero(presence_mask))
        percentage = round(pixel_count / total_pixels * 100, 2) if total_pixels else 0
        heatmap_time = time.perf_counter() - t_hm
        return {
            "index": idx,
            "path": rel_path,
            "pixel_count": pixel_count,
            "max_count": composite_sample_count,
            "percentage": percentage,
            "heatmap_time": heatmap_time,
        }

    # 🔥 heatmaps(8장) + sum_maps(2장) 동시 실행 (I/O 겹침 최대화)
    valid_indices = [idx for idx in indices if idx < 8]
    sum_map_entries: List[Dict[str, str]] = []
    sum_map_rel_path = None
    shot_local_square_weighted = bool(shot_local_square_weighted and shot_geometry)

    if shot_local_square_weighted:
        sum_map_entries = _save_shot_local_square_weighted_map(
            output_dir=output_dir,
            palette_list=palette_bytes,
            invalid_mask=invalid_mask,
            base_indices=base_indices,
            idx_8_mask=idx_8_13_only,
            scheme=scheme,
            grade_counts=grade_counts,
            only_low_mask=chip_inner_mask,
            image_count=composite_sample_count,
        )
        if sum_map_entries:
            sum_map_rel_path = sum_map_entries[0]["path"]
    else:
        with ThreadPoolExecutor(max_workers=min(len(valid_indices), 8) + 1) as pool:
            # heatmap 작업 제출
            hm_futures = [pool.submit(_save_heatmap_task, idx) for idx in valid_indices]

            # sum map 작업도 같은 풀에 제출 (heatmap과 동시 실행)
            sum_future = None
            if create_sum:
                sum_future = pool.submit(
                    _save_sum_map_variants,
                    None, output_dir, palette_bytes,
                    invalid_mask, base_indices, idx_8_13_only, scheme,
                    "", False, grade_counts, chip_inner_mask, None, composite_sample_count,
                )

            # heatmap 결과 수집
            for future in hm_futures:
                res = future.result()
                if res:
                    heatmap_times.append(res.pop("heatmap_time"))
                    heatmaps.append(res)

            # sum map 결과 수집
            if sum_future:
                sum_map_entries = sum_future.result()
                if sum_map_entries:
                    sum_map_rel_path = sum_map_entries[0]["path"]

    _mark("save_heatmaps_and_sum_maps", t)

    if create_sum and sum_map_entries:
        def _delayed_persist_square_cache():
            try:
                delay_ms = int(os.getenv("COMPOSITE_CACHE_PERSIST_DELAY_MS", "1500"))
            except ValueError:
                delay_ms = 1500
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)
            _persist_square_map_data(
                output_dir=output_dir,
                palette_list=palette_bytes,
                base_indices=base_indices,
                grade_counts=grade_counts,
                invalid_mask=invalid_mask,
                idx_8_mask=idx_8_13_only,
                image_count=composite_sample_count,
                color_scheme=scheme or ANONYMOUS_LOGIN_ID,
            )

        threading.Thread(target=_delayed_persist_square_cache, daemon=True).start()

    # 첫 번째 이미지의 positions.json을 composite 결과에 맞게 복사
    composite_image_filenames = []
    for heatmap in heatmaps:
        filename = heatmap["path"].split("/")[-1]
        composite_image_filenames.append(filename)
    for entry in sum_map_entries:
        filename = entry.get("filename") or entry["path"].split("/")[-1]
        composite_image_filenames.append(filename)

    if composite_image_filenames and positions_source_path:
        t = time.perf_counter()
        # 백그라운드 스레드로 positions 복사 (결과에 영향 없으므로 대기 불필요)
        threading.Thread(
            target=_copy_positions_without_bin,
            args=(positions_source_path, output_dir, composite_image_filenames),
            kwargs={
                "keep_chip_bin": show_normal_border,
                "selected_chip_coords": selected_coord_set,
                "selection_crop": selection_crop,
                "position_rect_overrides": position_rect_overrides,
                "position_canvas_size": position_canvas_size,
                "position_grid_edges": position_grid_edges,
            },
            daemon=True,
        ).start()
        _mark("copy_positions_async", t)

    total_time = time.perf_counter() - start_time
    timings["total"] = total_time

    # 시간별 분절 로그 출력
    print(f"\n[COMPOSITE] Timing breakdown (streaming):")
    if _HAS_NUMBA:
        print(f"  - numba_warmup:            {timings.get('numba_warmup', 0):.3f}s")
    print(f"  - prepare_output_dir:        {timings.get('prepare_output_dir', 0):.3f}s")
    print(f"  - load_and_accumulate:       {timings.get('load_and_accumulate', 0):.3f}s")
    print(f"  - positions_lookup:          {timings.get('positions_lookup', 0):.3f}s")
    print(f"  - mask_and_base:             {timings.get('mask_and_base_setup', 0):.3f}s")
    print(f"  - save_heatmaps+sum_maps:    {timings.get('save_heatmaps_and_sum_maps', 0):.3f}s")
    if heatmap_times:
        print(f"    heatmap times:             {[round(t, 3) for t in heatmap_times]}")
    print(f"  - total:                     {total_time:.3f}s ({processed_count} images, {composite_sample_count} aligned samples)\n")

    result = {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "heatmaps": heatmaps,
        "source_images": processed_count,
        "composite_sample_count": composite_sample_count,
        "source_image_paths": image_paths,
        "image_size": {"width": width, "height": height},
        "source_image_size": {"width": source_width, "height": source_height},
        "processing_time": round(total_time, 2),
        "generated_at": timestamp,
        "numba": _numba_runtime_info(
            accumulator=accumulator_mode,
            batch_size=effective_batch,
            warmup_time=timings.get("numba_warmup", 0.0),
            error=numba_warm_info.get("error") if isinstance(numba_warm_info, dict) else None,
        ),
        "timings": timings,
    }
    if selected_coord_set is not None:
        result["selected_chip_count"] = selected_chip_count_result or len(selected_coord_set)
        result["selection_crop"] = selection_crop
        result["selection_chip_inner_pixels"] = selection_chip_inner_pixels
        result["selection_grade_pixel_counts"] = selection_grade_pixel_counts
        result["selection_top_grades"] = selection_top_grades
    if shot_geometry:
        result["selected_shot_count"] = shot_geometry["shot_count"]
        result["selected_source_chip_count"] = shot_geometry["source_chip_count"]
        result["selected_missing_chip_count"] = shot_geometry["missing_chip_count"]
        result["selected_shot_shape"] = shot_geometry["shot_shape"]
    if shot_local_square_weighted:
        result["shot_local_square_weighted"] = True
    if sum_map_rel_path:
        result["sum_map_path"] = sum_map_rel_path
    if sum_map_entries:
        result["sum_maps"] = sum_map_entries
    return result
def create_palette_overlay(
    image_paths: List[str],
    focus_index: Optional[int] = 3,
    highlight_threshold: int = 8,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    지정된 팔레트 인덱스와 고인덱스만 빠르게 합성하는 경량 모드.
    - focus_index: 관심 팔레트 인덱스 (None이면 저인덱스 무시)
    - highlight_threshold: 이 값 이상인 인덱스는 원본 색으로 유지
    """
    start_time = time.time()
    if not image_paths:
        raise ValueError("image_paths is empty")

    output_dir, timestamp = _prepare_output_dir(login_id)

    first_path = IMAGES_ROOT / image_paths[0]
    first_img = Image.open(first_path)
    width, height = first_img.size
    source_palette = first_img.getpalette() if first_img.mode == 'P' else None
    first_img.close()

    # 최종 결과: 각 픽셀에서 최대 인덱스만 유지
    aggregated = np.zeros((height, width), dtype=np.uint8)
    pixel_loader = _iter_pixel_indices(
        image_paths,
        width,
        height,
        loader_mode or COMPOSITE_LOADER_MODE,
        max_workers or COMPOSITE_MAX_WORKERS
    )

    processed_count = 0
    for _, pixel_indices in pixel_loader:
        if pixel_indices is None:
            continue
        processed_count += 1
        
        # 필터링: 0~7 중 focus_index만 남기고 나머지는 0으로, 8 이상은 그대로
        filtered = np.zeros_like(pixel_indices)
        
        # 8 이상 인덱스는 그대로 유지
        high_mask = (pixel_indices >= highlight_threshold)
        filtered[high_mask] = pixel_indices[high_mask]
        
        # focus_index만 남김 (0~7 범위 내)
        if focus_index is not None and 0 <= focus_index < highlight_threshold:
            focus_mask = (pixel_indices == focus_index)
            filtered[focus_mask] = focus_index
        
        # 겹치면 max index로 (높은 인덱스 우선)
        aggregated = np.maximum(aggregated, filtered)

    overlay_img = Image.fromarray(aggregated, mode='P')
    if source_palette:
        overlay_img.putpalette(source_palette)
    overlay_path = output_dir / f"palette_focus_{focus_index if focus_index is not None else 'none'}{_image_ext()}"
    _save_image_with_backend(overlay_img.convert("RGB"), overlay_path)

    return {
        "mode": "palette",
        "output_dir": overlay_path.parent.relative_to(IMAGES_ROOT).as_posix(),
        "overlay_path": overlay_path.relative_to(IMAGES_ROOT).as_posix(),
        "focus_index": focus_index,
        "highlight_threshold": highlight_threshold,
        "source_images": processed_count,
        "processing_time": round(time.time() - start_time, 2),
        "generated_at": timestamp,
    }


def create_sum_map(
    image_paths: List[str],
    scheme: Optional[str] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    start_time = time.time()
    if not image_paths:
        raise ValueError("이미지 목록이 비어 있습니다.")

    output_dir, timestamp = _prepare_output_dir(login_id)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None

    palette_list = _build_palette_list(source_palette)
    # 🔥 개인색 미적용 — default palette로 저장, UI에서 PLTE 패치로 개인색 표시

    # 1단계: 모든 raw indices 수집
    raw_indices_list = []
    processed_count = 0

    for img_path in image_paths:
        full_path = IMAGES_ROOT / img_path
        if not full_path.exists():
            continue
        try:
            with Image.open(full_path) as img:
                if img.size != (width, height):
                    img = img.resize((width, height), Image.NEAREST)
                
                # 투명도 확인
                is_transparent = None
                if 'A' in img.getbands():
                    alpha = np.array(img.getchannel('A'))
                    is_transparent = (alpha == 0)

                if img.mode == 'P':
                    raw_indices = np.array(img, dtype=np.int16)
                else:
                    raw_indices = np.array(img.convert('L'), dtype=np.int16) // 32
                
                # 투명 영역 31 처리
                if is_transparent is not None:
                    raw_indices[is_transparent] = 31
                    
                raw_indices_list.append(raw_indices)
                processed_count += 1
        except Exception as exc:
            print(f"[SUM_MAP] image load failed: {img_path}, {exc}")
            continue

    if not raw_indices_list:
        raise ValueError("처리할 이미지가 없습니다.")

    # 2단계: 인덱스 8-13 처리 (특정 point가 8-13만 있는 경우만 8로 변경)
    stacked_raw = np.stack(raw_indices_list, axis=0)  # (N, H, W)
    idx_8_13_mask = (stacked_raw >= 8) & (stacked_raw <= 13)  # (N, H, W)
    idx_0_7_mask = (stacked_raw >= 0) & (stacked_raw <= 7)  # (N, H, W)
    idx_14_plus_mask = (stacked_raw >= 14)  # (N, H, W)
    
    # 🔥 invalid 칩(14 이상)을 0으로 변환하여 계산에 포함
    # 일부 이미지만 invalid여도 나머지 valid 이미지로 정상 계산
    stacked_raw[idx_14_plus_mask] = 0
    
    # 각 포인트에서 8-13이 있는지, 0-7이 있는지 확인 (14 이상은 이미 0으로 변환됨)
    has_8_13 = idx_8_13_mask.any(axis=0)  # (H, W)
    has_0_7 = idx_0_7_mask.any(axis=0) | idx_14_plus_mask.any(axis=0)  # (H, W) - invalid도 0으로 처리되어 포함
    
    # 🔥 모든 이미지가 invalid인 포인트만 invalid_mask로 마킹
    all_invalid = idx_14_plus_mask.all(axis=0)  # (H, W) - 모든 이미지가 14 이상
    
    # 8-13만 있고 0-7이나 invalid가 없는 포인트
    idx_8_13_only = has_8_13 & ~has_0_7  # (H, W)

    # 해당 픽셀을 모든 이미지에서 8로 변경
    stacked_raw[:, idx_8_13_only] = 8

    # 3단계: clipping (이미 14 이상은 0으로 변환됨)
    stacked_indices = np.clip(stacked_raw, 0, 13).astype(np.uint8)  # 0-13 범위
    _, height, width = stacked_indices.shape

    grade_counts = _compute_grade_counts(stacked_indices)

    valid_0_7_mask = (stacked_indices >= 0) & (stacked_indices <= 7)
    has_valid_0_7 = valid_0_7_mask.any(axis=0)
    has_8_13_after = ((stacked_indices >= 8) & (stacked_indices <= 13)).any(axis=0)
    only_0_7_mask = has_valid_0_7 & ~has_8_13_after  # invalid는 이미 0으로 변환되어 포함
    invalid_mask = all_invalid  # 🔥 모든 이미지가 invalid인 포인트만

    device_count = _count_unique_devices(image_paths)
    show_normal_border = device_count <= 1
    positions_source_path = _first_image_with_positions(image_paths)
    chip_area = (has_0_7 | idx_8_13_only) & ~invalid_mask

    base_indices = None
    if positions_source_path:
        base_indices = _build_chip_base_indices_from_positions(
            positions_source_path,
            width=width,
            height=height,
            show_normal_border=show_normal_border,
        )
    if base_indices is None:
        # positions.json 없을 때 fallback: chip 영역은 grade0, 나머지는 배경색
        base_indices = np.full((height, width), 8, dtype=np.uint8)
        base_indices[chip_area] = 0
    chip_inner_mask = (base_indices == 0)

    # 🔥 default 색상으로 생성 → display 시 개인색 적용 (썸네일 API PLTE 패치 + recolor)
    entries = _save_sum_map_variants(
        stacked_indices,
        output_dir,
        palette_list,
        invalid_mask=invalid_mask,
        base_indices=base_indices,
        idx_8_mask=idx_8_13_only,
        scheme="default",
        grade_counts=grade_counts,
        only_low_mask=chip_inner_mask,
        image_count=processed_count,
    )
    if not entries:
        raise RuntimeError("Sum Map 생성을 완료하지 못했습니다.")

    composite_image_filenames = []
    for entry in entries:
        filename = entry.get("filename") or entry["path"].split("/")[-1]
        composite_image_filenames.append(filename)

    if composite_image_filenames and positions_source_path:
        _copy_positions_without_bin(
            positions_source_path,
            output_dir,
            composite_image_filenames,
            keep_chip_bin=show_normal_border,
        )

    primary = entries[0]["path"]
    processing_time = time.time() - start_time
    return {
        "sum_map_path": primary,
        "sum_maps": entries,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2),
        "generated_at": timestamp,
    }
def create_subset_map(
    output_dir: Path,
    selected_grades: List[int],
    scheme: Optional[str] = None,
    override_colors: Optional[Sequence[str]] = None,
) -> List[Dict[str, str]]:
    """
    NPZ 파일에서 grade_counts를 로드하여 선택된 grade만으로 Subset Map 생성.

    Args:
        output_dir: Composite map이 저장된 디렉토리 (NPZ 파일 위치)
        selected_grades: 선택된 grade 리스트 (예: [3, 5])
        scheme: Color scheme (optional)
        override_colors: 색상 오버라이드 (optional)

    Returns:
        생성된 Subset Map 정보 리스트
    """
    if not selected_grades:
        raise ValueError("선택된 grade가 없습니다.")

    # 선택된 grade를 정렬하여 파일명 suffix 생성 (예: [3, 5] -> "_35")
    sorted_grades = sorted(selected_grades)
    suffix = "_" + "".join(str(g) for g in sorted_grades)

    # subset 결과도 현재 선택 1세트만 유지한다.
    _delete_existing_subset_outputs(output_dir)

    # NPZ 파일 로드
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    if not cache_path.exists():
        raise FileNotFoundError(f"Square map cache not found: {cache_path}")

    with np.load(cache_path) as data:
        base_indices = data["base_indices"].astype(np.uint8)
        palette_array = data["palette"].astype(np.uint8)
        grade_counts = data.get("grade_counts")
        invalid_mask = data.get("invalid_mask")
        idx_8_mask = data.get("idx_8_mask")
        only_low_mask = data.get("calc_mask")  # 0-7만 있는 포인트 마스크
        image_count_arr = data.get("source_image_count")
        source_image_count = int(image_count_arr.item()) if image_count_arr is not None else None
        color_scheme_arr = data.get("color_scheme")
        colors_arr = data.get("colors")

    if grade_counts is None:
        raise ValueError("grade_counts가 NPZ 파일에 없습니다.")

    grade_counts_arr = grade_counts.astype(np.uint16, copy=False)
    # Subset 계산 시 invalid/idx_8 포인트는 0으로 취급하고 마스크에서 제외
    invalid_mask_arr = None
    idx_8_mask_arr = None
    chip_inner_mask = (base_indices == 0)

    # Subset Map 계산 (chip 내부만 계산 대상으로 제한)
    square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
        grade_counts=grade_counts_arr,
        selected_grades=selected_grades,
        invalid_mask=invalid_mask_arr,
        idx_8_mask=idx_8_mask_arr,
        only_low_mask=chip_inner_mask,
        image_count=source_image_count,
        include_unselected_in_denominator=False,
    )

    # 색상 설정
    cached_scheme = None
    if color_scheme_arr is not None:
        try:
            cached_scheme = str(np.atleast_1d(color_scheme_arr).ravel()[0])
        except Exception:
            cached_scheme = None

    resolved_scheme = (scheme or cached_scheme or ANONYMOUS_LOGIN_ID).strip() or ANONYMOUS_LOGIN_ID
    settings = load_composite_color_settings(resolved_scheme)

    cached_colors: Optional[List[str]] = None
    if colors_arr is not None:
        try:
            cached_colors = [normalize_hex_color(str(c)) for c in colors_arr.tolist()]
        except Exception:
            cached_colors = None

    base_colors = cached_colors if cached_colors else settings.colors

    if override_colors:
        colors_to_use: List[str] = []
        for idx, base_color in enumerate(base_colors):
            candidate = override_colors[idx] if idx < len(override_colors) else None
            if candidate:
                try:
                    colors_to_use.append(normalize_hex_color(candidate))
                    continue
                except ValueError:
                    pass
            colors_to_use.append(base_color)
    else:
        colors_to_use = base_colors

    color_stops = np.array([_hex_to_rgb_tuple(c) for c in colors_to_use], dtype=np.float32)
    quantile_positions = None
    if settings.quantiles:
        quantile_positions = np.asarray(settings.quantiles, dtype=np.float32) * 100.0
    lut_positions = np.linspace(0.0, 100.0, 256, dtype=np.float32)
    shared_lut_colors = _interpolate_percentile_colors(lut_positions, color_stops, quantile_positions)
    palette_list = palette_array.reshape(-1).tolist()
    # 🔥 개인색 미적용 — default palette로 저장, UI에서 PLTE 패치로 개인색 표시

    # 🔥 Subset Map: Palette PNG로 저장
    grade_str = "".join(str(g) for g in sorted_grades)
    sum_palette = _build_sum_map_palette(palette_list, gradient_scheme="default")
    variants = [
        (f"square_average_{grade_str}.png", "square_mean", f"Composite SqMean [Grade {', '.join(map(str, sorted_grades))}]", square_mean_map, calc_mask),
        (f"square_weighted_average_{grade_str}.png", "weighted_square_mean", f"Composite Weighted SqMean [Grade {', '.join(map(str, sorted_grades))}]", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []

    def _render_and_save(args):
        filename, variant_type, display_name, data_map, mask = args
        sum_map_path = output_dir / filename
        for old_ext in (".jpg", ".webp"):
            old_file = sum_map_path.with_suffix(old_ext)
            if old_file.exists():
                old_file.unlink(missing_ok=True)
        value_min, value_max = _value_range_for_map(data_map, mask, clamp_min_to_zero=True)
        idx_arr = _render_sum_map_palette(
            base_indices=base_indices, value_map=data_map, mask=mask,
            value_min=value_min, value_max=value_max,
        )
        actual_path, rel_path = _save_palette_png(idx_arr, sum_palette, sum_map_path)
        return {
            "path": rel_path, "type": variant_type,
            "display_name": display_name, "filename": actual_path.name,
            "selected_grades": sorted_grades,
        }

    with ThreadPoolExecutor(max_workers=2) as pool:
        outputs = list(pool.map(_render_and_save, variants))

    # 🔥 기존 positions 파일을 subset 파일에도 복사
    # output_dir에 이미 생성된 Grade_0 positions 파일을 찾아서 subset 파일에도 복사
    output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
    positions_output_dir = POSITIONS_ROOT / output_dir_rel

    # Grade_0.json 파일을 찾아서 템플릿으로 사용
    grade_0_positions = positions_output_dir / "Grade_0.json"
    if grade_0_positions.exists():
        try:
            with open(grade_0_positions, 'r', encoding='utf-8') as f:
                positions_template = json.load(f)

            # subset 파일마다 positions 파일 생성
            for output in outputs:
                filename = output.get("filename")
                if not filename:
                    continue

                img_stem = Path(filename).stem
                positions_data_copy = positions_template.copy()

                # composite map 경로로 업데이트
                composite_rel_path = output_dir_rel / filename
                positions_data_copy['image_path'] = composite_rel_path.as_posix()
                positions_data_copy['wafer'] = img_stem
                if 'step' in positions_data_copy:
                    positions_data_copy['step'] = filename

                # positions 파일 저장
                positions_file_path = positions_output_dir / f"{img_stem}.json"
                _atomic_write_json(positions_file_path, positions_data_copy)
        except Exception:
            pass

    return outputs


def accumulate_pixel_counts(
    img_path: Path,
    counts: Dict[int, np.ndarray],
    indices: List[int],
    expected_size: Tuple[int, int]
):
    """
    단일 이미지의 픽셀값을 인덱스별 카운트에 누적

    Args:
        img_path: 이미지 파일 경로
        counts: 인덱스별 카운트 배열 딕셔너리
        indices: 처리할 인덱스 리스트
        expected_size: (width, height) 예상 크기
    """
    img = Image.open(img_path)

    # 크기가 다르면 리샘플링
    if img.size != expected_size:
        img = img.resize(expected_size, Image.NEAREST)

    # 🔥 팔레트 이미지 처리 (웨이퍼맵은 주로 P 모드)
    if img.mode == 'P':
        # 팔레트 모드: 픽셀값이 이미 0~7 (또는 0~255) 인덱스
        pixels = np.array(img)
        pixel_indices = pixels
    else:
        # RGB나 L 모드: 0~255를 0~7로 매핑
        pixels = np.array(img.convert('L'))
        # 0~31 → 0, 32~63 → 1, ..., 224~255 → 7
        pixel_indices = pixels // 32

    # 안전하게 0~7 범위로 클립
    pixel_indices = np.clip(pixel_indices, 0, 7)

    # 각 인덱스별 카운트 증가 (NumPy 벡터화)
    for idx in indices:
        mask = (pixel_indices == idx)

    img.close()


def generate_heatmap_image(
    count_array: np.ndarray,
    max_count: int,
    colormap: str = 'custom_white_red'
) -> Image.Image:
    """
    카운트 배열을 색상 히트맵으로 변환 (팔레트 방식)

    팔레트 방식 사용 이유:
    - 메모리 사용량: RGB 48MB → Palette 16MB (1/3 감소)
    - 처리 속도: RGB 48M ops → Palette 16M ops (3배 빠름)
    - PNG 파일 크기: RGB 20-30MB → Palette 5-10MB (1/3 감소)

    Args:
        count_array: [height, width] 카운트 배열
        max_count: 정규화 기준 (선택된 이미지 총 개수)
        colormap: 'custom_white_red' (흰색→빨강)

    Returns:
        PIL.Image: 팔레트 모드 히트맵 이미지
    """
    # 정규화 (0.0 ~ 1.0)
    if max_count > 0:
        normalized = count_array.astype(np.float32) / max_count
    else:
        normalized = count_array.astype(np.float32)

    normalized = np.clip(normalized, 0.0, 1.0)

    # 8비트 인덱스로 변환 (0~255)
    indexed = (normalized * 255).astype(np.uint8)

    # 그레이스케일 이미지 생성 (L 모드)
    img = Image.fromarray(indexed, mode='L')

    # 256색 팔레트 생성: 흰색(0) → 빨강(255)
    # count=0   → index=0   → RGB(255, 255, 255) 흰색
    # count=max → index=255 → RGB(255, 0, 0)     빨강
    palette = []
    for i in range(256):
        r = 255           # R 채널 고정
        g = 255 - i       # G 채널 감소
        b = 255 - i       # B 채널 감소
        palette.extend([r, g, b])

    # 팔레트 적용 (단 768바이트!)
    img.putpalette(palette)

    return img  # 팔레트 모드 이미지 반환
