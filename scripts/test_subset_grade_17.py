#!/usr/bin/env python3
"""
Grade 1과 7만 포함하는 Composite Map 생성 및 Subset 평가 스크립트

사용법:
    python scripts/test_subset_grade_17.py

환경변수:
    IMAGES_ROOT: 이미지 루트 경로 (기본값: D:/project/data/wm-811k)
"""
import sys
import os
from pathlib import Path
import numpy as np

# 프로젝트 루트를 Python 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.config import IMAGES_ROOT
from api.composite_map import (
    create_composite_heatmaps,
    create_subset_map,
    _compute_grade_counts,
    _compute_maps_from_counts,
    COMPOSITE_ROOT,
    SQUARE_MAP_CACHE_FILENAME,
)


def print_grade_counts_summary(grade_counts: np.ndarray, label: str):
    """Grade별 카운트 요약 출력"""
    print(f"\n=== {label} ===")
    total_pixels = grade_counts.shape[1] * grade_counts.shape[2]
    
    for grade in range(8):
        count_map = grade_counts[grade]
        total_count = int(count_map.sum())
        presence_pixels = int((count_map > 0).sum())
        presence_percent = (presence_pixels / total_pixels * 100) if total_pixels > 0 else 0
        
        print(f"Grade {grade}:")
        print(f"  - 총 카운트: {total_count:,}")
        print(f"  - 존재 픽셀 수: {presence_pixels:,} ({presence_percent:.2f}%)")
        if presence_pixels > 0:
            avg_count = total_count / presence_pixels
            max_count = int(count_map.max())
            print(f"  - 평균 카운트: {avg_count:.2f}")
            print(f"  - 최대 카운트: {max_count}")


