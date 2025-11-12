"""
7K 다중 이미지 처리 최적화 기법 평가 스크립트

제안된 최적화 기법:
1. 비트마스크 기반 presence_map (메모리 절감)
2. LUT(Lookup Table)를 사용한 중앙값 계산
3. 스트리밍 처리
4. 병렬 처리 최적화

프로젝트 코드는 변경하지 않고 평가만 수행
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


# =============================================================================
# 현재 방식 (기존 코드 기반)
# =============================================================================

def load_pixel_indices_current(image_rel_path: str, width: int, height: int) -> Optional[np.ndarray]:
    """현재 방식: pyvips 우선, PIL fallback"""
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


def process_current_method(
    image_paths: List[str],
    width: int,
    height: int,
    max_workers: Optional[int] = None
) -> Dict[str, Any]:
    """현재 방식: 카운트 배열 기반"""
    start_time = time.time()
    
    # 카운트 배열 초기화
    indices = list(range(8))
    idx_array = np.array(indices, dtype=np.uint16)
    counts = np.zeros((len(idx_array), height, width), dtype=np.uint32)
    valid_positions = np.where(idx_array < 8)[0]
    
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    high_mask_combined = np.zeros((height, width), dtype=bool)
    all_indices_list = []
    
    loading_start = time.time()
    
    # 병렬 로딩
    cpu_count = os.cpu_count() or 4
    optimal_workers = min(cpu_count * 2, 16, len(image_paths))
    worker_count = min(max_workers or optimal_workers, len(image_paths))
    
    loader = partial(load_pixel_indices_current, width=width, height=height)
    processed_count = 0
    
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_path = {
            executor.submit(loader, path): path
            for path in image_paths
        }
        
        for future in as_completed(future_to_path):
            path = future_to_path[future]
            try:
                pixel_indices = future.result()
                if pixel_indices is None:
                    continue
                
                # 고인덱스 처리
                high_mask = (pixel_indices >= 8)
                high_mask_combined |= high_mask
                high_indices_combined = np.maximum(
                    high_indices_combined,
                    np.where(high_mask, pixel_indices, 0)
                )
                
                # 카운트 누적
                for i, pos in enumerate(valid_positions):
                    idx = idx_array[pos]
                    mask = (pixel_indices == idx)
                    counts[pos] += mask.astype(np.uint32)
                
                all_indices_list.append(pixel_indices.astype(np.uint8))
                processed_count += 1
            except Exception as exc:
                print(f"[ERROR] 처리 실패: {path}, {exc}")
    
    loading_time = time.time() - loading_start
    
    # Sum Map 계산 (현재 방식: np.median)
    sum_start = time.time()
    if all_indices_list:
        all_indices = np.stack(all_indices_list, axis=0)
        sum_map_indices = np.median(all_indices, axis=0).astype(np.uint8)
    else:
        sum_map_indices = None
    sum_time = time.time() - sum_start
    
    processing_time = time.time() - start_time
    
    # 메모리 사용량 추정
    memory_estimate = (
        counts.nbytes +  # counts 배열
        (len(all_indices_list) * height * width if all_indices_list else 0) +  # all_indices_list
        high_indices_combined.nbytes +
        high_mask_combined.nbytes
    ) / (1024 * 1024)  # MB
    
    return {
        "method": "current",
        "processing_time": processing_time,
        "loading_time": loading_time,
        "sum_calculation_time": sum_time,
        "processed_count": processed_count,
        "memory_mb": memory_estimate,
        "counts": counts,
        "sum_map": sum_map_indices,
        "high_indices": high_indices_combined,
        "high_mask": high_mask_combined
    }


# =============================================================================
# 최적화 방식 1: 비트마스크 기반 presence_map
# =============================================================================

def process_bitmask_method(
    image_paths: List[str],
    width: int,
    height: int,
    max_workers: Optional[int] = None
) -> Dict[str, Any]:
    """최적화 방식: 비트마스크 기반 presence_map"""
    start_time = time.time()
    
    # presence_map: 각 픽셀에서 등장한 인덱스를 비트마스크로 저장
    presence_map = np.zeros((height, width), dtype=np.uint8)
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    high_mask_combined = np.zeros((height, width), dtype=bool)
    
    loading_start = time.time()
    
    # 병렬 로딩
    cpu_count = os.cpu_count() or 4
    optimal_workers = min(cpu_count * 2, 16, len(image_paths))
    worker_count = min(max_workers or optimal_workers, len(image_paths))
    
    loader = partial(load_pixel_indices_current, width=width, height=height)
    processed_count = 0
    
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_path = {
            executor.submit(loader, path): path
            for path in image_paths
        }
        
        for future in as_completed(future_to_path):
            path = future_to_path[future]
            try:
                pixel_indices = future.result()
                if pixel_indices is None:
                    continue
                
                # 고인덱스 처리
                high_mask = (pixel_indices >= 8)
                high_mask_combined |= high_mask
                high_indices_combined = np.maximum(
                    high_indices_combined,
                    np.where(high_mask, pixel_indices, 0)
                )
                
                # 비트마스크 누적: 인덱스 0~7만 처리
                low_mask = (pixel_indices < 8)
                low_indices = pixel_indices[low_mask]
                
                # 벡터화된 비트 OR 연산
                # 각 픽셀의 인덱스 값을 비트 플래그로 변환
                bit_flags = np.zeros((height, width), dtype=np.uint8)
                bit_flags[low_mask] = (1 << low_indices).astype(np.uint8)
                presence_map |= bit_flags
                
                processed_count += 1
            except Exception as exc:
                print(f"[ERROR] 처리 실패: {path}, {exc}")
    
    loading_time = time.time() - loading_start
    
    # LUT 생성: 각 비트마스크 패턴에 대한 중앙값 미리 계산
    lut_start = time.time()
    lut = np.zeros(256, dtype=np.uint8)
    for mask in range(256):
        if mask == 0:
            lut[mask] = 7  # 어떤 이미지에도 등장 안 한 경우
        else:
            # 비트마스크에서 설정된 인덱스 추출
            cats = [i for i in range(8) if mask & (1 << i)]
            if cats:
                cats.sort()
                mid = (len(cats) - 1) // 2  # 짝수일 때 아래쪽 중앙값
                lut[mask] = cats[mid]
            else:
                lut[mask] = 7
    lut_time = time.time() - lut_start
    
    # LUT 적용하여 median 맵 생성
    sum_start = time.time()
    sum_map_indices = lut[presence_map]
    sum_time = time.time() - sum_start
    
    # 인덱스별 히트맵 생성 (비트마스크 기반)
    # 사용자 제안: presence 여부만 확인하여 히트맵 생성
    count_start = time.time()
    heatmap_arrays = {}
    
    for idx in range(8):
        # 비트마스크 기반 히트맵 생성
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
    
    count_time = time.time() - count_start
    
    processing_time = time.time() - start_time
    
    # 메모리 사용량 추정
    memory_estimate = (
        presence_map.nbytes +  # presence_map만 (49MB for 7K)
        high_indices_combined.nbytes +
        high_mask_combined.nbytes +
        lut.nbytes  # LUT (256 bytes)
    ) / (1024 * 1024)  # MB
    
    return {
        "method": "bitmask",
        "processing_time": processing_time,
        "loading_time": loading_time,
        "lut_creation_time": lut_time,
        "sum_calculation_time": sum_time,
        "count_calculation_time": count_time,
        "processed_count": processed_count,
        "memory_mb": memory_estimate,
        "presence_map": presence_map,
        "sum_map": sum_map_indices,
        "heatmap_arrays": heatmap_arrays,  # 비트마스크 기반 히트맵
        "high_indices": high_indices_combined,
        "high_mask": high_mask_combined
    }


# =============================================================================
# 최적화 방식 2: 비트마스크 + 정확한 카운트 (하이브리드)
# =============================================================================

def process_hybrid_method(
    image_paths: List[str],
    width: int,
    height: int,
    max_workers: Optional[int] = None
) -> Dict[str, Any]:
    """하이브리드 방식: 비트마스크로 presence, 별도로 카운트"""
    start_time = time.time()
    
    presence_map = np.zeros((height, width), dtype=np.uint8)
    counts = np.zeros((8, height, width), dtype=np.uint32)
    high_indices_combined = np.zeros((height, width), dtype=np.uint8)
    high_mask_combined = np.zeros((height, width), dtype=bool)
    
    loading_start = time.time()
    
    cpu_count = os.cpu_count() or 4
    optimal_workers = min(cpu_count * 2, 16, len(image_paths))
    worker_count = min(max_workers or optimal_workers, len(image_paths))
    
    loader = partial(load_pixel_indices_current, width=width, height=height)
    processed_count = 0
    
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_to_path = {
            executor.submit(loader, path): path
            for path in image_paths
        }
        
        for future in as_completed(future_to_path):
            path = future_to_path[future]
            try:
                pixel_indices = future.result()
                if pixel_indices is None:
                    continue
                
                # 고인덱스 처리
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
                
                # 정확한 카운트 (인덱스 0~7만)
                for idx in range(8):
                    mask = (pixel_indices == idx)
                    counts[idx] += mask.astype(np.uint32)
                
                processed_count += 1
            except Exception as exc:
                print(f"[ERROR] 처리 실패: {path}, {exc}")
    
    loading_time = time.time() - loading_start
    
    # LUT 생성 및 적용
    lut_start = time.time()
    lut = np.zeros(256, dtype=np.uint8)
    for mask in range(256):
        if mask == 0:
            lut[mask] = 7
        else:
            cats = [i for i in range(8) if mask & (1 << i)]
            if cats:
                cats.sort()
                mid = (len(cats) - 1) // 2
                lut[mask] = cats[mid]
            else:
                lut[mask] = 7
    
    sum_start = time.time()
    sum_map_indices = lut[presence_map]
    sum_time = time.time() - sum_start
    
    processing_time = time.time() - start_time
    
    # 메모리 사용량 추정
    memory_estimate = (
        presence_map.nbytes +
        counts.nbytes +
        high_indices_combined.nbytes +
        high_mask_combined.nbytes +
        lut.nbytes
    ) / (1024 * 1024)  # MB
    
    return {
        "method": "hybrid",
        "processing_time": processing_time,
        "loading_time": loading_time,
        "lut_creation_time": time.time() - lut_start - sum_time,
        "sum_calculation_time": sum_time,
        "processed_count": processed_count,
        "memory_mb": memory_estimate,
        "presence_map": presence_map,
        "counts": counts,
        "sum_map": sum_map_indices,
        "high_indices": high_indices_combined,
        "high_mask": high_mask_combined
    }


# =============================================================================
# 벤치마크 실행
# =============================================================================

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
    print("7K 다중 이미지 처리 최적화 기법 평가")
    print("=" * 80)
    print(f"테스트 이미지: {len(image_paths)}개")
    print(f"이미지 크기: {width}×{height} ({width*height:,} 픽셀)")
    print(f"CPU 코어 수: {os.cpu_count()}")
    print()
    
    results = {}
    
    # 1. 현재 방식
    print("[1/3] 현재 방식 평가 중...")
    try:
        result_current = process_current_method(image_paths, width, height)
        results["current"] = result_current
        print(f"  [OK] 완료: {result_current['processing_time']:.2f}초")
    except Exception as e:
        print(f"  [ERROR] 실패: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    
    # 2. 비트마스크 방식
    print("[2/3] 비트마스크 방식 평가 중...")
    try:
        result_bitmask = process_bitmask_method(image_paths, width, height)
        results["bitmask"] = result_bitmask
        print(f"  [OK] 완료: {result_bitmask['processing_time']:.2f}초")
    except Exception as e:
        print(f"  [ERROR] 실패: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    
    # 3. 하이브리드 방식
    print("[3/3] 하이브리드 방식 평가 중...")
    try:
        result_hybrid = process_hybrid_method(image_paths, width, height)
        results["hybrid"] = result_hybrid
        print(f"  [OK] 완료: {result_hybrid['processing_time']:.2f}초")
    except Exception as e:
        print(f"  [ERROR] 실패: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    print("=" * 80)
    print("성능 비교 결과")
    print("=" * 80)
    
    if "current" in results:
        curr = results["current"]
        print(f"\n[현재 방식]")
        print(f"  전체 처리 시간: {curr['processing_time']:.2f}초")
        print(f"  이미지 로딩 시간: {curr['loading_time']:.2f}초")
        print(f"  Sum Map 계산 시간: {curr.get('sum_calculation_time', 0):.2f}초")
        print(f"  메모리 사용량: {curr['memory_mb']:.2f} MB")
        print(f"  처리된 이미지: {curr['processed_count']}개")
    
    if "bitmask" in results:
        bm = results["bitmask"]
        print(f"\n[비트마스크 방식]")
        print(f"  전체 처리 시간: {bm['processing_time']:.2f}초")
        print(f"  이미지 로딩 시간: {bm['loading_time']:.2f}초")
        print(f"  LUT 생성 시간: {bm.get('lut_creation_time', 0):.2f}초")
        print(f"  Sum Map 계산 시간: {bm.get('sum_calculation_time', 0):.2f}초")
        print(f"  카운트 계산 시간: {bm.get('count_calculation_time', 0):.2f}초")
        print(f"  메모리 사용량: {bm['memory_mb']:.2f} MB")
        print(f"  처리된 이미지: {bm['processed_count']}개")
        
        if "current" in results:
            speedup = results["current"]["processing_time"] / bm["processing_time"]
            memory_reduction = (1 - bm['memory_mb'] / results["current"]['memory_mb']) * 100
            print(f"  → 현재 대비 속도: {speedup:.2f}배")
            print(f"  → 메모리 절감: {memory_reduction:.1f}%")
    
    if "hybrid" in results:
        hyb = results["hybrid"]
        print(f"\n[하이브리드 방식]")
        print(f"  전체 처리 시간: {hyb['processing_time']:.2f}초")
        print(f"  이미지 로딩 시간: {hyb['loading_time']:.2f}초")
        print(f"  LUT 생성 시간: {hyb.get('lut_creation_time', 0):.2f}초")
        print(f"  Sum Map 계산 시간: {hyb.get('sum_calculation_time', 0):.2f}초")
        print(f"  메모리 사용량: {hyb['memory_mb']:.2f} MB")
        print(f"  처리된 이미지: {hyb['processed_count']}개")
        
        if "current" in results:
            speedup = results["current"]["processing_time"] / hyb["processing_time"]
            memory_reduction = (1 - hyb['memory_mb'] / results["current"]['memory_mb']) * 100
            print(f"  → 현재 대비 속도: {speedup:.2f}배")
            print(f"  → 메모리 절감: {memory_reduction:.1f}%")
    
    print()
    print("=" * 80)
    print("결론 및 권장사항")
    print("=" * 80)
    
    if "current" in results and "bitmask" in results:
        curr_time = results["current"]["processing_time"]
        bm_time = results["bitmask"]["processing_time"]
        curr_mem = results["current"]["memory_mb"]
        bm_mem = results["bitmask"]["memory_mb"]
        
        if bm_time < curr_time:
            improvement = (1 - bm_time / curr_time) * 100
            print(f"[OK] 비트마스크 방식이 {improvement:.1f}% 더 빠릅니다")
        else:
            slowdown = (bm_time / curr_time - 1) * 100
            print(f"[WARN] 비트마스크 방식이 {slowdown:.1f}% 더 느립니다")
        
        if bm_mem < curr_mem:
            mem_saving = (1 - bm_mem / curr_mem) * 100
            print(f"[OK] 비트마스크 방식이 메모리를 {mem_saving:.1f}% 절감합니다")
        else:
            mem_increase = (bm_mem / curr_mem - 1) * 100
            print(f"[WARN] 비트마스크 방식이 메모리를 {mem_increase:.1f}% 더 사용합니다")
    
    print()
    print("=" * 80)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="7K 이미지 처리 최적화 평가")
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
            # 절대 경로인 경우
            if img_file.is_relative_to(IMAGES_ROOT):
                rel_path = img_file.relative_to(IMAGES_ROOT)
                image_paths.append(str(rel_path))
            else:
                print(f"[WARNING] 경로 변환 실패: {img_file}")
                continue
    
    if not image_paths:
        print("[ERROR] 유효한 이미지 경로가 없습니다.")
        sys.exit(1)
    
    run_benchmark(image_paths, limit=args.limit)

