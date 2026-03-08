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

## 문서에서 제거해야 하는 오래된 설명

현재 기준으로 아래 설명은 정본이 아닙니다.

- Brotli/GZip 적용 수치
- HTTP/2 효과 수치
- preload 최적화 수치
- 다중 Uvicorn worker 권장표
- 구현 여부가 불명확한 프런트 최적화 아이디어 목록
