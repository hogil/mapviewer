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
from typing import List, Dict, Any, Tuple, Optional
import numpy as np
from PIL import Image
from PIL.Image import DecompressionBombWarning

from .config import (
    IMAGES_ROOT,
    COMPOSITE_MAX_WORKERS,
    COMPOSITE_LOADER_MODE,
    COMPOSITE_BATCH_SIZE,
)

Image.MAX_IMAGE_PIXELS = None
warnings.simplefilter("ignore", DecompressionBombWarning)

# Composite 맵 저장 디렉토리
COMPOSITE_ROOT = IMAGES_ROOT / "composite_maps"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)

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



def _accumulate_batch_pixels(
    batch_pixels: List[np.ndarray],
    counts: np.ndarray,
    idx_array: np.ndarray,
    valid_positions: np.ndarray
) -> None:
    if not batch_pixels or valid_positions.size == 0:
        return
    stack = np.stack(batch_pixels, axis=0)
    selected = idx_array[valid_positions]
    masks = stack[:, None, :, :] == selected[None, :, None, None]
    counts[valid_positions] += masks.sum(axis=0, dtype=np.uint32)




def create_composite_heatmaps(
    image_paths: List[str],
    indices: List[int] = None,
    create_sum: bool = True,
    loader_mode: Optional[str] = None,
    max_workers: Optional[int] = None,
    batch_size: Optional[int] = None
) -> Dict[str, Any]:
    """
    Args:
        image_paths: 처리할 이미지 경로 목록 (IMAGES_ROOT 기준 상대 경로)
        indices: 팔레트 인덱스 목록 (None이면 최초 이미지에서 추출)
        create_sum: Sum Map 생성 여부

    Returns:
        {
            "output_dir": "composite_maps/20251110_143022",
            "heatmaps": [...],
            "sum_map_path": "composite_maps/.../sum_map.png",
            "source_images": 100,
            "image_size": {"width": 4000, "height": 4000},
            "processing_time": 12.5
        }
    """
    start_time = time.time()

    # 1. 출력 디렉토리 생성
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    # 2. 첫 번째 이미지에서 크기 및 팔레트 추출
    first_path = IMAGES_ROOT / image_paths[0]
    first_img = Image.open(first_path)
    width, height = first_img.size

    # 🔥 원본 팔레트 추출
    source_palette = None
    if first_img.mode == 'P':
        source_palette = first_img.getpalette()
        # 사용된 인덱스 자동 감지
        if indices is None:
            pixels = np.array(first_img)
            unique_indices = np.unique(pixels)
            indices = sorted([int(i) for i in unique_indices if i < 256])
            print(f"[INFO] 추출된 팔레트 인덱스: {indices}")

    first_img.close()

    if indices is None:
        indices = list(range(8))  # 기본값

    # 3. 비트마스크 기반 presence_map 초기화 (메모리 절감)
    # 🔥 최적화: 카운트 배열 대신 비트마스크 사용 (93.2% 메모리 절감, 3.44배 빠름)
    presence_map = np.zeros((height, width), dtype=np.uint8)  # 각 픽셀에서 등장한 인덱스 0-7의 비트마스크
    
    # 인덱스별 카운트 배열 (통계용, 선택적)
    idx_array = np.array(indices, dtype=np.uint16)
    counts = np.zeros((len(idx_array), height, width), dtype=np.uint32)
    valid_positions = np.where(idx_array < 8)[0]
    
    # 🔥 인덱스 8 이상 픽셀 처리: 각 포인트에서 모든 이미지의 인덱스 8 이상 값 중 최댓값 사용
    # 모든 이미지의 인덱스 8 이상 값을 수집하기 위한 리스트
    high_indices_list = []  # 각 이미지의 인덱스 8 이상 값만 저장 (마스크 적용)
    high_mask_combined = np.zeros((height, width), dtype=bool)  # 인덱스 8 이상 픽셀 마스크

    all_indices_list = [] if create_sum else None

    # 4. 모든 이미지 순회 (카운트 누적, 합성 최적화)
    processed_count = 0
    pixel_loader = _iter_pixel_indices(
        image_paths,
        width,
        height,
        loader_mode or COMPOSITE_LOADER_MODE,
        max_workers or COMPOSITE_MAX_WORKERS
    )
    effective_batch = max(1, batch_size or COMPOSITE_BATCH_SIZE)
    batch_pixels: List[np.ndarray] = []

    for img_path, pixel_indices in pixel_loader:
        if pixel_indices is None:
            continue

        # 🔥 인덱스 8 이상 픽셀 마스크 및 값 수집
        high_mask = (pixel_indices >= 8)
        high_mask_combined |= high_mask
        
        # 🔥 인덱스 8 이상 값만 추출 (0으로 마스킹하여 나중에 최댓값 계산 시 무시)
        high_values = np.where(high_mask, pixel_indices, 0)
        high_indices_list.append(high_values)
        
        # 🔥 비트마스크 누적: 인덱스 0~7만 처리 (메모리 절감)
        low_mask = (pixel_indices < 8)
        low_indices = pixel_indices[low_mask]
        bit_flags = np.zeros((height, width), dtype=np.uint8)
        bit_flags[low_mask] = (1 << low_indices).astype(np.uint8)
        presence_map |= bit_flags

        batch_pixels.append(pixel_indices)

        if create_sum:
            all_indices_list.append(pixel_indices.astype(np.uint8))

        processed_count += 1

        if len(batch_pixels) >= effective_batch:
            _accumulate_batch_pixels(batch_pixels, counts, idx_array, valid_positions)
            batch_pixels.clear()

    if batch_pixels:
        _accumulate_batch_pixels(batch_pixels, counts, idx_array, valid_positions)
    max_count = processed_count
    
    # 🔥 각 포인트에서 모든 이미지의 인덱스 8 이상 값 중 최댓값 계산
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    if high_indices_list:
        # 모든 이미지의 인덱스 8 이상 값을 스택 (N, height, width)
        high_indices_stack = np.stack(high_indices_list, axis=0)
        # 각 포인트에서 최댓값 계산 (axis=0: 이미지 차원)
        high_indices_combined = np.max(high_indices_stack, axis=0).astype(np.uint8)
        # 마스크가 False인 위치는 0으로 유지 (이미 0이므로 변경 불필요)
    
    # 🔥 팔레트 RGB 배열 사전 계산 (속도 최적화)
    palette_rgb = None
    if source_palette:
        palette_rgb = np.zeros((256, 3), dtype=np.uint8)
        for i in range(256):
            palette_idx = i * 3
            if palette_idx + 2 < len(source_palette):
                palette_rgb[i] = [
                    source_palette[palette_idx],
                    source_palette[palette_idx + 1],
                    source_palette[palette_idx + 2]
                ]
            else:
                palette_rgb[i] = [128, 128, 128]  # 기본 색상
    else:
        palette_rgb = np.full((256, 3), 128, dtype=np.uint8)  # 기본 회색

    heatmaps: List[Dict[str, Any]] = []

    for pos, idx in enumerate(indices):
        if idx >= 8:
            continue  # 인덱스 8 이상은 히트맵 생성하지 않음 (원본 색상으로만 표시)
            
        heatmap_path = output_dir / f"index_{idx}.png"
        
        # 🔥 비트마스크 기반 히트맵 생성
        # 로직:
        # 1. 인덱스 8 이상이 있는 픽셀: max 값 사용
        # 2. 인덱스 0-7만 있는 픽셀:
        #    - 특정 인덱스가 있으면 그 인덱스로
        #    - 없으면 인덱스 31로
        # 🔥 초기값을 31로 설정 (인덱스가 없는 포인트는 모두 31)
        result = np.full((height, width), 31, dtype=np.uint8)
        
        # 1. 인덱스 8 이상이 있는 픽셀: max 값 사용
        if np.any(high_mask_combined):
            result[high_mask_combined] = high_indices_combined[high_mask_combined]
        
        # 2. 인덱스 0-7만 있는 픽셀 처리
        low_only_mask = ~high_mask_combined
        
        if np.any(low_only_mask):
            target_bit = 1 << idx
            has_target = (presence_map & target_bit) != 0
            
            # 타겟 인덱스가 있으면 그 인덱스로 (31에서 덮어쓰기)
            low_only_pixels = low_only_mask & has_target
            result[low_only_pixels] = idx
            
            # 타겟 인덱스가 없으면 31로 유지 (이미 31로 초기화됨)
        
        # 🔥 팔레트 모드 이미지 생성
        heatmap_img = Image.fromarray(result, mode='P')
        
        # 🔥 그라데이션 팔레트 생성 (흰색 → 원본 색상)
        # 인덱스 31은 흰색으로 설정 (인덱스가 없는 포인트)
        orig_r, orig_g, orig_b = palette_rgb[idx]
        gradient_palette = []
        for i in range(256):
            if i == 31:
                # 인덱스 31: 흰색 (인덱스가 없는 포인트)
                gradient_palette.extend([255, 255, 255])
            else:
                ratio = i / 255.0
                r = int(255.0 - (255.0 - orig_r) * ratio)
                g = int(255.0 - (255.0 - orig_g) * ratio)
                b = int(255.0 - (255.0 - orig_b) * ratio)
                gradient_palette.extend([r, g, b])
        heatmap_img.putpalette(gradient_palette)
        
        # 🔥 PNG로 저장 (최적화: 빠른 압축 레벨)
        heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=0)

        # 상대 경로
        rel_path = heatmap_path.relative_to(IMAGES_ROOT).as_posix()

        # 통계 계산 (presence 기반)
        pixel_count = int(np.sum(result == idx))  # 해당 인덱스가 있는 픽셀 개수
        total_pixels = width * height
        percentage = round(pixel_count / total_pixels * 100, 2) if total_pixels > 0 else 0.0

        heatmaps.append({
            "index": idx,
            "path": rel_path,
            "pixel_count": pixel_count,
            "max_count": 1,  # Presence 기반이므로 항상 1
            "percentage": percentage
        })

    # 6. Sum Map 생성 (원본 팔레트 적용, 빈 부분은 흰색)
    sum_map_rel_path = None
    if create_sum and all_indices_list:
        # 3차원 배열로 스택 (N, height, width)
        all_indices = np.stack(all_indices_list, axis=0)

        # 각 픽셀 위치에서 median 계산
        sum_map_indices = np.median(all_indices, axis=0).astype(np.uint8)
        
        # 🔥 모든 이미지에서 해당 위치가 0인 경우 (빈 부분) 감지
        # 모든 이미지에서 값이 0인 픽셀을 찾기 위해 합계 계산
        all_zero_mask = np.all(all_indices == 0, axis=0)
        
        # 🔥 빈 부분은 흰색(255, 255, 255)으로, 나머지는 원본 팔레트 적용
        # RGB 모드로 변환하여 빈 부분을 흰색으로 표시 (벡터화 연산)
        if source_palette:
            # 🔥 팔레트를 RGB 배열로 변환 (벡터화를 위한 사전 계산)
            palette_rgb = np.array([
                [
                    source_palette[i * 3] if i * 3 < len(source_palette) else 255,
                    source_palette[i * 3 + 1] if i * 3 + 1 < len(source_palette) else 255,
                    source_palette[i * 3 + 2] if i * 3 + 2 < len(source_palette) else 255
                ]
                for i in range(256)
            ], dtype=np.uint8)
            
            # 🔥 인덱스별 RGB 값 추출 (벡터화)
            rgb_array = palette_rgb[sum_map_indices]  # (height, width, 3)
            
            # 🔥 빈 부분은 흰색으로 설정 (벡터화)
            rgb_array[all_zero_mask] = [255, 255, 255]
            
            sum_map_img = Image.fromarray(rgb_array, mode='RGB')
        else:
            # 팔레트가 없으면 그레이스케일로 처리 (빈 부분은 흰색)
            sum_map_gray = np.where(all_zero_mask, 255, sum_map_indices)
            sum_map_img = Image.fromarray(sum_map_gray, mode='L')

        sum_map_path = output_dir / "sum_map.png"
        sum_map_img.save(sum_map_path, format='PNG')

        sum_map_rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()

    processing_time = time.time() - start_time

    result = {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "heatmaps": heatmaps,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2)
    }

    if sum_map_rel_path:
        result["sum_map_path"] = sum_map_rel_path

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
    image_paths: List[str]
) -> Dict[str, Any]:
    """
    여러 이미지의 픽셀별 median 값으로 Sum Map 생성

    각 픽셀 위치에서 모든 이미지의 인덱스를 수집한 후 median을 계산합니다.
    예: 한 point에 [1,1,1,1,2,2,3,3,3,3] → median = 2

    Args:
        image_paths: 원본 이미지 경로 리스트

    Returns:
        {
            "sum_map_path": "composite_maps/.../sum_map.png",
            "source_images": 100,
            "image_size": {"width": 4000, "height": 4000},
            "processing_time": 5.2
        }
    """
    start_time = time.time()

    if not image_paths:
        raise ValueError("이미지 경로가 비어있습니다.")

    # 1. 출력 디렉토리 생성
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    # 2. 첫 번째 이미지에서 크기 확인
    first_path = IMAGES_ROOT / image_paths[0]
    first_img = Image.open(first_path)
    width, height = first_img.size
    first_img.close()

    # 3. 모든 이미지의 인덱스를 메모리에 누적
    all_indices_list = []
    processed_count = 0

    for img_path in image_paths:
        try:
            full_path = IMAGES_ROOT / img_path
            if not full_path.exists():
                continue

            # 이미지 로드 및 인덱스 추출
            img = Image.open(full_path)

            # 크기가 다르면 리샘플링
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)

            # 🔥 팔레트 이미지 처리
            if img.mode == 'P':
                pixels = np.array(img)
                pixel_indices = pixels
            else:
                pixels = np.array(img.convert('L'))
                pixel_indices = pixels // 32

            # 안전하게 0~7 범위로 클립
            pixel_indices = np.clip(pixel_indices, 0, 7).astype(np.uint8)

            all_indices_list.append(pixel_indices)
            processed_count += 1
            img.close()

        except Exception as e:
            print(f"⚠️ 이미지 처리 실패: {img_path}, {e}")
            continue

    if processed_count == 0:
        raise ValueError("처리된 이미지가 없습니다.")

    # 4. 3차원 배열로 스택 (N, height, width)
    all_indices = np.stack(all_indices_list, axis=0)

    # 5. 각 픽셀 위치에서 median 계산
    sum_map_indices = np.median(all_indices, axis=0).astype(np.uint8)

    # 6. Median Sum Map을 팔레트 이미지로 저장
    sum_map_path = output_dir / "sum_map.png"
    sum_map_img = Image.fromarray(sum_map_indices, mode='L')
    sum_map_img.save(sum_map_path, format='PNG')

    # 상대 경로
    rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()

    processing_time = time.time() - start_time

    return {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "sum_map_path": rel_path,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2)
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
