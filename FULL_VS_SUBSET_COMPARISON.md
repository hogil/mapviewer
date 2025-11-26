# Full Composite Map vs Subset Map (요약)

## 1. 개념 차이

- **Full Map**: Grade 0~7 전체 사용 → **전체 결함 분포**를 보는 지도  
- **Subset Map**: 사용자가 선택한 grade만 사용 → **특정 결함 패턴만 분리**해서 보는 지도  
- 내부 계산(제곱 가중치, square_mean, square_weighted)은 두 경우 모두 동일한 수식을 사용한다.

## 2. Calc Mask (계산 영역)

두 지도는 **같은 웨이퍼 형상**을 가져야 하므로, 원본 `grade_counts` 기준으로 동일한 `calc_mask`를 쓴다.

```python
# 0-7 중 하나라도 있는 포인트
calc_mask = grade_counts.sum(axis=0) > 0
calc_mask &= ~idx_8_mask      # 8-13만 있는 영역 제외
calc_mask &= ~invalid_mask    # Invalid 영역 제외
```

Subset도 이 규칙을 그대로 따라가야 Full과 공간적으로 정확히 겹친다.

## 3. 값 크기/범위 차이 (간단 예시)

한 포인트에서:

```text
grade_counts[:, y, x] = [1, 4, 3, 2, 5, 1, 2, 0]   # 총 18장
```

- **Full Map**:  
  - grade 0~7 전체가 제곱 가중치 계산에 참여  
  - square_mean, square_weighted 값이 상대적으로 큼

- **Subset Map (예: [1, 2]만 선택)**:  
  - 선택되지 않은 grade(0,3,4,5,6,7)는 모두 grade 0으로 몰림  
  - 0² = 0이므로 분자(square_sum)는 크게 줄어듦  
  - 분모(weight_sum)는 커질 수 있어 **square_weighted는 더 작아지는 경향**

⇒ 같은 포인트라도 **Full 값 > Subset 값** 인 경우가 많고, Subset에는 0에 가까운 값이 많이 생긴다.

## 4. 시각적 차이 (모양은 같고, 패턴만 필터링)

### Full Map

```text
┌─────────────────────┐
│   🔴🔴🔴🔴🔴       │  모든 grade의 defect 패턴
│ 🔴🟠🟠🟠🔴🔴       │  전체 분포를 볼 수 있음
│   🟠🟡🟡🟠🔴       │
│     🟡🟡🟡🟠       │
│       🟡🟡🟡       │
└─────────────────────┘
```

### Subset Map (Grade 2, 3만 선택)

```text
┌─────────────────────┐
│                     │  Grade 0, 1은 투명 (0)
│   🟠🟠🟠           │  Grade 2, 3만 표시
│   🟠🟡🟡🟠         │  특정 패턴만 분리해서 볼 수 있음
│     🟡🟡🟡🟠       │
│       🟡🟡🟡       │
└─────────────────────┘
```

## 5. 색상(Rendering) 구조: 2-Layer

```python
def _render_sum_map_image(base_indices, value_map, mask, palette_list,
                          quantiles, color_stops):
    rgb_palette = np.array(palette_list).reshape(256, 3)

    # Layer 1: Base Layer (배경)
    rgb_array = rgb_palette[base_indices].copy()

    # Layer 2: Composite Layer (calc_mask 영역만)
    if calc_values.size > 0:
        percentiles = _percentile_ranks(calc_values)  # 0-100
        colors = _interpolate_percentile_colors(percentiles, color_stops)
        rgb_array[mask] = colors

    return Image.fromarray(rgb_array, mode='RGB')
```

- **Base Layer**
  - 0~7만 있는 곳: median 팔레트 색상
  - 8~13만 있는 곳: index 8(회색)
  - Invalid / Mixed: index 31(흰색)
  - Subset은 **Full에서 만든 `base_indices`를 그대로 재사용** → 웨이퍼 모양 동일

```text
Base Layer (렌더링 전):
┌─────────────────────┐
│ ⬜⬜⬜⬜⬜       │  31: 흰색 (Mixed/Invalid)
│🔵🔵🔵🔵⬜⬜    │  0-7: 팔레트 색상
│ 🔵🔵🔵🔵⬜     │  8: 회색 (8-13 only)
│   ⚪⚪⚪⬜     │
│     ⚪⚪⚪     │
└─────────────────────┘
```

