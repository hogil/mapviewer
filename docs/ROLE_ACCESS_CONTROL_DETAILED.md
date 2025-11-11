# Role & Access Control 상세 설계 문서

## 📋 목차

1. [개요](#개요)
2. [핵심 원칙](#핵심-원칙)
3. [역할 계층](#역할-계층)
4. [데이터 모델](#데이터-모델)
5. [API 상세 스펙](#api-상세-스펙)
6. [프론트엔드 구현](#프론트엔드-구현)
7. [보안 고려사항](#보안-고려사항)
8. [마이그레이션 전략](#마이그레이션-전략)
9. [테스트 시나리오](#테스트-시나리오)

---

## 개요

웨이퍼 맵 뷰어에 **역할 기반 접근 제어(RBAC)** 및 **제품 폴더별 권한 관리**를 도입합니다.

**문제점:**
- 현재 모든 사용자가 모든 폴더에서 라벨링/클래스 관리 가능
- 책임 소재 불명확, 실수로 인한 데이터 손실 위험
- 관리자 권한 부재

**해결책:**
- 4단계 역할 계층: USER → POWER → ADMIN → SUPER
- 제품 폴더별 세분화된 권한 부여
- 모든 권한 변경 감사 로그 기록

---

## 핵심 원칙

### 1. 역할(Role)과 제품 폴더 권한(Scope) 분리

```
역할 = "무엇을 할 수 있는가" (행동 권한)
Scope = "어디서 할 수 있는가" (리소스 범위)
```

**예시:**
```json
{
  "username": "alice",
  "role": "ROLE_POWER",          // 행동 권한: 라벨링, 클래스 관리
  "grants": [
    {
      "folder": "LOT123",          // 리소스: LOT123 폴더
      "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]
    },
    {
      "folder": "LOT456",          // 리소스: LOT456 폴더
      "permissions": ["LABEL_WRITE"]  // 클래스 관리 불가
    }
  ]
}
```

### 2. 권한 최소화 (Principle of Least Privilege)

- 사용자는 **명시적으로 부여된 권한**만 행사 가능
- 기본값은 **읽기 전용** (라벨링/클래스 관리 불가)

### 3. 감사 가능성 (Auditability)

모든 권한 변경 및 관리 작업은 **변경 불가능한 로그**로 기록:

```json
{
  "timestamp": "2025-11-10T15:30:45Z",
  "actor": "admin_user",
  "action": "grant_permission",
  "target_user": "alice",
  "folder": "LOT123",
  "permissions": ["LABEL_WRITE"],
  "ip": "192.168.1.100"
}
```

---

## 역할 계층

### ROLE_USER (일반 사용자)

**권한:**
- 부여받은 폴더에서 라벨 추가/삭제
- 부여받은 폴더에서 클래스 추가 (자신이 만든 클래스만 삭제 가능)
- 자신의 개인색 설정 관리

**제한:**
- 다른 사용자의 클래스 삭제 불가
- 사용자 관리 불가
- 시스템 설정 조회/변경 불가

**UI 표시:**
```
┌─────────────────────────────────────┐
│ 👤 Alice (USER)                     │
│ 📁 LOT123: 라벨 ✓ | 클래스 ✓       │
│ 📁 LOT456: 라벨 ✓ | 클래스 ✗       │
└─────────────────────────────────────┘
```

---

### ROLE_POWER (파워 유저)

**권한:**
- ROLE_USER 권한 전부
- 부여받은 폴더에서 모든 클래스 관리 (다른 사용자가 만든 것도 삭제 가능)
- 시스템 설정 **조회** (변경 불가)

**제한:**
- 다른 사용자 관리 불가
- 자신에게 권한 추가 불가 (Admin만 가능)
- 다른 사용자를 POWER로 승격 불가

**사용 사례:**
- 팀 리더, 시니어 엔지니어
- 특정 제품 라인의 책임자

---

### ROLE_ADMIN (관리자)

**권한:**
- ROLE_POWER 권한 전부
- **모든 폴더**에서 라벨/클래스 작업 (`folder="*"` 자동 부여)
- USER/POWER 사용자 생성/삭제/권한 부여
- 다른 ADMIN 생성/삭제
- 시스템 설정 조회/변경 (썸네일 캐시 삭제, 인덱스 리빌드 등)

**제한:**
- SUPER 사용자 관리 불가
- 시스템 환경변수 변경 불가
- 서버 재시작 불가

**UI 기능:**
```
관리자 패널:
├─ 사용자 관리
│  ├─ 일반 사용자 (CRUD)
│  ├─ 파워 사용자 (CRUD)
│  └─ 관리자 (CRUD)
├─ 권한 관리
│  ├─ 폴더별 권한 할당
│  └─ 권한 일괄 회수
├─ 감사 로그
│  ├─ 권한 변경 이력
│  └─ 라벨링 활동 로그
└─ 시스템 설정
   ├─ 썸네일 캐시 관리
   ├─ 파일 인덱스 관리
   └─ 통계 대시보드
```

---

### ROLE_SUPER (슈퍼 관리자)

**권한:**
- ROLE_ADMIN 권한 전부
- SUPER 사용자 관리 (생성/삭제)
- 시스템 환경변수 변경
- 서버 재시작/긴급 중지
- 모든 감사 로그 삭제 (긴급 상황 전용)

**제한:**
- **배포 시 1~2명만 보유** (DevOps/시스템 관리자)
- 일반 운영에서는 ADMIN으로 작업, 긴급 시에만 SUPER 권한 사용

---

## 데이터 모델

### User Schema

**저장 위치:** `{IMAGES_ROOT}/users/users.json`

```json
{
  "users": [
    {
      "login_id": "alice",
      "username": "Alice Kim",
      "dept_name": "Quality Assurance",
      "email": "alice@company.com",
      "role": "ROLE_POWER",
      "grants": [
        {
          "folder": "LOT123",
          "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]
        },
        {
          "folder": "batch/B001",
          "permissions": ["LABEL_WRITE"]
        }
      ],
      "created_by": "admin1",
      "created_at": "2025-11-01T10:00:00Z",
      "updated_by": "admin1",
      "updated_at": "2025-11-10T14:30:00Z",
      "is_active": true
    },
    {
      "login_id": "bob",
      "username": "Bob Lee",
      "dept_name": "Engineering",
      "email": "bob@company.com",
      "role": "ROLE_ADMIN",
      "grants": [
        {
          "folder": "*",
          "permissions": ["LABEL_WRITE", "CLASS_MANAGE", "USER_MANAGE"]
        }
      ],
      "created_by": "super_admin",
      "created_at": "2025-10-01T09:00:00Z",
      "updated_by": "super_admin",
      "updated_at": "2025-10-01T09:00:00Z",
      "is_active": true
    }
  ],
  "metadata": {
    "version": 1,
    "last_updated": "2025-11-10T14:30:00Z"
  }
}
```

### Permission Types

```python
class Permission(str, Enum):
    LABEL_WRITE = "LABEL_WRITE"          # 라벨 추가/삭제
    CLASS_MANAGE = "CLASS_MANAGE"        # 클래스 생성/수정/삭제
    USER_MANAGE = "USER_MANAGE"          # 일반 사용자 관리
    POWER_MANAGE = "POWER_MANAGE"        # 파워 사용자 관리
    ADMIN_MANAGE = "ADMIN_MANAGE"        # 관리자 관리 (SUPER만)
    SYSTEM_SETTINGS = "SYSTEM_SETTINGS"  # 시스템 설정 변경
```

### Audit Log Schema

**저장 위치:** `{IMAGES_ROOT}/logs/roles/audit-YYYYMMDD.jsonl`

```jsonl
{"timestamp":"2025-11-10T15:30:45Z","actor":"admin1","action":"create_user","target_user":"alice","role":"ROLE_USER","ip":"192.168.1.100"}
{"timestamp":"2025-11-10T15:31:00Z","actor":"admin1","action":"grant_permission","target_user":"alice","folder":"LOT123","permissions":["LABEL_WRITE","CLASS_MANAGE"],"ip":"192.168.1.100"}
{"timestamp":"2025-11-10T15:32:15Z","actor":"admin1","action":"upgrade_role","target_user":"alice","old_role":"ROLE_USER","new_role":"ROLE_POWER","ip":"192.168.1.100"}
{"timestamp":"2025-11-10T16:00:00Z","actor":"alice","action":"add_label","image_path":"LOT123/wafer_001.png","class":"defect_center","ip":"192.168.1.105"}
```

---

## API 상세 스펙

### 1. 사용자 조회

**GET /api/users**

**권한:** ADMIN 이상

**Query Parameters:**
- `role` (optional): 역할 필터 (예: `ROLE_USER`)
- `search` (optional): login_id 또는 username 검색
- `folder` (optional): 특정 폴더 권한을 가진 사용자만 조회

**Response:**
```json
{
  "users": [
    {
      "login_id": "alice",
      "username": "Alice Kim",
      "dept_name": "QA",
      "role": "ROLE_POWER",
      "grants": [
        {"folder": "LOT123", "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]}
      ],
      "created_at": "2025-11-01T10:00:00Z",
      "is_active": true
    }
  ],
  "total": 1
}
```

---

### 2. 사용자 생성

**POST /api/users**

**권한:**
- USER 생성: ADMIN 이상
- POWER 생성: ADMIN 이상
- ADMIN 생성: ADMIN 이상
- SUPER 생성: SUPER만

**Request:**
```json
{
  "login_id": "charlie",
  "username": "Charlie Park",
  "dept_name": "Manufacturing",
  "email": "charlie@company.com",
  "role": "ROLE_USER",
  "grants": [
    {
      "folder": "LOT789",
      "permissions": ["LABEL_WRITE"]
    }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "user": {
    "login_id": "charlie",
    "username": "Charlie Park",
    "role": "ROLE_USER",
    "created_at": "2025-11-10T16:00:00Z"
  }
}
```

**Error Cases:**
```json
// 401: 로그인 필요
{"error": "Unauthorized", "message": "로그인이 필요합니다"}

// 403: 권한 부족
{"error": "Forbidden", "message": "USER 생성 권한이 없습니다"}

// 409: 중복 사용자
{"error": "Conflict", "message": "이미 존재하는 login_id입니다"}

// 400: 잘못된 입력
{"error": "Bad Request", "message": "role 필드는 필수입니다"}
```

---

### 3. 권한 부여

**PATCH /api/users/{login_id}/grants**

**권한:** ADMIN 이상

**Request:**
```json
{
  "action": "add",  // "add" | "remove" | "replace"
  "grants": [
    {
      "folder": "LOT999",
      "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]
    }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "user": {
    "login_id": "alice",
    "grants": [
      {"folder": "LOT123", "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]},
      {"folder": "LOT999", "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]}
    ]
  }
}
```

---

### 4. 역할 변경

**PATCH /api/users/{login_id}/role**

**권한:**
- USER ↔ POWER: ADMIN 이상
- POWER ↔ ADMIN: ADMIN 이상
- ADMIN ↔ SUPER: SUPER만

**Request:**
```json
{
  "new_role": "ROLE_POWER"
}
```

**Response:**
```json
{
  "status": "success",
  "user": {
    "login_id": "alice",
    "old_role": "ROLE_USER",
    "new_role": "ROLE_POWER",
    "updated_at": "2025-11-10T16:30:00Z"
  }
}
```

---

### 5. 권한 검사 (내부 미들웨어)

```python
async def check_permission(
    request: Request,
    required_permission: Permission,
    folder_path: str
) -> bool:
    """
    요청 사용자가 특정 폴더에서 특정 권한을 가지고 있는지 검사

    Args:
        request: FastAPI Request 객체 (세션 포함)
        required_permission: 필요한 권한 (예: Permission.LABEL_WRITE)
        folder_path: 대상 폴더 경로 (예: "LOT123/wafer_001.png")

    Returns:
        bool: 권한 있으면 True, 없으면 False
    """
    # 1. 세션에서 사용자 정보 추출
    session = request.session
    user_role = session.get("role")
    user_grants = session.get("grants", [])

    # 2. SUPER는 모든 권한 보유
    if user_role == "ROLE_SUPER":
        return True

    # 3. ADMIN은 모든 폴더에서 LABEL_WRITE, CLASS_MANAGE 권한 보유
    if user_role == "ROLE_ADMIN" and required_permission in [
        Permission.LABEL_WRITE,
        Permission.CLASS_MANAGE
    ]:
        return True

    # 4. 폴더 경로에서 제품 폴더 추출
    product_folder = extract_product_folder(folder_path)

    # 5. grants에서 매칭되는 권한 찾기
    for grant in user_grants:
        if grant["folder"] == "*" or folder_matches(product_folder, grant["folder"]):
            if required_permission.value in grant["permissions"]:
                return True

    return False

def extract_product_folder(path: str) -> str:
    """
    이미지 경로에서 제품 폴더 추출

    예:
    - "LOT123/wafer_001.png" → "LOT123"
    - "batch/B001/wafer_002.png" → "batch/B001"
    - "classification/Good/img.png" → 원본 경로로 역변환 필요
    """
    # classification 경로면 원본 경로 찾기
    if "/classification/" in path or path.startswith("classification/"):
        original_path = lookup_original_path(path)
        path = original_path

    # 첫 번째 또는 첫 두 개 경로 컴포넌트 반환
    parts = path.split("/")
    if len(parts) >= 2 and parts[0] in ["batch", "lot", "wafer"]:
        return f"{parts[0]}/{parts[1]}"
    return parts[0]

def folder_matches(target: str, pattern: str) -> bool:
    """
    폴더 패턴 매칭 (와일드카드 지원)

    예:
    - folder_matches("LOT123", "LOT123") → True
    - folder_matches("LOT123/sub", "LOT123") → True (계층적)
    - folder_matches("LOT456", "LOT123") → False
    - folder_matches("anything", "*") → True (모든 폴더)
    """
    if pattern == "*":
        return True
    if target == pattern:
        return True
    if target.startswith(pattern + "/"):
        return True  # 하위 폴더도 허용
    return False
```

---

## 프론트엔드 구현

### 1. 권한 상태 표시

**User Info Badge (우측 상단)**

```html
<div id="user-info-badge" class="user-badge">
  <div class="user-role">👤 Alice Kim (POWER)</div>
  <div class="user-permissions">
    📁 <span id="current-folder">LOT123</span>:
    <span class="perm-label">라벨 ✓</span> |
    <span class="perm-class">클래스 ✓</span>
  </div>
</div>
```

**JavaScript 상태 관리:**

```javascript
class PermissionManager {
    constructor() {
        this.currentUser = null;
        this.currentFolder = null;
        this.permissions = new Set();
    }

    async loadUserInfo() {
        const response = await fetch('/api/whoami');
        const data = await response.json();

        this.currentUser = {
            login_id: data.login_id,
            username: data.username,
            role: data.role,
            grants: data.grants || []
        };

        this.updateBadge();
    }

    setCurrentFolder(folderPath) {
        this.currentFolder = folderPath;
        this.permissions = this.calculatePermissions(folderPath);
        this.updateBadge();
        this.updateButtonStates();
    }

    calculatePermissions(folderPath) {
        const perms = new Set();
        const productFolder = this.extractProductFolder(folderPath);

        // SUPER는 모든 권한
        if (this.currentUser.role === 'ROLE_SUPER') {
            return new Set(['LABEL_WRITE', 'CLASS_MANAGE', 'USER_MANAGE', 'SYSTEM_SETTINGS']);
        }

        // ADMIN은 라벨/클래스 전체 권한
        if (this.currentUser.role === 'ROLE_ADMIN') {
            perms.add('LABEL_WRITE');
            perms.add('CLASS_MANAGE');
            perms.add('USER_MANAGE');
            perms.add('SYSTEM_SETTINGS');
        }

        // grants 확인
        for (const grant of this.currentUser.grants) {
            if (grant.folder === '*' || this.folderMatches(productFolder, grant.folder)) {
                grant.permissions.forEach(p => perms.add(p));
            }
        }

        return perms;
    }

    hasPermission(permission) {
        return this.permissions.has(permission);
    }

    updateButtonStates() {
        // Add Label 버튼
        const addLabelBtn = document.getElementById('add-label-btn');
        if (!this.hasPermission('LABEL_WRITE')) {
            addLabelBtn.disabled = true;
            addLabelBtn.title = '현재 폴더에서 라벨 추가 권한이 없습니다';
        } else {
            addLabelBtn.disabled = false;
            addLabelBtn.title = '라벨 추가';
        }

        // Add Class 버튼
        const addClassBtn = document.getElementById('add-class-btn');
        if (!this.hasPermission('CLASS_MANAGE')) {
            addClassBtn.disabled = true;
            addClassBtn.title = '현재 폴더에서 클래스 관리 권한이 없습니다';
        } else {
            addClassBtn.disabled = false;
            addClassBtn.title = '클래스 추가';
        }

        // 사용자 관리 버튼 (ADMIN 이상만)
        const userManageBtn = document.getElementById('user-manage-btn');
        if (userManageBtn) {
            if (['ROLE_ADMIN', 'ROLE_SUPER'].includes(this.currentUser.role)) {
                userManageBtn.style.display = 'block';
            } else {
                userManageBtn.style.display = 'none';
            }
        }
    }

    updateBadge() {
        const badge = document.getElementById('user-info-badge');
        const folderEl = document.getElementById('current-folder');
        const permLabelEl = document.querySelector('.perm-label');
        const permClassEl = document.querySelector('.perm-class');

        folderEl.textContent = this.currentFolder || '선택 안 함';

        if (this.hasPermission('LABEL_WRITE')) {
            permLabelEl.innerHTML = '라벨 <span style="color: #0f0">✓</span>';
        } else {
            permLabelEl.innerHTML = '라벨 <span style="color: #f00">✗</span>';
        }

        if (this.hasPermission('CLASS_MANAGE')) {
            permClassEl.innerHTML = '클래스 <span style="color: #0f0">✓</span>';
        } else {
            permClassEl.innerHTML = '클래스 <span style="color: #f00">✗</span>';
        }
    }

    extractProductFolder(path) {
        // classification 경로 처리
        if (path.includes('/classification/')) {
            // 원본 경로로 역변환 필요
            return this.lookupOriginalFolder(path);
        }

        const parts = path.split('/').filter(Boolean);
        if (parts.length >= 2 && ['batch', 'lot', 'wafer'].includes(parts[0].toLowerCase())) {
            return `${parts[0]}/${parts[1]}`;
        }
        return parts[0] || '';
    }

    folderMatches(target, pattern) {
        if (pattern === '*') return true;
        if (target === pattern) return true;
        if (target.startsWith(pattern + '/')) return true;
        return false;
    }
}

// 전역 인스턴스
const permissionManager = new PermissionManager();

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
    await permissionManager.loadUserInfo();
});
```

---

### 2. 권한 편집 모달

이미 구현된 `#permission-editor-modal` 확장:

```javascript
class PermissionEditorManager {
    constructor() {
        this.modal = document.getElementById('permission-editor-modal');
        this.userList = document.getElementById('permission-user-list');
        this.currentEditingUser = null;
    }

    async open() {
        await this.loadUsers();
        this.modal.style.display = 'flex';
    }

    async loadUsers() {
        const response = await fetch('/api/users');
        const data = await response.json();

        this.renderUserList(data.users);
    }

    renderUserList(users) {
        this.userList.innerHTML = users.map(user => `
            <div class="permission-user-row" data-login-id="${user.login_id}">
                <div>
                    <div style="font-weight: 600;">${user.username}</div>
                    <div style="font-size: 11px; color: #999;">
                        ${user.login_id} | ${this.roleLabel(user.role)}
                    </div>
                </div>
                <div>${user.grants.length}개 폴더</div>
            </div>
        `).join('');

        // 클릭 이벤트
        this.userList.querySelectorAll('.permission-user-row').forEach(row => {
            row.addEventListener('click', () => {
                const loginId = row.dataset.loginId;
                this.selectUser(loginId);
            });
        });
    }

    async selectUser(loginId) {
        const response = await fetch(`/api/users/${loginId}`);
        const user = await response.json();

        this.currentEditingUser = user;
        this.renderUserForm(user);
    }

    renderUserForm(user) {
        document.getElementById('permission-login-input').value = user.login_id;
        document.getElementById('permission-username-input').value = user.username;
        document.getElementById('permission-dept-input').value = user.dept_name || '';
        document.getElementById('permission-role-select').value = user.role;

        this.renderFolderList(user.grants);
    }

    renderFolderList(grants) {
        const container = document.getElementById('permission-folder-list');

        container.innerHTML = grants.map((grant, idx) => `
            <div class="folder-row" data-index="${idx}">
                <input type="text" value="${grant.folder}"
                       placeholder="예) LOT123" data-field="folder">
                ${this.renderPermissionCheckboxes(grant.permissions)}
                <button type="button" onclick="permissionEditor.removeFolder(${idx})">
                    🗑️
                </button>
            </div>
        `).join('');
    }

    renderPermissionCheckboxes(permissions) {
        const allPerms = ['LABEL_WRITE', 'CLASS_MANAGE'];
        return allPerms.map(perm => `
            <label>
                <input type="checkbox" value="${perm}"
                       ${permissions.includes(perm) ? 'checked' : ''}>
                ${perm === 'LABEL_WRITE' ? '라벨' : '클래스'}
            </label>
        `).join('');
    }

    async saveUser() {
        const grants = this.collectGrants();

        const response = await fetch(`/api/users/${this.currentEditingUser.login_id}/grants`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'replace',
                grants: grants
            })
        });

        if (response.ok) {
            alert('저장되었습니다');
            await this.loadUsers();
        } else {
            const error = await response.json();
            alert(`오류: ${error.message}`);
        }
    }

    collectGrants() {
        const rows = document.querySelectorAll('.folder-row');
        const grants = [];

        rows.forEach(row => {
            const folder = row.querySelector('[data-field="folder"]').value.trim();
            if (!folder) return;

            const permissions = Array.from(row.querySelectorAll('input[type="checkbox"]:checked'))
                .map(cb => cb.value);

            grants.push({ folder, permissions });
        });

        return grants;
    }

    addFolder() {
        const grants = this.collectGrants();
        grants.push({ folder: '', permissions: [] });
        this.renderFolderList(grants);
    }

    removeFolder(index) {
        const grants = this.collectGrants();
        grants.splice(index, 1);
        this.renderFolderList(grants);
    }

    roleLabel(role) {
        const labels = {
            'ROLE_USER': 'USER',
            'ROLE_POWER': 'POWER',
            'ROLE_ADMIN': 'ADMIN',
            'ROLE_SUPER': 'SUPER'
        };
        return labels[role] || role;
    }
}

const permissionEditor = new PermissionEditorManager();
```

---

## 보안 고려사항

### 1. 세션 하이재킹 방지

```python
# api/main.py - Session 미들웨어 설정
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET_KEY", secrets.token_hex(32)),
    session_cookie="session_id",
    max_age=3600 * 8,  # 8시간
    same_site="lax",
    https_only=True  # HTTPS 환경에서만
)

# 세션 갱신 (활동 시마다)
@app.middleware("http")
async def refresh_session(request: Request, call_next):
    response = await call_next(request)

    if "session_user" in request.session:
        # 마지막 활동 시간 갱신
        request.session["last_activity"] = datetime.now().isoformat()

    return response
```

### 2. CSRF 방지

```python
from starlette_csrf import CSRFMiddleware

app.add_middleware(
    CSRFMiddleware,
    secret=os.getenv("CSRF_SECRET_KEY", secrets.token_hex(32)),
    cookie_name="csrf_token",
    header_name="X-CSRF-Token"
)
```

프론트엔드:
```javascript
// CSRF 토큰 자동 포함
async function apiCall(url, options = {}) {
    const csrfToken = getCookie('csrf_token');

    options.headers = {
        ...options.headers,
        'X-CSRF-Token': csrfToken
    };

    return fetch(url, options);
}
```

### 3. XSS 방지

```javascript
// DOM에 사용자 입력 삽입 시 항상 이스케이프
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 사용 예
userList.innerHTML = users.map(user => `
    <div>${escapeHtml(user.username)}</div>
`).join('');
```

### 4. Rate Limiting

```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

# 사용자 생성 제한 (10분당 5회)
@app.post("/api/users")
@limiter.limit("5/10minute")
async def create_user(request: Request, data: CreateUserRequest):
    pass

# 권한 변경 제한 (1분당 10회)
@app.patch("/api/users/{login_id}/grants")
@limiter.limit("10/minute")
async def update_grants(request: Request, login_id: str, data: UpdateGrantsRequest):
    pass
```

---

## 마이그레이션 전략

### Phase 1: 준비 (1주)

1. **SUPER 계정 생성**
```bash
python scripts/create_super_user.py --login-id super_admin --username "Super Admin"
```

2. **기존 관리자를 ADMIN으로 매핑**
```python
# scripts/migrate_existing_admins.py
existing_admins = ["admin1", "admin2"]

for admin_id in existing_admins:
    user = load_user(admin_id)
    user["role"] = "ROLE_ADMIN"
    user["grants"] = [
        {"folder": "*", "permissions": ["LABEL_WRITE", "CLASS_MANAGE", "USER_MANAGE"]}
    ]
    save_user(user)
```

### Phase 2: 데이터 마이그레이션 (2주)

1. **users.json 초기화**
```json
{
  "users": [],
  "metadata": {
    "version": 1,
    "migrated_from": "legacy_system",
    "migration_date": "2025-11-10T00:00:00Z"
  }
}
```

2. **기존 사용자 SAML 데이터 → User 스키마 변환**
```python
# scripts/migrate_saml_users.py
import json

saml_users = load_saml_users()  # OneLogin 또는 기존 시스템에서

for saml_user in saml_users:
    user = {
        "login_id": saml_user["login_id"],
        "username": saml_user["username"],
        "dept_name": saml_user["dept_name"],
        "email": saml_user["email"],
        "role": "ROLE_USER",  # 기본값
        "grants": [
            {"folder": "*", "permissions": ["LABEL_WRITE", "CLASS_MANAGE"]}
        ],  # 임시로 전체 권한 부여
        "created_by": "migration_script",
        "created_at": datetime.now().isoformat(),
        "is_active": True
    }

    save_user(user)
```

### Phase 3: 백엔드 권한 검사 추가 (2주)

1. **의존성 주입으로 권한 검사 미들웨어 추가**
```python
from fastapi import Depends, HTTPException

async def require_permission(
    permission: Permission,
    request: Request
):
    """
    Dependency: 특정 권한 필요
    """
    if not await check_permission(request, permission, folder="*"):
        raise HTTPException(
            status_code=403,
            detail=f"권한 부족: {permission.value} 필요"
        )

# 사용 예
@app.post("/api/classify")
async def classify_image(
    request: Request,
    data: ClassifyRequest,
    _=Depends(lambda r: require_permission(Permission.LABEL_WRITE, r))
):
    # 권한 검사 통과한 경우에만 실행
    pass
```

2. **모든 라벨링/클래스 API에 권한 검사 추가**

### Phase 4: 프론트엔드 UI 업데이트 (2주)

1. 권한 배지 추가
2. 버튼 상태 제어
3. 권한 편집 모달 완성

### Phase 5: 세분화 및 최적화 (2주)

1. 전체 권한(`folder="*"`) 제거
2. 실제 제품 폴더별로 권한 분배
3. 감사 로그 대시보드 구현

---

## 테스트 시나리오

### 시나리오 1: 일반 사용자 권한 테스트

**Given:**
- alice는 ROLE_USER
- LOT123 폴더에서 LABEL_WRITE, CLASS_MANAGE 권한 보유
- LOT456 폴더 권한 없음

**When:**
1. alice가 LOT123/wafer_001.png에 라벨 추가 시도
2. alice가 LOT456/wafer_002.png에 라벨 추가 시도
3. alice가 LOT123에서 새 클래스 생성 시도
4. alice가 다른 사용자가 만든 클래스 삭제 시도

**Then:**
1. ✅ 성공
2. ❌ 403 Forbidden
3. ✅ 성공
4. ❌ 403 Forbidden (자신이 만든 클래스만 삭제 가능)

---

### 시나리오 2: ADMIN 권한 테스트

**Given:**
- bob은 ROLE_ADMIN
- 자동으로 모든 폴더에 권한 보유

**When:**
1. bob이 LOT123/wafer_001.png에 라벨 추가
2. bob이 LOT456/wafer_002.png에 라벨 추가
3. bob이 alice에게 LOT789 폴더 권한 부여
4. bob이 charlie를 ROLE_POWER로 승격

**Then:**
1. ✅ 성공
2. ✅ 성공
3. ✅ 성공 (감사 로그 기록)
4. ✅ 성공 (감사 로그 기록)

---

### 시나리오 3: 권한 회수 테스트

**Given:**
- alice는 LOT123 권한 보유

**When:**
1. admin이 alice의 LOT123 권한 회수
2. alice가 LOT123/wafer_001.png에 라벨 추가 시도

**Then:**
1. ✅ 권한 회수 성공
2. ❌ 403 Forbidden

---

## 요약

1. **4단계 역할 계층**: USER → POWER → ADMIN → SUPER
2. **제품 폴더 기반 권한**: 각 역할은 특정 폴더에서만 권한 행사
3. **감사 로그**: 모든 권한 변경 기록 (append-only)
4. **보안**: 세션 하이재킹, CSRF, XSS 방지
5. **단계적 마이그레이션**: 기존 시스템과 호환성 유지하며 점진적 도입
