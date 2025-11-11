"""
Composite Map 생성 모듈
여러 웨이퍼 맵의 인덱스별 빈도를 히트맵으로 시각화
"""
import time
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional
import numpy as np
from PIL import Image

from .config import IMAGES_ROOT

# Composite 맵 저장 디렉토리
COMPOSITE_ROOT = IMAGES_ROOT / "composite_maps"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)


def create_composite_heatmaps(
    image_paths: List[str],
    indices: List[int] = None,
    create_sum: bool = True
) -> Dict[str, Any]:
    """
    여러 이미지에서 인덱스별 히트맵 및 Sum Map 생성 (원본 팔레트 색상 사용)

    Args:
        image_paths: 원본 이미지 경로 리스트
        indices: 생성할 인덱스 리스트 (기본: None = 자동 감지)
        create_sum: Sum Map도 함께 생성할지 여부 (기본: True)

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
            print(f"📊 자동 감지된 인덱스: {indices}")

    first_img.close()

    if indices is None:
        indices = list(range(8))  # 기본값

    # 3. 인덱스별 마스크 배열 초기화 (바이너리)
    masks = {idx: np.zeros((height, width), dtype=np.bool_)
             for idx in indices}

    all_indices_list = [] if create_sum else None

    # 🔥 4. 단일 패스로 모든 이미지 처리
    processed_count = 0
    for img_path in image_paths:
        try:
            full_path = IMAGES_ROOT / img_path
            if not full_path.exists():
                continue

            img = Image.open(full_path)

            # 크기가 다르면 리샘플링
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)

            # 팔레트 이미지 처리
            if img.mode == 'P':
                pixel_indices = np.array(img)
            else:
                pixel_indices = np.array(img.convert('L'))

            # 인덱스별 마스크 누적 (OR 연산)
            for idx in indices:
                masks[idx] |= (pixel_indices == idx)

            # Sum Map용 인덱스 배열 수집
            if create_sum:
                all_indices_list.append(pixel_indices.astype(np.uint8))

            processed_count += 1
            img.close()

        except Exception as e:
            print(f"⚠️ 이미지 처리 실패: {img_path}, {e}")
            continue

    # 5. 인덱스별 히트맵 생성 (원본 팔레트 적용)
    heatmaps = []

    for idx in indices:
        heatmap_path = output_dir / f"index_{idx}.png"

        # 🔥 마스크를 팔레트 이미지로 변환
        heatmap_indices = np.where(masks[idx], idx, 255).astype(np.uint8)  # 255 = 투명/배경
        heatmap_img = Image.fromarray(heatmap_indices, mode='P')

        # 🔥 원본 팔레트 적용
        if source_palette:
            heatmap_img.putpalette(source_palette)

        heatmap_img.save(heatmap_path, format='PNG')

        # 상대 경로
        rel_path = heatmap_path.relative_to(IMAGES_ROOT).as_posix()

        # 통계 계산
        pixel_count = int(np.sum(masks[idx]))
        total_pixels = width * height
        percentage = round(pixel_count / total_pixels * 100, 2) if total_pixels > 0 else 0.0

        heatmaps.append({
            "index": idx,
            "path": rel_path,
            "pixel_count": pixel_count,
            "percentage": percentage
        })

    # 6. Sum Map 생성 (원본 팔레트 적용)
    sum_map_rel_path = None
    if create_sum and all_indices_list:
        # 3차원 배열로 스택 (N, height, width)
        all_indices = np.stack(all_indices_list, axis=0)

        # 각 픽셀 위치에서 median 계산
        sum_map_indices = np.median(all_indices, axis=0).astype(np.uint8)

        # Sum Map 저장 (원본 팔레트 적용)
        sum_map_path = output_dir / "sum_map.png"
        sum_map_img = Image.fromarray(sum_map_indices, mode='P')

        # 🔥 원본 팔레트 적용
        if source_palette:
            sum_map_img.putpalette(source_palette)

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
        counts[idx] += mask.astype(np.uint16)

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
