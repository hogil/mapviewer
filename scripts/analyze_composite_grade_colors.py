#!/usr/bin/env python3
"""
Composite Map 생성 및 Grade 값/색상 분석 스크립트

사용법:
    python scripts/analyze_composite_grade_colors.py [이미지경로]

환경변수:
    IMAGES_ROOT: 이미지 루트 경로 (기본값: D:/project/data/wm-811k)
"""
import sys
import os
from pathlib import Path
from typing import Tuple, List, Optional
import numpy as np
from PIL import Image
import json

# 프로젝트 루트를 Python 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.config import IMAGES_ROOT
from api.composite_map import (
    create_composite_heatmaps,
    create_subset_map,
    COMPOSITE_ROOT,
    SQUARE_MAP_CACHE_FILENAME,
    _interpolate_percentile_colors,
    _compute_maps_from_counts,
)
from api.personal_colors import load_color_legends
from api.composite_colors import load_composite_color_settings


def get_color_from_palette(palette, index):
    """팔레트에서 인덱스에 해당하는 RGB 색상 반환"""
    if palette is None or index >= len(palette) // 3:
        return None
    r = palette[index * 3]
    g = palette[index * 3 + 1]
    b = palette[index * 3 + 2]
    return f"#{r:02x}{g:02x}{b:02x}"


def analyze_image_colors(image_path: Path, label: str):
    """이미지의 색상 분포 분석"""
    print(f"\n=== {label} 색상 분석 ===")
    
    if not image_path.exists():
        print(f"[오류] 이미지를 찾을 수 없습니다: {image_path}")
        return None
    
    img = Image.open(image_path)
    width, height = img.size
    total_pixels = width * height
    
    if img.mode == 'P':
        # 팔레트 모드
        palette = img.getpalette()
        pixels = np.array(img)
        img.close()
        
        # 픽셀 값별 카운트
        unique, counts = np.unique(pixels, return_counts=True)
        
        print(f"이미지 크기: {width} x {height} ({total_pixels:,} 픽셀)")
        print(f"모드: 팔레트 (P)")
        print(f"\n팔레트 인덱스별 픽셀 분포:")
        
        color_distribution = {}
        
        for idx, count in zip(unique, counts):
            if idx < 16:  # 0-15 인덱스만 분석
                color = get_color_from_palette(palette, idx)
                percentage = (count / total_pixels * 100) if total_pixels > 0 else 0
                color_distribution[idx] = {
                    'count': int(count),
                    'percentage': percentage,
                    'color': color
                }
                print(f"  인덱스 {idx:2d}: {count:8,} 픽셀 ({percentage:6.2f}%) - {color}")
        
        return color_distribution
    
    elif img.mode in ('RGB', 'RGBA'):
        # RGB 모드 - 실제 RGB 값으로 색상 추출
        rgb_array = np.array(img)
        if img.mode == 'RGBA':
            rgb_array = rgb_array[:, :, :3]  # Alpha 채널 제거
        img.close()
        
        print(f"이미지 크기: {width} x {height} ({total_pixels:,} 픽셀)")
        print(f"모드: RGB")
        
        # 실제 RGB 값으로 고유 색상 찾기 (그룹화 없이)
        rgb_flat = rgb_array.reshape(-1, 3)
        unique_colors, counts = np.unique(rgb_flat, axis=0, return_counts=True)
        
        # 상위 20개 색상만 표시
        top_indices = np.argsort(counts)[::-1][:20]
        
        print(f"\n주요 색상 분포 (상위 20개, 실제 RGB 값):")
        color_distribution = {}
        
        for i, idx in enumerate(top_indices):
            color_rgb = unique_colors[idx]
            count = counts[idx]
            percentage = (count / total_pixels * 100) if total_pixels > 0 else 0
            color_hex = f"#{color_rgb[0]:02x}{color_rgb[1]:02x}{color_rgb[2]:02x}"
            
            color_key = f"rgb_{color_rgb[0]}_{color_rgb[1]}_{color_rgb[2]}"
            color_distribution[color_key] = {
                'count': int(count),
                'percentage': percentage,
                'color': color_hex,
                'rgb': tuple(color_rgb)
            }
            
            print(f"  {i+1:2d}. {color_hex} (RGB: {color_rgb[0]:3d}, {color_rgb[1]:3d}, {color_rgb[2]:3d}): "
                  f"{count:8,} 픽셀 ({percentage:6.2f}%)")
        
        # 전체 색상 통계
        print(f"\n색상 통계:")
        print(f"  고유 색상 수: {len(unique_colors):,}")
        print(f"  평균 색상 밝기: {float(rgb_array.mean()):.1f}")
        print(f"  색상 표준편차: {float(rgb_array.std()):.1f}")
        
        return color_distribution
    
    else:
        print(f"[경고] 지원하지 않는 이미지 모드: {img.mode}")
        img.close()
        return None


