"""
Composite Map 생성 모듈
여러 웨이퍼 맵의 인덱스별 빈도를 히트맵으로 시각화
"""
import os
import shutil
import time
import warnings
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from datetime import datetime
from functools import partial, lru_cache
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Sequence, Callable
import re
import numpy as np
from PIL import Image
from PIL.Image import DecompressionBombWarning

try:
    from numba import njit, prange

    _HAS_NUMBA = True
except Exception:
    njit = None
    prange = None
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
    from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_444

    _TURBOJPEG = TurboJPEG()
    _HAS_TURBOJPEG = True
except Exception:
    _TURBOJPEG = None

_SAVE_BACKEND = os.getenv("COMPOSITE_SAVE_BACKEND", "turbo" if _HAS_TURBOJPEG else "pil").lower()
_SAVE_FORMAT = os.getenv("COMPOSITE_FORMAT", "JPEG" if _HAS_TURBOJPEG else "PNG").upper()
_JPEG_QUALITY = int(os.getenv("COMPOSITE_JPEG_QUALITY", "95"))
_CACHE_COMPRESS = os.getenv("COMPOSITE_CACHE_COMPRESS", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
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
# composite_cache_v1은 선택적 사용 (환경변수로 제어)
# 같은 이미지를 여러 composite map에 재사용할 때만 유용
USE_COMPOSITE_IMAGE_CACHE = os.getenv("USE_COMPOSITE_IMAGE_CACHE", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
COMPOSITE_CACHE_ROOT = IMAGES_ROOT / "composite_cache_v1" if USE_COMPOSITE_IMAGE_CACHE else None
_GRADE_RANGE = np.arange(8, dtype=np.uint8)
_SUBSET_NAME_RE = re.compile(r"^square_(weighted_)?average_([0-7]+)\.(png|jpg|jpeg|webp)$", re.IGNORECASE)


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


def _load_source_positions_data(image_rel_path: str) -> Optional[Dict[str, Any]]:
    import json

    for candidate in _candidate_source_positions_paths(image_rel_path):
        if not candidate.exists():
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def _copy_positions_without_bin(
    first_image_rel_path: str,
    output_dir: Path,
    composite_images: List[str],
    keep_chip_bin: bool = False,
) -> None:
    """
    첫 번째 이미지의 positions.json을 찾아 composite 결과 이미지들에 대응하는
    positions 파일로 복사한다.

    keep_chip_bin=True면 chip의 'b' 필드를 유지(없으면 Normal로 보정)하고,
    False면 기존처럼 제거한다.
    """
    import json

    positions_data = _load_source_positions_data(first_image_rel_path)
    if not positions_data:
        return

    try:
        chips = positions_data.get("chips")
        if isinstance(chips, list):
            for chip in chips:
                if not isinstance(chip, dict):
                    continue
                if keep_chip_bin:
                    chip["b"] = "Normal"
                elif "b" in chip:
                    del chip["b"]

        output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
        positions_output_dir = POSITIONS_ROOT / output_dir_rel
        positions_output_dir.mkdir(parents=True, exist_ok=True)

        for img_filename in composite_images:
            img_stem = Path(img_filename).stem
            composite_rel_path = output_dir_rel / img_filename
            positions_data_copy = positions_data.copy()
            positions_data_copy["image_path"] = composite_rel_path.as_posix()
            positions_data_copy["wafer"] = img_stem
            if "step" in positions_data_copy:
                positions_data_copy["step"] = img_filename

            positions_file_path = positions_output_dir / f"{img_stem}.json"
            with open(positions_file_path, "w", encoding="utf-8") as f:
                json.dump(positions_data_copy, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


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

    # index 31 = composite map 배경색 (chip 바깥)
    # _scheme_to_palette_bytes는 인덱스 ~24까지만 반환하므로 31은 명시적으로 설정
    background_rgb = _resolve_scheme_background_rgb(scheme)
    palette_list[31 * 3:31 * 3 + 3] = list(background_rgb)
    return palette_list


def _build_chip_base_indices_from_positions(
    image_rel_path: str,
    width: int,
    height: int,
    show_normal_border: bool = True,
) -> Optional[np.ndarray]:
    """
    positions.json의 chip 좌표로 base_indices 배열 생성.
    chip 바깥은 전부 배경색(31)으로 채워 wafer 원형 더미 영역을 제거.

    Returns:
        (H, W) uint8 ndarray:
            - 31: chip 바깥 (배경색) — 원형 wafer 더미 포함
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

    base = np.full((height, width), 31, dtype=np.uint8)  # 전체 = 배경색

    for chip in chips:
        if not isinstance(chip, dict):
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
    positions_user_dir = POSITIONS_ROOT / "composite_map" / safe_login

    # 사용자별 composite 결과는 항상 1세트만 유지한다.
    try:
        if user_dir.exists():
            shutil.rmtree(user_dir)
    except Exception:
        pass
    try:
        if positions_user_dir.exists():
            shutil.rmtree(positions_user_dir)
    except Exception:
        pass

    output_dir = user_dir / COMPOSITE_SESSION_DIRNAME
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir, timestamp


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


def _cache_path_for_image(rel_path: str, width: int, height: int) -> Optional[Path]:
    """이미지 캐시 경로 반환 (캐시가 비활성화되어 있으면 None)"""
    if not USE_COMPOSITE_IMAGE_CACHE or COMPOSITE_CACHE_ROOT is None:
        return None
    sanitized = rel_path.strip("/\\")
    cache_rel = Path(sanitized).with_suffix(f".{width}x{height}.npy")
    cache_path = COMPOSITE_CACHE_ROOT / cache_rel
    # 캐시 경로를 반환하기 전에 부모 디렉토리만 생성 (필요할 때만)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    return cache_path


# 메모리 캐시 (LRU): 최근 512개 이미지를 메모리에 캐싱 (대용량 이미지 대응)
@lru_cache(maxsize=512)
def _cached_load_pixel_indices(image_rel_path: str, width: int, height: int, mtime: float) -> Optional[bytes]:
    """
    메모리 캐시 레이어 (LRU)
    - mtime을 키로 사용하여 파일 변경 시 자동으로 캐시 무효화
    - numpy 배열을 bytes로 저장 (picklable)
    """
    try:
        result = _load_pixel_indices(image_rel_path, width, height)
        if result is not None:
            # numpy 배열을 bytes로 직렬화
            return result.tobytes()
        return None
    except Exception as e:
        print(f"[MEMORY CACHE] Load failed: {image_rel_path}, {e}")
        return None


def _load_pixel_indices_with_cache(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """
    3단계 캐싱 전략:
    1. 메모리 캐시 (LRU) - 가장 빠름
    2. 디스크 캐시 (NPY 파일)
    3. 원본 이미지 로드
    """
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None

    try:
        # 파일 mtime 확인
        mtime = full_path.stat().st_mtime

        # 메모리 캐시 체크
        cached_bytes = _cached_load_pixel_indices(image_rel_path, width, height, mtime)
        if cached_bytes is not None:
            # bytes를 numpy 배열로 역직렬화
            return np.frombuffer(cached_bytes, dtype=np.uint8).reshape(height, width)

        return None
    except Exception as e:
        print(f"[CACHE] Error loading {image_rel_path}: {e}")
        return None


def _count_low_grade_occurrences(
    stacked_indices: np.ndarray,
    chunk_size: Optional[int] = None,
) -> np.ndarray:
    """
    (N, H, W) 인덱스 배열에서 grade 0~7의 등장 횟수를 계산.
    4차원 브로드캐스트 대신 np.add.at 기반 누적로직을 사용하여
    메모리 사용량을 8배 이상 줄이고 CPU 캐시 효율을 높인다.
    """
    if stacked_indices.ndim != 3:
        raise ValueError("stacked_indices must be a 3D array (N, H, W)")

    total_images, height, width = stacked_indices.shape
    if total_images == 0 or height == 0 or width == 0:
        return np.zeros((8, height, width), dtype=np.uint16)

    inferred_chunk = chunk_size or COMPOSITE_BATCH_SIZE or 8
    chunk = max(1, min(total_images, max(4, min(64, inferred_chunk))))

    flat_pixels = height * width
    counts = np.zeros((8, flat_pixels), dtype=np.uint32)
    base_pixels = np.arange(flat_pixels, dtype=np.int64)
    pixel_cache: Dict[int, np.ndarray] = {}

    for start in range(0, total_images, chunk):
        chunk_arr = stacked_indices[start:start + chunk]
        current_len = chunk_arr.shape[0]
        flat_chunk = chunk_arr.reshape(-1)
        valid_mask = flat_chunk < 8
        if not valid_mask.any():
            continue
        if current_len not in pixel_cache:
            pixel_cache[current_len] = np.tile(base_pixels, current_len)
        pixel_ids = pixel_cache[current_len][valid_mask]
        grade_ids = flat_chunk[valid_mask].astype(np.int64, copy=False)
        np.add.at(counts, (grade_ids, pixel_ids), 1)

    clipped = np.clip(counts, 0, np.iinfo(np.uint16).max).astype(np.uint16, copy=False)
    return clipped.reshape(8, height, width)


if _HAS_NUMBA:
    @njit(parallel=True, fastmath=False, cache=True)
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
else:
    _numba_count_grades_impl = None


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


def _resolve_scheme_background_rgb(scheme: Optional[str]) -> Tuple[int, int, int]:
    """현재 개인 색 설정의 background를 Composite 배경색으로 사용한다."""
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
        return (255, 255, 255)

    raw_background = scheme_data.get("background")
    try:
        normalized = normalize_hex_color(str(raw_background or "#FFFFFF"))
    except Exception:
        normalized = "#FFFFFF"
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


def _load_pixel_indices(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """
    캐싱 개선:
    1. 캐시 히트 시 즉시 반환 (파일 I/O 최소화)
    2. 캐시 미스 시에만 이미지 로드
    3. 원자적 캐시 저장 (임시 파일 사용)
    """
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None

    cache_path: Optional[Path] = None
    try:
        cache_path = _cache_path_for_image(image_rel_path, width, height)
        # 캐시 체크 (파일 mtime 비교)
        if cache_path and cache_path.exists():
            try:
                cache_mtime = cache_path.stat().st_mtime
                file_mtime = full_path.stat().st_mtime
                if cache_mtime >= file_mtime:
                    # 캐시가 최신 - 바로 반환
                    return np.load(cache_path)
            except Exception:
                # 캐시 읽기 실패 - 재생성
                pass
    except Exception as exc:
        print(f"[COMPOSITE CACHE] load skipped ({image_rel_path}): {exc}")
        cache_path = None

    # 캐시 미스 - 이미지 로드 및 캐싱
    try:
        with Image.open(full_path) as img:
            # 🔥 lazy loading 방지: 명시적으로 load() 호출
            img.load()
            
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)

            # 투명도(Alpha) 확인을 위한 마스크 생성
            is_transparent = None
            if 'A' in img.getbands():
                alpha = np.array(img.getchannel('A'))
                is_transparent = (alpha == 0)
            elif 'transparency' in img.info:
                # GIF/PNG 투명색 처리
                transparency = img.info['transparency']
                if isinstance(transparency, bytes):
                     # 단순 처리를 위해 생략하거나, 필요한 경우 구현
                     pass
                else:
                    # 팔레트 인덱스 투명
                    temp_arr = np.array(img)
                    is_transparent = (temp_arr == transparency)

            if img.mode == 'P':
                # 🔥 팔레트 모드: 직접 numpy 배열로 변환 (가장 빠름)
                pixel_indices = np.array(img, dtype=np.uint8)
            else:
                img_l = img.convert('L')
                pixels = np.array(img_l, dtype=np.uint8)
                pixel_indices = pixels // 32

            # 투명한 영역은 31(Empty)로 강제 변환
            if is_transparent is not None:
                pixel_indices[is_transparent] = 31

            # 캐시 저장 (원자적 저장)
            if cache_path is not None:
                try:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    tmp_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
                    # np.save appends .npy when given a path string; use a handle to keep .tmp suffix
                    with open(tmp_path, "wb") as f:
                        np.save(f, pixel_indices, allow_pickle=False)
                    # 원자적 이동 (Windows에서도 작동)
                    try:
                        tmp_path.replace(cache_path)
                    except Exception:
                        # Windows에서 replace 실패 시 강제 삭제 후 재시도
                        if cache_path.exists():
                            cache_path.unlink()
                        tmp_path.rename(cache_path)
                except Exception as exc:
                    print(f"[COMPOSITE CACHE] save failed ({cache_path}): {exc}")
            return pixel_indices
    except Exception as exc:
        print(f"[FAST] Composite image load failed: {image_rel_path}, {exc}")
        return None


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
    - 메모리 캐시 (LRU) 사용으로 속도 향상
    - progress_callback: 진행률 콜백 (current, total)
    """
    if not image_paths:
        return []
    normalized_mode = (loader_mode or "thread").lower()
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    worker_count = min(max(1, max_workers), len(image_paths))
    # 🔥 fast 모드에서는 워커 수를 조금 더 공격적으로 사용 (이미 상단에서 기본값 상향)
    loader = partial(_load_pixel_indices_with_cache, width=width, height=height)

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
) -> Image.Image:
    rgb_palette = np.array(palette_list, dtype=np.uint8).reshape(256, 3)

    # 1. [Base Layer] 먼저 base_indices 색상(8번, 31번 등)으로 전체를 칠함
    # Fancy indexing already creates a copy, no need for .copy()
    rgb_array = rgb_palette[base_indices]

    # Early exit if no calculation needed
    if mask.any() and len(color_stops) >= 1:
        calc_values = value_map[mask].astype(np.float32, copy=False)

        if calc_values.size > 0:
            if lut_colors is None:
                quantile_positions = None
                if quantiles:
                    quantile_positions = np.asarray(quantiles, dtype=np.float32) * 100.0
                # 0~100 범위를 256 스텝으로 미리 보간하여 LUT 생성 (대용량 배열 반복 보간 최소화)
                lut_positions = np.linspace(0.0, 100.0, 256, dtype=np.float32)
                lut_colors_local = _interpolate_percentile_colors(lut_positions, color_stops, quantile_positions)
            else:
                lut_colors_local = lut_colors

            finite_values = calc_values[np.isfinite(calc_values)]
            if finite_values.size > 0:
                resolved_min = float(value_min if value_min is not None else finite_values.min())
                resolved_max = float(value_max if value_max is not None else finite_values.max())

                if force_full_range:
                    denom = resolved_max - resolved_min
                    if denom <= 0:
                        # 단일 값인 경우 0 또는 양수 여부에 따라 맵핑 결정
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

                # 2. [Composite Layer] 계산 대상(0-7만 있는 곳)만 Composite 색상으로 덮어씀
                # rgb_array is already a copy from fancy indexing, no need to copy again
                rgb_array[mask] = lut_colors_local[lut_idx]

    # rgb_array is already uint8, no need for astype
    return Image.fromarray(rgb_array, mode='RGB')


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


def _save_image_with_backend(img: Image.Image, path: Path) -> Tuple[Path, str]:
    """
    Save image with selectable backend/format.
    - COMPOSITE_SAVE_BACKEND: pil (default) | vips (if pyvips available)
    - COMPOSITE_FORMAT: PNG (default) | WEBP | JPEG
    Returns: (actual_path, rel_path)
    """
    backend, fmt = _resolve_save_backend()

    target_path = path
    if fmt == "WEBP":
        target_path = path.with_suffix(".webp")
    elif fmt == "JPEG":
        target_path = path.with_suffix(".jpg")

    # JPEG는 팔레트/투명도를 허용하지 않으므로 RGB로 변환
    save_img = img
    if fmt == "JPEG" and img.mode != "RGB":
        save_img = img.convert("RGB")
    elif fmt != "JPEG":
        save_img = img

    if backend == "vips" and _HAS_PYVIPS:
        arr = np.array(save_img, dtype=np.uint8)
        if arr.ndim == 2:
            # convert L to RGB for consistency
            arr = np.stack([arr, arr, arr], axis=2)
        h, w, c = arr.shape
        vips_img = _vips.Image.new_from_memory(arr.tobytes(), w, h, c, format="uchar")
        if fmt == "WEBP":
            vips_img.write_to_file(str(target_path), Q=100, lossless=1)
        elif fmt == "JPEG":
            vips_img.write_to_file(str(target_path), Q=_JPEG_QUALITY, strip=True, optimize_coding=True)
        else:
            vips_img.write_to_file(str(target_path), compression=0)
    elif backend == "turbo" and _HAS_TURBOJPEG and fmt == "JPEG":
        arr = np.array(save_img, dtype=np.uint8)
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=2)
        encoded = _TURBOJPEG.encode(arr, quality=_JPEG_QUALITY, jpeg_subsample=TJSAMP_444, pixel_format=TJPF_RGB)
        # Windows에서 기존 파일을 직접 truncate(write_bytes)할 때
        # 간헐적으로 OSError(Errno 22)가 발생할 수 있어 atomic replace를 사용한다.
        tmp_path = target_path.with_suffix(f"{target_path.suffix}.tmp")
        tmp_path.write_bytes(encoded)
        os.replace(tmp_path, target_path)
    else:
        if fmt == "WEBP":
            save_img.save(target_path, format="WEBP", quality=100, lossless=True, method=6)
        elif fmt == "JPEG":
            save_img.save(target_path, format="JPEG", quality=_JPEG_QUALITY, subsampling=0, optimize=True)
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
    square_mean_map: np.ndarray,
    weighted_map: np.ndarray,
    calc_mask: np.ndarray,
    weighted_mask: np.ndarray,
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
        "square_mean": square_mean_map.astype(square_mean_map.dtype, copy=False),
        "square_weighted": weighted_map.astype(weighted_map.dtype, copy=False),
        "calc_mask": calc_mask.astype(bool, copy=False),
        "weighted_mask": weighted_mask.astype(bool, copy=False),
        "base_indices": base_indices.astype(np.uint8, copy=False),
        "palette": palette_array,
    }
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
        try:
            np.savez(cache_path, **save_payload)
        except Exception:
            pass
    threading.Thread(target=_save_npz, daemon=True).start()


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
        cached_square_mean = data["square_mean"]
        cached_weighted = data["square_weighted"]
        calc_mask = data["calc_mask"].astype(bool)
        weighted_mask = data["weighted_mask"].astype(bool)
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
            square_mean_map = cached_square_mean
            weighted_map = cached_weighted
    else:
        square_mean_map = cached_square_mean
        weighted_map = cached_weighted
    palette_list = palette_array.reshape(-1).tolist()
    resolved_scheme = (scheme or cached_scheme or ANONYMOUS_LOGIN_ID).strip() or ANONYMOUS_LOGIN_ID
    settings = load_composite_color_settings(resolved_scheme)
    palette_list = _apply_personal_palette(palette_list, resolved_scheme)
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

    ext = _image_ext()
    variants = [
        (f"square_average{ext}", "square_mean", "Composite SqMean", square_mean_map, calc_mask),
        (f"square_weighted_average{ext}", "weighted_square_mean", "Composite Weighted SqMean", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    subset_outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename

        # min=0, max=실제최대값 계산
        values = data_map[mask]
        if values.size > 0:
            finite = values[np.isfinite(values)]
            if finite.size > 0:
                v_min = 0.0  # 🔥 항상 0을 min으로 사용
                v_max = float(finite.max())
            else:
                v_min, v_max = None, None
        else:
            v_min, v_max = None, None

        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=data_map,
            mask=mask,
            palette_list=palette_list,
            quantiles=settings.quantiles,
            color_stops=color_stops,
            lut_colors=shared_lut_colors,
            value_min=v_min,
            value_max=v_max,
            force_full_range=True,  # 🔥 0~max 전체 범위 사용
        )
        actual_path, rel_path = _save_image_with_backend(img, sum_map_path)
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": actual_path.name,
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
                img = _render_sum_map_image(
                    base_indices=base_indices,
                    value_map=render_map,
                    mask=sub_calc_mask,
                    palette_list=palette_list,
                    quantiles=settings.quantiles,
                    color_stops=color_stops,
                    lut_colors=shared_lut_colors,
                    value_min=vmin,
                    value_max=vmax,
                    force_full_range=True,
                )
                actual_path, rel_path = _save_image_with_backend(img, target)
                outputs.append({
                    "path": rel_path,
                    "type": "square_mean",
                    "display_name": f"Composite SqMean [Grade {grade_label}]",
                    "filename": actual_path.name,
                    "selected_grades": list(grade_tuple),
                })
                subset_outputs.append({
                    "path": rel_path,
                    "type": "square_mean",
                    "display_name": f"Composite SqMean [Grade {grade_label}]",
                    "filename": actual_path.name,
                    "selected_grades": list(grade_tuple),
                })

            if "weighted" in name_map:
                target = output_dir / name_map["weighted"]
                render_map = sub_weighted
                vmin, vmax = _value_range_for_map(render_map, sub_weighted_mask, clamp_min_to_zero=True)
                img = _render_sum_map_image(
                    base_indices=base_indices,
                    value_map=render_map,
                    mask=sub_weighted_mask,
                    palette_list=palette_list,
                    quantiles=settings.quantiles,
                    color_stops=color_stops,
                    lut_colors=shared_lut_colors,
                    value_min=vmin,
                    value_max=vmax,
                    force_full_range=True,
                )
                actual_path, rel_path = _save_image_with_backend(img, target)
                outputs.append({
                    "path": rel_path,
                    "type": "weighted_square_mean",
                    "display_name": f"Composite Weighted SqMean [Grade {grade_label}]",
                    "filename": actual_path.name,
                    "selected_grades": list(grade_tuple),
                })
                subset_outputs.append({
                    "path": rel_path,
                    "type": "weighted_square_mean",
                    "display_name": f"Composite Weighted SqMean [Grade {grade_label}]",
                    "filename": actual_path.name,
                    "selected_grades": list(grade_tuple),
                })

    return outputs + subset_outputs



def _save_sum_map_variants(
    all_indices: np.ndarray,
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
) -> List[Dict[str, str]]:
    trace = _trace_enabled()
    if all_indices.ndim != 3:
        raise ValueError("all_indices must be (N, H, W)")
    if all_indices.shape[0] == 0:
        return []

    # all_indices는 (N, H, W) 형태이므로 height와 width 추출
    _, height, width = all_indices.shape

    image_count = all_indices.shape[0]
    if image_count == 0:
        return []
    sum_float16 = _use_sum_float16()
    float_dtype = np.float16 if sum_float16 else np.float32

    if grade_counts is None:
        grade_counts = _compute_grade_counts(all_indices)
    grade_counts_float = grade_counts.astype(np.float32, copy=False)

    # 제곱합 계산: 각 인덱스 값을 제곱한 후 카운트와 곱함
    square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
    square_sums = np.sum(grade_counts_float * square_weights, axis=0, dtype=np.float32)

    # calc_mask: 인덱스 0-7만 있는 포인트
    if only_low_mask is not None:
        calc_mask = only_low_mask.astype(bool, copy=False).copy()
    else:
        calc_mask = grade_counts_float.sum(axis=0) > 0
        if idx_8_mask is not None:
            calc_mask &= ~idx_8_mask
        if invalid_mask is not None:
            calc_mask &= ~invalid_mask

    # square_average: 제곱합 / 이미지 개수
    square_mean_map = np.zeros_like(square_sums, dtype=float_dtype)
    with np.errstate(divide='ignore', invalid='ignore'):
        square_mean_map[calc_mask] = (square_sums[calc_mask] / float(image_count)).astype(float_dtype, copy=False)

    # square_weighted_average: 제곱합 / (0개수*1 + 1개수*1 + 2개수*2 + ... + 7개수*7)
    weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32).reshape(8, 1, 1)
    weight_map = np.sum(grade_counts_float * weight_factors, axis=0, dtype=np.float32)
    weighted_mask = calc_mask & (weight_map > 0)

    weighted_map = np.zeros_like(square_sums, dtype=float_dtype)
    with np.errstate(divide='ignore', invalid='ignore'):
        weighted_map[weighted_mask] = (square_sums[weighted_mask] / weight_map[weighted_mask]).astype(float_dtype, copy=False)


    if base_indices is None:
        if _FAST_MEDIAN:
            # Use mean instead of median for better performance (O(n) vs O(n log n)).
            # Avoid materializing a full float32 copy of all_indices (N*H*W) to keep memory bounded.
            mean_map = np.mean(all_indices, axis=0, dtype=np.float32)
            base_indices = np.clip(np.rint(mean_map), 0, 13).astype(np.uint8)  # 0-13 범위
        else:
            median_map = np.median(all_indices, axis=0)
            base_indices = np.clip(np.rint(median_map), 0, 13).astype(np.uint8)  # 0-13 범위
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

    if persist_cache:
        _persist_square_map_data(
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

    display_suffix = f" [{name_suffix.lstrip('_')}]" if name_suffix else ""
    ext = _image_ext()
    variants = [
        (f"square_average{name_suffix}{ext}", "square_mean", f"Composite SqMean{display_suffix}", square_mean_map, calc_mask),
        (f"square_weighted_average{name_suffix}{ext}", "weighted_square_mean", f"Composite Weighted SqMean{display_suffix}", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    save_futures: List[Tuple] = []

    render_workers = _RENDER_WORKERS
    save_workers = _SAVE_WORKERS

    def _render_task(data_map, mask_arr):
        t0 = time.perf_counter()
        lut_idx_time = 0.0
        interp_time = 0.0
        mask_points = int(mask_arr.sum())

        # min=0, max=실제최대값 계산
        values = data_map[mask_arr]
        if values.size > 0:
            finite = values[np.isfinite(values)]
            if finite.size > 0:
                v_min = 0.0  # 🔥 항상 0을 min으로 사용
                v_max = float(finite.max())
            else:
                v_min, v_max = None, None
        else:
            v_min, v_max = None, None

        def _render_inner():
            nonlocal lut_idx_time, interp_time
            t_interp_start = time.perf_counter()
            img = _render_sum_map_image(
                base_indices=base_indices,
                value_map=data_map,
                mask=mask_arr,
                palette_list=palette,
                quantiles=settings.quantiles,
                color_stops=color_stops,
                lut_colors=shared_lut_colors,
                value_min=v_min,
                value_max=v_max,
                force_full_range=True,  # 🔥 0~max 전체 범위 사용
            )
            interp_time = time.perf_counter() - t_interp_start
            return img

        img = _render_inner()
        total_render = time.perf_counter() - t0
        return img, {
            "mask_points": mask_points,
            "render_time": total_render,
            "interp_time": interp_time,
        }

    def _save_future(render_future, target_path: Path):
        img, render_stats = render_future.result()
        t_save = time.perf_counter()
        actual_path, rel_path = _save_image_with_backend(img, target_path)
        save_time = time.perf_counter() - t_save
        return actual_path, rel_path, render_stats, save_time

    with ThreadPoolExecutor(max_workers=render_workers) as render_pool, ThreadPoolExecutor(max_workers=save_workers) as save_pool:
        for filename, variant_type, display_name, data_map, mask in variants:
            sum_map_path = output_dir / filename
            render_future = render_pool.submit(_render_task, data_map, mask)
            save_future = save_pool.submit(_save_future, render_future, sum_map_path)
            save_futures.append((save_future, filename, variant_type, display_name))

        total_render_time = 0.0
        total_save_time = 0.0
        for future, filename, variant_type, display_name in save_futures:
            actual_path, rel_path, render_stats, save_time = future.result()
            total_render_time += render_stats['render_time']
            total_save_time += save_time
            outputs.append({
                "path": rel_path,
                "type": variant_type,
                "display_name": display_name,
                "filename": actual_path.name,
            })
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


def create_composite_heatmaps(
    image_paths: List[str],
    indices: List[int] = None,
    create_sum: bool = True,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    batch_size: Optional[int] = None,
    scheme: Optional[str] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    start_time = time.perf_counter()
    trace = _trace_enabled()
    timings: Dict[str, float] = {}

    def _mark(label: str, started: float):
        timings[label] = time.perf_counter() - started
    if not image_paths:
        raise ValueError("image_paths is empty")

    t = time.perf_counter()
    output_dir, timestamp = _prepare_output_dir(login_id)
    _mark("prepare_output_dir", t)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None

    loader_mode = loader_mode or COMPOSITE_LOADER_MODE
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    batch_size = batch_size or COMPOSITE_BATCH_SIZE

    palette_list = _build_palette_list(source_palette)
    palette_list = _apply_personal_palette(palette_list, scheme)

    if indices is None:
        indices = list(range(8))

    # 1단계: 모든 raw indices 수집
    raw_indices_list: List[np.ndarray] = []
    processed_count = 0

    t = time.perf_counter()
    for batch_paths in _batched_paths(image_paths, batch_size):
        for rel_path, raw_indices in _iter_pixel_indices(
            batch_paths,
            width=width,
            height=height,
            loader_mode=loader_mode,
            max_workers=max_workers,
        ):
            if raw_indices is None:
                continue
            raw_indices_list.append(raw_indices.astype(np.uint8, copy=False))
            processed_count += 1
    load_time = time.perf_counter() - t
    _mark("load_indices", t)

    if not raw_indices_list:
        raise ValueError("처리할 이미지가 없습니다.")

    # 2단계: 인덱스 8-13 처리 (특정 point가 8-13만 있는 경우만 8로 변경)
    t = time.perf_counter()
    stacked_raw = np.stack(raw_indices_list, axis=0)  # (N, H, W)
    raw_indices_list.clear()
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
    stacked_indices = np.clip(stacked_raw, 0, 13, out=stacked_raw)  # 0-13 범위
    stacked_indices = np.ascontiguousarray(stacked_indices, dtype=np.uint8)
    _, height, width = stacked_indices.shape
    mask_time = time.perf_counter() - t

    t = time.perf_counter()
    grade_counts = _compute_grade_counts(stacked_indices)
    grade_time = time.perf_counter() - t
    _mark("grade_counts", t)

    device_count = _count_unique_devices(image_paths)
    show_normal_border = device_count <= 1
    positions_source_path = _first_image_with_positions(image_paths)

    # (idx_8_13_only를 제외한 포인트 중 0-7이 있는 것)
    t = time.perf_counter()
    only_0_7_mask = has_0_7 & ~has_8_13  # (H, W) - invalid는 이미 0으로 변환되어 포함
    invalid_mask = all_invalid  # 🔥 모든 이미지가 invalid인 포인트만
    invalid_mask_bool = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    chip_area = has_0_7 | idx_8_13_only
    if invalid_mask_bool is not None:
        chip_area &= ~invalid_mask_bool

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
        base_indices = np.full((height, width), 31, dtype=np.uint8)
        base_indices[chip_area] = 0
    chip_inner_mask = (base_indices == 0)
    _mark("mask_and_base_setup", t)

    heatmaps: List[Dict[str, Any]] = []
    palette_bytes = palette_list[:]
    grade_presence = grade_counts > 0
    invalid_mask_bool = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None

    t = time.perf_counter()
    heatmap_times = []
    for idx in indices:
        if idx >= 8:
            continue
        t_hm = time.perf_counter()
        result = base_indices.copy()
        presence_mask = grade_presence[idx].copy()
        if invalid_mask_bool is not None:
            presence_mask &= ~invalid_mask_bool
        presence_mask &= chip_inner_mask
        result[presence_mask] = idx  # 해당 grade 포인트 = grade 색
        heatmap_path = output_dir / f"Grade_{idx}{_image_ext()}"
        heatmap_img = Image.fromarray(result, mode='P')
        heatmap_img.putpalette(palette_bytes)
        actual_path, rel_path = _save_image_with_backend(heatmap_img, heatmap_path)
        total_pixels = width * height
        pixel_count = int(np.count_nonzero(presence_mask))
        percentage = round(pixel_count / total_pixels * 100, 2) if total_pixels else 0
        heatmap_time = time.perf_counter() - t_hm
        heatmap_times.append(heatmap_time)
        heatmaps.append({
            "index": idx,
            "path": rel_path,
            "pixel_count": pixel_count,
            "max_count": processed_count,
            "percentage": percentage,
        })
    total_heatmap_time = time.perf_counter() - t
    _mark("save_heatmaps", t)

    sum_map_entries: List[Dict[str, str]] = []
    sum_map_rel_path = None
    if create_sum:
        t = time.perf_counter()
        sum_map_entries = _save_sum_map_variants(
            stacked_indices,
            output_dir,
            palette_bytes,
            invalid_mask=invalid_mask,
            base_indices=base_indices,
            idx_8_mask=idx_8_13_only,
            scheme=scheme,
            grade_counts=grade_counts,
            only_low_mask=chip_inner_mask,
        )
        sum_map_time = time.perf_counter() - t
        _mark("save_sum_maps", t)
        if sum_map_entries:
            sum_map_rel_path = sum_map_entries[0]["path"]

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
        _copy_positions_without_bin(
            positions_source_path,
            output_dir,
            composite_image_filenames,
            keep_chip_bin=show_normal_border,
        )
        _mark("copy_positions_async", t)

    total_time = time.perf_counter() - start_time
    timings["total"] = total_time

    # 시간별 분절 로그 출력
    print(f"\n[COMPOSITE] Timing breakdown:")
    print(f"  - prepare_output_dir: {timings.get('prepare_output_dir', 0):.3f}s")
    print(f"  - load_indices:       {timings.get('load_indices', 0):.3f}s")
    print(f"  - grade_counts:       {timings.get('grade_counts', 0):.3f}s")
    print(f"  - mask_and_base:      {timings.get('mask_and_base_setup', 0):.3f}s")
    print(f"  - save_heatmaps:      {timings.get('save_heatmaps', 0):.3f}s")
    if create_sum:
        print(f"  - save_sum_maps:      {timings.get('save_sum_maps', 0):.3f}s")
    print(f"  - total:              {total_time:.3f}s\n")

    result = {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "heatmaps": heatmaps,
        "source_images": processed_count,
        "source_image_paths": image_paths,
        "image_size": {"width": width, "height": height},
        "processing_time": round(total_time, 2),
        "generated_at": timestamp,
        "timings": timings,
    }
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
    palette_list = _apply_personal_palette(palette_list, scheme)

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
        base_indices = np.full((height, width), 31, dtype=np.uint8)
        base_indices[chip_area] = 0
    chip_inner_mask = (base_indices == 0)

    entries = _save_sum_map_variants(
        stacked_indices,
        output_dir,
        palette_list,
        invalid_mask=invalid_mask,
        base_indices=base_indices,
        idx_8_mask=idx_8_13_only,
        scheme=scheme,
        grade_counts=grade_counts,
        only_low_mask=chip_inner_mask,
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
    palette_list = _apply_personal_palette(palette_list, resolved_scheme)

    # Subset Map 이미지 생성 (독립적인 min→0%, max→100% 매핑)
    grade_str = "".join(str(g) for g in sorted_grades)
    ext = _image_ext()
    variants = [
        (f"square_average_{grade_str}{ext}", "square_mean", f"Composite SqMean [Grade {', '.join(map(str, sorted_grades))}]", square_mean_map, calc_mask),
        (f"square_weighted_average_{grade_str}{ext}", "weighted_square_mean", f"Composite Weighted SqMean [Grade {', '.join(map(str, sorted_grades))}]", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        # Subset의 실제 min/max를 계산하여 0%~100% 전체 범위로 매핑
        render_map = data_map

        value_min, value_max = _value_range_for_map(render_map, mask, clamp_min_to_zero=True)

        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=render_map,
            mask=mask,
            palette_list=palette_list,
            quantiles=settings.quantiles,
            color_stops=color_stops,
            lut_colors=shared_lut_colors,
            value_min=value_min,
            value_max=value_max,
            force_full_range=True,
        )
        actual_path, rel_path = _save_image_with_backend(img, sum_map_path)
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": actual_path.name,
            "selected_grades": sorted_grades,
        })

    # 🔥 기존 positions 파일을 subset 파일에도 복사
    # output_dir에 이미 생성된 Grade_0 positions 파일을 찾아서 subset 파일에도 복사
    output_dir_rel = output_dir.relative_to(IMAGES_ROOT)
    positions_output_dir = POSITIONS_ROOT / output_dir_rel

    # Grade_0.json 파일을 찾아서 템플릿으로 사용
    grade_0_positions = positions_output_dir / "Grade_0.json"
    if grade_0_positions.exists():
        try:
            import json
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
                with open(positions_file_path, 'w', encoding='utf-8') as f:
                    json.dump(positions_data_copy, f, ensure_ascii=False, indent=2)
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
