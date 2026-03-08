# 피라미드 썸네일

## 개요

피라미드 이미지는 `GET /api/image?level=...` 경로로 제공되며, 서버 캐시와 브라우저 내부 피라미드를 함께 사용합니다. 현재 구현 정본은 `api/main.py`, `api/config.py`, `js/main.js`, `js/semiconductor-renderer.js`입니다.

## 레벨과 줌 기준

서버와 프런트는 `/api/config`로 내려오는 값을 기준으로 같은 레벨 체계를 사용합니다.

- 기본 `PYRAMID_LEVELS`: `0.2, 0.5, 0.7, 1.0`
- 기본 `PYRAMID_ZOOM_THRESHOLDS`: `0.25, 0.5, 0.75`

요청 레벨이 정확히 일치하지 않으면 서버는 가장 가까운 configured level로 보정합니다.

## 캐시 구조

현재 피라미드 캐시는 단순 `pyramid_{scheme}_{level}` 구조보다 더 세분화됩니다.

- 비개인색: `thumbnails/pyramid_{levelTag}`
- 개인색: `thumbnails/{scheme}/{lastModified}/pyramid_{levelTag}`
- 필터 포함: `thumbnails/{scheme}/{lastModified}/pyramid_filter_{tokenHash}_{levelTag}`

즉 캐시 분리는 `scheme + lastModified + filter token + level` 기준입니다.

## 서버 생성 방식

현재 개인색/필터 피라미드는 원본 PNG를 메모리에서 패치한 뒤 각 레벨을 직접 생성합니다.

- 비개인색: 원본 기반 리사이즈
- 개인색: palette patch 후 리사이즈
- grade/bottom filter가 있으면 동일하게 패치된 원본 기준 생성

예전 문서처럼 "레벨 1.0을 먼저 만들고 다른 레벨이 그 파일을 다시 리사이즈한다"는 설명은 현재 기준 정본이 아닙니다.

## 포맷과 커널

- 기본 포맷은 `api/config.py` 기준 `WEBP`
- 런타임은 `start.ps1`, `start.sh`에서 `JPEG`로 override 가능
- 리사이즈 커널은 `PYRAMID_KERNEL` 기준이며 현재 기본은 `cubic`
- 문서에서 Lanczos3를 현재 구현처럼 설명하면 틀릴 수 있습니다.

## 클라이언트 동작

클라이언트는 서버 피라미드와 별개로 브라우저 메모리 내부 피라미드도 유지합니다.

- 줌 threshold를 넘으면 즉시 캔버스 레벨을 만듦
- 이후 `ImageBitmap`으로 품질을 올려 교체
- 서버 캐시와 클라이언트 피라미드가 함께 동작

## composite와의 관계

현재 프런트는 `composite_map/` 및 `composite_cache_v1/` 경로에 대해서는 서버 피라미드를 사용하지 않고 원본 `/api/image` 경로를 사용합니다.

## 관련 엔드포인트

- `GET /api/config`
- `GET /api/image`

## 관련 설정

- `PYRAMID_LEVELS`
- `PYRAMID_ZOOM_THRESHOLDS`
- `PYRAMID_FORMAT`
- `PYRAMID_Q`
- `PYRAMID_PNG_COMPRESSION`
- `PYRAMID_PNG_EFFORT`
- `PYRAMID_KERNEL`
- `PYRAMID_LOADER_MODE`
