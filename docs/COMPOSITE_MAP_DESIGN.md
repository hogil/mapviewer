# 🎨 Composite Map 설계 문서

## 개요

Composite Map은 여러 웨이퍼 맵의 defect 패턴 빈도를 히트맵으로 시각화하는 기능입니다.

## 📊 기본 개념

### 입력
- Grid 모드에서 선택한 N개 이미지 (예: 100개 웨이퍼 맵)
- 각 이미지는 픽셀 값으로 인덱스(0~7) 표현

### 처리
- 각 픽셀 위치에서 인덱스 0~7별 출현 횟수 카운트
- 동일 좌표에서 각 인덱스가 몇 번 나타나는지 통계

### 출력
- 8개의 히트맵 이미지 (인덱스별)
- 색상: 0개(흰색) → N개(빨간색) 그라데이션

## 🔍 처리 예시

```
100개 웨이퍼 맵 선택:
- wafer_001.png
- wafer_002.png
- ...
- wafer_100.png

픽셀값 → 인덱스 매핑:
- 0~31 → 인덱스 0
- 32~63 → 인덱스 1
- 64~95 → 인덱스 2
- 96~127 → 인덱스 3
- 128~159 → 인덱스 4
- 160~191 → 인덱스 5
- 192~223 → 인덱스 6
- 224~255 → 인덱스 7

좌표(100, 200)에서 분석:
이미지 1: 픽셀값 50 → 인덱스 1
이미지 2: 픽셀값 45 → 인덱스 1
이미지 3: 픽셀값 150 → 인덱스 4
...
이미지 100: 픽셀값 55 → 인덱스 1

결과:
- 인덱스 0: 5번 출현
- 인덱스 1: 78번 출현 ← 가장 많음!
- 인덱스 2: 3번 출현
- 인덱스 3: 0번
- 인덱스 4: 12번 출현
- 인덱스 5: 1번
- 인덱스 6: 0번
- 인덱스 7: 1번
```

## 📐 시스템 아키텍처

### 1. Frontend (js/main.js)

#### UI 컴포넌트
```javascript
// Grid Controls에 버튼 추가
<button id="generate-composite-btn" class="grid-btn">
    🔥 Composite Map
</button>
```

#### 이벤트 핸들러
```javascript
async generateCompositeMap() {
    const selectedPaths = this.getSelectedImagePaths();

    if (selectedPaths.length < 2) {
        alert('최소 2개 이상 이미지를 선택하세요');
        return;
    }

    // 진행 상황 모달 표시
    this.showProgressModal('Composite Map 생성 중...', 0);

    try {
        const response = await fetch('/api/composite-map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image_paths: selectedPaths,
                indices: [0, 1, 2, 3, 4, 5, 6, 7]
            })
        });

        const result = await response.json();

        // 결과 표시 (모달 또는 그리드에 추가)
        this.displayCompositeResults(result);

    } catch (error) {
        console.error('Composite map 생성 실패:', error);
        alert('Composite map 생성 중 오류 발생');
    } finally {
        this.hideProgressModal();
    }
}
```

### 2. Backend API (api/main.py)

```python
@app.post("/api/composite-map")
async def generate_composite_map(request: Request):
    """
    Generate composite heatmaps from multiple wafer maps

    Request body:
    {
        "image_paths": ["path1.png", "path2.png", ...],
        "indices": [0, 1, 2, 3, 4, 5, 6, 7]
    }

    Returns:
    {
        "output_dir": "composite_maps/20250110_143022",
        "heatmaps": [
            {"index": 0, "path": "...", "max_count": 85},
            {"index": 1, "path": "...", "max_count": 92},
            ...
        ],
        "total_images": 100,
        "processing_time": 12.5
    }
    """
    data = await request.json()
    image_paths = data.get("image_paths", [])
    indices = data.get("indices", list(range(8)))

    if len(image_paths) < 2:
        raise HTTPException(400, "최소 2개 이상 이미지 필요")

    # Composite map 생성
    result = await create_composite_heatmaps(image_paths, indices)

    return JSONResponse(result)
```

### 3. Core Processing (api/composite_map.py - 새 파일)

#### 데이터 구조
```python
# 메모리 레이아웃
# 100개 이미지, 각 2000x2000 픽셀이라면:

counts = {
    0: np.zeros((2000, 2000), dtype=np.uint16),  # 인덱스 0 카운트
    1: np.zeros((2000, 2000), dtype=np.uint16),  # 인덱스 1 카운트
    2: np.zeros((2000, 2000), dtype=np.uint16),
    3: np.zeros((2000, 2000), dtype=np.uint16),
    4: np.zeros((2000, 2000), dtype=np.uint16),
    5: np.zeros((2000, 2000), dtype=np.uint16),
    6: np.zeros((2000, 2000), dtype=np.uint16),
    7: np.zeros((2000, 2000), dtype=np.uint16),
}

# 메모리 사용량: 8 × 2000 × 2000 × 2 bytes = 64MB
# (uint16는 0~65535까지 표현 가능, 충분함)
```