def analyze_square_average_comparison(full_dir: Path, subset_dir: Path = None):
    """square_average와 square_average_12 비교 분석"""
    print("\n" + "=" * 80)
    print("Square Average 비교 분석")
    print("=" * 80)
    
    full_square = full_dir / "square_average.png"
    subset_square = None
    
    if subset_dir:
        subset_square = subset_dir / "square_average_12.png"
    else:
        # 같은 디렉토리에서 찾기
        subset_square = full_dir / "square_average_12.png"
    
    if not full_square.exists():
        print(f"[오류] Full square_average 이미지를 찾을 수 없습니다: {full_square}")
        return
    
    print(f"\n[Full] {full_square.name}")
    full_colors = analyze_image_colors(full_square, "Full Square Average")
    
    if subset_square and subset_square.exists():
        print(f"\n[Subset 12] {subset_square.name}")
        subset_colors = analyze_image_colors(subset_square, "Subset 12 Square Average")
        
        # 비교
        if full_colors and subset_colors:
            print("\n=== 색상 분포 비교 ===")
            all_keys = set(full_colors.keys()) | set(subset_colors.keys())
            
            # 키가 숫자인지 문자열인지 확인
            is_numeric = all(isinstance(k, (int, np.integer)) for k in all_keys)
            
            if is_numeric:
                # 팔레트 모드 (숫자 인덱스)
                for idx in sorted(all_keys):
                    full_info = full_colors.get(idx, {'count': 0, 'percentage': 0, 'color': None})
                    subset_info = subset_colors.get(idx, {'count': 0, 'percentage': 0, 'color': None})
                    
                    count_diff = subset_info['count'] - full_info['count']
                    pct_diff = subset_info['percentage'] - full_info['percentage']
                    
                    print(f"인덱스 {idx:2d}:")
                    print(f"  Full:   {full_info['count']:8,} 픽셀 ({full_info['percentage']:6.2f}%)")
                    print(f"  Subset: {subset_info['count']:8,} 픽셀 ({subset_info['percentage']:6.2f}%)")
                    print(f"  차이:   {count_diff:8,} 픽셀 ({pct_diff:+6.2f}%)")
            else:
                # RGB 모드 (문자열 키)
                # 색상별로 정렬 (색상 코드 기준)
                sorted_keys = sorted(all_keys, key=lambda k: (
                    full_colors.get(k, {}).get('color', '') or subset_colors.get(k, {}).get('color', '')
                ))
                
                for key in sorted_keys:
                    full_info = full_colors.get(key, {'count': 0, 'percentage': 0, 'color': None})
                    subset_info = subset_colors.get(key, {'count': 0, 'percentage': 0, 'color': None})
                    
                    count_diff = subset_info['count'] - full_info['count']
                    pct_diff = subset_info['percentage'] - full_info['percentage']
                    
                    color = full_info.get('color') or subset_info.get('color') or 'N/A'
                    print(f"색상 {color}:")
                    print(f"  Full:   {full_info['count']:8,} 픽셀 ({full_info['percentage']:6.2f}%)")
                    print(f"  Subset: {subset_info['count']:8,} 픽셀 ({subset_info['percentage']:6.2f}%)")
                    print(f"  차이:   {count_diff:8,} 픽셀 ({pct_diff:+6.2f}%)")
    else:
        print(f"[경고] Subset square_average_12 이미지를 찾을 수 없습니다: {subset_square}")


