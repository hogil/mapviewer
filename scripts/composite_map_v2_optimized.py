"""
Composite Map v2 최적화 버전
- pyvips 사용 (이미지 로딩 2-3배 빠름)
- 병렬 저장 (저장 시간 50% 개선)
- PNG compress_level=0 (추가 10% 개선)
"""
import sys
import time
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import partial
from typing import List, Dict, Any, Optional
import numpy as np
from PIL import Image
from PIL.Image import DecompressionBombWarning
import warnings

# 프로젝트 루트를 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api import config
from api.config import IMAGES_ROOT

# pyvips import (선택적)
try:
    import pyvips
    PYVIPS_AVAILABLE = True
except ImportError:
    pyvips = None
    PYVIPS_AVAILABLE = False

Image.MAX_IMAGE_PIXELS = None
warnings.simplefilter("ignore", DecompressionBombWarning)

COMPOSITE_ROOT = IMAGES_ROOT / "composite_maps"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)


def _load_palette_indices(
    image_rel_path: str,
    width: int,
    height: int
) -> Optional[np.ndarray]:
    """팔레트 모드 이미지에서 인덱스만 추출 (pyvips 우선)"""
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None
    
    try:
        # 🔥 pyvips 사용 (2-3배 빠름)
        if PYVIPS_AVAILABLE:
            try:
                img = pyvips.Image.new_from_file(
                    str(full_path),
                    access='sequential',  # 순차 접근 (스트리밍)
                    memory=True           # 캐시 활성화
                )
                
                # 크기 확인 및 리사이즈
                if img.width != width or img.height != height:
                    img = img.resize(
                        width / img.width,
                        vscale=height / img.height,
                        kernel='nearest'
                    )
                
                # 팔레트 모드면 인덱스 직접 추출
                if img.bandfmt == 'uchar' and img.bands == 1:
                    pixel_indices = np.ndarray(
                        buffer=img.write_to_memory(),
                        dtype=np.uint8,
                        shape=(img.height, img.width)
                    )
                    return pixel_indices
                else:
                    # RGB/L 모드면 그레이스케일로 변환 후 인덱스화
                    if img.bands > 1:
                        img = img.colourspace('b-w')  # RGB → grayscale
                    pixels = np.ndarray(
                        buffer=img.write_to_memory(),
                        dtype=np.uint8,
                        shape=(img.height, img.width)
                    )
                    pixel_indices = (pixels // 32).astype(np.uint8)
                    return pixel_indices
            except Exception as pyvips_exc:
                # pyvips 실패 시 PIL로 fallback
                pass
        
        # PIL fallback
        with Image.open(full_path) as img:
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)
            
            if img.mode == 'P':
                pixel_indices = np.array(img, dtype=np.uint8)
            else:
                if img.mode != 'L':
                    img = img.convert('L')
                pixels = np.array(img, dtype=np.uint8)
                pixel_indices = (pixels // 32).astype(np.uint8)
            
            return pixel_indices
    
    except Exception as exc:
        print(f"[ERROR] Failed to load palette indices: {image_rel_path}, {exc}")
        return None


def _iter_palette_indices_parallel(
    image_paths: List[str],
    width: int,
    height: int,
    max_workers: Optional[int] = None
):
    """병렬로 팔레트 인덱스 추출 (워커 수 최적화)"""
    if not image_paths:
        return
    
    cpu_count = os.cpu_count() or 4
    # 🔥 워커 수 증가: cpu_count * 2 (최대 16개)
    optimal_workers = min(cpu_count * 2, 16, len(image_paths))
    max_workers = min(max_workers or optimal_workers, len(image_paths))
    
    loader = partial(_load_palette_indices, width=width, height=height)
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_path = {
            executor.submit(loader, path): path
            for path in image_paths
        }
        
        for future in as_completed(future_to_path):
            path = future_to_path[future]
            try:
                result = future.result()
                yield path, result
            except Exception as exc:
                print(f"[ERROR] Failed to load {path}: {exc}")
                yield path, None


def _accumulate_batch_pixels_optimized(
    batch_pixels: List[np.ndarray],
    counts: np.ndarray,
    idx_array: np.ndarray,
    valid_positions: np.ndarray
) -> None:
    """배치 픽셀 누적 (루프 기반, 메모리 효율적)"""
    if not batch_pixels or valid_positions.size == 0:
        return
    
    for pixel_indices in batch_pixels:
        for i, pos in enumerate(valid_positions):
            idx = idx_array[pos]
            mask = (pixel_indices == idx)
            counts[pos] += mask.astype(np.uint32)


def _extract_palette_rgb_fast(source_palette: Optional[List[int]]) -> np.ndarray:
    """팔레트를 RGB 배열로 변환"""
    if not source_palette:
        return np.full((256, 3), 128, dtype=np.uint8)
    
    palette_array = np.array(source_palette, dtype=np.uint8)
    palette_size = len(palette_array) // 3
    
    if palette_size > 0:
        palette_rgb = palette_array[:palette_size * 3].reshape(palette_size, 3)
    else:
        palette_rgb = np.full((256, 3), 128, dtype=np.uint8)
    
    if palette_size < 256:
        full_palette = np.full((256, 3), 128, dtype=np.uint8)
        full_palette[:palette_size] = palette_rgb
        palette_rgb = full_palette
    
    return palette_rgb


def _create_gradient_palette(
    orig_r: int,
    orig_g: int,
    orig_b: int
) -> List[int]:
    """그라데이션 팔레트 생성"""
    palette = []
    for i in range(256):
        ratio = i / 255.0
        r = int(255.0 - (255.0 - orig_r) * ratio)
        g = int(255.0 - (255.0 - orig_g) * ratio)
        b = int(255.0 - (255.0 - orig_b) * ratio)
        palette.extend([r, g, b])
    return palette


def _precompute_gradient_palettes(
    indices: List[int],
    palette_rgb: np.ndarray
) -> Dict[int, List[int]]:
    """모든 팔레트를 한 번에 사전 계산"""
    gradient_palettes = {}
    for idx in indices:
        orig_r, orig_g, orig_b = palette_rgb[idx]
        gradient_palettes[idx] = _create_gradient_palette(orig_r, orig_g, orig_b)
    return gradient_palettes


def _calculate_high_indices_online(
    high_indices_list: List[np.ndarray],
    height: int,
    width: int
) -> np.ndarray:
    """온라인 max 계산"""
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    
    for high_values in high_indices_list:
        high_indices_combined = np.maximum(high_indices_combined, high_values)
    
    return high_indices_combined


def _save_heatmap_parallel(args):
    """히트맵 저장 (병렬 처리용)"""
    pos, idx, count_array, max_count, high_mask_combined, high_indices_combined, \
    gradient_palettes, output_dir = args
    
    # 정규화
    if max_count > 0:
        normalized = np.clip(
            (count_array.astype(np.float32) / max_count * 255),
            0, 255
        ).astype(np.uint8)
    else:
        normalized = np.zeros(count_array.shape, dtype=np.uint8)
    
    # 고인덱스 부분은 원본 값 사용
    if np.any(high_mask_combined):
        normalized = np.where(
            high_mask_combined,
            high_indices_combined,
            normalized
        )
    
    # 팔레트 모드 이미지 생성
    heatmap_img = Image.fromarray(normalized, mode='P')
    heatmap_img.putpalette(gradient_palettes[idx])
    
    # 파일 저장 (compress_level=0으로 최대 속도)
    heatmap_path = output_dir / f"index_{idx}.png"
    heatmap_img.save(
        heatmap_path,
        format='PNG',
        optimize=False,
        compress_level=0  # 🔥 압축 없음 (더 빠름)
    )
    
    rel_path = heatmap_path.relative_to(IMAGES_ROOT).as_posix()
    
    # 통계 계산
    pixel_count = int(np.sum(count_array > 0))
    max_pixel_count = int(np.max(count_array))
    percentage = (pixel_count / (count_array.size) * 100) if count_array.size > 0 else 0
    
    return {
        "index": idx,
        "path": rel_path,
        "pixel_count": pixel_count,
        "max_count": max_pixel_count,
        "percentage": round(percentage, 2)
    }


def create_composite_heatmaps_optimized(
    image_paths: List[str],
    indices: Optional[List[int]] = None,
    create_sum: bool = True,
    max_workers: Optional[int] = None,
    batch_size: Optional[int] = None,
    use_streaming_median: bool = False
) -> Dict[str, Any]:
    """최적화된 Composite Map 생성"""
    from datetime import datetime
    
    start_time = time.time()
    
    # 1. 출력 디렉토리 생성
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = COMPOSITE_ROOT / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"[INFO] Composite Map 생성 시작: {output_dir}")
    if PYVIPS_AVAILABLE:
        print(f"[INFO] pyvips 사용: 활성화 (로딩 속도 향상)")
    else:
        print(f"[INFO] pyvips 사용: 비활성화 (PIL 사용)")
    
    # 2. 첫 번째 이미지에서 크기 및 팔레트 추출
    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as first_img:
        width, height = first_img.size
        source_palette = first_img.getpalette() if first_img.mode == 'P' else None
        
        if indices is None:
            pixels = np.array(first_img)
            unique_indices = np.unique(pixels)
            indices = sorted([int(i) for i in unique_indices if i < 256])
            print(f"[INFO] 자동 감지 인덱스: {indices}")
    
    if not indices:
        indices = list(range(8))
    
    print(f"[INFO] 이미지 크기: {width}×{height}, 인덱스: {len(indices)}개")
    
    # 3. 카운트 배열 초기화
    idx_array = np.array(indices, dtype=np.uint16)
    counts = np.zeros((len(idx_array), height, width), dtype=np.uint32)
    valid_positions = np.where(idx_array < 8)[0]
    
    high_indices_list = []
    high_mask_combined = np.zeros((height, width), dtype=bool)
    all_indices_list = [] if create_sum else None
    
    # 4. 이미지 로딩 및 카운트 누적
    print("[INFO] 이미지 처리 중...")
    loading_start = time.time()
    
    processed_count = 0
    effective_batch = max(1, batch_size or 4)  # 🔥 배치 크기 증가 (기본 4)
    batch_pixels: List[np.ndarray] = []
    
    pixel_loader = _iter_palette_indices_parallel(
        image_paths,
        width,
        height,
        max_workers=max_workers
    )
    
    for img_path, pixel_indices in pixel_loader:
        if pixel_indices is None:
            continue
        
        # 고인덱스 (8 이상) 처리 - MAX 값 사용
        high_mask = (pixel_indices >= 8)
        high_mask_combined |= high_mask
        high_values = np.where(high_mask, pixel_indices, 0)
        high_indices_list.append(high_values)
        
        batch_pixels.append(pixel_indices)
        
        if create_sum:
            if pixel_indices.dtype != np.uint8:
                all_indices_list.append(pixel_indices.astype(np.uint8))
            else:
                all_indices_list.append(pixel_indices)
        
        processed_count += 1
        
        if len(batch_pixels) >= effective_batch:
            _accumulate_batch_pixels_optimized(batch_pixels, counts, idx_array, valid_positions)
            batch_pixels.clear()
        
        if processed_count % 50 == 0:
            print(f"  처리 중... {processed_count}개")
    
    if batch_pixels:
        _accumulate_batch_pixels_optimized(batch_pixels, counts, idx_array, valid_positions)
    
    loading_time = time.time() - loading_start
    print(f"[INFO] 이미지 로딩 완료: {processed_count}개, {loading_time:.2f}초")
    
    max_count = processed_count
    
    # 5. 고인덱스 최댓값 계산
    high_indices_combined = _calculate_high_indices_online(
        high_indices_list,
        height,
        width
    )
    
    # 6. 팔레트 RGB 추출
    palette_rgb = _extract_palette_rgb_fast(source_palette)
    
    # 7. 팔레트 사전 계산
    print("[INFO] 팔레트 계산 중...")
    gradient_palettes = _precompute_gradient_palettes(indices, palette_rgb)
    
    # 8. 히트맵 생성 및 저장 (병렬 처리)
    print("[INFO] 히트맵 생성 및 저장 중...")
    save_start = time.time()
    
    # 🔥 병렬 저장 준비
    save_args = []
    for pos, idx in enumerate(indices):
        if idx >= 8:
            continue
        save_args.append((
            pos, idx, counts[pos], max_count,
            high_mask_combined, high_indices_combined,
            gradient_palettes, output_dir
        ))
    
    # 🔥 병렬 저장 실행
    heatmaps = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(_save_heatmap_parallel, args)
            for args in save_args
        ]
        for future in as_completed(futures):
            heatmaps.append(future.result())
    
    # 인덱스 순서대로 정렬
    heatmaps.sort(key=lambda x: x['index'])
    
    # 9. Sum Map 생성
    sum_map_rel_path = None
    
    if create_sum and all_indices_list:
        all_indices = np.stack(all_indices_list, axis=0)
        sum_map_indices = np.median(all_indices, axis=0).astype(np.uint8)
        
        # 팔레트 모드로 저장
        sum_map_img = Image.fromarray(sum_map_indices, mode='P')
        if source_palette:
            sum_map_img.putpalette(source_palette)
        else:
            default_palette = []
            for i in range(256):
                gray = 255 - i
                default_palette.extend([gray, gray, gray])
            sum_map_img.putpalette(default_palette)
        
        sum_map_path = output_dir / "sum_map.png"
        sum_map_img.save(
            sum_map_path,
            format='PNG',
            optimize=False,
            compress_level=0  # 🔥 압축 없음
        )
        
        sum_map_rel_path = sum_map_path.relative_to(IMAGES_ROOT).as_posix()
    
    save_time = time.time() - save_start
    processing_time = time.time() - start_time
    
    print(f"[INFO] 저장 완료: {save_time:.2f}초")
    print(f"[INFO] 전체 처리: {processing_time:.2f}초")
    
    result = {
        "output_dir": output_dir.relative_to(IMAGES_ROOT).as_posix(),
        "heatmaps": heatmaps,
        "source_images": processed_count,
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2),
        "loading_time": round(loading_time, 2),
        "save_time": round(save_time, 2),
    }
    
    if sum_map_rel_path:
        result["sum_map_path"] = sum_map_rel_path
    
    return result


