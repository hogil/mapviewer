"""
Composite Map 생성 모듈
여러 웨이퍼 맵의 인덱스별 빈도를 히트맵으로 시각화
"""
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Sequence
import numpy as np
from PIL import Image
from PIL.Image import DecompressionBombWarning

from .config import (
    IMAGES_ROOT,
    COMPOSITE_MAX_WORKERS,
    COMPOSITE_LOADER_MODE,
    COMPOSITE_BATCH_SIZE,
)
from .personal_colors import load_color_legends, _scheme_to_palette_bytes, normalize_hex_color
from .composite_colors import load_composite_color_settings

Image.MAX_IMAGE_PIXELS = None
warnings.simplefilter("ignore", DecompressionBombWarning)

# Composite 맵 저장 디렉토리
COMPOSITE_ROOT = IMAGES_ROOT / "composite_maps"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)
SQUARE_MAP_CACHE_FILENAME = "square_maps_data.npz"


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


def _hex_to_rgb_tuple(value: str) -> Tuple[int, int, int]:
    value = value.lstrip("#")
    if len(value) != 6:
        return (255, 255, 255)
    r = int(value[0:2], 16)
    g = int(value[2:4], 16)
    b = int(value[4:6], 16)
    return (r, g, b)


def _interpolate_percentile_colors(
    percentiles: np.ndarray,
    color_array: np.ndarray,
) -> np.ndarray:
    """
    Percentile (0~100)을 색상으로 변환

    Args:
        percentiles: 0~100 범위의 percentile 값들
        color_array: 11개의 RGB 색상 [quantile0, quantile10, ..., quantile100]

    Returns:
        RGB 색상 배열
    """
    if percentiles.size == 0:
        return np.zeros((0, 3), dtype=np.uint8)

    # percentile을 0~10 인덱스로 변환
    # percentile 0~10 → bucket 0, 10~20 → bucket 1, ..., 90~100 → bucket 9
    bucket_indices = (percentiles / 10.0).astype(np.float32)
    buckets = np.floor(bucket_indices).astype(np.int32)
    buckets = np.clip(buckets, 0, len(color_array) - 2)
    next_idx = buckets + 1

    # 보간 비율 계산
    t = (bucket_indices - buckets).reshape(-1, 1)

    # 색상 보간
    start_colors = color_array[buckets]
    end_colors = color_array[next_idx]
    blended = start_colors + (end_colors - start_colors) * t
    return np.clip(np.round(blended), 0, 255).astype(np.uint8)


def _load_pixel_indices(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None
    try:
        with Image.open(full_path) as img:
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)
            if img.mode == 'P':
                pixel_indices = np.array(img, dtype=np.uint8)
            else:
                img_l = img.convert('L')
                pixels = np.array(img_l, dtype=np.uint8)
                pixel_indices = pixels // 32
            return pixel_indices
    except Exception as exc:
        print(f"[FAST] Composite image load failed: {image_rel_path}, {exc}")
        return None


def _iter_pixel_indices(
    image_paths: List[str],
    width: int,
    height: int,
    loader_mode: str,
    max_workers: Optional[int]
):
    if not image_paths:
        return []
    normalized_mode = (loader_mode or "thread").lower()
    max_workers = max_workers or COMPOSITE_MAX_WORKERS
    worker_count = min(max(1, max_workers), len(image_paths))
    loader = partial(_load_pixel_indices, width=width, height=height)

    if normalized_mode in {"sequential", "none"} or worker_count <= 1:
        for rel_path in image_paths:
            yield rel_path, loader(rel_path)
        return

    executor_cls = ThreadPoolExecutor
    if normalized_mode in {"process", "proc", "multiprocess"}:
        executor_cls = ProcessPoolExecutor

    with executor_cls(max_workers=worker_count) as executor:
        for rel_path, result in zip(image_paths, executor.map(loader, image_paths)):
            yield rel_path, result


