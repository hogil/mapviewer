"""
Composite Map Subset 오류 분석

핵심 문제:
1. recolor_saved_sum_maps (line 484-491)에서 calc_mask를 only_low_mask로 전달
2. _compute_subset_maps_from_counts (line 744-757)에서:
   - only_low_mask가 있으면 그대로 사용 (744-745)
   - 없으면 원본 grade_counts로 재계산 (747-757)
   
잠재적 버그:
- calc_mask를 전달하면 idx_8_mask, invalid_mask 필터링을 재적용하지 않음
- 747-757줄의 재계산 로직을 건너뜀
"""

print("=" * 70)
print("COMPOSITE MAP SUBSET 오류 분석")
print("=" * 70)
print()

print("📍 문제 발생 위치:")
print()
print("1. api/composite_map.py:484-491 (recolor_saved_sum_maps)")
print("   square_mean_map_sub, weighted_map_sub, calc_mask_sub, weighted_mask_sub = _compute_subset_maps_from_counts(")
print("       grade_counts_arr,")
print("       normalized,")
print("       invalid_mask_arr,")
print("       idx_8_mask_arr,")
print("       calc_mask,  # ← 여기가 문제!")
print("       source_image_count,")
print("   )")
print()

print("2. api/composite_map.py:744-757 (_compute_subset_maps_from_counts)")
print("   if only_low_mask is not None:")
print("       calc_mask = only_low_mask.astype(bool, copy=False).copy()")
print("   else:")
print("       # 원본 grade_counts로 재계산")
print("       raw_counts_float = grade_counts.astype(np.float32, copy=False)")
print("       calc_mask = raw_counts_float.sum(axis=0) > 0")
print("       if idx_8_mask is not None:")
print("           calc_mask &= ~idx_8_mask")
print("       if invalid_mask is not None:")
print("           calc_mask &= ~invalid_mask")
print()

print("🐛 버그 상세:")
print()
print("Case 1: calc_mask를 전달하는 경우 (현재 recolor_saved_sum_maps)")
print("  - 744줄에서 calc_mask를 그대로 사용")
print("  - 754-757줄의 idx_8_mask, invalid_mask 필터링을 건너뜀")
print("  - 만약 캐시된 calc_mask가 최신 상태가 아니면 문제 발생 가능")
print()

print("Case 2: None을 전달하는 경우 (권장)")
print("  - 748-757줄에서 원본 grade_counts로 calc_mask 재계산")
print("  - idx_8_mask, invalid_mask를 올바르게 필터링")
print("  - 항상 일관된 결과 보장")
print()

print("🔧 해결 방법:")
print()
print("Option 1: recolor_saved_sum_maps에서 None 전달")
print("  Line 489: calc_mask, → None,")
print()

print("Option 2: only_low_mask 파라미터 제거")
print("  - _compute_subset_maps_from_counts에서 only_low_mask 파라미터 삭제")
print("  - 항상 원본 grade_counts로 계산하도록 단순화")
print()

print("=" * 70)
print("추가 발견 사항")
print("=" * 70)
print()

print("💡 현재 데이터 특성:")
print("  - 테스트 결과: 모든 포인트가 single-grade (100%)")
print("  - 37,712,398개 포인트 모두 하나의 Grade만 가짐")
print("  - 이것이 square_mean과 square_weighted가 동일하게 보이는 이유")
print()

print("📊 Single-grade vs Mixed-grade:")
print("  Single: square_mean = square_weighted")
print("    예) grade 3이 2개 → mean=9, weighted=3")
print("  Mixed: square_mean ≠ square_weighted")
print("    예) grade 1,3 각 1개 → mean=5, weighted=2.5")
print()

print("=" * 70)