def analyze_grade_values_from_npz(cache_path: Path, label: str):
    """NPZ 파일에서 grade 값 분석"""
    print(f"\n=== {label} Grade 값 분석 ===")
    
    if not cache_path.exists():
        print(f"[오류] 캐시 파일을 찾을 수 없습니다: {cache_path}")
        return None
    
    try:
        with np.load(cache_path) as data:
            square_mean_map = data.get("square_mean")
            grade_counts = data.get("grade_counts")
            calc_mask = data.get("calc_mask")
            
            if square_mean_map is None:
                print("[경고] square_mean 데이터가 없습니다.")
                return None
            
            square_mean_map = square_mean_map.astype(np.float32)
            calc_mask = calc_mask.astype(bool) if calc_mask is not None else None
            
            if calc_mask is not None:
                values = square_mean_map[calc_mask]
            else:
                values = square_mean_map.flatten()
                values = values[np.isfinite(values)]
            
            if values.size == 0:
                print("[경고] 유효한 값이 없습니다.")
                return None
            
            # 0~100 스케일로 변환 (최대값 기준)
            v_max = float(values.max())
            v_min = float(values.min())
            fixed_min = 0.0  # 요청: 정규화 시 최소값을 0으로 고정

            # 0~100 범위로 정규화 (min=0 고정)
            if v_max > fixed_min:
                normalized = ((values - fixed_min) / (v_max - fixed_min)) * 100.0
            else:
                normalized = np.zeros_like(values)
            
            print(f"Square Mean 값 범위:")
            print(f"  원본 Min: {v_min:.4f}")
            print(f"  원본 Max: {v_max:.4f}")
            print(f"  원본 Mean: {float(values.mean()):.4f}")
            print(f"\n0~100 스케일 변환 (정규화 기준: min=0.0, max={v_max:.4f}):")
            print(f"  Min: {float(normalized.min()):.2f}")
            print(f"  Max: {float(normalized.max()):.2f}")
            print(f"  Mean: {float(normalized.mean()):.2f}")
            print(f"  Median: {float(np.median(normalized)):.2f}")
            
            # 구간별 분포
            bins = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
            hist, _ = np.histogram(normalized, bins=bins)
            print(f"\n0~100 구간별 분포:")
            for i in range(len(bins) - 1):
                count = int(hist[i])
                pct = (count / len(normalized) * 100) if len(normalized) > 0 else 0
                print(f"  {bins[i]:3d}~{bins[i+1]:3d}: {count:8,} 픽셀 ({pct:6.2f}%)")
            
            # Grade별 카운트 분석
            if grade_counts is not None:
                grade_counts = grade_counts.astype(np.uint16)
                print(f"\nGrade별 카운트:")
                for grade in range(8):
                    count_map = grade_counts[grade]
                    total_count = int(count_map.sum())
                    presence_pixels = int((count_map > 0).sum())
                    if presence_pixels > 0:
                        avg_count = total_count / presence_pixels
                        print(f"  Grade {grade}: 총 {total_count:,}, 존재 픽셀 {presence_pixels:,}, 평균 {avg_count:.2f}")
            
            return {
                'original_min': v_min,
                'original_max': v_max,
                'original_mean': float(values.mean()),
                'normalized_min': float(normalized.min()),
                'normalized_max': float(normalized.max()),
                'normalized_mean': float(normalized.mean()),
                'normalized_median': float(np.median(normalized)),
            }
            
    except Exception as e:
        print(f"[오류] 캐시 파일 분석 실패: {e}")
        import traceback
        traceback.print_exc()
        return None


def get_color_from_legends(grade: int, scheme: str = "change"):
    """Color legends에서 grade에 해당하는 색상 가져오기"""
    legends = load_color_legends()
    if scheme not in legends:
        scheme = "change"
    
    scheme_data = legends.get(scheme, {})
    top = scheme_data.get('top', {})
    
    grade_key = f'Grade{grade}'
    color = top.get(grade_key, '#000000')
    return color


def _hex_to_rgb_tuple(hex_value: str) -> Tuple[int, int, int]:
    """Hex 색상을 RGB 튜플로 변환"""
    hex_value = hex_value.lstrip('#')
    return tuple(int(hex_value[i:i+2], 16) for i in (0, 2, 4))


