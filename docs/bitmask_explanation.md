# 비트마스크 방식 설명

## 비트마스크란?

비트마스크는 **각 비트(bit)를 플래그로 사용**하는 기법입니다. 8비트(1바이트)로 8가지 상태를 표현할 수 있습니다.

### 예시: 인덱스 0~7 추적

각 픽셀에서 어떤 인덱스(0~7)가 등장했는지를 8비트로 표현:

```
비트 위치:  7  6  5  4  3  2  1  0
인덱스:     7  6  5  4  3  2  1  0
```

**예시 1**: 인덱스 0, 5, 7이 등장했다면
```
비트마스크 = 1<<0 | 1<<5 | 1<<7
           = 0b10100001
           = 161 (십진수)
```

**예시 2**: 인덱스 2, 3이 등장했다면
```
비트마스크 = 1<<2 | 1<<3
           = 0b00001100
           = 12 (십진수)
```

## 현재 방식 vs 비트마스크 방식

### 현재 방식 (카운트 배열)

```python
# 각 이미지를 읽으면서
for image in images:
    pixel_indices = load_image(image)  # 49MB
    
    # 각 인덱스별로 카운트 누적
    for idx in range(8):
        mask = (pixel_indices == idx)
        counts[idx] += mask.astype(np.uint32)
    
    # Sum Map을 위해 모든 인덱스를 저장
    all_indices_list.append(pixel_indices)  # 49MB × 이미지 수

# Sum Map 계산: 모든 이미지 스택
all_indices = np.stack(all_indices_list)  # 490MB (10개 이미지)
sum_map = np.median(all_indices, axis=0)
```

**메모리 사용량**:
- `counts`: 8 × 49MB = 392MB
- `all_indices_list`: 49MB × 이미지 수 (10개 = 490MB)
- **총합**: 약 2,545MB (10개 이미지 기준)

### 비트마스크 방식

```python
# presence_map: 각 픽셀에서 등장한 인덱스를 비트마스크로 저장
presence_map = np.zeros((height, width), dtype=np.uint8)  # 49MB

# 각 이미지를 읽으면서
for image in images:
    pixel_indices = load_image(image)  # 49MB
    
    # 비트마스크 누적 (인덱스 0~7만)
    low_mask = (pixel_indices < 8)
    low_indices = pixel_indices[low_mask]
    
    # 각 픽셀의 인덱스를 비트 플래그로 변환
    bit_flags = np.zeros((height, width), dtype=np.uint8)
    bit_flags[low_mask] = (1 << low_indices).astype(np.uint8)
    
    # 비트 OR 연산으로 누적
    presence_map |= bit_flags

# LUT 생성: 각 비트마스크 패턴(0~255)에 대한 중앙값 미리 계산
lut = np.zeros(256, dtype=np.uint8)
for mask in range(256):
    cats = [i for i in range(8) if mask & (1 << i)]  # 설정된 비트 추출
    if cats:
        cats.sort()
        mid = (len(cats) - 1) // 2
        lut[mask] = cats[mid]

# Sum Map 생성: LUT 조회 (한 줄!)
sum_map = lut[presence_map]
```

**메모리 사용량**:
- `presence_map`: 49MB (고정)
- `lut`: 256 bytes (무시 가능)
- **총합**: 약 173MB

## 비트마스크로 인덱스별 히트맵 생성 (가능!)

### ✅ 사용자 제안: Presence 기반 히트맵

비트마스크는 카운트는 제공하지 않지만, **presence 여부만 확인하면 되는 히트맵은 생성 가능**합니다!

### 로직

1. **동일 포인트 내에 인덱스 0-7만 있는 경우**:
   - 특정 인덱스가 있으면 → 그 인덱스로 표시
   - 없으면 → 인덱스 31로 변경

2. **동일 포인트 내에 인덱스 8 이상이 있으면**:
   - 인덱스 종류 중 max 값 사용

### 구현 코드

