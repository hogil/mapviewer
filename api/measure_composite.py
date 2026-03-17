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
    """positions 로드 후 ftn_keys/qtn_keys 인덱스 캐시 설정."""
    _compact_key_index_cache.clear()
    for prefix, key_name in (("f", "ftn_keys"), ("q", "qtn_keys")):
        keys = positions_data.get(key_name)
        if keys:
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
    if raw is None:
        return None
    try:
        return float(raw)
    except (ValueError, TypeError):
        return None


# ── Positions 병렬 로드 ─────────────────────────────────────

def _load_positions_parallel(
    image_paths: List[str],
) -> List[Tuple[str, Optional[dict]]]:
    def _load(rel_path):
        return (rel_path, _load_source_positions_data(rel_path))

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        return list(pool.map(_load, image_paths))


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
            xa, ya = chip.get("x_abs"), chip.get("y_abs")
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
) -> Image.Image:
    """
    Gradient-colored chip 렌더링.
    gradient_filter: 표시할 percentile range 인덱스 (0-9). None=전체.
    bin_filter: 표시할 BIN 타입. None=전체.
    """
    from PIL import ImageDraw, ImageFont

    img = Image.open(base_image_path).convert("RGB")
    w, h = img.size

    coord = base_positions.get("coord", {})
    canvas = coord.get("canvas", {}) if isinstance(coord, dict) else {}
    cw = int(canvas.get("width", w)) if isinstance(canvas, dict) else w
    ch = int(canvas.get("height", h)) if isinstance(canvas, dict) else h
    if cw <= 0:
        cw = w
    if ch <= 0:
        ch = h
    sx, sy = w / float(cw), h / float(ch)

    chips = base_positions.get("chips", [])
    if not isinstance(chips, list):
        return img

    # Build (x_abs, y_abs) → chip index + BIN lookup
    abs_to_idx: Dict[Tuple[int, int], int] = {}
    abs_to_bin: Dict[Tuple[int, int], str] = {}
    for i, c in enumerate(chips):
        if not isinstance(c, dict):
            continue
        xa, ya = c.get("x_abs"), c.get("y_abs")
        if xa is None or ya is None:
            continue
        key = (int(xa), int(ya))
        abs_to_idx[key] = i
        abs_to_bin[key] = _normalize_bin(c.get("b"))

    arr = np.array(img, dtype=np.uint8)

    # 필터 활성 시 비매칭 chip → 흰색(숫자 없음), 비활성 시 → 연한 회색
    has_filter = gradient_filter is not None or bin_filter is not None
    BASE_COLOR = (255, 255, 255) if has_filter else (224, 224, 224)

    # 1) 모든 chip → base color
    for c in chips:
        if not isinstance(c, dict):
            continue
        r = _chip_rect(c, sx, sy, w, h)
        if r:
            arr[r[1]:r[3], r[0]:r[2]] = BASE_COLOR

    # 1.5) 칩 테두리 (Normal 색상)
    if border_color is not None:
        bc = border_color
        for c in chips:
            if not isinstance(c, dict):
                continue
            r = _chip_rect(c, sx, sy, w, h)
            if not r:
                continue
            x0, y0, x1, y1 = r
            arr[y0, x0:x1] = bc        # 상단
            arr[y1 - 1, x0:x1] = bc    # 하단
            arr[y0:y1, x0] = bc        # 좌측
            arr[y0:y1, x1 - 1] = bc    # 우측

    # 2) 매칭 chip → gradient (filter 적용)
    render_info = []
    for (xa, ya), pct in percentile_map.items():
        idx = abs_to_idx.get((xa, ya))
        if idx is None:
            continue

        # gradient filter: percentile range 체크
        if gradient_filter is not None:
            range_idx = min(int(pct / 10), 9)
            if range_idx not in gradient_filter:
                continue

        # bin filter: chip BIN 타입 체크
        if bin_filter is not None:
            chip_bin = abs_to_bin.get((xa, ya), "Normal")
            if chip_bin not in bin_filter:
                continue

        rect = _chip_rect(chips[idx], sx, sy, w, h)
        if not rect:
            continue
        color = _interpolate_color(pct, gradient_stops)
        arr[rect[1]:rect[3], rect[0]:rect[2]] = color
        raw = value_map.get((xa, ya)) if value_map else None
        render_info.append((rect[0], rect[1], rect[2], rect[3], color, raw))

    if not render_info:
        return Image.fromarray(arr)

    # 3) 텍스트 렌더링
    result_img = Image.fromarray(arr)
    if value_map and render_info:
        draw = ImageDraw.Draw(result_img)
        samples = render_info[:20]
        avg_h = sum(y1 - y0 for _, y0, _, y1, _, _ in samples) / len(samples)
        font_size = max(8, min(24, int(avg_h * 0.45)))
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except (OSError, IOError):
            try:
                font = ImageFont.truetype(
                    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size
                )
            except (OSError, IOError):
                font = ImageFont.load_default()

        for x0, y0, x1, y1, bg, raw in render_info:
            if raw is None:
                continue
            text = _fmt_value(raw)
            tc = _contrast_text(*bg)
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            tx = x0 + ((x1 - x0) - tw) // 2
            ty = y0 + ((y1 - y0) - th) // 2
            draw.text((tx, ty), text, fill=tc, font=font)

    return result_img


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

    # 1. Positions 병렬 로드
    all_positions = _load_positions_parallel(image_paths)
    valid = [(p, d) for p, d in all_positions if d is not None]
    if not valid:
        raise ValueError("No valid positions data found")

    # 2. 값 수집 + 집계 (BIN=1/0 전처리 포함)
    value_map = _collect_and_aggregate(valid, mode, item_key, bin_types, aggregation)
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

    # 6. Output directory
    user_dir = COMPOSITE_ROOT / (login_id or ANONYMOUS_LOGIN_ID)
    user_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = user_dir / f"{ts}_measure"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 7. 렌더링
    border_rgb = _get_normal_border_rgb(resolved)
    result_img = _render(base_path, base_pos, pct_map, stops, value_map=value_map, border_color=border_rgb)

    # 8. 저장
    if mode == "bin":
        bins_label = ",".join(sorted(bin_types)) if bin_types else "all"
        display_name = f"BIN_{bins_label}_{aggregation}"
    else:
        prefix = "FBT" if mode == "f" else "QVL"
        display_name = f"{prefix}_{item_key}_{aggregation}"

    out_file = out_dir / f"{display_name}.png"
    _save_image_with_backend(result_img, out_file)

    actual = out_file
    for ext in [".png", ".jpg", ".webp"]:
        c = out_file.with_suffix(ext)
        if c.exists():
            actual = c
            break

    result_rel = actual.relative_to(IMAGES_ROOT).as_posix()

    # 9. Positions 복사 (BIN 정보 보존 → bottom legend용)
    _copy_positions_without_bin(base_rel, out_dir, [actual.name], keep_chip_bin=True)

    # 10. NPZ 캐시
    keys = sorted(pct_map.keys())
    pos_arr = np.array(keys, dtype=np.int32)
    val_arr = np.array([value_map[k] for k in keys], dtype=np.float32)
    pct_arr = np.array([pct_map[k] for k in keys], dtype=np.float32)
    _save_cache(out_dir, pos_arr, val_arr, pct_arr, mode, item_key, aggregation, len(valid), resolved)

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
        "source_images": len(valid),
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
    )
    _save_image_with_backend(result_img, target)

    # filter 적용 후 range counts 재계산
    # BIN lookup 구성 (O(1) access)
    bin_lookup = {}
    if bf_set is not None:
        for c in base_pos.get("chips", []):
            if isinstance(c, dict) and c.get("x_abs") is not None:
                bin_lookup[(int(c["x_abs"]), int(c["y_abs"]))] = _normalize_bin(c.get("b"))

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
