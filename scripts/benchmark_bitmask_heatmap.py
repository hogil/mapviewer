"""
비트마스크 기반 히트맵 생성 성능 평가
현재 방식(카운트 기반) vs 비트마스크 방식(Presence 기반) 비교
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
import warnings

# 프로젝트 루트를 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api import config
from api.config import IMAGES_ROOT

# pyvips import
try:
    import pyvips
    PYVIPS_AVAILABLE = True
except ImportError:
    pyvips = None
    PYVIPS_AVAILABLE = False

Image.MAX_IMAGE_PIXELS = None
warnings.simplefilter("ignore", Image.DecompressionBombWarning)

COMPOSITE_ROOT = IMAGES_ROOT / "composite_maps"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)


def load_pixel_indices(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """이미지에서 팔레트 인덱스 추출"""
    full_path = IMAGES_ROOT / image_rel_path
    if not full_path.exists():
        return None
    
    try:
        if PYVIPS_AVAILABLE:
            try:
                img = pyvips.Image.new_from_file(
                    str(full_path),
                    access='sequential',
                    memory=True
                )
                
                if img.width != width or img.height != height:
                    scale_x = width / img.width
                    scale_y = height / img.height
                    img = img.resize(scale_x, vscale=scale_y, kernel='nearest')
                
                if img.bandfmt == 'uchar' and img.bands == 1:
                    pixel_indices = np.ndarray(
                        buffer=img.write_to_memory(),
                        dtype=np.uint8,
                        shape=(img.height, img.width)
                    )
                    return np.ascontiguousarray(pixel_indices, dtype=np.uint8)
                else:
                    if img.bands > 1:
                        img = img.colourspace('b-w')
                    pixels = np.ndarray(
                        buffer=img.write_to_memory(),
                        dtype=np.uint8,
                        shape=(img.height, img.width)
                    )
                    pixel_indices = (pixels // 32).astype(np.uint8)
                    return np.ascontiguousarray(pixel_indices, dtype=np.uint8)
            except Exception:
                pass
        
        with Image.open(full_path) as img:
            if img.size != (width, height):
                img = img.resize((width, height), Image.NEAREST)
            if img.mode == 'P':
                pixel_indices = np.array(img, dtype=np.uint8)
            else:
                img_l = img.convert('L')
                pixels = np.array(img_l, dtype=np.uint8)
                pixel_indices = (pixels // 32).astype(np.uint8)
            return np.ascontiguousarray(pixel_indices, dtype=np.uint8)
    except Exception as exc:
        print(f"[ERROR] 이미지 로드 실패: {image_rel_path}, {exc}")
        return None


def process_current_method(image_paths: List[str], width: int, height: int) -> Dict[str, Any]:
    """현재 방식: 카운트 기반 히트맵"""
    start_time = time.time()
    
    indices = list(range(8))
    idx_array = np.array(indices, dtype=np.uint16)
    counts = np.zeros((len(idx_array), height, width), dtype=np.uint32)
    valid_positions = np.where(idx_array < 8)[0]
    
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    high_mask_combined = np.zeros((height, width), dtype=bool)
    
    loading_start = time.time()
    
    cpu_count = os.cpu_count() or 4
    optimal_workers = min(cpu_count * 2, 16, len(image_paths))
    worker_count = min(max(1, optimal_workers), len(image_paths))
    
    loader = partial(load_pixel_indices, width=width, height=height)
    processed_count = 0
    
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_path = {
            executor.submit(loader, path): path
            for path in image_paths
        }
        
        for future in as_completed(future_to_path):
            try:
                pixel_indices = future.result()
                if pixel_indices is None:
                    continue
                
                high_mask = (pixel_indices >= 8)
                high_mask_combined |= high_mask
                high_indices_combined = np.maximum(
                    high_indices_combined,
                    np.where(high_mask, pixel_indices, 0)
                )
                
                for i, pos in enumerate(valid_positions):
                    idx = idx_array[pos]
                    mask = (pixel_indices == idx)
                    counts[pos] += mask.astype(np.uint32)
                
                processed_count += 1
            except Exception as exc:
                print(f"[ERROR] 처리 실패: {exc}")
    
    loading_time = time.time() - loading_start
    
    # 히트맵 생성 시간 측정
    heatmap_start = time.time()
    max_count = processed_count
    
    # 히트맵 배열 생성 (실제 저장은 하지 않음)
    heatmap_arrays = {}
    for idx in range(8):
        if max_count > 0:
            normalized = np.clip(
                (counts[idx].astype(np.float32) / max_count * 255),
                0, 255
            ).astype(np.uint8)
        else:
            normalized = np.zeros((height, width), dtype=np.uint8)
        
        if np.any(high_mask_combined):
            normalized = np.where(high_mask_combined, high_indices_combined, normalized)
        
        heatmap_arrays[idx] = normalized
    
    heatmap_time = time.time() - heatmap_start
    processing_time = time.time() - start_time
    
    return {
        "method": "current",
        "processing_time": processing_time,
        "loading_time": loading_time,
        "heatmap_time": heatmap_time,
        "processed_count": processed_count,
        "counts": counts
    }


def process_bitmask_method(image_paths: List[str], width: int, height: int) -> Dict[str, Any]:
    """비트마스크 방식: Presence 기반 히트맵"""
    start_time = time.time()
    
    presence_map = np.zeros((height, width), dtype=np.uint8)
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    high_mask_combined = np.zeros((height, width), dtype=bool)
    
    loading_start = time.time()
    
    cpu_count = os.cpu_count() or 4
    optimal_workers = min(cpu_count * 2, 16, len(image_paths))
    worker_count = min(max(1, optimal_workers), len(image_paths))
    
    loader = partial(load_pixel_indices, width=width, height=height)
    processed_count = 0
    
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_path = {
            executor.submit(loader, path): path
            for path in image_paths
        }
        
        for future in as_completed(future_to_path):
            try:
                pixel_indices = future.result()
                if pixel_indices is None:
                    continue
                
                high_mask = (pixel_indices >= 8)
                high_mask_combined |= high_mask
                high_indices_combined = np.maximum(
                    high_indices_combined,
                    np.where(high_mask, pixel_indices, 0)
                )
                
                # 비트마스크 누적
                low_mask = (pixel_indices < 8)
                low_indices = pixel_indices[low_mask]
                bit_flags = np.zeros((height, width), dtype=np.uint8)
                bit_flags[low_mask] = (1 << low_indices).astype(np.uint8)
                presence_map |= bit_flags
                
                processed_count += 1
            except Exception as exc:
                print(f"[ERROR] 처리 실패: {exc}")
    
    loading_time = time.time() - loading_start
    
    # 히트맵 생성 시간 측정
    heatmap_start = time.time()
    
    heatmap_arrays = {}
    for idx in range(8):
        result = np.zeros((height, width), dtype=np.uint8)
        
        # 1. 인덱스 8 이상이 있는 픽셀: max 값 사용
        if np.any(high_mask_combined):
            result[high_mask_combined] = high_indices_combined[high_mask_combined]
        
        # 2. 인덱스 0-7만 있는 픽셀 처리
        low_only_mask = ~high_mask_combined
        
        if np.any(low_only_mask):
            target_bit = 1 << idx
            has_target = (presence_map & target_bit) != 0
            
            # 타겟 인덱스가 있으면 그 인덱스로
            low_only_pixels = low_only_mask & has_target
            result[low_only_pixels] = idx
            
            # 타겟 인덱스가 없으면 인덱스 31로
            low_only_no_target = low_only_mask & ~has_target
            result[low_only_no_target] = 31
        
        heatmap_arrays[idx] = result
    
    heatmap_time = time.time() - heatmap_start
    processing_time = time.time() - start_time
    
    return {
        "method": "bitmask",
        "processing_time": processing_time,
        "loading_time": loading_time,
        "heatmap_time": heatmap_time,
        "processed_count": processed_count,
        "presence_map": presence_map
    }


def run_benchmark(image_paths: List[str], limit: Optional[int] = None):
    """벤치마크 실행"""
    if limit:
        image_paths = image_paths[:limit]
    
    if not image_paths:
        print("[ERROR] 이미지가 없습니다.")
        return
    
    # 첫 번째 이미지로 크기 확인
    first_path = IMAGES_ROOT / image_paths[0]
    with Image.open(first_path) as img:
        width, height = img.size
    
    print("=" * 80)
    print("비트마스크 기반 히트맵 생성 성능 평가")
    print("=" * 80)
    print(f"테스트 이미지: {len(image_paths)}개")
    print(f"이미지 크기: {width}×{height} ({width*height:,} 픽셀)")
    print(f"CPU 코어 수: {os.cpu_count()}")
    print()
    
    results = {}
    
    # 1. 현재 방식
    print("[1/2] 현재 방식 (카운트 기반) 평가 중...")
    try:
        result_current = process_current_method(image_paths, width, height)
        results["current"] = result_current
        print(f"  [OK] 완료: {result_current['processing_time']:.2f}초")
        print(f"      - 로딩: {result_current['loading_time']:.2f}초")
        print(f"      - 히트맵 생성: {result_current['heatmap_time']:.2f}초")
    except Exception as e:
        print(f"  [ERROR] 실패: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    
    # 2. 비트마스크 방식
    print("[2/2] 비트마스크 방식 (Presence 기반) 평가 중...")
    try:
        result_bitmask = process_bitmask_method(image_paths, width, height)
        results["bitmask"] = result_bitmask
        print(f"  [OK] 완료: {result_bitmask['processing_time']:.2f}초")
        print(f"      - 로딩: {result_bitmask['loading_time']:.2f}초")
        print(f"      - 히트맵 생성: {result_bitmask['heatmap_time']:.2f}초")
    except Exception as e:
        print(f"  [ERROR] 실패: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    print("=" * 80)
    print("성능 비교 결과")
    print("=" * 80)
    
    if "current" in results and "bitmask" in results:
        curr = results["current"]
        bm = results["bitmask"]
        
        print(f"\n[현재 방식]")
        print(f"  전체 처리 시간: {curr['processing_time']:.2f}초")
        print(f"  이미지 로딩 시간: {curr['loading_time']:.2f}초")
        print(f"  히트맵 생성 시간: {curr['heatmap_time']:.2f}초")
        
        print(f"\n[비트마스크 방식]")
        print(f"  전체 처리 시간: {bm['processing_time']:.2f}초")
        print(f"  이미지 로딩 시간: {bm['loading_time']:.2f}초")
        print(f"  히트맵 생성 시간: {bm['heatmap_time']:.2f}초")
        
        # 성능 개선 계산
        total_speedup = curr['processing_time'] / bm['processing_time']
        heatmap_speedup = curr['heatmap_time'] / bm['heatmap_time'] if bm['heatmap_time'] > 0 else float('inf')
        
        print(f"\n[성능 개선]")
        print(f"  전체 처리 속도: {total_speedup:.2f}배")
        print(f"  히트맵 생성 속도: {heatmap_speedup:.2f}배")
        
        if total_speedup > 1.0:
            improvement = (1 - bm['processing_time'] / curr['processing_time']) * 100
            print(f"\n[OK] 비트마스크 방식이 {improvement:.1f}% 더 빠릅니다!")
        else:
            slowdown = (bm['processing_time'] / curr['processing_time'] - 1) * 100
            print(f"\n[WARN] 비트마스크 방식이 {slowdown:.1f}% 더 느립니다.")
    
    print()
    print("=" * 80)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="비트마스크 히트맵 성능 평가")
    parser.add_argument("--dir", type=str, help="이미지 디렉토리 경로")
    parser.add_argument("--limit", type=int, help="처리할 이미지 개수 제한")
    args = parser.parse_args()
    
    # 이미지 경로 수집
    if args.dir:
        test_dir = Path(args.dir)
    else:
        test_dir = Path("D:/project/data/wm-811k/palette_3k")
    
    if not test_dir.exists():
        print(f"[ERROR] 디렉토리가 없습니다: {test_dir}")
        sys.exit(1)
    
    image_files = sorted([
        f for f in test_dir.iterdir() 
        if f.is_file() and f.suffix.lower() in ['.png', '.jpg', '.jpeg']
    ])
    
    if not image_files:
        print(f"[ERROR] 이미지가 없습니다: {test_dir}")
        sys.exit(1)
    
    image_paths = []
    for img_file in image_files:
        try:
            rel_path = img_file.relative_to(IMAGES_ROOT)
            image_paths.append(str(rel_path))
        except ValueError:
            if img_file.is_relative_to(IMAGES_ROOT):
                rel_path = img_file.relative_to(IMAGES_ROOT)
                image_paths.append(str(rel_path))
            else:
                continue
    
    if not image_paths:
        print("[ERROR] 유효한 이미지 경로가 없습니다.")
        sys.exit(1)
    
    run_benchmark(image_paths, limit=args.limit)