def analyze_grade1_values(cache_path: Path, selected_grades: Optional[List[int]] = None, label: str = ""):
    """Grade 1의 계산값, 0~100값, RGB값 분석"""
    print(f"\n=== Grade 1 상세 분석 {label} ===")
    
    if not cache_path.exists():
        print(f"[오류] 캐시 파일을 찾을 수 없습니다: {cache_path}")
        return None
    
    try:
        with np.load(cache_path) as data:
            square_mean_map = data.get("square_mean")
            grade_counts = data.get("grade_counts")
            calc_mask = data.get("calc_mask")
            invalid_mask = data.get("invalid_mask")
            idx_8_mask = data.get("idx_8_mask")
            image_count_arr = data.get("source_image_count")
            source_image_count = int(image_count_arr.item()) if image_count_arr is not None else 1
        
        if square_mean_map is None or grade_counts is None:
            print("[경고] 필요한 데이터가 없습니다.")
            return None
        
        square_mean_map = square_mean_map.astype(np.float32)
        grade_counts = grade_counts.astype(np.uint16, copy=False)
        calc_mask = calc_mask.astype(bool) if calc_mask is not None else None
        
        # Subset 계산이 필요한 경우
        if selected_grades is not None:
            invalid_mask_arr = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
            idx_8_mask_arr = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None
            
            square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
                grade_counts=grade_counts,
                selected_grades=selected_grades,
                invalid_mask=invalid_mask_arr,
                idx_8_mask=idx_8_mask_arr,
                only_low_mask=calc_mask,
                image_count=source_image_count,
                include_unselected_in_denominator=False,
            )
        
        # Grade 1이 존재하는 픽셀 찾기 (Grade 1이 포함된 모든 픽셀)
        grade1_mask = grade_counts[1] > 0
        if calc_mask is not None:
            grade1_mask = grade1_mask & calc_mask
        
        if not grade1_mask.any():
            print("[경고] Grade 1이 존재하는 픽셀이 없습니다.")
            return None
        
        # Grade 1 픽셀의 square_mean 값
        grade1_values = square_mean_map[grade1_mask]
        grade1_values = grade1_values[np.isfinite(grade1_values)]
        
        if grade1_values.size == 0:
            print("[경고] 유효한 Grade 1 값이 없습니다.")
            return None
        
        # 전체 square_mean_map의 최대값을 사용해 0~100 스케일 변환 (min=0 고정)
        all_values = square_mean_map[calc_mask] if calc_mask is not None else square_mean_map.flatten()
        all_values = all_values[np.isfinite(all_values)]
        
        if all_values.size > 0:
            norm_min = 0.0
            norm_max = float(all_values.max())
        else:
            norm_min = 0.0
            norm_max = float(grade1_values.max())
        
        # Grade 1 값들의 통계
        v_min = float(grade1_values.min())
        v_max = float(grade1_values.max())
        v_mean = float(grade1_values.mean())
        v_median = float(np.median(grade1_values))
        
        # Grade 1 값들을 전체 범위(max) 기준으로 0~100 스케일 변환 (min=0 고정)
        if norm_max > norm_min:
            normalized = ((grade1_values - norm_min) / (norm_max - norm_min)) * 100.0
        else:
            normalized = np.zeros_like(grade1_values)
        
        # Composite color 설정 로드
        settings = load_composite_color_settings("change")
        color_stops = np.array([_hex_to_rgb_tuple(c) for c in settings.colors], dtype=np.float32)
        quantile_positions = None
        if settings.quantiles:
            quantile_positions = np.asarray(settings.quantiles, dtype=np.float32) * 100.0
        
        # RGB 값 계산 (평균값 기준)
        mean_normalized = float(normalized.mean())
        lut_positions = np.linspace(0.0, 100.0, 256, dtype=np.float32)
        lut_colors = _interpolate_percentile_colors(lut_positions, color_stops, quantile_positions)
        
        # 평균값에 해당하는 RGB
        lut_idx = int(np.clip(np.rint(mean_normalized / 100.0 * 255.0), 0, 255))
        mean_rgb = lut_colors[lut_idx]
        
        # Min, Max 값에 해당하는 RGB
        min_normalized = float(normalized.min())
        max_normalized = float(normalized.max())
        min_lut_idx = int(np.clip(np.rint(min_normalized / 100.0 * 255.0), 0, 255))
        max_lut_idx = int(np.clip(np.rint(max_normalized / 100.0 * 255.0), 0, 255))
        min_rgb = lut_colors[min_lut_idx]
        max_rgb = lut_colors[max_lut_idx]
        
        print(f"\n[계산값 (Square Mean)]")
        print(f"  Min: {v_min:.4f}")
        print(f"  Max: {v_max:.4f}")
        print(f"  Mean: {v_mean:.4f}")
        print(f"  Median: {v_median:.4f}")
        
        print(f"\n[0~100 스케일 변환값]")
        print(f"  (정규화 기준: min=0.0, max={norm_max:.4f})")
        print(f"  Min: {min_normalized:.2f}")
        print(f"  Max: {max_normalized:.2f}")
        print(f"  Mean: {mean_normalized:.2f}")
        print(f"  Median: {float(np.median(normalized)):.2f}")
        
        print(f"\n[RGB 값 (Composite Color 적용)]")
        print(f"  Min RGB: ({min_rgb[0]:3d}, {min_rgb[1]:3d}, {min_rgb[2]:3d}) = #{min_rgb[0]:02x}{min_rgb[1]:02x}{min_rgb[2]:02x}")
        print(f"  Max RGB: ({max_rgb[0]:3d}, {max_rgb[1]:3d}, {max_rgb[2]:3d}) = #{max_rgb[0]:02x}{max_rgb[1]:02x}{max_rgb[2]:02x}")
        print(f"  Mean RGB: ({mean_rgb[0]:3d}, {mean_rgb[1]:3d}, {mean_rgb[2]:3d}) = #{mean_rgb[0]:02x}{mean_rgb[1]:02x}{mean_rgb[2]:02x}")
        
        print(f"\n[통계]")
        print(f"  Grade 1 존재 픽셀 수: {int(grade1_mask.sum()):,}")
        print(f"  전체 픽셀 대비: {int(grade1_mask.sum()) / grade1_mask.size * 100:.2f}%")
        
        return {
            'square_mean_min': v_min,
            'square_mean_max': v_max,
            'square_mean_mean': float(grade1_values.mean()),
            'normalized_min': min_normalized,
            'normalized_max': max_normalized,
            'normalized_mean': mean_normalized,
            'rgb_min': tuple(min_rgb),
            'rgb_max': tuple(max_rgb),
            'rgb_mean': tuple(mean_rgb),
            'pixel_count': int(grade1_mask.sum()),
        }
        
    except Exception as e:
        print(f"[오류] Grade 1 분석 실패: {e}")
        import traceback
        traceback.print_exc()
        return None


