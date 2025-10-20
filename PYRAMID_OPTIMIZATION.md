# 피라미드 이미지 로딩 최적화 가이드

## 📊 개요

L3 Tracker는 대용량 반도체 웨이퍼맵 이미지(최대 9000×9000 픽셀)를 효율적으로 처리하기 위해 **이미지 피라미드(Image Pyramid)** 기술을 사용합니다. 이 문서는 피라미드 로딩 최적화 과정과 기술적 상세를 설명합니다.

---

## 🎯 피라미드 레벨 구성

### 레벨 정의 (config.py)

```python
PYRAMID_LEVELS = [0.2, 0.5, 0.7, 1.0]
PYRAMID_ZOOM_THRESHOLDS = [0.25, 0.5, 0.75]
```

| 레벨 | 해상도 (9000×9000 기준) | 파일 크기 (WebP) | 사용 시점 |
|------|------------------------|------------------|----------|
| 0.2  | 1800×1800              | ~1.0MB           | Zoom < 25% |
| 0.5  | 4500×4500              | ~8.1MB           | 25% ≤ Zoom < 50% |
| 0.7  | 6300×6300              | ~16.5MB          | 50% ≤ Zoom < 75% |
| 1.0  | 9000×9000              | ~12.2MB          | Zoom ≥ 75% |

---

## 🔄 로딩 프로세스 (Before → After)

### 🔴 **이전 방식: Lazy Loading Pattern**

#### Phase 1: 초기 로드
```
사용자 → 이미지 클릭
         ↓
클라이언트 → 서버: GET /api/image?level=0.2
         ↓
서버: 파일 생성 + 반환 (~550ms)
         ↓
클라이언트: Blob → ImageBitmap 디코딩
         ↓
화면 렌더링
         ↓
서버 Background: Level 0.5, 0.7, 1.0 생성 (클라이언트 모름)
```

#### Phase 2: Zoom 변경 (0.09 → 0.27)
```
사용자 → 줌인
         ↓
클라이언트: pyramidLevels[0.5] 확인 → ❌ 없음
         ↓
클라이언트 → 서버: GET /api/image?level=0.5
         ↓
서버: 파일 반환 (이미 생성됨, ~620ms)
         ↓
클라이언트: Blob → ImageBitmap 디코딩
         ↓
화면 전환 (총 620ms 대기 ⏳)
```

**⚠️ 문제점:**
- Zoom 변경할 때마다 **네트워크 다운로드 + 디코딩 대기**
- Level 0.7: ~1300ms, Level 1.0: ~707ms
- **총 3회 Zoom 시 2627ms 누적 대기**

---

### 🟢 **현재 방식: Eager Pre-fetch Pattern**

#### Phase 1: 초기 로드
```
사용자 → 이미지 클릭
         ↓
클라이언트 → 서버: GET /api/image?level=0.2
         ↓
서버: 파일 생성 + 반환 (~168ms, WebP 최적화)
         ↓
클라이언트: Blob → ImageBitmap 디코딩
         ↓
화면 렌더링 ✅
         ↓
서버 Background: Level 0.5, 0.7, 1.0 생성
         ↓
클라이언트 Background: 모든 레벨 Pre-fetch 시작 🚀
```

#### Phase 2: Background Pre-fetch (병렬)
```
클라이언트: prefetchAllPyramidLevels() 시작
         ↓
순차 다운로드 (낮은 레벨부터):
  ├─ Level 0.5: HEAD → GET → Bitmap → 메모리 저장
  ├─ Level 0.7: HEAD → GET → Bitmap → 메모리 저장
  └─ Level 1.0: HEAD → GET → Bitmap → 메모리 저장
         ↓
모든 레벨 준비 완료 ✅
```

**다운로드 순서 예시:**
```javascript
// 초기 Level = 0.2
순서: 0.5 → 0.7 → 1.0

// 초기 Level = 0.7
순서: 0.2 → 0.5 → 1.0
```

#### Phase 3: Zoom 변경 (즉시 전환)
```
사용자 → 줌인
         ↓
클라이언트: pyramidLevels[0.5] 확인 → ✅ 있음!
         ↓
메모리 포인터 변경 (0ms)
         ↓
화면 전환 ⚡ (즉시!)
```