#### 메인 함수
```python
async def create_composite_heatmaps(image_paths: list, indices: list):
    """
    메인 composite map 생성 함수
    """
    start_time = time.time()

    # 1. 출력 디렉토리 생성
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = IMAGES_ROOT / "composite_maps" / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    # 2. 첫 번째 이미지에서 크기 확인
    first_img = Image.open(IMAGES_ROOT / image_paths[0])
    width, height = first_img.size
    first_img.close()

    # 3. 카운트 배열 초기화 (메모리 효율적)
    counts = {idx: np.zeros((height, width), dtype=np.uint16)
              for idx in indices}

    # 4. 각 이미지 순회하며 카운트
    for img_path in image_paths:
        accumulate_pixel_counts(IMAGES_ROOT / img_path, counts, indices)

    # 5. 히트맵 생성
    heatmaps = []
    max_count = len(image_paths)

    for idx in indices:
        heatmap_path = output_dir / f"index_{idx}.png"
        actual_max = np.max(counts[idx])

        # 색상 매핑 및 이미지 생성
        heatmap_img = generate_heatmap_image(
            counts[idx],
            max_count=max_count,
            colormap='hot'
        )

        heatmap_img.save(heatmap_path)

        heatmaps.append({
            "index": idx,
            "path": str(heatmap_path.relative_to(IMAGES_ROOT)),
            "max_count": int(actual_max),
            "percentage": round(actual_max / max_count * 100, 1)
        })

    processing_time = time.time() - start_time

    return {
        "output_dir": str(output_dir.relative_to(IMAGES_ROOT)),
        "heatmaps": heatmaps,
        "total_images": len(image_paths),
        "image_size": {"width": width, "height": height},
        "processing_time": round(processing_time, 2)
    }
```

#### 픽셀 카운트 누적
```python
def accumulate_pixel_counts(img_path: Path, counts: dict, indices: list):
    """
    단일 이미지의 픽셀값을 인덱스별 카운트에 누적
    """
    img = Image.open(img_path).convert('L')  # Grayscale
    pixels = np.array(img)

    # 픽셀값 → 인덱스 매핑 (0~7)
    pixel_indices = pixels // 32  # 8개 구간으로 분할
    pixel_indices = np.clip(pixel_indices, 0, 7)

    # 각 인덱스별 카운트 증가
    for idx in indices:
        mask = (pixel_indices == idx)
        counts[idx] += mask.astype(np.uint16)

    img.close()
```

#### 히트맵 생성
```python
def generate_heatmap_image(count_array: np.ndarray, max_count: int,
                           colormap: str = 'hot'):
    """
    카운트 배열을 색상 히트맵으로 변환

    Args:
        count_array: [height, width] 카운트 배열
        max_count: 정규화 기준 (선택된 이미지 총 개수)
        colormap: 'hot', 'jet', 'viridis', 'coolwarm', 'custom_white_red'

    Returns:
        PIL.Image: RGB 히트맵 이미지
    """
    # 정규화 (0.0 ~ 1.0)
    normalized = count_array / max_count if max_count > 0 else count_array

    if colormap == 'custom_white_red':
        # 사용자 요청: 흰색(0) → 빨강(max)
        rgb = np.zeros((*count_array.shape, 3), dtype=np.uint8)
        rgb[:, :, 0] = (255 * normalized).astype(np.uint8)  # R
        rgb[:, :, 1] = (255 * (1 - normalized)).astype(np.uint8)  # G
        rgb[:, :, 2] = (255 * (1 - normalized)).astype(np.uint8)  # B

        """
        색상 매핑:
        count=0   (0%)   → RGB(0, 255, 255)   → 흰색
        count=25  (25%)  → RGB(64, 191, 191)  → 연한 분홍
        count=50  (50%)  → RGB(128, 127, 127) → 중간 빨강
        count=75  (75%)  → RGB(191, 64, 64)   → 진한 빨강
        count=100 (100%) → RGB(255, 0, 0)     → 순수 빨강
        """
    else:
        # matplotlib colormap 사용
        import matplotlib.pyplot as plt
        cmap = plt.cm.get_cmap(colormap)
        rgba = cmap(normalized)
        rgb = (rgba[:, :, :3] * 255).astype(np.uint8)

    return Image.fromarray(rgb)
```

## 🚀 성능 최적화

### 1. 메모리 효율성
```python
# ❌ 비효율적: 모든 이미지를 메모리에 로드
all_images = [np.array(Image.open(p)) for p in paths]  # OOM!

# ✅ 효율적: 스트리밍 방식 (한 번에 하나씩)
for path in paths:
    img = np.array(Image.open(path))
    process_image(img)
    del img  # 즉시 해제
```

### 2. 속도 최적화 (NumPy 벡터화)
```python
# ❌ 느림: 픽셀 단위 루프
for y in range(height):
    for x in range(width):
        if pixels[y, x] // 32 == target_idx:
            counts[target_idx][y, x] += 1

# ✅ 빠름: 벡터화 연산 (100배 이상 빠름)
mask = (pixels // 32 == target_idx)
counts[target_idx] += mask.astype(np.uint16)
```

