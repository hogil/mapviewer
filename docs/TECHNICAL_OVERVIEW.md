# Technical Overview

L3 Tracker의 전체 기술 구성과 검색 사용 규칙을 빠르게 공유하기 위한 문서입니다. 세부 API와 기능별 계약은 각 전용 문서를 기준으로 봅니다.

## Executive Summary

L3 Tracker는 대용량 반도체 wafer map 이미지를 웹에서 빠르게 탐색하고, 검색/분류/개인색/Composite 분석까지 처리하는 내부 업무용 이미지 뷰어입니다. 기술 방향은 "외부 검색엔진이나 DB 의존을 늘리지 않고, 파일 시스템 기반 데이터를 Python 서버와 브라우저 기본 기술로 고속 처리"하는 것입니다.

## Technology Stack For Reporting

| 영역 | 기술 스택 | 역할 | 보고 포인트 |
|------|-----------|------|-------------|
| Frontend UI | HTML5, CSS3, Vanilla JavaScript ES modules | 화면, 폴더 탐색, 검색, 그리드, 라벨링 UI | React/Vue 같은 프레임워크와 별도 빌드 파이프라인 없이 브라우저 표준 기술로 운영 |
| Rendering | Canvas 2D, WebGL2 지원 renderer, OffscreenCanvas 옵션 | wafer map 확대/축소, overlay, minimap, chip annotation | 대용량 이미지 뷰어에 맞춘 canvas 중심 렌더링 |
| Backend API | Python 3, Starlette bootstrap, FastAPI full app, Uvicorn HTTPS | API, 인증, 이미지/검색/분류/Composite 기능 제공 | 첫 화면 응답은 가볍게, 전체 기능은 lazy-load하는 구조 |
| Image Processing | pyvips, Pillow, TurboJPEG 옵션 | 썸네일, 피라미드 이미지, palette 색상 변경, 이미지 캐시 생성 | 대용량 이미지 I/O와 변환을 서버에서 병렬 처리 |
| Compute Acceleration | Numba/Cython 옵션 | Composite/Measure 집계와 고비용 계산 가속 | 반복 계산 병목을 Python 순수 루프에만 의존하지 않도록 보완 |
| Search | Custom Python file index, in-memory lookup, disk cache | LOT/파일명/논리 검색 | Elasticsearch나 DB 없이 이미지 파일 경로 인덱스로 검색 처리 |
| Auth | SAML SP, fallback login | 사내 SSO 연동 및 개발/운영 fallback | 운영은 SAML 기반 접근, 로컬/테스트는 fallback 가능 |
| Storage & Cache | File system, JSON, thumbnail/pyramid disk cache | 이미지 원본, 색상/권한 설정, 로그, 생성 캐시 저장 | 중앙 DB 없이 파일 기반 운영, 대용량 이미지는 캐시로 재사용 |
| Runtime & Ops | Ubuntu/Windows scripts, single Uvicorn worker, internal worker pools | 운영 환경변수, SSL, worker/concurrency 튜닝 | 서버 프로세스는 1개로 상태 일관성을 유지하고 내부 병렬도로 성능 확보 |
| Test Automation | Playwright E2E scripts | 주요 UI/기능 회귀 테스트 | 브라우저 자동화로 실제 사용자 흐름 검증 |

## Key Flow

1. 브라우저가 HTML/CSS/JavaScript 모듈을 받아 초기 탐색 화면을 먼저 표시합니다.
2. 사용자 상호작용 또는 idle 시점에 전체 viewer 모듈을 로딩합니다.
3. Python API 서버는 bootstrap layer로 초기 요청을 빠르게 처리하고, 전체 FastAPI 기능을 lazy-load합니다.
4. 이미지 요청은 thumbnail/pyramid/cache 계층을 통해 필요한 크기만 내려받습니다.
5. 검색은 파일 시스템 전체를 매번 스캔하지 않고, 사전에 만든 파일 경로 인덱스를 사용합니다.
6. Composite/Measure 같은 고비용 분석은 서버 worker와 가속 옵션을 사용해 백그라운드로 처리합니다.

이 구조의 핵심 장점은 배포 구성이 단순하고, 사내 파일 서버 형태의 대용량 이미지 데이터에 직접 맞춰져 있으며, 초기 화면 속도와 이미지 처리 성능을 별도로 튜닝할 수 있다는 점입니다.

## 한 줄 구조

