"""
L3Tracker - Wafer Map Viewer API (HTTPS, Pretty Table Logs, Noise-free)
"""

# ======================== Imports ========================
import os, re, sys, json, time, shutil, asyncio, logging, logging.config, hashlib
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
from collections import OrderedDict
from threading import RLock
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import urlparse, parse_qs

from fastapi import FastAPI, HTTPException, Query, Request, Path as PathParam, Depends
from fastapi import Response as FastAPIResponse
from fastapi.responses import JSONResponse, FileResponse, Response, RedirectResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from PIL import Image
import http.client
import urllib.parse

from .access_logger import logger_instance
from .thumbnail_service import ThumbnailService

# SAML
try:
    from onelogin.saml2.auth import OneLogin_Saml2_Auth
    from onelogin.saml2.settings import OneLogin_Saml2_Settings
except Exception:
    OneLogin_Saml2_Auth = None
    OneLogin_Saml2_Settings = None
from . import config

# ================= Windows ANSI 색상 호환 =================
try:
    from colorama import just_fix_windows_console
    just_fix_windows_console()
except Exception:
    pass

# ================= wcwidth 기반 셀 패딩 ====================
try:
    from wcwidth import wcwidth as _wcwidth
except Exception:
    import unicodedata
    def _wcwidth(ch: str) -> int:
        if ch in ("\r", "\n", "\t"):
            return 0
        return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1

def _one_line(s: str) -> str:
    return ("" if s is None else str(s)).replace("\r", " ").replace("\n", " ").replace("\t", " ")

def _pad_cell(s: str, width: int) -> str:
    s = _one_line(s)
    out, used = [], 0
    for ch in s:
        w = _wcwidth(ch)
        if w < 0:
            continue
        if used + w > width:
            if used < width:
                out.append("…"); used += 1
            break
        out.append(ch); used += w
    if used < width:
        out.append(" " * (width - used))
    return "".join(out)

# ======================== Logging ========================
class _SuppressNoise(logging.Filter):
    """자주 보이는 소음 로그(10054/connection_lost/Invalid HTTP request…) 억제"""
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            msg = str(record.msg)
        lower = msg.lower()
        if "invalid http request received" in lower:
            return False
        if "proactorbasepipetransport._call_connection_lost" in lower:
            return False
        if "winerror 10054" in lower:
            return False
        if "current connection was forcibly closed by the remote host" in lower:
            return False
        return True

LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "simple": {"format": "%(levelname)s: %(asctime)s     %(message)s", "datefmt": "%Y-%m-%d %H:%M:%S"}
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "simple", "stream": "ext://sys.stdout"},
    },
    "root": {"level": "INFO", "handlers": ["console"]},
    "loggers": {
        "uvicorn":        {"handlers": ["console"], "level": "INFO",    "propagate": False},
        "uvicorn.error":  {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "uvicorn.access": {"handlers": [],          "level": "CRITICAL","propagate": False},
        "l3tracker":      {"handlers": ["console"], "level": "INFO",    "propagate": False},
        "access":         {"handlers": ["console"], "level": "INFO",    "propagate": False},
        "asyncio":        {"handlers": ["console"], "level": "ERROR",   "propagate": False},
    },
}
logging.config.dictConfig(LOGGING_CONFIG)
# 실행 후 필터 부착(딕트 설정만으로는 content-based filter 넣기 번거로움)
for name in ("uvicorn", "uvicorn.error", "asyncio", ""):
    logging.getLogger(name).addFilter(_SuppressNoise())
logger = logging.getLogger("l3tracker")

# ================= Pretty Access Table Logger =================
ACCESS_TABLE_COLOR = os.getenv("ACCESS_TABLE_COLOR", "1") != "0"  # 0이면 색 끔
ACCESS_TABLE_WIDTHS = [
    ("TAG", 7), ("TIME", 25), ("IP", 14), ("METHOD", 6), ("STS", 8), ("PATH", 24), ("NOTE", 50)
]

def _ansi(code: str) -> str:
    return f"\x1b[{code}m" if ACCESS_TABLE_COLOR else ""

CLR = {
    "reset": _ansi("0"), "dim": _ansi("2"), "bold": _ansi("1"),
    "red": _ansi("31"), "green": _ansi("32"), "yellow": _ansi("33"),
    "blue": _ansi("34"), "magenta": _ansi("35"), "cyan": _ansi("36"), "white": _ansi("37"),
}

def _border_line(ch_left: str, ch_mid: str, ch_right: str, ch_fill: str) -> str:
    return ch_left + ch_mid.join(ch_fill * w for _, w in ACCESS_TABLE_WIDTHS) + ch_right

ACCESS_TABLE_HEADER = _border_line("┌", "┬", "┐", "─") + "\n" + \
    "│" + "│".join(_pad_cell(name, w) for name, w in ACCESS_TABLE_WIDTHS) + "│\n" + \
    _border_line("├", "┼", "┤", "─")
ACCESS_TABLE_FOOTER = _border_line("└", "┴", "┘", "─")

_access_table_logger = logging.getLogger("access.table")
if not _access_table_logger.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    _access_table_logger.addHandler(_h)
    _access_table_logger.setLevel(logging.INFO)
    _access_table_logger.propagate = False

_access_table_header_printed = False
_access_count = 0
ACCESS_TABLE_HEADER_EVERY = int(os.getenv("ACCESS_TABLE_HEADER_EVERY", "0"))  # 0=비활성

def print_access_header_once():
    global _access_table_header_printed
    if not _access_table_header_printed:
        _access_table_logger.info(ACCESS_TABLE_HEADER)
        _access_table_header_printed = True

def _color_for_tag(tag: str) -> str:
    return {"IMAGE": CLR["cyan"], "ACTION": CLR["magenta"], "API": CLR["blue"], "INFO": CLR["white"]}.get(tag, "")

def _color_for_status(sts) -> str:
    try:
        code = int(sts)
    except Exception:
        return CLR["white"]  # 상태코드 없음('-') → 흰색
    if 200 <= code < 300: return CLR["green"]
    if 300 <= code < 400: return CLR["yellow"]
    return CLR["red"]

def _color_for_method(m: str) -> str:
    m = (m or "").upper()
    return {"GET": CLR["cyan"], "POST": CLR["yellow"], "DELETE": CLR["red"], "PUT": CLR["magenta"]}.get(m, CLR["white"])

def shorten_note_path(abs_path: str, root_dir: str) -> str:
    try:
        p = Path(abs_path).resolve()
        r = Path(root_dir).resolve()
        return str(p.relative_to(r))
    except Exception:
        return abs_path

def _note_from_request(request: Request, endpoint: str) -> str:
    try:
        qs = parse_qs(urlparse(str(request.url)).query)
    except Exception:
        qs = {}
    if endpoint.startswith("/api/thumbnail"):
        path = qs.get('path', [''])[0]
        return f"[{shorten_note_path(path, str(ROOT_DIR))}]"
    if endpoint.startswith("/api/image"):
        path = qs.get('path', [''])[0]
        return f"[{shorten_note_path(path, str(ROOT_DIR))}]"
    if endpoint.startswith("/api/classify"):
        return "[분류작업]"
    if endpoint.startswith("/api/labels"):
        return "[라벨]"
    if endpoint.startswith("/api/classes"):
        return "[클래스]"
    return ""

def log_access_row(*, tag: str, ip: str = "-", method: str = "-", status: str = "-",
                   path: str = "-", note: str = ""):
    """셀을 wcwidth 기준으로 패딩해 열 경계를 항상 맞춤."""
    global _access_count
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    plain_cells = {}
    for col_name, width in ACCESS_TABLE_WIDTHS:
        if col_name == "TAG":
            plain_cells[col_name] = _pad_cell(tag, width)
        elif col_name == "TIME":
            plain_cells[col_name] = _pad_cell(ts, width)
        elif col_name == "IP":
            plain_cells[col_name] = _pad_cell(ip, width)
        elif col_name == "METHOD":
            plain_cells[col_name] = _pad_cell((method or "").upper(), width)
        elif col_name == "STS":
            plain_cells[col_name] = _pad_cell(str(status), width)
        elif col_name == "PATH":
            plain_cells[col_name] = _pad_cell(path, width)
        elif col_name == "NOTE":
            plain_cells[col_name] = _pad_cell(note, width)

    tag_col    = f"{_color_for_tag(tag)}{plain_cells['TAG']}{CLR['reset']}"
    method_col = f"{_color_for_method(method)}{plain_cells['METHOD']}{CLR['reset']}"
    sts_col    = f"{_color_for_status(status)}{plain_cells['STS']}{CLR['reset']}"
    path_col   = f"{CLR['dim']}{plain_cells['PATH']}{CLR['reset']}"
    note_color = CLR["white"] if tag == "IMAGE" else (CLR["magenta"] if tag == "ACTION" else "")
    note_col   = f"{note_color}{plain_cells['NOTE']}{CLR['reset']}" if note_color else plain_cells["NOTE"]

    cells = [tag_col, plain_cells["TIME"], plain_cells["IP"], method_col, sts_col, path_col, note_col]
    _access_table_logger.info("│" + "│".join(cells) + "│")

    _access_count += 1
    if ACCESS_TABLE_HEADER_EVERY and _access_count % ACCESS_TABLE_HEADER_EVERY == 0:
        _access_table_logger.info(ACCESS_TABLE_HEADER)

# ======================== Config Bindings ========================
ROOT_DIR = config.ROOT_DIR
THUMBNAIL_DIR = config.THUMBNAIL_DIR
SUPPORTED_EXTENSIONS = set(ext.lower() for ext in config.SUPPORTED_EXTS)

# 🔥 현재 폴더 변수 (검색 제한용)
current_folder = ROOT_DIR

THUMBNAIL_FORMAT = config.THUMBNAIL_FORMAT
THUMBNAIL_QUALITY = config.THUMBNAIL_QUALITY
THUMBNAIL_SIZE_DEFAULT = config.THUMBNAIL_SIZE_DEFAULT

# ======================== Service Instances ========================
thumbnail_service = ThumbnailService(
    root_dir=ROOT_DIR,
    thumbnail_dir=THUMBNAIL_DIR,
    thumbnail_format=THUMBNAIL_FORMAT,
    thumbnail_quality=THUMBNAIL_QUALITY
)

IO_THREADS = config.IO_THREADS
THUMBNAIL_SEM_SIZE = config.THUMBNAIL_SEM

DIRLIST_CACHE_SIZE = config.DIRLIST_CACHE_SIZE
THUMB_STAT_TTL_SECONDS = config.THUMB_STAT_TTL_SECONDS
THUMB_STAT_CACHE_CAPACITY = config.THUMB_STAT_CACHE_CAPACITY

SKIP_DIRS = {d.strip() for d in config.SKIP_DIRS if d.strip()}

LABELS_DIR = config.LABELS_DIR
LABELS_FILE = config.LABELS_FILE

# ======================== Pools / State / Caches ========================
IO_POOL = ThreadPoolExecutor(max_workers=IO_THREADS)
THUMBNAIL_SEM = asyncio.Semaphore(THUMBNAIL_SEM_SIZE)

USER_ACTIVITY_FLAG = False
BACKGROUND_TASKS_PAUSED = False
INDEX_BUILDING = False
INDEX_READY = False

# 🔍 디버그용 썸네일 요청 카운터
THUMBNAIL_REQUEST_COUNTER = 0
THUMBNAIL_COUNTER_LOCK = RLock()

FILE_INDEX: Dict[str, Dict[str, Any]] = {}
FILE_INDEX_LOCK = RLock()

LABELS: Dict[str, List[str]] = {}
LABELS_LOCK = RLock()
LABELS_MTIME: float = 0.0
CLASSES_MTIME: float = 0.0

class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._lock = RLock()
    def get(self, key: str):
        with self._lock:
            val = self._cache.get(key)
            if val is None: return None
            self._cache.move_to_end(key);  return val
    def set(self, key: str, value: Any):
        with self._lock:
            if key in self._cache: self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self.capacity: self._cache.popitem(last=False)
    def delete(self, key: str):
        with self._lock: self._cache.pop(key, None)
    def clear(self):
        with self._lock: self._cache.clear()

