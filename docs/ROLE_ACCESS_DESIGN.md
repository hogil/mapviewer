# Role & Access Control Design

## 개요

웨이퍼 뷰어는 현재 라벨링/클래스 관리 기능을 전 사용자에게 개방하고 있다. 이 문서는 제품 폴더별 권한, 역할별 책임, 관리 기능을 구조적으로 도입하기 위한 설계를 정의한다. 구현 언어/프레임워크에 종속되지 않는 개념 모델만을 다루며, 향후 API/DB/UI에 동일한 원칙을 적용한다.

---

## 핵심 원칙

1. **역할(Role)** 과 **제품 폴더 권한(Product Scope)** 을 분리한다.  
   - 역할은 사용자가 수행할 수 있는 행동(라벨 CRUD, 사용자 관리 등)을 정의한다.  
   - 제품 폴더 권한은 특정 폴더(예: `wafer/A1`, `batch/batch_01`)에서 해당 역할을 실행할 수 있는지 여부를 결정한다.

2. **권한 최소화**: 사용자는 명시적으로 부여된 폴더/행동에서만 작업 가능하다.

3. **감사 가능성**: 사용자·역할·제품·행동이 모두 로그로 남아야 한다.

---

## 역할 계층

| 역할 ID | 설명 | 포함 권한 요약 |
| --- | --- | --- |
| `ROLE_USER` | 일반 사용자 | 지정된 폴더에서 라벨/클래스 추가·삭제 |
| `ROLE_POWER` | 파워 유저 | `ROLE_USER` 권한. <br>※ Admin이 부여하며, 다른 파워유저를 임명하거나 권한 위임 불가 |
| `ROLE_ADMIN` | 관리자 | `ROLE_POWER` 권한 + 파워/일반 유저 관리 + 다른 관리자 등록/삭제, 글로벌 설정 |
| `ROLE_SUPER` | 앱 개발자(최고 권한) | `ROLE_ADMIN` 권한 + 시스템 전역 설정, 긴급 잠금 |

- `ROLE_SUPER` 는 DevOps/개발팀 전용으로 배포 시 1~2명만 보유.
- 모든 역할은 상위 역할 권한을 포함한다.

---

## 권한 도메인 분리

### 1. 기능 권한 (Action Permissions)

| 권한 코드 | 설명 |
| --- | --- |
| `LABEL_WRITE` | 라벨 추가·삭제 |
| `CLASS_MANAGE` | 클래스(add/delete/rename) |
| `USER_MANAGE` | 일반 사용자 생성/삭제, 폴더 권한 매핑 |
| `POWER_MANAGE` | 파워 사용자 생성/삭제, 역할 변경 |
| `ADMIN_MANAGE` | 관리자 생성/삭제 (ROLE_SUPER만) |
| `SYSTEM_SETTINGS` | 썸네일/인덱스/환경 변수 등 시스템 설정 |

각 역할이 기본적으로 소유하는 권한:

| 역할 | LABEL_WRITE | CLASS_MANAGE | USER_MANAGE | POWER_MANAGE | ADMIN_MANAGE | SYSTEM_SETTINGS |
| --- | --- | --- | --- | --- | --- | --- |
| USER | ✅ | ✅(본인이 만든 클래스) | ❌ | ❌ | ❌ | ❌ |
| POWER | ✅ | ✅ | ✅ | ✅ | ❌ | 제한적(조회) |
| ADMIN | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SUPER | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 2. 제품 폴더 권한 (Resource Scope)

모든 권한은 **제품 폴더** 단위로 스코프를 갖는다. 예시:

```jsonc
{
  "username": "alice",
  "role": "ROLE_POWER",
  "grants": [
    { "folder": "batch/batch_01", "permissions": ["LABEL_WRITE", "CLASS_MANAGE"] },
    { "folder": "wafer/A1", "permissions": ["LABEL_WRITE"] }
  ]
}
```

- `folder="*"` 는 전체 제품을 의미한다 (SUPER/ADMIN만 사용).
- 폴더 권한은 계층적이며, 상위 권한이 하위 폴더에 자동 적용된다.
- UI는 현재 선택된 폴더에 대해 사용자 권한을 즉시 표시해야 한다 (예: “읽기 전용” 배지).

---

## 사용자/역할 관리 플로우

1. **SUPER**:
   - 다른 SUPER 를 제외한 모든 계정/역할을 관리.
   - 시스템 전역 설정 (썸네일 클린, ENV 교체, 강제 로그아웃 등).
2. **ADMIN**:
   - 관리자/파워/일반 유저를 모두 생성·삭제 가능. 파워유저 승격·강등도 Admin만 수행.
   - 제품 폴더 권한을 지정/회수하며, 지정 시 감사 로그에 저장.
   - 모든 제품 폴더에서 라벨/클래스 작성·수정 권한을 자동 보유.
3. **POWER**:
   - Admin이 명시적으로 지정한 제품 폴더에서만 라벨/클래스 작업 가능.
   - 다른 유저를 파워로 임명하거나 폴더 권한을 배포할 수 없음.