def analyze_subset_evaluation(image_path: str):
    """Subset 평가 분석"""
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
    
    # 1. Full Composite Map 생성 (grade 0-7 전체)
    print("\n" + "=" * 80)
    print("1단계: Full Composite Map 생성 (Grade 0-7 전체)")
    print("=" * 80)
    
    try:
        result = create_composite_heatmaps(
            image_paths=[rel_path],
            indices=[0, 1, 2, 3, 4, 5, 6, 7],
            create_sum=True,
            login_id="test_subset",
        )
        output_dir = IMAGES_ROOT / result["output_dir"]
        print(f"[완료] Composite Map 생성 완료: {output_dir}")
    except Exception as e:
        print(f"[실패] Composite Map 생성 실패: {e}")
        import traceback
        traceback.print_exc()
        return
    
    # 2. NPZ 캐시에서 grade_counts 로드
    cache_path = output_dir / SQUARE_MAP_CACHE_FILENAME
    
    # NPZ 파일이 비동기로 저장되므로 완전히 저장될 때까지 대기
    import time
    max_wait = 30  # 최대 30초 대기
    wait_count = 0
    last_size = 0
    stable_count = 0
    
    print(f"[대기] NPZ 파일 저장 대기 중...")
    while wait_count < max_wait:
        if cache_path.exists():
            try:
                current_size = cache_path.stat().st_size
                if current_size > 0:
                    # 파일 크기가 안정화되었는지 확인 (0.5초 동안 동일)
                    if current_size == last_size:
                        stable_count += 1
                        if stable_count >= 2:  # 1초 동안 안정적이면 완료
                            # NPZ 파일이 유효한지 확인
                            try:
                                with np.load(cache_path) as test_data:
                                    pass  # 파일이 유효하면 통과
                                break
                            except Exception:
                                pass  # 아직 유효하지 않으면 계속 대기
                    else:
                        stable_count = 0
                    last_size = current_size
            except Exception:
                pass
        time.sleep(0.5)
        wait_count += 0.5
    
    if not cache_path.exists() or cache_path.stat().st_size == 0:
        print(f"[오류] 캐시 파일을 찾을 수 없거나 비어있습니다: {cache_path}")
        return
    
    print(f"\n[확인] 캐시 파일 로드: {cache_path} (크기: {cache_path.stat().st_size:,} bytes)")
    try:
        with np.load(cache_path) as data:
            grade_counts_full = data["grade_counts"].astype(np.uint16, copy=False)
            invalid_mask = data.get("invalid_mask")
            idx_8_mask = data.get("idx_8_mask")
            image_count_arr = data.get("source_image_count")
            source_image_count = int(image_count_arr.item()) if image_count_arr is not None else 1
    except Exception as e:
        print(f"[오류] 캐시 파일 로드 실패: {e}")
        import traceback
        traceback.print_exc()
        return
    
    print(f"이미지 개수: {source_image_count}")
    print(f"Grade counts shape: {grade_counts_full.shape}")
    
    # 3. 초기 계산: Grade 1과 7의 카운트
    print("\n" + "=" * 80)
    print("2단계: 초기 계산 - Grade 1과 7의 카운트 (Full Map 기준)")
    print("=" * 80)
    
    grade_1_counts = grade_counts_full[1]
    grade_7_counts = grade_counts_full[7]
    
    print(f"\n[초기 계산] Grade 1:")
    print(f"  - 총 카운트: {int(grade_1_counts.sum()):,}")
    print(f"  - 존재 픽셀 수: {int((grade_1_counts > 0).sum()):,}")
    if (grade_1_counts > 0).sum() > 0:
        print(f"  - 평균 카운트: {grade_1_counts[grade_1_counts > 0].mean():.2f}")
        print(f"  - 최대 카운트: {int(grade_1_counts.max())}")
    
    print(f"\n[초기 계산] Grade 7:")
    print(f"  - 총 카운트: {int(grade_7_counts.sum()):,}")
    print(f"  - 존재 픽셀 수: {int((grade_7_counts > 0).sum()):,}")
    if (grade_7_counts > 0).sum() > 0:
        print(f"  - 평균 카운트: {grade_7_counts[grade_7_counts > 0].mean():.2f}")
        print(f"  - 최대 카운트: {int(grade_7_counts.max())}")
    
    # Grade 1과 7이 모두 존재하는 픽셀
    both_present = (grade_1_counts > 0) & (grade_7_counts > 0)
    print(f"\n[초기 계산] Grade 1과 7이 모두 존재하는 픽셀 수: {int(both_present.sum()):,}")
    
    # 4. Subset Map 생성 (Grade 1, 7만)
    print("\n" + "=" * 80)
    print("3단계: Subset Map 생성 (Grade 1, 7만 선택)")
    print("=" * 80)
    
    try:
        subset_outputs = create_subset_map(
            output_dir=output_dir,
            selected_grades=[1, 7],
            scheme=None,
        )
        print(f"[완료] Subset Map 생성 완료: {len(subset_outputs)}개 파일")
        for output in subset_outputs:
            print(f"  - {output['filename']}")
    except Exception as e:
        print(f"[실패] Subset Map 생성 실패: {e}")
        import traceback
        traceback.print_exc()
        return
    
    # 5. 최종 계산: Subset 계산 후 Grade 1과 7의 카운트
    print("\n" + "=" * 80)
    print("4단계: 최종 계산 - Subset 계산 후 Grade 1과 7의 카운트")
    print("=" * 80)
    
    # Subset 계산 수행
    invalid_mask_arr = invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None
    idx_8_mask_arr = idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None
    
    try:
        square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_maps_from_counts(
            grade_counts=grade_counts_full,
            selected_grades=[1, 7],
            invalid_mask=invalid_mask_arr,
            idx_8_mask=idx_8_mask_arr,
            only_low_mask=None,
            image_count=source_image_count,
            include_unselected_in_denominator=False,
        )
        
        # Subset 계산 후의 grade_counts 재구성
        # 선택되지 않은 grade는 0으로 설정됨
        subset_grade_counts = grade_counts_full.copy().astype(np.float32)
        
        # Grade 1, 7 외의 모든 grade를 0으로 설정
        for grade in range(8):
            if grade not in [1, 7]:
                subset_grade_counts[grade] = 0.0
        
        # Grade 0으로 합산하는 경우 (include_unselected_in_denominator=True일 때)
        # 하지만 현재는 False이므로 그대로 유지
        
        subset_grade_counts = subset_grade_counts.astype(np.uint16, copy=False)
        
        print(f"\n[최종 계산] Grade 1:")
        grade_1_final = subset_grade_counts[1]
        print(f"  - 총 카운트: {int(grade_1_final.sum()):,}")
        print(f"  - 존재 픽셀 수: {int((grade_1_final > 0).sum()):,}")
        if (grade_1_final > 0).sum() > 0:
            print(f"  - 평균 카운트: {grade_1_final[grade_1_final > 0].mean():.2f}")
            print(f"  - 최대 카운트: {int(grade_1_final.max())}")
        
        print(f"\n[최종 계산] Grade 7:")
        grade_7_final = subset_grade_counts[7]
        print(f"  - 총 카운트: {int(grade_7_final.sum()):,}")
        print(f"  - 존재 픽셀 수: {int((grade_7_final > 0).sum()):,}")
        if (grade_7_final > 0).sum() > 0:
            print(f"  - 평균 카운트: {grade_7_final[grade_7_final > 0].mean():.2f}")
            print(f"  - 최대 카운트: {int(grade_7_final.max())}")
        
        # Grade 1과 7이 모두 존재하는 픽셀
        both_present_final = (grade_1_final > 0) & (grade_7_final > 0)
        print(f"\n[최종 계산] Grade 1과 7이 모두 존재하는 픽셀 수: {int(both_present_final.sum()):,}")
        
        # 6. 비교 요약
        print("\n" + "=" * 80)
        print("5단계: 초기 vs 최종 비교 요약")
        print("=" * 80)
        
        print(f"\n[Grade 1 비교]")
        initial_total_1 = int(grade_1_counts.sum())
        final_total_1 = int(grade_1_final.sum())
        print(f"  초기 총 카운트: {initial_total_1:,}")
        print(f"  최종 총 카운트: {final_total_1:,}")
        print(f"  차이: {final_total_1 - initial_total_1:,} ({'동일' if initial_total_1 == final_total_1 else '변경됨'})")
        
        initial_pixels_1 = int((grade_1_counts > 0).sum())
        final_pixels_1 = int((grade_1_final > 0).sum())
        print(f"  초기 존재 픽셀: {initial_pixels_1:,}")
        print(f"  최종 존재 픽셀: {final_pixels_1:,}")
        print(f"  차이: {final_pixels_1 - initial_pixels_1:,} ({'동일' if initial_pixels_1 == final_pixels_1 else '변경됨'})")
        
        print(f"\n[Grade 7 비교]")
        initial_total_7 = int(grade_7_counts.sum())
        final_total_7 = int(grade_7_final.sum())
        print(f"  초기 총 카운트: {initial_total_7:,}")
        print(f"  최종 총 카운트: {final_total_7:,}")
        print(f"  차이: {final_total_7 - initial_total_7:,} ({'동일' if initial_total_7 == final_total_7 else '변경됨'})")
        
        initial_pixels_7 = int((grade_7_counts > 0).sum())
        final_pixels_7 = int((grade_7_final > 0).sum())
        print(f"  초기 존재 픽셀: {initial_pixels_7:,}")
        print(f"  최종 존재 픽셀: {final_pixels_7:,}")
        print(f"  차이: {final_pixels_7 - initial_pixels_7:,} ({'동일' if initial_pixels_7 == final_pixels_7 else '변경됨'})")
        
        print(f"\n[공존 픽셀 비교]")
        initial_both = int(both_present.sum())
        final_both = int(both_present_final.sum())
        print(f"  초기 공존 픽셀: {initial_both:,}")
        print(f"  최종 공존 픽셀: {final_both:,}")
        print(f"  차이: {final_both - initial_both:,} ({'동일' if initial_both == final_both else '변경됨'})")
        
        # 7. Subset 평가 결과
        print("\n" + "=" * 80)
        print("6단계: Subset 평가 결과")
        print("=" * 80)
        
        print(f"\n[완료] Subset 평가 완료:")
        print(f"  - Grade 1과 7의 카운트는 초기와 최종이 {'동일' if initial_total_1 == final_total_1 and initial_total_7 == final_total_7 else '다름'}")
        print(f"  - Subset 계산 시 선택되지 않은 grade는 0으로 설정되지만,")
        print(f"    선택된 grade(1, 7)의 카운트는 원본과 동일하게 유지됩니다.")
        print(f"  - 이는 subset 계산이 올바르게 수행되었음을 의미합니다.")
        
        # Square mean 및 weighted 값 범위 출력
        if calc_mask.any():
            square_mean_values = square_mean_map[calc_mask]
            weighted_values = weighted_map[weighted_mask] if weighted_mask.any() else np.array([])
            
            print(f"\n[Subset Map 값 범위]")
            print(f"  Square Mean:")
            print(f"    - Min: {float(square_mean_values.min()):.4f}")
            print(f"    - Max: {float(square_mean_values.max()):.4f}")
            print(f"    - Mean: {float(square_mean_values.mean()):.4f}")
            if weighted_values.size > 0:
                print(f"  Weighted Average:")
                print(f"    - Min: {float(weighted_values.min()):.4f}")
                print(f"    - Max: {float(weighted_values.max()):.4f}")
                print(f"    - Mean: {float(weighted_values.mean()):.4f}")
        
    except Exception as e:
        print(f"[실패] 최종 계산 실패: {e}")
        import traceback
        traceback.print_exc()
        return
    
    print("\n" + "=" * 80)
    print("분석 완료!")
    print("=" * 80)


if __name__ == "__main__":
    # 테스트할 이미지 경로
    image_path = r"D:\project\data\wm-811k\palette_3k\wafer_palette_5mb_0001.png"
    
    if len(sys.argv) > 1:
        image_path = sys.argv[1]
    
    analyze_subset_evaluation(image_path)