def _render_sum_map_image(
    base_indices: np.ndarray,
    value_map: np.ndarray,
    mask: np.ndarray,
    palette_list: List[int],
    quantiles: Sequence[float],
    color_stops: np.ndarray,
) -> Image.Image:
    rgb_palette = np.array(palette_list, dtype=np.uint8).reshape(256, 3)
    rgb_array = rgb_palette[base_indices].copy()
    calc_values = value_map[mask]

    if calc_values.size > 0 and len(color_stops) >= 2:
        # 값들을 percentile (0~100)로 정규화
        min_val = calc_values.min()
        max_val = calc_values.max()

        if max_val > min_val:
            percentiles = (calc_values - min_val) / (max_val - min_val) * 100.0
        else:
            percentiles = np.zeros_like(calc_values)

        # percentile에 따라 색상 보간
        # color_stops는 [0, 10, 20, ..., 100]에 해당하는 11개 색상
        colors = _interpolate_percentile_colors(percentiles, color_stops)
        rgb_array[mask] = colors

    return Image.fromarray(rgb_array.astype(np.uint8), mode='RGB')


def _persist_square_map_data(
    output_dir: Path,
    palette_list: Sequence[int],
    base_indices: np.ndarray,
    square_mean_map: np.ndarray,
    weighted_map: np.ndarray,
    calc_mask: np.ndarray,
    weighted_mask: np.ndarray,
) -> None:
    """
    Cache square-map arrays for fast recoloring.
    """
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    palette_array = np.array(palette_list, dtype=np.uint8).reshape(256, 3)
    np.savez_compressed(
        cache_path,
        square_mean=square_mean_map.astype(np.float32, copy=False),
        square_weighted=weighted_map.astype(np.float32, copy=False),
        calc_mask=calc_mask.astype(bool, copy=False),
        weighted_mask=weighted_mask.astype(bool, copy=False),
        base_indices=base_indices.astype(np.uint8, copy=False),
        palette=palette_array,
    )


def recolor_saved_sum_maps(
    output_dir: Path,
    override_colors: Optional[Sequence[str]] = None,
    scheme: Optional[str] = None,
) -> List[Dict[str, str]]:
    """
    Reload cached square-map arrays and regenerate PNGs with updated colors.
    """
    print(f"[recolor_saved_sum_maps] 호출됨")
    print(f"  output_dir: {output_dir}")
    print(f"  override_colors: {override_colors}")

    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    print(f"  cache_path: {cache_path}")
    print(f"  cache_path.exists(): {cache_path.exists()}")

    if not cache_path.exists():
        raise FileNotFoundError(f"Square map cache not found: {cache_path}")

    with np.load(cache_path) as data:
        square_mean_map = data["square_mean"]
        weighted_map = data["square_weighted"]
        calc_mask = data["calc_mask"].astype(bool)
        weighted_mask = data["weighted_mask"].astype(bool)
        base_indices = data["base_indices"].astype(np.uint8)
        palette_array = data["palette"].astype(np.uint8)

    palette_list = palette_array.reshape(-1).tolist()
    settings = load_composite_color_settings(scheme)
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

    color_stops = np.array([_hex_to_rgb_tuple(c) for c in colors_to_use], dtype=np.float32)

    variants = [
        ("square_average.png", "square_mean", "Composite SqMean", square_mean_map, calc_mask),
        ("square_weighted_average.png", "weighted_square_mean", "Composite Weighted SqMean", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=data_map,
            mask=mask,
            palette_list=palette_list,
            quantiles=settings.quantiles,
            color_stops=color_stops,
        )
        img.save(sum_map_path, format='PNG', optimize=False)
        rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": filename,
        })

    print(f"[recolor_saved_sum_maps] outputs: {outputs}")
    print(f"[recolor_saved_sum_maps] outputs 개수: {len(outputs)}")
    return outputs



