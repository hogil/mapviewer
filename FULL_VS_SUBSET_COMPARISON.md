# Full Composite Map vs Subset Map

> **핵심 요약:** Full Map은 모든 grade(0-7)의 결함 분포를 보여주고, Subset Map은 선택한 grade만 분리해서 보여줍니다. 계산 수식은 동일하지만, 값의 범위와 색상 표현이 달라집니다.

## 목차

1. [개념 차이](#1-개념-차이)
2. [Calc Mask (계산 영역)](#2-calc-mask-계산-영역)
3. [값 크기/범위 차이](#3-값-크기범위-차이)
4. [시각적 차이](#4-시각적-차이)
5. [색상(Rendering) 구조: 2-Layer](#5-색상rendering-구조-2-layer)
6. [Full vs Subset 색상 차이](#6-full-vs-subset-색상-차이)
7. [실제 사용 패턴](#7-실제-사용-패턴)
8. [버그 포인트](#8-버그-포인트)

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

## 3. 값 크기/범위 차이

### 간단 예시

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

### 상세 수식 비교

**원본 grade_counts**
```
grade_counts[:, y, x] = [1, 4, 3, 2, 5, 1, 2, 0]
                        └──────────────────────┘
                        0  1  2  3  4  5  6  7 (grade)

image_count = 1 + 4 + 3 + 2 + 5 + 1 + 2 + 0 = 18
```

**Full Map (모든 grade 사용)**
```
square_weights = [0², 1², 2², 3², 4², 5², 6², 7²]
               = [0,  1,  4,  9, 16, 25, 36, 49]

square_sum = Σ(counts × square_weights)
           = 1×0 + 4×1 + 3×4 + 2×9 + 5×16 + 1×25 + 2×36 + 0×49
           = 211

square_mean = 211 / 18 ≈ 11.72

weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]
weight_sum = 54

square_weighted = 211 / 54 ≈ 3.91
```

**Subset Map (Grade [1, 2]만 선택)**

비선택 grade의 카운트를 전부 **0번 인덱스**로 이동:

```
최종 counts = [11, 4, 3, 0, 0, 0, 0, 0]

square_sum = 11×0 + 4×1 + 3×4 = 16
square_mean = 16 / 18 ≈ 0.89  (Full 11.72보다 훨씬 작음)

weight_sum = 11×1 + 4×1 + 3×2 = 21
square_weighted = 16 / 21 ≈ 0.76
```

## 4. 시각적 차이

모양은 같고, 패턴만 필터링됩니다.

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

### Layer 1: Base Layer (배경)

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

### Layer 2: Composite Layer (Gradient 색상)

- `value_map`(square_mean 또는 square_weighted)의 값을 Min-Max scaling 해서 0~100 percentile로 변환
- 사용자 정의 color stops(11개) 사이를 선형 보간해서 RGB 결정
- Full/Subset 모두 동일한 로직을 쓰고, **값의 범위만 다르다**

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

**색상 설정 파일:**
- 위치: `logs/color-legends.json`의 `"composite"` 섹션
- 구현: `api/composite_colors.py`의 `load_composite_color_settings` / `save_composite_color_settings`

**Recolor 기능:**
- 합성 값(`square_mean_map` / `square_weighted_map`)과 `calc_mask`, `base_indices`는 그대로 유지
- 색상 스킴만 변경하여 수 초 이내로 빠르게 재색칠 가능
- Full / Subset 모두 동일한 방식으로 적용

## 6. Full vs Subset 색상 차이

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

⇒ **Subset은 "선택한 grade 안에서의 상대적인 위치"를 보여주는 지도**라서,
Full에서 낮아 보이던 포인트가 Subset에서는 꽤 높은 색상으로 보일 수 있다.

## 7. 실제 사용 패턴

- **전체 확인**: Full Map으로 웨이퍼 전체 결함 분포 확인
- **심각도별 분석**: Subset [5, 6, 7]로 심각 결함 핫스팟만 보기
- **두 그룹 비교**: Subset [0, 1] vs [6, 7]로 경미/심각 결함 공간 분포 비교
- **단일 패턴 집중**: Subset [3], [3,4] 등으로 특정 grade 패턴만 분리해서 분석

## 8. 버그 포인트

### 문제

과거에는 Full에서 만든 `calc_mask`를 Subset에 그대로 전달해서 **재계산을 건너뛰는** 코드가 있었음:

```python
# 잘못된 방식 (버그)
_compute_subset_maps_from_counts(
    ...,
    calc_mask,  # ← Full Map의 calc_mask 전달
    ...
)
```

이렇게 하면 `idx_8_mask`, `invalid_mask`가 나중에 달라졌을 때 Full/Subset 유효 영역이 어긋날 수 있음.

### 해결

Subset 호출 시 `only_low_mask=None`을 넘겨서, 항상 원본 `grade_counts` 기준으로 `calc_mask`를 **다시 계산**:

```python
# 올바른 방식
_compute_subset_maps_from_counts(
    ...,
    None,  # ← None 전달
    ...
)

# 함수 내부에서 원본 grade_counts로 재계산
raw_counts_float = grade_counts.astype(np.float32, copy=False)
calc_mask = raw_counts_float.sum(axis=0) > 0
if idx_8_mask is not None:
    calc_mask &= ~idx_8_mask
if invalid_mask is not None:
    calc_mask &= ~invalid_mask
```

이를 통해 Full과 Subset 간 일관성이 유지된다.

---

## 참고: 구현 파일

- `api/composite_map.py` - Full/Subset Map 생성 로직
- `api/composite_colors.py` - 색상 설정 관리
- `logs/color-legends.json` - 색상 스킴 저장소