DIRLIST_CACHE = LRUCache(DIRLIST_CACHE_SIZE)

class TTLCache:
    def __init__(self, ttl_sec: float, capacity: int):
        self.ttl = ttl_sec
        self.capacity = capacity
        self._data: OrderedDict[str, Tuple[float, Any]] = OrderedDict()
        self._lock = RLock()
    def get(self, key: str):
        now = time.time()
        with self._lock:
            item = self._data.get(key)
            if not item: return None
            exp, val = item
            if exp < now:
                del self._data[key];  return None
            self._data.move_to_end(key);  return val
    def set(self, key: str, value: Any):
        now = time.time()
        with self._lock:
            if key in self._data: self._data.move_to_end(key)
            self._data[key] = (now + self.ttl, value)
            if len(self._data) > self.capacity: self._data.popitem(last=False)
    def clear(self):
        with self._lock: self._data.clear()

THUMB_STAT_CACHE = TTLCache(THUMB_STAT_TTL_SECONDS, THUMB_STAT_CACHE_CAPACITY)

# ======================== FastAPI & Middleware ========================
app = FastAPI(title="L3Tracker API", version="2.6.0")

# ======================== SAML SSO (OneLogin python3-saml) ========================
SAML_DIR = Path("saml")
DEV_SAML = os.getenv("DEV_SAML", "1").strip().lower() in {"1", "true", "yes", "y", "on"}
AUTO_LOGIN = os.getenv("AUTO_LOGIN", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
DEFAULT_ORG_URL = os.getenv("DEFAULT_ORG_URL", "")

def _load_saml_files() -> Tuple[Dict[str, Any], Dict[str, Any]]:
    base: Dict[str, Any] = {}
    adv: Dict[str, Any] = {}
    try:
        settings_path = SAML_DIR / "settings.json"
        if settings_path.exists():
            with open(settings_path, "r", encoding="utf-8") as f:
                base = json.load(f)
    except Exception as e:
        logger.warning(f"SAML settings.json 로드 실패: {e}")
    try:
        adv_path = SAML_DIR / "advanced_settings.json"
        if adv_path.exists():
            with open(adv_path, "r", encoding="utf-8") as f:
                adv = json.load(f)
    except Exception as e:
        logger.warning(f"SAML advanced_settings.json 로드 실패: {e}")

    # IdP X.509 인증서를 파일에서 주입(선택)
    try:
        idp_pem = SAML_DIR / "certs" / "idp_x509.pem"
        if idp_pem.exists():
            with open(idp_pem, "r", encoding="utf-8") as c:
                base.setdefault("idp", {})["x509cert"] = c.read()
    except Exception as e:
        logger.warning(f"SAML IdP 인증서 로드 실패: {e}")

    # SP 서명에 사용할 키/증서가 있으면 주입(선택)
    try:
        sp_crt = SAML_DIR / "certs" / "sp.crt"
        sp_key = SAML_DIR / "certs" / "sp.key"
        if sp_crt.exists() and sp_key.exists():
            with open(sp_crt, "r", encoding="utf-8") as c:
                crt = c.read()
            with open(sp_key, "r", encoding="utf-8") as k:
                key = k.read()
            base.setdefault("sp", {})["x509cert"] = crt
            base["sp"]["privateKey"] = key
    except Exception as e:
        logger.warning(f"SAML SP 키/증서 로드 실패: {e}")

    return base, adv

def _prepare_fastapi_request(req: Request) -> Dict[str, Any]:
    host = req.headers.get("x-forwarded-host") or req.headers.get("host") or req.client.host
    proto = req.headers.get("x-forwarded-proto") or req.url.scheme
    port = "443" if proto == "https" else "80"
    return {
        "http_host": host,
        "server_port": port,
        "script_name": req.url.path,
        "get_data": dict(req.query_params or {}),
        "post_data": {},
        "https": "on" if proto == "https" else "off",
    }

def _saml_auth(req: Request) -> OneLogin_Saml2_Auth:
    if OneLogin_Saml2_Auth is None:
        raise HTTPException(status_code=500, detail="python3-saml 미설치")
    # 파일 기반 로드를 사용해도 되지만, 여기서는 병합된 설정을 우선 사용
    return OneLogin_Saml2_Auth(_prepare_fastapi_request(req), custom_base_path=str(SAML_DIR))

@app.get("/saml/metadata")
async def saml_metadata():
    try:
        if OneLogin_Saml2_Settings is None:
            return PlainTextResponse("python3-saml 미설치", status_code=500)
        base, adv = _load_saml_files()
        combined = dict(base)
        try:
            # security 등 상위 키 병합
            for k, v in (adv or {}).items():
                combined[k] = v
        except Exception:
            pass
        settings = OneLogin_Saml2_Settings(settings=combined, custom_base_path=str(SAML_DIR))
        settings.set_strict(False)
        metadata = settings.get_sp_metadata()
        return Response(content=metadata, media_type="application/xml")
    except Exception as e:
        logger.exception(f"SAML 메타데이터 생성 실패: {e}")
        return PlainTextResponse(f"metadata error: {e}", status_code=500)

@app.get("/saml/login")
async def saml_login(request: Request):
    auth = _saml_auth(request)
    # 사내 스타일 org_url 파라미터를 세션 메타에 기록할 수 있도록 쿼리 수용
    org_url = request.query_params.get("org_url")
    resp = RedirectResponse(auth.login())
    if org_url:
        meta = {"org_url": org_url}
        try:
            prev_meta = request.cookies.get("session_meta")
            if prev_meta:
                import json as _json
                cur = _json.loads(prev_meta)
                cur.update(meta)
                meta = cur
        except Exception:
            pass
        resp.set_cookie("session_meta", json.dumps(meta, ensure_ascii=False), max_age=7*24*3600, secure=True, httponly=False, samesite="Lax")
    return resp

@app.post("/saml/acs")
async def saml_acs(request: Request):
    if OneLogin_Saml2_Auth is None:
        return PlainTextResponse("python3-saml 미설치", status_code=500)
    form = dict(await request.form())
    req_dict = _prepare_fastapi_request(request)
    req_dict["post_data"] = form
    auth = OneLogin_Saml2_Auth(req_dict, custom_base_path=str(SAML_DIR))
    try:
        auth.process_response()
        errors = auth.get_errors()
    except Exception as e:
        # 개발 모드: 예외 발생 시에도 사용자 폴백 허용
        if DEV_SAML:
            # 우선순위: user → (account@pc) → dev-user
            user = (
                form.get("user")
                or form.get("email")
                or request.query_params.get("user")
                or request.query_params.get("email")
            )
            if not user:
                account = form.get("account") or request.query_params.get("account")
                pc = form.get("pc") or request.query_params.get("pc")
                if account:
                    user = f"{account}@{pc or 'unknown'}"
                else:
                    user = "dev-user"
            # org_url/dev 메타도 반영
            meta = {
                "org_url": request.query_params.get("org_url") or form.get("org_url"),
                "company": request.query_params.get("company") or form.get("company"),
                "department": request.query_params.get("department") or form.get("department"),
                "team": request.query_params.get("team") or form.get("team"),
            }
            meta = {k: v for k, v in meta.items() if v}
            resp = FastAPIResponse(status_code=302)
            resp.headers["Location"] = "/"
            resp.set_cookie("session_user", user, max_age=7*24*3600, secure=True, httponly=True, samesite="Lax")
            if meta:
                try:
                    prev = request.cookies.get("session_meta")
                    if prev:
                        cur = json.loads(prev)
                        cur.update(meta)
                        meta = cur
                except Exception:
                    pass
                resp.set_cookie("session_meta", json.dumps(meta, ensure_ascii=False), max_age=7*24*3600, secure=True, httponly=False, samesite="Lax")
            log_access_row(tag="INFO", path="/saml/acs", method="POST", status=302, note=f"DEV SAML(예외) 로그인: {user}")
            return resp
        return PlainTextResponse("ACS error: exception during processing", status_code=400)

    if errors or not auth.is_authenticated():
        if DEV_SAML:
            # 개발 모드 폴백: 쿼리/폼에서 사용자 식별자 수용
            user = (form.get("user") or form.get("email") or request.query_params.get("user")
                    or request.query_params.get("email"))
            if not user:
                account = form.get("account") or request.query_params.get("account")
                pc = form.get("pc") or request.query_params.get("pc")
                user = f"{account}@{pc or 'unknown'}" if account else "dev-user"
            resp = FastAPIResponse(status_code=302)
            resp.headers["Location"] = "/"
            resp.set_cookie("session_user", user, max_age=7*24*3600, secure=True, httponly=True, samesite="Lax")
            log_access_row(tag="INFO", path="/saml/acs", method="POST", status=302, note=f"DEV SAML 로그인: {user}")
            return resp
        reason = auth.get_last_error_reason() or ""
        return PlainTextResponse(f"ACS error: {errors or 'not_authenticated'}\n{reason}", status_code=400)

    nameid = auth.get_nameid() or "saml-user"
    # SAML Attributes에서 메타 추출 시도 (사내 호환: org_url/samlUserdata 등)
    meta = {}
    try:
        attrs = auth.get_attributes() or {}
        # 예시 매핑 - 실제 사내 속성명에 맞춰 추가 확장 가능
        def pick(*keys):
            for k in keys:
                v = attrs.get(k) or attrs.get(k.upper()) or attrs.get(k.lower())
                if isinstance(v, list):
                    v = v[0] if v else None
                if v:
                    return v
            return None
        # 표준/사내 속성 매핑
        meta_candidates = {
            # 표준/일반
            "org_url": pick("org_url", "OrgUrl", "OrganizationURL"),
            "company": pick("company", "Company", "o", "organizationName"),
            "department": pick("department", "Department", "departmentNumber", "ou", "DeptName"),
            "team": pick("team", "Team"),
            "title": pick("title", "Title", "GrdName", "GrdName_EN"),
            "email": pick("email", "Email", "mail"),
            # 사내 전용 필드들 보존
            "login_id": pick("LoginId"),
            "department_id": pick("DeptId"),
            "employee_id": pick("Sabun"),
            "department_name": pick("DeptName"),
            "grade": pick("GrdName"),
            "grade_en": pick("GrdName_EN"),
            "username": pick("Username"),
        }
        meta = {k: v for k, v in meta_candidates.items() if v}
    except Exception:
        meta = {}
    resp = FastAPIResponse(status_code=302)
    resp.headers["Location"] = "/"
    resp.set_cookie("session_user", nameid, max_age=7*24*3600, secure=True, httponly=True, samesite="Lax")
    if meta:
        try:
            prev = request.cookies.get("session_meta")
            if prev:
                cur = json.loads(prev)
                cur.update(meta)
                meta = cur
        except Exception:
            pass
        resp.set_cookie("session_meta", json.dumps(meta, ensure_ascii=False), max_age=7*24*3600, secure=True, httponly=False, samesite="Lax")
    log_access_row(tag="INFO", path="/saml/acs", method="POST", status=302, note=f"SAML 로그인: {nameid}")
    return resp

@app.get("/saml/dev-login")
async def saml_dev_login(request: Request):
    """개발 모드 간편 로그인: ?user=이메일(또는 임의값)
    DEV_SAML=1일 때만 허용.
    """
    if not DEV_SAML:
        return PlainTextResponse("DEV_SAML 비활성화", status_code=403)
    # 우선순위: user → (account@pc) → dev-user
    user = request.query_params.get("user") or request.query_params.get("email")
    account = request.query_params.get("account")
    pc = request.query_params.get("pc")
    company = request.query_params.get("company") or request.query_params.get("corp")
    department = request.query_params.get("department") or request.query_params.get("dept") or request.query_params.get("DeptName")
    team = request.query_params.get("team")
    title = request.query_params.get("title")
    # 사내 속성들
    login_id = request.query_params.get("LoginId")
    dept_id = request.query_params.get("DeptId")
    sabun = request.query_params.get("Sabun")
    dept_name = request.query_params.get("DeptName")
    grd_name = request.query_params.get("GrdName")
    grd_name_en = request.query_params.get("GrdName_EN")
    username = request.query_params.get("Username")

    if not user:
        if account:
            user = f"{account}@{pc or 'unknown'}"
        else:
            user = "dev-user"
    # 메타데이터를 별도 쿠키에 JSON으로 저장
    meta = {
        "company": company,
        "department": department or dept_name,
        "team": team,
        "title": title or grd_name or grd_name_en,
        "account": account,
        "pc": pc,
        # 사내 보존 필드들
        "login_id": login_id or account,
        "department_id": dept_id,
        "employee_id": sabun,
        "department_name": dept_name,
        "grade": grd_name,
        "grade_en": grd_name_en,
        "username": username,
    }
    # None 제거
    meta = {k: v for k, v in meta.items() if v}

    resp = FastAPIResponse(status_code=302)
    resp.headers["Location"] = "/"
    resp.set_cookie("session_user", user, max_age=7*24*3600, secure=True, httponly=True, samesite="Lax")
    if meta:
        resp.set_cookie("session_meta", json.dumps(meta, ensure_ascii=False), max_age=7*24*3600, secure=True, httponly=False, samesite="Lax")
    log_access_row(tag="INFO", path="/saml/dev-login", method="GET", status=302, note=f"DEV 로그인: {user}")
    return resp

# ===== 계정 확인용 간단 API =====
@app.get("/api/whoami")
async def api_whoami(request: Request):
    user = request.cookies.get("session_user") or ""
    account = ""
    pc = ""
    meta = {}
    meta_cookie = request.cookies.get("session_meta")
    if meta_cookie:
        try:
            meta = json.loads(meta_cookie)
        except Exception:
            meta = {}
    if user and "@" in user:
        parts = user.split("@", 1)
        account = parts[0]
        pc = parts[1]
    return {"user": user, "account": account, "pc": pc, **({"meta": meta} if meta else {})}


# ===== 사내 ADFS/STS 헬스 체크 (핑) =====
@app.get("/api/sso/ping")
async def sso_ping(url: str = Query(..., description="예: http://stsds.secsso.net/adfs/ls/")):
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc
        scheme = parsed.scheme.lower()
        path = parsed.path or "/"
        conn = http.client.HTTPSConnection(host, timeout=3) if scheme == "https" else http.client.HTTPConnection(host, timeout=3)
        conn.request("GET", path)
        resp = conn.getresponse()
        status = resp.status
        conn.close()
        return {"ok": status < 500, "status": status}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---- 사용자 우선 플래그 ----
def set_user_activity():
    global USER_ACTIVITY_FLAG, BACKGROUND_TASKS_PAUSED
    USER_ACTIVITY_FLAG = True;  BACKGROUND_TASKS_PAUSED = True

def clear_user_activity():
    global USER_ACTIVITY_FLAG
    USER_ACTIVITY_FLAG = False

@app.middleware("http")
async def user_priority_middleware(request: Request, call_next):
    set_user_activity()
    try:
        response = await call_next(request)
    finally:
        asyncio.create_task(delayed_background_resume())
    return response

async def delayed_background_resume():
    await asyncio.sleep(1.5)
    global BACKGROUND_TASKS_PAUSED
    BACKGROUND_TASKS_PAUSED = False
    clear_user_activity()

# ---- 라벨/클래스 노스토어 ----
@app.middleware("http")
async def no_store_for_labels_and_classes(request: Request, call_next):
    response = await call_next(request)
    p = request.url.path
    if p.startswith("/api/labels") or p.startswith("/api/classes"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# ---- 액세스 테이블 로그 ----
class AccessTrackingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 자동 로그인 강제: 세션 쿠키가 없고 HTML 페이지 접근 시 IdP SSO로 직접 리다이렉트
        if AUTO_LOGIN:
            path = request.url.path
            # 정적/JS/API 는 제외하고, 루트/페이지 접근만 리다이렉트
            if not path.startswith(('/api/', '/js/', '/static/', '/saml/')):
                if not request.cookies.get('session_user'):
                    # settings.json에서 IdP SSO URL 읽기
                    try:
                        base_settings, _ = _load_saml_files()
                        idp_sso_url = base_settings.get('idp', {}).get('singleSignOnService', {}).get('url', '')
                        if idp_sso_url:
                            logger.info(f"🔐 [AUTO LOGIN] 세션 없음 → IdP SSO로 리다이렉트: {idp_sso_url}")
                            return RedirectResponse(idp_sso_url, status_code=302)
                    except Exception as e:
                        logger.warning(f"⚠️ [AUTO LOGIN] IdP SSO URL 로드 실패, /saml/login으로 폴백: {e}")

                    # 폴백: /saml/login으로 리다이렉트
                    login_url = '/saml/login'
                    if DEFAULT_ORG_URL:
                        login_url += f"?org_url={DEFAULT_ORG_URL}"
                    return RedirectResponse(login_url, status_code=302)
        response = await call_next(request)

        client_ip = logger_instance.get_client_ip(request)
        user_cookie = request.cookies.get("session_user") or None
        # 세션 메타(JSON) 파싱 시도
        meta_cookie = request.cookies.get("session_meta")
        meta_dict = None
        if meta_cookie:
            try:
                meta_dict = json.loads(meta_cookie)
            except Exception:
                meta_dict = None
        # 표시: 계정 이름 부서 IP
        display_user = user_cookie or client_ip
        if meta_dict:
            name = meta_dict.get('Username') or meta_dict.get('username')
            dept = meta_dict.get('DeptName') or meta_dict.get('department')
            parts = []
            if user_cookie: parts.append(user_cookie)
            if name: parts.append(name)
            if dept: parts.append(dept)
            parts.append(client_ip)
            display_user = " | ".join(parts)
        endpoint = str(request.url.path)
        method = request.method
        status = response.status_code

        skip_prefix = ["/favicon.ico", "/static/", "/js/", "/api/files/all", "/api/stats", "/api/stats/", "/stats"]
        if any(endpoint.startswith(p) for p in skip_prefix):
            return response

        if endpoint.startswith(("/api/thumbnail", "/api/image")):
            tag = "IMAGE"
        elif endpoint.startswith("/api/classify"):
            tag = "ACTION"
        else:
            tag = "API"

        try:
            # 계정 쿠키(session_user)가 있으면 해당 사용자 기준으로 통계 집계 + 부서/팀/회사 메타
            logger_instance._update_stats(client_ip, endpoint, method, user_id_override=user_cookie, meta=meta_dict)
        except Exception:
            pass
        # 내부 log_access 호출은 try/except로 무시되므로, 테이블 출력은 아래 한 번만 수행

        note = _note_from_request(request, endpoint)
        # NOTE 칼럼에 부서/팀/회사 간단 표기 (있을 때만)
        if meta_dict:
            bits = []
            if meta_dict.get("company"): bits.append(meta_dict.get("company"))
            if meta_dict.get("department"): bits.append(meta_dict.get("department"))
            if meta_dict.get("team"): bits.append(meta_dict.get("team"))
            if bits:
                note = (note + " ").strip() + f"[{ ' / '.join(bits) }]"
        # IP 칼럼에 계정(username@hostname) 우선 표시
        log_access_row(tag=tag, ip=display_user, method=method, status=status, path=endpoint, note=note)
        return response

app.add_middleware(AccessTrackingMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# ======================== Utilities & Sync ========================
def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS

def get_thumbnail_path(image_path: Path, size: Tuple[int, int]) -> Path:
    # 🔥 절대 경로를 해시로 변환하여 썸네일 경로 생성
    path_hash = hashlib.md5(str(image_path.resolve()).encode()).hexdigest()[:16]
    thumbnail_name = f"{path_hash}_{size[0]}x{size[1]}.{THUMBNAIL_FORMAT.lower()}"
    return THUMBNAIL_DIR / thumbnail_name

def safe_resolve_path(path: Optional[str]) -> Path:
    if not path: return current_folder
    try:
        normalized = os.path.normpath(str(path).lstrip("/\\"))
        target = (current_folder / normalized).resolve()
        if not str(target).startswith(str(ROOT_DIR)):
            raise HTTPException(status_code=400, detail="Invalid path")
        return target
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"경로 해석 실패: {path}, 오류: {e}")
        raise HTTPException(status_code=400, detail="Invalid path")

def compute_etag(st) -> str:
    return f'W/"{st.st_mtime_ns:x}-{st.st_size:x}"'

def relkey_from_any_path(any_path: str) -> str:
    abs_path = safe_resolve_path(any_path)
    return str(abs_path.relative_to(ROOT_DIR)).replace("\\", "/")

def _classification_dir() -> Path:
    return current_folder / "classification"

def _classes_stat_mtime() -> float:
    try: return _classification_dir().stat().st_mtime
    except FileNotFoundError: return 0.0

def _scan_classes() -> set:
    classes = set(); d = _classification_dir()
    if not d.exists(): return classes
    try:
        with os.scandir(d) as it:
            for e in it:
                if e.is_dir(follow_symlinks=False): classes.add(e.name)
    except FileNotFoundError:
        pass
    return classes

def _labels_reload_if_stale():
    global LABELS_MTIME
    try: st = LABELS_FILE.stat()
    except FileNotFoundError: return
    if st.st_mtime > LABELS_MTIME: _labels_load()

def _dircache_invalidate(path: Path):
    try: DIRLIST_CACHE.delete(str(path))
    except Exception: pass
    try: DIRLIST_CACHE.delete(str(path.resolve()))
    except Exception: pass

def _sync_labels_with_classes(existing_classes: set) -> int:
    removed = 0
    with LABELS_LOCK:
        for rel, labs in list(LABELS.items()):
            new_labs = [x for x in labs if x in existing_classes]
            if new_labs != labs:
                LABELS[rel] = new_labs or LABELS.pop(rel, None) or []
                removed += 1
    if removed: _labels_save()
    return removed

def _sync_labels_if_classes_changed():
    global CLASSES_MTIME
    cur = _classes_stat_mtime()
    if cur > CLASSES_MTIME:
        CLASSES_MTIME = cur
        classes = _scan_classes()
        cleaned = _sync_labels_with_classes(classes)
        if cleaned:
            logger.info(f"[SYNC] classes 변경 감지 → 라벨 {cleaned}개 이미지에서 정리됨")

async def labels_classes_sync_dep():
    _labels_reload_if_stale()
    _sync_labels_if_classes_changed()

def _remove_label_from_all_images(label_name: str) -> int:
    removed = 0
    with LABELS_LOCK:
        for rel, labs in list(LABELS.items()):
            if label_name in labs:
                new_labs = [x for x in labs if x != label_name]
                if new_labs: LABELS[rel] = new_labs
                else: LABELS.pop(rel, None)
                removed += 1
    if removed:
        _labels_save()
        log_access_row(tag="INFO", note=f"라벨 완전 삭제: '{label_name}' → {removed}개 이미지에서 제거")
    return removed

# ----- labels file I/O -----
def _labels_load():
    global LABELS, LABELS_MTIME
    if not LABELS_FILE.exists():
        with LABELS_LOCK:
            LABELS = {}
        LABELS_MTIME = 0.0
        return
    try:
        with LABELS_LOCK:
            with open(LABELS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            LABELS = {k: [str(x) for x in v] for k, v in data.items() if isinstance(v, list)}
        try:
            LABELS_MTIME = LABELS_FILE.stat().st_mtime
        except Exception:
            LABELS_MTIME = time.time()

        log_access_row(tag="INFO", note=f"라벨 로드: {len(LABELS)}개 이미지 (mtime={LABELS_MTIME:.5f})")
    except Exception as e:
        logger.error(f"라벨 로드 실패: {e}")

def _labels_save():
    global LABELS_MTIME
    try:
        LABELS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = LABELS_FILE.with_suffix(".json.tmp")
        with LABELS_LOCK:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(LABELS, f, ensure_ascii=False, indent=2)
            os.replace(tmp, LABELS_FILE)
        try:
            LABELS_MTIME = LABELS_FILE.stat().st_mtime
        except Exception:
            LABELS_MTIME = time.time()
    except Exception as e:
        logger.error(f"라벨 저장 실패: {e}")
        raise HTTPException(status_code=500, detail="Failed to save labels")

# ======================== Directory Listing / Index ========================
def list_dir_fast(target: Path) -> List[Dict[str, str]]:
    no_cache_paths = ["classification", "images", "labels"]
    should_cache = not any(x in str(target).replace("\\", "/") for x in no_cache_paths)

    key = str(target)
    if should_cache:
        cached = DIRLIST_CACHE.get(key)
        if cached is not None:
            return cached

    items: List[Dict[str, str]] = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                name = entry.name
                # 🔥 classification, thumbnails 폴더 제외
                if name.startswith('.') or name == '__pycache__' or name in SKIP_DIRS or name in ['classification', 'thumbnails']: 
                    continue
                typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                # 🔥 ROOT_DIR 기준 상대 경로 추가
                try:
                    abs_path = Path(entry.path).resolve()
                    rel_path = str(abs_path.relative_to(ROOT_DIR.resolve())).replace('\\', '/')
                except ValueError:
                    # ROOT_DIR 밖이면 절대 경로 그대로
                    rel_path = str(entry.path).replace('\\', '/')
                items.append({
                    "name": name, 
                    "type": typ, 
                    "path": str(entry.path).replace('\\', '/'),
                    "rel_path": rel_path  # ROOT_DIR 기준 상대 경로
                })
        directories = [x for x in items if x["type"] == "directory"]
        files = [x for x in items if x["type"] == "file"]
        directories.sort(key=lambda x: x["name"].lower(), reverse=True)
        files.sort(key=lambda x: x["name"].lower(), reverse=True)
        items = directories + files
        if should_cache: DIRLIST_CACHE.set(key, items)
    except FileNotFoundError:
        pass
    return items

async def build_file_index_background():
    global INDEX_BUILDING, INDEX_READY
    if INDEX_BUILDING: return
    INDEX_BUILDING, INDEX_READY = True, False
    log_access_row(tag="INFO", note="백그라운드 인덱스 구축 시작")

    def _walk_and_index():
        global INDEX_READY
        start = time.time()
        for root, dirs, files in os.walk(ROOT_DIR):
            if BACKGROUND_TASKS_PAUSED or USER_ACTIVITY_FLAG: time.sleep(0.1)
            for skip in list(SKIP_DIRS):
                if skip in dirs: dirs.remove(skip)
            for fn in files:
                if os.path.splitext(fn)[1].lower() not in SUPPORTED_EXTENSIONS: continue
                full = Path(root) / fn
                try: rel = str(full.relative_to(ROOT_DIR)).replace("\\", "/")
                except Exception: continue
                try:
                    st = full.stat()
                    rec = {"name_lower": fn.lower(), "size": st.st_size, "modified": st.st_mtime}
                    with FILE_INDEX_LOCK: FILE_INDEX[rel] = rec
                except Exception:
                    continue
            time.sleep(0.001)
        INDEX_READY = True
        elapsed = time.time() - start
        log_access_row(tag="INFO", note=f"인덱스 구축 완료: {len(FILE_INDEX)}개, {elapsed:.1f}s")

    try:
        await asyncio.get_running_loop().run_in_executor(ThreadPoolExecutor(max_workers=1), _walk_and_index)
    finally:
        INDEX_BUILDING = False

# ======================== Thumbnails / Common ========================
def _generate_thumbnail_sync(image_path: Path, thumbnail_path: Path, size: Tuple[int, int]):
    try:
        # 썸네일 디렉토리 생성
        thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
        
        # 이미지 열기 및 썸네일 생성
        with Image.open(image_path) as img:
            # 원본 이미지가 이미 작으면 복사만
            if img.width <= size[0] and img.height <= size[1]:
                img.save(
                    thumbnail_path, 
                    THUMBNAIL_FORMAT.upper(), 
                    quality=THUMBNAIL_QUALITY, 
                    optimize=True
                )
            else:
                # 썸네일 생성 (고품질 리샘플링)
                img.thumbnail(size, Image.Resampling.LANCZOS)
                img.save(
                    thumbnail_path, 
                    THUMBNAIL_FORMAT.upper(), 
                    quality=THUMBNAIL_QUALITY, 
                    optimize=True
                )
    except Exception as e:
        logger.error(f"동기 썸네일 생성 실패: {image_path} -> {thumbnail_path}, 오류: {e}")
        raise

async def generate_thumbnail(image_path: Path, size: Tuple[int, int]) -> Optional[Path]:
    start_time = time.time()
    try:
        thumb = get_thumbnail_path(image_path, size)
        key = f"{thumb}|{size[0]}x{size[1]}"

        if not image_path.exists():
            logger.warning(f"원본 이미지 파일이 존재하지 않습니다: {image_path}")
            return None

        try:
            image_mtime = image_path.stat().st_mtime
        except Exception as e:
            logger.warning(f"이미지 파일 정보 읽기 실패: {image_path}, 오류: {e}")
            return None

        # 캐시 확인
        cached = False
        if thumb.exists() and thumb.stat().st_size > 0:
            try:
                if thumb.stat().st_mtime >= image_mtime:
                    cached = THUMB_STAT_CACHE.get(key)
            except Exception:
                cached = False
        if cached:
            THUMB_STAT_CACHE.set(key, True)
            elapsed = time.time() - start_time
            logger.info(f"⚡ [THUMB CACHE HIT] {image_path.name} - {elapsed*1000:.1f}ms")
            return thumb

        async with THUMBNAIL_SEM:
            # 다시 한번 확인 (레이스 컨디션 방지)
            if thumb.exists() and thumb.stat().st_size > 0:
                try:
                    if thumb.stat().st_mtime >= image_mtime:
                        THUMB_STAT_CACHE.set(key, True)
                        elapsed = time.time() - start_time
                        logger.info(f"⚡ [THUMB CACHE HIT2] {image_path.name} - {elapsed*1000:.1f}ms")
                        return thumb
                except Exception:
                    pass
            
            # 기존 썸네일 삭제 (구버전인 경우)
            if thumb.exists():
                try:
                    thumb.unlink()
                except Exception as e:
                    logger.warning(f"기존 썸네일 삭제 실패: {thumb}, 오류: {e}")
            
            # 새 썸네일 생성
            gen_start = time.time()
            logger.info(f"🔨 [THUMB GEN START] {image_path.name} - 썸네일 생성 시작")
            try:
                await asyncio.get_running_loop().run_in_executor(
                    ThreadPoolExecutor(max_workers=1), _generate_thumbnail_sync, image_path, thumb, size
                )
                gen_elapsed = time.time() - gen_start
                
                # 생성된 썸네일 확인
                if thumb.exists() and thumb.stat().st_size > 0:
                    THUMB_STAT_CACHE.set(key, True)
                    elapsed = time.time() - start_time
                    logger.info(f"✅ [THUMB GEN DONE] {image_path.name} - 생성: {gen_elapsed*1000:.1f}ms, 전체: {elapsed*1000:.1f}ms")
                    return thumb
                else:
                    logger.warning(f"썸네일 생성 후 파일이 존재하지 않거나 크기가 0: {thumb}")
                    return None
            except Exception as e:
                gen_elapsed = time.time() - gen_start
                logger.error(f"❌ [THUMB GEN FAIL] {image_path.name} - {gen_elapsed*1000:.1f}ms, 오류: {e}")
                return None
                
    except Exception as e:
        logger.error(f"썸네일 생성 중 예외 발생: {image_path}, 오류: {e}")
        return None

def maybe_304(request: Request, st) -> Optional[Response]:
    etag = compute_etag(st)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "public, max-age=604800, immutable"})
    return None

# ======================== Schemas ========================
_CLASS_NAME_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

class CreateClassReq(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)

class LabelAddReq(BaseModel):
    image_path: str = Field(..., description="ROOT 기준 상대경로 또는 절대경로도 허용")
    labels: List[str] = Field(..., min_items=1)

class LabelDelReq(BaseModel):
    image_path: str
    labels: Optional[List[str]] = None

class ClassifyRequest(BaseModel):
    image_path: str
    class_name: str

class ClassifyDeleteRequest(BaseModel):
    image_path: Optional[str] = None
    image_name: Optional[str] = None
    class_name: str

# 프런트 호환: 배치 삭제용 요청 스키마 (POST /api/classify/delete)
class ClassifyDeleteBatchReq(BaseModel):
    images: List[str]
    class_: str = Field(alias="class")

# ======================== Endpoints ========================
@app.get("/api/files")
async def get_files(path: Optional[str] = None, prefer: Optional[str] = None):
    try:
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        if any(x in str(target).replace('\\', '/') for x in ['classification', 'images', 'labels']):
            _dircache_invalidate(target)
        items = list_dir_fast(target)
        # prefer 폴더명을 최상단에
        if prefer:
            try:
                prefer_low = prefer.lower()
                items.sort(key=lambda x: (0 if x['type']=='directory' and x['name'].lower()==prefer_low else 1, x['name'].lower()), reverse=True)
            except Exception:
                pass
        return {"success": True, "items": items}
    except Exception as e:
        logger.exception(f"폴더 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Helpers ----------------
def _lookup_original_relpath_from_classification_path(path_str: str) -> Optional[str]:
    """classification/<class>/<filename> 형식이 오면 ROOT_DIR 내 원본 상대경로를 추정한다."""
    try:
        p = Path(path_str).as_posix()
        if "/classification/" not in p and not p.startswith("classification/"):
            return None
        filename = Path(p).name
        # FILE_INDEX 키는 ROOT 기준 상대경로
        with FILE_INDEX_LOCK:
            for rel, _rec in FILE_INDEX.items():
                if Path(rel).name == filename:
                    return rel
        # 인덱스가 아직 없으면 폴백: ROOT_DIR에서 탐색(최초 1회 비용)
        for root, _dirs, files in os.walk(ROOT_DIR):
            if filename in files:
                abs_match = Path(root) / filename
                try:
                    return str(abs_match.relative_to(ROOT_DIR)).replace("\\", "/")
                except Exception:
                    return None
    except Exception:
        return None

def _generate_pyramid_sync(image_path: Path, pyramid_path: Path, level: float):
    """🚀 피라미드 레벨 이미지 생성 (속도 극대화)"""

    # 디렉토리 생성
    pyramid_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info(f"🚀 [SPEED PYRAMID] 시작: {image_path.name} → level={level}")

    try:
        # PyVips로 초고속 처리 시도
        import pyvips

        # 🚀 순차 접근 모드로 이미지 로드 (메모리 효율 & 속도 최적화)
        image = pyvips.Image.new_from_file(str(image_path), access='sequential')

        orig_w, orig_h = image.width, image.height
        new_w = int(orig_w * level)
        new_h = int(orig_h * level)

        logger.info(f"🚀 [SPEED SIZE] 원본={orig_w}×{orig_h} → 새크기={new_w}×{new_h}")

        # 🚀 고품질 리사이즈: Lanczos3 (최고 품질)
        if level >= 1.0:
            # Level 1.0: 원본 복사
            resized = image
            logger.info(f"🚀 [ORIGINAL COPY] Level 1.0 - 원본 복사")
        else:
            # 모든 레벨: Lanczos3 (최고 품질)
            resized = image.resize(level, kernel='lanczos3')
            logger.info(f"🚀 [HIGH QUALITY] Level {level} - Lanczos3")

        # 🚀 고품질 JPEG 저장 (Q=100, 빠른 저장 우선)
        resized.write_to_file(
            str(pyramid_path), 
            Q=100,
            strip=False,           # 메타데이터 유지 (처리 시간 단축)
            interlace=False,       # Progressive JPEG 비활성화 (속도 향상)
            optimize_coding=False  # Huffman 최적화 비활성화 (속도 우선)
        )

        logger.info(f"🚀 [SPEED SAVE] {pyramid_path} ({new_w}×{new_h})")

        # 파일 확인
        if pyramid_path.exists():
            file_size = pyramid_path.stat().st_size
            logger.info(f"✅ [SPEED SUCCESS] 파일크기: {file_size} bytes")
        else:
            logger.error(f"❌ [SPEED FAILED] 파일 생성 실패")

    except ImportError:
        # PyVips가 없으면 Pillow 사용
        logger.info(f"🚀 [PILLOW FALLBACK] PyVips 없음 - Pillow 사용")

        from PIL import Image

        with Image.open(image_path) as img:
            orig_w, orig_h = img.size
            new_w = int(orig_w * level)
            new_h = int(orig_h * level)

            logger.info(f"🚀 [PILLOW SIZE] 원본={orig_w}×{orig_h} → 새크기={new_w}×{new_h}")

            # 리사이즈 (LANCZOS: 최고 품질)
            resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            # JPEG로 저장 (Q=100, 최고 품질)
            resized.save(pyramid_path, format="JPEG", quality=100, optimize=False)

            logger.info(f"🚀 [PILLOW SAVE] {pyramid_path} ({new_w}×{new_h})")

    except Exception as e:
        logger.exception(f"🚀 [SPEED ERROR] 피라미드 생성 실패: {e}")

        # 실패 시 원본 복사
        try:
            import shutil
            shutil.copy2(image_path, pyramid_path)
            logger.info(f"🚀 [SPEED FALLBACK] 원본 복사: {pyramid_path}")
        except Exception as copy_error:
            logger.exception(f"🚀 [SPEED COPY FAILED] {copy_error}")
            raise

@app.get("/api/image")
async def get_image(request: Request, path: str, level: Optional[float] = None):
    try:
        # 🔥 ROOT_DIR 기준으로 경로 해석 (상대 경로 지원)
        if Path(path).is_absolute():
            # 절대 경로인 경우
            image_path = Path(path)
            # ROOT_DIR 내 경로인지 보안 검증
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Access denied: Path outside ROOT_DIR")
        else:
            # 상대 경로인 경우 ROOT_DIR 기준으로 해석
            image_path = ROOT_DIR / path
            # 보안 검증: ROOT_DIR 내에 있는지 확인
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Access denied: Path outside ROOT_DIR")
        
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")

        logger.info(f"🚀 [IMAGE API] 요청: path={path}, level={level}")
        logger.info(f"🚀 [IMAGE API] 해석된 경로: {image_path}")
        logger.info(f"🚀 [IMAGE API] ROOT_DIR: {ROOT_DIR}")

        # 🎯 피라미드 레벨이 요청된 경우
        if level is not None:
            logger.info(f"🎯 [PYRAMID MODE] 활성화됨")

            # 레벨 검증
            if level not in config.PYRAMID_LEVELS:
                level = min(config.PYRAMID_LEVELS, key=lambda x: abs(x - level))
                logger.info(f"🎯 [LEVEL FIXED] {level}")

            # 🚀 Level 1.0은 원본 파일 직접 반환 (최고속)
            if level >= 1.0:
                logger.info(f"🚀 [ORIGINAL DIRECT] Level 1.0 - 원본 파일 직접 반환")
                st = image_path.stat()
                headers = {
                    "Cache-Control": "public, max-age=31536000, immutable",  # 1년 캐시
                    "ETag": compute_etag(st),
                    "X-Pyramid-Level": "1.0",
                    "X-Cache-Status": "ORIGINAL"
                }
                return FileResponse(image_path, headers=headers)

            # 피라미드 디렉토리 생성
            pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{int(level*100)}"
            pyramid_dir.mkdir(parents=True, exist_ok=True)

            # 피라미드 파일 경로
            rel_path = image_path.relative_to(config.ROOT_DIR)
            safe_filename = str(rel_path).replace("/", "_").replace("\\", "_")

            # 비어있거나 잘못된 파일명 방지
            if not safe_filename.strip():
                safe_filename = "unknown_image"

            # Windows 예약 파일명 필터링
            stem = Path(safe_filename).stem
            stem_lower = stem.lower()
            WINDOWS_RESERVED = {'nul', 'con', 'prn', 'aux', 'nul.', 'con.', 'prn.', 'aux.'}
            if stem_lower in WINDOWS_RESERVED or any(stem_lower.startswith(f'{dev}') for dev in ['com', 'lpt']):
                stem = f"file_{stem}"

            pyramid_path = pyramid_dir / f"{stem}_L{int(level*100)}.jpg"
            logger.info(f"🎯 [PYRAMID PATH] {pyramid_path}")

            # 🚀 캐시 확인: 이미 존재하고 최신이면 즉시 반환
            image_mtime = image_path.stat().st_mtime
            if pyramid_path.exists() and pyramid_path.stat().st_size > 0:
                if pyramid_path.stat().st_mtime >= image_mtime:
                    logger.info(f"✅ [CACHE HIT] 캐시된 피라미드 사용: {pyramid_path}")
                    st = pyramid_path.stat()
                    headers = {
                        "Cache-Control": "public, max-age=31536000, immutable",
                        "Content-Type": "image/jpeg",
                        "ETag": compute_etag(st),
                        "X-Pyramid-Level": str(level),
                        "X-Cache-Status": "HIT"
                    }
                    return FileResponse(pyramid_path, headers=headers)

            # 캐시 미스: 피라미드 이미지 생성
            logger.info(f"🎯 [CACHE MISS] 피라미드 생성 시작: level={level}")
            _generate_pyramid_sync(image_path, pyramid_path, level)
            logger.info(f"🎯 [GENERATE COMPLETE] {pyramid_path}")

            # 생성된 파일 확인 및 반환
            if pyramid_path.exists():
                st = pyramid_path.stat()
                logger.info(f"✅ [PYRAMID SUCCESS] {pyramid_path} ({st.st_size} bytes)")

                headers = {
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Content-Type": "image/jpeg",
                    "ETag": compute_etag(st),
                    "X-Pyramid-Level": str(level),
                    "X-Cache-Status": "MISS"
                }
                return FileResponse(pyramid_path, headers=headers)
            else:
                logger.error(f"❌ [GENERATION FAILED] {pyramid_path}")
                raise HTTPException(status_code=500, detail="Pyramid generation failed")
        else:
            # 원본 이미지 반환
            logger.info(f"🎯 [ORIGINAL MODE] {image_path}")
            st = image_path.stat()
            headers = {"Cache-Control": "public, max-age=86400", "ETag": compute_etag(st)}
            return FileResponse(image_path, headers=headers)

    except Exception as e:
        logger.exception(f"❌ [IMAGE API ERROR] {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/thumbnail")
async def get_thumbnail(request: Request, path: str, size: int = THUMBNAIL_SIZE_DEFAULT):
    global THUMBNAIL_REQUEST_COUNTER
    
    try:
        # 🔍 첫 번째 요청 추적
        with THUMBNAIL_COUNTER_LOCK:
            THUMBNAIL_REQUEST_COUNTER += 1
            is_first_request = (THUMBNAIL_REQUEST_COUNTER == 1)
        
        # 🔥 ROOT_DIR 기준으로 경로 해석 (상대 경로 지원)
        if Path(path).is_absolute():
            # 절대 경로인 경우
            image_path = Path(path)
            # ROOT_DIR 내 경로인지 보안 검증
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                logger.warning(f"ROOT_DIR 외부 경로 접근 시도: {path}")
                raise HTTPException(status_code=403, detail="Access denied: Path outside ROOT_DIR")
        else:
            # 상대 경로인 경우 ROOT_DIR 기준으로 해석
            image_path = ROOT_DIR / path
            # 보안 검증: ROOT_DIR 내에 있는지 확인
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                logger.warning(f"ROOT_DIR 외부 경로 접근 시도: {path}")
                raise HTTPException(status_code=403, detail="Access denied: Path outside ROOT_DIR")
        
        # 🔍 첫 번째 요청만 상세 로그
        if is_first_request:
            logger.info(f"=" * 80)
            logger.info(f"🎯 [첫 번째 썸네일 요청]")
            logger.info(f"🔍 [THUMBNAIL #1] 프론트엔드 요청 경로: {path}")
            logger.info(f"🔍 [THUMBNAIL #1] ROOT_DIR: {ROOT_DIR}")
            logger.info(f"🔍 [THUMBNAIL #1] ROOT_DIR 기준 절대 경로: {image_path}")
            logger.info(f"🔍 [THUMBNAIL #1] 파일 존재: {image_path.exists()}")
            logger.info(f"🔍 [THUMBNAIL #1] 크기: {size}")
            if image_path.exists():
                try:
                    rel_path = image_path.resolve().relative_to(ROOT_DIR.resolve())
                    logger.info(f"🔍 [THUMBNAIL #1] ROOT_DIR 기준 상대 경로: {rel_path}")
                except ValueError:
                    logger.info(f"🔍 [THUMBNAIL #1] ⚠️ ROOT_DIR 외부 파일!")
            else:
                logger.info(f"🔍 [THUMBNAIL #1] ❌ 파일이 존재하지 않습니다!")
            logger.info(f"=" * 80)
        
        # 파일 존재 확인
        if not image_path.exists() or not image_path.is_file():
            logger.warning(f"이미지 파일이 존재하지 않습니다: {image_path}")
            raise HTTPException(status_code=404, detail="Image not found")
        
        # 이미지 형식 확인
        if not is_supported_image(image_path):
            logger.warning(f"지원하지 않는 이미지 형식: {image_path}")
            raise HTTPException(status_code=415, detail="Unsupported image format")
        
        try:
            # 썸네일 생성 시도
            thumb = await generate_thumbnail(image_path, (size, size))
            if thumb and thumb.exists():
                st = thumb.stat()
                resp_304 = maybe_304(request, st)
                if resp_304: return resp_304
                headers = {"Cache-Control": "public, max-age=604800, immutable", "ETag": compute_etag(st)}
                return FileResponse(thumb, headers=headers)
            else:
                # 썸네일 생성 실패 시 원본 이미지 제공
                logger.warning(f"썸네일 생성 실패, 원본 이미지 제공: {image_path}")
                return await get_image(request, path)
        except Exception as thumb_error:
            logger.warning(f"썸네일 생성 실패, 원본 이미지 제공: {thumb_error}")
            return await get_image(request, path)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"썸네일 제공 실패: {e}")
        raise HTTPException(status_code=500, detail=f"Thumbnail generation failed: {str(e)}")

class PreloadRequest(BaseModel):
    paths: List[str] = Field(..., description="썸네일을 미리 생성할 이미지 경로 목록")
    size: int = Field(THUMBNAIL_SIZE_DEFAULT, description="썸네일 크기")

@app.post("/api/thumbnail/preload")
async def preload_thumbnails(request: Request, preload_req: PreloadRequest):
    """썸네일 배치 미리 생성"""
    try:
        valid_paths = []
        for path_str in preload_req.paths:
            try:
                image_path = Path(path_str)
                # ROOT_DIR 내 경로인지 보안 검증
                try:
                    image_path.resolve().relative_to(ROOT_DIR.resolve())
                except ValueError:
                    continue
                
                if image_path.exists() and image_path.is_file() and is_supported_image(image_path):
                    valid_paths.append(path_str)
            except Exception:
                continue
        
        if not valid_paths:
            return {"success": True, "results": [], "message": "유효한 이미지 경로가 없습니다"}
        
        # 배치 썸네일 생성
        results = []
        for path_str in valid_paths[:20]:  # 최대 20개로 제한
            try:
                image_path = Path(path_str)
                thumb = await generate_thumbnail(image_path, (preload_req.size, preload_req.size))
                results.append({
                    "path": path_str,
                    "success": thumb is not None and thumb.exists(),
                    "thumbnail": str(thumb) if thumb else None
                })
            except Exception as e:
                results.append({
                    "path": path_str,
                    "success": False,
                    "error": str(e)
                })
        
        return {
            "success": True,
            "results": results,
            "total_requested": len(preload_req.paths),
            "valid_paths": len(valid_paths),
            "processed": len(results)
        }
    except Exception as e:
        logger.exception(f"썸네일 preload 실패: {e}")
        raise HTTPException(status_code=500, detail=f"Preload failed: {str(e)}")

@app.get("/api/search")
async def search_files(q: str = Query(..., description="파일명 검색(대소문자 무시, 부분일치)"),
                       limit: int = Query(500, ge=1, le=5000),
                       offset: int = Query(0, ge=0)):
    try:
        query = (q or "").strip().lower()
        if not query:
            return {"success": True, "results": [], "offset": offset, "limit": limit}
        goal = offset + limit
        bucket: List[str] = []

        # 🔥 current_folder 전역 변수 사용
        global current_folder
        search_root = current_folder
        
        # 🔍 디버그: 검색 폴더 확인
        logger.info(f"🔍 [SEARCH DEBUG] current_folder: {current_folder}")
        logger.info(f"🔍 [SEARCH DEBUG] search_root: {search_root}")
        logger.info(f"🔍 [SEARCH DEBUG] ROOT_DIR: {ROOT_DIR}")
        logger.info(f"🔍 [SEARCH DEBUG] 검색어: {query}")
        logger.info(f"🔍 [SEARCH DEBUG] current_folder == ROOT_DIR: {current_folder.resolve() == ROOT_DIR.resolve()}")
        logger.info(f"🔍 [SEARCH DEBUG] limit: {limit}, offset: {offset}")

        # 🔥 썸네일 캐시 초기화 (매 검색마다)
        THUMB_STAT_CACHE.clear()
        logger.info("🔍 [SEARCH DEBUG] 썸네일 캐시 초기화 완료")
        
        # 🔍 썸네일 요청 카운터 리셋 (새로운 검색)
        global THUMBNAIL_REQUEST_COUNTER
        with THUMBNAIL_COUNTER_LOCK:
            THUMBNAIL_REQUEST_COUNTER = 0
        logger.info("🔍 [SEARCH DEBUG] 썸네일 요청 카운터 리셋")

        # 🔥 current_folder가 ROOT_DIR과 다른 경우에만 필터링 적용
        if current_folder.resolve() != ROOT_DIR.resolve():
            # 하위 폴더에서 검색하는 경우 - 직접 파일 시스템 스캔 (더 빠름)
            logger.info(f"🔍 [SEARCH DEBUG] 하위 폴더 검색: {search_root}")
            try:
                for root, dirs, files in os.walk(search_root):
                    for skip in list(SKIP_DIRS):
                        if skip in dirs: dirs.remove(skip)
                    for fn in files:
                        ext = os.path.splitext(fn)[1].lower()
                        if ext not in SUPPORTED_EXTENSIONS: continue
                        low = fn.lower()
                        if query not in low: continue
                        full = Path(root) / fn
                        # 🔥 ROOT_DIR 기준 절대 경로로 변환
                        try:
                            rel_path = full.relative_to(ROOT_DIR)
                            abs_path = str(ROOT_DIR / rel_path).replace("\\", "/")
                            bucket.append(abs_path)
                        except ValueError:
                            # ROOT_DIR 밖의 파일이면 건너뛰기
                            continue
                        if len(bucket) >= goal: break
                    if len(bucket) >= goal: break
            except Exception as e:
                logger.error(f"하위 폴더 검색 실패: {e}")
        else:
            # ROOT_DIR에서 검색하는 경우 - 인덱스 사용
            logger.info(f"🔍 [SEARCH DEBUG] ROOT_DIR 전체 검색")
            with FILE_INDEX_LOCK:
                items = list(FILE_INDEX.items())
            if items:
                for rel, meta in items:
                    if query in meta["name_lower"]:
                        file_path = ROOT_DIR / rel
                        # 🔥 ROOT_DIR 기준 절대 경로 반환
                        abs_path = str(file_path.resolve()).replace("\\", "/")
                        bucket.append(abs_path)
                        if len(bucket) >= goal: break

            # 인덱스로 부족하면 파일 시스템 스캔으로 보완
            if len(bucket) < goal:
                seen = set(bucket)
                need = goal - len(bucket)
                def _scan():
                    nonlocal need
                    for root, dirs, files in os.walk(ROOT_DIR):
                        for skip in list(SKIP_DIRS):
                            if skip in dirs: dirs.remove(skip)
                        for fn in files:
                            ext = os.path.splitext(fn)[1].lower()
                            if ext not in SUPPORTED_EXTENSIONS: continue
                            low = fn.lower()
                            if query not in low: continue
                            full = Path(root) / fn
                            try: 
                                # 🔥 ROOT_DIR 기준 절대 경로 반환
                                rel = str(full.relative_to(ROOT_DIR)).replace("\\", "/")
                                abs_path = str(ROOT_DIR / rel).replace("\\", "/")
                            except Exception: continue
                            if rel in seen: continue
                            seen.add(rel)
                            bucket.append(abs_path)
                            try:
                                st = full.stat()
                                rec = {"name_lower": low, "size": st.st_size, "modified": st.st_mtime}
                                with FILE_INDEX_LOCK: FILE_INDEX[rel] = rec
                            except Exception:
                                pass
                            need -= 1
                            if need <= 0: return
                if need > 0:
                    await asyncio.get_running_loop().run_in_executor(ThreadPoolExecutor(max_workers=1), _scan)

        results = bucket[offset: offset + limit]
        
        # 🔍 디버그: 검색 결과 확인
        logger.info(f"🔍 [SEARCH DEBUG] 검색 결과 수: {len(bucket)}")
        logger.info(f"🔍 [SEARCH DEBUG] 반환되는 파일 수: {len(results)}")
        if bucket:
            logger.info(f"🔍 [SEARCH DEBUG] 첫 번째 결과: {bucket[0]}")
            if len(bucket) > 1:
                logger.info(f"🔍 [SEARCH DEBUG] 마지막 결과: {bucket[-1]}")
        
        return {"success": True, "results": results, "offset": offset, "limit": limit, "total": len(bucket)}
    except Exception as e:
        logger.exception(f"검색 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/all")
async def get_all_files():
    try:
        with FILE_INDEX_LOCK:
            keys = list(FILE_INDEX.keys())
        if not keys and not INDEX_BUILDING:
            asyncio.create_task(build_file_index_background())
        return {"success": True, "files": keys}
    except Exception as e:
        logger.exception(f"전체 파일 목록 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Classes ----------------
@app.get("/api/classes")
async def get_classes(_=Depends(labels_classes_sync_dep)):
    try:
        classification_dir = _classification_dir()
        _dircache_invalidate(classification_dir)
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            log_access_row(tag="INFO", note=f"classification 폴더 생성: {classification_dir}")
            return {"success": True, "classes": []}
        classes = []
        try:
            with os.scandir(classification_dir) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False): classes.append(entry.name)
        except FileNotFoundError:
            pass
        return {"success": True, "classes": sorted(classes, key=str.lower)}
    except Exception as e:
        logger.exception(f"분류 클래스 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classes")
async def create_class(req: CreateClassReq, _=Depends(labels_classes_sync_dep)):
    try:
        name = req.name.strip()
        if not name or name.isspace(): raise HTTPException(status_code=400, detail="클래스명이 비어있습니다")
        if any(ord(c) < 32 or ord(c) > 126 for c in name):
            raise HTTPException(status_code=400, detail="클래스명에 특수문자/한글 자모 사용 불가 (A-Z,a-z,0-9,_,-)")
        if not _CLASS_NAME_RE.match(name): raise HTTPException(status_code=400, detail="클래스명 형식 오류")
        if len(name) > 50: raise HTTPException(status_code=400, detail="클래스명이 너무 깁니다 (최대 50자)")
        class_dir = _classification_dir() / name
        if class_dir.exists(): raise HTTPException(status_code=409, detail="Class already exists")
        class_dir.mkdir(parents=True, exist_ok=False)
        _sync_labels_if_classes_changed()
        for p in (_classification_dir(), class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()
        log_access_row(tag="INFO", note=f"클래스 '{name}' 생성 완료")
        return {"success": True, "class": name, "refresh_required": True, "message": f"클래스 '{name}' 생성됨"}
    except Exception as e:
        logger.exception(f"클래스 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/classes/{class_name}")
async def delete_class(class_name: str = PathParam(..., min_length=1, max_length=128),
                       force: bool = Query(False, description="True면 내용 포함 통째 삭제"),
                       _=Depends(labels_classes_sync_dep)):
    try:
        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        if not class_dir.exists() or not class_dir.is_dir(): raise HTTPException(status_code=404, detail="Class not found")
        if force:
            shutil.rmtree(class_dir)
            log_access_row(tag="INFO", note=f"클래스 삭제(force): {class_name}")
        else:
            if any(class_dir.iterdir()): raise HTTPException(status_code=409, detail="Class directory not empty")
            class_dir.rmdir()
            log_access_row(tag="INFO", note=f"클래스 삭제: {class_name}")
        removed_cnt = _remove_label_from_all_images(class_name)
        _labels_load()
        for p in (_classification_dir(), class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()
        log_access_row(tag="INFO", note=f"클래스 '{class_name}' 삭제 완료")
        return {"success": True, "deleted": class_name, "force": force, "labels_cleaned": removed_cnt, "refresh_required": True}
    except Exception as e:
        logger.exception(f"클래스 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class DeleteClassesReq(BaseModel):
    names: List[str] = Field(..., min_items=1)

@app.post("/api/classes/delete")
async def delete_classes(req: DeleteClassesReq, _=Depends(labels_classes_sync_dep)):
    try:
        if not req.names: raise HTTPException(status_code=400, detail="클래스명 목록이 비어있습니다")
        deleted, failed, total_cleaned = [], [], 0
        for class_name in req.names:
            try:
                class_name = class_name.strip()
                if not _CLASS_NAME_RE.match(class_name): raise ValueError("Invalid class name")
                class_dir = _classification_dir() / class_name
                if not class_dir.exists() or not class_dir.is_dir(): raise FileNotFoundError("Class not found")
                shutil.rmtree(class_dir); deleted.append(class_name)
                total_cleaned += _remove_label_from_all_images(class_name)
            except Exception as e:
                failed.append({"class": class_name, "error": str(e)})
                logger.exception(f"클래스 {class_name} 삭제 실패: {e}")
        if total_cleaned > 0: _labels_load()
        _dircache_invalidate(_classification_dir())
        log_access_row(tag="INFO", note="배치 클래스 삭제 완료 - Label Explorer 새로고침 필요")
        return {"success": True, "deleted": deleted, "failed": failed, "labels_cleaned": total_cleaned,
                "refresh_required": True, "message": f"{len(deleted)}개 삭제, {len(failed)}개 실패"}
    except Exception as e:
        logger.exception(f"클래스 일괄 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/classes/{class_name}/images")
async def class_images(class_name: str = PathParam(..., min_length=1, max_length=128),
                       limit: int = Query(500, ge=1, le=5000),
                       offset: int = Query(0, ge=0),
                       _=Depends(labels_classes_sync_dep)):
    try:
        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        if not class_dir.exists() or not class_dir.is_dir(): raise HTTPException(status_code=404, detail="Class not found")
        found: List[str] = []; goal = offset + limit
        for p in class_dir.rglob("*"):
            if p.is_file() and is_supported_image(p):
                rel = str(p.relative_to(ROOT_DIR)).replace("\\", "/")
                found.append(rel)
                if len(found) >= goal: break
        return {"success": True, "class": class_name, "results": found[offset: offset + limit], "offset": offset, "limit": limit}
    except Exception as e:
        logger.exception(f"클래스 이미지 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Labels ----------------
@app.post("/api/labels")
async def add_labels(req: LabelAddReq, _=Depends(labels_classes_sync_dep)):
    try:
        rel = relkey_from_any_path(req.image_path)
        abs_path = ROOT_DIR / rel
        if not abs_path.exists() or not abs_path.is_file(): raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(abs_path): raise HTTPException(status_code=400, detail="Unsupported image format")
        new_labels = [str(x).strip() for x in req.labels if str(x).strip()]
        if not new_labels: raise HTTPException(status_code=400, detail="Empty labels")
        with LABELS_LOCK:
            cur = set(LABELS.get(rel, [])); cur.update(new_labels); LABELS[rel] = sorted(cur)
        _labels_save(); _dircache_invalidate(_classification_dir())
        return {"success": True, "image": rel, "labels": LABELS[rel]}
    except Exception as e:
        logger.exception(f"라벨 추가 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/labels")
async def delete_labels(req: LabelDelReq, _=Depends(labels_classes_sync_dep)):
    try:
        rel = relkey_from_any_path(req.image_path)
        with LABELS_LOCK:
            if rel not in LABELS: raise HTTPException(status_code=404, detail="No labels for this image")
            if req.labels is None: LABELS.pop(rel, None)
            else:
                to_remove = {str(x).strip() for x in req.labels if str(x).strip()}
                if not to_remove: raise HTTPException(status_code=400, detail="Empty labels to remove")
                remain = [x for x in LABELS[rel] if x not in to_remove]
                LABELS[rel] = remain or LABELS.pop(rel, None) or []
        _labels_save(); _dircache_invalidate(_classification_dir())
        return {"success": True, "image": rel, "labels": LABELS.get(rel, [])}
    except Exception as e:
        logger.exception(f"라벨 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/labels/delete")
async def delete_labels_post(req: LabelDelReq, _=Depends(labels_classes_sync_dep)):
    return await delete_labels(req)

@app.get("/api/labels/{image_path:path}")
async def get_labels(image_path: str, _=Depends(labels_classes_sync_dep)):
    try:
        rel = relkey_from_any_path(image_path)
        with LABELS_LOCK: labels = list(LABELS.get(rel, []))
        return {"success": True, "image": rel, "labels": labels}
    except Exception as e:
        logger.exception(f"라벨 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Stats passthrough ----------------
@app.get("/api/stats/daily")
async def get_daily_stats(): return logger_instance.get_daily_stats()
@app.get("/api/stats/trend")
async def get_trend_stats(days: int = Query(7, ge=1, le=30)): return logger_instance.get_daily_trend(days)
@app.get("/api/stats/monthly")
async def get_monthly_stats(months: int = Query(3, ge=1, le=12)): return logger_instance.get_monthly_trend(months)
@app.get("/api/stats/users")
async def get_users_stats(): return logger_instance.get_users_stats()
@app.get("/api/stats/recent-users")
async def get_recent_users(): return logger_instance.get_recent_users()
@app.get("/api/stats/user/{user_id}")
async def get_user_detail(user_id: str):
    user_detail = logger_instance.get_user_detail(user_id)
    if user_detail is None: raise HTTPException(status_code=404, detail="User not found")
    return user_detail
@app.get("/api/stats/active-users")
async def get_active_users(): return logger_instance.get_active_users()

# 상세 브레이크다운 제공 (회사/부서/팀/org_url)
@app.get("/api/stats/breakdown")
async def get_breakdown():
    daily = logger_instance.get_daily_stats()
    # get_daily_stats는 카운트만 제공하므로, 저장 파일을 직접 노출하지 않고
    # 최근 집계에서 breakdown을 재구성할 수 있도록 logger_instance 내부 구조 활용
    try:
        # 비공개 필드 접근 대신 공개 API 조합으로는 한계가 있어 일단 users/월간 트렌드로 대체
        monthly = logger_instance.get_monthly_trend(1)
        return {"daily": daily, "monthly": monthly}
    except Exception as e:
        return {"error": str(e), "daily": daily}

# ---------------- Classification ----------------
@app.post("/api/classify")
async def classify_images(request: ClassifyRequest, _=Depends(labels_classes_sync_dep)):
    """이미지를 클래스로 분류하고 classification 디렉토리에 복사/링크"""
    try:
        # classification 경로가 들어오면 원본 상대경로로 역매핑 시도
        rel_path = _lookup_original_relpath_from_classification_path(request.image_path) or relkey_from_any_path(request.image_path)
        abs_path = ROOT_DIR / rel_path
        if not abs_path.exists() or not abs_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(abs_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")
        
        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")
            
        # 클래스 디렉토리 생성
        class_dir = _classification_dir() / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        # 대상 파일 경로
        target_file = class_dir / abs_path.name
        
        # 파일 복사 또는 하드링크 생성
        try:
            if abs_path.stat().st_dev == class_dir.stat().st_dev:
                # 같은 드라이브면 하드링크 시도
                if not target_file.exists():
                    os.link(str(abs_path), str(target_file))
                    log_access_row(tag="ACTION", note=f"하드링크 생성: {rel_path} -> {class_name}")
            else:
                # 다른 드라이브면 복사
                if not target_file.exists():
                    shutil.copy2(abs_path, target_file)
                    log_access_row(tag="ACTION", note=f"파일 복사: {rel_path} -> {class_name}")
        except (OSError, PermissionError) as e:
            # 하드링크 실패시 복사로 폴백
            if not target_file.exists():
                shutil.copy2(abs_path, target_file)
                log_access_row(tag="ACTION", note=f"복사 폴백: {rel_path} -> {class_name}")
        
        # 라벨도 추가
        with LABELS_LOCK:
            cur_labels = set(LABELS.get(rel_path, []))
            cur_labels.add(class_name)
            LABELS[rel_path] = sorted(cur_labels)
        
        _labels_save()
        _dircache_invalidate(class_dir)
        
        return {"success": True, "image": rel_path, "class": class_name, "labels": LABELS[rel_path]}
        
    except Exception as e:
        logger.exception(f"이미지 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class BatchClassifyRequest(BaseModel):
    images: List[str]
    class_name: str

@app.post("/api/classify/batch")
async def classify_images_batch(request: BatchClassifyRequest, _=Depends(labels_classes_sync_dep)):
    """배치 이미지 분류"""
    try:
        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")
            
        # 클래스 디렉토리 생성
        class_dir = _classification_dir() / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        results = []
        errors = []
        
        for image_path in request.images:
            try:
                rel_path = _lookup_original_relpath_from_classification_path(image_path) or relkey_from_any_path(image_path)
                abs_path = ROOT_DIR / rel_path
                
                if not abs_path.exists() or not abs_path.is_file():
                    errors.append(f"{rel_path}: 파일 없음")
                    continue
                    
                if not is_supported_image(abs_path):
                    errors.append(f"{rel_path}: 지원하지 않는 형식")
                    continue
                
                # 대상 파일 경로
                target_file = class_dir / abs_path.name
                
                # 파일 복사 또는 하드링크 생성
                try:
                    if abs_path.stat().st_dev == class_dir.stat().st_dev:
                        # 같은 드라이브면 하드링크 시도
                        if not target_file.exists():
                            os.link(str(abs_path), str(target_file))
                    else:
                        # 다른 드라이브면 복사
                        if not target_file.exists():
                            shutil.copy2(abs_path, target_file)
                except (OSError, PermissionError):
                    # 하드링크 실패시 복사로 폴백
                    if not target_file.exists():
                        shutil.copy2(abs_path, target_file)
                
                # 라벨도 추가
                with LABELS_LOCK:
                    cur_labels = set(LABELS.get(rel_path, []))
                    cur_labels.add(class_name)
                    LABELS[rel_path] = sorted(cur_labels)
                
                results.append(rel_path)
                
            except Exception as e:
                errors.append(f"{rel_path}: {str(e)}")
        
        if results:
            _labels_save()
            _dircache_invalidate(class_dir)
        
        log_access_row(tag="ACTION", note=f"배치 분류: {len(results)}개 성공, {len(errors)}개 실패 -> {class_name}")
        
        return {
            "success": True,
            "class": class_name,
            "processed": len(results),
            "errors": len(errors),
            "results": results,
            "error_details": errors
        }
        
    except Exception as e:
        logger.exception(f"배치 이미지 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classify")
async def classify_images(request: ClassifyRequest, _=Depends(labels_classes_sync_dep)):
    """이미지를 클래스로 분류하고 classification 디렉토리에 복사/링크"""
    try:
        rel_path = relkey_from_any_path(request.image_path)
        abs_path = ROOT_DIR / rel_path
        
        if not abs_path.exists():
            raise HTTPException(status_code=404, detail="Image file not found")
        
        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")
        
        # 클래스 디렉토리 생성
        class_dir = _classification_dir() / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        # 대상 파일 경로
        target_file = class_dir / abs_path.name
        
        # 파일이 이미 존재하면 스킵
        if target_file.exists():
            logger.info(f"파일이 이미 존재함: {target_file}")
        else:
            # 하드링크 시도, 실패하면 복사
            try:
                if abs_path.drive.lower() == target_file.drive.lower():
                    os.link(str(abs_path), str(target_file))
                    logger.info(f"하드링크 생성: {abs_path} -> {target_file}")
                else:
                    import shutil
                    shutil.copy2(str(abs_path), str(target_file))
                    logger.info(f"파일 복사: {abs_path} -> {target_file}")
            except Exception as e:
                import shutil
                shutil.copy2(str(abs_path), str(target_file))
                logger.info(f"하드링크 실패, 복사로 대체: {abs_path} -> {target_file}")
        
        # 라벨 추가
        with LABELS_LOCK:
            if rel_path not in LABELS:
                LABELS[rel_path] = []
            if class_name not in LABELS[rel_path]:
                LABELS[rel_path].append(class_name)
                _labels_save()
        
        return {"success": True, "message": f"Image classified as '{class_name}'"}
        
    except Exception as e:
        logger.exception(f"이미지 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/classify")
async def delete_classification(request: ClassifyDeleteRequest, _=Depends(labels_classes_sync_dep)):
    """classification 디렉토리에서 이미지 제거"""
    try:
        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")
            
        class_dir = _classification_dir() / class_name
        if not class_dir.exists():
            raise HTTPException(status_code=404, detail="Class not found")
        
        # 이미지 경로 또는 이름으로 찾기
        if request.image_path:
            rel_path = _lookup_original_relpath_from_classification_path(request.image_path) or relkey_from_any_path(request.image_path)
            abs_path = ROOT_DIR / rel_path
            target_file = class_dir / abs_path.name
        elif request.image_name:
            target_file = class_dir / request.image_name
            # 원본 파일 경로 찾기
            for root, dirs, files in os.walk(ROOT_DIR):
                if request.image_name in files:
                    abs_path = Path(root) / request.image_name
                    rel_path = str(abs_path.relative_to(ROOT_DIR)).replace("\\", "/")
                    break
            else:
                raise HTTPException(status_code=404, detail="Original image not found")
        else:
            raise HTTPException(status_code=400, detail="Either image_path or image_name required")
        
        if not target_file.exists():
            raise HTTPException(status_code=404, detail="Classification file not found")
        
        # classification 디렉토리에서 파일 삭제
        target_file.unlink()
        
        # 라벨에서도 제거
        with LABELS_LOCK:
            if rel_path in LABELS and class_name in LABELS[rel_path]:
                new_labels = [x for x in LABELS[rel_path] if x != class_name]
                if new_labels:
                    LABELS[rel_path] = new_labels
                else:
                    LABELS.pop(rel_path, None)
        
        _labels_save()
        _dircache_invalidate(class_dir)
        
        log_access_row(tag="ACTION", note=f"분류 제거: {rel_path} from {class_name}")
        
        return {"success": True, "removed": str(target_file.relative_to(ROOT_DIR)), "class": class_name}
        
    except Exception as e:
        logger.exception(f"분류 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# 프런트엔드가 사용하는 엔드포인트: POST /api/classify/delete
@app.post("/api/classify/delete")
async def classify_delete_batch(request: ClassifyDeleteBatchReq, _=Depends(labels_classes_sync_dep)):
    try:
        class_name = request.class_.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")

        class_dir = _classification_dir() / class_name
        removed = 0
        for any_path in request.images:
            try:
                rel_path = relkey_from_any_path(any_path)
                abs_path = ROOT_DIR / rel_path
                target_file = class_dir / abs_path.name
                if target_file.exists():
                    try:
                        target_file.unlink()
                    except FileNotFoundError:
                        pass
                with LABELS_LOCK:
                    labels = set(LABELS.get(rel_path, []))
                    if class_name in labels:
                        labels.discard(class_name)
                        LABELS[rel_path] = sorted(labels) if labels else LABELS.pop(rel_path, None) or []
                removed += 1
            except Exception:
                continue

        _labels_save(); _dircache_invalidate(class_dir)
        log_access_row(tag="ACTION", note=f"배치 분류 제거: {removed} items from {class_name}")
        return {"success": True, "removed": removed, "class": class_name}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"배치 분류 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Static / Pages ----------------
app.mount("/js", StaticFiles(directory="js"), name="js")
app.mount("/static", StaticFiles(directory="."), name="static")

@app.get("/")
async def read_root():
    try:
        html_path = Path("index.html")
        return FileResponse(html_path) if html_path.exists() else {"message": "index.html not found"}
    except Exception as e:
        logger.exception(f"루트 페이지 로드 실패: {e}")
        return {"error": "Failed to load main page"}

@app.get("/stats")
async def read_stats():
    try:
        stats_path = Path("stats.html")
        return FileResponse(stats_path) if stats_path.exists() else {"message": "stats.html not found"}
    except Exception as e:
        logger.exception(f"통계 페이지 로드 실패: {e}")
        return {"error": "Failed to load stats page"}

@app.get("/main.js")
async def get_main_js():
    try:
        js_path = Path("main.js")
        return FileResponse(js_path) if js_path.exists() else {"message": "main.js not found"}
    except Exception as e:
        logger.exception(f"main.js 로드 실패: {e}")
        return {"error": "Failed to load main.js"}

# ---------------- Folder / Lifecycle ----------------
@app.get("/api/current-folder")
async def get_current_folder(): 
    global current_folder
    return {"current_folder": str(current_folder)}

@app.get("/api/root-folder")
async def get_root_folder():
    from .config import ROOT_DIR as ORIGINAL_ROOT_DIR
    return {"root_folder": str(ORIGINAL_ROOT_DIR)}

@app.post("/api/cache")
async def clear_cache(request: Request):
    """캐시 삭제 (file index 제외)"""
    try:
        # PAR 캐시 초기화 (썸네일, 디렉토리 리스트)
        DIRLIST_CACHE.clear()
        THUMB_STAT_CACHE.clear()
        
        # 🔥 썸네일 서비스 캐시도 삭제
        thumbnail_result = thumbnail_service.clear_cache()
        
        # 전역 인덱스는 유지 (file index 제외)
        log_access_row(tag="INFO", note="PAR 캐시 초기화 완료 (파일 인덱스 유지)")
        
        return {
            "success": True, 
            "message": "캐시가 초기화되었습니다 (파일 인덱스 유지)",
            "cleared_caches": ["디렉토리 리스트 캐시", "썸네일 통계 캐시", "썸네일 서비스 캐시"],
            "thumbnail_service": thumbnail_result
        }
    except Exception as e:
        logger.error(f"캐시 초기화 실패: {e}")
        raise HTTPException(status_code=500, detail=f"캐시 초기화 실패: {str(e)}")

@app.post("/api/cache/all")
async def clear_all_cache(request: Request):
    """전체 캐시 삭제 (file index 포함)"""
    try:
        # 모든 캐시 초기화
        DIRLIST_CACHE.clear()
        THUMB_STAT_CACHE.clear()
        
        # 전역 인덱스도 초기화
        global INDEX_READY, INDEX_BUILDING
        INDEX_READY = False
        INDEX_BUILDING = False
        
        log_access_row(tag="INFO", note="전체 캐시 초기화 완료 (파일 인덱스 포함)")
        
        return {
            "success": True, 
            "message": "모든 캐시가 초기화되었습니다",
            "cleared_caches": ["디렉토리 리스트 캐시", "썸네일 통계 캐시", "파일 인덱스"]
        }
    except Exception as e:
        logger.error(f"전체 캐시 초기화 실패: {e}")
        raise HTTPException(status_code=500, detail=f"전체 캐시 초기화 실패: {str(e)}")

@app.post("/api/change-folder")
async def change_folder(request: Request):
    try:
        data = await request.json()
        new_path = data.get("path")
        if not new_path: raise HTTPException(status_code=400, detail="폴더 경로가 필요합니다")
        new_path_obj = Path(new_path).resolve()
        if not new_path_obj.exists(): raise HTTPException(status_code=404, detail="폴더가 존재하지 않습니다")
        if not new_path_obj.is_dir(): raise HTTPException(status_code=400, detail="유효한 폴더가 아닙니다")

        # 🔥 ROOT_DIR은 절대 변경하지 않음! current_folder만 변경
        global current_folder
        current_folder = new_path_obj
        
        # 🔍 디버그: 폴더 변경 확인
        logger.info(f"🔍 [CHANGE_FOLDER DEBUG] ROOT_DIR (변경 안됨): {ROOT_DIR}")
        logger.info(f"🔍 [CHANGE_FOLDER DEBUG] 새 current_folder: {current_folder}")
        logger.info(f"🔍 [CHANGE_FOLDER DEBUG] THUMBNAIL_DIR (변경 안됨): {THUMBNAIL_DIR}")
        logger.info(f"🔍 [CHANGE_FOLDER DEBUG] 변경 전 경로: {new_path}")
        logger.info(f"🔍 [CHANGE_FOLDER DEBUG] 변경 후 절대 경로: {new_path_obj}")
        
        # 🔥 ROOT_DIR과 THUMBNAIL_DIR은 절대 변경하지 않음
        # 썸네일과 라벨은 원래 ROOT_DIR 기준으로 관리

        DIRLIST_CACHE.clear();  THUMB_STAT_CACHE.clear()
        
        # 🔍 썸네일 요청 카운터 리셋 (새로운 폴더)
        global INDEX_READY, INDEX_BUILDING, THUMBNAIL_REQUEST_COUNTER
        with THUMBNAIL_COUNTER_LOCK:
            THUMBNAIL_REQUEST_COUNTER = 0
        logger.info("🔍 [CHANGE_FOLDER DEBUG] 썸네일 요청 카운터 리셋")
        
        INDEX_READY = False; INDEX_BUILDING = False

        classification_dir = _classification_dir()
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            log_access_row(tag="INFO", note=f"새 폴더의 classification 폴더 생성: {classification_dir}")

        _labels_load()
        return {
            "success": True, 
            "message": f"검색 폴더가 '{new_path}'로 변경되었습니다", 
            "root_dir": str(ROOT_DIR),
            "current_folder": str(current_folder)
        }
    except Exception as e:
        logger.error(f"폴더 변경 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 변경 실패: {str(e)}")

@app.get("/api/browse-folders")
async def browse_folders(path: Optional[str] = None):
    try:
        # 🔥 항상 ROOT_DIR 기준으로 폴더 목록 반환
        target_path = ROOT_DIR
        logger.info(f"🔍 [BROWSE FOLDERS] ROOT_DIR 기준 폴더 목록 조회: {target_path}")
        
        if not target_path.exists() or not target_path.is_dir():
            raise HTTPException(status_code=404, detail="ROOT_DIR을 찾을 수 없습니다")

        folders = []
        subfolders = []  # 2depth 폴더들
        
        try:
            with os.scandir(target_path) as it:
                for entry in it:
                    # 🔥 classification, thumbnails 폴더 제외
                    if entry.is_dir(follow_symlinks=False) and not entry.name.startswith('.') and entry.name not in ['classification', 'thumbnails']:
                        # 1depth 폴더 추가
                        folders.append({"name": entry.name, "path": str(entry.path), "type": "folder", "depth": 1})
                        
                        # 2depth 폴더들도 추가
                        try:
                            with os.scandir(entry.path) as sub_it:
                                for sub_entry in sub_it:
                                    # 🔥 classification, thumbnails 폴더 제외
                                    if sub_entry.is_dir(follow_symlinks=False) and not sub_entry.name.startswith('.') and sub_entry.name not in ['classification', 'thumbnails']:
                                        subfolders.append({
                                            "name": f"{entry.name} / {sub_entry.name}", 
                                            "path": str(sub_entry.path), 
                                            "type": "folder", 
                                            "depth": 2,
                                            "parent": entry.name
                                        })
                        except PermissionError:
                            # 하위 폴더 접근 권한이 없으면 무시
                            continue
                            
        except PermissionError:
            raise HTTPException(status_code=403, detail="폴더 접근 권한이 없습니다")

        # 1depth와 2depth 폴더를 합치고 정렬 (내림차순)
        all_folders = folders + subfolders
        all_folders.sort(key=lambda x: (x["depth"], x["name"].lower()), reverse=True)
        
        return {"folders": all_folders}
    except Exception as e:
        logger.error(f"폴더 브라우징 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 브라우징 실패: {str(e)}")

# ======================== Lifecycle ========================
@app.on_event("startup")
async def startup_event():
    bootlog = logging.getLogger("uvicorn.error")
    bootlog.info("🚀 L3Tracker 서버 시작 (테이블 로그 시스템)")
    scheme = "HTTPS" if config.SSL_ENABLED else "HTTP"
    port_to_log = config.HTTPS_PORT if config.SSL_ENABLED else config.DEFAULT_PORT
    bootlog.info(f"📍 호스트: {config.DEFAULT_HOST}")
    bootlog.info(f"🔌 포트: {port_to_log} ({scheme})")
    bootlog.info(f"📁 ROOT_DIR: {config.ROOT_DIR}")
    bootlog.info(f"🔧 PROJECT_ROOT: {os.getenv('PROJECT_ROOT', 'NOT SET')}")
    
    # 🔍 서버 시작 시 current_folder 정보 출력
    bootlog.info(f"🔍 [STARTUP] current_folder: {current_folder}")
    bootlog.info(f"🔍 [STARTUP] THUMBNAIL_DIR: {THUMBNAIL_DIR}")
    
    bootlog.info("=" * 50)
    print_access_header_once()

    # asyncio 소음 예외 억제(10054 등)
    try:
        loop = asyncio.get_running_loop()
        default_handler = loop.get_exception_handler()
        def _silence_asyncio(loop, context):
            exc = context.get('exception')
            msg = str(context.get('message', ''))
            if isinstance(exc, (ConnectionResetError,)):
                return
            if "WinError 10054" in msg:
                return
            if default_handler:
                default_handler(loop, context)
        loop.set_exception_handler(_silence_asyncio)
    except Exception:
        pass

    _classification_dir().mkdir(parents=True, exist_ok=True)
    _labels_load()
    global CLASSES_MTIME
    CLASSES_MTIME = _classes_stat_mtime()
    asyncio.create_task(build_file_index_background())

@app.on_event("shutdown")
async def shutdown_event():
    logging.getLogger("uvicorn.error").info("🛑 L3Tracker 서버 종료")

# ======================== __main__ ========================
if __name__ == "__main__":
    import uvicorn
    import multiprocessing

    if not config.SSL_ENABLED:
        logger.error("[SSL] SSL_ENABLED=0 입니다. 이 실행파일은 HTTPS만 지원합니다.")
        sys.exit(2)

    cert_path = Path(str(config.SSL_CERTFILE)).resolve()
    key_path  = Path(str(config.SSL_KEYFILE)).resolve()
    if not cert_path.exists() or not key_path.exists():
        logger.error(f"[SSL] 인증서/키 파일이 없습니다.\n  CERT: {cert_path}\n  KEY : {key_path}")
        sys.exit(2)

    reload_flag = os.getenv("RELOAD", "1") == "1"
    logger.info(f"[SSL] HTTPS 모드 활성화: 포트 {config.HTTPS_PORT}")
    logger.info(f"[SSL] CERTFILE={cert_path}")
    logger.info(f"[SSL] KEYFILE={key_path}")
    
    # 🔍 서버 시작 시 current_folder 정보 출력
    logger.info(f"🔍 [SERVER START] ROOT_DIR: {ROOT_DIR}")
    logger.info(f"🔍 [SERVER START] current_folder: {current_folder}")
    logger.info(f"🔍 [SERVER START] THUMBNAIL_DIR: {THUMBNAIL_DIR}")

    # 워커 수 결정 로직
    # - 환경변수 UVICORN_WORKERS가 있으면 그대로 사용
    # - 없으면 CPU 논리 코어의 50%를 기본값으로 사용 (최소 2, 최대 32)
    env_val = os.getenv("UVICORN_WORKERS")
    if env_val is not None and env_val.strip() != "":
        try:
            workers_env = int(env_val)
        except Exception:
            workers_env = 1
    else:
        try:
            cpu_cnt = max(1, multiprocessing.cpu_count())
            workers_env = max(2, min(32, int(cpu_cnt * 0.5)))
        except Exception:
            workers_env = 2
    # reload 사용 시 workers=1 고정. reload 비사용 시 환경변수로 워커 수 제어
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(config.HTTPS_PORT),        # 기본 8443
        reload=reload_flag,                 # 개발 편의
        workers=(1 if reload_flag else max(1, workers_env)),
        log_level="info",
        access_log=False,                   # 커스텀 테이블 로그 사용
        use_colors=True,
        log_config=None,
        ssl_certfile=str(cert_path),
        ssl_keyfile=str(key_path),
    )