- **Composite Layer**
  - `value_map`(square_mean 또는 square_weighted)의 값을 Min-Max scaling 해서 0~100 percentile로 변환  
  - 사용자 정의 color stops(11개) 사이를 선형 보간해서 RGB 결정  
  - Full/Subset 모두 동일한 로직을 쓰고, **값의 범위만 다르다**

## 6. Full vs Subset 색상 차이 (표)

| 항목 | Full Map | Subset Map |
|------|----------|------------|
| **값 범위** | 넓음 (0~대략 40~50) | 좁음 (0~소수/한 자리수) |
| **Percentile 기준** | 전체 데이터 | 선택 grade 데이터만 |
| **Color Stops** | 11개 (동일) | 11개 (동일) |
| **동일 포인트 색상** | 상대적으로 진함 | 상대적으로 연함 |
| **Base Layer** | 웨이퍼 형상 + 배경 | Full과 완전히 동일 |
| **Composite Layer** | calc_mask 영역 | 같은 calc_mask 영역 |

### 같은 포인트, 다른 해석 예시

```text
Full:    값 범위 0~49, 특정 포인트 값 = 2.29  → 약 5%  → 파란색 (낮은 값)
Subset:  값 범위 0~3,  같은 포인트 값 = 1.71 → 약 57% → 노랑~주황 (중간~높은 값)
```

⇒ **Subset은 “선택한 grade 안에서의 상대적인 위치”를 보여주는 지도**라서,  
Full에서 낮아 보이던 포인트가 Subset에서는 꽤 높은 색상으로 보일 수 있다.

## 7. 실제 사용 패턴

- **전체 확인**: Full Map으로 웨이퍼 전체 결함 분포 확인  
- **심각도별 분석**: Subset [5, 6, 7]로 심각 결함 핫스팟만 보기  
- **두 그룹 비교**: Subset [0, 1] vs [6, 7]로 경미/심각 결함 공간 분포 비교  
- **단일 패턴 집중**: Subset [3], [3,4] 등으로 특정 grade 패턴만 분리해서 분석

## 8. 버그 포인트 (요약)

- 과거에는 Full에서 만든 `calc_mask`를 Subset에 그대로 전달해서 **재계산을 건너뛰는** 코드가 있었음  
- 이렇게 하면 `idx_8_mask`, `invalid_mask`가 나중에 달라졌을 때 Full/Subset 유효 영역이 어긋날 수 있음  
- 수정 방향: Subset 호출 시 `only_low_mask=None`을 넘겨서,  
  항상 원본 `grade_counts` 기준으로 `calc_mask`를 **다시 계산**하도록 유지하는 것이 안전하다.

# Full Composite Map vs Subset Map 비교

## 1. Grade 선택 범위

### Full Map
- **모든 Grade (0-7) 포함**
- `selected_grades = [0, 1, 2, 3, 4, 5, 6, 7]`

### Subset Map
- **사용자가 선택한 Grade만 포함**
- 예: `selected_grades = [1, 3, 5]`

## 2. 계산 방식

### Full Map (api/composite_map.py:706-924)
```python
# 모든 grade의 counts 사용
grade_counts = np.zeros((8, height, width), dtype=np.uint16)
for idx in range(8):
    grade_counts[idx] = np.count_nonzero(all_indices == idx, axis=0)

# 제곱 가중치 적용
square_weights = (np.arange(8) ** 2).reshape(8, 1, 1)
square_sums = np.sum(grade_counts * square_weights, axis=0)

# Square Average
square_mean_map[calc_mask] = square_sums[calc_mask] / image_count

# Square Weighted Average
weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]
weight_map = np.sum(grade_counts * weight_factors, axis=0)
weighted_map[weighted_mask] = square_sums[weighted_mask] / weight_map[weighted_mask]
```

