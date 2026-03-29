# API Reference

L3 Tracker의 전체 API 엔드포인트 목록입니다. 정본: `api/main.py`.

서버 실행: `python -m api.main` → `https://localhost:8443`

## 인증 (SAML)

| Method | Path | 설명 |
|--------|------|------|
| GET | `/saml/metadata` | SP 메타데이터 |
| GET | `/saml/login` | IdP 리다이렉트 시작 |
| POST | `/saml/acs` | Assertion Consumer Service |
| GET | `/saml/dev-login` | 개발용 계정 주입 |
| GET | `/api/auth/user` | 현재 세션 사용자 정보 |
| GET | `/api/sso/ping` | 외부 SSO 헬스 체크 |

## 설정/상태

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/config` | 프론트 설정 (pyramid levels, 동시성 등) |
| GET | `/api/index-status` | 인덱스 빌드 상태 |
| GET | `/api/index/status` | 인덱스 상세 상태 |
| GET | `/status` | 서버 상태 |
| GET | `/api/current-folder` | 현재 폴더 |
| GET | `/api/root-folder` | 루트 폴더 |
| POST | `/api/change-folder` | 폴더 변경 |

## 파일 탐색/검색

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/files` | 현재 폴더 목록 |
| GET | `/api/files/all` | 전체 파일 목록 |
| GET | `/api/files/recursive` | 재귀적 파일 목록 |
| GET | `/api/browse-folders` | 폴더 브라우저 |
| GET | `/api/search` | 파일명 검색 (AND/OR/NOT 지원) |
| GET | `/api/filter-metadata` | 메타데이터 기반 필터 |

## 이미지

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/image` | 원본/피라미드 이미지 (level, personalized, filter 지원) |
| GET | `/api/image/size` | 이미지 크기 정보 |
| GET | `/api/image/crop` | 이미지 crop |
| GET | `/api/thumbnail` | 썸네일 (pyvips, 고품질) |
| POST | `/api/thumbnail/preload` | 썸네일 배치 프리패치 |
| GET | `/api/bin-map-thumb` | BIN map 썸네일 |
| GET | `/api/measure-thumb` | Measure 썸네일 |
| POST | `/api/measure-thumb-batch` | Measure 썸네일 배치 |
| GET | `/api/palette-counts` | 팔레트 인덱스별 픽셀 카운트 |

## 개인색 (Personalized Colors)

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/color-scheme` | 개인색 저장 |
| DELETE | `/api/color-scheme` | 개인색 삭제 |
| POST | `/api/color-scheme-ratio` | 색상 비율 저장 |
| GET | `/api/composite-colors` | Composite gradient 조회 |
| POST | `/api/composite-colors` | Composite gradient 저장 |
| GET | `/api/measure-colors` | Measure 색상 조회 |
| POST | `/api/measure-colors` | Measure 색상 저장 |
| GET | `/api/gradient-stats` | Gradient 통계 |

## Composite Map

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/composite-map` | Composite map 생성 (비동기, 최대 256장) |
| GET | `/api/composite-map/status/{task_id}` | 생성 진행 상태 |
| POST | `/api/composite-subset` | Subset map 생성 (선택 grade만) |
| POST | `/api/composite-recolor` | NPZ 캐시 기반 재색칠 |
| POST | `/api/composite-cleanup` | Composite 결과 정리 |

## Measure Composite

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/measure-composite-data` | Measure composite 데이터 생성 |
| POST | `/api/measure-composite` | Measure composite 이미지 생성 |
| POST | `/api/measure-composite-recolor` | Measure composite 재색칠 |