4. **USER**:
   - 부여받은 폴더 범위에서 라벨/클래스 작업만 가능.

모든 관리/권한 작업은 감사 로그에 **actor, target_user, role_change, folder_scope, timestamp** 와 함께 기록한다.  
- 저장 위치: `logs/roles/audit-YYYYMMDD.jsonl` (append-only).  
- Admin 이상의 UI는 이 파일을 읽어 필터링/검색/다운로드만 제공하며, 편집은 불가하다.  
- 역할 편집 모달 하단에는 “저장 시 logs/roles/... 에 기록됩니다” 안내문을 고정 표기하여 투명성을 확보한다.

---

## 라벨링/클래스 권한 모델

라벨/클래스 작업은 “행동 권한 + 폴더 권한” 두 가지 조건을 모두 충족해야 한다.

1. 요청의 `image_path` 또는 `class` 가 속한 제품 폴더를 추출.
2. 사용자 세션의 `grants` 중 해당 폴더를 포함하고 `LABEL_WRITE` 혹은 `CLASS_MANAGE` 권한이 있는지 검사.
3. 조건 불충족 시 403 반려.

폴더별로 “읽기 전용”이 필요한 경우 `LABEL_READ` 같은 권한을 추가해 뷰어만 허용할 수 있다.

---

## UI/UX 가이드

1. **권한 배지 표시**
   - 상단 패널에 현재 사용자, 역할, 선택된 폴더에서의 권한을 배지로 표시.
   - 예: `User (batch/batch_01: 라벨 가능 / 클래스 X)`

2. **버튼/메뉴 제어**
   - 버튼을 숨기지 말고 비활성화하며, hover 시 “이 폴더에서 라벨 권한이 없습니다” 등 안내툴팁 제공.

3. **관리 도구**
   - Power 이상: “사용자 관리” 패널에서 일반 사용자/폴더 권한 편집.
   - Admin: 파워유저 탭 + 시스템 설정 탭.
   - Super: 관리자 탭 + 환경변수/썸네일 캐시 등 최상위 설정.

4. **폴더 선택 시 권한 재평가**
   - 폴더를 바꿀 때마다 권한 매트릭스를 다시 계산하여 UI 상태를 즉시 반영.

---

## API/데이터 확장

- **User Schema 예시**
  ```jsonc
  {
    "username": "alice",
    "role": "ROLE_POWER",
    "grants": [
      {
        "folder": "batch/batch_01",
        "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]
      }
    ],
    "created_by": "admin1",
    "created_at": "2025-11-10T09:00:00Z"
  }
  ```

- **역할 변경 API 보안**
  - `POST /api/users` : ROLE ≥ targetRole + 1만 허용 (예: ROLE_POWER는 ROLE_USER만 생성 가능).
  - `PATCH /api/users/{id}/role` : 같은 규칙.
  - `PATCH /api/users/{id}/grants` : POWER는 USER 폴더 권한만, ADMIN은 POWER/USER.

- **세션/토큰**
  - 로그인 응답에 `role`, `grants` 포함.
  - 서버측에서 폴더 권한 변경 시 세션 무효화(재로그인 요구) 또는 푸시.

---

## 감사 및 모니터링

- 모든 사용자 관리/폴더 권한/라벨 작업은 `audit.log` 형태로 저장:
  ```json
  {
    "timestamp": "...",
    "actor": "admin1",
    "action": "grant_permission",
    "target": "user123",
    "folder": "batch/batch_01",
    "permissions": ["LABEL_WRITE"]
  }
  ```
- 관리자 전용 UI에서 기간/actor별 필터 제공.

---

## 마이그레이션 전략

1. **1단계**: `ROLE_SUPER` 계정 생성, 기존 관리자 계정을 ROLE_ADMIN으로 매핑.
2. **2단계**: 사용자 테이블에 `role` 과 `grants` 필드 추가. 초기에는 모든 사용자에게 `folder="*"` + `LABEL_WRITE`,`CLASS_MANAGE` 부여.
3. **3단계**: UI/백엔드에 권한 검사 로직 추가, 권한 기반 버튼 상태 적용.
4. **4단계**: 실제 운영 데이터에 폴더별 권한 세분화 후 기본값 제거.

---

## 요약

1. 역할 4단계(일반/파워/관리자/슈퍼)로 행동 권한을 정의한다.
2. 모든 권한은 제품 폴더 스코프와 결합돼야 하며, 라벨링은 폴더별 허용 여부가 분리돼야 한다.
3. 사용자 관리 권한은 역할 계층을 따르며, SUPER만 다른 Admin을 관리할 수 있다.
4. UI는 권한 상태를 항상 노출하고, 버튼 비활성화 + 안내툴팁으로 사용자 경험을 보장한다.
5. 모든 민감 작업은 audit 로그로 남기고, Power/Admin/Super 전용 관리 화면을 제공한다.