### Subset Map (api/composite_map.py:1051-1126)
```python
def _compute_maps_from_counts(
    grade_counts: np.ndarray,
    selected_grades: Sequence[int],
    invalid_mask: Optional[np.ndarray],
    idx_8_mask: Optional[np.ndarray],
    only_low_mask: Optional[np.ndarray] = None,
    image_count: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    # 1. 원본 grade_counts 복사
    counts_float = grade_counts.astype(np.float32, copy=True)

    # 2. 선택되지 않은 grade의 counts를 "Grade 0"으로 몰아서 이동
    all_grades = set(range(8))
    target_grades = set(selected_grades)
    grades_to_move = list(all_grades - target_grades - {0})

    if grades_to_move:
        for grade_idx in grades_to_move:
            counts_float[0, :, :] += counts_float[grade_idx, :, :]
            counts_float[grade_idx, :, :] = 0.0

    # 3. Full Map과 동일한 수식으로 square_sum / weight_sum 계산
    square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
    square_sums = np.sum(counts_float * square_weights, axis=0, dtype=np.float32)

    weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32).reshape(8, 1, 1)
    weight_map_sum = np.sum(counts_float * weight_factors, axis=0, dtype=np.float32)

    # 4. 동일한 계산식
    square_mean_map[calc_mask] = square_sums[calc_mask] / image_count_value
    weighted_map[weighted_mask] = square_sums[weighted_mask] / weight_map_sum[weighted_mask]
```

## 3. Calc Mask (계산 영역)

### Full Map
```python
# 0-7 중 하나라도 있는 포인트
calc_mask = grade_counts.sum(axis=0) > 0
calc_mask &= ~idx_8_mask  # 8-13만 있는 영역 제외
calc_mask &= ~invalid_mask  # Invalid 영역 제외
```

### Subset Map (정상 동작 시)
```python
# ⚠️ Full Map과 동일한 마스크 사용해야 함
# 원본 grade_counts로부터 재계산
raw_counts_float = grade_counts.astype(np.float32, copy=False)
calc_mask = raw_counts_float.sum(axis=0) > 0
calc_mask &= ~idx_8_mask
calc_mask &= ~invalid_mask
```

**핵심: Subset도 전체 웨이퍼 형상을 유지하기 위해 Full과 동일한 calc_mask 사용**

## 4. 값의 범위 차이

### 예시: 한 포인트에서 18개 이미지

**원본 grade_counts**
```
grade_counts[:, y, x] = [1, 4, 3, 2, 5, 1, 2, 0]
                        └──────────────────────┘
                        0  1  2  3  4  5  6  7 (grade)

image_count = 1 + 4 + 3 + 2 + 5 + 1 + 2 + 0 = 18
```

### 4.1 Full Map (모든 grade 사용)
```
square_weights = [0², 1², 2², 3², 4², 5², 6², 7²]
               = [0,  1,  4,  9, 16, 25, 36, 49]

square_sum = Σ(counts × square_weights)
           = 1×0 + 4×1 + 3×4 + 2×9 + 5×16 + 1×25 + 2×36 + 0×49
           = 0   + 4   + 12  + 18  + 80   + 25   + 72   + 0
           = 211

square_mean = 211 / 18 ≈ 11.72

weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]

weight_sum = 1×1 + 4×1 + 3×2 + 2×3 + 5×4 + 1×5 + 2×6 + 0×7
           = 1   + 4   + 6    + 6    + 20   + 5    + 12
           = 54

square_weighted = 211 / 54 ≈ 3.91
```

### 4.2 Subset Map (Grade [1, 2]만 선택)

- 선택된 grade: 1, 2  
- 비선택 grade: 0, 3, 4, 5, 6, 7  
- 비선택 grade의 카운트를 전부 **0번 인덱스**로 이동:

```
원본:   [1, 4, 3, 2, 5, 1, 2, 0]
3 이동: [3, 4, 3, 0, 5, 1, 2, 0]
4 이동: [8, 4, 3, 0, 0, 1, 2, 0]
5 이동: [9, 4, 3, 0, 0, 0, 2, 0]
6 이동: [11,4, 3, 0, 0, 0, 0, 0]

최종 counts = [11, 4, 3, 0, 0, 0, 0, 0]
```

이제 같은 수식을 적용하면:

```
square_sum = 11×0 + 4×1 + 3×4 + 0×9 + ... = 16
square_mean = 16 / 18 ≈ 0.89  (Full 11.72보다 훨씬 작음)

weight_sum = 11×1 + 4×1 + 3×2 + ... = 21
square_weighted = 16 / 21 ≈ 0.76
```

**관찰:**
- **square_sum**: 선택된 grade(1,2)만 남아서 크게 감소  
- **square_mean**: 분모는 여전히 전체 image_count(18) → 값이 매우 작아짐  
- **square_weighted**: 0번 인덱스에 비선택 grade 카운트가 모두 모여  
  - 제곱에는 영향(0²) 없지만  
  - 분모(weight_sum)를 크게 만들어 값이 더 작아짐

