"""
Measure Composite Map 생성 모듈 (v2 — rebuilt from scratch)

BIN/FBT/QVL chip-level 값을 집계하여 gradient heatmap 생성.
핵심: BIN은 전처리(1/0 변환) 1번 더한 것일 뿐, FBT/QVL과 동일 파이프라인.
"""

import json
import os
import threading
import time
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
from PIL import Image

from .config import IMAGES_ROOT, POSITIONS_ROOT
from .composite_map import (
    _load_source_positions_data,
    _first_image_with_positions,
    _save_image_with_backend,
    _copy_positions_without_bin,
    COMPOSITE_ROOT,
    ANONYMOUS_LOGIN_ID,
    _sanitize_login_id,
)
from .personal_colors import get_ratio_gradient_for_scheme, load_color_legends, DEFAULT_BOTTOM_COLORS

MEASURE_CACHE_FILENAME = "measure_composite_data.npz"


def _get_normal_border_rgb(scheme: Optional[str] = None) -> Tuple[int, int, int]:
    """사용자 scheme의 Normal 색상을 RGB 튜플로 반환."""
    hex_color = DEFAULT_BOTTOM_COLORS.get("Normal", "#BEBEBE")
    try:
        legends = load_color_legends()
        user = legends.get(scheme or ANONYMOUS_LOGIN_ID, {})
        bottom = user.get("bottom", {})
        if "Normal" in bottom:
            hex_color = bottom["Normal"]
    except Exception:
        pass
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
_MAX_WORKERS = int(os.getenv("MEASURE_COMPOSITE_WORKERS", "8"))

# 미리 워밍업된 ProcessPool (JSON 병렬 파싱용, 서버 시작 시 1회 생성)
from concurrent.futures import ProcessPoolExecutor as _ProcPool
_MEASURE_PROC_POOL: _ProcPool = None
try:
    _PROC_WORKERS = min(os.cpu_count() or 8, 16)
    _MEASURE_PROC_POOL = _ProcPool(max_workers=_PROC_WORKERS)
    # 모든 워커 워밍업 (1개만 깨우면 첫 호출 시 나머지 스폰으로 느림)
    from api._parallel_json import extract_chip_values as _warmup_fn
    list(_MEASURE_PROC_POOL.map(_warmup_fn, [("__dummy__", "f", "0", None)] * _PROC_WORKERS))
except Exception:
    _MEASURE_PROC_POOL = None

# ── 숫자 추출 (문자 혼합값 "0C", "123R" 등 지원) ────────────
import re as _re
_NUM_RE = _re.compile(r'-?\d+\.?\d*')

def _safe_float(raw) -> Optional[float]:
    """문자 혼합값에서 숫자 부분만 추출하여 float 변환."""
    if raw is None:
        return None
    try:
        return float(raw)
    except (ValueError, TypeError):
        m = _NUM_RE.search(str(raw))
        return float(m.group()) if m else None


# ── BIN 정규화 (JS _normalizeBottomValue 동일) ──────────────

_KNOWN_BINS = {285, 286, 287, 288, 290, 291, 300, 385, 386, 388, 389, 390}


def _normalize_bin(b) -> str:
    if b is None:
        return "Normal"
    s = str(b).strip()
    if not s:
        return "Normal"
    low = s.lower()
    if low in ("normal", "nor", "border"):
        return "Normal"
    if low in ("invalid", "inv"):
        return "Invalid"
    num = None
    if low.startswith("b") and low[1:].isdigit():
        num = int(low[1:])
    elif s.isdigit():
        num = int(s)
    if num is not None:
        if num < 200:
            return "Normal"
        if num < 280:
            return "Invalid"
        return str(num) if num in _KNOWN_BINS else "ETC"
    return s


# ── compact_array 포맷 지원: ftn_keys/qtn_keys 인덱스 조회 ──

_compact_key_index_cache: Dict[str, Dict[str, int]] = {}


def _set_compact_keys(positions_data: dict):
    """positions 로드 후 {mode}tn_keys 인덱스 캐시 설정."""
    _compact_key_index_cache.clear()
    for key_name, keys in positions_data.items():
        if key_name.endswith("tn_keys") and isinstance(keys, list):
            prefix = key_name[:-len("tn_keys")]  # "ftn_keys" → "f", "qtn_keys" → "q"
            _compact_key_index_cache[prefix] = {str(k): i for i, k in enumerate(keys)}


def _ftn_key_index(mode: str, item_key: str) -> Optional[int]:
    idx_map = _compact_key_index_cache.get(mode)
    if idx_map is None:
        return None
    return idx_map.get(str(item_key))


# ── 값 추출: BIN=1/0 전처리, FBT/QVL=수치 ──────────────────

