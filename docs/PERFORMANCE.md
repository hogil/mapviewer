# 성능 최적화 가이드

이 문서는 "이상적인 최적화 아이디어"가 아니라 현재 코드와 시작 스크립트가 실제로 어떻게 동작하는지를 기준으로 정리합니다.

정본:

- `api/main.py`
- `api/config.py`
- `start.ps1`
- `start.sh`
- `index.html`

## 현재 서버 기본 원칙

- 서버는 HTTPS 전용으로 동작합니다.
- 인증서가 없거나 SSL 설정이 맞지 않으면 시작이 중단될 수 있습니다.
- Uvicorn worker는 현재 코드 경로에서 사실상 1로 고정됩니다.

즉 과거 문서처럼 다중 Uvicorn worker 확장을 권장하면 현재 구현과 충돌합니다.

## 현재 압축 상태

예전의 Brotli/GZip 미들웨어 설명은 현재 기준 정본이 아닙니다.

- `BrotliMiddleware`, `GZipMiddleware`는 현재 비활성화 상태
- Python 3.13 관련 이슈 때문에 활성 운영 경로가 아님

따라서 "현재 서버는 Brotli/GZip 압축을 사용한다"는 설명은 틀립니다.

## HTTP2 / Keep-Alive

`start.ps1`, `start.sh`에는 `HTTP2`, `KEEP_ALIVE` 환경변수가 남아 있지만, 현재 Python 서버 시작 경로의 핵심 동작을 결정하는 스위치로 적극 사용되지는 않습니다.

문서 기준으로는 "스크립트에 변수는 있으나 서버 실행 코드의 핵심 최적화 스위치는 아님" 정도로 보는 것이 맞습니다.

## 현재 캐시 헤더

현재 캐시 정책은 경로별로 다릅니다.

- `/`: `max-age=3600`
- `/api/image`: `no-store`
- `/api/thumbnail`: `no-store`
- 피라미드 이미지 응답: `max-age=31536000, immutable`

즉 "썸네일 1주일 immutable" 같은 일반론은 현재 코드와 다릅니다.

## 인덱스/검색 관련 성능

인덱스는 `.file_index_cache.txt`를 먼저 로드하고, 서버 응답을 막지 않는 백그라운드 빌드를 즉시 시작합니다.

관련 설정:

- `INDEX_WORKERS`
- `SEARCH_WORKERS`
- `INDEX_REFRESH_INTERVAL_MINUTES`
- `SEARCH_FALLBACK_MAX_FILES`
- `SEARCH_FALLBACK_TIMEOUT_MS`

운영 스크립트는 검색 폴백을 사실상 비활성화하는 값으로 실행합니다.

## 썸네일/피라미드 런타임 값

`api/config.py`의 기본값보다 실제 시작 스크립트 override가 더 중요합니다.

### Windows `start.ps1`

- `THUMBNAIL_FORMAT=JPEG`
- `THUMBNAIL_QUALITY=100`
- `PYRAMID_FORMAT=JPEG`
- `PYRAMID_Q=100`
- `PYRAMID_KERNEL=cubic`
- `PYRAMID_LOADER_MODE=random`
- `USE_TURBOJPEG=1`

### Ubuntu `start.sh`

- `THUMBNAIL_FORMAT=JPEG`
- `THUMBNAIL_QUALITY=100`
- `PYRAMID_FORMAT=JPEG`
- `PYRAMID_Q=100`
- `PYRAMID_KERNEL=cubic`
- `PYRAMID_LOADER_MODE=random`
- `USE_TURBOJPEG=1`

## 현재 concurrency 관련 핵심값

- `IO_THREADS`
- `THUMBNAIL_SEM`
- `THUMB_PREFETCH_BATCH`
- `THUMB_CLIENT_MAX_CONCURRENCY`
- `INDEX_WORKERS`
- `SEARCH_WORKERS`
- `VIPS_CONCURRENCY`
- `COMPOSITE_MAX_WORKERS`
- `COMPOSITE_RENDER_WORKERS`
- `COMPOSITE_SAVE_WORKERS`

하지만 Uvicorn 자체는 단일 worker 고정이라는 점이 가장 중요합니다.

## preload와 프런트 네트워크 경로

예전 문서의 preload/modulepreload 설명은 현재 `index.html` 기준 최신이 아닙니다.

현재는:

- `dns-prefetch`는 남아 있음
- 예전 preload/modulepreload는 정본으로 보기 어려움

## 현재 이미지 경로 최적화 포인트

- 원본과 썸네일은 `no-store`
- 피라미드는 장기 immutable 캐시
- 개인색/필터는 캐시 경로 자체를 분리
- composite는 별도 결과 경로와 캐시를 사용
- grid 썸네일은 TurboJPEG 사용 가능 시 해당 경로를 활용