## 5. 시각적 차이

### Full Map
```
┌─────────────────────┐
│   🔴🔴🔴🔴🔴       │  모든 grade의 defect 패턴
│ 🔴🟠🟠🟠🔴🔴       │  전체 분포를 볼 수 있음
│   🟠🟡🟡🟠🔴       │
│     🟡🟡🟡🟠       │
│       🟡🟡🟡       │
└─────────────────────┘
```

### Subset Map (Grade 2, 3만 선택)
```
┌─────────────────────┐
│                     │  Grade 0, 1은 투명 (0)
│   🟠🟠🟠           │  Grade 2, 3만 표시
│   🟠🟡🟡🟠         │  특정 패턴만 분리해서 볼 수 있음
│     🟡🟡🟡🟠       │
│       🟡🟡🟡       │
└─────────────────────┘
```

## 6. 현재 버그의 영향

### 버그가 있을 때 (only_low_mask 전달)
```python
# Line 489, 853에서 calc_mask를 전달
_compute_subset_maps_from_counts(
    ...,
    calc_mask,  # ← Full Map의 calc_mask 전달
    ...
)

# Line 744에서 그대로 사용 → 재계산 건너뜀
calc_mask = only_low_mask.astype(bool, copy=False).copy()
# idx_8_mask, invalid_mask 재필터링 건너뜀!
```

**문제점:**
- Full Map 생성 이후 idx_8_mask나 invalid_mask가 변경되면 불일치
- 캐시된 calc_mask가 최신 상태가 아닐 수 있음
- Edge case에서 잘못된 영역이 계산에 포함될 수 있음

### 버그 수정 후 (None 전달)
```python
_compute_subset_maps_from_counts(
    ...,
    None,  # ← None 전달
    ...
)

# Line 748-757에서 원본 grade_counts로 재계산
raw_counts_float = grade_counts.astype(np.float32, copy=False)
calc_mask = raw_counts_float.sum(axis=0) > 0
if idx_8_mask is not None:
    calc_mask &= ~idx_8_mask  # 올바른 필터링
if invalid_mask is not None:
    calc_mask &= ~invalid_mask  # 올바른 필터링
```

**개선점:**
- 항상 최신 상태의 calc_mask 생성
- idx_8_mask, invalid_mask 필터링 보장
- Full과 Subset 간 일관성 유지

## 7. 주요 차이점 요약표

| 항목 | Full Map | Subset Map |
|------|----------|------------|
| **Grade 범위** | 0-7 전체 | 선택된 grade만 (예: 1, 3, 5) |
| **Counts 처리** | 모든 grade 사용 | 비선택 grade → 0으로 변경 |
| **Calc Mask** | 0-7 중 하나라도 있으면 포함 | Full과 동일 (웨이퍼 형상 유지) |
| **값의 크기** | 상대적으로 큼 | 상대적으로 작음 (0도 많음) |
| **시각화** | 모든 defect 패턴 | 특정 grade 패턴만 |
| **사용 목적** | 전체 분포 확인 | 특정 결함 유형 분리 분석 |

## 8. 수식 비교

### Square Average (square_mean)

**Full:**
```
square_mean = (Σ grade² × count) / total_images
            = (0²×c₀ + 1²×c₁ + 2²×c₂ + ... + 7²×c₇) / N
```

**Subset (예: grade 1, 3만 선택):**

- 선택되지 않은 grade의 카운트는 모두 **c₀'**(유효한 grade 0 카운트)에 합산됨.
- 하지만 0² = 0 이므로 **제곱합에는 영향이 없음**.

```
square_mean_subset = (Σ grade² × count_after_move) / N
                   = (0²×c₀' + 1²×c₁ + 2²×0 + 3²×c₃ + ... + 7²×0) / N
                   = (1²×c₁ + 3²×c₃) / N
```

⇒ **분모 N(전체 이미지 개수)는 Full과 동일하지만, 분자에서 비선택 grade의 기여가 사라져 값이 작아짐.**

### Square Weighted Average (square_weighted)

**Full:**
```
weight_sum_full = 1×c₀ + 1×c₁ + 2×c₂ + 3×c₃ + 4×c₄ + 5×c₅ + 6×c₆ + 7×c₇
square_weighted_full = square_sum_full / weight_sum_full
```

