# Composite Map 성능 최적화 방안

## 📊 현재 성능 분석 (10개 이미지, 7788×7788)

```
전체 처리 시간: 16.95초
├─ 이미지 로딩: 10.53초 (62%) ← 병목 1
├─ 저장 시간:   5.92초  (35%) ← 병목 2
└─ 기타:        0.5초   (3%)
```

## 🚀 최적화 방안

### 1. 이미지 로딩 최적화 (10.53초 → 목표: 5-6초)

#### 1-1. pyvips 사용 (2-3배 빠름)
**현재**: PIL 사용
**개선**: pyvips 사용

```python
# 현재 (PIL)
with Image.open(full_path) as img:
    pixel_indices = np.array(img, dtype=np.uint8)

# 개선 (pyvips)
img = pyvips.Image.new_from_file(str(full_path), access='sequential')
pixel_indices = np.ndarray(
    buffer=img.write_to_memory(),
    dtype=np.uint8,
    shape=(img.height, img.width)
)
```

**예상 효과**: 10.53초 → 4-5초 (50-60% 개선)

#### 1-2. 워커 수 증가
**현재**: `cpu_count * 1.5` (약 6-12개)
**개선**: `cpu_count * 2` 또는 `min(16, len(image_paths))`

```python
# 현재
optimal_workers = int(cpu_count * 1.5)

# 개선
optimal_workers = min(cpu_count * 2, 16, len(image_paths))
```

**예상 효과**: 5-10% 추가 개선

#### 1-3. 배치 크기 최적화
**현재**: batch_size=2
**개선**: batch_size=4-8 (메모리 여유 시)

```python
# 현재
effective_batch = max(1, batch_size or 2)

# 개선
effective_batch = max(1, batch_size or 4)  # 메모리 여유 시 8
```

**예상 효과**: 5-10% 개선

---

### 2. 저장 최적화 (5.92초 → 목표: 3-4초)

#### 2-1. 병렬 저장
**현재**: 순차 저장 (8개 히트맵)
**개선**: ThreadPoolExecutor로 병렬 저장

```python
# 현재
for pos, idx in enumerate(indices):
    heatmap_img.save(heatmap_path, ...)

# 개선
def save_heatmap(args):
    pos, idx, normalized, gradient_palettes, output_dir = args
    heatmap_img = Image.fromarray(normalized, mode='P')
    heatmap_img.putpalette(gradient_palettes[idx])
    heatmap_path = output_dir / f"index_{idx}.png"
    heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=1)
    return heatmap_path

with ThreadPoolExecutor(max_workers=4) as executor:
    futures = [
        executor.submit(save_heatmap, (pos, idx, normalized, ...))
        for pos, idx in enumerate(indices) if idx < 8
    ]
    for future in as_completed(futures):
        future.result()
```

**예상 효과**: 5.92초 → 2-3초 (50% 개선)

#### 2-2. PNG 압축 레벨 조정
**현재**: compress_level=1
**개선**: compress_level=0 (압축 없음, 더 빠름)

```python
# 현재
heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=1)

# 개선
heatmap_img.save(heatmap_path, format='PNG', optimize=False, compress_level=0)
```

**예상 효과**: 10-15% 추가 개선

---

### 3. 배치 누적 최적화

#### 3-1. 벡터화 연산 개선
**현재**: 이중 루프 (이미지 × 인덱스)
**개선**: NumPy 브로드캐스팅 활용

```python
# 현재 (느림)
for pixel_indices in batch_pixels:
    for i, pos in enumerate(valid_positions):
        idx = idx_array[pos]
        mask = (pixel_indices == idx)
        counts[pos] += mask.astype(np.uint32)

# 개선 (빠름)
stack = np.stack(batch_pixels, axis=0)  # (batch, H, W)
for i, pos in enumerate(valid_positions):
    idx = idx_array[pos]
    masks = (stack == idx)  # (batch, H, W)
    counts[pos] += masks.sum(axis=0, dtype=np.uint32)
```

**주의**: 메모리 사용량 증가 (배치 크기 조정 필요)

**예상 효과**: 10-20% 개선 (배치 크기=4일 때)

---

### 4. 메모리 최적화

#### 4-1. 조기 메모리 해제
```python
# 이미지 처리 후 즉시 해제
for img_path, pixel_indices in pixel_loader:
    # ... 처리 ...
    del pixel_indices  # 명시적 해제
```

#### 4-2. 불필요한 복사 제거
```python
# 현재
all_indices_list.append(pixel_indices.astype(np.uint8))

# 개선 (이미 uint8이면 복사 불필요)
if pixel_indices.dtype != np.uint8:
    all_indices_list.append(pixel_indices.astype(np.uint8))
else:
    all_indices_list.append(pixel_indices)
```

---

## 📈 예상 성능 개선

### 최적화 적용 전
```
전체: 16.95초
├─ 로딩: 10.53초
└─ 저장:  5.92초
```

### 최적화 적용 후 (목표)
```
전체: 8-10초 (40-50% 개선)
├─ 로딩: 4-5초  (pyvips + 워커 증가)
└─ 저장:  2-3초  (병렬 저장 + 압축 레벨 0)
```

---

## 🎯 우선순위별 적용

### Phase 1: 빠른 효과 (즉시 적용 가능)
1. ✅ pyvips 사용 (로딩 50% 개선)
2. ✅ 병렬 저장 (저장 50% 개선)
3. ✅ PNG compress_level=0 (저장 10% 추가)

**예상**: 16.95초 → 9-10초

### Phase 2: 추가 최적화
4. 워커 수 증가
5. 배치 크기 조정
6. 벡터화 연산 개선

**예상**: 9-10초 → 7-8초

---

## 💡 추가 고려사항

### SSD vs HDD
- **SSD**: 병렬 I/O 효과 큼
- **HDD**: 순차 I/O 권장 (워커 수 감소)

### 메모리 제약
- 배치 크기 조정 필요
- 벡터화 연산은 메모리 사용량 증가

### 이미지 크기별 최적화
- **작은 이미지** (< 2000×2000): 배치 크기 증가
- **큰 이미지** (> 5000×5000): 배치 크기 감소, 워커 수 증가


