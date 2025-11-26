# Full Composite Map vs Subset Map 비교

## 1. Grade 선택 범위

### Full Map
- **모든 Grade (0-7) 포함**
- `selected_grades = [0, 1, 2, 3, 4, 5, 6, 7]`

### Subset Map
- **사용자가 선택한 Grade만 포함**
- 예: `selected_grades = [1, 3, 5]`

## 2. 계산 방식

### Full Map (api/composite_map.py:542-573)
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

### Subset Map (api/composite_map.py:721-777)
```python
# 1. 선택되지 않은 grade의 counts를 0으로 만듦
counts_float = grade_counts.astype(np.float32, copy=True)
all_grades = set(range(8))
target_grades = set(selected_grades)
grades_to_zero = list(all_grades - target_grades)

if grades_to_zero:
    counts_float[grades_to_zero, :, :] = 0.0  # 비선택 grade → 0

# 2. Full Map과 동일한 수식으로 계산
square_weights = (np.arange(8) ** 2).reshape(8, 1, 1)
square_sums = np.sum(counts_float * square_weights, axis=0)

weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]
weight_map_sum = np.sum(counts_float * weight_factors, axis=0)

# 3. 동일한 계산식
square_mean_map[calc_mask] = square_sums[calc_mask] / image_count
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

### 예시: 한 포인트에서 3개 이미지

**Full Map (Grade 0, 1, 2 모두 포함)**
```
Counts: [1개, 1개, 1개, 0, 0, 0, 0, 0]

square_sum = 0²×1 + 1²×1 + 2²×1 = 0 + 1 + 4 = 5
square_mean = 5 / 3 = 1.67

weight_sum = 1×1 + 1×1 + 2×1 = 4
square_weighted = 5 / 4 = 1.25
```

**Subset Map (Grade 1만 선택)**
```
Counts: [0개, 1개, 0개, 0, 0, 0, 0, 0]  # 0과 2를 0으로 만듦

square_sum = 0²×0 + 1²×1 + 2²×0 = 1
square_mean = 1 / 3 = 0.33

weight_sum = 1×0 + 1×1 + 2×0 = 1
square_weighted = 1 / 1 = 1.00
```

**관찰:**
- Subset은 Full보다 값이 작음 (일부 grade만 반영)
- 선택되지 않은 grade만 있는 포인트 → 값이 0
- Full의 calc_mask 영역 중 일부가 0 값을 가짐

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

**Subset (grade 1, 3만 선택):**
```
square_mean = (Σ grade² × count) / total_images
            = (0²×0 + 1²×c₁ + 2²×0 + 3²×c₃ + ... + 7²×0) / N
            = (1²×c₁ + 3²×c₃) / N
```

### Square Weighted Average (square_weighted)

**Full:**
```
weight_sum = 1×c₀ + 1×c₁ + 2×c₂ + 3×c₃ + 4×c₄ + 5×c₅ + 6×c₆ + 7×c₇
square_weighted = square_sum / weight_sum
```

**Subset:**
```
weight_sum = 1×0 + 1×c₁ + 2×0 + 3×c₃ + ... + 7×0
           = 1×c₁ + 3×c₃
square_weighted = square_sum / weight_sum
```

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

**저장 위치:**
- `personal_colors/{scheme}.json`
- Recolor 시 동일한 scheme 재사용

**구조:**
```json
{
  "colors": [
    "#0000FF", "#0080FF", "#00FFFF", "#00FF80",
    "#00FF00", "#80FF00", "#FFFF00", "#FFC000",
    "#FF8000", "#FF4000", "#FF0000"
  ],
  "quantiles": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
}
```

### Recolor 기능

**Fast Recolor (데이터 재계산 없이 색상만 변경):**
```python
# 1. 캐시에서 로드
square_mean_map  # 값 유지
base_indices     # 배경 유지
calc_mask        # 마스크 유지

# 2. 새로운 color_stops로 재렌더링
new_colors = ["#FF0000", "#00FF00", ...]  # 사용자 변경
color_stops = [_hex_to_rgb_tuple(c) for c in new_colors]

# 3. Percentile 재계산 (값 범위는 동일)
percentiles = _percentile_ranks(square_mean_map[calc_mask])
colors = _interpolate_percentile_colors(percentiles, color_stops)

# 4. 재렌더링 (수 초 내 완료)
rgb_array[calc_mask] = colors
```

**Full과 Subset 모두 동일한 Recolor 지원**

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