## 2026-06-08 formal E2E 성능 기준값

실행 명령:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-e2e-playwright.ps1 -Headless
```

세션:

- `SESSION=20260608-075006-6b0cd897`
- `BASE_URL=https://127.0.0.1:8443`
- `SUMMARY=D:\project\mapviewer\.codex-tmp\e2e-sessions\20260608-075006-6b0cd897\e2e-summary.json`
- `COLD_START_SUMMARY=D:\project\mapviewer\.codex-tmp\e2e-sessions\20260608-075006-6b0cd897\cold-start-summary.json`
- `REPORT=D:\project\mapviewer\.codex-tmp\e2e-sessions\20260608-075006-6b0cd897\e2e-report.txt`

최종 판정:

- `RESULT_SUMMARY status=PASS pass=27 fail=0`
- `PROCESS_CLEANUP status=PASS`
- stderr는 비어 있었고, timeout/warning/runtime exception은 없었다.

핵심 성능값:

| 항목 | 값 | 의미 |
|------|----|------|
| Fresh boot `domLoadedMs` | `1043ms` | 첫 `GET /`부터 `DOMContentLoaded`까지 |
| Fresh boot `viewerReadyMs` | `1644ms` | 첫 `GET /`부터 `window.viewer` 및 `window.__l3FullViewerReady=true`까지 |
| Fresh boot `explorerReadyMs` | `1657ms` | 첫 `GET /`부터 Explorer folder DOM 준비까지 |
| Viewer init after DOM | `601ms` | `viewerReadyMs - domLoadedMs`; DOM 이후 full viewer 준비 구간 |
| Fresh boot grid | `gridCount=5000`, `wraps=5000`, `visibleWraps=4`, `loadedVisible=4` | recursive `unknown` 5000장 그리드가 실제 DOM/visible thumbnail까지 뜬 상태 |
| Unknown grid/index phase | `loadMs=2030ms`, `count=5000`, `wraps=5000`, `broken=0` | phase `36,37,38,40`; 인덱스 build 시간이 아니라 unknown 5000장 그리드/DOM/무결성 확인 wall time |
| Cache/FQ grouped phase | `fqLoadMs=1921ms`, `fqCount=5000`, `wraps=5000`, `placeholders=0` | phase `46,52,53,54,55,58,59,61,62,63`; 단일 F/Q 생성 시간이 아니라 grouped grid/cache/FQ-missing/asset-version 검증 wall time |
| Search exact | `5.119ms` | `api exact q` |
| Search logical OR | `30.34ms` | `api logical or` |
| Search `lot_multi` | `0.886ms` | indexed LOT multi-search |
| Search `lot_wafer` | `0.625ms` | indexed LOT/Wafer search |
| Composite 10장 | `elapsedSec=3.9`, `processingTime=2.94`, `numba.warmed=true`, `threads=16` | browser wall time 및 server-reported composite processing time |
| Chip label wafer lookup | `annotationAvgMs=2.6`, `lookupMs=70.1` | chip label annotation 평균 및 wafer lookup |
| MY LOT lot 10 | `lotSaveMs=114.4`, `lotGridReadyMs=68`, `lotGridVisibleMs=16` | LOT 10개 paste/save/grid visible |
| MY LOT wafer 30 | `waferSaveMs=287.4`, `waferPositionVerifyMs=148`, `waferGridReadyMs=47`, `waferGridVisibleMs=42` | wafer 30개 save/grid visible; `waferPositionVerifyMs`는 E2E 검증 시간이지 save/copy 시간이 아님 |
| MY LOT total | `3160ms` | `mylot-wafer30-lot10-perf` 전체 wall time |

Fresh boot 비교 참고:

- 저장된 과거 boot smoke 51개 기준 `viewerReadyMs` 평균은 `1154ms`, median은 `1053ms`, P75는 `1292ms`, 범위는 `648~1894ms`.
- 2026-06-08 formal phase `0`의 `viewerReadyMs=1644ms`는 과거 평균/median보다 느린 쪽이지만 과거 범위 밖은 아니다.
- 이번 측정에서 증가분은 `WaferMapViewer` 생성보다 `domLoadedMs=1043ms` 구간 영향이 크다. 성능 회귀를 판단할 때 `domLoadedMs`와 `viewerReadyMs - domLoadedMs`를 분리해서 본다.

## 문서에서 제거해야 하는 오래된 설명

현재 기준으로 아래 설명은 정본이 아닙니다.

- Brotli/GZip 적용 수치
- HTTP/2 효과 수치
- preload 최적화 수치
- 다중 Uvicorn worker 권장표
- 구현 여부가 불명확한 프런트 최적화 아이디어 목록
