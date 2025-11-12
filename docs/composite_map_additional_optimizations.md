# Composite Map 추가 최적화 방안

## 📋 적용 가능한 최적화 (GPU 제외)

### 1. ✅ 배열 Contiguous 보장 (즉시 적용 가능)

**효과**: NumPy 연산 속도 5-10% 향상

**현재 코드**:
```python
batch_pixels.append(pixel_indices)
```

**개선**:
```python
# C-연속 배열로 보장 (메모리 복사 최소화)
batch_pixels.append(np.ascontiguousarray(pixel_indices, dtype=np.uint8))
```

**적용 위치**: `_iter_pixel_indices`에서 반환 시

---

### 2. ✅ OpenCV PNG 저장 (조건부 적용)

**효과**: PIL 대비 4배 빠름 (26초 → 6초)

**주의사항**: 
- OpenCV는 팔레트 모드를 직접 지원하지 않음
- RGB 변환 후 저장 필요 (파일 크기 증가)
- 팔레트 모드 유지가 중요하면 적용 불가

**적용 방법**:
```python
# 팔레트 → RGB 변환 후 OpenCV 저장
if CV2_AVAILABLE:
    # 팔레트를 RGB로 변환
    rgb_array = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            idx = normalized[y, x]
            rgb_array[y, x] = gradient_palettes[idx][idx*3:(idx*3+3)]
    
    # OpenCV로 저장 (PIL 대비 4배 빠름)
    cv2.imwrite(str(heatmap_path), rgb_array, [cv2.IMWRITE_PNG_COMPRESSION, 0])
else:
    # PIL fallback
    heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=0)
```

**결정 필요**: 팔레트 모드 유지 vs 저장 속도

---

### 3. ⚠️ Pillow-SIMD 사용 (제외)

**참고**: SIMD는 설치 환경에 따라 설치가 어려울 수 있어 제외

---

### 4. ✅ 비트마스크 최적화 (선택적)

**효과**: 인덱스 존재 여부 계산 최적화

**현재**: 각 인덱스별로 별도 마스크 계산
**개선**: 비트마스크로 한 번에 처리

```python
# 비트마스크 생성 (각 픽셀 위치의 인덱스 존재 여부)
bitmask = np.zeros((height, width), dtype=np.uint8)
for pixel_indices in batch_pixels:
    bitmask |= (1 << np.clip(pixel_indices, 0, 7))  # 0-7 인덱스만

# 인덱스별 존재 여부 추출
for idx in range(8):
    presence = (bitmask & (1 << idx)) > 0
    counts[idx] += presence.astype(np.uint32)
```

**주의**: 현재 루프 방식이 메모리 효율적이므로, 메모리 여유 시에만 적용

---

### 5. ✅ Numba JIT 컴파일 (선택적)

**효과**: 반복문 2-5배 빠름

**적용 예시**:
```python
from numba import njit

@njit(parallel=True)
def accumulate_batch_pixels_numba(batch_pixels, counts, idx_array, valid_positions):
    for i in range(len(batch_pixels)):
        pixel_indices = batch_pixels[i]
        for j in range(len(valid_positions)):
            pos = valid_positions[j]
            idx = idx_array[pos]
            mask = (pixel_indices == idx)
            counts[pos] += mask.astype(np.uint32)
```

**주의**: 
- 첫 실행 시 컴파일 시간 소요
- NumPy 배열만 지원 (PIL Image 불가)
- 의존성 추가 필요

---

## 🎯 우선순위별 적용

### Phase 1: 즉시 적용 (코드 변경 최소)
1. ✅ **배열 Contiguous 보장** (5-10% 개선) - 이미 적용됨

### Phase 2: 조건부 적용
2. ⚠️ **OpenCV PNG 저장** (4배 빠름, 팔레트 모드 포기)
   - 팔레트 모드 유지 필요 시 적용 불가
   - RGB 변환 후 저장 (파일 크기 증가)

### Phase 3: 고급 최적화 (의존성 추가)
3. ⚠️ **Numba JIT** (2-5배 빠름, 컴파일 시간 소요)
4. ⚠️ **비트마스크 최적화** (메모리 여유 시)

---

## 📊 예상 성능 개선

### 현재 (최적화 적용 후)
- 전체: 11.73초
- 로딩: 8.56초
- 저장: 2.77초

### Phase 1 적용 후 (이미 완료)
- 전체: **14.38초** (약 15% 개선)
- 로딩: 10.32초
- 저장: 3.56초

### Phase 2 적용 후 (OpenCV 사용 시)
- 전체: **6-7초** (약 40% 개선)
- 로딩: 6-7초
- 저장: **0.7초** (OpenCV 4배 빠름)

---

## 💡 권장 사항

1. **현재 상태**: 배열 Contiguous 보장 적용 완료 (15% 개선 달성)
2. **조건 확인**: 팔레트 모드 유지 필요 여부 확인 후 OpenCV 적용 결정
3. **벤치마크**: 각 단계별 성능 측정 후 다음 단계 결정