def _extract_value(
    chip: dict, mode: str, item_key: Optional[str], bin_set: Optional[Set[str]]
) -> Optional[float]:
    """
    chip에서 값 하나 추출.
    - BIN: 선택 BIN이면 1.0, 아니면 0.0 (모든 chip에 값 부여)
    - FBT/QVL: chip[mode][item_key] → float, 없으면 None (skip)
    """
    if mode == "bin":
        norm = _normalize_bin(chip.get("b"))
        return 1.0 if norm in bin_set else 0.0

    data = chip.get(mode)
    if isinstance(data, dict):
        raw = data.get(item_key)
    elif isinstance(data, list):
        # compact_array 포맷: ftn_keys/qtn_keys 인덱스로 접근
        idx = _ftn_key_index(mode, item_key)
        raw = data[idx] if idx is not None and idx < len(data) else None
    else:
        return None
    return _safe_float(raw)


def _extract_values_from_data(data, mode, item_key, bin_types):
    """캐시된 positions 데이터에서 칩 값 추출 (extract_chip_values와 동일 로직)."""
    chips = data.get("chips")
    if not isinstance(chips, list):
        return None
    key_idx = None
    if mode != "bin":
        key_name = f"{mode}tn_keys"
        keys = data.get(key_name, [])
        for i, k in enumerate(keys):
            if str(k) == str(item_key):
                key_idx = i
                break
    bin_set = set(str(b) for b in bin_types) if bin_types else None
    results = []
    for chip in chips:
        xa = chip.get("x_abs") if chip.get("x_abs") is not None else chip.get("x")
        ya = chip.get("y_abs") if chip.get("y_abs") is not None else chip.get("y")
        if xa is None or ya is None:
            continue
        if mode == "bin":
            b = chip.get("b")
            norm = _normalize_bin(b)
            val = 1.0 if (bin_set and norm in bin_set) else 0.0
        else:
            fd = chip.get(mode)
            if isinstance(fd, list) and key_idx is not None and key_idx < len(fd):
                raw_val = fd[key_idx]
            elif isinstance(fd, dict):
                raw_val = fd.get(item_key)
            else:
                continue
            val = _safe_float(raw_val)
            if val is None:
                continue
        results.append((int(xa), int(ya), val))
    return results


# ── Positions 병렬 로드 ─────────────────────────────────────

def _load_positions_parallel(
    image_paths: List[str],
) -> List[Tuple[str, Optional[dict]]]:
    def _load(rel_path):
        return (rel_path, _load_source_positions_data(rel_path))

    # 항상 ThreadPool 사용 (I/O read_bytes 병렬 + GIL 틈새 활용)
    if len(image_paths) > 1:
        with ThreadPoolExecutor(max_workers=min(len(image_paths), _MAX_WORKERS)) as pool:
            return list(pool.map(_load, image_paths))
    return [_load(p) for p in image_paths]


# ── 값 수집 + 집계 (모든 모드 통합) ─────────────────────────

def _collect_and_aggregate(
    positions_list: List[Tuple[str, Optional[dict]]],
    mode: str,
    item_key: Optional[str],
    bin_types: Optional[List[str]],
    aggregation: str,
) -> Dict[Tuple[int, int], float]:
    """
    모든 wafer에서 chip 값 수집 → (x_abs, y_abs)별 집계.
    BIN 모드: 1/0 전처리 후 동일 파이프라인.
    """
    bin_set = (
        {str(b) for b in bin_types} if bin_types
        else {str(b) for b in _KNOWN_BINS}
    )

    # BIN + count → sum 으로 변환 (1/0의 sum = match count)
    eff_agg = "sum" if (mode == "bin" and aggregation == "count") else aggregation

    values_by_pos: Dict[Tuple[int, int], List[float]] = {}

    for _rel, pos_data in positions_list:
        if not pos_data:
            continue
        _set_compact_keys(pos_data)
        chips = pos_data.get("chips", [])
        if not isinstance(chips, list):
            continue
        for chip in chips:
            if not isinstance(chip, dict):
                continue
            xa = chip.get("x_abs") if chip.get("x_abs") is not None else chip.get("x")
            ya = chip.get("y_abs") if chip.get("y_abs") is not None else chip.get("y")
            if xa is None or ya is None:
                continue
            val = _extract_value(chip, mode, item_key, bin_set)
            if val is None:
                continue
            values_by_pos.setdefault((int(xa), int(ya)), []).append(val)

    result: Dict[Tuple[int, int], float] = {}
    for key, vals in values_by_pos.items():
        if eff_agg == "sum":
            agg = sum(vals)
        elif eff_agg == "count":
            agg = float(len(vals))
        else:  # average
            agg = sum(vals) / len(vals) if vals else 0.0
        result[key] = agg

    return result


