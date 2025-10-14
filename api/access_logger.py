#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import logging
import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from collections import defaultdict, Counter
from fastapi import Request
from typing import Dict, List, Any, Optional

# 로그 디렉터리 생성
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

# 접속자 로그 파일
ACCESS_LOG_FILE = LOG_DIR / "access.log"
STATS_LOG_FILE = LOG_DIR / "stats.json"

# 로거 설정 - 로깅 시스템 충돌 방지
access_logger = logging.getLogger("access")
access_logger.setLevel(logging.INFO)
access_logger.propagate = False  # 상위 로거로 전파 방지

# 기존 핸들러 제거 (중복 방지)
access_logger.handlers.clear()

# 파일 핸들러 설정
file_handler = logging.FileHandler(ACCESS_LOG_FILE, encoding='utf-8')
file_formatter = logging.Formatter('%(message)s')
file_handler.setFormatter(file_formatter)
access_logger.addHandler(file_handler)

class AccessLogger:
    def __init__(self):
        self.stats_data: Dict[str, Any] = self._load_stats()
        self.recent_api_calls: Dict[str, float] = {}  # IP+endpoint -> timestamp 매핑
        self.active_sessions: Dict[str, Dict[str, Any]] = {}  # IP -> 세션 정보
        self.session_timeout = 300  # 5분 (초) - 테스트용으로 짧게 설정
        self.ip_to_userid_cache: Dict[str, str] = {}  # IP → user_id 캐시 (성능 최적화)
        
        # stats.json 저장 최적화
        self._stats_dirty = False  # stats.json이 변경되었는지 플래그
        self._last_save_time = time.time()  # 마지막 저장 시간
        self._save_interval = 10.0  # 10초마다 자동 저장
    
    def _load_stats(self) -> Dict[str, Any]:
        """통계 데이터 로드"""
        if STATS_LOG_FILE.exists():
            try:
                with open(STATS_LOG_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "users": {},
            "daily_stats": {},
            "monthly_stats": {},
            "department_stats": {}  # 부서별 통계 추가
        }
    
    def _save_stats(self, force: bool = False):
        """통계 데이터 저장 - 배치 처리로 성능 최적화"""
        current_time = time.time()
        
        # force가 아니고, 변경사항이 없거나 아직 저장 간격이 안 되었으면 스킵
        if not force:
            if not self._stats_dirty:
                return
            if current_time - self._last_save_time < self._save_interval:
                return
        
        try:
            with open(STATS_LOG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.stats_data, f, ensure_ascii=False, indent=2)
            self._stats_dirty = False
            self._last_save_time = current_time
        except Exception as e:
            print(f"통계 저장 실패: {e}")
    
    def get_user_by_ip(self, ip: str) -> tuple:
        """IP로 사용자 찾기 (캐시 사용) - 성능 최적화 + SAML 인증 시간 체크"""
        import time
        
        # SAML 인증 유효 시간 (24시간)
        SAML_AUTH_VALID_HOURS = 24
        current_time = time.time()
        
        # 캐시에 있으면 즉시 반환 (단, SAML 인증 시간 체크)
        if ip in self.ip_to_userid_cache:
            cached_user_id = self.ip_to_userid_cache[ip]
            if cached_user_id in self.stats_data.get("users", {}):
                user_data = self.stats_data["users"][cached_user_id]
                profile = user_data.get("profile", {})
                
                # 🔥 SAML 인증 시간 체크
                last_saml_auth_time = profile.get("last_saml_auth_time", 0)
                if last_saml_auth_time > 0:
                    hours_since_auth = (current_time - last_saml_auth_time) / 3600
                    if hours_since_auth > SAML_AUTH_VALID_HOURS:
                        # 24시간이 지났으면 LoginId 무효화
                        return (None, None)
                
                return (cached_user_id, profile)
        
        # 캐시에 없으면 검색
        for uid, udata in self.stats_data.get("users", {}).items():
            ip_addresses = udata.get("ip_addresses", [])
            if ip in ip_addresses:
                profile = udata.get("profile", {})
                if profile and profile.get("LoginId"):
                    # 🔥 SAML 인증 시간 체크
                    last_saml_auth_time = profile.get("last_saml_auth_time", 0)
                    if last_saml_auth_time > 0:
                        hours_since_auth = (current_time - last_saml_auth_time) / 3600
                        if hours_since_auth > SAML_AUTH_VALID_HOURS:
                            # 24시간이 지났으면 LoginId 무효화
                            continue
                    
                    # 캐시에 저장
                    self.ip_to_userid_cache[ip] = uid
                    return (uid, profile)
        
        return (None, None)
    
    def _update_department_stats(self, user_id: str, dept_name: str, is_new_user: bool = False):
        """부서별 통계 증분 업데이트"""
        # department_stats 초기화 (없으면 생성)
        if "department_stats" not in self.stats_data:
            self.stats_data["department_stats"] = {}
        
        dept_stats = self.stats_data["department_stats"]
        
        # 부서 통계 초기화
        if dept_name not in dept_stats:
            dept_stats[dept_name] = {
                "name": dept_name,
                "user_count": 0,
                "total_requests": 0,
                "new_users_30d": 0,
                "users": []
            }
        
        # 사용자가 이 부서에 처음 추가되는 경우
        user_exists = any(u["user_id"] == user_id for u in dept_stats[dept_name]["users"])
        if not user_exists:
            dept_stats[dept_name]["user_count"] += 1
            user_data = self.stats_data["users"].get(user_id, {})
            dept_stats[dept_name]["users"].append({
                "user_id": user_id,
                "profile": user_data.get("profile", {}),
                "first_seen": user_data.get("first_seen", "")
            })
            
            # 30일 내 신규 사용자인 경우
            if is_new_user:
                dept_stats[dept_name]["new_users_30d"] += 1
        
        # 요청 수 증가
        dept_stats[dept_name]["total_requests"] += 1
    
    def remove_ip_login_record(self, client_ip: str, login_id: str = None):
        """SAML 로그인 성공 시 IP로 로그인한 기록을 삭제 (LoginId 기준)"""
        try:
            # LoginId가 제공되면 해당 사용자의 IP 기록을 정리
            if login_id and login_id in self.stats_data.get("users", {}):
                user_data = self.stats_data["users"][login_id]
                # IP 주소 목록에서 해당 IP 제거
                if client_ip in user_data.get("ip_addresses", []):
                    user_data["ip_addresses"].remove(client_ip)
                    # primary_ip가 삭제된 IP와 같으면 다른 IP로 변경
                    if user_data.get("primary_ip") == client_ip and user_data.get("ip_addresses"):
                        user_data["primary_ip"] = user_data["ip_addresses"][0]
                    print(f"LoginId {login_id}의 IP {client_ip} 기록 정리됨")
            
            # IP 키로 된 사용자 기록이 있으면 삭제
            if client_ip in self.stats_data.get("users", {}):
                del self.stats_data["users"][client_ip]
                print(f"IP 로그인 기록 삭제됨: {client_ip}")
                
                # 통계 데이터 저장 (배치 처리)
                self._stats_dirty = True
                self._save_stats()
                
                # active_sessions에서도 해당 IP 세션 제거
                if client_ip in self.active_sessions:
                    del self.active_sessions[client_ip]
                    
                return True
        except Exception as e:
            print(f"IP 로그인 기록 삭제 실패: {e}")
        return False
    
    def log_access(self, request: Request, endpoint: str, status_code: int = 200):
        """테이블 형식 접속 로그 기록"""
        # stats 관련 요청은 로깅하지 않음
        if '/api/stats' in endpoint or endpoint == '/stats' or endpoint.endswith('/stats.html'):
            return
            
        client_ip = self.get_client_ip(request)
        # 메모리 세션에서 사용자 정보 가져오기 (request.state에 저장됨)
        session_user = getattr(request.state, "session_user", None)
        display_user = session_user or client_ip
        method = request.method
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # 추가 정보 추출
        extra_info = self._extract_extra_info(request, endpoint, method)
        
        # 테이블 형식 로그 생성 (계정 우선 표시)
        self._log_table_format(timestamp, display_user, method, endpoint, status_code, extra_info)
        
        # 통계 업데이트 (계정 기준 우선)
        self._update_stats(client_ip, endpoint, method, user_id_override=session_user)
    
    def _extract_extra_info(self, request: Request, endpoint: str, method: str) -> str:
        """요청에서 파일명, 클래스명 등 추가 정보 추출"""
        import urllib.parse
        
        query_params = dict(request.query_params)
        
        # 이미지/썸네일 요청에서 경로 정보 추출
        if endpoint.startswith('/api/image') or endpoint.startswith('/api/thumbnail'):
            path = query_params.get('path', '')
            if path:
                # 경로 정보 표시 - 최대 4개 폴더까지 표시
                path_parts = path.split('/')
                if len(path_parts) >= 5:
                    # 5개 이상: 상위3개폴더/파일명
                    path_display = f"{path_parts[-4]}/{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 4:
                    # 4개: 상위2개폴더/파일명
                    path_display = f"{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 3:
                    # 3개: 상위폴더/파일명
                    path_display = f"{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 2:
                    # 2개: 폴더/파일명
                    path_display = f"{path_parts[-2]}/{path_parts[-1]}"
                elif len(path_parts) == 1:
                    # 1개: 파일명만
                    path_display = path_parts[-1]
                else:
                    path_display = path
                
                return f"[{path_display}]"
        
        # 클래스 관련 요청
        elif '/api/classes/' in endpoint:
            parts = endpoint.split('/api/classes/')
            if len(parts) > 1:
                class_info = parts[1].split('/')[0]
                return f"[{class_info}]"
        
        # POST 요청에서 body 정보 추출 (간단한 정보만)
        elif method in ['POST', 'DELETE']:
            if 'classify' in endpoint:
                return "[분류작업]"
            elif 'classes' in endpoint:
                return "[클래스관리]"
            elif 'labels' in endpoint:
                return "[라벨관리]"
        
        return ""
    
    def _log_table_format(self, timestamp: str, ip: str, method: str, endpoint: str, status_code: int, extra_info: str = ""):
        """완벽한 테이블 형식 로그 출력 - 요청 타입별 구분"""
        # 로그 타입 결정
        log_type_name = self._determine_log_type(endpoint, method)
        
        # 메서드별 색상
        method_colors = {
            'GET': '\033[96m',     # 밝은 청록색
            'POST': '\033[95m',    # 밝은 마젠타색
            'PUT': '\033[94m',     # 밝은 파란색
            'DELETE': '\033[91m'   # 밝은 빨간색
        }
        method_color = method_colors.get(method, '\033[97m')
        
        # 상태 코드별 색상
        if 200 <= status_code < 300:
            status_color = '\033[92m'  # 초록색
        elif 300 <= status_code < 400:
            status_color = '\033[94m'  # 파란색
        elif 400 <= status_code < 500:
            status_color = '\033[93m'  # 노란색
        else:
            status_color = '\033[91m'  # 빨간색
        
        # 로그 타입별 색상
        type_colors = {
            'PAGE': '\033[92m',      # 초록색 - 페이지 접속
            'API': '\033[96m',       # 청록색 - API 호출
            'FILE': '\033[93m',      # 노란색 - 파일 요청
            'AUTH': '\033[95m',      # 마젠타색 - 인증 관련
            'ACTION': '\033[91m',    # 빨간색 - 사용자 액션 (클래스/라벨/분류)
            'IMAGE': '\033[94m',     # 파란색 - 이미지 조회
            'ERROR': '\033[91m'      # 빨간색 - 오류
        }
        type_color = type_colors.get(log_type_name, '\033[97m')
        
        # 완벽한 테이블 정렬 - 모든 컬럼 고정 너비
        log_type = f"{log_type_name:<3}"     # 3자리 (API, PAGE, FILE 등)
        timestamp_col = f"{timestamp:<19}"   # 19자리 (YYYY-MM-DD HH:MM:SS)
        ip_col = f"{ip:<15}"                # 15자리
        method_col = f"{method:<4}"          # 4자리 (GET, POST, PUT, DEL)
        
        # 상위폴더+파일명 추출 (예: files→folder/image.png)
        endpoint_display = endpoint
        if endpoint.startswith('/api/'):
            endpoint_display = endpoint[5:]  # /api/ 제거
            
            # path 파라미터에서 파일 정보 추출 (query string이 있든 없든)
            if 'path=' in endpoint:
                import urllib.parse
                try:
                    path_param = endpoint.split('path=')[1].split('&')[0]
                    decoded_path = urllib.parse.unquote(path_param)
                    
                    # base_endpoint 추출
                    if '?' in endpoint_display:
                        base_endpoint = endpoint_display.split('?')[0]
                    else:
                        base_endpoint = endpoint_display
                    
                    # 경로 정보 표시 - 최대 4개 폴더까지 표시
                    path_parts = decoded_path.split('/')
                    if len(path_parts) >= 5:
                        # 5개 이상: 상위3개폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-4]}/{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 4:
                        # 4개: 상위2개폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-3]}/{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 3:
                        # 3개: 상위폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 2:
                        # 2개: 폴더/파일명
                        endpoint_display = f"{base_endpoint}→{path_parts[-2]}/{path_parts[-1]}"
                    elif len(path_parts) == 1:
                        # 1개: 파일명만
                        endpoint_display = f"{base_endpoint}→{path_parts[-1]}"
                except:
                    # path 파라미터 추출 실패시 원본 유지
                    pass
        
        endpoint_col = f"{endpoint_display:<25}"  # 25자리로 조정
        status_col = f"{status_code:>3}"         # 3자리 (우측 정렬)
        
        # 추가 정보가 있으면 표시
        extra_part = f" {extra_info}" if extra_info else ""
        
        # 🎯 완벽한 테이블 정렬 - 색상 코드 길이 정확히 계산
        # 색상 코드 길이: \033[XXm = 5자리, \033[0m = 4자리
        type_with_color = f"{type_color}{log_type}\033[0m"
        ip_with_color = f"\033[90m{ip_col}\033[0m"
        method_with_color = f"{method_color}{method_col}\033[0m"
        status_with_color = f"{status_color}{status_col}\033[0m"
        
        # 🎯 완벽한 테이블 정렬 - 색상 코드 길이 보정
        # 실제 텍스트 길이만 고려하여 정렬 (색상 코드는 무시)
        type_padded = f"{type_with_color:<8}"   # API(3) + 색상코드(9) = 8자리
        ip_padded = f"{ip_with_color:<20}"      # IP(15) + 색상코드(9) = 20자리  
        method_padded = f"{method_with_color:<8}"  # GET(3) + 색상코드(9) = 8자리
        status_padded = f"{status_with_color:>6}"  # 200(3) + 색상코드(9) = 6자리 (우측정렬)
        
        # 🎯 완벽한 정렬 - 모든 컬럼이 고정 위치에
        message = (
            f"{type_padded}  {timestamp_col}  "  # 타입-시간 간 여백 2칸
            f"{ip_padded}  {method_padded}  "    # IP-메서드 간 여백 2칸
            f"{endpoint_col}  {status_padded}{extra_part}"  # 엔드포인트-상태 간 여백 2칸
        )
        
        # 콘솔에 테이블 형식으로 출력 (중복 방지)
        print(message)
        
        # 파일에는 단순한 형식으로 저장
        file_message = f"{log_type_name}: {timestamp} {ip:<15} {method:<6} {endpoint:<30} {status_code:>3}"
        access_logger.info(file_message)
    
    def _determine_log_type(self, endpoint: str, method: str) -> str:
        """엔드포인트와 메서드에 따라 로그 타입 결정"""
        # 메인 페이지 접속
        if endpoint in ['/', '/stats']:
            return 'PAGE'
        
        # JavaScript/CSS 파일
        elif endpoint.endswith(('.js', '.css', '.html')):
            return 'FILE'
        
        # 인증 관련
        elif any(auth_path in endpoint for auth_path in ['/api/set-username', '/register', '/login', '/auth']):
            return 'AUTH'
        
        # 사용자 액션 (클래스/라벨/분류 작업)
        elif self._is_user_action(endpoint, method):
            return 'ACTION'
        
        # 이미지 조회 (실제 사용자가 이미지를 보는 행위)
        elif endpoint.startswith('/api/image') or endpoint.startswith('/api/thumbnail'):
            return 'IMAGE'
        
        # 일반 API 호출
        elif endpoint.startswith('/api/'):
            return 'API'
        
        # 기타
        else:
            return 'FILE'
    
    def _is_user_action(self, endpoint: str, method: str) -> bool:
        """사용자 액션인지 판단"""
        # POST/DELETE 메서드인 클래스/라벨/분류 작업
        action_endpoints = [
            '/api/classes', '/api/labels', '/api/classify'
        ]
        
        if method in ['POST', 'DELETE']:
            return any(endpoint.startswith(action_ep) for action_ep in action_endpoints)
        
        # 특정 GET 액션들 (이미지 분류 조회 등)
        if method == 'GET':
            if '/api/classes/' in endpoint and '/images' in endpoint:  # 클래스별 이미지 조회
                return True
            if endpoint.startswith('/api/labels/') and len(endpoint) > len('/api/labels/'):  # 특정 이미지 라벨 조회
                return True
        
        return False
    
    def _update_stats(self, ip: str, endpoint: str, method: str, user_id_override: Optional[str] = None, meta: Optional[Dict[str, Any]] = None):
        """통계 업데이트 - 세션 관리 포함 (LoginId 기준, SAML 인증된 경우만 기록)"""
        # localhost IP 제외
        if ip in ['127.0.0.1', '::1', 'localhost']:
            return
            
        today = datetime.now().strftime('%Y-%m-%d')
        now_timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        now_unix = time.time()
        
        # LoginId 기준으로 사용자 식별
        LoginId = None
        profile_meta: Dict[str, Any] = {}
        
        # 사내 SAML claim 7개 필드만 사용
        SAML_FIELDS = ["Username", "LoginId", "Sabun", "DeptName", "GrdName_EN", "GrdName", "x-ms-forwarded-client-ip"]
        
        # 🔥 1. meta에서 LoginId 추출 시도
        if meta and isinstance(meta, dict):
            LoginId = meta.get("LoginId")
            if LoginId:
                # SAML profile 정보 저장 (7개 필드만)
                for field in SAML_FIELDS:
                    value = meta.get(field)
                    if value:
                        profile_meta[field] = value
                print(f"🔍 [UPDATE_STATS] meta에서 LoginId 추출: {LoginId}, profile_meta: {list(profile_meta.keys())}")
            else:
                print(f"⚠️ [UPDATE_STATS] meta에 LoginId 없음: {list(meta.keys())}")
        
        # 🔥 2. meta가 없으면 user_id_override 사용 (쿠키에서 온 LoginId)
        if not LoginId and user_id_override:
            LoginId = user_id_override
            # stats.json에서 기존 profile 정보 가져오기
            existing_user = self.stats_data.get("users", {}).get(LoginId, {})
            if existing_user:
                profile_meta = existing_user.get("profile", {})
                print(f"🔍 [UPDATE_STATS] user_id_override 사용: {LoginId}, 기존 profile: {list(profile_meta.keys())}")
        
        # 🔥 3. 여전히 LoginId가 없거나 IP와 같으면 완전 차단
        if not LoginId or LoginId == ip:
            # IP만 있고 LoginId가 없음 → IP 로그 차단
            print(f"⚠️ [SKIP] LoginId 없음 또는 IP와 동일: LoginId={LoginId}, ip={ip}")
            return
        
        # 🔥 4. LoginId가 있지만 profile이 비어있으면 차단 (SAML 미인증)
        if not profile_meta or len(profile_meta) == 0:
            # profile이 없음 → SAML 미인증 사용자 → 차단
            print(f"⚠️ [SKIP] profile 비어있음: LoginId={LoginId}, ip={ip}, endpoint={endpoint}")
            return
        
        print(f"✅ [LOG] SAML 로그 기록: LoginId={LoginId}, ip={ip}, endpoint={endpoint}, profile={list(profile_meta.keys())}")
        
        # 🔥 detail_access.csv에 기록 (SAML 로그인 시마다)
        if endpoint == "/saml/acs" and profile_meta:
            try:
                from .detail_access_logger import detail_access_logger
                print(f"🔄 [CSV 기록] detail_access.csv 기록 시작 - LoginId: {LoginId}")
                result = detail_access_logger.log_saml_access(profile_meta, ip)
                print(f"✅ [CSV 기록] detail_access.csv 기록 완료 - 결과: {result}")
            except Exception as e:
                print(f"❌ [CSV 기록] detail_access.csv 기록 실패: {e}")
                import traceback
                traceback.print_exc()
        
        # 중복 요청 체크 (IP→LoginId 전환 시 중복 방지)
        # 같은 IP에서 5초 이내에 이미 로그가 있으면 스킵 (SAML 로그인 직후 중복 방지)
        recent_key = f"{ip}_{endpoint}"
        
        if not hasattr(self, '_recent_requests'):
            self._recent_requests = {}
            self._last_cache_cleanup = now_unix
        
        # 1분마다 캐시 정리
        if now_unix - self._last_cache_cleanup > 60:
            # 10초 이상 된 기록 삭제
            cutoff = now_unix - 10
            self._recent_requests = {k: v for k, v in self._recent_requests.items() if v > cutoff}
            self._last_cache_cleanup = now_unix
        
        # 같은 IP에서 5초 이내 같은 endpoint 요청이면 중복으로 간주하고 스킵
        last_request_time = self._recent_requests.get(recent_key, 0)
        if now_unix - last_request_time < 5.0:
            # 5초 이내 중복 요청 → 스킵
            return
        
        self._recent_requests[recent_key] = now_unix
        
        # 세션 관리
        self._update_session(ip, now_unix, endpoint)
        
        # 사용자별 통계 (LoginId 기준)
        # 🔥 profile이 있는 경우만 사용자 생성 (IP 사용자 생성 차단)
        if LoginId not in self.stats_data["users"]:
            if not profile_meta or len(profile_meta) == 0:
                # profile이 없으면 사용자 생성 안 함 (IP 로그 차단)
                print(f"⚠️ [SKIP CREATE] profile 없어서 사용자 생성 안 함: LoginId={LoginId}, ip={ip}")
                return
            
            self.stats_data["users"][LoginId] = {
                "primary_ip": ip,
                "ip_addresses": [ip],
                "total_requests": 0,
                "unique_days": [],
                "first_seen": today,
                "last_seen": today,
                "last_access_time": now_timestamp,
                "first_access_time": now_timestamp,
                "session_count": 0,  # 총 세션 수
                "total_session_time": 0,  # 총 세션 시간 (초)
                "current_session_start": now_timestamp,  # 현재 세션 시작 시간
                "daily_requests": {},
                "endpoints": {},
                "sessions": [],  # 세션 히스토리
                "profile": profile_meta,  # 🔥 profile 직접 저장
                "user_type": "saml"  # 🔥 profile이 있으면 무조건 SAML 사용자
            }
            # 캐시 업데이트
            self.ip_to_userid_cache[ip] = LoginId
            print(f"✅ [CREATE] SAML 사용자 생성: LoginId={LoginId}, profile={list(profile_meta.keys())}")
        
        user_data = self.stats_data["users"][LoginId]
        
        # IP 주소 업데이트 (새로운 IP면 추가 + 캐시 업데이트)
        if ip not in user_data.get("ip_addresses", []):
            user_data["ip_addresses"].append(ip)
            # 캐시 업데이트
            self.ip_to_userid_cache[ip] = LoginId
        
        # Profile 정보 업데이트
        if "profile" not in user_data:
            user_data["profile"] = {}
        if profile_meta:
            for k, v in profile_meta.items():
                if v:
                    user_data["profile"][k] = v
        
        # 기존 사용자에 최초 접속 시간이 없다면 보정
        if "first_access_time" not in user_data:
            user_data["first_access_time"] = now_timestamp

        user_data["total_requests"] += 1
        user_data["last_seen"] = today
        user_data["last_access_time"] = now_timestamp
        
        # 기존 사용자에게 새로운 필드 추가
        if "session_count" not in user_data:
            user_data["session_count"] = 0
        if "total_session_time" not in user_data:
            user_data["total_session_time"] = 0
        if "current_session_start" not in user_data:
            user_data["current_session_start"] = now_timestamp
        if "sessions" not in user_data:
            user_data["sessions"] = []
        
        if ip not in user_data["ip_addresses"]:
            user_data["ip_addresses"].append(ip)
        
        if today not in user_data["unique_days"]:
            user_data["unique_days"].append(today)
        
        if today not in user_data["daily_requests"]:
            user_data["daily_requests"][today] = 0
        user_data["daily_requests"][today] += 1
        
        if endpoint not in user_data["endpoints"]:
            user_data["endpoints"][endpoint] = 0
        user_data["endpoints"][endpoint] += 1
        
        # 일별 통계
        if today not in self.stats_data["daily_stats"]:
            self.stats_data["daily_stats"][today] = {
                "active_users": [],
                "new_users": [],
                "total_requests": 0,
                "by_department": {},
                "by_team": {},
                "by_company": {},
                "by_org_url": {}
            }
        
        daily = self.stats_data["daily_stats"][today]
        
        # 중복 제거하며 추가
        if LoginId not in daily["active_users"]:
            daily["active_users"].append(LoginId)
        daily["total_requests"] += 1
        
        # 신규 사용자 체크
        if user_data["first_seen"] == today:
            if LoginId not in daily["new_users"]:
                daily["new_users"].append(LoginId)
        
        # 월별 통계
        month = today[:7]  # YYYY-MM
        if month not in self.stats_data["monthly_stats"]:
            self.stats_data["monthly_stats"][month] = {
                "active_users": [],
                "new_users": [],
                "total_requests": 0,
                "month_name": datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%Y년 %m월"),
                "by_department": {},
                "by_team": {},
                "by_company": {},
                "by_org_url": {}
            }
        
        monthly = self.stats_data["monthly_stats"][month]
        
        # 중복 제거하며 추가
        if LoginId not in monthly["active_users"]:
            monthly["active_users"].append(LoginId)
        monthly["total_requests"] += 1
        
        if user_data["first_seen"].startswith(month):
            if LoginId not in monthly["new_users"]:
                monthly["new_users"].append(LoginId)
        # 부서 카운트 (profile.DeptName 사용)
        profile = user_data.get("profile", {})
        user_type = user_data.get("user_type", "unknown")
        
        # 부서명 결정
        if user_type == "saml":
            dept_name = profile.get("DeptName") or "부서미지정"
        else:
            dept_name = "외부"
        
        # 일별/월별 통계 업데이트
        if dept_name:
            daily["by_department"][dept_name] = daily["by_department"].get(dept_name, 0) + 1
            monthly["by_department"][dept_name] = monthly["by_department"].get(dept_name, 0) + 1
        
        # 부서별 통계 증분 업데이트 (새로운 방식)
        thirty_days_ago = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
        is_new_user = user_data.get("first_seen", "") >= thirty_days_ago
        self._update_department_stats(LoginId, dept_name, is_new_user)
        
        # 통계 저장 (배치 처리 - 10초마다 자동 저장)
        self._stats_dirty = True
        self._save_stats()
    
    def get_client_ip(self, request: Request) -> str:
        """실제 클라이언트 IP 추출 (프록시 고려)"""
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
        
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip
        
        return request.client.host if request.client else "unknown"
    
    def should_log_frequent_api(self, client_ip: str, endpoint: str) -> bool:
        """자주 반복되는 API 호출 로깅 제한 (동일 IP+endpoint 조합을 5초간 한 번만 로깅)"""
        now = time.time()
        key = f"{client_ip}:{endpoint}"
        
        # 이전 호출 시간 확인
        last_call = self.recent_api_calls.get(key, 0)
        
        # 5초 내 중복 호출이면 로깅 스킵
        if now - last_call < 5.0:
            return False
        
        # 현재 시간 기록
        self.recent_api_calls[key] = now
        
        # 오래된 기록 정리 (10분 이상 된 것들)
        cutoff = now - 600  # 10분
        self.recent_api_calls = {k: v for k, v in self.recent_api_calls.items() if v > cutoff}
        
        return True
    
    def _update_session(self, ip: str, now_unix: float, endpoint: str):
        """세션 업데이트 - 접속/재접속/세션 종료 관리"""
        # localhost IP 제외
        if ip in ['127.0.0.1', '::1', 'localhost']:
            return
            
        # 세션 타임아웃된 사용자 정리
        self._cleanup_expired_sessions(now_unix)
        
        # 현재 사용자 세션 확인
        if ip in self.active_sessions:
            # 기존 세션 업데이트
            session = self.active_sessions[ip]
            session["last_activity"] = now_unix
            session["request_count"] += 1
            session["last_endpoint"] = endpoint
            
            # 사용자 데이터의 현재 세션 시간 업데이트
            if ip in self.stats_data["users"]:
                user_data = self.stats_data["users"][ip]
                session_duration = now_unix - session["start_time"]
                user_data["current_session_duration"] = int(session_duration)
                
                # 세션 관련 정보만 업데이트 (통계는 _update_stats에서 처리)
                user_data["last_seen"] = datetime.now().strftime('%Y-%m-%d')
                user_data["last_access_time"] = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
        else:
            # 새 세션 시작
            self.active_sessions[ip] = {
                "start_time": now_unix,
                "last_activity": now_unix,
                "request_count": 1,
                "last_endpoint": endpoint,
                "session_id": f"{ip}_{int(now_unix)}"
            }
            
            # 🔥 사용자 데이터에 새 세션 기록 (IP 키로 사용자 생성하지 않음!)
            # stats.json에 LoginId로 등록된 사용자만 세션 관리
            found_user_id = None
            for uid, udata in self.stats_data["users"].items():
                if ip in udata.get("ip_addresses", []):
                    found_user_id = uid
                    break
            
            if not found_user_id:
                # stats.json에 없는 IP → 세션 관리 안 함 (IP 로그 차단)
                print(f"⚠️ [SKIP SESSION] IP가 stats.json에 없음: {ip}, endpoint={endpoint}")
                return
            
            user_data = self.stats_data["users"][found_user_id]
            user_data["session_count"] += 1
            user_data["current_session_start"] = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
            user_data["current_session_duration"] = 0
            
            # 세션 관련 정보만 업데이트 (통계는 _update_stats에서 처리)
            user_data["last_seen"] = datetime.now().strftime('%Y-%m-%d')
            user_data["last_access_time"] = datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S')
            
            # 세션 히스토리에 추가
            session_info = {
                "session_id": f"{ip}_{int(now_unix)}",
                "start_time": datetime.fromtimestamp(now_unix).strftime('%Y-%m-%d %H:%M:%S'),
                "end_time": None,  # 아직 진행 중
                "duration": 0,
                "request_count": 1,
                "last_endpoint": endpoint
            }
            user_data["sessions"].append(session_info)
            
            # 최근 100개 세션만 유지
            if len(user_data["sessions"]) > 100:
                user_data["sessions"] = user_data["sessions"][-100:]
    
    def _cleanup_expired_sessions(self, now_unix: float):
        """만료된 세션 정리 및 세션 종료 기록"""
        expired_ips = []
        
        for ip, session in self.active_sessions.items():
            if now_unix - session["last_activity"] > self.session_timeout:
                # 세션 종료 기록
                self._record_session_end(ip, session, now_unix)
                expired_ips.append(ip)
        
        # 만료된 세션 제거
        for ip in expired_ips:
            del self.active_sessions[ip]
    
    def _record_session_end(self, ip: str, session: Dict[str, Any], end_time: float):
        """세션 종료 기록"""
        if ip in self.stats_data["users"]:
            user_data = self.stats_data["users"][ip]
            session_duration = end_time - session["start_time"]
            
            # 총 세션 시간 업데이트
            user_data["total_session_time"] += int(session_duration)
            
            # 세션 히스토리 업데이트
            for session_info in user_data["sessions"]:
                if session_info["session_id"] == session["session_id"]:
                    session_info["end_time"] = datetime.fromtimestamp(end_time).strftime('%Y-%m-%d %H:%M:%S')
                    session_info["duration"] = int(session_duration)
                    session_info["request_count"] = session["request_count"]
                    break
    
    def get_active_users(self) -> Dict[str, Any]:
        """현재 활성 사용자 정보"""
        now_unix = time.time()
        self._cleanup_expired_sessions(now_unix)
        
        active_users = []
        for ip, session in self.active_sessions.items():
            # localhost IP 제외
            if ip in ['127.0.0.1', '::1', 'localhost']:
                continue
            session_duration = now_unix - session["start_time"]
            user_data = self.stats_data["users"].get(ip, {})
            
            active_users.append({
                "ip": ip,
                "session_id": session["session_id"],
                "session_start": datetime.fromtimestamp(session["start_time"]).strftime('%Y-%m-%d %H:%M:%S'),
                "session_duration": int(session_duration),
                "request_count": session["request_count"],
                "last_endpoint": session["last_endpoint"],
                "last_activity": datetime.fromtimestamp(session["last_activity"]).strftime('%Y-%m-%d %H:%M:%S'),
                "total_requests": user_data.get("total_requests", 0),
                "unique_days": len(user_data.get("unique_days", [])),
                "first_seen": user_data.get("first_seen", "Unknown")
            })
        
        # 세션 시작 시간으로 정렬 (최신 순)
        active_users.sort(key=lambda x: x["session_start"], reverse=True)
        
        return {
            "total_active": len(active_users),
            "active_users": active_users
        }
    
    # 통계 API 메서드들
    def get_daily_stats(self) -> Dict[str, Any]:
        """일별 통계 조회 - 실시간 활성 사용자 포함"""
        # 실시간으로 최신 stats.json 데이터 로드
        current_stats = self._load_stats()
        today = datetime.now().strftime('%Y-%m-%d')
        today_data = current_stats["daily_stats"].get(today, {
            "active_users": [],
            "new_users": [],
            "total_requests": 0
        })
        
        # 현재 활성 사용자 수
        active_users_info = self.get_active_users()
        
        return {
            "total_users": len(self.stats_data["users"]),
            "active_today": len(today_data["active_users"]),
            "currently_active": active_users_info["total_active"],
            "new_users_today": len(today_data["new_users"]),
            "total_requests_today": today_data["total_requests"],
            "active_users_detail": active_users_info["active_users"][:10]  # 상위 10명
        }
    
    def get_daily_trend(self, days: int = 7) -> Dict[str, Any]:
        """일별 트렌드 통계"""
        end_date = datetime.now()
        trend_data = {}
        
        for i in range(days):
            date = (end_date - timedelta(days=i)).strftime('%Y-%m-%d')
            daily_data = self.stats_data["daily_stats"].get(date, {
                "active_users": [],
                "new_users": [],
                "total_requests": 0
            })
            
            trend_data[date] = {
                "active_users": len(daily_data["active_users"]),
                "new_users": len(daily_data["new_users"]),
                "total_requests": daily_data["total_requests"]
            }
        
        return trend_data
    
    def get_monthly_trend(self, months: int = 3) -> Dict[str, Any]:
        """월별 트렌드 통계"""
        end_date = datetime.now()
        trend_data = {}
        
        for i in range(months):
            date = end_date.replace(day=1) - timedelta(days=i*30)
            month = date.strftime('%Y-%m')
            monthly_data = self.stats_data["monthly_stats"].get(month, {
                "active_users": [],
                "new_users": [],
                "total_requests": 0,
                "month_name": date.strftime("%Y년 %m월")
            })
            
            trend_data[month] = {
                "active_users": len(monthly_data["active_users"]),
                "new_users": len(monthly_data["new_users"]),
                "total_requests": monthly_data["total_requests"],
                "month_name": monthly_data["month_name"]
            }
        
        return trend_data
    
    def get_users_stats(self) -> Dict[str, Any]:
        """사용자 통계 - 세션 정보 포함 (접속일수 기준 내림차순 정렬)"""
        # 실시간으로 최신 stats.json 데이터 로드
        current_stats = self._load_stats()
        users = []
        for user_id, data in current_stats["users"].items():
            # localhost IP 제외
            if user_id in ['127.0.0.1', '::1', 'localhost']:
                continue
            # 현재 세션 상태 확인
            is_active = user_id in self.active_sessions
            current_session_duration = 0
            if is_active:
                now_unix = time.time()
                session = self.active_sessions[user_id]
                current_session_duration = int(now_unix - session["start_time"])
            
            users.append({
                "user_id": user_id,
                "display_name": user_id,
                "primary_ip": data.get("primary_ip", ""),
                "total_requests": data["total_requests"],
                "unique_days": len(data["unique_days"]),
                "last_seen": data["last_seen"],
                "last_access_time": data.get("last_access_time", data["last_seen"]),
                "session_count": data.get("session_count", 0),
                "total_session_time": data.get("total_session_time", 0),
                "avg_session_time": round(data.get("total_session_time", 0) / max(data.get("session_count", 1), 1), 1),
                "is_active": is_active,
                "current_session_duration": current_session_duration,
                "current_session_start": data.get("current_session_start", "Unknown"),
                "profile": data.get("profile", {}),  # profile 정보 추가
                "user_type": data.get("user_type", "unknown")  # 사용자 타입 추가
            })
        
        # 접속일수 기준 내림차순 정렬 (동일하면 총 요청 수로 2차 정렬)
        users.sort(key=lambda x: (x["unique_days"], x["total_requests"]), reverse=True)
        
        return {
            "total_users": len(users),
            "users": users[:50]  # 상위 50명
        }
    
    def get_recent_users(self) -> Dict[str, Any]:
        """최근 접속 사용자 (LoginId 기준)"""
        # 실시간으로 최신 stats.json 데이터 로드
        current_stats = self._load_stats()
        today = datetime.now().strftime('%Y-%m-%d')
        
        recent_users = []
        for user_id, data in current_stats["users"].items():
            # localhost IP 제외
            if user_id in ['127.0.0.1', '::1', 'localhost']:
                continue
            
            # 실제 저장된 마지막 접속 시간 사용
            last_access = data.get("last_access_time", data["last_seen"])
            
            # unique_days 계산
            unique_days = len(data.get("unique_days", []))
            
            recent_users.append({
                "user_id": user_id,
                "display_name": user_id,
                "primary_ip": data.get("primary_ip", ""),
                "profile": data.get("profile", {}),  # profile 정보 추가
                "user_type": data.get("user_type", "unknown"),  # 사용자 타입 추가
                "total_requests": data.get("daily_requests", {}).get(today, 0),
                "unique_days": unique_days,
                "last_access": last_access
            })
        
        # 마지막 접속 시간으로 정렬 (최신 순)
        recent_users.sort(key=lambda x: x["last_access"], reverse=True)
        
        return {
            "total_recent": len(recent_users),
            "recent_users": recent_users[:20]  # 상위 20명
        }
    
    def get_user_detail(self, user_id: str) -> Optional[Dict[str, Any]]:
        """특정 사용자 상세 정보"""
        if user_id not in self.stats_data["users"]:
            return None
        
        return self.stats_data["users"][user_id]
    
    def get_department_stats(self) -> Dict[str, Any]:
        """부서별 사용자 분포 및 활동량 통계 - 캐시된 통계 반환 (빠름!)"""
        # department_stats가 없으면 빈 딕셔너리 반환
        department_stats = self.stats_data.get("department_stats", {})
        
        return {
            "departments": department_stats,
            "activity": department_stats  # activity와 departments 동일하게 사용
        }

# 전역 인스턴스
logger_instance = AccessLogger()