브라우저는 `index.html`에서 Vanilla JS 앱을 로딩하고, 서버는 `api/main.py`의 bootstrap 앱으로 빠르게 뜬 뒤 `api/full_app.py`의 전체 FastAPI 앱을 lazy-load합니다. 이미지/검색/분류/Composite 처리는 파일 시스템 기반 캐시와 백그라운드 worker로 처리합니다.

```text
Browser
  index.html
  js/boot-explorer.js
  js/main.js + feature modules
        |
        | HTTPS JSON / image / thumbnail APIs
        v
api/main.py bootstrap app
        |
        | lazy-load
        v
api/full_app.py full FastAPI app
        |
        +-- api/index_service.py   file index
        +-- api/search_service.py  search
        +-- api/thumbnail_service.py / pyvips
        +-- api/composite_map.py
        +-- logs/*.json, data files, image cache
```

## Frontend

| 영역 | 사용 기술 | 구현 위치 |
|------|-----------|-----------|
| 앱 구조 | Vanilla JavaScript ES modules, 빌드 스텝 없음 | `index.html`, `js/*.js` |
| 초기 로딩 | lightweight explorer 먼저 표시 후 main viewer lazy import | `js/boot-explorer.js` |
| 메인 컨트롤러 | Wafer map 상태, 폴더/검색/라벨/Composite orchestration | `js/main.js` |
| 렌더링 | Canvas 2D 중심, WebGL2 지원 renderer | `js/semiconductor-renderer.js`, `image-canvas`, `overlay-canvas` |
| 그리드/썸네일 | 클라이언트 동시 요청 + 서버 썸네일 API | `js/grid.js`, `ThumbnailManager` |
| 검색 UI | 검색 입력, folder scope, 결과 표시 | `js/search.js`, `js/main.js` |
| 색상/권한/메뉴 | 모달과 context menu 모듈 | `js/color-editor.js`, `js/context-menu.js`, `js/permission-manager.js` |

프론트는 React/Vue 같은 프레임워크를 쓰지 않습니다. ES module import와 브라우저 기본 API(`fetch`, `requestIdleCallback`, Canvas, Worker)를 직접 사용합니다.

초기 화면은 `boot-explorer.js`가 `/api/config`, `/api/root-folder`, `/api/current-folder`, `/api/browse-folders`를 prefetch하고, 사용자 상호작용 또는 idle 시점에 `main.js`를 import합니다. 그래서 첫 화면 속도를 위해 큰 초기화는 `main.js` import 이후나 idle task로 넘기는 방식이 맞습니다.

## Backend

| 영역 | 사용 기술 | 구현 위치 |
|------|-----------|-----------|
| 서버 | Python, Uvicorn HTTPS | `python -m api.main`, `start.ps1`, `start.sh` |
| Bootstrap | Starlette 기반 cold-path app | `api/main.py` |
| Full app | FastAPI endpoint 본체 | `api/full_app.py` |
| 이미지 처리 | pyvips, Pillow, TurboJPEG 옵션 | `api/thumbnail_service.py`, `api/full_app.py` |
| 검색/인덱스 | 파일 시스템 인덱스 + executor 기반 검색 | `api/index_service.py`, `api/search_service.py` |
| 인증 | SAML SP / fallback login | `api/full_app.py`, `api/config.py` |
| 저장소 | DB 중심이 아니라 파일 시스템과 JSON | `logs/*.json`, 이미지 루트, 캐시 디렉터리 |

운영에서 FastAPI worker는 `UVICORN_WORKERS=1`이 전제입니다. 여러 Uvicorn worker를 띄우면 인덱스와 캐시가 프로세스별로 갈라져 중복 빌드와 상태 불일치가 생길 수 있습니다. 동시성은 `IO_THREADS`, `THUMBNAIL_SEM`, `THUMBNAIL_EXECUTOR_WORKERS`, `SEARCH_WORKERS`, `COMPOSITE_*` 환경변수로 조절합니다.

`api/main.py`는 첫 응답을 빠르게 주기 위한 bootstrap layer입니다. 전체 기능은 `api.full_app`를 lazy-load한 뒤 proxy/forwarding합니다. 따라서 서버 시작 경로에서는 무거운 스캔, 썸네일 warmup, Composite import를 blocking으로 넣지 않는 것이 기본 규칙입니다.

## Image Pipeline

이미지는 원본 전체를 매번 내려받지 않습니다.

- 단일 이미지 뷰는 `/api/image?path=...&level=...`로 필요한 피라미드 레벨을 요청합니다.
- 그리드는 `/api/thumbnail`과 batch/preload API를 사용합니다.
- 개인색은 가능하면 PNG IDAT 재압축 없이 PLTE palette만 패치합니다.
- Composite와 Measure는 서버에서 계산하고, 결과/중간 산출물은 캐시 경로에 저장합니다.