# ── Percentile ranking ──────────────────────────────────────

def _percentile_ranks(
    value_map: Dict[Tuple[int, int], float],
) -> Dict[Tuple[int, int], float]:
    if not value_map:
        return {}
    sorted_vals = sorted(value_map.values())
    n = len(sorted_vals)
    vmin, vmax = sorted_vals[0], sorted_vals[-1]

    # 모든 값이 동일 → 50%
    if vmin == vmax:
        return {k: 50.0 for k in value_map}

    result = {}
    for key, val in value_map.items():
        lo = bisect_left(sorted_vals, val)
        rank = (lo / (n - 1)) * 100.0 if n > 1 else 50.0
        result[key] = max(0.0, min(100.0, rank))
    return result


# ── Color interpolation ────────────────────────────────────

def _interpolate_color(
    pct: float, stops: List[Tuple[int, int, int]]
) -> Tuple[int, int, int]:
    idx_f = pct / 10.0
    lo = max(0, min(10, int(idx_f)))
    hi = min(10, lo + 1)
    t = idx_f - lo
    r0, g0, b0 = stops[lo]
    r1, g1, b1 = stops[hi]
    return (
        int(r0 + (r1 - r0) * t),
        int(g0 + (g1 - g0) * t),
        int(b0 + (b1 - b0) * t),
    )


def _contrast_text(r: int, g: int, b: int) -> Tuple[int, int, int]:
    return (0, 0, 0) if (0.299 * r + 0.587 * g + 0.114 * b) > 140 else (255, 255, 255)


# ── Chip rect 계산 ──────────────────────────────────────────

def _chip_rect(
    chip: dict, sx: float, sy: float, w: int, h: int, inset: int = 0
) -> Optional[Tuple[int, int, int, int]]:
    rect = chip.get("rect", {})
    x0r = rect.get("x0") if isinstance(rect, dict) else None
    y0r = rect.get("y0") if isinstance(rect, dict) else None
    x1r = rect.get("x1") if isinstance(rect, dict) else None
    y1r = rect.get("y1") if isinstance(rect, dict) else None

    if None in (x0r, y0r, x1r, y1r):
        xr = chip.get("x")
        yr = chip.get("y")
        wr = chip.get("w", chip.get("width"))
        hr = chip.get("h", chip.get("height"))
        if None in (xr, yr, wr, hr):
            return None
        x0r, y0r = xr, yr
        x1r = float(xr) + float(wr)
        y1r = float(yr) + float(hr)

    try:
        cx0 = max(0, min(w, int(round(float(x0r) * sx))))
        cy0 = max(0, min(h, int(round(float(y0r) * sy))))
        cx1 = max(0, min(w, int(round(float(x1r) * sx))))
        cy1 = max(0, min(h, int(round(float(y1r) * sy))))
    except (TypeError, ValueError):
        return None

    x0 = min(cx0 + inset, cx1)
    y0 = min(cy0 + inset, cy1)
    x1 = max(cx1 - inset, cx0)
    y1 = max(cy1 - inset, cy0)
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


# ── Value 포맷 (K/M 축약) ──────────────────────────────────

def _fmt_value(val: float) -> str:
    v = abs(val)
    if v == int(v):
        n = int(v)
        if n < 1000:
            return str(n)
        if n < 10000:
            return f"{n / 1000:.1f}K"
        if n < 1_000_000:
            return f"{n // 1000}K"
        if n < 10_000_000:
            return f"{n / 1_000_000:.1f}M"
        return f"{n // 1_000_000}M"
    if v < 1000:
        return f"{v:.1f}" if v != int(v) else str(int(v))
    if v < 10000:
        return f"{v / 1000:.1f}K"
    if v < 1_000_000:
        return f"{int(v) // 1000}K"
    return f"{v / 1_000_000:.1f}M"


# ── 이미지 렌더링 ──────────────────────────────────────────

