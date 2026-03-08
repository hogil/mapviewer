# 개인색 설정 (Personalized Colors)

## 개요

개인색은 palette PNG의 팔레트를 사용자별 스킴으로 바꿔 응답하는 기능입니다. 현재 구현 정본은 `api/main.py`와 `api/personal_colors.py`입니다.

## 저장소

```text
logs/color-legends.json
```

최상위 사용자 스킴과 `composite` 하위 gradient 스킴이 함께 저장됩니다.

## 현재 적용 방식

현재 주 경로는 "PIL 전체 RGB 변환"이 아니라 서버가 PNG의 PLTE를 메모리에서 직접 패치하는 방식입니다.

- 원본 이미지: `GET /api/image`
- crop 이미지: `GET /api/image/crop`
- 썸네일: `GET /api/thumbnail`
- 피라미드: `GET /api/image?level=...`

이 경로에서 `personalized`, `scheme`, `grade_filter`, `bottom_filter`가 함께 적용될 수 있습니다.

## 스킴 결정

- 기본 기준은 현재 로그인 사용자 ID
- 사용자 정보는 `GET /api/auth/user`가 `colorScheme`으로 내려줌
- 로그인 정보가 없으면 fallback login id 사용
- 예전 레거시 문자열을 직접 scheme로 쓰는 방식은 현재 기준이 아님

즉 개인색은 "현재 사용자 스킴" 중심으로 동작합니다.

## 팔레트 인덱스 매핑

- `0~7`: `top.Grade0` ~ `top.Grade7`
- `8`: `background`
- `9`: `text`
- `10`: `bottom.Normal`
- `11`: `bottom.Invalid`
- `12~23`: `bottom.B285` ~ `bottom.B390`

`bottom.Normal`과 `bottom.Invalid`는 BIN이 아니라 고정 border 인덱스입니다.

## 캐시 분리

개인색 캐시는 사용자 스킴 기준으로 분리되며, 단순히 `scheme`만이 아니라 `lastModified`와 filter variant도 반영됩니다.

- 썸네일: `scheme + lastModified + filter variant`
- 피라미드: `scheme + lastModified + filter token + level`

현재 파일명은 원본 상대경로 기반 단순 조합이 아니라 해시 기반입니다.

## UI 상태

프런트 기본값은 개인색 ON입니다.

- `js/main.js`는 개인색을 기본 활성 상태로 사용
- 과거의 ON/OFF 체크박스 설명은 현재 UI 기준으로 stale일 수 있음
- 요청 URL에는 `personalized=true`, `scheme`, `grade_filter`, `bottom_filter`가 함께 붙을 수 있음

## composite와의 관계

개인색은 wafer 이미지에만 쓰이지 않습니다. composite도 개인색 팔레트의 배경과 border를 재사용합니다.

- composite 배경: 개인색 `background`
- composite border: 개인색 `bottom.Normal`
- composite 내부 gradient: `composite` 섹션의 사용자별 gradient

## 관련 엔드포인트

- `GET /api/auth/user`
- `POST /api/color-scheme`
- `DELETE /api/color-scheme`
- `GET /api/image`
- `GET /api/image/crop`
- `GET /api/thumbnail`

## 관련 파일

- `api/main.py`
- `api/personal_colors.py`
- `js/main.js`