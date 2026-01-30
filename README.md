# Wafer Map Viewer (MapViewer)

<div align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue.svg" />
  <img src="https://img.shields.io/badge/backend-FastAPI-green.svg" />
  <img src="https://img.shields.io/badge/frontend-Vanilla%20JS%20(ES6%2B)-yellow.svg" />
  <img src="https://img.shields.io/badge/render-Canvas%20%2B%20WebGL2-orange.svg" />
</div>

대용량 반도체 웨이퍼맵(수천~수만 장 썸네일, 단일 맵 수천만 픽셀)을 **지연 없이 탐색(줌/팬)** 하고,
**개인색(palette) / 필터 / 합성(Composite) / 클립보드 복사** 같은 업무 기능을 “빠르게” 제공하는 웹 애플리케이션입니다.

---

## 왜 이렇게 빠른가 (핵심 설계)

### 1) 서버: 피라미드(해상도 레벨) + 디스크 캐시 + 백그라운드 생성

- **한 장의 원본을 그대로 계속 보내지 않음**  
  단일 뷰는 `/api/image?path=...&level=...` 로 **피라미드 레벨**(예: 1.0 / 0.5 / 0.25)을 요청합니다.
- **레벨 이미지는 디스크에 캐시**  
  생성된 피라미드는 `THUMBNAIL_DIR/pyramid_*` (또는 개인색 scheme 하위)로 저장되고,
  응답은 `Cache-Control: immutable` + `ETag` 로 브라우저/프록시 캐시가 강하게 동작합니다.
- **“지금 필요한 레벨”만 즉시 만들고, 나머지는 백그라운드로**  
  최초 요청 레벨만 동기 생성 → 나머지 레벨은 `asyncio` 백그라운드 태스크로 미리 생성합니다.

관련 코드:
- `api/main.py` (`GET /api/image`, pyramid 캐시/HIT/MISS, 백그라운드 레벨 생성)

### 2) 썸네일: pyvips(스트리밍) + (옵션) TurboJPEG + 동시성 세마포어

- `pyvips.Image.new_from_file(..., access="sequential")` 로 **디스크 I/O 효율**을 최대화합니다.
- JPEG 저장은 (옵션) TurboJPEG를 사용해 인코딩 시간을 줄입니다.
- `THUMBNAIL_SEM` 기반 세마포어로 서버 동시 생성량을 제어해 **과부하/스톨을 방지**합니다.

관련 코드:
- `api/thumbnail_service.py` (`ThumbnailService`)
- `api/cache_manager.py` (LRU/TTL 기반 캐시 계층)

### 3) 개인색/필터: “재렌더링”이 아니라 “팔레트(PLTE)만 패치”

웨이퍼맵 PNG가 **팔레트(P) 기반**일 때, 색을 바꾸기 위해 전체 이미지를 다시 만들 필요가 없습니다.
이 프로젝트는 PNG의 **PLTE 청크만 메모리에서 in-place 패치**해서 색상을 변경합니다.

- 장점: **IDAT 재압축이 없어서 매우 빠름**, CPU 사용량/지연이 급감
- 개인색은 사용자별 scheme + timestamp 경로로 분리 캐시되어 충돌이 없습니다.

관련 코드:
- `api/personal_colors.py` (`plte_inplace_patch_memory`, `swap_first16_colors`, `load_color_legends`)
- `api/main.py` (`/api/image`에서 personalized/grade/bottom filter 처리)

### 4) 클라이언트: Canvas/WebGL2 렌더러 + 피라미드 레벨 선택 + 프레임 친화적 스케줄링

- 렌더링은 **Vanilla JS + Canvas/WebGL2** 로 구현되어 번들러/프레임워크 오버헤드가 없습니다.
- `SemiconductorRenderer`는 2D context를 `desynchronized: true` 로 생성하고,
  WebGL2가 가능하면 GPU로 스케일링(바이큐빅)하여 줌/팬 시 체감 지연을 줄입니다.
- 렌더/DOM 작업은 `requestAnimationFrame` / `requestIdleCallback` 기반 큐로 분산해
  **스크롤/줌 중 프레임 드랍을 최소화**합니다.

관련 코드:
- `js/semiconductor-renderer.js` (Canvas2D/WebGL2 렌더러)
- `js/render-optimizer.js` (idle task / rAF 스케줄링, lazy load, virtual scroll)
- `js/main.js` (피라미드 레벨 로딩/캐시, 프리패치 흐름)