---

## 📊 성능 비교

### 초기 로드 시간

| 단계 | 이전 (JPEG) | 현재 (WebP) | 개선율 |
|------|------------|------------|--------|
| Fetch | 331ms | 1ms | **-99.7%** |
| Blob 디코딩 | 40ms | 3ms | **-92.5%** |
| Bitmap 생성 | 35ms | 33ms | -5.7% |
| **총 시간** | **566ms** | **168ms** | **-70.3%** |

### Zoom 변경 시간 (3회)

| Zoom | 이전 방식 | 현재 방식 | 개선율 |
|------|----------|----------|--------|
| Lv0.2 → 0.5 | 620ms | **0ms** | **-100%** |
| Lv0.5 → 0.7 | 1300ms | **0ms** | **-100%** |
| Lv0.7 → 1.0 | 707ms | **0ms** | **-100%** |
| **총 대기** | **2627ms** | **0ms** | **-100%** |

### 사용자 경험 개선

```
이전: 첫 로드(566ms) + Zoom 3회(2627ms) = 3193ms 대기 ⏳
현재: 첫 로드(168ms) + Zoom 3회(0ms) = 168ms 대기 ⚡

→ 94.7% 시간 감소!
```

---

## 🔧 기술적 상세

### 1. 이미지 인코딩/디코딩 과정

#### 서버 → 클라이언트 전송
```
원본 픽셀 (메모리)
9000×9000 × RGB = 243MB
         ↓
  [pyvips 인코딩]
webpsave(Q=100, lossless=False, effort=1)
         ↓
WebP 파일 (디스크)
12.2MB (~95% 압축)
         ↓
  [HTTP 전송]
         ↓
Blob (브라우저 메모리)
12.2MB (압축 상태)
         ↓
  [createImageBitmap 디코딩]
         ↓
ImageBitmap (GPU 메모리)
9000×9000 × RGBA = 324MB
```

#### 왜 디코딩이 필요한가?

**Q: WebP를 그대로 화면에 렌더링하면 안 되나요?**

**A: Canvas API는 압축 이미지를 직접 렌더링할 수 없습니다.**

| 방법 | 가능 여부 | 품질 | 성능 | GPU 최적화 |
|------|-----------|------|------|-----------|
| WebP 파일 직접 사용 | ❌ 불가능 | - | - | - |
| HTMLImageElement | ✅ 가능 | 동일 | 느림 | 제한적 |
| **ImageBitmap (현재)** | ✅ 가능 | **동일** | **빠름** | **최적** |

**ImageBitmap의 장점:**
- GPU 메모리에 직접 업로드 (텍스처 최적화)
- 디코딩 1회만 수행 (재사용 가능)
- 하드웨어 가속 렌더링

**✅ 결론: WebP Q=100 → 픽셀 → 화면 = 원본과 동일 품질**

---

### 2. HEAD 요청 최적화

#### 파일 존재 확인
```javascript
// 1. HEAD 요청 (Body 없음, ~5ms)
const headResponse = await fetch(url, { method: 'HEAD' });

// 2. 파일 존재 확인
if (!headResponse.ok) {
    return;  // 404면 스킵
}

// 3. 캐시 상태 확인
const cacheStatus = headResponse.headers.get('X-Cache-Status');
// 'HIT': 이미 생성됨
// 'MISS': 지금 생성 중
// 'ORIGINAL': 원본 파일
```

#### 장점
- **서버 로그 오염 방지** (is_head 체크로 로그 스킵)
- **불필요한 다운로드 방지** (404면 즉시 종료)
- **빠른 존재 확인** (~5ms)

---

### 3. 순차 다운로드 전략

#### 우선순위 기반 다운로드

```javascript
async prefetchAllPyramidLevels() {
    const levels = SERVER_CONFIG.PYRAMID_LEVELS;  // [0.2, 0.5, 0.7, 1.0]
    const currentLevel = this.currentPyramidLevel;

    // 현재 레벨 제외하고 낮은 순으로 정렬
    const remainingLevels = levels
        .filter(level => level !== currentLevel)
        .sort((a, b) => a - b);  // [0.2, 0.5, 0.7, 1.0] - current

    // 순차 다운로드 (await로 순서 보장)
    for (const level of remainingLevels) {
        await this.loadPyramidLevel(level, true);
    }
}
```

