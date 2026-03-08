# Role & Access Control (RBAC)

## 개요

현재 RBAC는 하나의 완성된 체계가 아니라 두 권한 시스템이 병존하는 상태입니다. 이 문서는 "현재 코드가 실제로 어떻게 동작하는가"를 기준으로 정리합니다.

## 현재 병존하는 두 체계

### 1. `logs/permissions.json` 기반 체계

- 저장 파일: `logs/permissions.json`
- 주요 API: `/api/roles/users`
- 메인 폴더 권한 검사: `api/main.py`의 `_check_folder_permission()`
- 현재 메인 UI 경로와 가장 직접적으로 연결됨

### 2. `logs/users.json` 기반 체계

- 저장 파일: `logs/users.json`
- 주요 API: `/api/users*`
- 구현 파일: `api/user_manager.py`
- 감사 로그: `logs/audit-roles-YYYYMMDD.jsonl`
- 별도 UI 코드 `js/permission-manager.js`가 이 경로를 사용

즉 문서에서 "`logs/permissions.json`만 정본"이라고 단정하면 현재 구현과 다릅니다.

## 실제 폴더 권한 검사

실제 라벨 쓰기와 클래스 관리 권한 검사는 `api/main.py`의 `_check_folder_permission()`이 담당합니다.

현재 적용 대상:

- `LABEL_WRITE`
- `CLASS_MANAGE`

읽기/탐색 전체를 전면 차단하는 구조는 아닙니다.

## 기본 허용 동작

현재 구현은 개발 편의성을 위해 명시적 권한 구성이 전혀 없을 때 기본 허용으로 동작할 수 있습니다.

즉:

- `permissions.json`에 사용자 정보가 없고
- `users.json`에도 bootstrap 사용자 외 실사용자 정보가 없으면
- 라벨/클래스 작업이 허용될 수 있습니다

문서에서 "권한 없으면 항상 차단"으로만 설명하면 현재 코드와 다릅니다.

## `logs/permissions.json` 구조

이 경로는 `loginId`, `role`, `folders[]` 구조를 사용합니다.

```json
{
  "users": [
    {
      "loginId": "alice",
      "role": "ROLE_POWER",
      "folders": [
        {
          "path": "positions/lot123",
          "allow_label": true,
          "allow_class": true
        }
      ]
    }
  ]
}
```

특징:

- 폴더 입력은 저장 시 `positions/<folder>` 형태로 정규화될 수 있음
- 일반 비교는 소문자 경로 기준
- `ROLE_ADMIN`, `ROLE_SUPER`는 사실상 전체 권한(`*`) 취급
- `loginId: "all"` 사용자를 전체 사용자 bootstrap 용도로 둘 수 있음

## `logs/users.json` 구조

이 경로는 enum 기반 `role + grants[]` 구조를 사용합니다.

```json
{
  "username": "alice",
  "role": "POWER",
  "grants": [
    {
      "folder": "positions/lot123",
      "level": "POWER"
    }
  ]
}
```

역할명도 `ROLE_POWER`가 아니라 `POWER` 같은 enum 체계를 사용합니다.

즉 두 파일은 이름만 다른 게 아니라 데이터 구조와 역할명 체계도 다릅니다.

## 역할 의미 차이

문서에서 역할을 하나의 단일 표로 설명하면 오해가 생길 수 있습니다.

- `permissions.json` 경로는 `ROLE_USER/ROLE_POWER/ROLE_ADMIN/ROLE_SUPER`
- `users.json` 경로는 `USER/POWER/ADMIN/SUPER`

또한 `api/user_manager.py` 기준으로 `USER`는 읽기 중심 역할이며, 예전 문서처럼 "일반 사용자가 라벨/클래스 추가·삭제"라고 단정할 수 없습니다.

## 현재 UI 경로

현재 권한 UI도 하나가 아닙니다.

### 메인 경로

- 프런트: `js/main.js`
- API: `/api/roles/users`
- 저장 파일: `logs/permissions.json`

### 별도 관리자 경로

- 프런트: `js/permission-manager.js`
- API: `/api/users*`
- 저장 파일: `logs/users.json`

따라서 `js/permission-manager.js`만 현재 권한 UI라고 설명하면 실제 화면 경로와 어긋날 수 있습니다.

## 감사 로그

감사 로그는 모든 권한 변경에 공통으로 남지 않습니다.

- `/api/users*` 경로 변경은 `logs/audit-roles-YYYYMMDD.jsonl`에 기록
- 현재 메인 `/api/roles/users` 경로는 동일한 감사 로그를 남기지 않음

즉 "모든 권한 변경이 감사 로그에 남는다"는 문장은 현재 코드 기준으로 틀립니다.

## 현재 API

`permissions.json` 계열:

- `GET /api/roles/users`
- `POST /api/roles/users`
- `DELETE /api/roles/users/{login_id}`

`users.json` 계열:

- `GET /api/users`
- `PUT /api/users/{username}/role`
- `POST /api/users/{username}/grants`
- `DELETE /api/users/{username}/grants`
- `GET /api/audit-logs`

## 현재 권한 체크 특징

- `/api/roles/users`의 `GET`은 현재 읽기 권한 체크가 없음
- `/api/roles/users`의 `POST`/`DELETE`는 관리자 권한 필요
- 실제 폴더 권한은 서버가 403으로 막는 구조가 중심
- 문서에서 "UI 버튼 비활성화 + hover 툴팁"을 확정 동작처럼 쓰면 근거가 약함

## 현재 문서 해석 원칙

이 문서는 미래 설계 문서가 아니라 현재 병존 상태를 기록하는 문서입니다.

정리하면:

- 권한 파일은 하나가 아님
- 역할 enum도 하나가 아님
- 감사 로그도 한 경로에만 붙음
- 실제 쓰기 권한 검사는 `_check_folder_permission()`이 중심