**Subset (동일 예):**

- 선택되지 않은 grade의 카운트가 전부 **c₀'**로 더해지기 때문에,  
  - **제곱합(square_sum)은 줄어들고**,  
  - **분모 weight_sum은 오히려 커질 수 있음**.

```
weight_sum_subset = 1×c₀' + 1×c₁ + 2×0 + 3×c₃ + ... + 7×0
square_weighted_subset = square_sum_subset / weight_sum_subset
```

⇒ 비선택 grade의 카운트가 **“0번 grade”로 몰려 분모를 키우는 역할**을 하므로,  
   같은 포인트라도 **subset의 square_weighted 값이 Full보다 더 작아지는 경향**이 있다.

## 9. 실제 사용 예시

### Use Case 1: 특정 심각도만 분석
```
Full Map: Grade 0-7 모두 → 전체 결함 분포
Subset [5, 6, 7]: 심각한 결함만 → 핫스팟 식별
```

### Use Case 2: 특정 패턴 비교
```
Subset [0, 1]: 경미한 결함
Subset [6, 7]: 심각한 결함
→ 두 그룹의 공간적 분포 차이 비교
```

### Use Case 3: 단계별 분석
```
Full Map 생성 → 전체 확인
Subset [3] 생성 → Grade 3만 집중 분석
Subset [3, 4] 생성 → Grade 3-4 패턴 확인
```

## 10. 색상(Color) 처리 방식

### 2-Layer 렌더링 아키텍처

```python
# api/composite_map.py:272-296 (_render_sum_map_image)
def _render_sum_map_image(base_indices, value_map, mask, palette_list,
                          quantiles, color_stops):
    rgb_palette = np.array(palette_list).reshape(256, 3)

    # Layer 1: Base Layer (배경)
    rgb_array = rgb_palette[base_indices].copy()

    # Layer 2: Composite Layer (calc_mask 영역만)
    if calc_values.size > 0:
        percentiles = _percentile_ranks(calc_values)  # 0-100
        colors = _interpolate_percentile_colors(percentiles, color_stops)
        rgb_array[mask] = colors  # 덮어씌움

    return Image.fromarray(rgb_array, mode='RGB')
```

### Layer 1: Base Layer (배경색)

**Full Map:**
```python
# 0-7만 있는 곳: median 값의 팔레트 색상 (덮어씌워질 예정)
base_indices[only_0_7_mask] = median_indices[only_0_7_mask]

# 8-13만 있는 곳: 인덱스 8 색상 고정
base_indices[idx_8_13_only] = 8  # 예: 회색

# Invalid 영역: 인덱스 31 흰색
base_indices[invalid_mask] = 31  # RGB(255, 255, 255)

# Mixed 영역: 인덱스 31 흰색
base_indices[mixed_areas] = 31
```

**Subset Map:**
```python
# Full과 동일한 base_indices 사용 (캐시에서 로드)
# 동일한 웨이퍼 형상 유지
```

**시각화:**
```
Base Layer (렌더링 전):
┌─────────────────────┐
│ ⬜⬜⬜⬜⬜       │  31: 흰색 (Mixed/Invalid)
│🔵🔵🔵🔵⬜⬜    │  0-7: 팔레트 색상 (덮어씌워질 예정)
│ 🔵🔵🔵🔵⬜     │  8: 회색 (8-13 only)
│   ⚪⚪⚪⬜     │
│     ⚪⚪⚪     │
└─────────────────────┘
```

### Layer 2: Composite Layer (Gradient 색상)

**Percentile 계산 (Min-Max Scaling):**
```python
# api/composite_map.py:104-123 (_percentile_ranks)
def _percentile_ranks(values):
    v_min = np.min(values)
    v_max = np.max(values)

    # Min-Max Scaling: 0은 0%, Max는 100%
    return (values - v_min) / (v_max - v_min) * 100.0
```

**Full Map 예시:**
```
Values: [0, 1, 4, 9, 16, 25, 36, 49]  (square_mean)
Min: 0, Max: 49

Percentiles:
0  → 0%
1  → 2.04%
4  → 8.16%
9  → 18.37%
16 → 32.65%
25 → 51.02%
36 → 73.47%
49 → 100%
```