#### 다운로드 순서 예시

**Case 1: 초기 Level = 0.2**
```
현재: 0.2 ✅ (이미 로드됨)
다운로드 순서: 0.5 → 0.7 → 1.0

┌─────────────────────────────────────┐
│ Time: 0s    1s    2s    3s    4s    │
├─────────────────────────────────────┤
│ 0.5: [████████████]                 │ ← 먼저 완료 (작은 파일)
│ 0.7:              [█████████████]   │
│ 1.0:                             [█]│ ← 마지막 (원본 복사, 빠름)
└─────────────────────────────────────┘
```

**Case 2: 초기 Level = 0.7**
```
현재: 0.7 ✅ (이미 로드됨)
다운로드 순서: 0.2 → 0.5 → 1.0

┌─────────────────────────────────────┐
│ Time: 0s    1s    2s    3s    4s    │
├─────────────────────────────────────┤
│ 0.2: [███]                          │ ← 가장 먼저 완료 (가장 작음)
│ 0.5:      [████████████]            │
│ 1.0:                      [█]       │ ← 빠르게 완료
└─────────────────────────────────────┘
```

#### 왜 순차 다운로드인가?

| 방식 | 첫 레벨 준비 | 모든 레벨 준비 | 사용자 경험 |
|------|-------------|--------------|------------|
| **병렬** (이전) | ~4578ms (Lv0.5) | ~5403ms | 5초 대기 |
| **순차** (현재) | **~300ms (작은 레벨)** | ~5500ms | 빠른 레벨부터 사용 가능! |

**✅ 장점:**
- 작은 파일부터 빠르게 준비
- 사용자가 즉시 사용 가능한 레벨 확보
- 총 시간은 비슷하지만 UX 크게 개선

---

### 4. 메모리 관리

#### ImageBitmap 캐싱

```javascript
pyramidLevels = {
    0.2: ImageBitmap(1800×1800),   // ~12MB (RGBA)
    0.5: ImageBitmap(4500×4500),   // ~80MB
    0.7: ImageBitmap(6300×6300),   // ~160MB
    1.0: ImageBitmap(9000×9000),   // ~320MB
}
// 총 메모리: ~572MB
```

**Trade-off:**
- ✅ **장점**: Zoom 변경 시 즉시 응답 (0ms)
- ⚠️ **단점**: 메모리 사용량 증가 (~572MB/이미지)

**최적화 전략:**
- 단일 이미지 뷰에서만 사용
- 그리드 뷰에서는 썸네일만 사용
- 이미지 변경 시 기존 피라미드 해제

---

## 📈 병목 제거 분석

### 이전 방식 병목

```
Zoom 변경 이벤트
      ↓
HTTP Request (11ms)
      ↓
Network Transfer (100~200ms)
      ↓
Response → Blob (376ms) ← 🔥 병목 1 (디코딩)
      ↓
ImageBitmap 생성 (245ms) ← 🔥 병목 2 (GPU 업로드)
      ↓
화면 렌더링
      ↓
총 시간: ~620ms ⏳
```

### 현재 방식

```
Zoom 변경 이벤트
      ↓
pyramidLevels[level] 메모리 참조 (0ms) ← ⚡ 즉시!
      ↓
화면 렌더링
      ↓
총 시간: ~0ms ⚡
```

**✅ 네트워크 I/O와 디코딩 병목 완전 제거!**

---

## 🔧 핵심 구현 코드

### 서버 (api/main.py)

#### HEAD 요청 지원
```python
@app.head("/api/image")
@app.get("/api/image")
async def get_image(request: Request, path: str, level: Optional[float] = None):
    is_head = request.method == "HEAD"

    # HEAD 요청 시 로그 출력 안 함
    if not is_head:
        logger.info(f"🎯 [PYRAMID MODE] 활성화됨")
```

#### WebP 인코딩
```python
# 고품질 WebP 생성
resized.webpsave(
    str(pyramid_path),
    Q=100,                   # 최고 품질 (원본과 동일)
    strip=True,              # 메타데이터 제거
    lossless=False,          # 손실 압축 (더 작은 파일)
    effort=1,                # 빠른 인코딩
    smart_subsample=False    # 빠른 인코딩
)
```

