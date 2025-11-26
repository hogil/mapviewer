# Subset Grade 처리 방법 상세 설명

## 핵심 원리

**비선택 Grade의 카운트를 0으로 만들어서 계산에서 제외**

```python
# api/composite_map.py:618-629 (_compute_subset_maps_from_counts)

# 1. 원본 grade_counts 복사
counts_float = grade_counts.astype(np.float32, copy=True)

# 2. 선택되지 않은 grade → 0으로 변경
all_grades = set(range(8))              # {0, 1, 2, 3, 4, 5, 6, 7}
target_grades = set(selected_grades)    # 예: {1, 3, 5}
grades_to_zero = list(all_grades - target_grades)  # [0, 2, 4, 6, 7]

if grades_to_zero:
    counts_float[grades_to_zero, :, :] = 0.0  # 카운트를 0으로!
```

## 구체적 예시

### 상황 설정
- **3개 이미지** 분석
- **포인트 (100, 200)** 에서의 처리

### 원본 데이터 (grade_counts)
```
포인트 (100, 200)에서 각 이미지의 grade:
  Image 1: grade 0
  Image 2: grade 1
  Image 3: grade 2

grade_counts[:, 100, 200] = [1, 1, 1, 0, 0, 0, 0, 0]
                            └─┴─┴─└─────────────────┘
                            0 1 2  3 4 5 6 7 (grade)
```

---

## Case 1: Full Map (모든 Grade)

### Step 1: Grade Counts (그대로 사용)
```python
counts = [1, 1, 1, 0, 0, 0, 0, 0]
```

### Step 2: Square Sum 계산
```python
square_weights = [0², 1², 2², 3², 4², 5², 6², 7²]
               = [0,  1,  4,  9, 16, 25, 36, 49]

square_sum = Σ (counts × square_weights)
           = 1×0 + 1×1 + 1×4 + 0×9 + 0×16 + 0×25 + 0×36 + 0×49
           = 0 + 1 + 4 + 0 + 0 + 0 + 0 + 0
           = 5
```

### Step 3: Square Average
```python
square_mean = square_sum / image_count
            = 5 / 3
            = 1.67
```

### Step 4: Square Weighted Average
```python
weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]

weight_sum = Σ (counts × weight_factors)
           = 1×1 + 1×1 + 1×2 + 0×3 + 0×4 + 0×5 + 0×6 + 0×7
           = 1 + 1 + 2 + 0 + 0 + 0 + 0 + 0
           = 4

square_weighted = square_sum / weight_sum
                = 5 / 4
                = 1.25
```

---

## Case 2: Subset [1, 2] 선택

### Step 1: Grade Counts 수정
```python
# 원본
original_counts = [1, 1, 1, 0, 0, 0, 0, 0]

# Grade 0을 0으로 변경
selected_grades = [1, 2]
grades_to_zero = [0, 3, 4, 5, 6, 7]

counts_float[0, :, :] = 0.0  # grade 0 → 0
counts_float[3:, :, :] = 0.0  # grade 3-7 → 0

# 수정된 counts
counts = [0, 1, 1, 0, 0, 0, 0, 0]
        └─┴─┴─└─────────────────┘
        ✗ ✓ ✓  ✗ ✗ ✗ ✗ ✗
```

### Step 2: Square Sum 계산
```python
square_weights = [0, 1, 4, 9, 16, 25, 36, 49]

square_sum = 0×0 + 1×1 + 1×4 + 0×9 + 0×16 + 0×25 + 0×36 + 0×49
           = 0 + 1 + 4 + 0 + 0 + 0 + 0 + 0
           = 5
```

### Step 3: Square Average
```python
square_mean = 5 / 3 = 1.67  (동일!)
```

### Step 4: Square Weighted Average
```python
weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]

weight_sum = 0×1 + 1×1 + 1×2 + 0×3 + 0×4 + 0×5 + 0×6 + 0×7
           = 0 + 1 + 2 + 0 + 0 + 0 + 0 + 0
           = 3

square_weighted = 5 / 3 = 1.67
```

---

## Case 3: Subset [1] 만 선택

### Step 1: Grade Counts 수정
```python
selected_grades = [1]
grades_to_zero = [0, 2, 3, 4, 5, 6, 7]

counts = [0, 1, 0, 0, 0, 0, 0, 0]
        └─┴─┴─└─────────────────┘
        ✗ ✓ ✗  ✗ ✗ ✗ ✗ ✗
```

### Step 2: Square Sum 계산
```python
square_sum = 0×0 + 1×1 + 0×4 + ...
           = 0 + 1 + 0 + 0 + 0 + 0 + 0 + 0
           = 1  ← 작아짐!
```

### Step 3: Square Average
```python
square_mean = 1 / 3 = 0.33  ← 작아짐!
```

### Step 4: Square Weighted Average
```python
weight_sum = 0×1 + 1×1 + 0×2 + ...
           = 1

square_weighted = 1 / 1 = 1.00
```