---

## 편의 기능도 “빠르게” 구현한 이유

- **개인색(Color Scheme)**: 사용자별 색상표를 `logs/color-legends.json`에 저장 → 서버가 PLTE만 패치해서 즉시 반영  
  - 관련: `api/personal_colors.py`, `js/color-editor.js`
- **Composite Map / Composite Subset**: numpy/numba(+옵션 Cython)로 집계, 병렬 워커로 렌더/저장 분리  
  - 관련: `api/composite_map.py`, `/api/composite-map`, `/api/composite-subset`
- **컨텍스트 메뉴 복사/합성**: 캔버스에서 보이는 영역만 합성해서 Clipboard API로 복사 (오버레이/범례 포함)  
  - 관련: `js/context-menu.js`
- **Chip 오버레이/선택/라벨링**: 별도 overlay canvas에 chip 레이어를 렌더링해 메인 이미지와 독립적으로 빠르게 갱신  
  - 관련: `js/chip-annotator.js`, `/api/chip-positions`, `/api/chip-annotations`, `/api/classify/chips`
- **라벨/분류 워크플로우**: 분류는 “이미지 복사”가 아니라 가능하면 **하드링크**를 사용해 I/O를 줄임  
  - 관련: `api/main.py` (`/api/classify`, `/api/classify/batch`)

---

## 기술 스택

- **Backend**: FastAPI, Uvicorn, asyncio, (옵션) Brotli/GZip
- **Image Pipeline**: pyvips, Pillow, (옵션) TurboJPEG, numpy, numba, (옵션) Cython
- **Frontend**: Vanilla JavaScript (ES6 Modules, **No build step**), Canvas 2D, WebGL2, Web APIs(Clipboard/IntersectionObserver 등)

---

## 빠른 시작

### 설치

```bash
pip install -r requirements.txt
```

### 실행

- Windows: `./start.ps1`
- Ubuntu/Linux: `./start.sh`

브라우저에서 `http://localhost:8080` 접속

---

## 성능 튜닝 포인트 (자주 조절하는 것들)

| 변수 | 의미 | 권장 접근 |
|---|---|---|
| `THUMB_PREFETCH_BATCH` | 클라이언트 프리패치 배치 크기 | 썸네일 밀집 환경에서 점진적으로 ↑ |
| `THUMB_CLIENT_MAX_CONCURRENCY` | 클라이언트 동시 요청 수 | 네트워크/서버 여유에 맞춰 ↑ |
| `THUMBNAIL_SEM` | 서버 썸네일 생성 동시성(세마포어) | CPU/I/O 한계 넘지 않게 조절 |
| `VIPS_CONCURRENCY` | pyvips 내부 동시성 | 코어 수에 비례하되 과도하면 역효과 |
| `IO_THREADS` | I/O 스레드 풀 | HDD/네트워크 스토리지면 보수적으로 |

실제 운영 값은 `start.ps1`, `start.sh`의 기본값과 `/api/config` 응답을 기준으로 맞춥니다.

---

## API Snapshot

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/files` | 폴더 탐색 |
| GET | `/api/search` | 현재 폴더 범위 검색 |
| GET | `/api/config` | 프론트 설정(프리패치/동시성 등) |
| GET | `/api/thumbnail` | 썸네일 생성/제공 |
| POST | `/api/thumbnail/preload` | 썸네일 배치 프리패치 |
| GET | `/api/image` | 원본/피라미드 레벨 이미지 (`level`, `personalized`, `scheme`, 필터) |
| POST | `/api/classify` | 분류(하드링크/복사) + 라벨 업데이트 |
| POST | `/api/classify/chips` | chip crop 저장/라벨링 |
| POST | `/api/composite-map` | composite map 생성(비동기 작업) |
| GET | `/api/composite-map/status/{task_id}` | composite map 진행상태 |
| POST | `/api/composite-subset` | subset composite 생성 |

---

## 더 읽을거리

- 성능/벤치마크 자료: `docs/`, `docs/archive/`
- 칩 주석/좌표: `CHIP_ANNOTATION.md`
- 내부 구조 개요: `ARCHITECTURE.md`

---

## 저장소

```bash
git clone https://github.com/hogil/mapviewer.git
cd mapviewer
```