```python
def create_heatmap_from_bitmask(
    presence_map: np.ndarray,
    high_mask_combined: np.ndarray,
    high_indices_combined: np.ndarray,
    target_idx: int
) -> np.ndarray:
    """비트마스크 기반 인덱스별 히트맵 생성"""
    result = np.zeros_like(presence_map, dtype=np.uint8)
    
    # 1. 인덱스 8 이상이 있는 픽셀: max 값 사용
    if np.any(high_mask_combined):
        result[high_mask_combined] = high_indices_combined[high_mask_combined]
    
    # 2. 인덱스 0-7만 있는 픽셀 처리
    low_only_mask = ~high_mask_combined
    
    if np.any(low_only_mask):
        target_bit = 1 << target_idx
        has_target = (presence_map & target_bit) != 0
        
        # 타겟 인덱스가 있으면 그 인덱스로
        low_only_pixels = low_only_mask & has_target
        result[low_only_pixels] = target_idx
        
        # 타겟 인덱스가 없으면 인덱스 31로
        low_only_no_target = low_only_mask & ~has_target
        result[low_only_no_target] = 31
    
    return result
```

### 예시

```python
# presence_map에서 인덱스 0, 2, 5가 등장 (0b10100001)
presence_map[50, 50] = (1 << 0) | (1 << 2) | (1 << 5)

# 인덱스 0의 히트맵
heatmap_0 = create_heatmap_from_bitmask(...)
# → [50, 50] 위치: 인덱스 0 (presence 있음)
# → [0, 0] 위치: 인덱스 31 (presence 없음)

# 인덱스 1의 히트맵
heatmap_1 = create_heatmap_from_bitmask(...)
# → [50, 50] 위치: 인덱스 31 (presence 없음)
```

### 기존 방식과의 차이

**기존 방식 (카운트 기반)**:
- 각 인덱스가 몇 번 등장했는지 카운트
- 빈도에 따라 그라데이션 (0회 → 흰색, 최대 → 원본 색상)
- 정확한 통계 제공

**비트마스크 방식 (Presence 기반)**:
- 각 인덱스가 등장했는지만 확인 (있음/없음)
- 있으면 해당 인덱스, 없으면 31
- 카운트 정보 없음 (빈도 반영 불가)

### 해결 방법

#### 방법 1: 하이브리드 방식 (권장)

비트마스크로 Sum Map을 빠르게 계산하고, 별도로 카운트 배열을 유지:

```python
presence_map = np.zeros((height, width), dtype=np.uint8)  # Sum Map용
counts = np.zeros((8, height, width), dtype=np.uint32)    # 히트맵용

for image in images:
    pixel_indices = load_image(image)
    
    # 비트마스크 누적 (Sum Map용)
    bit_flags = (1 << pixel_indices).astype(np.uint8)
    presence_map |= bit_flags
    
    # 카운트 누적 (히트맵용)
    for idx in range(8):
        counts[idx] += (pixel_indices == idx).astype(np.uint32)

# Sum Map: LUT 사용 (빠름)
sum_map = lut[presence_map]

# 히트맵: 카운트 사용 (정확함)
for idx in range(8):
    heatmap = create_heatmap(counts[idx], max_count)
```

**장점**:
- Sum Map은 빠르게 계산 (LUT 사용)
- 히트맵도 정확하게 생성 가능
- 현재 방식보다 1.19배 빠름

**단점**:
- 메모리 사용량이 큼 (카운트 배열 필요)

#### 방법 2: 비트마스크만 사용 (Sum Map만 필요한 경우)

히트맵이 필요 없고 Sum Map만 필요한 경우:

```python
# 비트마스크만 사용
presence_map = np.zeros((height, width), dtype=np.uint8)

for image in images:
    pixel_indices = load_image(image)
    bit_flags = (1 << pixel_indices).astype(np.uint8)
    presence_map |= bit_flags

# Sum Map만 생성
sum_map = lut[presence_map]
```

**장점**:
- 매우 빠름 (3.48배)
- 메모리 절감 (93.2%)

**단점**:
- 히트맵 생성 불가능

#### 방법 3: 근사치 히트맵 (권장하지 않음)

비트마스크에서 presence 여부만 확인하여 근사치 히트맵 생성:

```python
# presence 여부만 확인 (정확한 카운트는 아님)
for idx in range(8):
    bit_flag = 1 << idx
    presence = (presence_map & bit_flag) != 0
    
    # presence가 있으면 최대값, 없으면 0
    # (실제 카운트와는 다름!)
    approximate_count = presence.astype(np.uint8) * 255
    heatmap = Image.fromarray(approximate_count, mode='P')
```

**문제점**:
- 정확한 빈도를 반영하지 못함
- 모든 presence 픽셀이 동일한 강도로 표시됨

## 결론

### 비트마스크 방식이 적합한 경우