def analyze_existing_composite_folder(folder_path: str):
    """기존 composite map 폴더 분석"""
    print("=" * 80)
    print(f"기존 Composite Map 폴더 분석: {folder_path}")
    print("=" * 80)
    
    folder = Path(folder_path)
    if not folder.exists():
        print(f"[오류] 폴더를 찾을 수 없습니다: {folder}")
        return
    
    # NPZ 파일 확인
    cache_path = folder / SQUARE_MAP_CACHE_FILENAME
    if cache_path.exists():
        print("\n" + "=" * 80)
        print("1단계: Full Map Grade 값 분석")
        print("=" * 80)
        full_stats = analyze_grade_values_from_npz(cache_path, "Full Map")
        
        # Grade별 색상 정보
        print(f"\n=== Grade별 색상 정보 ===")
        legends = load_color_legends()
        scheme = legends.get("change", {})
        top = scheme.get("top", {})
        for grade in range(8):
            grade_key = f'Grade{grade}'
            color = top.get(grade_key, '#000000')
            print(f"Grade {grade}: {color}")
    else:
        print(f"[경고] NPZ 캐시 파일을 찾을 수 없습니다: {cache_path}")
        full_stats = None
    
    # Square Average 비교
    print("\n" + "=" * 80)
    print("2단계: Square Average 이미지 색상 비교")
    print("=" * 80)
    analyze_square_average_comparison(folder)
    
    # 요약
    if full_stats:
        print("\n" + "=" * 80)
        print("3단계: 분석 요약")
        print("=" * 80)
        print(f"\n[Full Map]")
        print(f"  원본 값 범위: {full_stats['original_min']:.4f} ~ {full_stats['original_max']:.4f}")
        print(f"  0~100 스케일: {full_stats['normalized_min']:.2f} ~ {full_stats['normalized_max']:.2f}")
        print(f"  평균: {full_stats['normalized_mean']:.2f}, 중앙값: {full_stats['normalized_median']:.2f}")