**Subset Map (grade 1, 3만 선택) 예시:**
```
Values: [0, 0.33, 1, 3]  (일부만 계산됨)
Min: 0, Max: 3

Percentiles:
0    → 0%
0.33 → 11%
1    → 33.33%
3    → 100%

→ 값의 범위가 작아서 상대적으로 낮은 percentile
```

### 색상 보간 (Color Interpolation)

**Color Stops 구조:**
```javascript
// 사용자 설정 (11개 색상)
colors: [
  "#0000FF",  // quantile 0%   - 파랑
  "#0080FF",  // quantile 10%
  "#00FFFF",  // quantile 20%  - 하늘색
  "#00FF80",  // quantile 30%
  "#00FF00",  // quantile 40%  - 녹색
  "#80FF00",  // quantile 50%
  "#FFFF00",  // quantile 60%  - 노랑
  "#FFC000",  // quantile 70%
  "#FF8000",  // quantile 80%  - 주황
  "#FF4000",  // quantile 90%
  "#FF0000",  // quantile 100% - 빨강
]
```

**Percentile → RGB 변환:**
```python
# api/composite_map.py:126-171 (_interpolate_percentile_colors)
def _interpolate_percentile_colors(percentiles, color_array, quantile_positions):
    # percentiles: [0, 5, 15, 25, ..., 100]
    # quantile_positions: [0, 10, 20, ..., 100]

    # 1. percentile을 color_array 인덱스로 변환
    norm_indices = np.interp(percentiles, quantile_positions,
                             np.arange(len(color_array)))

    # 2. 인접한 두 색상 사이에서 선형 보간
    buckets = np.floor(norm_indices).astype(int)
    next_idx = buckets + 1
    t = norm_indices - buckets  # 보간 비율 (0~1)

    start_colors = color_array[buckets]    # 예: 파랑
    end_colors = color_array[next_idx]      # 예: 하늘색
    blended = start_colors + (end_colors - start_colors) * t

    return blended.astype(uint8)
```

**예시: Percentile 15% → RGB**
```
Percentile: 15%
Quantile positions: [0, 10, 20, ...]

Interpolation:
  15는 10과 20 사이
  norm_indices = 1.5  (color_array[1]과 [2] 사이)

  start_color = color_array[1] = RGB(0, 128, 255)  # 하늘색
  end_color = color_array[2] = RGB(0, 255, 255)    # 청록색
  t = 0.5

  blended = (0, 128, 255) + ((0, 255, 255) - (0, 128, 255)) * 0.5
          = (0, 128, 255) + (0, 127, 0) * 0.5
          = (0, 191.5, 255)
          = RGB(0, 192, 255)
```

### Full vs Subset 색상 차이

| 항목 | Full Map | Subset Map |
|------|----------|------------|
| **값의 범위** | 넓음 (예: 0~49) | 좁음 (예: 0~3) |
| **Percentile 분포** | 전체 분포 반영 | 선택 grade만 반영 |
| **색상 그라데이션** | 전체 color stops 활용 | 동일하게 전체 활용 (상대적) |
| **Min 값** | 전역 최소값 | 선택 grade 최소값 (≥ 전역) |
| **Max 값** | 전역 최대값 | 선택 grade 최대값 (≤ 전역) |
| **동일 위치 색상** | 상대적으로 진함 | 상대적으로 연함 |

### 구체적 비교 예시

**Full Map (모든 grade):**
```
포인트 A: grade [0:2개, 1:3개, 2:1개, 3:1개]
  square_mean = (0 + 3 + 4 + 9) / 7 = 2.29

  전체 범위: 0~49
  Percentile: 2.29 / 49 * 100 = 4.67%
  Color: 파랑에 가까움 (color_stops[0~1] 사이)
```

**Subset Map (grade 1, 3만):**
```
포인트 A: grade [0:0개, 1:3개, 2:0개, 3:1개]  # 0,2 제거
  square_mean = (0 + 3 + 0 + 9) / 7 = 1.71

  전체 범위: 0~3  (Subset 최대값이 낮음)
  Percentile: 1.71 / 3 * 100 = 57%
  Color: 노랑~주황 (color_stops[5~7] 사이)
```

**핵심 차이:**
- Full: 4.67% → 파랑 (낮은 값으로 판단)
- Subset: 57% → 노랑 (중간~높은 값으로 판단)
- **같은 포인트, 다른 색상!**