## 분류 (Classification)

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/classes` | 클래스 목록 |
| POST | `/api/classes` | 클래스 생성 |
| DELETE | `/api/classes/{class_name}` | 클래스 삭제 |
| POST | `/api/classes/rename` | 클래스 이름 변경 |
| POST | `/api/classes/delete` | 클래스 배치 삭제 |
| GET | `/api/classes/{class_name}/images` | 클래스별 이미지 목록 |
| POST | `/api/classify` | 이미지에 라벨 부여 |
| POST | `/api/classify/batch` | 배치 분류 |
| DELETE | `/api/classify` | 라벨 제거 |
| POST | `/api/classify/delete` | 라벨 배치 삭제 |
| GET | `/api/labels/{image_path}` | 이미지 라벨 조회 |
| POST | `/api/labels` | 라벨 저장 |
| DELETE | `/api/labels` | 라벨 삭제 |
| POST | `/api/labels/delete` | 라벨 배치 삭제 |

## Chip Annotation

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/chip-positions` | positions.json 조회 |
| GET | `/api/chip-annotations` | chip annotation 조회 |
| POST | `/api/classify/chips` | chip crop + annotation 저장 |
| GET | `/api/classify/chips/{wafer_name}` | wafer별 chip 분류 조회 |
| POST | `/api/chip-images/extract` | chip crop 이미지 추출 |

## MY LOT

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/my-lot` | MY LOT 전체 조회 |
| GET | `/api/my-lot/groups` | 그룹 목록 |
| GET | `/api/my-lot/entries` | 엔트리 목록 |
| POST | `/api/my-lot/group` | 그룹 생성 |
| PUT | `/api/my-lot/group/rename` | 그룹 이름 변경 |
| DELETE | `/api/my-lot/group` | 그룹 삭제 |
| POST | `/api/my-lot` | 엔트리 추가 |
| POST | `/api/my-lot/batch` | 엔트리 배치 추가 |
| POST | `/api/my-lot/manual` | 수동 엔트리 추가 |
| DELETE | `/api/my-lot` | 엔트리 삭제 |
| DELETE | `/api/my-lot/batch` | 엔트리 배치 삭제 |

## 사용자/권한 (RBAC)

두 권한 체계가 병존합니다. 상세는 `docs/ROLE_ACCESS.md` 참조.

### permissions.json 계열

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/roles/users` | 권한 사용자 목록 |
| POST | `/api/roles/users` | 권한 사용자 추가/수정 |
| DELETE | `/api/roles/users/{login_id}` | 권한 사용자 삭제 |

### users.json 계열

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/users` | 사용자 목록 |
| GET | `/api/users/{username}` | 사용자 조회 |
| POST | `/api/users` | 사용자 생성 |
| PUT | `/api/users/{username}/role` | 역할 변경 |
| POST | `/api/users/{username}/grants` | 폴더 권한 부여 |
| DELETE | `/api/users/{username}/grants` | 폴더 권한 제거 |
| DELETE | `/api/users/{username}` | 사용자 삭제 |
| GET | `/api/users/search` | 사용자 검색 |
| GET | `/api/audit-logs` | 감사 로그 |

## 통계

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/stats/daily` | 일별 통계 |
| GET | `/api/stats/trend` | 트렌드 |
| GET | `/api/stats/monthly` | 월별 통계 |
| GET | `/api/stats/users` | 사용자별 통계 |
| GET | `/api/stats/recent-users` | 최근 접속 사용자 |
| GET | `/api/stats/user/{user_id}` | 특정 사용자 통계 |
| GET | `/api/stats/active-users` | 활동 사용자 |
| GET | `/api/stats/department` | 부서별 통계 |
| GET | `/api/stats/export-csv` | CSV 내보내기 |
| GET | `/api/stats/breakdown` | 상세 분석 |

## 캐시/설정

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/cache` | 캐시 무효화 |
| POST | `/api/cache/all` | 전체 캐시 무효화 |
| GET | `/api/user-prefs` | 사용자 환경설정 조회 |
| PUT | `/api/user-prefs` | 사용자 환경설정 저장 |

## 정적 파일

| Method | Path | 설명 |
|--------|------|------|
| GET | `/` | index.html |
| GET | `/stats` | stats.html |
| GET | `/js/{filename}` | JS 모듈 |
| GET | `/css/{filename}` | CSS |
| GET | `/logs/color-legends.json` | 색상 설정 파일 |
