"""
사용자 관리 및 권한 제어 모듈
Role-Based Access Control (RBAC) 시스템
"""
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
from enum import Enum

# 역할 계층 정의
class Role(str, Enum):
    USER = "USER"       # 읽기 전용
    POWER = "POWER"     # 라벨링 가능
    ADMIN = "ADMIN"     # 클래스 관리 + 폴더별 권한 부여
    SUPER = "SUPER"     # 모든 권한 + 역할 변경

# 역할 계층 순서 (낮은 숫자가 높은 권한)
ROLE_HIERARCHY = {
    Role.SUPER: 0,
    Role.ADMIN: 1,
    Role.POWER: 2,
    Role.USER: 3
}

# 권한 액션 정의
class Permission(str, Enum):
    READ = "READ"                   # 읽기
    LABEL = "LABEL"                 # 라벨링
    CLASS_MANAGE = "CLASS_MANAGE"   # 클래스 관리
    GRANT_MANAGE = "GRANT_MANAGE"   # 폴더 권한 부여
    ROLE_CHANGE = "ROLE_CHANGE"     # 역할 변경

# 역할별 기본 권한
ROLE_PERMISSIONS = {
    Role.USER: {Permission.READ},
    Role.POWER: {Permission.READ, Permission.LABEL},
    Role.ADMIN: {Permission.READ, Permission.LABEL, Permission.CLASS_MANAGE, Permission.GRANT_MANAGE},
    Role.SUPER: {Permission.READ, Permission.LABEL, Permission.CLASS_MANAGE, Permission.GRANT_MANAGE, Permission.ROLE_CHANGE}
}

# 🔥 데이터 경로 - logs 디렉토리로 통합
LOGS_DIR = Path(__file__).parent.parent / "logs"
USERS_FILE = LOGS_DIR / "users.json"
AUDIT_LOG_PREFIX = "audit-roles"
LEGACY_AUDIT_LOG_DIR = LOGS_DIR / "roles"

# 디렉토리 생성
LOGS_DIR.mkdir(parents=True, exist_ok=True)


def _migrate_legacy_audit_logs() -> None:
    """레거시 logs/roles/audit-*.jsonl 파일을 logs/audit-roles-*.jsonl로 1회 마이그레이션."""
    if not LEGACY_AUDIT_LOG_DIR.exists() or not LEGACY_AUDIT_LOG_DIR.is_dir():
        return
    for src in LEGACY_AUDIT_LOG_DIR.glob("audit-*.jsonl"):
        suffix = src.name[len("audit-"):] if src.name.startswith("audit-") else src.name
        dst = LOGS_DIR / f"{AUDIT_LOG_PREFIX}-{suffix}"
        try:
            if not dst.exists():
                shutil.move(str(src), str(dst))
        except Exception:
            # 마이그레이션 실패 시에도 서비스는 계속 동작해야 함
            pass
    try:
        # 비어 있으면 정리
        LEGACY_AUDIT_LOG_DIR.rmdir()
    except Exception:
        pass


_migrate_legacy_audit_logs()