자세한 계약은 `IMAGE_PIPELINE.md`, `PYRAMID_THUMBNAIL.md`, `COMPOSITE_MAP.md`를 기준으로 봅니다.

## Search

검색 구현 정본은 `api/search_service.py`와 `api/index_service.py`입니다. UI나 API를 추가할 때는 파일 시스템을 직접 매번 스캔하지 말고 인덱스를 먼저 사용해야 합니다.

### 사용자 검색 방식

| 목적 | 입력 방식 |
|------|-----------|
| 단일 LOT 검색 | `ABC123` |
| 여러 키워드 중 하나 | `ABC123 DEF456` 또는 `ABC123,DEF456` |
| 명시적 논리 검색 | `ABC123 AND 00C`, `ABC123 OR DEF456`, `ABC123 NOT PWQ` |
| 그룹 조건 | `(ABC123 OR DEF456) AND 00C` |
| 특정 폴더 안에서 검색 | 현재 폴더를 바꾸거나 API의 `folder` 파라미터 사용 |
| 여러 LOT 붙여넣기 | 줄바꿈, 콤마, 탭, 세미콜론, `/` 구분 허용 |

논리 연산자가 없는 다중 토큰은 내부적으로 `OR` 검색으로 처리됩니다.

### API 기준

주요 엔드포인트:

- `GET /api/search`
- `GET /api/search-ready`
- `GET /api/index-status`
- `GET /api/files`
- `GET /api/files/recursive`

검색 scope:

- `folder` 미지정: 현재 폴더 기준
- `folder=""`: 이미지 루트 전체
- 특정 `folder`: `IMAGES_ROOT` 기준 상대 경로

운영에서는 인덱스 기반 검색이 기본입니다. `SEARCH_FALLBACK_MAX_FILES=0`, `SEARCH_FALLBACK_TIMEOUT_MS=0`이면 파일 시스템 폴백을 사실상 비활성화합니다.

### 개발 규칙

검색 관련 기능을 추가할 때 지켜야 할 규칙입니다.

1. 대량 검색은 `SearchService.search()` 또는 `IndexService`의 lookup API를 사용합니다.
2. 요청마다 `os.walk`, `rglob`, 전체 파일 순회 fallback을 새로 만들지 않습니다.
3. LOT 기준 검색은 파일명 첫 번째 `_` 앞 token을 기준으로 판단합니다.
4. Chip/label/classification 파생 경로를 검색 결과로 노출할 때는 원본 wafer 경로와의 관계를 확인합니다.
5. 인덱스가 준비되지 않았을 때는 `/api/search-ready` 또는 `ensure_ready_for_search()` 흐름을 사용합니다.
6. 결과가 없다는 이유로 자동 전체 스캔을 추가하지 않습니다. 먼저 index 상태, folder scope, excluded folder, query token을 확인합니다.

## Runtime Config

| 파일 | 용도 |
|------|------|
| `start.ps1` | Windows 개발 실행값 |
| `start.sh` | Ubuntu 운영 실행값 |
| `api/config.py` | 환경변수 기본값과 공통 설정 |

운영 32C 서버 기준으로 `start.sh`는 단일 Uvicorn worker를 유지하고 내부 worker만 조절합니다. 예를 들어 `INDEX_WORKERS=24`는 인덱스 작업이 API 응답/썸네일/Composite와 CPU를 모두 놓고 경쟁하지 않도록 32코어의 75% 수준으로 둔 값입니다.

## Where To Look

| 질문 | 먼저 볼 파일 |
|------|--------------|
| 프론트 첫 로딩이 느림 | `js/boot-explorer.js`, `api/main.py` |
| 이미지가 안 나옴 | `api/full_app.py`, `api/thumbnail_service.py`, `docs/IMAGE_PIPELINE.md` |
| 검색 결과가 이상함 | `api/search_service.py`, `api/index_service.py`, `docs/INDEX_SEARCH.md` |
| 그리드/썸네일이 느림 | `js/grid.js`, `api/full_app.py`, `docs/PERFORMANCE.md` |
| Composite 이슈 | `api/composite_map.py`, `api/measure_composite.py`, `docs/COMPOSITE_MAP.md` |
| 권한/SAML 이슈 | `api/user_manager.py`, `api/full_app.py`, `docs/ROLE_ACCESS.md` |