def _save_sum_map_variants(
    all_indices: np.ndarray,
    output_dir: Path,
    palette_list: Optional[Sequence[int]] = None,
    invalid_mask: Optional[np.ndarray] = None,
    base_indices: Optional[np.ndarray] = None,
    idx_8_mask: Optional[np.ndarray] = None,
    scheme: Optional[str] = None,
) -> List[Dict[str, str]]:
    if all_indices.ndim != 3:
        raise ValueError("all_indices must be (N, H, W)")
    if all_indices.shape[0] == 0:
        return []

    float_indices = all_indices.astype(np.float32)
    valid_mask = (all_indices >= 0) & (all_indices <= 7)
    counts = valid_mask.sum(axis=0).astype(np.float32)
    calc_mask = counts > 0
    weighted_mask = calc_mask.copy()

    # 인덱스 8 포인트와 invalid 포인트 제외
    if idx_8_mask is not None:
        calc_mask &= ~idx_8_mask
        weighted_mask &= ~idx_8_mask
    if invalid_mask is not None:
        calc_mask &= ~invalid_mask
        weighted_mask &= ~invalid_mask

    valid_values = np.where(valid_mask, float_indices, 0.0)
    squared_values = np.square(valid_values, dtype=np.float32)
    square_sums = np.sum(squared_values, axis=0, dtype=np.float32)

    square_mean_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        square_mean_map[calc_mask] = square_sums[calc_mask] / counts[calc_mask]

    weights = np.where(valid_mask, np.maximum(valid_values, 1.0), 0.0)
    weight_sum = np.sum(weights, axis=0, dtype=np.float32)
    weighted_map = np.zeros_like(square_sums, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        weighted_map[weighted_mask] = square_sums[weighted_mask] / weight_sum[weighted_mask]

    # 디버그 로그
    print(f"[SQUARE MAP DEBUG]")
    print(f"  calc_mask points: {calc_mask.sum()}")
    print(f"  weighted_mask points: {weighted_mask.sum()}")
    print(f"  calc_mask == weighted_mask: {np.array_equal(calc_mask, weighted_mask)}")
    if calc_mask.any():
        print(f"  square_mean range: [{square_mean_map[calc_mask].min():.2f}, {square_mean_map[calc_mask].max():.2f}]")
    if weighted_mask.any():
        print(f"  weighted_map range: [{weighted_map[weighted_mask].min():.2f}, {weighted_map[weighted_mask].max():.2f}]")
        print(f"  weighted_map has nan/inf: {np.isnan(weighted_map[weighted_mask]).any()} / {np.isinf(weighted_map[weighted_mask]).any()}")

    if base_indices is None:
        median_map = np.median(float_indices, axis=0)
        base_indices = np.clip(np.rint(median_map), 0, 8).astype(np.uint8)  # 0-8 범위
    base_indices = base_indices.copy()
    if invalid_mask is not None:
        base_indices[invalid_mask] = 31

    palette = _build_palette_list(palette_list)
    settings = load_composite_color_settings(scheme)
    color_stops = np.array([_hex_to_rgb_tuple(c) for c in settings.colors], dtype=np.float32)

    _persist_square_map_data(
        output_dir=output_dir,
        palette_list=palette,
        base_indices=base_indices,
        square_mean_map=square_mean_map,
        weighted_map=weighted_map,
        calc_mask=calc_mask,
        weighted_mask=weighted_mask,
    )

    variants = [
        ("square_average.png", "square_mean", "Composite SqMean", square_mean_map, calc_mask),
        ("square_weighted_average.png", "weighted_square_mean", "Composite Weighted SqMean", weighted_map, weighted_mask),
    ]

    outputs: List[Dict[str, str]] = []
    for filename, variant_type, display_name, data_map, mask in variants:
        sum_map_path = output_dir / filename
        print(f"[SAVE] Saving {filename}, mask points: {mask.sum()}")
        img = _render_sum_map_image(
            base_indices=base_indices,
            value_map=data_map,
            mask=mask,
            palette_list=palette,
            quantiles=settings.quantiles,
            color_stops=color_stops,
        )
        img.save(sum_map_path, format='PNG', optimize=False)
        rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()
        print(f"[SAVE] Saved to: {rel_path}")
        outputs.append({
            "path": rel_path,
            "type": variant_type,
            "display_name": display_name,
            "filename": filename,
        })

    print(f"[SAVE] Total outputs: {len(outputs)}")
    return outputs
def create_composite_heatmaps(
    image_paths: List[str],
    indices: List[int] = None,
    create_sum: bool = True,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    batch_size: Optional[int] = None,
    scheme: Optional[str] = None
) -> Dict[str, Any]:
    start_time = time.time()
    if not image_paths:
        raise ValueError("image_paths is empty")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None

    palette_list = _build_palette_list(source_palette)
    if scheme:
        legends = load_color_legends()
        scheme_data = legends.get(scheme)
        if scheme_data:
            palette_bytes = _scheme_to_palette_bytes(scheme_data)
            limit = min(len(palette_bytes) // 3, 256)
            for i in range(limit):
                palette_list[i * 3:(i + 1) * 3] = palette_bytes[i * 3:(i + 1) * 3]
    palette_list[31 * 3:31 * 3 + 3] = [255, 255, 255]

    if indices is None:
        indices = list(range(8))

    # 1단계: 모든 raw indices 수집
    raw_indices_list: List[np.ndarray] = []
    processed_count = 0

    for img_path in image_paths:
        try:
            full_path = IMAGES_ROOT / img_path
            if not full_path.exists():
                continue
            with Image.open(full_path) as img:
                if img.size != (width, height):
                    img = img.resize((width, height), Image.NEAREST)
                if img.mode == 'P':
                    raw_indices = np.array(img, dtype=np.int16)
                else:
                    raw_indices = np.array(img.convert('L'), dtype=np.int16) // 32
                raw_indices_list.append(raw_indices)
                processed_count += 1
        except Exception as exc:
            print(f"[Composite] image load failed: {img_path}, {exc}")
            continue

    if not raw_indices_list:
        raise ValueError("처리할 이미지가 없습니다.")

    # 2단계: 인덱스 8-13 처리 (1개라도 있으면 인덱스 8로 변경)
    stacked_raw = np.stack(raw_indices_list, axis=0)  # (N, H, W)
    idx_8_13_mask = (stacked_raw >= 8) & (stacked_raw <= 13)  # (N, H, W)
    idx_8_13_any = idx_8_13_mask.any(axis=0)  # (H, W) - 1개라도 있으면 True

    # 해당 픽셀을 모든 이미지에서 8로 변경
    for i in range(len(raw_indices_list)):
        raw_indices_list[i][idx_8_13_any] = 8

    # 3단계: invalid mask 생성 및 clipping
    # 인덱스 8은 유효, 9 이상만 invalid (31로)
    invalid_mask = np.zeros((height, width), dtype=bool)
    all_indices_list: List[np.ndarray] = []

    for raw_indices in raw_indices_list:
        invalid_mask |= (raw_indices > 8)  # 9 이상만 invalid
        clipped = np.clip(raw_indices, 0, 8).astype(np.uint8)  # 0-8 범위
        all_indices_list.append(clipped)

    stacked_indices = np.stack(all_indices_list, axis=0)
    float_indices = stacked_indices.astype(np.float32)
    median_map = np.median(float_indices, axis=0)
    median_indices = np.clip(np.rint(median_map), 0, 8).astype(np.uint8)  # 0-8 범위
    base_indices = median_indices.copy()
    base_indices[idx_8_13_any] = 8  # 인덱스 8-13이 한 번이라도 나온 포인트는 8로
    base_indices[invalid_mask] = 31

    heatmaps: List[Dict[str, Any]] = []
    palette_bytes = palette_list[:]
    for idx in indices:
        if idx >= 8:
            continue
        result = np.full((height, width), 31, dtype=np.uint8)
        valid_mask = (~invalid_mask) & (median_indices == idx)
        result[valid_mask] = idx
        # 인덱스 8-13이 한 번이라도 나온 포인트는 8로 설정
        result[idx_8_13_any & ~invalid_mask] = 8
        heatmap_path = output_dir / f"Grade_{idx}.png"
        heatmap_img = Image.fromarray(result, mode='P')
        heatmap_img.putpalette(palette_bytes)
        heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=0)
        rel_path = heatmap_path.relative_to(IMAGES_ROOT).as_posix()
        total_pixels = width * height
        pixel_count = int(np.sum(valid_mask))
        percentage = round(pixel_count / total_pixels * 100, 2) if total_pixels else 0
        heatmaps.append({
            "index": idx,
            "path": rel_path,
            "pixel_count": pixel_count,
            "max_count": processed_count,
            "percentage": percentage,
        })

    sum_map_entries: List[Dict[str, str]] = []
    sum_map_rel_path = None
    if create_sum:
        sum_map_entries = _save_sum_map_variants(
            stacked_indices,
            output_dir,
            palette_bytes,
            invalid_mask=invalid_mask,
            base_indices=base_indices,
            idx_8_mask=idx_8_13_any,
            scheme=scheme,
        )
        print(f"[API] sum_map_entries after _save_sum_map_variants: {sum_map_entries}")
        print(f"[API] sum_map_entries length: {len(sum_map_entries)}")
        print(f"[API] sum_map_entries bool: {bool(sum_map_entries)}")
        if sum_map_entries:
            sum_map_rel_path = sum_map_entries[0]["path"]

    processing_time = time.time() - start_time
    result = {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "heatmaps": heatmaps,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2),
    }
    if sum_map_rel_path:
        result["sum_map_path"] = sum_map_rel_path
    if sum_map_entries:
        result["sum_maps"] = sum_map_entries
    print(f"[API] Final result keys: {result.keys()}")
    print(f"[API] 'sum_maps' in result: {'sum_maps' in result}")
    return result