class UserManager:
    """사용자 관리 클래스"""

    def __init__(self):
        self._users_cache: Optional[Dict[str, Dict]] = None
        self._ensure_users_file()

    def _ensure_users_file(self):
        """users.json 파일이 없으면 기본 사용자 생성"""
        if not USERS_FILE.exists():
            default_users = {
                "admin": {
                    "username": "admin",
                    "display_name": "System Administrator",
                    "email": "admin@system.local",
                    "role": Role.SUPER,
                    "grants": [],
                    "created_at": datetime.utcnow().isoformat() + "Z",
                    "updated_at": datetime.utcnow().isoformat() + "Z"
                }
            }
            self._save_users(default_users)

    def _load_users(self) -> Dict[str, Dict]:
        """users.json 로드"""
        if self._users_cache is None:
            try:
                with open(USERS_FILE, 'r', encoding='utf-8') as f:
                    self._users_cache = json.load(f)
            except Exception as e:
                print(f"❌ 사용자 데이터 로드 실패: {e}")
                self._users_cache = {}
        return self._users_cache

    def _save_users(self, users: Dict[str, Dict]):
        """users.json 저장"""
        with open(USERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(users, f, indent=2, ensure_ascii=False)
        self._users_cache = users

    def get_user(self, username: str) -> Optional[Dict]:
        """사용자 정보 조회"""
        users = self._load_users()
        return users.get(username)

    def get_all_users(self) -> List[Dict]:
        """모든 사용자 목록 조회"""
        users = self._load_users()
        return list(users.values())

    def create_user(self, username: str, display_name: str, email: str,
                   role: Role = Role.USER, folders: str = "", actor: str = "system") -> Dict:
        """
        사용자 생성

        Args:
            username: 사용자명
            display_name: 표시 이름
            email: 이메일
            role: 역할
            folders: 제품 폴더 (쉼표 구분: "ABCD,FESD" 또는 "*" 전체)
            actor: 작업자
        """
        users = self._load_users()

        if username in users:
            raise ValueError(f"사용자 '{username}'이(가) 이미 존재합니다.")

        now = datetime.utcnow().isoformat() + "Z"

        # 🔥 제품 폴더 권한 처리
        grants = self._parse_folder_grants(folders, role)

        user = {
            "username": username,
            "display_name": display_name,
            "email": email,
            "role": role,
            "grants": grants,
            "created_at": now,
            "updated_at": now
        }

        users[username] = user
        self._save_users(users)

        # 감사 로그 기록
        self._write_audit_log(
            actor=actor,
            action="user_create",
            target=username,
            details={"role": role, "folders": folders}
        )

        return user

    def _parse_folder_grants(self, folders: str, role: Role) -> List[Dict]:
        """
        제품 폴더 문자열을 grants 리스트로 변환

        Args:
            folders: "ABCD,FESD,YEGF" 또는 "*" (전체)
            role: 사용자 역할

        Returns:
            grants 리스트 [{"folder": "...", "level": "..."}]
        """
        grants = []

        if not folders or not folders.strip():
            return grants

        folders = folders.strip()

        # 🔥 ADMIN이면 자동으로 *로 설정
        if role in {Role.ADMIN, Role.SUPER}:
            folders = "*"

        # "*" = 전체 권한
        if folders == "*":
            grants.append({"folder": "*", "level": role})
        else:
            # 쉼표로 구분된 제품 폴더
            folder_list = [f.strip() for f in folders.split(",") if f.strip()]
            for folder in folder_list:
                grants.append({"folder": folder, "level": role})

        return grants

    def update_role(self, username: str, new_role: Role, actor: str) -> Dict:
        """사용자 역할 변경"""
        users = self._load_users()

        if username not in users:
            raise ValueError(f"사용자 '{username}'을(를) 찾을 수 없습니다.")

        user = users[username]
        old_role = user["role"]

        if old_role == new_role:
            return user  # 변경 없음

        user["role"] = new_role
        user["updated_at"] = datetime.utcnow().isoformat() + "Z"

        # 🔥 ADMIN/SUPER로 변경 시 자동으로 * 권한 추가
        if new_role in {Role.ADMIN, Role.SUPER}:
            grants = user.get("grants", [])
            # * 권한이 없으면 추가
            has_all_permission = any(g.get("folder") == "*" for g in grants)
            if not has_all_permission:
                grants.append({"folder": "*", "level": new_role})
                user["grants"] = grants

        self._save_users(users)

        # 감사 로그 기록
        self._write_audit_log(
            actor=actor,
            action="role_change",
            target=username,
            details={"old_role": old_role, "new_role": new_role}
        )

        return user

    def add_grant(self, username: str, folder: str, level: Role, actor: str) -> Dict:
        """폴더 권한 부여"""
        users = self._load_users()

        if username not in users:
            raise ValueError(f"사용자 '{username}'을(를) 찾을 수 없습니다.")

        user = users[username]
        grants = user.get("grants", [])

        # 기존 권한 확인
        existing = next((g for g in grants if g["folder"] == folder), None)
        if existing:
            old_level = existing["level"]
            existing["level"] = level
        else:
            grants.append({"folder": folder, "level": level})
            old_level = None

        user["grants"] = grants
        user["updated_at"] = datetime.utcnow().isoformat() + "Z"

        self._save_users(users)

        # 감사 로그 기록
        self._write_audit_log(
            actor=actor,
            action="grant_add" if not existing else "grant_update",
            target=username,
            details={"folder": folder, "old_level": old_level, "new_level": level}
        )

        return user

    def remove_grant(self, username: str, folder: str, actor: str) -> Dict:
        """폴더 권한 제거"""
        users = self._load_users()

        if username not in users:
            raise ValueError(f"사용자 '{username}'을(를) 찾을 수 없습니다.")

        user = users[username]
        grants = user.get("grants", [])

        # 권한 제거
        original_count = len(grants)
        grants = [g for g in grants if g["folder"] != folder]

        if len(grants) == original_count:
            raise ValueError(f"폴더 '{folder}'에 대한 권한이 없습니다.")

        user["grants"] = grants
        user["updated_at"] = datetime.utcnow().isoformat() + "Z"

        self._save_users(users)

        # 감사 로그 기록
        self._write_audit_log(
            actor=actor,
            action="grant_remove",
            target=username,
            details={"folder": folder}
        )

        return user

    def delete_user(self, username: str, actor: str) -> bool:
        """사용자 삭제"""
        users = self._load_users()

        if username not in users:
            raise ValueError(f"사용자 '{username}'을(를) 찾을 수 없습니다.")

        user = users.pop(username)
        self._save_users(users)

        # 감사 로그 기록
        self._write_audit_log(
            actor=actor,
            action="user_delete",
            target=username,
            details={"role": user["role"]}
        )

        return True

    def _write_audit_log(self, actor: str, action: str, target: str, details: Dict):
        """감사 로그 기록 (JSONL 형식, append-only)"""
        today = datetime.utcnow().strftime("%Y%m%d")
        log_file = LOGS_DIR / f"{AUDIT_LOG_PREFIX}-{today}.jsonl"

        log_entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "actor": actor,
            "action": action,
            "target": target,
            "details": details
        }

        with open(log_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')

    def get_audit_logs(self, date: Optional[str] = None, limit: int = 100) -> List[Dict]:
        """감사 로그 조회"""
        files: List[Path] = []
        if date:
            current_log = LOGS_DIR / f"{AUDIT_LOG_PREFIX}-{date}.jsonl"
            legacy_log = LEGACY_AUDIT_LOG_DIR / f"audit-{date}.jsonl"
            if current_log.exists():
                files.append(current_log)
            if legacy_log.exists():
                files.append(legacy_log)
        else:
            # 최근 파일부터 역순으로 조회
            files.extend(sorted(LOGS_DIR.glob(f"{AUDIT_LOG_PREFIX}-*.jsonl"), reverse=True))
            if LEGACY_AUDIT_LOG_DIR.exists():
                files.extend(sorted(LEGACY_AUDIT_LOG_DIR.glob("audit-*.jsonl"), reverse=True))

        # 중복 제거(순서 유지)
        dedup_files: List[Path] = []
        seen = set()
        for p in files:
            key = str(p.resolve()) if p.exists() else str(p)
            if key in seen:
                continue
            seen.add(key)
            dedup_files.append(p)

        logs = []
        for log_file in dedup_files:
            try:
                with open(log_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        if line.strip():
                            logs.append(json.loads(line))
                            if len(logs) >= limit:
                                return logs
            except Exception as e:
                print(f"⚠️ 로그 파일 읽기 실패: {log_file}, {e}")

        return logs


class PermissionChecker:
    """권한 검사 클래스"""

    def __init__(self, user_manager: UserManager):
        self.user_manager = user_manager

    def has_permission(self, username: str, permission: Permission, folder: str = None) -> bool:
        """사용자가 특정 권한을 가지고 있는지 확인"""
        # 🔥 먼저 일반 사용자 권한 확인
        user = self.user_manager.get_user(username)
        if user:
            role = Role(user["role"])

            # 기본 역할 권한 확인
            if permission in ROLE_PERMISSIONS[role]:
                # 폴더별 권한이 필요한 경우
                if folder and permission in {Permission.LABEL, Permission.CLASS_MANAGE}:
                    return self._check_folder_permission(user, permission, folder)
                return True

        # 🔥 사용자 권한이 없으면 "all" 사용자 권한 확인
        # "all" 사용자가 admin/super 역할을 가지면 모든 사용자에게 권한 부여
        all_user = self.user_manager.get_user("all")
        if all_user:
            all_role = Role(all_user["role"])
            # "all" 사용자가 ADMIN 또는 SUPER 역할이면 모든 사용자에게 권한 부여
            if all_role in {Role.ADMIN, Role.SUPER}:
                if permission in ROLE_PERMISSIONS[all_role]:
                    # 폴더별 권한이 필요한 경우
                    if folder and permission in {Permission.LABEL, Permission.CLASS_MANAGE}:
                        return self._check_folder_permission(all_user, permission, folder)
                    return True

        return False

    def _check_folder_permission(self, user: Dict, permission: Permission, folder: str) -> bool:
        """폴더별 권한 확인 (상위 폴더 권한 상속)"""
        role = Role(user["role"])
        grants = user.get("grants", [])

        # SUPER와 ADMIN은 전역 권한
        if role in {Role.SUPER, Role.ADMIN}:
            return True

        # 폴더 경로를 정규화 (대소문자 무시: 소문자로 변환)
        folder_normalized = folder.replace('\\', '/').rstrip('/').lower()

        # 부여된 권한 확인
        for grant in grants:
            grant_folder = grant["folder"].replace('\\', '/').rstrip('/').lower()
            grant_level = Role(grant["level"])

            # * 권한이면 모든 폴더 접근 가능
            if grant_folder == "*":
                if permission in ROLE_PERMISSIONS[grant_level]:
                    return True
                continue

            # 해당 폴더 또는 하위 폴더인지 확인 (대소문자 무시)
            if folder_normalized.startswith(grant_folder):
                # grant_level에 permission이 있는지 확인
                if permission in ROLE_PERMISSIONS[grant_level]:
                    return True

        return False

    def can_modify_user(self, actor_username: str, target_username: str) -> bool:
        """actor가 target의 역할을 변경할 수 있는지 확인"""
        actor = self.user_manager.get_user(actor_username)
        target = self.user_manager.get_user(target_username)

        if not actor or not target:
            return False

        actor_role = Role(actor["role"])
        target_role = Role(target["role"])

        # SUPER만 역할 변경 가능
        if actor_role != Role.SUPER:
            return False

        # 자기 자신은 변경 불가 (안전장치)
        if actor_username == target_username:
            return False

        return True

    def get_effective_role(self, username: str, folder: str) -> Role:
        """특정 폴더에서 사용자의 유효 역할 반환"""
        user = self.user_manager.get_user(username)
        if not user:
            return Role.USER

        base_role = Role(user["role"])
        grants = user.get("grants", [])

        # 폴더 경로 정규화 (대소문자 무시: 소문자로 변환)
        folder_normalized = folder.replace('\\', '/').rstrip('/').lower()

        # 가장 구체적인(긴) 폴더 매칭 우선
        matched_grant = None
        for grant in grants:
            grant_folder = grant["folder"].replace('\\', '/').rstrip('/').lower()
            if folder_normalized.startswith(grant_folder):
                if not matched_grant or len(grant_folder) > len(matched_grant["folder"].replace('\\', '/').rstrip('/').lower()):
                    matched_grant = grant

        if matched_grant:
            grant_level = Role(matched_grant["level"])
            # 높은 권한 반환
            if ROLE_HIERARCHY[grant_level] < ROLE_HIERARCHY[base_role]:
                return grant_level

        return base_role


# 전역 인스턴스
_user_manager = None
_permission_checker = None


def get_user_manager() -> UserManager:
    """UserManager 싱글톤 인스턴스 반환"""
    global _user_manager
    if _user_manager is None:
        _user_manager = UserManager()
    return _user_manager


def get_permission_checker() -> PermissionChecker:
    """PermissionChecker 싱글톤 인스턴스 반환"""
    global _permission_checker
    if _permission_checker is None:
        _permission_checker = PermissionChecker(get_user_manager())
    return _permission_checker