def analyze_composite_map(image_path: str):
    """Composite Map 생성 및 분석"""
    print("=" * 80)
    print(f"이미지 경로: {image_path}")
    print("=" * 80)
    
    # 이미지 경로를 상대 경로로 변환
    full_path = Path(image_path)
    if full_path.is_absolute():
        try:
            rel_path = full_path.relative_to(IMAGES_ROOT).as_posix()
        except ValueError:
            print(f"[오류] 이미지가 IMAGES_ROOT({IMAGES_ROOT}) 하위에 없습니다.")
            return
    else:
        rel_path = image_path.replace("\\", "/")
    
    # 이미지 존재 확인
    full_image_path = IMAGES_ROOT / rel_path
    if not full_image_path.exists():
        print(f"[오류] 이미지 파일을 찾을 수 없습니다: {full_image_path}")
        return
    
    print(f"[확인] 이미지 확인: {full_image_path}")
    
    # 1. Full Composite Map 생성
    print("\n" + "=" * 80)
    print("1단계: Full Composite Map 생성 (Grade 0-7 전체)")
    print("=" * 80)
    
    try:
        result = create_composite_heatmaps(
            image_paths=[rel_path],
            indices=[0, 1, 2, 3, 4, 5, 6, 7],
            create_sum=True,
            login_id="change",
        )
        full_output_dir = IMAGES_ROOT / result["output_dir"]
        print(f"[완료] Full Composite Map 생성 완료: {full_output_dir}")
    except Exception as e:
        print(f"[실패] Full Composite Map 생성 실패: {e}")
        import traceback
        traceback.print_exc()
        return
    
    # NPZ 파일 대기
    full_cache_path = full_output_dir / SQUARE_MAP_CACHE_FILENAME
    import time
    max_wait = 30
    wait_count = 0
    
    print(f"[대기] NPZ 파일 저장 대기 중...")
    while wait_count < max_wait:
        if full_cache_path.exists() and full_cache_path.stat().st_size > 0:
            try:
                with np.load(full_cache_path) as test_data:
                    pass
                break
            except Exception:
                pass
        time.sleep(0.5)
        wait_count += 0.5
    
    if not full_cache_path.exists():
        print(f"[오류] 캐시 파일을 찾을 수 없습니다: {full_cache_path}")
        return
    
    # 2. Full Map Grade 값 분석
    print("\n" + "=" * 80)
    print("2단계: Full Map Grade 값 분석")
    print("=" * 80)
    
    full_stats = analyze_grade_values_from_npz(full_cache_path, "Full Map")
    
    # Grade별 색상 정보
    print(f"\n=== Grade별 색상 정보 ===")
    legends = load_color_legends()
    scheme = legends.get("change", {})
    top = scheme.get("top", {})
    for grade in range(8):
        grade_key = f'Grade{grade}'
        color = top.get(grade_key, '#000000')
        print(f"Grade {grade}: {color}")
    
    # 3. Subset 12 Map 생성 (Grade 1, 2만 선택)
    print("\n" + "=" * 80)
    print("3단계: Subset 12 Map 생성 (Grade 1, 2만 선택)")
    print("=" * 80)
    
    try:
        subset_outputs = create_subset_map(
            output_dir=full_output_dir,
            selected_grades=[1, 2],
            scheme=None,
        )
        print(f"[완료] Subset 12 Map 생성 완료: {len(subset_outputs)}개 파일")
        for output in subset_outputs:
            print(f"  - {output['filename']}")
    except Exception as e:
        print(f"[실패] Subset 12 Map 생성 실패: {e}")
        import traceback
        traceback.print_exc()
        return
    
    # 4. Grade 1 상세 분석 (Full)
    print("\n" + "=" * 80)
    print("4단계: Grade 1 상세 분석 (Full Map)")
    print("=" * 80)
    
    grade1_full_stats = analyze_grade1_values(full_cache_path, selected_grades=None, label="(Full Map)")
    
    # 5. Subset Map Grade 값 분석 (같은 NPZ 파일 사용, subset 계산은 별도)
    print("\n" + "=" * 80)
    print("5단계: Subset 12 Map Grade 값 분석")
    print("=" * 80)
    
    # Subset 계산을 위해 NPZ에서 grade_counts 로드
    try:
        with np.load(full_cache_path) as data:
            grade_counts = data.get("grade_counts")
            invalid_mask = data.get("invalid_mask")
            idx_8_mask = data.get("idx_8_mask")
            image_count_arr = data.get("source_image_count")
            source_image_count = int(image_count_arr.item()) if image_count_arr is not None else 1
        
        if grade_counts is not None:
            from api.composite_map import _compute_maps_from_counts
            grade_counts_arr = grade_counts.astype(np.uint16, copy=False)
            invalid_mask_arr = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
            idx_8_mask_arr = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None
            
            square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
                grade_counts=grade_counts_arr,
                selected_grades=[1, 2],
                invalid_mask=invalid_mask_arr,
                idx_8_mask=idx_8_mask_arr,
                only_low_mask=None,
                image_count=source_image_count,
                include_unselected_in_denominator=False,
            )
            
            # Subset 값 분석
            if calc_mask.any():
                values = square_mean_map[calc_mask]
                values = values[np.isfinite(values)]
                
                if values.size > 0:
                    v_max = float(values.max())
                    v_min = float(values.min())
                    fixed_min = 0.0  # 요청: 정규화 시 최소값을 0으로 고정
                    
                    if v_max > fixed_min:
                        normalized = ((values - fixed_min) / (v_max - fixed_min)) * 100.0
                    else:
                        normalized = np.zeros_like(values)
                    
                    print(f"Subset 12 Square Mean 값 범위:")
                    print(f"  원본 Min: {v_min:.4f}")
                    print(f"  원본 Max: {v_max:.4f}")
                    print(f"  원본 Mean: {float(values.mean()):.4f}")
                    print(f"\n0~100 스케일 변환 (정규화 기준: min=0.0, max={v_max:.4f}):")
                    print(f"  Min: {float(normalized.min()):.2f}")
                    print(f"  Max: {float(normalized.max()):.2f}")
                    print(f"  Mean: {float(normalized.mean()):.2f}")
                    print(f"  Median: {float(np.median(normalized)):.2f}")
                    
                    subset_stats = {
                        'original_min': v_min,
                        'original_max': v_max,
                        'original_mean': float(values.mean()),
                        'normalized_min': float(normalized.min()),
                        'normalized_max': float(normalized.max()),
                        'normalized_mean': float(normalized.mean()),
                        'normalized_median': float(np.median(normalized)),
                    }
                else:
                    subset_stats = None
            else:
                subset_stats = None
        else:
            subset_stats = None
    except Exception as e:
        print(f"[경고] Subset 분석 실패: {e}")
        subset_stats = None
    
    # 6. Grade 1 상세 분석 (Subset 1,2)
    print("\n" + "=" * 80)
    print("6단계: Grade 1 상세 분석 (Subset 1,2)")
    print("=" * 80)
    
    grade1_subset_stats = analyze_grade1_values(full_cache_path, selected_grades=[1, 2], label="(Subset 1,2)")
    
    # 7. Square Average 비교
    print("\n" + "=" * 80)
    print("7단계: Square Average 이미지 색상 비교")
    print("=" * 80)
    
    analyze_square_average_comparison(full_output_dir)
    
    # 8. Grade 1 비교 요약
    print("\n" + "=" * 80)
    print("8단계: Grade 1 Full vs Subset 비교")
    print("=" * 80)
    
    if grade1_full_stats and grade1_subset_stats:
        print(f"\n[계산값 (Square Mean) 비교]")
        print(f"  Full Min:   {grade1_full_stats['square_mean_min']:.4f}")
        print(f"  Subset Min: {grade1_subset_stats['square_mean_min']:.4f}")
        print(f"  Full Max:   {grade1_full_stats['square_mean_max']:.4f}")
        print(f"  Subset Max: {grade1_subset_stats['square_mean_max']:.4f}")
        print(f"  Full Mean:  {grade1_full_stats['square_mean_mean']:.4f}")
        print(f"  Subset Mean: {grade1_subset_stats['square_mean_mean']:.4f}")
        
        print(f"\n[0~100 스케일 변환값 비교]")
        print(f"  Full Min:   {grade1_full_stats['normalized_min']:.2f}")
        print(f"  Subset Min: {grade1_subset_stats['normalized_min']:.2f}")
        print(f"  Full Max:   {grade1_full_stats['normalized_max']:.2f}")
        print(f"  Subset Max: {grade1_subset_stats['normalized_max']:.2f}")
        print(f"  Full Mean:  {grade1_full_stats['normalized_mean']:.2f}")
        print(f"  Subset Mean: {grade1_subset_stats['normalized_mean']:.2f}")
        
        print(f"\n[RGB 값 비교 (Composite Color 적용)]")
        full_rgb = grade1_full_stats['rgb_mean']
        subset_rgb = grade1_subset_stats['rgb_mean']
        print(f"  Full Mean RGB:   ({full_rgb[0]:3d}, {full_rgb[1]:3d}, {full_rgb[2]:3d}) = #{full_rgb[0]:02x}{full_rgb[1]:02x}{full_rgb[2]:02x}")
        print(f"  Subset Mean RGB: ({subset_rgb[0]:3d}, {subset_rgb[1]:3d}, {subset_rgb[2]:3d}) = #{subset_rgb[0]:02x}{subset_rgb[1]:02x}{subset_rgb[2]:02x}")
    
    # 9. 전체 요약
    print("\n" + "=" * 80)
    print("9단계: 전체 분석 요약")
    print("=" * 80)
    
    if full_stats:
        print(f"\n[Full Map]")
        print(f"  원본 값 범위: {full_stats['original_min']:.4f} ~ {full_stats['original_max']:.4f}")
        print(f"  0~100 스케일: {full_stats['normalized_min']:.2f} ~ {full_stats['normalized_max']:.2f}")
        print(f"  평균: {full_stats['normalized_mean']:.2f}, 중앙값: {full_stats['normalized_median']:.2f}")
    
    if subset_stats:
        print(f"\n[Subset 12 Map]")
        print(f"  원본 값 범위: {subset_stats['original_min']:.4f} ~ {subset_stats['original_max']:.4f}")
        print(f"  0~100 스케일: {subset_stats['normalized_min']:.2f} ~ {subset_stats['normalized_max']:.2f}")
        print(f"  평균: {subset_stats['normalized_mean']:.2f}, 중앙값: {subset_stats['normalized_median']:.2f}")
    
    print(f"\n[출력 디렉토리]")
    print(f"  {full_output_dir}")
    
    print("\n" + "=" * 80)
    print("분석 완료!")
    print("=" * 80)


if __name__ == "__main__":
    # 명령행 인자 확인
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        
        # 폴더 경로인지 확인
        folder_path = Path(arg)
        if folder_path.is_dir():
            # 기존 composite map 폴더 분석
            analyze_existing_composite_folder(arg)
        else:
            # 이미지 파일로 composite map 생성 및 분석
            analyze_composite_map(arg)
    else:
        # palette_3k 폴더에서 첫 번째 파일 선택
        palette_dir = Path(r"D:\project\data\wm-811k\palette_3k")
        png_files = list(palette_dir.glob("*.png"))
        if not png_files:
            print(f"[오류] palette_3k 폴더에 PNG 파일이 없습니다: {palette_dir}")
            sys.exit(1)
        image_path = str(png_files[0])
        print(f"[자동 선택] {image_path}")
        analyze_composite_map(image_path)