✅ **Sum Map + Presence 기반 히트맵이 필요한 경우**
- 비트마스크 + LUT로 Sum Map 매우 빠르게 계산
- Presence 기반 히트맵도 빠르게 생성 가능
- 메모리 사용량 극도로 적음 (93.2% 절감)
- **단, 카운트 기반 그라데이션 히트맵은 불가능**

### 하이브리드 방식이 적합한 경우

✅ **Sum Map + 카운트 기반 히트맵이 필요한 경우**
- 비트마스크로 Sum Map 빠르게 계산
- 카운트 배열로 정확한 빈도 기반 히트맵 생성
- 현재 방식보다 빠르면서도 정확함

### 현재 방식이 적합한 경우

✅ **단순하고 검증된 방식이 필요한 경우**
- 모든 기능 정확하게 동작
- 메모리와 속도가 크게 중요하지 않은 경우

## 실제 코드 예시

### 비트마스크로 Sum Map 생성

```python
import numpy as np

# presence_map 초기화
presence_map = np.zeros((7000, 7000), dtype=np.uint8)

# 각 이미지 처리
for pixel_indices in image_arrays:
    # 인덱스 0~7만 처리
    low_mask = (pixel_indices < 8)
    low_indices = pixel_indices[low_mask]
    
    # 비트 플래그 생성
    bit_flags = np.zeros_like(presence_map)
    bit_flags[low_mask] = (1 << low_indices).astype(np.uint8)
    
    # 비트 OR 누적
    presence_map |= bit_flags

# LUT 생성
lut = np.zeros(256, dtype=np.uint8)
for mask in range(256):
    if mask == 0:
        lut[mask] = 7
    else:
        cats = [i for i in range(8) if mask & (1 << i)]
        cats.sort()
        mid = (len(cats) - 1) // 2
        lut[mask] = cats[mid]

# Sum Map 생성 (한 줄!)
sum_map = lut[presence_map]
```

### 하이브리드 방식으로 Sum Map + 히트맵 생성

```python
presence_map = np.zeros((7000, 7000), dtype=np.uint8)
counts = np.zeros((8, 7000, 7000), dtype=np.uint32)

for pixel_indices in image_arrays:
    # 비트마스크 누적
    low_mask = (pixel_indices < 8)
    bit_flags = np.zeros_like(presence_map)
    bit_flags[low_mask] = (1 << pixel_indices[low_mask]).astype(np.uint8)
    presence_map |= bit_flags
    
    # 카운트 누적
    for idx in range(8):
        counts[idx] += (pixel_indices == idx).astype(np.uint32)

# Sum Map (빠름)
sum_map = lut[presence_map]

# 히트맵 (정확함)
max_count = np.max(counts)
for idx in range(8):
    normalized = (counts[idx] / max_count * 255).astype(np.uint8)
    heatmap = Image.fromarray(normalized, mode='P')
    heatmap.putpalette(gradient_palette)
```

## 요약

| 방식 | Sum Map | 히트맵 | 히트맵 타입 | 속도 | 메모리 |
|------|---------|--------|-------------|------|--------|
| 비트마스크만 | 가능 (빠름) | 가능 | Presence 기반 (있음/없음) | 3.48배 | 93.2% 절감 |
| 하이브리드 | 가능 (빠름) | 가능 | 카운트 기반 (빈도) | 1.19배 | 20.5% 절감 |
| 현재 방식 | 가능 | 가능 | 카운트 기반 (빈도) | 1.0배 | 기준 |

### 히트맵 타입 설명

- **Presence 기반**: 인덱스가 등장했는지만 확인 (있음/없음)
  - 있으면 해당 인덱스, 없으면 31
  - 카운트 정보 없음 (빈도 반영 불가)
  
- **카운트 기반**: 인덱스가 등장한 횟수(빈도)를 반영
  - 0회 → 흰색, 최대 → 원본 색상 (그라데이션)
  - 정확한 통계 제공

## 최종 결론

✅ **비트마스크 방식으로 Sum Map과 인덱스별 히트맵 모두 생성 가능합니다!**

- Sum Map: LUT 기반 (매우 빠름)
- 히트맵: Presence 기반 (빠름)
- 메모리: 93.2% 절감
- 속도: 3.48배 향상

다만, 카운트 기반 그라데이션 히트맵이 필요한 경우에는 하이브리드 방식을 사용해야 합니다.

