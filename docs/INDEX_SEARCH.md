# 파일 인덱스 & 검색

# 파일 인덱스 & 검색

현재 검색 구현 정본은 `api/main.py`, `api/index_service.py`, `api/search_service.py`입니다.

## 인덱스 기본 동작

인덱스는 상대 경로 목록을 `.file_index_cache.txt`에 저장합니다.

서버 시작 시:

1. 기존 캐시 파일을 먼저 로드
2. 서버 응답을 막지 않는 백그라운드 빌드를 즉시 시작
3. 자동 재빌드가 켜져 있으면 refresh loop도 시작 직후 1회 실행

즉 "서버 시작 후 첫 주기까지 기다렸다가 첫 재빌드"가 아니라, 시작 직후 한 번 재빌드가 바로 돌 수 있습니다.

## 관련 설정

- `INDEX_REFRESH_INTERVAL_MINUTES`
- `INDEX_WORKERS`
- `SEARCH_WORKERS`
- `SEARCH_FALLBACK_MAX_FILES`
- `SEARCH_FALLBACK_TIMEOUT_MS`

`INDEX_REFRESH_INTERVAL_MINUTES=0`이면 자동 재빌드 루프를 끌 수 있습니다.

## 현재 검색 규칙

검색은 파일명 기준의 대소문자 무시 포함 검색입니다.

- 폴더명 자체를 별도 인덱스로 검색하지 않음
- 논리 검색은 `AND`, `OR`, `NOT`, 괄호 지원
- 논리 연산자 없는 다중 토큰 검색은 내부적으로 `OR` 검색 처리

## 검색 스코프

`/api/search`의 `folder` 파라미터는 `ROOT_DIR` 기준 상대경로로 해석됩니다.

- `folder` 미지정: `current_folder` 기준
- `folder=""`: 전체 `ROOT_DIR`
- `current_folder` 변경: `/api/change-folder`

## 인덱스 폴백

인덱스가 비어 있을 때만 파일시스템 직접 스캔 폴백이 동작합니다.

- "검색 결과가 없을 때마다 폴백"은 현재 구현과 다름
- 운영 스크립트에서는 보통 폴백을 사실상 비활성화하는 값으로 실행함

## 다중 LOT 검색

다중 LOT 검색은 대량 입력을 받아 파일명 prefix를 기준으로 필터링합니다.

LOT 판정 규칙:

```text
{LOT}_{something}
→ 첫 번째 `_` 앞 토큰을 LOT로 사용
```

입력 파서는 줄바꿈만이 아니라 여러 구분자를 허용합니다.

- `,`
- `\n`
- `\r`
- `\t`
- `;`
- `/`

파일명이나 경로를 통째로 붙여넣어도 basename을 뽑고 첫 `_` 앞 토큰을 LOT로 사용합니다.

추가 규칙:

- 소문자 정규화
- 중복 제거
- 최대 100개까지만 처리

## 현재 LOT 검색 구현 주의

예전 문서처럼 `by_lot` 딕셔너리 O(1) 조회를 설명하면 현재 코드와 다릅니다.

현재는:

- 인덱스된 파일명에서 basename 추출
- 첫 `_` 앞 토큰 비교
- 일치 항목 필터링

즉 별도 `by_lot` 전용 인덱스를 유지하는 구조가 아닙니다.

## 관련 엔드포인트

- `GET /api/search`
- `GET /api/index/status`
- `GET /api/files`
- `GET /api/files/all`
- `POST /api/change-folder`