### 3. 병렬 처리 (선택)
```python
from concurrent.futures import ProcessPoolExecutor

def process_batch(image_paths_batch):
    """각 프로세스가 독립적으로 일부 이미지 처리"""
    local_counts = {i: np.zeros((height, width), dtype=np.uint16)
                    for i in range(8)}
    for path in image_paths_batch:
        accumulate_pixel_counts(path, local_counts)
    return local_counts

# 배치 분할 (4개 프로세스)
batches = np.array_split(image_paths, 4)

with ProcessPoolExecutor(max_workers=4) as executor:
    results = executor.map(process_batch, batches)

# 결과 합산
final_counts = {i: np.zeros((height, width), dtype=np.uint16)
                for i in range(8)}
for batch_counts in results:
    for idx in range(8):
        final_counts[idx] += batch_counts[idx]
```

## 📊 UI 결과 표시

```javascript
displayCompositeResults(result) {
    const modal = document.createElement('div');
    modal.className = 'composite-results-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 1200px;">
            <h2>Composite Map 결과</h2>
            <p>총 ${result.total_images}개 이미지 분석 완료
               (처리 시간: ${result.processing_time}초)</p>

            <div class="heatmap-grid" style="display: grid;
                 grid-template-columns: repeat(4, 1fr); gap: 16px;">
                ${result.heatmaps.map(h => `
                    <div class="heatmap-item">
                        <h4>Index ${h.index}</h4>
                        <img src="/api/image?path=${encodeURIComponent(h.path)}"
                             style="width: 100%; cursor: pointer;"
                             onclick="viewer.loadImage('${h.path}')">
                        <p>Max: ${h.max_count} (${h.percentage}%)</p>
                    </div>
                `).join('')}
            </div>

            <button onclick="this.closest('.modal').remove()">닫기</button>
        </div>
    `;
    document.body.appendChild(modal);
}
```

## 🔧 구현 순서

1. **Backend 먼저 구현**
   - `api/composite_map.py` 생성
   - `create_composite_heatmaps()` 함수 구현
   - `accumulate_pixel_counts()` 함수 구현
   - `generate_heatmap_image()` 함수 구현

2. **API 엔드포인트 추가**
   - `api/main.py`에 `/api/composite-map` 추가

3. **Frontend 통합**
   - Grid Controls에 버튼 추가
   - 선택된 이미지 경로 수집 로직
   - API 호출 및 결과 표시

4. **최적화** (선택사항)
   - 진행 상황 WebSocket으로 실시간 업데이트
   - 병렬 처리로 속도 향상
   - 메모리 효율적인 스트리밍 방식

## 📝 사용 예시

```
1. Grid 모드에서 100개 웨이퍼 맵 선택
2. 우클릭 컨텍스트 메뉴에서 `Create Composite Map` 선택 (또는 상단 버튼)
3. 서버에서 처리 (약 10초)
4. 8개의 히트맵 이미지 생성
5. 모달로 결과 표시
6. 각 히트맵 클릭하면 단일 이미지 모드로 전환
```

## 📁 출력 구조

```
IMAGES_ROOT/
└── composite_maps/
    └── 20250110_143022/
        ├── index_0.png  (인덱스 0 히트맵)
        ├── index_1.png  (인덱스 1 히트맵)
        ├── index_2.png
        ├── index_3.png
        ├── index_4.png
        ├── index_5.png
        ├── index_6.png
        └── index_7.png
```

## 🎯 기대 효과

- **패턴 분석**: 여러 웨이퍼에서 공통적으로 나타나는 defect 패턴 시각화
- **핫스팟 탐지**: 특정 위치에서 자주 발생하는 결함 영역 식별
- **품질 개선**: 공정 개선을 위한 데이터 기반 의사결정
- **효율성**: 수백 개 이미지를 수동으로 비교하는 시간 절약

---

## 🖱 컨텍스트 메뉴 & 전환 UX

1. **그리드 우클릭 메뉴 확장**
   - `Create Composite Map` 항목 추가: 선택된 이미지들을 새 Composite 세션으로 보냄.
   - Composite 모드에서는 동일한 우클릭 메뉴에 `Return to Previous Grid` 항목을 노출하여, 원래 그리드 컨텍스트로 즉시 복귀할 수 있도록 한다.

2. **Composite 전용 그리드**
   - Composite 모드에 진입하면 우측 패널에 “Composite Session” 배지와 이전 세션 이름을 표시.
   - `Return to Previous Grid` 를 누르면 이전 선택 상태(스크롤, 선택 인덱스)를 복원한 뒤 Composite 전용 UI를 닫는다.

3. **세션 상태**
   - 진입할 때 기존 그리드 상태를 `sessionStorage` 혹은 전역 상태(`savedViewState`)에 보관한다.
   - 복귀 시 동일한 상태를 재적용하여 사용자가 길을 잃지 않도록 한다.