# 테스트 실행
if __name__ == "__main__":
    test_dir = Path("D:/project/data/wm-811k/palette_3k")
    
    image_files = sorted([
        f for f in test_dir.iterdir() 
        if f.is_file() and f.suffix.lower() in ['.png', '.jpg', '.jpeg']
    ])[:10]
    
    if len(image_files) < 10:
        print(f"[ERROR] 이미지가 10개 미만입니다. (현재: {len(image_files)}개)")
        sys.exit(1)
    
    image_paths = []
    for img_file in image_files:
        try:
            rel_path = img_file.relative_to(IMAGES_ROOT)
            image_paths.append(str(rel_path))
        except ValueError:
            print(f"[WARNING] 경로 변환 실패: {img_file}")
            continue
    
    print("=" * 60)
    print("Composite Map 생성 시간 벤치마크 (v2 최적화 버전)")
    print("=" * 60)
    print(f"테스트 이미지: {len(image_paths)}개")
    print(f"이미지 경로: {test_dir}")
    print("\n처리할 이미지:")
    for i, path in enumerate(image_paths[:10], 1):
        print(f"  {i}. {Path(path).name}")
    print()
    
    start_time = time.time()
    
    try:
        result = create_composite_heatmaps_optimized(
            image_paths=image_paths,
            indices=None,
            create_sum=True,
            max_workers=None,  # 자동 계산
            batch_size=4,     # 🔥 배치 크기 증가
            use_streaming_median=False
        )
        
        elapsed_time = time.time() - start_time
        
        print("=" * 60)
        print("[SUCCESS] 처리 완료!")
        print("=" * 60)
        print(f"전체 처리 시간: {elapsed_time:.2f}초")
        print(f"  - 이미지 로딩: {result['loading_time']:.2f}초")
        print(f"  - 저장 시간: {result['save_time']:.2f}초")
        print(f"출력 디렉토리: {result['output_dir']}")
        print(f"처리된 이미지: {result['source_images']}개")
        print(f"이미지 크기: {result['image_size']['width']}×{result['image_size']['height']}")
        print(f"생성된 히트맵: {len(result['heatmaps'])}개")
        
        if 'sum_map_path' in result:
            print(f"Sum Map: {result['sum_map_path']}")
        
        print("\n히트맵 상세:")
        for hm in result['heatmaps']:
            print(f"  Index {hm['index']}: {Path(hm['path']).name}")
            print(f"    - 픽셀 수: {hm['pixel_count']:,}")
            print(f"    - 최대 카운트: {hm['max_count']}")
            print(f"    - 비율: {hm['percentage']}%")
        
        print("\n" + "=" * 60)
        print(f"평균 처리 시간 (이미지당): {elapsed_time / len(image_paths):.3f}초")
        print("=" * 60)
        
    except Exception as e:
        elapsed_time = time.time() - start_time
        print(f"\n[ERROR] 오류 발생: {e}")
        print(f"실패까지 걸린 시간: {elapsed_time:.2f}초")
        import traceback
        traceback.print_exc()