### 최종 렌더링 결과

**Full Map:**
```
┌─────────────────────┐
│ ⬜⬜⬜⬜⬜       │  ⬜ 흰색: Invalid/Mixed
│🔴🟠🟡🟢⬜⬜    │  🔴 빨강: High value
│ 🟠🟡🟢🔵⬜     │  🟠 주황: Medium-high
│   🟡🟢🔵⬜     │  🟡 노랑: Medium
│     🟢🔵🔵     │  🟢 녹색: Medium-low
└─────────────────────┘  🔵 파랑: Low value
Full gradient (0~49)     ⚪ 회색: Index 8-13 only
```

**Subset Map (grade 3, 5만):**
```
┌─────────────────────┐
│ ⬜⬜⬜⬜⬜       │  값의 범위가 좁아짐 (0~8)
│      🟡🟢⬜⬜    │  동일한 color stops 사용
│   🟡🟡🟢🔵⬜     │  → 상대적으로 더 밝은 색상
│   🟡🟢🔵⬜     │
│     🟢🔵🔵     │  선택 grade만 표시
└─────────────────────┘  나머지는 투명(0 또는 배경색)
Narrower range (0~8)
```

### 색상 설정 (Composite Color Settings)

**저장 위치 및 구조:**
- 파일: `logs/color-legends.json` 의 `"composite"` 섹션  
- 스킴 키: `scheme` (기본 `"change"` 또는 사용자 LoginId 등)  
- 내부 구조(요약):
  - `keys`: `["quantile0", "quantile10", ..., "quantile100"]`
  - `quantiles`: `[0.0, 0.1, ..., 1.0]`
  - `colors`: 각 quantile에 대응하는 11개 HEX 색상 배열
  - `defaultColors`: 기본 그라데이션 색상
  - `modified`: 사용자가 기본값을 변경했는지 여부
  - `lastModified`: 마지막 수정 시간(YYMMDD_HHMMSS)

`api/composite_colors.py` 의 `load_composite_color_settings` / `save_composite_color_settings` 가  
위 구조를 읽고 쓰면서, 부족한 값은 `DEFAULT_COMPOSITE_COLORS` 로 보정해 준다.

### Recolor 기능 (빠른 색상 변경)

- 합성 값(`square_mean_map` / `square_weighted_map`)과 `calc_mask`, `base_indices`는 **그대로 유지**  
- 선택된 composite 색상 스킴에서 `colors`/`quantiles`를 읽어와 **color_stops**를 만들고,  
  `_percentile_ranks` + `_interpolate_percentile_colors` 로 새 RGB를 계산한 뒤  
  같은 `calc_mask` 영역에만 다시 입혀서 **수 초 이내로 빠르게 재색칠**한다.  
- Full / Subset 모두 동일한 방식으로 Recolor가 적용된다.

## 11. 색상 차이 요약표

| 항목 | Full Map | Subset Map |
|------|----------|------------|
| **값 범위** | 넓음 (0~49) | 좁음 (0~8) |
| **Percentile 계산** | 전체 데이터 기준 | Subset 데이터 기준 |
| **Color Stops** | 11개 (동일) | 11개 (동일) |
| **색상 매핑** | Min-Max Scaling | Min-Max Scaling |
| **동일 포인트 색상** | 상대적으로 진함 | 상대적으로 연함 |
| **Base Layer** | 동일 (캐시 공유) | 동일 (캐시 공유) |
| **Composite Layer** | calc_mask 영역 | calc_mask 영역 (동일) |
| **Recolor 지원** | ✅ 고속 | ✅ 고속 |

## 결론

**Subset Map의 핵심:**
- Full Map과 동일한 공간 영역 (calc_mask)에서 계산
- 선택한 grade의 counts만 사용하여 재계산
- 비선택 grade의 영향을 제거한 분포 확인 가능
- Full Map 데이터(grade_counts)를 활용하여 빠르게 생성

**색상 처리의 핵심:**
- 2-Layer 렌더링 (Base + Composite)
- Min-Max Scaling으로 percentile 계산
- 선형 보간으로 부드러운 그라데이션
- Full과 Subset은 값의 범위 차이로 다른 색상 표현

**현재 버그:**
- calc_mask 전달 시 재계산을 건너뛰어 불일치 가능
- None 전달로 해결 가능