---

## Case 4: Subset [0] 만 선택

### Step 1: Grade Counts 수정
```python
selected_grades = [0]
counts = [1, 0, 0, 0, 0, 0, 0, 0]
```

### Step 2: Square Sum 계산
```python
square_sum = 1×0 + 0×1 + 0×4 + ...
           = 0  ← 0!
```

### Step 3: Square Average
```python
square_mean = 0 / 3 = 0  ← 최소값!
```

---

## 값 범위가 줄어드는 이유

### Full Map (모든 Grade)
```
가능한 값의 범위:
- 최소: grade 0만 → 0² = 0
- 최대: grade 7만 → 7² = 49
- 범위: 0 ~ 49
```

### Subset [1, 3] 선택
```
가능한 값의 범위:
- 최소: grade 1만 → 1² = 1
- 최대: grade 3만 → 3² = 9
- 범위: 0 ~ 9  (좁아짐!)

왜 0도 포함?
→ 다른 포인트에서 grade 1, 3이 없으면 0
```

### Subset [7] 선택
```
가능한 값의 범위:
- 최소: grade 7 없음 → 0
- 최대: grade 7만 → 7² = 49
- 범위: 0 ~ 49  (Full과 동일할 수도!)
```

---

## 실제 코드 동작 흐름

### 1. Full Map 생성 (create_composite_heatmaps)
```python
# Line 859-861
grade_counts = np.zeros((8, height, width), dtype=np.uint16)
for idx in range(8):
    grade_counts[idx] = np.count_nonzero(stacked_indices == idx, axis=0)

# 저장 (Line 606)
_persist_square_map_data(..., grade_counts=grade_counts, ...)
```

### 2. Subset Map 생성 (create_subset_square_maps)
```python
# Line 733: 캐시에서 로드
grade_counts = data["grade_counts"]  # Full Map의 counts

# Line 745-752: 선택 grade만 계산
square_mean_map, weighted_map, calc_mask, weighted_mask = _compute_subset_maps_from_counts(
    grade_counts,         # 원본 counts
    normalized_grades,    # 예: [1, 3, 5]
    invalid_mask,
    idx_8_mask,
    only_low_mask,
    source_image_count,
)
```

### 3. _compute_subset_maps_from_counts 내부
```python
# Line 620: 복사
counts_float = grade_counts.astype(np.float32, copy=True)

# Line 628-629: 비선택 grade → 0
grades_to_zero = [0, 2, 4, 6, 7]  # 예시
counts_float[grades_to_zero, :, :] = 0.0

# Line 634-638: 동일한 수식으로 계산
square_weights = (np.arange(8) ** 2).reshape(8, 1, 1)
square_sums = np.sum(counts_float * square_weights, axis=0)

weight_factors = [1, 1, 2, 3, 4, 5, 6, 7]
weight_map_sum = np.sum(counts_float * weight_factors, axis=0)
```

---

## 전체 맵에서의 효과

### Full Map
```
전체 포인트의 값 분포:
Min: 0.00
Max: 48.75
Mean: 12.34
Std: 15.67

→ 넓은 범위, 다양한 값
```

### Subset [1, 3, 5]
```
전체 포인트의 값 분포:
Min: 0.00
Max: 8.21
Mean: 2.45
Std: 3.12

→ 좁은 범위, 낮은 값
```

---

## 시각적 비교

### Full Map (모든 Grade)
```
포인트별 값:
┌───────────────────┐
│  0  1  5  12  25  │  Grade 0-7 모두 반영
│  2  8  15  20  30 │  → 큰 값들
│  3  10  18  22  35│
│  5  12  20  28  40│
│  8  15  25  35  49│  Max: 49
└───────────────────┘
```

### Subset [1, 3] (일부 Grade)
```
포인트별 값:
┌───────────────────┐
│  0  1  2   3   4  │  Grade 1, 3만 반영
│  0  1  3   4   5  │  → 작은 값들
│  1  2  4   5   6  │
│  1  3  5   6   7  │
│  2  3  6   7   9  │  Max: 9
└───────────────────┘
```

---

## 요약

| 단계 | Full Map | Subset Map |
|------|----------|------------|
| **1. Counts** | 모든 grade 사용 | 비선택 grade → 0 |
| **2. Square Sum** | 큰 가중치 반영 (49까지) | 작은 가중치만 (9까지) |
| **3. 나누기** | 동일한 분모 | 동일한 분모 |
| **4. 결과 범위** | 넓음 (0~49) | 좁음 (0~9) |
| **5. Percentile** | 전역 기준 | 상대적 기준 |
| **6. 색상** | 진한 색상 | 연한 색상 |

**핵심:**
- 비선택 grade의 counts를 0으로 만들면
- Square sum이 작아지고
- 결과적으로 값의 범위가 좁아짐
- Percentile 계산 시 상대적으로 높은 %가 나옴
- 같은 포인트가 더 밝은 색상으로 표현됨