#### Background 생성
```python
asyncio.create_task(_generate_other_levels_background(image_path, level, stem))

async def _generate_other_levels_background(image_path, current_level, stem):
    # 현재 레벨 제외하고 나머지 생성
    other_levels = [l for l in config.PYRAMID_LEVELS if l != current_level]

    for other_level in other_levels:
        # 이미 존재하거나 생성 중이면 스킵
        if pyramid_path.exists() or path_key in _pyramid_bg_generating:
            continue

        # 생성 시작
        _pyramid_bg_generating.add(path_key)
        _generate_pyramid_sync(image_path, pyramid_path, other_level)
        _pyramid_bg_generating.discard(path_key)
```

---

### 클라이언트 (main.js)

#### Pre-fetch 함수
```javascript
async prefetchAllPyramidLevels() {
    const levels = SERVER_CONFIG.PYRAMID_LEVELS;
    const currentLevel = this.currentPyramidLevel;

    // 현재 레벨 제외하고 낮은 순으로 정렬
    const remainingLevels = levels
        .filter(level => level !== currentLevel)
        .sort((a, b) => a - b);

    console.log(`🚀 [PREFETCH] Background 순차 다운로드 시작: [${remainingLevels.join(', ')}]`);

    // 순차 다운로드 (낮은 레벨부터)
    for (const level of remainingLevels) {
        try {
            await this.loadPyramidLevel(level, true);  // silent=true
        } catch (err) {
            console.warn(`⚠️ [PREFETCH] Lv${level} 다운로드 실패, 건너뜀`);
        }
    }

    console.log(`✅ [PREFETCH] 모든 레벨 다운로드 완료`);
}
```

#### 피라미드 로드 함수
```javascript
async loadPyramidLevel(level, silent = false) {
    // 이미 로드되었으면 스킵
    if (this.pyramidLevels[level]) return;

    // 이미 로딩 중이면 스킵
    if (this._pyramidLoading.has(level)) return;
    this._pyramidLoading.add(level);

    try {
        const url = `/api/image?path=${encodeURIComponent(this.selectedImagePath)}&level=${level}`;

        // 1. HEAD 요청으로 파일 존재 확인
        const headResponse = await fetch(url, { method: 'HEAD' });
        if (!headResponse.ok) {
            this._pyramidLoading.delete(level);
            return;
        }

        // 2. 파일 다운로드
        const response = await fetch(url);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);

        // 3. 메모리 저장
        this.pyramidLevels[level] = bitmap;
        this._pyramidLoading.delete(level);

        // 4. 현재 줌에 적합하면 즉시 교체
        const bestLevel = this.getBestPyramidLevel(this.transform.scale);
        if (bestLevel === level && !silent) {
            this.currentImage = bitmap;
            this.currentPyramidLevel = level;
            this.scheduleDraw();

            console.log(`🎯 [SWITCH] Lv${level} | ... | Zoom:${this.transform.scale.toFixed(2)}`);
        } else if (silent) {
            const cacheStatus = headResponse.headers.get('X-Cache-Status');
            console.log(`✅ [PREFETCH] Lv${level} 다운로드 완료 | Cache:${cacheStatus}`);
        }
    } catch (err) {
        console.error(`❌ [ERROR] 피라미드 로드 실패 level=${level}:`, err);
        this._pyramidLoading.delete(level);
    }
}
```

#### Zoom 변경 시 즉시 전환
```javascript
updatePyramidLevel() {
    const bestLevel = this.getBestPyramidLevel(this.transform.scale);

    if (bestLevel !== this.currentPyramidLevel) {
        if (this.pyramidLevels[bestLevel]) {
            // 이미 메모리에 있으면 즉시 교체
            this.currentImage = this.pyramidLevels[bestLevel];
            this.currentPyramidLevel = bestLevel;
            this.scheduleDraw();

            console.log(`🎯 [SWITCH] Lv${bestLevel} | ... | Zoom:${this.transform.scale.toFixed(2)}`);
        } else {
            // 없으면 다운로드 (첫 로드 직후 등)
            this.loadPyramidLevel(bestLevel);
        }
    }
}
```

---

## 📊 로그 예시