def _render(
    base_image_path: Path,
    base_positions: dict,
    percentile_map: Dict[Tuple[int, int], float],
    gradient_stops: List[Tuple[int, int, int]],
    value_map: Optional[Dict[Tuple[int, int], float]] = None,
    gradient_filter: Optional[Set[int]] = None,
    bin_filter: Optional[Set[str]] = None,
    border_color: Optional[Tuple[int, int, int]] = None,
    scheme: Optional[str] = None,
) -> Image.Image:
    """
    PIL ImageDraw 기반 고속 렌더링 — numpy 143MB 배열 제거.
    positions 좌표만으로 칩 사각형을 직접 그림.
    """
    from PIL import ImageDraw, ImageFont
    from .composite_map import _resolve_scheme_background_rgb

    # 캔버스 크기 결정 (이미지 로드 없음)
    coord = base_positions.get("coord", {})
    canvas_info = coord.get("canvas", {}) if isinstance(coord, dict) else {}
    w = int(canvas_info.get("width", 0)) if isinstance(canvas_info, dict) else 0
    h = int(canvas_info.get("height", 0)) if isinstance(canvas_info, dict) else 0
    if w <= 0 or h <= 0:
        img = Image.open(base_image_path)
        w, h = img.size
        img.close()

    cw = w if w > 0 else 1
    ch = h if h > 0 else 1
    sx, sy = w / float(cw), h / float(ch)

    chips = base_positions.get("chips", [])
    if not isinstance(chips, list):
        return Image.new("RGB", (w, h), (0, 0, 0))

    # w/h 없는 칩 데이터용: 칩 크기 추정 (인접 칩 간 최소 간격 기반)
    _need_wh = any(
        isinstance(c, dict) and c.get("w") is None and c.get("width") is None
        and c.get("rect") is None
        for c in chips
    )
    est_cw, est_ch = 1, 1
    if _need_wh and len(chips) >= 2:
        xs = sorted({int(c.get("x", 0)) for c in chips if isinstance(c, dict) and c.get("x") is not None})
        ys = sorted({int(c.get("y", 0)) for c in chips if isinstance(c, dict) and c.get("y") is not None})
        if len(xs) >= 2:
            est_cw = min(xs[i+1] - xs[i] for i in range(len(xs)-1) if xs[i+1] > xs[i])
        if len(ys) >= 2:
            est_ch = min(ys[i+1] - ys[i] for i in range(len(ys)-1) if ys[i+1] > ys[i])
        if est_cw <= 0:
            est_cw = 1
        if est_ch <= 0:
            est_ch = 1

    # chip rect 계산 + abs 좌표 매핑
    chip_rects = []
    abs_to_idx: Dict[Tuple[int, int], int] = {}
    abs_to_bin: Dict[Tuple[int, int], str] = {}
    for i, c in enumerate(chips):
        if not isinstance(c, dict):
            chip_rects.append(None)
            continue
        # w/h 없는 칩에 추정값 보충
        if _need_wh and c.get("w") is None and c.get("width") is None:
            c = {**c, "w": est_cw, "h": est_ch}
        r = _chip_rect(c, sx, sy, w, h)
        chip_rects.append(r)
        xa = c.get("x_abs") if c.get("x_abs") is not None else c.get("x")
        ya = c.get("y_abs") if c.get("y_abs") is not None else c.get("y")
        if xa is not None and ya is not None:
            key = (int(xa), int(ya))
            abs_to_idx[key] = i
            abs_to_bin[key] = _normalize_bin(c.get("b"))

    # PIL Image 직접 생성 (배경색 = 개인색)
    bg_rgb = _resolve_scheme_background_rgb(scheme)
    img = Image.new("RGB", (w, h), bg_rgb)
    draw = ImageDraw.Draw(img)

    has_filter = gradient_filter is not None or bin_filter is not None
    base_fill = (255, 255, 255) if has_filter else (224, 224, 224)
    bc = border_color

    # 1) 모든 칩 → base color + 테두리 (ImageDraw.rectangle, C 구현)
    for r in chip_rects:
        if r is None:
            continue
        draw.rectangle([r[0], r[1], r[2] - 1, r[3] - 1], fill=base_fill, outline=bc)

    # 2) 매칭 칩 → gradient color
    render_info = []
    for (xa, ya), pct in percentile_map.items():
        idx = abs_to_idx.get((xa, ya))
        if idx is None:
            continue
        if gradient_filter is not None:
            if min(int(pct / 10), 9) not in gradient_filter:
                continue
        if bin_filter is not None:
            if abs_to_bin.get((xa, ya), "Normal") not in bin_filter:
                continue
        rect = chip_rects[idx]
        if not rect:
            continue
        color = _interpolate_color(pct, gradient_stops)
        x0, y0, x1, y1 = rect
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=color)
        if bc:
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=bc)
        raw = value_map.get((xa, ya)) if value_map else None
        render_info.append((x0, y0, x1, y1, color, raw))

    if not render_info:
        return img

    # 3) 텍스트
    if value_map and render_info:
        samples = render_info[:20]
        avg_h = sum(y1 - y0 for _, y0, _, y1, _, _ in samples) / len(samples)
        avg_w = sum(x1 - x0 for x0, _, x1, _, _, _ in samples) / len(samples)
        # 칩 크기 비례 폰트 — 칩 높이의 35%, 최소 8px (대형 캔버스에서도 가독성 보장)
        font_size = max(8, int(min(avg_w, avg_h) * 0.35))
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except (OSError, IOError):
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
            except (OSError, IOError):
                font = ImageFont.load_default()

        for x0, y0, x1, y1, bg, raw in render_info:
            if raw is None:
                continue
            text = _fmt_value(raw)
            tc = _contrast_text(*bg)
            cw, ch = x1 - x0, y1 - y0
            # 텍스트가 칩보다 클 경우 축소 폰트 사용
            cur_font = font
            bbox = draw.textbbox((0, 0), text, font=cur_font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            if tw > cw * 0.95 or th > ch * 0.85:
                shrink = min(cw * 0.9 / max(tw, 1), ch * 0.8 / max(th, 1))
                sf = max(8, int(font_size * shrink))
                try:
                    cur_font = ImageFont.truetype(font.path, sf)
                except Exception:
                    cur_font = font
                bbox = draw.textbbox((0, 0), text, font=cur_font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.text((x0 + (cw - tw) // 2, y0 + (ch - th) // 2), text, fill=tc, font=cur_font)

    return img


# ── NPZ 캐시 ───────────────────────────────────────────────

def _save_cache(
    output_dir: Path,
    positions_arr: np.ndarray,
    values_arr: np.ndarray,
    percentiles_arr: np.ndarray,
    mode: str,
    item_key: Optional[str],
    aggregation: str,
    source_count: int,
    scheme: Optional[str] = None,
) -> None:
    cache_path = output_dir / MEASURE_CACHE_FILENAME
    payload = {
        "chip_positions": positions_arr,
        "aggregated_values": values_arr,
        "percentiles": percentiles_arr,
        "mode": np.array([mode], dtype="U8"),
        "item_key": np.array([item_key or ""], dtype="U32"),
        "aggregation": np.array([aggregation], dtype="U16"),
        "source_image_count": np.array(source_count, dtype=np.uint32),
    }
    if scheme:
        payload["color_scheme"] = np.array([scheme], dtype="U32")

    def _bg_save():
        try:
            np.savez(cache_path, **payload)
        except Exception:
            pass

    threading.Thread(target=_bg_save, daemon=True).start()


def create_measure_data_only(
    image_paths: List[str],
    mode: str,
    item_key: Optional[str] = None,
    bin_types: Optional[List[str]] = None,
    aggregation: str = "average",
    scheme: Optional[str] = None,
) -> Dict[str, Any]:
    """
    이미지 렌더링/저장 없이 칩 좌표+값+색상만 반환.
    브라우저에서 Canvas로 직접 그림.
    """
    t0 = time.perf_counter()

    # 1. Positions 파싱 + 값 추출
    #    1개: 순차 (13ms), 여러 개: ProcessPool 병렬 (GIL-free 병렬 파싱)
    from .composite_map import _load_source_positions_data, _candidate_source_positions_paths
    from ._parallel_json import extract_chip_values

    if len(image_paths) <= 2:
        # 소수 파일: 순차 (ProcessPool 스폰 오버헤드 회피)
        all_chip_results = []
        for rel_path in image_paths:
            data = _load_source_positions_data(rel_path)
            if data:
                all_chip_results.append(_extract_values_from_data(data, mode, item_key, bin_types))
            else:
                all_chip_results.append(None)
    else:
        # 다수 파일: ProcessPool 병렬 (JSON 파싱이 GIL-free)
        pos_args = []
        for rel_path in image_paths:
            for c in _candidate_source_positions_paths(rel_path):
                if c.exists():
                    pos_args.append((str(c), mode, item_key, bin_types))
                    break
        if _MEASURE_PROC_POOL is not None and pos_args:
            all_chip_results = list(_MEASURE_PROC_POOL.map(extract_chip_values, pos_args))
        else:
            all_chip_results = [extract_chip_values(a) for a in pos_args]

    # 2. 집계
    values_by_pos: Dict[Tuple[int, int], List[float]] = {}
    source_count = 0
    for chip_vals in all_chip_results:
        if not chip_vals:
            continue
        source_count += 1
        for xa, ya, val in chip_vals:
            values_by_pos.setdefault((xa, ya), []).append(val)

    eff_agg = "sum" if (mode == "bin" and aggregation == "count") else aggregation
    value_map: Dict[Tuple[int, int], float] = {}
    for key, vals in values_by_pos.items():
        if eff_agg == "sum":
            value_map[key] = sum(vals)
        elif eff_agg == "count":
            value_map[key] = float(len(vals))
        else:
            value_map[key] = sum(vals) / len(vals) if vals else 0.0

    if not value_map:
        raise ValueError(f"No chip values found (mode={mode}, item_key={item_key})")

    # 3. Percentile
    pct_map = _percentile_ranks(value_map)

    # 4. Gradient 색상
    resolved = scheme or ANONYMOUS_LOGIN_ID
    stops = get_ratio_gradient_for_scheme(resolved)

    # 5. Base positions (canvas 크기 + 칩 좌표)
    from .composite_map import _first_image_with_positions, _load_source_positions_data, _resolve_scheme_background_rgb
    base_rel = _first_image_with_positions(image_paths)
    base_pos = _load_source_positions_data(base_rel) if base_rel else None

    canvas_w, canvas_h = 0, 0
    chip_rects = []
    if base_pos:
        coord = base_pos.get("coord", {})
        canvas_info = coord.get("canvas", {}) if isinstance(coord, dict) else {}
        canvas_w = int(canvas_info.get("width", 0)) if isinstance(canvas_info, dict) else 0
        canvas_h = int(canvas_info.get("height", 0)) if isinstance(canvas_info, dict) else 0
        sx = 1.0 if canvas_w <= 0 else 1.0
        sy = 1.0 if canvas_h <= 0 else 1.0

        base_chips = base_pos.get("chips", [])
        # w/h 없는 칩용 크기 추정
        _need_wh2 = any(
            isinstance(c, dict) and c.get("w") is None and c.get("width") is None
            and c.get("rect") is None
            for c in base_chips
        )
        est_cw2, est_ch2 = 1, 1
        if _need_wh2 and len(base_chips) >= 2:
            xs2 = sorted({int(c.get("x", 0)) for c in base_chips if isinstance(c, dict) and c.get("x") is not None})
            ys2 = sorted({int(c.get("y", 0)) for c in base_chips if isinstance(c, dict) and c.get("y") is not None})
            if len(xs2) >= 2:
                est_cw2 = min(xs2[i+1] - xs2[i] for i in range(len(xs2)-1) if xs2[i+1] > xs2[i])
            if len(ys2) >= 2:
                est_ch2 = min(ys2[i+1] - ys2[i] for i in range(len(ys2)-1) if ys2[i+1] > ys2[i])
            if est_cw2 <= 0: est_cw2 = 1
            if est_ch2 <= 0: est_ch2 = 1

        for chip in base_chips:
            if not isinstance(chip, dict):
                continue
            xa = chip.get("x_abs") if chip.get("x_abs") is not None else chip.get("x")
            ya = chip.get("y_abs") if chip.get("y_abs") is not None else chip.get("y")
            c_for_rect = chip
            if _need_wh2 and chip.get("w") is None and chip.get("width") is None:
                c_for_rect = {**chip, "w": est_cw2, "h": est_ch2}
            cr = _chip_rect(c_for_rect, sx, sy, canvas_w, canvas_h)
            if cr:
                chip_rects.append({
                    "xa": xa, "ya": ya,
                    "x0": cr[0], "y0": cr[1],
                    "x1": cr[2], "y1": cr[3],
                })

    # 6. 칩별 결과 데이터
    border_rgb = _get_normal_border_rgb(resolved)
    bg_rgb = _resolve_scheme_background_rgb(resolved)
    chips_data = []
    for (xa, ya), pct in pct_map.items():
        color = _interpolate_color(pct, stops)
        raw = value_map.get((xa, ya))
        chips_data.append({
            "xa": xa, "ya": ya,
            "pct": round(pct, 1),
            "val": round(raw, 2) if raw is not None else None,
            "color": list(color),
        })

    elapsed = time.perf_counter() - t0
    return {
        "canvas": {"width": canvas_w, "height": canvas_h},
        "chips": chips_data,
        "chip_rects": chip_rects,
        "background": list(bg_rgb),
        "border": list(border_rgb),
        "gradient_stops": [list(s) for s in stops],
        "source_images": source_count,
        "chip_count": len(chips_data),
        "processing_time": round(elapsed, 3),
        "mode": mode,
        "item_key": item_key,
        "aggregation": aggregation,
    }


# ── Main: Measure Composite 생성 ───────────────────────────

def create_measure_composite(
    image_paths: List[str],
    mode: str,
    item_key: Optional[str] = None,
    bin_types: Optional[List[str]] = None,
    aggregation: str = "average",
    scheme: Optional[str] = None,
    login_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Measure Composite Map 생성.
    BIN: 전처리(1/0) → FBT/QVL과 동일 파이프라인.
    """
    t0 = time.perf_counter()

    # 1+2. Positions 로드 + 값 추출을 ProcessPool 병렬로 한 번에 처리
    # (JSON 2.7MB 파싱이 GIL-bound → ProcessPool로 진짜 병렬)
    from .composite_map import _candidate_source_positions_paths, _positions_json_cache
    from ._parallel_json import extract_chip_values

    # positions 파일 경로 해결
    pos_file_args = []
    for rel_path in image_paths:
        pos_path = None
        # 캐시 히트 체크
        cached = _positions_json_cache.get(rel_path)
        if cached is not None:
            pos_path = "__cached__:" + rel_path
        else:
            from pathlib import Path as _P
            for c in _candidate_source_positions_paths(rel_path):
                if c.exists():
                    pos_path = str(c)
                    break
        if pos_path:
            pos_file_args.append((pos_path, mode, item_key, bin_types))

    # 캐시 히트는 순차, 캐시 미스는 ProcessPool 병렬
    cached_results = []
    proc_args = []
    proc_indices = []
    all_chip_results = [None] * len(pos_file_args)

    for i, (path, m, k, b) in enumerate(pos_file_args):
        if path.startswith("__cached__:"):
            rel = path[len("__cached__:"):]
            data = _positions_json_cache[rel]
            # 캐시된 데이터에서 직접 추출
            chip_vals = _extract_values_from_data(data, m, k, b)
            all_chip_results[i] = chip_vals
        else:
            proc_args.append((path, m, k, b))
            proc_indices.append(i)

    # ProcessPool로 캐시 미스 파일 병렬 처리
    if proc_args and _MEASURE_PROC_POOL is not None:
        proc_results = list(_MEASURE_PROC_POOL.map(extract_chip_values, proc_args))
        for idx, result in zip(proc_indices, proc_results):
            all_chip_results[idx] = result
    elif proc_args:
        for idx, arg in zip(proc_indices, proc_args):
            all_chip_results[idx] = extract_chip_values(arg)

    # 집계
    values_by_pos: Dict[Tuple[int, int], List[float]] = {}
    source_count = 0
    for chip_vals in all_chip_results:
        if chip_vals is None:
            continue
        source_count += 1
        for xa, ya, val in chip_vals:
            values_by_pos.setdefault((xa, ya), []).append(val)

    eff_agg = "sum" if (mode == "bin" and aggregation == "count") else aggregation
    value_map: Dict[Tuple[int, int], float] = {}
    for key, vals in values_by_pos.items():
        if eff_agg == "sum":
            value_map[key] = sum(vals)
        elif eff_agg == "count":
            value_map[key] = float(len(vals))
        else:
            value_map[key] = sum(vals) / len(vals) if vals else 0.0

    valid_count = source_count
    if not value_map:
        raise ValueError(f"No chip values found (mode={mode}, item_key={item_key})")

    # 3. Percentile ranking
    pct_map = _percentile_ranks(value_map)

    # 4. Gradient 색상
    resolved = scheme or login_id or ANONYMOUS_LOGIN_ID
    stops = get_ratio_gradient_for_scheme(resolved)

    # 5. Base image
    base_rel = _first_image_with_positions(image_paths)
    if not base_rel:
        raise ValueError("No base image found")
    base_path = IMAGES_ROOT / base_rel
    base_pos = _load_source_positions_data(base_rel)
    if not base_pos:
        raise ValueError("Cannot load positions for base image")

    # 6. Output directory — LoginId 바로 밑에 생성 (서브폴더 없음)
    user_dir = COMPOSITE_ROOT / _sanitize_login_id(login_id)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = user_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    # 🔥 이전 삭제는 /api/composite-cleanup에서 처리 — 여기서는 생성만

    # 7. 렌더링
    border_rgb = _get_normal_border_rgb(resolved)
    result_img = _render(base_path, base_pos, pct_map, stops, value_map=value_map, border_color=border_rgb, scheme=resolved)

    # 8. 저장
    if mode == "bin":
        bins_label = ",".join(sorted(bin_types)) if bin_types else "all"
        display_name = f"BIN_{bins_label}_{aggregation}"
    else:
        display_name = f"{mode.upper()}_{item_key}_{aggregation}"

    out_file = out_dir / f"{display_name}.png"
    _save_image_with_backend(result_img, out_file)

    actual = out_file
    for ext in [".png", ".jpg", ".webp"]:
        c = out_file.with_suffix(ext)
        if c.exists():
            actual = c
            break

    result_rel = actual.relative_to(IMAGES_ROOT).as_posix()

    # 9. Positions 복사 (BIN 정보 보존 → bottom legend용) — 비동기
    threading.Thread(
        target=_copy_positions_without_bin,
        args=(base_rel, out_dir, [actual.name]),
        kwargs={"keep_chip_bin": True},
        daemon=True,
    ).start()

    # 10. NPZ 캐시
    keys = sorted(pct_map.keys())
    pos_arr = np.array(keys, dtype=np.int32)
    val_arr = np.array([value_map[k] for k in keys], dtype=np.float32)
    pct_arr = np.array([pct_map[k] for k in keys], dtype=np.float32)
    _save_cache(out_dir, pos_arr, val_arr, pct_arr, mode, item_key, aggregation, valid_count, resolved)

    elapsed = time.perf_counter() - t0

    # Range counts (10구간)
    range_counts = [0] * 10
    for pct in pct_map.values():
        range_counts[min(int(pct / 10), 9)] += 1

    return {
        "output_dir": out_dir.relative_to(IMAGES_ROOT).as_posix(),
        "timestamp": ts,
        "image_path": result_rel,
        "display_name": display_name,
        "filename": actual.name,
        "source_images": valid_count,
        "total_images": len(image_paths),
        "chip_count": len(pct_map),
        "mode": mode,
        "item_key": item_key,
        "bin_types": bin_types,
        "aggregation": aggregation,
        "value_range": {
            "min": float(min(value_map.values())),
            "max": float(max(value_map.values())),
        },
        "range_counts": range_counts,
        "processing_time": round(elapsed, 2),
        "generated_at": ts,
        "image_size": {"width": result_img.width, "height": result_img.height},
    }


# ── Recolor (NPZ 캐시 기반 + filter 지원) ──────────────────

def recolor_measure_composite(
    output_dir_rel: str,
    scheme: Optional[str] = None,
    gradient_filter: Optional[List[int]] = None,
    bin_filter: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    NPZ 캐시 기반 빠른 재렌더링.
    gradient_filter: 표시할 percentile range 인덱스 리스트 [0,1,...,9]
    bin_filter: 표시할 BIN 타입 리스트 ["285", "286", ...]
    """
    out_dir = IMAGES_ROOT / output_dir_rel
    cache_path = out_dir / MEASURE_CACHE_FILENAME
    if not cache_path.exists():
        raise FileNotFoundError(f"Measure cache not found: {cache_path}")

    with np.load(cache_path) as data:
        pos_arr = data["chip_positions"]
        pct_arr = data["percentiles"]
        val_arr = data["aggregated_values"]

    pct_map = {}
    val_map = {}
    for i in range(len(pos_arr)):
        k = (int(pos_arr[i, 0]), int(pos_arr[i, 1]))
        pct_map[k] = float(pct_arr[i])
        val_map[k] = float(val_arr[i])

    resolved = scheme or ANONYMOUS_LOGIN_ID
    stops = get_ratio_gradient_for_scheme(resolved)

    # 기존 출력 이미지 찾기
    images = [
        f for f in out_dir.iterdir()
        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
        and MEASURE_CACHE_FILENAME.replace(".npz", "") not in f.stem
    ]
    if not images:
        raise FileNotFoundError("No output image found")
    target = images[0]

    # Positions 파일 로드
    pos_dir = POSITIONS_ROOT / out_dir.relative_to(IMAGES_ROOT)
    pos_file = pos_dir / f"{target.stem}.json"
    if not pos_file.exists():
        raise FileNotFoundError(f"Positions not found: {pos_file}")
    with open(pos_file, "r", encoding="utf-8") as f:
        base_pos = json.load(f)

    # Filter sets 구성
    gf_set = set(gradient_filter) if gradient_filter else None
    bf_set = set(bin_filter) if bin_filter else None

    # 재렌더링
    border_rgb = _get_normal_border_rgb(resolved)
    result_img = _render(
        target, base_pos, pct_map, stops,
        value_map=val_map,
        gradient_filter=gf_set,
        bin_filter=bf_set,
        border_color=border_rgb,
        scheme=resolved,
    )
    _save_image_with_backend(result_img, target)

    # filter 적용 후 range counts 재계산
    # BIN lookup 구성 (O(1) access)
    bin_lookup = {}
    if bf_set is not None:
        for c in base_pos.get("chips", []):
            if isinstance(c, dict):
                _xa = c.get("x_abs") if c.get("x_abs") is not None else c.get("x")
                _ya = c.get("y_abs") if c.get("y_abs") is not None else c.get("y")
                if _xa is not None and _ya is not None:
                    bin_lookup[(int(_xa), int(_ya))] = _normalize_bin(c.get("b"))

    range_counts = [0] * 10
    for (xa, ya), pct in pct_map.items():
        ri = min(int(pct / 10), 9)
        if gf_set is not None and ri not in gf_set:
            continue
        if bf_set is not None:
            if bin_lookup.get((xa, ya), "Normal") not in bf_set:
                continue
        range_counts[ri] += 1

    return {
        "success": True,
        "output_dir": output_dir_rel,
        "image_path": target.relative_to(IMAGES_ROOT).as_posix(),
        "scheme": resolved,
        "range_counts": range_counts,
    }