def create_palette_overlay(
    image_paths: List[str],
    focus_index: Optional[int] = 3,
    highlight_threshold: int = 8,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None
) -> Dict[str, Any]:
    """
    지정된 팔레트 인덱스와 고인덱스만 빠르게 합성하는 경량 모드.
    - focus_index: 관심 팔레트 인덱스 (None이면 저인덱스 무시)
    - highlight_threshold: 이 값 이상인 인덱스는 원본 색으로 유지
    """
    start_time = time.time()
    if not image_paths:
        raise ValueError("image_paths is empty")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

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
    overlay_path = output_dir / f"palette_focus_{focus_index if focus_index is not None else 'none'}.png"
    overlay_img.save(overlay_path)

    return {
        "mode": "palette",
        "output_dir": overlay_path.parent.relative_to(IMAGES_ROOT).as_posix(),
        "overlay_path": overlay_path.relative_to(IMAGES_ROOT).as_posix(),
        "focus_index": focus_index,
        "highlight_threshold": highlight_threshold,
        "source_images": processed_count,
        "processing_time": round(time.time() - start_time, 2)
    }


def create_sum_map(
    image_paths: List[str],
    scheme: Optional[str] = None,
) -> Dict[str, Any]:
    start_time = time.time()
    if not image_paths:
        raise ValueError("이미지 목록이 비어 있습니다.")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None

    palette_list = _build_palette_list(source_palette)
    palette_list[31 * 3:31 * 3 + 3] = [255, 255, 255]

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
                if img.mode == 'P':
                    raw_indices = np.array(img, dtype=np.int16)
                else:
                    raw_indices = np.array(img.convert('L'), dtype=np.int16) // 32
                raw_indices_list.append(raw_indices)
                processed_count += 1
        except Exception as exc:
            print(f"[SUM_MAP] image load failed: {img_path}, {exc}")
            continue

    if not raw_indices_list:
        raise ValueError("처리할 이미지가 없습니다.")

    # 2단계: 인덱스 8-13 처리 (1개라도 있으면 인덱스 8로 변경)
    stacked_raw = np.stack(raw_indices_list, axis=0)  # (N, H, W)
    idx_8_13_mask = (stacked_raw >= 8) & (stacked_raw <= 13)  # (N, H, W)
    idx_8_13_any = idx_8_13_mask.any(axis=0)  # (H, W) - 1개라도 있으면 True

    # 해당 픽셀을 모든 이미지에서 8로 변경
    for i in range(len(raw_indices_list)):
        raw_indices_list[i][idx_8_13_any] = 8

    # 3단계: invalid mask 생성 및 clipping
    # 인덱스 8은 유효, 9 이상만 invalid (31로)
    invalid_mask = np.zeros((height, width), dtype=bool)
    all_indices_list = []

    for raw_indices in raw_indices_list:
        invalid_mask |= (raw_indices > 8)  # 9 이상만 invalid
        clipped = np.clip(raw_indices, 0, 8).astype(np.uint8)  # 0-8 범위
        all_indices_list.append(clipped)

    stacked_indices = np.stack(all_indices_list, axis=0)
    float_indices = stacked_indices.astype(np.float32)
    median_map = np.median(float_indices, axis=0)
    base_indices = np.clip(np.rint(median_map), 0, 8).astype(np.uint8)  # 0-8 범위
    base_indices[idx_8_13_any] = 8  # 인덱스 8-13이 한 번이라도 나온 포인트는 8로
    base_indices[invalid_mask] = 31

    entries = _save_sum_map_variants(
        stacked_indices,
        output_dir,
        palette_list,
        invalid_mask=invalid_mask,
        base_indices=base_indices,
        idx_8_mask=idx_8_13_any,
        scheme=scheme,
    )
    if not entries:
        raise RuntimeError("Sum Map 생성을 완료하지 못했습니다.")

    primary = entries[0]["path"]
    processing_time = time.time() - start_time
    return {
        "sum_map_path": primary,
        "sum_maps": entries,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2),
    }
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