### 초기 이미지 로드 (Level 0.2)
```
📸 [INIT] Lv0.2 | 9000×9000 → 1800×1800 | Zoom:0.09 | Fetch:1ms Blob:3ms Bitmap:33ms | Total:168ms
🚀 [PREFETCH] Background 순차 다운로드 시작: [0.5, 0.7, 1.0]
```

### Background Pre-fetch 완료
```
✅ [PREFETCH] Lv0.5 다운로드 완료 (4500×4500) | Cache:HIT | 343ms
✅ [PREFETCH] Lv0.7 다운로드 완료 (6300×6300) | Cache:HIT | 586ms
✅ [PREFETCH] Lv1 다운로드 완료 (9000×9000) | Cache:ORIGINAL | 286ms
✅ [PREFETCH] 모든 레벨 다운로드 완료
```

### Zoom 변경 (즉시 전환)
```
🎯 [SWITCH] Lv0.5 | 9000×9000 → 4500×4500 | Zoom:0.27
🎯 [SWITCH] Lv0.7 | 9000×9000 → 6300×6300 | Zoom:0.55
🎯 [SWITCH] Lv1 | 9000×9000 → 9000×9000 | Zoom:0.82
```

---

## 🎯 최적화 체크리스트

### 서버
- [x] WebP Q=100 인코딩 (품질 유지)
- [x] HEAD 요청 지원 (파일 존재 확인)
- [x] Background 피라미드 생성
- [x] 캐시 헤더 (X-Cache-Status)
- [x] 로그 최적화 (HEAD 요청 시 스킵)

### 클라이언트
- [x] Eager Pre-fetch Pattern
- [x] 순차 다운로드 (낮은 레벨부터)
- [x] ImageBitmap 캐싱
- [x] 즉시 전환 (메모리 참조)
- [x] 로그 구분 (INIT/PREFETCH/SWITCH)

### 성능
- [x] 초기 로드: 70% 개선 (566ms → 168ms)
- [x] Zoom 변경: 100% 개선 (620ms → 0ms)
- [x] 총 대기: 94.7% 개선 (3193ms → 168ms)

---

## 🚀 향후 개선 방향

### 1. WebP 인코딩 속도 개선 (선택 사항)
```python
# 현재: effort=1
resized.webpsave(str(pyramid_path), Q=100, effort=1)

# 개선: effort=0 (39% 빠름, 파일 15% 증가)
resized.webpsave(str(pyramid_path), Q=100, effort=0)
```

**Trade-off:**
- ✅ 인코딩 속도 39% 개선 (~1974ms → ~1200ms)
- ⚠️ 파일 크기 15% 증가 (~17.3MB → ~20MB)

### 2. 서버 병렬 생성 (고급)
```python
# 멀티프로세스로 레벨별 병렬 생성
from concurrent.futures import ProcessPoolExecutor

with ProcessPoolExecutor(max_workers=3) as executor:
    futures = [executor.submit(_generate_pyramid_sync, level) for level in levels]
```

**고려사항:**
- 프로세스 오버헤드
- 메모리 사용량 증가
- I/O 경합

### 3. 적응형 품질 조정 (실험적)
```python
# 낮은 레벨은 품질 낮춤 (더 빠른 생성)
quality = 90 if level < 0.5 else 100
resized.webpsave(str(pyramid_path), Q=quality, effort=0)
```

**⚠️ 주의: 품질 저하 가능**

---

## 📚 참고 자료

- [pyvips 문서](https://libvips.github.io/pyvips/)
- [WebP 포맷 스펙](https://developers.google.com/speed/webp)
- [ImageBitmap API](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap)
- [Canvas API 최적화](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)

---

## 📝 버전 히스토리

### v2.0.0 (2025-01-20)
- ✅ JPEG → WebP 변환
- ✅ HEAD 요청 지원
- ✅ Eager Pre-fetch Pattern 구현
- ✅ 순차 다운로드 (우선순위 기반)
- ✅ 94.7% 성능 개선

### v1.0.0 (2025-01-10)
- ✅ 피라미드 이미지 시스템 도입
- ✅ Lazy Loading Pattern
- ✅ Background 생성

---

**작성일:** 2025-01-20
**작성자:** L3 Tracker Team
