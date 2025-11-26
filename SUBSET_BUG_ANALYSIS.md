# Composite Map Subset 오류 분석

## 문제 요약

composite map의 subset 기능에서 발생할 수 있는 잠재적 버그를 분석했습니다.

## 발견된 문제

### 1. 핵심 코드 위치

**api/composite_map.py:484-491 (recolor_saved_sum_maps)**
```python
square_mean_map_sub, weighted_map_sub, calc_mask_sub, weighted_mask_sub = _compute_subset_maps_from_counts(
    grade_counts_arr,
    normalized,
    invalid_mask_arr,
    idx_8_mask_arr,
    calc_mask,  # <- 문제: Full Map의 calc_mask를 전달
    source_image_count,
)
```

**api/composite_map.py:744-757 (_compute_subset_maps_from_counts)**
```python
# 3. 마스크 설정
if only_low_mask is not None:
    calc_mask = only_low_mask.astype(bool, copy=False).copy()
else:
    # only_low_mask가 없으면 원본 grade_counts 기준으로 새로 만듦 (0-7 존재 여부)
    # 따라서 원본 grade_counts의 합을 봐야 합니다.
    raw_counts_float = grade_counts.astype(np.float32, copy=False)
    calc_mask = raw_counts_float.sum(axis=0) > 0
    if idx_8_mask is not None:
        calc_mask &= ~idx_8_mask
    if invalid_mask is not None:
        calc_mask &= ~invalid_mask
```

### 2. 버그 상세

**Case 1: calc_mask를 전달하는 경우 (현재 recolor_saved_sum_maps)**
- Line 744에서 전달받은 calc_mask를 그대로 사용
- Line 754-757의 idx_8_mask, invalid_mask 필터링을 **건너뜀**
- 캐시된 calc_mask가 최신 상태가 아니면 문제 발생 가능

**Case 2: None을 전달하는 경우 (권장)**
- Line 748-757에서 원본 grade_counts로 calc_mask 재계산
- idx_8_mask, invalid_mask를 올바르게 필터링
- 항상 일관된 결과 보장

### 3. 동일한 문제가 있는 다른 위치

**api/composite_map.py:848-855 (create_subset_square_maps)**
```python
square_mean_map, weighted_map, subset_calc_mask, subset_weighted_mask = _compute_subset_maps_from_counts(
    grade_counts,
    normalized_grades,
    invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None,
    idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None,
    only_low_mask,  # <- 여기도 마스크를 전달
    source_image_count,
)
```

## 해결 방법

### Option 1: None 전달 (권장)

**recolor_saved_sum_maps (Line 489)**
```python
square_mean_map_sub, weighted_map_sub, calc_mask_sub, weighted_mask_sub = _compute_subset_maps_from_counts(
    grade_counts_arr,
    normalized,
    invalid_mask_arr,
    idx_8_mask_arr,
    None,  # <- calc_mask 대신 None 전달
    source_image_count,
)
```

**create_subset_square_maps (Line 853)**
```python
square_mean_map, weighted_map, subset_calc_mask, subset_weighted_mask = _compute_subset_maps_from_counts(
    grade_counts,
    normalized_grades,
    invalid_mask.astype(bool, copy=False) if invalid_mask is not None else None,
    idx_8_mask.astype(bool, copy=False) if idx_8_mask is not None else None,
    None,  # <- only_low_mask 대신 None 전달
    source_image_count,
)
```

### Option 2: only_low_mask 파라미터 제거

`_compute_subset_maps_from_counts` 함수에서 `only_low_mask` 파라미터를 완전히 제거하고,
항상 원본 grade_counts로부터 calc_mask를 계산하도록 단순화합니다.

```python
def _compute_subset_maps_from_counts(
    grade_counts: np.ndarray,
    selected_grades: Sequence[int],
    invalid_mask: Optional[np.ndarray],
    idx_8_mask: Optional[np.ndarray],
    # only_low_mask 파라미터 삭제
    image_count: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    # ... (중략)

    # 항상 원본 grade_counts로 계산
    raw_counts_float = grade_counts.astype(np.float32, copy=False)
    calc_mask = raw_counts_float.sum(axis=0) > 0
    if idx_8_mask is not None:
        calc_mask &= ~idx_8_mask
    if invalid_mask is not None:
        calc_mask &= ~invalid_mask
```

## 추가 발견 사항

### 데이터 특성
- 테스트 결과: **모든 포인트가 single-grade (100%)**
- 37,712,398개 포인트 모두 하나의 Grade만 가짐
- 이것이 square_mean과 square_weighted가 동일하게 보이는 이유

### Single-grade vs Mixed-grade

**Single-grade인 경우:**
- square_mean = square_weighted (값이 동일)
- 예: grade 3이 2개
  - square_sum = 3² × 2 = 18
  - square_mean = 18 / 2 = 9
  - weight_sum = 3 × 2 = 6
  - square_weighted = 18 / 6 = 3

**Mixed-grade인 경우:**
- square_mean ≠ square_weighted (값이 다름)
- 예: grade 1과 3이 각 1개
  - square_sum = 1² × 1 + 3² × 1 = 10
  - square_mean = 10 / 2 = 5
  - weight_sum = 1 × 1 + 3 × 1 = 4
  - square_weighted = 10 / 4 = 2.5

## 권장 사항

1. **즉시 수정**: recolor_saved_sum_maps와 create_subset_square_maps에서 None 전달
2. **장기 개선**: only_low_mask 파라미터를 완전히 제거하여 코드 단순화
3. **테스트**: Mixed-grade 데이터로 subset 기능 검증

## 영향 범위

- Subset Square Map 생성 시 일관성 문제
- Recolor 작업 시 마스크 불일치 가능성
- 특정 edge case에서 잘못된 영역이 계산에 포함될 수 있음
