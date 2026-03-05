# Role & Access Control (RBAC)

## 개요

현재는 모든 사용자가 모든 폴더에서 라벨링/클래스 관리 가능.
이 문서는 제품 폴더별 권한 + 역할 계층 도입 설계를 정의한다 (미구현).

---

## 역할 계층

| 역할 | 설명 | 포함 권한 |
|------|------|----------|
| `ROLE_USER` | 일반 사용자 | 지정 폴더에서 라벨/클래스 추가·삭제 |
| `ROLE_POWER` | 파워 유저 | USER 권한 + 일반 사용자 관리 |
| `ROLE_ADMIN` | 관리자 | POWER 권한 + 관리자 등록/삭제 + 글로벌 설정 |
| `ROLE_SUPER` | 최고 권한 | ADMIN 권한 + 시스템 전역 설정 + 긴급 잠금 |

- SUPER는 DevOps 전용, 1~2명만 보유
- 상위 역할은 하위 역할 권한을 모두 포함

---

## 권한 매트릭스

| 권한 | USER | POWER | ADMIN | SUPER |
|------|------|-------|-------|-------|
| LABEL_WRITE | ✅ | ✅ | ✅ | ✅ |
| CLASS_MANAGE | ✅(본인) | ✅ | ✅ | ✅ |
| USER_MANAGE | ❌ | ✅ | ✅ | ✅ |
| POWER_MANAGE | ❌ | ❌ | ✅ | ✅ |
| ADMIN_MANAGE | ❌ | ❌ | ❌ | ✅ |
| SYSTEM_SETTINGS | ❌ | 조회만 | ✅ | ✅ |

---

## 제품 폴더 스코프

모든 권한은 "행동 권한 + 폴더 스코프" 두 조건을 모두 충족해야 한다.

```json
{
  "username": "alice",
  "role": "ROLE_POWER",
  "grants": [
    { "folder": "LOT123", "permissions": ["LABEL_WRITE", "CLASS_MANAGE"] },
    { "folder": "LOT456", "permissions": ["LABEL_WRITE"] }
  ]
}
```

- `folder="*"` → 전체 폴더 (SUPER/ADMIN만)
- 권한 불충족 시 403 반환
- UI: 버튼 비활성화 + hover 시 안내 툴팁 (숨기지 않음)

---

## 감사 로그

모든 권한 변경/사용자 관리 작업은 `logs/roles/audit-YYYYMMDD.jsonl`에 기록 (append-only).

```json
{
  "timestamp": "...",
  "actor": "admin1",
  "action": "grant_permission",
  "target": "user123",
  "folder": "LOT123",
  "permissions": ["LABEL_WRITE"]
}
```

---

## 마이그레이션 전략

1. SUPER 계정 생성, 기존 관리자 → ROLE_ADMIN 매핑
2. 사용자 테이블에 `role`, `grants` 필드 추가 (초기: 모든 사용자에게 `folder="*"` 전체 권한)
3. 백엔드 권한 검사 로직 + UI 버튼 상태 제어 추가
4. 운영 데이터 기반으로 폴더별 권한 세분화 후 기본값 제거
