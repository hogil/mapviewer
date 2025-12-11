
"""
L3Tracker - Wafer Map Viewer API (HTTPS, Pretty Table Logs, Noise-free)
"""

# ======================== UTF-8 Console Setup ========================
import sys
import os

# Windows 콘솔 UTF-8 인코딩 설정 (이모지 지원)
if sys.platform == 'win32':
    try:
        import io
        if sys.stdout.encoding != 'utf-8':
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        if sys.stderr.encoding != 'utf-8':
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
        # Windows 콘솔 코드 페이지를 UTF-8로 설정
        os.system('chcp 65001 > nul 2>&1')
    except Exception:
        pass

# ======================== Imports ========================
import re, json, time, shutil, asyncio, logging, logging.config, hashlib, errno, queue, threading, uuid
from pathlib import Path
from contextlib import contextmanager, asynccontextmanager
from typing import List, Optional, Dict, Any, Tuple, Set, Literal, Iterable
from collections import OrderedDict
from bisect import bisect_left, bisect_right
from threading import RLock, Lock
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import urlparse, parse_qs

from fastapi import FastAPI, HTTPException, Query, Request, Path as PathParam, Depends, BackgroundTasks
from fastapi import Response as FastAPIResponse
from fastapi.responses import JSONResponse, FileResponse, Response, RedirectResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import anyio
try:
    from starlette.middleware.brotli import BrotliMiddleware
    HAS_BROTLI = True
except ImportError:
    BrotliMiddleware = None
    HAS_BROTLI = False
from pydantic import BaseModel, Field
from PIL import Image
import http.client
import urllib.parse

# ================= pyvips 로그 억제 =================
logging.getLogger('pyvips').setLevel(logging.WARNING)

# numpy import (required for TurboJPEG)
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    np = None
    HAS_NUMPY = False

# TurboJPEG import (optional)
try:
    from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_420, TJSAMP_422
    try:
        from turbojpeg import TJFLAG_FASTDCT
    except ImportError:
        TJFLAG_FASTDCT = None
    TURBOJPEG_AVAILABLE = HAS_NUMPY  # TurboJPEG requires numpy
except ImportError:
    TURBOJPEG_AVAILABLE = False
    TurboJPEG = None
    TJPF_RGB = None
    TJSAMP_420 = None
    TJFLAG_FASTDCT = None
    np = None

from .access_logger import logger_instance
from .detail_access_logger import detail_access_logger

# SAML (thumbnail_service보다 먼저 import - SAML은 필수, thumbnail은 optional)
try:
    from onelogin.saml2.auth import OneLogin_Saml2_Auth
    from onelogin.saml2.settings import OneLogin_Saml2_Settings
except Exception:
    OneLogin_Saml2_Auth = None
    OneLogin_Saml2_Settings = None

from .thumbnail_service import ThumbnailService
from . import config
from .index_service import (
    IndexService,
    _tokenize_logical_query,
    is_complex_query,
    search_index_logical,
    search_index_slice_parallel,
)
from .search_service import SearchService
from .personal_colors import (
    load_color_legends,
    save_color_legends,
    get_user_color_scheme,
    prepare_personalized_image,
    apply_personalized_palette,
    swap_first16_colors,
    plte_inplace_patch_memory,
)
from .composite_colors import (
    load_composite_color_settings,
    save_composite_color_settings,
)
from .my_lot import (
    add_entry as my_lot_add_entry,
    add_lot_batch as my_lot_add_lot_batch,
    create_placeholder_image as my_lot_create_placeholder,
    create_group as my_lot_create_group,
    delete_group as my_lot_delete_group,
    rename_group as my_lot_rename_group,
    list_my_lot as my_lot_list,
    remove_entry as my_lot_remove_entry,
    remove_entries_batch as my_lot_remove_entries_batch,
    create_manual_entry as my_lot_create_manual_entry,
)
from .user_manager import (
    get_user_manager,
    get_permission_checker,
    Role,
    Permission,
)

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
IMAGES_ROOT = config.IMAGES_ROOT
THUMBNAIL_DIR = config.THUMBNAIL_DIR
SUPPORTED_EXTENSIONS = set(ext.lower() for ext in config.SUPPORTED_EXTS)

# 🔥 현재 폴더 변수 (검색 제한용)
current_folder = IMAGES_ROOT

THUMBNAIL_FORMAT = config.THUMBNAIL_FORMAT
THUMBNAIL_QUALITY = config.THUMBNAIL_QUALITY
THUMBNAIL_SIZE_DEFAULT = config.THUMBNAIL_SIZE_DEFAULT

# TurboJPEG 인스턴스 (그리드 썸네일 최적화)
TURBO_JPEG = globals().get("TURBO_JPEG")
if TURBO_JPEG is None and TURBOJPEG_AVAILABLE and getattr(config, "USE_TURBOJPEG", False):
    try:
        turbo_path = getattr(config, "TURBOJPEG_PATH", "") or None
        TURBO_JPEG = TurboJPEG(lib_path=turbo_path if turbo_path else None)
        globals()["TURBO_JPEG"] = TURBO_JPEG
        print("[main.py] TurboJPEG Q95 FASTDCT + 4:2:0 초기화 완료")
    except Exception as e:
        print(f"[main.py] TurboJPEG 초기화 실패, pyvips 폴백: {e}")
        TURBO_JPEG = None

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
INDEX_REFRESH_INTERVAL_SECONDS = max(0, config.INDEX_REFRESH_INTERVAL_MINUTES) * 60
SKIP_DIRS = {d.strip() for d in config.SKIP_DIRS if d.strip()}

LABELS_DIR = config.LABELS_DIR
LABELS_FILE = config.LABELS_FILE

# ======================== Pools / State / Caches ========================
IO_POOL = ThreadPoolExecutor(max_workers=IO_THREADS)
DIRLIST_EXECUTOR = ThreadPoolExecutor(max_workers=max(4, min(16, (os.cpu_count() or 8))))
THUMBNAIL_SEM = asyncio.Semaphore(THUMBNAIL_SEM_SIZE)

# Composite map background task storage
COMPOSITE_TASKS: Dict[str, Dict[str, Any]] = {}
COMPOSITE_TASKS_LOCK = asyncio.Lock()

# Composite map concurrency control (최대 2개 동시 실행)
COMPOSITE_CONCURRENCY_LIMIT = 2
COMPOSITE_SEMAPHORE: Optional[asyncio.Semaphore] = None
_THUMBNAIL_EXECUTOR_WORKERS = max(4, min(THUMBNAIL_SEM_SIZE, (os.cpu_count() or 4) * 2))
THUMBNAIL_EXECUTOR = ThreadPoolExecutor(max_workers=_THUMBNAIL_EXECUTOR_WORKERS)

USER_ACTIVITY_FLAG = False
BACKGROUND_TASKS_PAUSED = False
INDEX_LOCK_WAIT_SECONDS = int(os.getenv("INDEX_LOCK_WAIT_SECONDS", "600"))
INDEX_CACHE_FILE = ROOT_DIR / ".file_index_cache.txt"
INDEX_LOCK_FILE = ROOT_DIR / ".file_index_cache.lock"
index_service = IndexService(
    root_dir=ROOT_DIR,
    skip_dirs=SKIP_DIRS,
    cache_file=INDEX_CACHE_FILE,
    lock_file=INDEX_LOCK_FILE,
    index_workers=config.INDEX_WORKERS,
    lock_wait_seconds=INDEX_LOCK_WAIT_SECONDS,
    logger=logging.getLogger("uvicorn.error"),
)
FILE_INDEX = index_service.file_index
FILE_INDEX_LOCK = index_service.lock
FILE_INDEX_KEYS = index_service.keys
FILE_INDEX_NAMES = index_service.names

SEARCH_FALLBACK_MAX_FILES = int(os.getenv("SEARCH_FALLBACK_MAX_FILES", "2000") or "0")
SEARCH_FALLBACK_TIMEOUT_MS = int(os.getenv("SEARCH_FALLBACK_TIMEOUT_MS", "5000") or "0")
_fallback_timeout_sec = SEARCH_FALLBACK_TIMEOUT_MS / 1000 if SEARCH_FALLBACK_TIMEOUT_MS > 0 else 5.0
search_service = SearchService(
    index_service=index_service,
    io_executor=IO_POOL,
    logger=logging.getLogger("uvicorn.error"),
    search_workers=config.SEARCH_WORKERS,
    excluded_folders=["classification", "classification_chips", "chip_annotations", "thumbnails", "composite_map"],
    supported_exts=config.SUPPORTED_EXTS,
    fallback_max_files=SEARCH_FALLBACK_MAX_FILES,
    fallback_timeout_sec=_fallback_timeout_sec,
)

# 검색 연산자 정규식 패턴 캐싱 (재컴파일 방지로 성능 향상) - 기존 유틸과 호환
_OPERATOR_PATTERNS = {
    "and": re.compile(r"\band\b", re.IGNORECASE),
    "or": re.compile(r"\bor\b", re.IGNORECASE),
    "not": re.compile(r"\bnot\b", re.IGNORECASE),
}
_LOGICAL_OPERATORS = {"and", "or", "not"}
_LOGICAL_PRECEDENCE = {"or": 1, "and": 2, "not": 3}

ROLES_FILE = Path("logs") / "permissions.json"
ROLES_FILE.parent.mkdir(parents=True, exist_ok=True)
ROLES_FILE_LOCK = Lock()
ROLE_DEFAULT = "ROLE_USER"
ROLE_HIERARCHY = ["ROLE_USER", "ROLE_POWER", "ROLE_ADMIN", "ROLE_SUPER"]
COMPOSITE_ROOT = ROOT_DIR / "composite_map"
COMPOSITE_ROOT.mkdir(parents=True, exist_ok=True)

def _pid_alive(pid: int) -> bool:
    # index_service가 내부에서 관리하므로 이전 호환성을 위해 유지
    try:
        os.kill(pid, 0)
    except OSError as exc:
        if exc.errno == errno.EPERM:
            return True
        return False
    except Exception:
        return False
    return True

def _matches_search_query(filename_lower: str, query: str) -> bool:
    """검색 쿼리와 파일명 매칭 (AND/OR/NOT 지원)

    Args:
        filename_lower: 소문자 파일명
        query: 검색 쿼리 (소문자, 공백 제거됨)

    Returns:
        매칭 여부
    """
    if not query:
        return True

    try:
        return _evaluate_expression(filename_lower, query)
    except Exception:
        # 오류 시 기본 포함 검색으로 폴백
        return query in filename_lower


def _tokenize_logical_query(query: str) -> List[str]:
    tokens: List[str] = []
    i = 0
    length = len(query)
    while i < length:
        ch = query[i]
        if ch in ("(", ")"):
            tokens.append(ch)
            i += 1
            continue
        if ch.isspace():
            i += 1
            continue
        j = i
        while j < length and query[j] not in ("(", ")") and not query[j].isspace():
            j += 1
        token = query[i:j].strip().lower()
        if token:
            tokens.append(token)
        i = j
    return tokens


def _is_complex_query(query: str) -> bool:
    tokens = _tokenize_logical_query(query)
    return any(tok in _LOGICAL_OPERATORS or tok in ("(", ")") for tok in tokens)

def _parse_lot_filter(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    parts = re.split(r"[,\n\r\t;/]+", raw)
    tokens: List[str] = []
    seen: Set[str] = set()
    for part in parts:
        cleaned = part.strip().lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        tokens.append(cleaned)
        if len(tokens) >= 100:
            break
    return tokens

def _filter_existing_relpaths(candidates: List[str]) -> Tuple[List[str], int]:
    valid: List[str] = []
    missing = 0
    root_resolved = ROOT_DIR.resolve()
    for rel in candidates:
        try:
            raw = str(rel).replace("\\", "/")
            if not raw:
                missing += 1
                continue
            rel_path_obj = Path(raw)
            if rel_path_obj.is_absolute():
                candidate_path = rel_path_obj.resolve()
            else:
                candidate_path = (ROOT_DIR / rel_path_obj).resolve()
            candidate_path.relative_to(root_resolved)
        except Exception:
            missing += 1
            continue
        if not candidate_path.exists() or not candidate_path.is_file():
            missing += 1
            continue
        try:
            if candidate_path.stat().st_size <= 0:
                missing += 1
                continue
        except OSError:
            missing += 1
            continue
        rel_str = str(candidate_path.relative_to(root_resolved)).replace("\\", "/")
        valid.append(rel_str)
    return valid, missing

def _roles_file_path() -> Path:
    ROLES_FILE.parent.mkdir(parents=True, exist_ok=True)
    return ROLES_FILE

def _load_roles_data() -> Dict[str, Any]:
    path = _roles_file_path()
    if not path.exists():
        return {"users": [], "updated_at": None}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
            if "users" not in data or not isinstance(data["users"], list):
                data["users"] = []
            return data
    except Exception:
        return {"users": [], "updated_at": None}

def _save_roles_data(data: Dict[str, Any]) -> None:
    path = _roles_file_path()
    tmp = path.with_suffix(".tmp")
    data["updated_at"] = datetime.now().isoformat()
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)

def _normalize_role(role: str) -> str:
    value = (role or ROLE_DEFAULT).strip().upper()
    if not value.startswith("ROLE_"):
        value = f"ROLE_{value}"
    if value not in ROLE_HIERARCHY:
        return ROLE_DEFAULT
    return value

def _current_login_id(req: Optional[Request]) -> Optional[str]:
    if req is None:
        return None
    try:
        session = req.session  # type: ignore[attr-defined]
    except Exception:
        # 세션 미들웨어가 없으면 세션 접근 건너뛰기
        pass
    else:
        try:
            session_user = session.get("session_user", {})
        except AttributeError:
            session_user = {}
        if isinstance(session_user, dict):
            for key in ("LoginId", "loginId", "login_id", "username"):
                if session_user.get(key):
                    return str(session_user[key])
    
    # cookie fallback
    login_id = req.cookies.get("session_user")
    if login_id:
        return login_id
    
    # 🔥 SAML 세션 확인 (URL 파라미터 또는 쿠키)
    try:
        # URL 파라미터에서 LoginId 확인 (SAML 로그인 직후)
        login_id_param = req.query_params.get("LoginId")
        if login_id_param and login_id_param in SAML_USER_SESSIONS:
            return login_id_param
        
        # SAML_USER_SESSIONS에서 모든 세션 확인 (현재는 간단하게 첫 번째 매칭)
        # 실제로는 쿠키나 헤더로 사용자를 식별해야 하지만, 일단 모든 세션 확인
        # TODO: 더 정확한 사용자 식별 방법 필요 (IP, 쿠키 등)
    except Exception:
        pass
    
    return None

def _get_user_role(login_id: Optional[str]) -> str:
    if not login_id:
        return ROLE_DEFAULT
    data = _load_roles_data()
    for user in data.get("users", []):
        if user.get("loginId") == login_id:
            return _normalize_role(user.get("role", ROLE_DEFAULT))
    return ROLE_DEFAULT

def _ensure_admin_access(req: Request) -> None:
    data = _load_roles_data()
    login_id = _current_login_id(req)
    # Bootstrap: no users yet -> allow access
    if not data.get("users"):
        return
    role = _get_user_role(login_id)
    if role not in {"ROLE_ADMIN", "ROLE_SUPER"}:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")

def _check_folder_permission(req: Request, folder_path: str, permission_type: str) -> None:
    """폴더별 권한 검사 (LABEL_WRITE 또는 CLASS_MANAGE)"""
    # 🔥 permissions.json에서 "all" 사용자 확인 (가장 먼저 확인, username 없어도 작동)
    try:
        roles_data = _load_roles_data()
        all_user = None
        for user in roles_data.get("users", []):
            if user.get("loginId") == "all":
                all_user = user
                break
        
        # "all" 사용자가 ADMIN 또는 SUPER 역할이면 모든 사용자에게 권한 부여
        if all_user:
            all_role = all_user.get("role", "")
            if all_role in {"ROLE_ADMIN", "ROLE_SUPER"}:
                # ADMIN/SUPER는 모든 폴더에 대한 모든 권한 보유
                logger.info(f"✅ [PERMISSION] 'all' 사용자가 {all_role} 역할로 모든 사용자에게 모든 권한 허용 (폴더: {folder_path}, 권한: {permission_type})")
                return
    except Exception as e:
        logger.warning(f"⚠️ [PERMISSION] permissions.json에서 'all' 사용자 확인 실패: {e}")
    
    # 🔥 새로운 user_manager 시스템 사용
    username = get_current_user(req)
    logger.debug(f"🔍 [PERMISSION] get_current_user 결과: {username}")
    
    # 🔥 username이 None인 경우 _current_login_id로 재시도 (SAML 세션 확인 포함)
    if username is None:
        username = _current_login_id(req)
        logger.debug(f"🔍 [PERMISSION] _current_login_id 결과: {username}")
    
    # 🔥 SAML 세션에서 직접 확인 (쿠키나 헤더로 LoginId 찾기)
    if username is None:
        try:
            # URL 파라미터에서 LoginId 확인 (SAML 로그인 직후)
            login_id_param = req.query_params.get("LoginId")
            if login_id_param and login_id_param in SAML_USER_SESSIONS:
                username = login_id_param
                logger.debug(f"🔍 [PERMISSION] URL 파라미터에서 LoginId 찾음: {username}")
            else:
                # SAML_USER_SESSIONS에서 쿠키로 사용자 찾기
                for login_id, meta in SAML_USER_SESSIONS.items():
                    # 쿠키에서 LoginId 확인 (간단한 방법)
                    if req.cookies.get("saml_login_id") == login_id:
                        username = login_id
                        logger.debug(f"🔍 [PERMISSION] 쿠키에서 LoginId 찾음: {username}")
                        break
                    # Referer 헤더에서 LoginId 추출 (리다이렉트 후)
                    referer = req.headers.get("referer", "")
                    if f"LoginId={login_id}" in referer:
                        username = login_id
                        logger.debug(f"🔍 [PERMISSION] Referer 헤더에서 LoginId 찾음: {username}")
                        break
        except Exception as e:
            logger.warning(f"⚠️ [PERMISSION] SAML 세션 확인 실패: {e}")
    
    logger.info(f"🔍 [PERMISSION] 최종 사용자 식별: {username} (폴더: {folder_path}, 권한: {permission_type})")
    
    # 🔥 permissions.json에서 현재 사용자 확인
    try:
        roles_data = _load_roles_data()
        user_data = None
        for user in roles_data.get("users", []):
            if user.get("loginId") == username:
                user_data = user
                break
        
        if user_data:
            user_role = user_data.get("role", "")
            # ADMIN/SUPER는 모든 폴더에 대한 모든 권한 보유
            if user_role in {"ROLE_ADMIN", "ROLE_SUPER"}:
                logger.info(f"✅ [PERMISSION] 사용자 '{username}'이 {user_role} 역할로 모든 권한 허용")
                return
            
            # 폴더별 권한 확인
            folders = user_data.get("folders", [])
            folder_path_lower = folder_path.lower().replace('\\', '/').rstrip('/')
            
            for folder in folders:
                folder_path_from_grant = folder.get("path", "").lower().replace('\\', '/').rstrip('/')
                
                # * 권한이면 모든 폴더 접근 가능
                if folder_path_from_grant == "*":
                    if permission_type == "CLASS_MANAGE" and folder.get("allow_class", False):
                        logger.info(f"✅ [PERMISSION] 사용자 '{username}'이 * 권한으로 {permission_type} 허용")
                        return
                    elif permission_type == "LABEL_WRITE" and folder.get("allow_label", False):
                        logger.info(f"✅ [PERMISSION] 사용자 '{username}'이 * 권한으로 {permission_type} 허용")
                        return
                
                # 폴더 경로 매칭 (하위 폴더 포함)
                if folder_path_lower.startswith(folder_path_from_grant):
                    if permission_type == "CLASS_MANAGE" and folder.get("allow_class", False):
                        logger.info(f"✅ [PERMISSION] 사용자 '{username}'이 {folder_path_from_grant} 권한으로 {permission_type} 허용")
                        return
                    elif permission_type == "LABEL_WRITE" and folder.get("allow_label", False):
                        logger.info(f"✅ [PERMISSION] 사용자 '{username}'이 {folder_path_from_grant} 권한으로 {permission_type} 허용")
                        return
    except Exception as e:
        logger.warning(f"⚠️ [PERMISSION] permissions.json에서 사용자 확인 실패: {e}")
    
    # 🔥 user_manager 시스템도 확인 (하위 호환성)
    checker = get_permission_checker()

    # Permission 매핑
    if permission_type == "LABEL_WRITE":
        required_permission = Permission.LABEL
    elif permission_type == "CLASS_MANAGE":
        required_permission = Permission.CLASS_MANAGE
    else:
        raise ValueError(f"Unknown permission type: {permission_type}")

    # 권한 검사 (username이 None이면 기본 권한으로 처리)
    if checker.has_permission(username, required_permission, folder_path):
        logger.info(f"✅ [PERMISSION] user_manager 시스템에서 사용자 '{username}' 권한 확인됨")
        return
    
    # 🔥 모든 권한 검사 실패
    logger.warning(f"❌ [PERMISSION] 사용자 '{username}'이 폴더 '{folder_path}'에 대한 {permission_type} 권한 없음")
    
    # 🔥 권한 타입을 한글로 변환
    permission_name = "클래스 관리" if permission_type == "CLASS_MANAGE" else "라벨 쓰기"
    
    raise HTTPException(
        status_code=403,
        detail=f"이 폴더에 대한 {permission_name} 권한이 없습니다."
    )


def _logical_to_postfix(tokens: List[str]) -> List[str]:
    output: List[str] = []
    stack: List[str] = []
    for token in tokens:
        if token == "(":
            stack.append(token)
        elif token == ")":
            while stack and stack[-1] != "(":
                output.append(stack.pop())
            if stack and stack[-1] == "(":
                stack.pop()
        elif token in _LOGICAL_OPERATORS:
            while stack and stack[-1] in _LOGICAL_OPERATORS:
                top = stack[-1]
                if token == "not":
                    if _LOGICAL_PRECEDENCE[top] > _LOGICAL_PRECEDENCE[token]:
                        output.append(stack.pop())
                    else:
                        break
                else:
                    if _LOGICAL_PRECEDENCE[top] >= _LOGICAL_PRECEDENCE[token]:
                        output.append(stack.pop())
                    else:
                        break
            stack.append(token)
        else:
            output.append(token)
    while stack:
        output.append(stack.pop())
    return output


def _collect_term_hits(keys_slice: List[str], names_slice: List[str], tokens: List[str]) -> Dict[str, Set[str]]:
    unique_terms = [
        token for token in tokens
        if token and token not in _LOGICAL_OPERATORS and token not in ("(", ")")
    ]
    unique_terms = list(dict.fromkeys(unique_terms))
    if not unique_terms:
        return {}

    def _scan_term(term: str) -> Tuple[str, Set[str]]:
        hits: Set[str] = set()
        if not term:
            return term, hits

        # 🔥 논리 검색(AND/OR/NOT)에서는 항상 전체 스캔 (in 방식)
        # 이유: "center and 1" 검색 시 "1"이 파일명 중간에 있을 수 있음
        # 예: center_asdf_1.png → "1"을 startswith로 찾으면 못 찾음
        for rel, name_lower in zip(keys_slice, names_slice):
            if term in name_lower:
                hits.add(rel)

        return term, hits

    max_workers = config.SEARCH_WORKERS or 1
    max_workers = max(1, min(len(unique_terms), max_workers))
    term_hits: Dict[str, Set[str]] = {}

    if max_workers == 1 or len(unique_terms) == 1:
        for term in unique_terms:
            t, hits = _scan_term(term)
            term_hits[t] = hits
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(_scan_term, term) for term in unique_terms]
            for future in as_completed(futures):
                term, hits = future.result()
                term_hits[term] = hits

    return term_hits


def _evaluate_logical_query(keys_slice: List[str], names_slice: List[str], query: str, limit: Optional[int] = None) -> List[str]:
    tokens = _tokenize_logical_query(query)
    postfix = _logical_to_postfix(tokens)
    term_hits = _collect_term_hits(keys_slice, names_slice, tokens)
    universe: Optional[Set[str]] = None
    if "not" in postfix:
        universe = set(keys_slice)
    stack: List[Set[str]] = []
    for token in postfix:
        if token in _LOGICAL_OPERATORS:
            if token == "not":
                operand = stack.pop() if stack else set()
                if universe is None:
                    universe = set(keys_slice)
                stack.append(universe - operand)
            else:
                right = stack.pop() if stack else set()
                left = stack.pop() if stack else set()
                if token == "and":
                    stack.append(left & right)
                else:
                    stack.append(left | right)
        else:
            stack.append(set(term_hits.get(token, set())))
    result_set = stack.pop() if stack else set()
    ordered_hits: List[str] = []
    # 🔥 limit이 None이면 제한 없이 모든 매칭 파일 검색
    for rel in keys_slice:
        if rel in result_set:
            ordered_hits.append(rel)
            if limit is not None and len(ordered_hits) >= limit:
                break
    return ordered_hits

def _evaluate_expression(filename: str, expression: str) -> bool:
    """표현식 평가 (괄호, OR 연산자 처리)"""
    # 괄호 처리 (재귀)
    while '(' in expression:
        start = expression.rfind('(')
        end = expression.find(')', start)
        if end == -1:
            break

        sub_expr = expression[start + 1:end]
        result = _evaluate_expression(filename, sub_expr)
        expression = expression[:start] + ('1' if result else '0') + expression[end + 1:]

    # OR 연산자로 분할
    or_terms = _split_by_operator(expression, 'or')
    if len(or_terms) > 1:
        return any(_evaluate_and_expression(filename, term.strip()) for term in or_terms)

    return _evaluate_and_expression(filename, expression)

def _evaluate_and_expression(filename: str, expression: str) -> bool:
    """AND 표현식 평가 (early termination 최적화)"""
    and_terms = _split_by_operator(expression, 'and')
    # all()의 short-circuit 평가 활용 (첫 False 발견 시 즉시 중단)
    for term in and_terms:
        if not _evaluate_not_expression(filename, term.strip()):
            return False
    return True

def _evaluate_not_expression(filename: str, expression: str) -> bool:
    """NOT 표현식 평가"""
    if expression.startswith('not '):
        term = expression[4:].strip()
        return not _evaluate_basic_term(filename, term)
    return _evaluate_basic_term(filename, expression)

def _evaluate_basic_term(filename: str, term: str) -> bool:
    """기본 용어 평가 (포함 검사)"""
    if not term or term in ('0', '1'):
        return term == '1'
    return term in filename

def _split_by_operator(text: str, operator: str) -> List[str]:
    """연산자로 문자열 분할 (단어 경계 고려)

    최적화: 정규식 사전 컴파일로 성능 향상
    """
    pattern = _OPERATOR_PATTERNS.get(operator)
    if not pattern:
        # 미리 정의되지 않은 연산자는 런타임 컴파일
        pattern = re.compile(r'\b' + operator + r'\b', re.IGNORECASE)
    parts = pattern.split(text)
    return [p for p in parts if p.strip()]

def _search_index_slice(keys: List[str], names: List[str], query: str, goal: Optional[int] = None) -> List[str]:
    """단일 청크 단순 검색 (AND/OR 없는 경우 전용)."""
    if not query:
        return []

    # 🔥 단일어도 포함 검색으로 처리 (파일명 중간 위치 매칭 보장)
    #    prefix 매치는 우선 수집 후 부족하면 포함 매치로 채움
    prefix_hits: List[str] = []
    contains_hits: List[str] = []

    for rel, name_lower in zip(keys, names):
        if name_lower.startswith(query):
            prefix_hits.append(rel)
        elif query in name_lower:
            contains_hits.append(rel)

        if goal is not None and len(prefix_hits) >= goal:
            break

    if goal is not None:
        remaining = goal - len(prefix_hits)
        if remaining > 0:
            prefix_hits.extend(contains_hits[:remaining])
        return prefix_hits

    return prefix_hits + contains_hits

def _search_index_slice_parallel(keys: List[str], names: List[str], query: str, goal: Optional[int] = None, num_chunks: int = 4) -> List[str]:
    """병렬 검색 (멀티청크, 단순 쿼리 전용)."""
    if not keys:
        return []

    num_chunks = max(1, num_chunks)

    if len(keys) < num_chunks * 10:
        return _search_index_slice(keys, names, query, goal)

    chunk_size = len(keys) // num_chunks
    key_chunks: List[List[str]] = []
    name_chunks: List[List[str]] = []
    for i in range(num_chunks):
        start = i * chunk_size
        end = start + chunk_size if i < num_chunks - 1 else len(keys)
        key_chunks.append(keys[start:end])
        name_chunks.append(names[start:end])

    results: List[str] = []
    with ThreadPoolExecutor(max_workers=num_chunks) as executor:
        futures = [
            executor.submit(_search_index_slice, key_chunk, name_chunk, query, goal)
            for key_chunk, name_chunk in zip(key_chunks, name_chunks)
        ]
        for future in as_completed(futures):
            try:
                chunk_results = future.result()
                results.extend(chunk_results)
                # 🔥 goal이 None이면 제한 없이 모든 결과 수집
                if goal is not None and len(results) >= goal:
                    break
            except Exception as exc:
                logger.error(f"청크 검색 실패: {exc}")
                continue

    # 🔥 goal이 None이면 모든 결과 반환, 있으면 goal개만 반환
    return results[:goal] if goal is not None else results

def _search_index_logical(keys: List[str], names: List[str], query: str, goal: Optional[int] = None) -> List[str]:
    """AND/OR/NOT 표현식을 위한 고급 검색."""
    if not keys or not query:
        return []
    return _evaluate_logical_query(keys, names, query, goal)

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

# 🔥 팔레트 캐시 (원본 PNG 파일의 팔레트 정보 캐싱 - 파일 읽기 최소화)
_PALETTE_CACHE: Dict[str, Tuple[float, List[int]]] = {}  # {image_path: (mtime, palette)}
_PALETTE_CACHE_LOCK = RLock()
_PALETTE_CACHE_MAX_SIZE = 500  # 최대 500개 파일의 팔레트 캐싱

def _get_cached_palette(image_path: Path) -> Optional[List[int]]:
    """원본 PNG 파일의 팔레트 정보를 캐시에서 가져오거나 읽기"""
    path_str = str(image_path)
    
    with _PALETTE_CACHE_LOCK:
        # 캐시 확인
        if path_str in _PALETTE_CACHE:
            cached_mtime, cached_palette = _PALETTE_CACHE[path_str]
            try:
                current_mtime = image_path.stat().st_mtime
                if current_mtime == cached_mtime:
                    return cached_palette
            except Exception:
                pass
        
        # 캐시에 없거나 파일이 변경된 경우 읽기
        try:
            from PIL import Image as PILImage
            with PILImage.open(image_path) as pil_original:
                if pil_original.mode != 'P':
                    pil_original = pil_original.convert('P')
                
                palette = pil_original.getpalette()
                if palette:
                    # 캐시에 저장
                    try:
                        mtime = image_path.stat().st_mtime
                        
                        # 캐시 크기 제한
                        if len(_PALETTE_CACHE) >= _PALETTE_CACHE_MAX_SIZE:
                            # 가장 오래된 항목 제거 (FIFO)
                            oldest_key = next(iter(_PALETTE_CACHE))
                            del _PALETTE_CACHE[oldest_key]
                        
                        _PALETTE_CACHE[path_str] = (mtime, palette)
                    except Exception:
                        pass
                    
                    return palette
        except Exception:
            pass
        
        return None

# ======================== Lifecycle ========================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 🔥 lifespan 시작 즉시 출력 (디버그용)
    print("=" * 80, flush=True)
    print("[LIFESPAN] ✅ lifespan 함수 진입!", flush=True)
    print("=" * 80, flush=True)
    
    # Startup
    
    # 🧹 Python 캐시 정리 (서버 시작 시)
    try:
        import glob
        cache_dirs = []
        cache_files = []
        for root, dirs, files in os.walk(Path(__file__).parent.parent):
            # __pycache__ 디렉토리 찾기
            if '__pycache__' in dirs:
                cache_dirs.append(os.path.join(root, '__pycache__'))
            # .pyc 파일 찾기
            for file in files:
                if file.endswith('.pyc'):
                    cache_files.append(os.path.join(root, file))
        
        # 캐시 삭제
        deleted_count = 0
        for cache_dir in cache_dirs:
            try:
                shutil.rmtree(cache_dir)
                deleted_count += 1
            except Exception:
                pass
        for cache_file in cache_files:
            try:
                os.remove(cache_file)
                deleted_count += 1
            except Exception:
                pass
        
        if deleted_count > 0:
            bootlog = logging.getLogger("uvicorn.error")
            bootlog.info(f"🧹 Python 캐시 정리 완료: {deleted_count}개 항목 삭제")
    except Exception:
        # 캐시 정리 실패해도 서버는 계속 실행
        pass
    
    bootlog = logging.getLogger("uvicorn.error")
    bootlog.info("🚀 L3Tracker 서버 시작 (테이블 로그 시스템)")
    scheme = "HTTPS" if config.SSL_ENABLED else "HTTP"
    port_to_log = config.HTTPS_PORT if config.SSL_ENABLED else config.DEFAULT_PORT
    bootlog.info(f"📍 호스트: {config.DEFAULT_HOST}")
    bootlog.info(f"🔌 포트: {port_to_log} ({scheme})")
    bootlog.info(f"📁 ROOT_DIR: {config.ROOT_DIR}")
    bootlog.info(f"🔧 PROJECT_ROOT: {os.getenv('PROJECT_ROOT', 'NOT SET')}")
    
    # 디버그 로그 제거 (초기 로드 시에만 필요하면 주석 해제)
    # bootlog.info(f"🔍 [STARTUP] current_folder: {current_folder}")
    # bootlog.info(f"🔍 [STARTUP] THUMBNAIL_DIR: {THUMBNAIL_DIR}")
    
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

    print("=" * 80, flush=True)
    print("[LIFESPAN] Starting lifespan context...", flush=True)
    print("=" * 80, flush=True)

    _classification_dir().mkdir(parents=True, exist_ok=True)
    _labels_load()
    global CLASSES_MTIME
    CLASSES_MTIME = _classes_stat_mtime()

    print("[INDEX] Cache load started...", flush=True)
    cache_start = time.time()
    try:
        cache_loaded = index_service.load_cache()
    except Exception as exc:
        bootlog.error(f"❌ [INDEX] 캐시 로드 중 오류: {exc}")
        print(f"[INDEX] Cache load failed: {exc}", flush=True)
        cache_loaded = False

    cache_duration = time.time() - cache_start
    if cache_loaded and index_service.keys:
        bootlog.info(f"📂 [INDEX] Cache load complete: {len(index_service.keys)} files ({cache_duration:.2f}s)")
        print(f"[INDEX] Cache load complete: {len(index_service.keys)} files ({cache_duration:.2f}s)", flush=True)
    else:
        bootlog.info("[INDEX] No cache found")
        print("[INDEX] No cache found", flush=True)

    index_action = "rebuild" if cache_loaded and index_service.keys else "build"
    bootlog.info(f"🔨 [INDEX] 인덱스 {index_action} 시작 (캐시 성공/실패와 무관하게 즉시 실행)")
    print(f"[INDEX] Starting index {index_action}...", flush=True)
    try:
        # 🔥 락 파일이 stale 상태일 수 있으므로 강제 삭제 시도
        if index_service.lock_file.exists():
            try:
                if index_service._lock_file_stale():
                    bootlog.warning(f"⚠️ [INDEX] Stale 락 파일 발견, 삭제 시도: {index_service.lock_file}")
                    index_service.lock_file.unlink(missing_ok=True)
            except Exception as lock_exc:
                bootlog.warning(f"⚠️ [INDEX] 락 파일 확인 실패: {lock_exc}")
        
        build_result = await index_service.build(force=True, allow_background=False)
        if not build_result:
            # 🔥 빌드가 False를 반환한 경우 (락 획득 실패 등)
            bootlog.error(f"❌ [INDEX] {index_action} 실패: build() 메서드가 False 반환 (락 획득 실패 또는 다른 프로세스가 빌드 중)")
            print(f"[INDEX] {index_action.capitalize()} failed: build() returned False", flush=True)
            # 락 파일을 다시 확인하고 강제 삭제 후 재시도
            if index_service.lock_file.exists():
                try:
                    index_service.lock_file.unlink(missing_ok=True)
                    bootlog.info(f"🔄 [INDEX] 락 파일 삭제 후 재시도")
                    build_result = await index_service.build(force=True, allow_background=False)
                    if not build_result:
                        bootlog.error(f"❌ [INDEX] 재시도 후에도 실패")
                except Exception as retry_exc:
                    bootlog.error(f"❌ [INDEX] 재시도 실패: {retry_exc}")
        else:
            # 🔥 인덱스 파일이 실제로 생성되었는지 확인
            cache_file = index_service.cache_file
            if cache_file.exists():
                file_size = cache_file.stat().st_size
                bootlog.info(
                    f"✅ [INDEX] 빌드 완료: files={index_service.total_files}, dirs={index_service.total_dirs}, cache_size={file_size:,} bytes"
                )
                print(
                    f"[INDEX] Build complete: files={index_service.total_files}, dirs={index_service.total_dirs}, cache_size={file_size:,} bytes",
                    flush=True,
                )
            else:
                bootlog.error(f"❌ [INDEX] 빌드 완료했지만 캐시 파일이 생성되지 않음: {cache_file}")
                print(f"[INDEX] Build complete but cache file not found: {cache_file}", flush=True)
    except Exception as exc:
        bootlog.error(f"❌ [INDEX] {index_action} 실패: {exc}", exc_info=True)
        print(f"[INDEX] {index_action.capitalize()} failed: {exc}", flush=True)

    if INDEX_REFRESH_INTERVAL_SECONDS > 0:
        interval_minutes = INDEX_REFRESH_INTERVAL_SECONDS // 60 or 1
        bootlog.info(f"🔁 [INDEX] 자동 재빌드 주기: {interval_minutes}분 (첫 재빌드는 즉시 실행)")
        await index_service.start_refresh_loop(INDEX_REFRESH_INTERVAL_SECONDS)
        bootlog.info(f"✅ [INDEX] 자동 재빌드 루프 시작됨 (매 {interval_minutes}분마다 실행)")
    else:
        bootlog.warning("⚠️ [INDEX] 자동 재빌드가 비활성화됨 (INDEX_REFRESH_INTERVAL_MINUTES=0)")

    yield  # 앱 실행 중

    # Shutdown
    logging.getLogger("uvicorn.error").info("🛑 L3Tracker 서버 종료")

    await index_service.stop_refresh_loop()

    try:
        THUMBNAIL_EXECUTOR.shutdown(wait=False, cancel_futures=False)
    except Exception:
        pass
    try:
        DIRLIST_EXECUTOR.shutdown(wait=False, cancel_futures=False)
    except Exception:
        pass

# ======================== FastAPI & Middleware ========================
app = FastAPI(title="L3Tracker API", version="2.6.0", lifespan=lifespan)


# ======================== 🔥 Startup Event (lifespan 백업) ========================
# lifespan이 호출되지 않는 경우를 대비한 백업 startup 이벤트
@app.on_event("startup")
async def startup_event():
    """lifespan이 호출되지 않는 경우를 대비한 백업 startup 이벤트"""
    global INDEX_REFRESH_INTERVAL_SECONDS
    
    print("=" * 80, flush=True)
    print("[STARTUP EVENT] ✅ on_event('startup') 실행됨!", flush=True)
    print("=" * 80, flush=True)
    
    bootlog = logging.getLogger("uvicorn.error")
    
    # 인덱스가 이미 준비되었는지 확인 (lifespan에서 이미 처리된 경우)
    if index_service.ready and index_service.keys:
        bootlog.info(f"ℹ️ [STARTUP] 인덱스 이미 준비됨 (lifespan에서 처리): {len(index_service.keys)}개 파일")
        print(f"[STARTUP] Index already ready: {len(index_service.keys)} files", flush=True)
        return
    
    # 🔥 캐시 로드는 즉시 실행 (빠름)
    cache_start = time.time()
    try:
        cache_loaded = index_service.load_cache()
        cache_duration = time.time() - cache_start
        if cache_loaded and index_service.keys:
            bootlog.info(f"📂 [STARTUP] Cache load complete: {len(index_service.keys)} files ({cache_duration:.2f}s)")
            print(f"[STARTUP] Cache load complete: {len(index_service.keys)} files ({cache_duration:.2f}s)", flush=True)
        else:
            bootlog.info("[STARTUP] No cache found")
            print("[STARTUP] No cache found", flush=True)
    except Exception as exc:
        bootlog.warning(f"⚠️ [STARTUP] Cache load failed: {exc}")
        cache_loaded = False
    
    # 🔥 인덱스 빌드는 백그라운드에서 비동기 실행 (서버 시작 블로킹 방지)
    asyncio.create_task(_background_index_build())
    bootlog.info("🚀 [STARTUP] 인덱스 빌드가 백그라운드에서 시작됨 (서버는 즉시 사용 가능)")
    print("[STARTUP] Index build started in background (server ready)", flush=True)
    
    # 🔥 자동 재빌드 루프도 백그라운드에서 시작
    if INDEX_REFRESH_INTERVAL_SECONDS > 0:
        interval_minutes = INDEX_REFRESH_INTERVAL_SECONDS // 60 or 1
        bootlog.info(f"🔁 [STARTUP] 자동 재빌드 주기: {interval_minutes}분")
        await index_service.start_refresh_loop(INDEX_REFRESH_INTERVAL_SECONDS)


async def _background_index_build():
    """백그라운드에서 인덱스 빌드 실행"""
    bootlog = logging.getLogger("uvicorn.error")
    build_start = time.time()
    try:
        print("[INDEX] Background build started...", flush=True)
        bootlog.info("🔨 [INDEX] Background build started")
        
        build_result = await index_service.build(force=True, allow_background=False)
        build_duration = time.time() - build_start
        
        if build_result:
            cache_file = index_service.cache_file
            if cache_file.exists():
                file_size = cache_file.stat().st_size
                bootlog.info(
                    f"✅ [INDEX] Background build complete: {index_service.total_files} files ({build_duration:.2f}s)"
                )
                print(f"[INDEX] Background build complete: {index_service.total_files} files ({build_duration:.2f}s)", flush=True)
            else:
                bootlog.error(f"❌ [INDEX] 캐시 파일이 생성되지 않음: {cache_file}")
        else:
            bootlog.warning("⚠️ [INDEX] 백그라운드 빌드 실패 (락 획득 실패 또는 이미 진행 중)")
    except Exception as exc:
        bootlog.error(f"❌ [INDEX] 백그라운드 빌드 오류: {exc}", exc_info=True)
        print(f"[INDEX] Background build failed: {exc}", flush=True)


@app.on_event("shutdown")
async def shutdown_event():
    """서버 종료 시 정리"""
    print("[SHUTDOWN EVENT] 서버 종료 중...", flush=True)
    await index_service.stop_refresh_loop()


# ======================== SAML SSO (OneLogin python3-saml) ========================
SAML_DIR = Path("saml")
AUTO_LOGIN = os.getenv("AUTO_LOGIN", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
DEFAULT_ORG_URL = os.getenv("DEFAULT_ORG_URL", "")
# NOTE: 내부 단독 사용 전제. dev-login, /logs 노출 등은 의도적으로 유지하며 외부 공개 환경에서는 사용 금지.

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
    """SAML 인증 객체 생성
    
    OneLogin_Saml2_Auth가 None인 경우에만 '미설치' 오류 발생
    """
    if OneLogin_Saml2_Auth is None:
        raise HTTPException(
            status_code=500, 
            detail="python3-saml 라이브러리가 설치되지 않았습니다. pip install python3-saml 실행 필요"
        )
    return OneLogin_Saml2_Auth(_prepare_fastapi_request(req), custom_base_path=str(SAML_DIR))

@app.get("/saml/metadata")
async def saml_metadata():
    try:
        if OneLogin_Saml2_Settings is None:
            return PlainTextResponse(
                "python3-saml 라이브러리가 설치되지 않았습니다. pip install python3-saml 실행 필요",
                status_code=500
            )
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
    """SAML 로그인 시작 (AUTO_LOGIN=True일 때 자동 리다이렉트)"""
    try:
        logger.info("=" * 100)
        logger.info(f"🔐 [SAML LOGIN] 요청 시작")
        logger.info(f"  - Full URL: {request.url}")
        logger.info(f"  - Scheme: {request.url.scheme}")
        logger.info(f"  - Hostname: {request.url.hostname}")
        logger.info(f"  - Port: {request.url.port}")
        logger.info(f"  - Path: {request.url.path}")
        logger.info(f"  - Method: {request.method}")
        logger.info(f"  - Client: {request.client}")
        logger.info(f"  - AUTO_LOGIN: {AUTO_LOGIN}")
        logger.info("=" * 100)
        
        auth = _saml_auth(request)
        org_url = request.query_params.get("org_url")
        
        # 🔥 RelayState를 명시적으로 '/'로 설정 (어제 코드와 동일)
        logger.info("=" * 100)
        logger.info(f"🔐 [SAML LOGIN] OneLogin auth.login() 호출 시작")
        logger.info(f"  - return_to: /")
        logger.info(f"  - org_url: {org_url}")
        logger.info(f"  - request.url: {request.url}")
        logger.info(f"  - request.url.port: {request.url.port}")
        logger.info(f"  - request.url.hostname: {request.url.hostname}")
        logger.info("=" * 100)
        
        try:
            idp_login_url = auth.login(return_to='/')
            logger.info("=" * 100)
            logger.info(f"🔐 [SAML LOGIN] OneLogin auth.login() 호출 완료")
            logger.info(f"  - IdP SSO URL: {idp_login_url}")
            logger.info(f"  - RelayState: / (명시적 설정)")
            logger.info("=" * 100)
        except Exception as e:
            logger.error("=" * 100)
            logger.error(f"❌ [SAML LOGIN] OneLogin auth.login() 호출 실패")
            logger.error(f"  - Error: {e}")
            logger.error(f"  - Error type: {type(e)}")
            import traceback
            logger.error(f"  - Traceback: {traceback.format_exc()}")
            logger.error("=" * 100)
            raise
        
        # SAMLRequest 파라미터 추출 및 디코딩
        try:
            from urllib.parse import urlparse, parse_qs
            import base64
            import zlib
            
            parsed = urlparse(idp_login_url)
            params = parse_qs(parsed.query)
            
            if 'SAMLRequest' in params:
                saml_request_encoded = params['SAMLRequest'][0]
                logger.info(f"🔑 [SAML REQUEST] Encoded (처음 100자):")
                logger.info(f"  {saml_request_encoded[:100]}...")
                
                # Base64 디코딩 후 압축 해제
                try:
                    decoded = base64.b64decode(saml_request_encoded)
                    decompressed = zlib.decompress(decoded, -zlib.MAX_WBITS)
                    xml_content = decompressed.decode('utf-8')
                    logger.info(f"🔑 [SAML REQUEST] Decoded XML (전체):")
                    for line in xml_content.split('\n'):
                        logger.info(f"  {line}")
                except Exception as decode_err:
                    logger.warning(f"⚠️ [SAML REQUEST] 디코딩 실패: {decode_err}")
            
            if 'RelayState' in params:
                logger.info(f"📌 [RELAY STATE] {params['RelayState'][0]}")
                
        except Exception as e:
            logger.warning(f"⚠️ [SAML REQUEST] 파싱 실패: {e}")
        
        resp = RedirectResponse(idp_login_url)
        # 쿠키 사용 안 함 - org_url은 SAML 응답에서 처리
        
        logger.info(f"✅ [SAML LOGIN] 리다이렉트 응답 반환")
        return resp
    except Exception as e:
        logger.exception(f"❌ [SAML LOGIN ERROR] 로그인 처리 실패: {e}")
        return PlainTextResponse(f"SAML 로그인 실패: {str(e)}", status_code=500)

@app.post("/saml/acs")
async def saml_acs(request: Request):
    """SAML ACS (Assertion Consumer Service) 콜백"""
    logger.info("=" * 100)
    logger.info(f"📥 [SAML ACS] 요청 수신")
    logger.info(f"  - Full URL: {request.url}")
    logger.info(f"  - Scheme: {request.url.scheme}")
    logger.info(f"  - Hostname: {request.url.hostname}")
    logger.info(f"  - Port: {request.url.port}")
    logger.info(f"  - Path: {request.url.path}")
    logger.info(f"  - Method: {request.method}")
    logger.info(f"  - Client: {request.client}")
    logger.info(f"  - Headers:")
    for key, value in request.headers.items():
        logger.info(f"    {key}: {value}")
    logger.info("=" * 100)
    
    if OneLogin_Saml2_Auth is None:
        return PlainTextResponse(
            "python3-saml 라이브러리가 설치되지 않았습니다. pip install python3-saml 실행 필요",
            status_code=500
        )
    form = dict(await request.form())
    logger.info(f"📋 [SAML ACS] Form 데이터 수신: {list(form.keys())}")
    
    # SAMLResponse 디코딩
    if 'SAMLResponse' in form:
        try:
            import base64
            saml_response_encoded = form['SAMLResponse']
            logger.info(f"🔑 [SAML RESPONSE] Encoded (처음 100자):")
            logger.info(f"  {saml_response_encoded[:100]}...")
            
            # Base64 디코딩
            decoded = base64.b64decode(saml_response_encoded)
            xml_content = decoded.decode('utf-8')
            logger.info(f"🔑 [SAML RESPONSE] Decoded XML (전체):")
            for line in xml_content.split('\n'):
                logger.info(f"  {line}")
        except Exception as e:
            logger.warning(f"⚠️ [SAML RESPONSE] 디코딩 실패: {e}")
    
    if 'RelayState' in form:
        logger.info(f"📌 [RELAY STATE] {form['RelayState']}")
    
    req_dict = _prepare_fastapi_request(request)
    req_dict["post_data"] = form
    auth = OneLogin_Saml2_Auth(req_dict, custom_base_path=str(SAML_DIR))

    try:
        auth.process_response()
        errors = auth.get_errors()
    except Exception as e:
        logger.warning(f"🚫 [SAML ACS] 처리 예외: {e}")
        # 예외 발생 시 바로 차단
        return PlainTextResponse("ACS error: exception during processing", status_code=400)

    # SAML 속성 추출 - 원본 claim 이름 유지 (인증 체크 전에 먼저 추출)
    attrs = auth.get_attributes() or {}
    
    # 7개 허용 필드 추출 (URL prefix 제거)
    def pick_first(key):
        # 정확한 키로 먼저 시도
        v = attrs.get(key)
        if v:
            if isinstance(v, list):
                return v[0] if v else None
            return v
        
        # URL이 붙은 경우 찾기 (예: "http://schemas.company.com/claims/LoginId")
        for attr_key in attrs.keys():
            # "/" 또는 "#"으로 split해서 마지막 부분이 매칭되는지 확인
            if '/' in attr_key or '#' in attr_key:
                last_part = attr_key.split('/')[-1].split('#')[-1]
                if last_part == key:
                    v = attrs[attr_key]
                    if isinstance(v, list):
                        return v[0] if v else None
                    return v
        return None
    
    meta = {}
    for field in ("Username", "LoginId", "Sabun", "DeptName", "GrdName_EN", "GrdName", "x-ms-forwarded-client-ip"):
        val = pick_first(field)
        if val:
            meta[field] = val
    
    # 🔥 LoginId 추출 및 즉시 체크
    LoginId = meta.get("LoginId")
    
    logger.info("=" * 100)
    logger.info(f"🔐 [LoginId 체크] LoginId 추출 및 즉시 체크")
    logger.info(f"  - LoginId: {LoginId}")
    logger.info(f"  - meta: {meta}")
    logger.info("=" * 100)
    
    # LoginId 없으면 IdP SSO로 리다이렉트 (접속 차단)
    if not LoginId:
        logger.error(f"🚫 [SAML FAIL] LoginId 없음 → IdP SSO로 리다이렉트 (접속 차단)")
        base_settings, _ = _load_saml_files()
        idp_sso_url = base_settings.get("idp", {}).get("singleSignOnService", {}).get("url")
        
        if idp_sso_url:
            logger.info(f"  → IdP SSO로 리다이렉트 (접속 차단): {idp_sso_url}")
            return RedirectResponse(idp_sso_url, status_code=302)
        else:
            return PlainTextResponse(
                f"SAML 인증 실패\n\n오류: LoginId not found\n상세: SAML 응답에 LoginId attribute가 없습니다.\n\n관리자에게 문의하세요.",
                status_code=400
            )
    
    logger.info(f"✅ [LoginId 확인] LoginId 존재 → SAML 로그인 성공")
    
    # 로그 출력
    bootlog = logging.getLogger("uvicorn.error")
    bootlog.info("=" * 100)
    bootlog.info("[SAML LOGIN SUCCESS] 로그인 성공")
    bootlog.info("-" * 100)
    bootlog.info(f"✅ [FINAL] LoginId: {LoginId}")
    bootlog.info("-" * 100)
    bootlog.info("[SAML ATTRIBUTES] 수신된 속성 (Key → Value):")
    
    if attrs:
        for key in sorted(attrs.keys()):
            value = attrs[key]
            value_str = str(value)
            if len(value_str) > 100:
                value_str = value_str[:97] + "..."
            
            # URL prefix 제거하고 짧게 표시
            display_key = key
            if '/' in key or '#' in key:
                display_key = key.split('/')[-1].split('#')[-1]
            
            bootlog.info(f"  {display_key:30s} → {value_str}")
    else:
        bootlog.info("  (속성 없음)")
    
    bootlog.info(f"🔍 [EXTRACTED META] 추출된 필드: {list(meta.keys())}")
    bootlog.info("=" * 100)
    
    # detail_access.csv에 상세 기록 (SAML 속성 추출 직후)
    try:
        client_ip = logger_instance.get_client_ip(request)
        bootlog.info(f"🔄 [DETAIL ACCESS] CSV 기록 시작 - meta: {meta}")
        result = detail_access_logger.log_saml_access(meta, client_ip)
        bootlog.info(f"✅ [DETAIL ACCESS] CSV 기록 완료 - 결과: {result}")
    except Exception as e:
        bootlog.error(f"❌ [DETAIL ACCESS] CSV 기록 실패: {e}")
        import traceback
        bootlog.error(f"❌ [DETAIL ACCESS] 에러 상세: {traceback.format_exc()}")

    # 🔥 SAML 로그인 성공 시 IP로 로그인한 기록 삭제 및 SAML 로그 직접 기록 (LoginId 기준)
    # ⚠️ 중요: stats.json 업데이트는 SAML 인증 확인 후에만 수행
    try:
        import time
        client_ip = logger_instance.get_client_ip(request)
        
        if client_ip and LoginId:
            # 🔥 IP 기록 삭제 제거: 멀티워커 환경에서 유저 정보 보존을 위해 삭제하지 않음

            # ① SAML 인증 시간 추가
            meta["last_saml_auth_time"] = time.time()
            
            # ③ SAML 로그인 정보로 직접 통계 업데이트 (중복 방지)
            bootlog.info(f"🔄 [SAML LOG] SAML 로그인 직접 기록: {LoginId}")
            bootlog.info(f"🔍 [SAML LOG DEBUG] meta 내용: {meta}")
            bootlog.info(f"🔍 [SAML LOG DEBUG] client_ip: {client_ip}")
            bootlog.info(f"🔍 [SAML LOG DEBUG] last_saml_auth_time: {meta['last_saml_auth_time']}")
            
            logger_instance._update_stats(
                ip=client_ip,
                endpoint="/saml/acs",  # SAML ACS로 기록 (리다이렉트 후 / 중복 방지)
                method="POST",
                user_id_override=LoginId,  # LoginId 사용 (SAML claim에서만)
                meta=meta  # SAML 메타 정보 전달 (last_saml_auth_time 포함)
            )
            bootlog.info(f"✅ [SAML LOG] SAML 로그 기록 완료")
    except Exception as e:
        bootlog.warning(f"⚠️ [SAML LOG] SAML 로그 기록 실패: {e}")
    
    # 🔥 SAML 로그인 성공 - 서버 메모리에 사용자 정보 저장 (LoginId 기준)
    try:
        # SAML 속성들을 metadata에 포함하여 저장
        meta["saml_attributes"] = attrs
        # LoginId 기준으로 저장
        SAML_USER_SESSIONS[LoginId] = meta
        
        # 🔥 SAML 로그인 직후 color scheme 생성 (LoginId, Username, DeptName)
        try:
            username = meta.get("Username", "")
            dept_name = meta.get("DeptName", "")
            get_user_color_scheme(LoginId, username if username else None, dept_name if dept_name else None)
            bootlog.info(f"✅ [SAML LOGIN] Color scheme 생성 완료: LoginId={LoginId}, Username={username}, DeptName={dept_name}")
        except Exception as e:
            bootlog.warning(f"⚠️ [SAML LOGIN] Color scheme 생성 실패: {e}")
    except Exception as e:
        bootlog.error(f"❌ [SAML SESSION] 사용자 정보 저장 실패: {e}")
    
    # 🔥 SAML 로그인 성공 - URL 파라미터로 사용자 정보 전달
    Username = meta.get("Username", "")
    DeptName = meta.get("DeptName", "")
    Sabun = meta.get("Sabun", "")  # 로그용으로만 사용

    redirect_url = f"/?saml_success=true&LoginId={LoginId}&Username={Username}&DeptName={DeptName}"

    bootlog.info("=" * 100)
    bootlog.info(f"✅ [SAML LOGIN] 로그인 성공 - LoginId={LoginId}, Username={Username}, Sabun={Sabun}, DeptName={DeptName}")
    bootlog.info(f"✅ [SAML LOGIN] Redirect to: {redirect_url}")
    bootlog.info("=" * 100)
    
    log_access_row(tag="INFO", path="/saml/acs", method="POST", status=302, note=f"SAML 로그인: {LoginId}")
    return RedirectResponse(redirect_url, status_code=302)

@app.get("/saml/dev-login")
async def saml_dev_login(request: Request):
    """개발 모드 간편 로그인: ?user=이메일(또는 임의값)
    AUTO_LOGIN=0일 때만 허용.
    """
    # NOTE: 내부 테스트용으로 개방 유지. 외부 서비스에서는 비활성화/삭제 필요.
    if AUTO_LOGIN:
        return PlainTextResponse("AUTO_LOGIN 활성화 - SAML 로그인 필요", status_code=403)
    # 우선순위: user → (account@pc) → dev-user
    user = request.query_params.get("user") or request.query_params.get("email")
    account = request.query_params.get("account")
    pc = request.query_params.get("pc")

    if not user:
        if account:
            user = f"{account}@{pc or 'unknown'}"
        else:
            user = "dev-user"
    
    client_ip = logger_instance.get_client_ip(request)

    # 메타데이터를 별도 쿠키에 JSON으로 저장 (7개 허용 필드만 사용)
    meta = {
        "LoginId": request.query_params.get("LoginId") or account,
        "Username": request.query_params.get("Username"),
        "Sabun": request.query_params.get("Sabun"),
        "DeptName": request.query_params.get("DeptName") or request.query_params.get("department") or request.query_params.get("dept"),
        "GrdName": request.query_params.get("GrdName") or request.query_params.get("title"),
        "GrdName_EN": request.query_params.get("GrdName_EN"),
        "x-ms-forwarded-client-ip": request.headers.get("x-ms-forwarded-client-ip") or request.headers.get("x-forwarded-for"),
    }
    # None 제거
    meta = {k: v for k, v in meta.items() if v}
    
    # 개발 모드용 SAML 속성 시뮬레이션
    meta["saml_attributes"] = {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": user,
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": user,
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/role": "User",
        "LoginId": meta.get("LoginId", ""),
        "Username": meta.get("Username", ""),
        "DeptName": meta.get("DeptName", ""),
        "GrdName": meta.get("GrdName", ""),
        "GrdName_EN": meta.get("GrdName_EN", ""),
        "Sabun": meta.get("Sabun", ""),
    }

    # 🔥 개발 모드 로그인 - 서버 메모리에 사용자 정보 저장 (LoginId 기준)
    try:
        LoginId = meta.get("LoginId", "")
        if LoginId:
            # LoginId 기준으로 저장
            SAML_USER_SESSIONS[LoginId] = meta
            
            # 🔥 개발 모드 로그인 직후 color scheme 생성 (LoginId, Username, DeptName)
            try:
                username = meta.get("Username", "")
                dept_name = meta.get("DeptName", "")
                get_user_color_scheme(LoginId, username if username else None, dept_name if dept_name else None)
                logger.info(f"✅ [DEV LOGIN] Color scheme 생성 완료: LoginId={LoginId}, Username={username}, DeptName={dept_name}")
            except Exception as e:
                logger.warning(f"⚠️ [DEV LOGIN] Color scheme 생성 실패: {e}")
        else:
            logger.warning(f"⚠️ [DEV SESSION] LoginId가 없어서 저장하지 않음")
    except Exception as e:
        logger.error(f"❌ [DEV SESSION] 사용자 정보 저장 실패: {e}")
    
    # 🔥 개발 모드 로그인 - URL 파라미터로 사용자 정보 전달
    LoginId = meta.get("LoginId", "")
    Username = meta.get("Username", "")
    DeptName = meta.get("DeptName", "")
    Sabun = meta.get("Sabun", "")  # 로그용으로만 사용

    redirect_url = f"/?dev_success=true&LoginId={LoginId}&Username={Username}&DeptName={DeptName}"

    logger.info(f"✅ [DEV LOGIN] 개발 모드 로그인 성공 - LoginId={LoginId}, Username={Username}, Sabun={Sabun}, DeptName={DeptName}")
    logger.info(f"✅ [DEV LOGIN] Redirect to: {redirect_url}")
    
    # detail_access.csv에도 개발 모드 로그인 기록
    try:
        logger.info(f"🔄 [DEV DETAIL ACCESS] CSV 기록 시작 - meta: {meta}")
        result = detail_access_logger.log_saml_access(meta, client_ip)
        logger.info(f"✅ [DEV DETAIL ACCESS] CSV 기록 완료 - 결과: {result}")
    except Exception as e:
        logger.error(f"❌ [DEV DETAIL ACCESS] CSV 기록 실패: {e}")
        import traceback
        logger.error(f"❌ [DEV DETAIL ACCESS] 에러 상세: {traceback.format_exc()}")
    
    log_access_row(tag="INFO", path="/saml/dev-login", method="GET", status=302, note=f"DEV 로그인: {user}")
    return RedirectResponse(redirect_url, status_code=302)

# ===== 계정 확인용 간단 API =====
@app.get("/api/config")
async def api_config():
    """프론트엔드 설정 API (AUTO_LOGIN 등)"""
    return {
        "AUTO_LOGIN": AUTO_LOGIN,
        "DEFAULT_ORG_URL": DEFAULT_ORG_URL,
        "PYRAMID_LEVELS": config.PYRAMID_LEVELS,
        "PYRAMID_ZOOM_THRESHOLDS": config.PYRAMID_ZOOM_THRESHOLDS,
        "THUMB_BATCH_SIZE": config.THUMB_PREFETCH_BATCH,
        "THUMB_MAX_CONCURRENCY": config.THUMB_CLIENT_MAX_CONCURRENCY
    }

# 🔥 서버 메모리에 SAML 로그인 정보 저장
SAML_USER_SESSIONS = {}  # {LoginId: user_info}
# NOTE: 만료/검증 없이 유지되므로 내부 전용. 외부 노출 시 TTL/서명 검증 추가 필요.

@app.get("/api/auth/user")
async def api_auth_user(request: Request, LoginId: Optional[str] = None):
    """현재 사용자 정보 반환 - 서버 메모리에서 SAML 로그인 정보 확인"""
    # NOTE: 쿼리 파라미터/쿠키를 신뢰하는 간단한 경로. 외부 서비스에서는 세션 검증을 붙여야 함.
    try:
        # LoginId가 제공된 경우 해당 사용자 정보 조회
        if LoginId and LoginId in SAML_USER_SESSIONS:
            user_info = SAML_USER_SESSIONS[LoginId]
            
            # SAML 속성들을 프론트엔드로 전달
            saml_attributes = user_info.get("saml_attributes", {})
            
            # 🔥 보안: Sabun은 프론트엔드로 전달하지 않음 (미사용 필드)
            login_id = user_info.get("LoginId", "")
            username = user_info.get("Username", "")
            dept_name = user_info.get("DeptName", "")
            # 개인색 설정을 위한 color scheme 결정 (LoginId, Username, DeptName 모두 scheme 생성)
            color_scheme = get_user_color_scheme(login_id, username, dept_name) if login_id else None

            return {
                "authenticated": True,
                "LoginId": login_id,
                "Username": user_info.get("Username", ""),
                "DeptName": user_info.get("DeptName", ""),
                "GrdName_EN": user_info.get("GrdName_EN", ""),
                "GrdName": user_info.get("GrdName", ""),
                "metadata": user_info.get("metadata", {}),
                "saml_attributes": saml_attributes,  # 🔥 SAML 속성들을 프론트엔드로 전달
                "colorScheme": color_scheme  # 🎨 개인색 scheme
            }

        # LoginId가 없으면 'change' scheme 반환
        return {
            "authenticated": False,
            "LoginId": None,
            "Username": "",
            "DeptName": "",
            "GrdName_EN": "",
            "GrdName": "",
            "metadata": {},
            "saml_attributes": {},
            "colorScheme": "change"  # 🎨 LoginId가 없으면 change scheme
        }
        
    except Exception as e:
        logger.error(f"❌ [API /auth/user] 오류 발생: {e}")
        # 오류 발생 시 빈 인증 정보 반환 (LoginId 없으면 change scheme)
        return {
            "authenticated": False,
            "LoginId": None,
            "Username": "",
            "DeptName": "",
            "GrdName_EN": "",
            "GrdName": "",
            "metadata": {},
            "saml_attributes": {},
            "colorScheme": "change"  # 🎨 LoginId가 없으면 change scheme
        }


# ===== 색상 스킴 저장 API =====
@app.post("/api/color-scheme")
async def save_color_scheme(request: Request):
    """색상 스킴 저장"""
    try:
        data = await request.json()
        scheme_name = data.get('schemeName')
        scheme_data = data.get('schemeData')
        
        if not scheme_name:
            raise HTTPException(status_code=400, detail="schemeName이 필요합니다")
        if not scheme_data:
            raise HTTPException(status_code=400, detail="schemeData가 필요합니다")
        
        # 기존 legends 로드
        legends = load_color_legends()
        
        # 새로운 스킴 데이터 저장
        # 색상 편집에는 top, bottom, background, text만 사용 (다른 필드 제거)
        filtered_scheme_data = {
            'top': scheme_data.get('top', {}),
            'bottom': scheme_data.get('bottom', {}),
            'background': scheme_data.get('background', '#FEFEFE'),
            'text': scheme_data.get('text', '#000001')
        }
        
        # 기존 scheme의 메타데이터 유지 (Username, DeptName, lastModified 등)
        existing_scheme = legends.get(scheme_name, {})
        if 'Username' in existing_scheme:
            filtered_scheme_data['Username'] = existing_scheme['Username']
        if 'DeptName' in existing_scheme:
            filtered_scheme_data['DeptName'] = existing_scheme['DeptName']
        
        # default scheme과 비교하여 modified 설정
        # 색상 값 정규화 후 비교 (대소문자 무시)
        from .personal_colors import normalize_hex_color
        
        default_scheme = legends.get('default', {})
        
        def normalize_color_dict(color_dict):
            """색상 딕셔너리의 모든 색상 값을 정규화"""
            if not color_dict or not isinstance(color_dict, dict):
                return color_dict
            normalized = {}
            for key, value in color_dict.items():
                if isinstance(value, str) and value.startswith('#'):
                    try:
                        normalized[key] = normalize_hex_color(value)
                    except (ValueError, AttributeError):
                        normalized[key] = value.upper() if value else value
                else:
                    normalized[key] = value
            return normalized
        
        def normalize_single_color(color):
            """단일 색상 값 정규화"""
            if isinstance(color, str) and color.startswith('#'):
                try:
                    return normalize_hex_color(color)
                except (ValueError, AttributeError):
                    return color.upper() if color else color
            return color
        
        # 색상 값 정규화 후 비교
        normalized_scheme = {
            'top': normalize_color_dict(filtered_scheme_data.get('top')),
            'bottom': normalize_color_dict(filtered_scheme_data.get('bottom')),
            'background': normalize_single_color(filtered_scheme_data.get('background')),
            'text': normalize_single_color(filtered_scheme_data.get('text'))
        }
        
        normalized_default = {
            'top': normalize_color_dict(default_scheme.get('top')),
            'bottom': normalize_color_dict(default_scheme.get('bottom')),
            'background': normalize_single_color(default_scheme.get('background')),
            'text': normalize_single_color(default_scheme.get('text'))
        }
        
        is_same_as_default = (
            normalized_scheme.get('top') == normalized_default.get('top') and
            normalized_scheme.get('bottom') == normalized_default.get('bottom') and
            normalized_scheme.get('background') == normalized_default.get('background') and
            normalized_scheme.get('text') == normalized_default.get('text')
        )
        
        # default와 같으면 modified: false, 다르면 modified: true
        filtered_scheme_data['modified'] = not is_same_as_default
        
        legends[scheme_name] = filtered_scheme_data
        
        # 파일에 저장 (마지막 수정 시간 추가)
        if save_color_legends(legends, updated_scheme_name=scheme_name):
            # 디버그 로그 제거 (너무 자주 출력됨)
            # logger.info(f"✅ Color scheme saved: {scheme_name}")
            
            # 🔥 색상 편집 저장 후 해당 scheme의 썸네일 및 피라미드 캐시 무효화
            # scheme별 폴더 전체 삭제 (예: thumbnail/LoginId_251106_091612/)
            try:
                deleted_count = 0
                import shutil
                
                # 1. scheme 폴더 전체 삭제 (thumbnail/{scheme}/ 형태)
                scheme_dir = THUMBNAIL_DIR / scheme_name
                if scheme_dir.exists() and scheme_dir.is_dir():
                    try:
                        shutil.rmtree(scheme_dir)
                        deleted_count += 1
                        # 디버그 로그 제거
                        # logger.info(f"✅ scheme 폴더 삭제: {scheme_dir}")
                    except Exception as e:
                        logger.warning(f"scheme 폴더 삭제 실패: {scheme_dir}, 오류: {e}")
                
                # 하위 호환성: 기존 scheme_timestamp 형태도 삭제
                old_pattern = f"{scheme_name}_*"
                for old_dir in THUMBNAIL_DIR.glob(old_pattern):
                    if old_dir.is_dir():
                        try:
                            shutil.rmtree(old_dir)
                            deleted_count += 1
                            # 디버그 로그 제거
                            # logger.info(f"✅ 기존 scheme 폴더 삭제: {old_dir}")
                        except Exception as e:
                            logger.warning(f"기존 scheme 폴더 삭제 실패: {old_dir}, 오류: {e}")
                
                # 2. 기존 방식 썸네일 파일 삭제 (하위 호환성: scheme 이름이 파일명에 포함된 경우)
                scheme_pattern = f"*_{scheme_name}_*.{THUMBNAIL_FORMAT.lower()}"
                for thumb_file in THUMBNAIL_DIR.glob(scheme_pattern):
                    try:
                        thumb_file.unlink()
                        deleted_count += 1
                    except Exception as e:
                        logger.warning(f"썸네일 삭제 실패: {thumb_file}, 오류: {e}")
                
                # 3. 기존 방식 피라미드 디렉토리 삭제 (하위 호환성)
                pyramid_pattern = f"pyramid_{scheme_name}_*"
                for pyramid_dir in THUMBNAIL_DIR.glob(pyramid_pattern):
                    if pyramid_dir.is_dir():
                        try:
                            shutil.rmtree(pyramid_dir)
                            deleted_count += 1
                            logger.debug(f"피라미드 디렉토리 삭제: {pyramid_dir}")
                        except Exception as e:
                            logger.warning(f"피라미드 디렉토리 삭제 실패: {pyramid_dir}, 오류: {e}")
                
                # 4. 메모리 캐시 초기화 (cache_manager가 있으면 사용)
                try:
                    from .cache_manager import cache_manager
                    cache_manager.clear_thumbnail_cache()
                except ImportError:
                    # cache_manager가 없으면 무시 (선택적 기능)
                    pass
                except Exception as e:
                    logger.warning(f"메모리 캐시 초기화 실패: {e}")
                
                # 디버그 로그 제거 (너무 자주 출력됨)
                # logger.info(f"✅ 캐시 무효화 완료: {scheme_name} ({deleted_count}개 항목 삭제)")
            except Exception as e:
                logger.warning(f"⚠️ 캐시 무효화 실패: {e}")
            
            return {"success": True, "schemeName": scheme_name}
        else:
            raise HTTPException(status_code=500, detail="색상 스킴 저장 실패")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ [API /api/color-scheme] 오류 발생: {e}")
        raise HTTPException(status_code=500, detail=f"색상 스킴 저장 중 오류: {str(e)}")


# ===== 사내 ADFS/STS 헬스 체크 (핑) =====


# ===== Composite 색상 편집 API =====
@app.get("/api/composite-colors")
async def get_composite_colors(request: Request):
    try:
        login_id = _current_login_id(request)
        scheme = get_user_color_scheme(login_id) if login_id else "change"
        settings = load_composite_color_settings(scheme)
        return settings.to_dict()
    except Exception as exc:
        logger.error(f"❌ [/api/composite-colors] 조회 실패: {exc}")
        raise HTTPException(status_code=500, detail="Composite 색상 정보를 불러오지 못했습니다.")


@app.post("/api/composite-colors")
async def save_composite_colors_endpoint(request: Request):
    try:
        payload = await request.json()
        colors = payload.get("colors")
        if not isinstance(colors, list) or not colors:
            raise HTTPException(status_code=400, detail="colors 배열이 필요합니다.")
        login_id = _current_login_id(request)
        scheme = get_user_color_scheme(login_id) if login_id else "change"
        settings = save_composite_color_settings(colors, scheme)
        return settings.to_dict()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"❌ [/api/composite-colors] 저장 실패: {exc}")
        raise HTTPException(status_code=500, detail="Composite 색상을 저장하지 못했습니다.")


@app.post("/api/composite-recolor")
async def recolor_composite_sum_maps_endpoint(request: Request):
    if not HAS_NUMPY:
        raise HTTPException(status_code=500, detail="numpy가 필요합니다. 서버 설정을 확인해주세요.")
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON 본문을 파싱하지 못했습니다.")

    rel_output_dir = (payload or {}).get("output_dir")
    if not rel_output_dir:
        raise HTTPException(status_code=400, detail="output_dir 값이 필요합니다.")
    override_colors = payload.get("colors") if isinstance(payload, dict) else None
    if override_colors is not None and not isinstance(override_colors, list):
        raise HTTPException(status_code=400, detail="colors 필드는 배열이어야 합니다.")

    normalized_rel = str(rel_output_dir).strip().replace("\\", "/")
    target_path = (IMAGES_ROOT / normalized_rel).resolve()
    composite_root = COMPOSITE_ROOT.resolve()
    if not str(target_path).startswith(str(composite_root)):
        raise HTTPException(status_code=400, detail="유효한 Composite 출력 디렉터리가 아닙니다.")
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="Composite 출력 디렉터리를 찾을 수 없습니다.")

    try:
        login_id = _current_login_id(request)
        scheme = get_user_color_scheme(login_id) if login_id else "change"
        from .composite_map import recolor_saved_sum_maps

        entries = recolor_saved_sum_maps(target_path, override_colors=override_colors, scheme=scheme)
        rel_path = target_path.relative_to(IMAGES_ROOT).as_posix()
        response_data = {"output_dir": rel_path, "sum_maps": entries}
        print(f"[/api/composite-recolor] 응답 데이터: {response_data}")
        return response_data
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="재색칠을 위한 원본 데이터가 없습니다.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"? [/api/composite-recolor] 실패: {exc}")
        raise HTTPException(status_code=500, detail="Composite Sum Map을 갱신하지 못했습니다.")


# ===== MY LOT 관리 API =====
def _resolve_my_lot_login(request: Request) -> str:
    login_id = _current_login_id(request)
    return login_id or "change"


@app.get("/api/my-lot")
async def get_my_lot_entries(request: Request):
    login_id = _resolve_my_lot_login(request)
    try:
        return my_lot_list(login_id)
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot] 조회 실패: {exc}")
        raise HTTPException(status_code=500, detail="MY LOT 데이터를 불러오지 못했습니다.")


@app.post("/api/my-lot/group")
async def create_my_lot_group(request: Request):
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        group = payload.get("group")
        if not group:
            raise HTTPException(status_code=400, detail="group 이름이 필요합니다.")
        info = my_lot_create_group(login_id, mode, group)
        return {"success": True, **info}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot/group] 생성 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"그룹을 생성하지 못했습니다: {exc}")


@app.put("/api/my-lot/group/rename")
async def rename_my_lot_group(request: Request):
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        old_name = payload.get("old_name")
        new_name = payload.get("new_name")
        if not old_name or not new_name:
            raise HTTPException(status_code=400, detail="old_name과 new_name이 필요합니다.")
        renamed = my_lot_rename_group(login_id, mode, old_name, new_name)
        if not renamed:
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")
        return {"success": True}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot/group/rename] 이름 변경 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"그룹 이름을 변경하지 못했습니다: {exc}")


@app.delete("/api/my-lot/group")
async def delete_my_lot_group(request: Request):
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        group = payload.get("group")
        if not group:
            raise HTTPException(status_code=400, detail="group 이름이 필요합니다.")
        deleted = my_lot_delete_group(login_id, mode, group)
        if not deleted:
            raise HTTPException(status_code=404, detail="그룹을 찾을 수 없습니다.")
        return {"success": True}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot/group] 삭제 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"그룹을 삭제하지 못했습니다: {exc}")


@app.post("/api/my-lot")
async def add_my_lot_entry_endpoint(request: Request):
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        group = payload.get("group")
        path = payload.get("path")
        if not group or not path:
            raise HTTPException(status_code=400, detail="group과 path가 필요합니다.")

        # 상대 경로를 절대 경로로 변환
        rel_path = relkey_from_any_path(path)
        abs_path = ROOT_DIR / rel_path

        if not abs_path.exists() or not abs_path.is_file():
            raise HTTPException(status_code=404, detail="이미지를 찾을 수 없습니다.")

        result = my_lot_add_entry(login_id, mode, group, abs_path)
        return {"success": True, **result}
    except HTTPException:
        raise
    except ValueError as exc:
        # 중복 등록 등의 ValueError는 400으로 처리
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot] 저장 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"MY LOT 저장에 실패했습니다: {exc}")


@app.post("/api/my-lot/batch")
async def add_my_lot_batch_endpoint(request: Request):
    """LOT 값으로 검색하여 해당 LOT의 모든 이미지를 그룹에 일괄 추가."""
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        group = payload.get("group")
        lot_value = payload.get("lot")  # LOT 값
        paths = payload.get("paths")  # 또는 경로 리스트
        manual_values = payload.get("manual_values") or []

        if not group:
            raise HTTPException(status_code=400, detail="group이 필요합니다.")

        # 🔥 실제 이미지가 있는 LOT/Wafer 조합을 추적 (placeholder 중복 방지)
        matched_keys = set()
        collected_paths = []
        
        # 🔥 1단계: 실제 이미지 경로 수집
        if paths:
            for path in paths:
                rel_path = relkey_from_any_path(path)
                abs_path = ROOT_DIR / rel_path
                if abs_path.exists() and abs_path.is_file():
                    collected_paths.append(abs_path)
                    # 파일명에서 LOT/Wafer 추출하여 추적
                    filename = abs_path.stem  # 확장자 제외한 파일명
                    parts = filename.split("_")
                    root = parts[0] if len(parts) > 0 else filename
                    wafer = ""
                    if len(parts) > 2:
                        wafer = parts[2]
                    elif len(parts) > 1:
                        # W로 시작하는 부분 찾기
                        for part in reversed(parts):
                            if part and (part[0] == 'W' or part[0] == 'w'):
                                wafer = part
                                break
                    
                    if mode == "lot":
                        key = root.lower()
                    else:
                        key = f"{root.lower()}_{wafer.lower()}"
                    if key:
                        matched_keys.add(key)

        # 🔥 2단계: 실제 이미지가 없는 항목만 placeholder 생성
        placeholder_paths = []
        if manual_values:
            if not isinstance(manual_values, list):
                raise HTTPException(status_code=400, detail="manual_values는 배열이어야 합니다.")
            for item in manual_values:
                lot_candidate = ""
                wafer_candidate = ""
                if isinstance(item, str):
                    lot_candidate = item
                elif isinstance(item, dict):
                    lot_candidate = (item.get("lot") or "").strip()
                    wafer_candidate = (item.get("wafer") or "").strip()
                if not lot_candidate:
                    continue
                
                # 🔥 실제 이미지가 있는지 확인 (중복 방지)
                if mode == "lot":
                    key = lot_candidate.lower()
                else:
                    key = f"{lot_candidate.lower()}_{wafer_candidate.lower()}"
                
                if key in matched_keys:
                    # 실제 이미지가 이미 있으므로 placeholder 생성 skip
                    continue
                
                # 🔥 실제 이미지가 없으면 placeholder 생성
                from .my_lot import create_placeholder_image
                placeholder = create_placeholder_image(
                    mode,
                    lot_candidate,
                    wafer_candidate if mode == "wafer" else "",
                )
                if placeholder:
                    placeholder_paths.append(placeholder)
                    matched_keys.add(key)

        # 🔥 3단계: placeholder 경로 추가
        if placeholder_paths:
            collected_paths.extend(placeholder_paths)

        if collected_paths:
            result = my_lot_add_lot_batch(login_id, mode, group, collected_paths)
            result["placeholder_count"] = len(placeholder_paths)
            return {"success": True, **result}

        # collected_paths가 비어있지만 manual_values가 제공된 경우 (placeholder 생성 실패)
        if manual_values:
            return {
                "success": True,
                "success_count": 0,
                "duplicate_count": 0,
                "placeholder_count": 0,
                "message": "이미지를 찾을 수 없어 등록하지 못했습니다."
            }

        # lot_value가 제공된 경우: search로 해당 LOT의 모든 이미지 찾기
        if not lot_value:
            raise HTTPException(status_code=400, detail="lot 또는 paths가 필요합니다.")

        if not index_service.keys:
            await index_service.ensure_ready_for_search()
        if not index_service.keys:
            asyncio.create_task(index_service.build(force=True, allow_background=True))
            raise HTTPException(status_code=503, detail="파일 인덱스가 준비되지 않았습니다.")

        # LOT로 시작하는 파일들을 검색
        lot_prefix = lot_value.strip().lower()
        matched_paths = []

        for rel_path, name_lower in zip(index_service.keys, index_service.names):
            # 파일명이 LOT_로 시작하는지 확인
            if name_lower.startswith(lot_prefix + "_") or name_lower.startswith(lot_prefix + "."):
                abs_path = ROOT_DIR / rel_path
                if abs_path.exists() and abs_path.is_file():
                    matched_paths.append(abs_path)

        if not matched_paths:
            return {
                "success": True,
                "success_count": 0,
                "duplicate_count": 0,
                "error_count": 0,
                "errors": [],
                "message": f"LOT '{lot_value}'에 해당하는 이미지를 찾을 수 없습니다.",
            }

        result = my_lot_add_lot_batch(login_id, mode, group, matched_paths)
        return {"success": True, **result}

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot/batch] 일괄 등록 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"MY LOT 일괄 등록에 실패했습니다: {exc}")


@app.delete("/api/my-lot")
async def delete_my_lot_entry_endpoint(request: Request):
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        group = payload.get("group")
        filename = payload.get("value")  # value는 filename으로 처리
        if not group or not filename:
            raise HTTPException(status_code=400, detail="group과 filename이 필요합니다.")
        removed = my_lot_remove_entry(login_id, mode, group, filename)
        return {"success": removed}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot] 삭제 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"MY LOT 항목을 삭제하지 못했습니다: {exc}")


@app.delete("/api/my-lot/batch")
async def delete_my_lot_batch_endpoint(request: Request):
    """여러 MY LOT 항목을 일괄 삭제."""
    login_id = _resolve_my_lot_login(request)
    try:
        payload = await request.json()
        mode = payload.get("mode", "lot")
        group = payload.get("group")
        filenames = payload.get("filenames", [])
        if not group:
            raise HTTPException(status_code=400, detail="group이 필요합니다.")
        if not filenames:
            raise HTTPException(status_code=400, detail="filenames가 필요합니다.")
        result = my_lot_remove_entries_batch(login_id, mode, group, filenames)
        return {"success": True, **result}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"❌ [/api/my-lot/batch] 일괄 삭제 실패: {exc}")
        raise HTTPException(status_code=500, detail=f"MY LOT 항목 일괄 삭제에 실패했습니다: {exc}")



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
    try:
        response = await call_next(request)
        p = request.url.path
        if p.startswith("/api/labels") or p.startswith("/api/classes"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response
    except BaseException as e:
        # 클라이언트 연결 끊김 관련 예외는 조용히 처리
        exc_str = str(e)
        exc_type = type(e).__name__

        # EndOfStream, "No response returned", ExceptionGroup 등 클라이언트 연결 끊김 관련
        if (exc_type == "EndOfStream" or
            "No response returned" in exc_str or
            "EndOfStream" in exc_str or
            isinstance(e, (ConnectionError, ConnectionResetError, BrokenPipeError))):
            return Response(status_code=499)

        # ExceptionGroup인 경우 하위 예외 확인
        if exc_type in ("ExceptionGroup", "BaseExceptionGroup"):
            # ExceptionGroup의 경우 모든 하위 예외가 EndOfStream 관련인지 확인
            try:
                if hasattr(e, 'exceptions'):
                    all_client_disconnect = all(
                        "EndOfStream" in str(ex) or "No response returned" in str(ex)
                        for ex in e.exceptions
                    )
                    if all_client_disconnect:
                        return Response(status_code=499)
            except:
                pass

        # 예상치 못한 예외는 로깅 후 재발생
        logger = logging.getLogger(__name__)
        logger.error(f"미들웨어 예외: {exc_type}: {e}")
        raise

# ---- 액세스 테이블 로그 ----
class AccessTrackingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            # 자동 로그인 강제: 세션 쿠키가 없고 HTML 페이지 접근 시 /saml/login으로 리다이렉트
            skip_logging = False  # 로그 스킵 플래그

            # AUTO_LOGIN은 /saml/login 엔드포인트에서 처리 (수동 접속과 동일)
            # 미들웨어에서는 리다이렉트하지 않음

            response = await call_next(request)

            # SAML 리다이렉트로 인한 요청은 로그 스킵
            if skip_logging:
                return response

            endpoint = str(request.url.path)

            # 🔥 최적화: 이미지/썸네일 요청은 완전히 스킵 (대량 요청 시 성능 향상)
            if endpoint.startswith("/api/thumbnail") or endpoint.startswith("/api/image"):
                return response

            # 🔥 로그 스킵 대상 엔드포인트 체크 (통계 업데이트 전에 먼저 체크)
            skip_prefix = ["/favicon.ico", "/static/", "/js/", "/api/files/all", "/api/stats", "/api/stats/", "/stats", "/saml/login", "/saml/acs", "/saml/metadata", "/saml/sls"]

            # 루트(/) 페이지는 SAML 로그인 시에만 직접 기록하므로 미들웨어에서 스킵
            skip_endpoints = ["/", "/index.html"]
            if endpoint in skip_endpoints:
                return response

            if any(endpoint.startswith(p) for p in skip_prefix):
                return response

            client_ip = logger_instance.get_client_ip(request)

            # 🔥 stats.json을 읽지 않음 - SAML 로그인은 /saml/acs에서만 처리
            # middleware에서는 접속 제어를 하지 않음

            # 표시: IP만 표시
            display_user = client_ip

            method = request.method
            status = response.status_code

            # 🔥 최적화: 이미지/썸네일은 이미 위에서 return했으므로 여기는 도달 불가
            if endpoint.startswith("/api/classify"):
                tag = "ACTION"
            else:
                tag = "API"

            # 🔥 stats.json 업데이트는 /saml/acs에서만 수행 (쓰기만 함, 읽지 않음)
            # middleware에서는 stats.json을 읽거나 업데이트하지 않음

            note = _note_from_request(request, endpoint)
            # IP 칼럼에 IP만 표시 (stats.json 읽지 않음)
            log_access_row(tag=tag, ip=display_user, method=method, status=status, path=endpoint, note=note)
            return response
        except BaseException as e:
            # 클라이언트 연결 끊김 관련 예외는 조용히 처리
            exc_str = str(e)
            exc_type = type(e).__name__

            # EndOfStream, "No response returned", ExceptionGroup 등 클라이언트 연결 끊김 관련
            if (exc_type == "EndOfStream" or
                "No response returned" in exc_str or
                "EndOfStream" in exc_str or
                isinstance(e, (ConnectionError, ConnectionResetError, BrokenPipeError))):
                return Response(status_code=499)

            # ExceptionGroup인 경우 하위 예외 확인
            if exc_type in ("ExceptionGroup", "BaseExceptionGroup"):
                # ExceptionGroup의 경우 모든 하위 예외가 EndOfStream 관련인지 확인
                try:
                    if hasattr(e, 'exceptions'):
                        all_client_disconnect = all(
                            "EndOfStream" in str(ex) or "No response returned" in str(ex)
                            for ex in e.exceptions
                        )
                        if all_client_disconnect:
                            return Response(status_code=499)
                except:
                    pass

            # 예상치 못한 예외는 재발생 (상위 레벨에서 처리)
            raise

app.add_middleware(AccessTrackingMiddleware)

# 🔇 uvicorn access 로그에서 composite-map status polling 제거
class _SkipCompositeStatusFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        # request_line 또는 경로가 포함된 로그 메시지에서 status 엔드포인트 차단
        return "/api/composite-map/status" not in msg

logging.getLogger("uvicorn.access").addFilter(_SkipCompositeStatusFilter())

# 🚀 압축 미들웨어: 완전 비활성화
# 🔥 Python 3.13에서 GZip "I/O operation on closed file" 에러가 발생
# 이미지는 이미 압축되어 있고, JSON 응답은 작아서 압축 불필요
# 미들웨어를 추가하지 않음으로써 에러 완전 방지
# if HAS_BROTLI:
#     app.add_middleware(BrotliMiddleware, quality=3, minimum_size=_COMPRESS_MIN_SIZE)
# app.add_middleware(GZipMiddleware, minimum_size=_COMPRESS_MIN_SIZE, compresslevel=1)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# ======================== Utilities & Sync ========================
def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXTENSIONS

def get_thumbnail_path(image_path: Path, size: Tuple[int, int], scheme: Optional[str] = None) -> Path:
    # 🔥 절대 경로를 해시로 변환하여 썸네일 경로 생성
    path_hash = hashlib.md5(str(image_path.resolve()).encode()).hexdigest()[:16]
    
    # 썸네일 파일명
    thumbnail_name = f"{path_hash}_{size[0]}x{size[1]}.{THUMBNAIL_FORMAT.lower()}"
    
    # scheme이 있으면 scheme별 폴더 사용 (예: thumbnail/LoginId/251106_091612/)
    if scheme:
        from .personal_colors import load_color_legends
        legends = load_color_legends()
        scheme_data = legends.get(scheme, {})
        timestamp = scheme_data.get('lastModified')
        
        if timestamp:
            # scheme 폴더 아래 timestamp 폴더 사용
            scheme_dir = THUMBNAIL_DIR / scheme / timestamp
        else:
            # lastModified가 없으면 scheme만 사용 (하위 호환성)
            scheme_dir = THUMBNAIL_DIR / scheme
        
        # scheme 폴더 생성
        scheme_dir.mkdir(parents=True, exist_ok=True)
        return scheme_dir / thumbnail_name
    
    return THUMBNAIL_DIR / thumbnail_name

def safe_resolve_path(path: Optional[str]) -> Path:
    if not path: return current_folder
    try:
        normalized = os.path.normpath(str(path).lstrip("/\\"))
        
        # 🔥 ROOT_DIR 기준으로 경로 해석 (current_folder 무시)
        # 프론트엔드에서 전달하는 path는 이미 ROOT_DIR 기준 상대경로
        target = (ROOT_DIR / normalized).resolve()
        
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

def _chip_classification_root(base_folder: Optional[Path] = None) -> Path:
    """
    Chip 모드에서 사용할 분류 루트.
    current_folder(또는 지정된 base_folder)의 첫 컴포넌트를 제거한 뒤
    classification_chips/<trimmed-path> 경로를 반환한다.
    """
    target_base = base_folder or current_folder
    try:
        rel = target_base.relative_to(ROOT_DIR)
    except ValueError:
        rel = Path()
    trimmed = _trim_leading_component(rel)
    chip_root = config.CHIP_LABELS_DIR
    trimmed_parts = [p for p in trimmed.parts if p not in ("", ".")]
    if trimmed_parts:
        chip_root = chip_root.joinpath(*trimmed_parts)
    chip_root.mkdir(parents=True, exist_ok=True)
    return chip_root

def _classification_dir(mode: str = "wafer") -> Path:
    """
    Classification 폴더 경로 반환
    mode: "wafer" -> {current_folder}/classification/
          "chip"  -> {current_folder}/classification_chips/
    """
    global current_folder
    if mode == "chip":
        return current_folder / "classification_chips"
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
    """
    ⚠️ DEPRECATED: 이 함수는 사용하지 마세요!
    - 조회 API: _labels_reload_if_stale()만 호출
    - 쓰기 API: 수동으로 _sync_labels_if_classes_changed() 호출
    """
    _labels_reload_if_stale()
    # _sync_labels_if_classes_changed()  # ⚠️ 제거: current_folder 기준으로만 동작하여 문제 발생

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
    
    # 🚀 ROOT_DIR 미리 계산 (성능 최적화)
    root_dir_str = str(ROOT_DIR.resolve()).replace('\\', '/')
    root_dir_len = len(root_dir_str)
    
    try:
        # 🔥 처리할 항목들을 먼저 수집
        entries_to_process = []
        with os.scandir(target) as it:
            for entry in it:
                name = entry.name
                # 🔥 classification, classification_chips, chip_annotations, thumbnails 폴더 제외
                if name.startswith('.') or name == '__pycache__' or name in SKIP_DIRS or name in ['classification', 'classification_chips', 'chip_annotations', 'thumbnails', 'labels']:
                    continue
                entries_to_process.append(entry)
        
        # 🔥 대량 파일 처리 시에만 병렬 처리 (오버헤드 최소화)
        if len(entries_to_process) > 100:
            def process_entry(entry):
                typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                entry_path_str = str(entry.path).replace('\\', '/')
                # ROOT_DIR 부분을 제거하여 상대 경로 생성
                if entry_path_str.startswith(root_dir_str):
                    root_relative = entry_path_str[root_dir_len:].lstrip('/')
                else:
                    root_relative = entry.name
                
                return {
                    "name": entry.name, 
                    "type": typ, 
                    "path": entry_path_str,
                    "root_relative": root_relative  # ROOT_DIR 기준 절대 경로
                }
            
            # 🔥 병렬 처리 (대량 파일 처리 시 성능 향상, SEARCH_WORKERS 사용)
            with ThreadPoolExecutor(max_workers=config.SEARCH_WORKERS) as executor:
                items = list(executor.map(process_entry, entries_to_process))
        else:
            # 🔥 소량 파일은 순차 처리 (오버헤드 방지)
            for entry in entries_to_process:
                typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                entry_path_str = str(entry.path).replace('\\', '/')
                # ROOT_DIR 부분을 제거하여 상대 경로 생성
                if entry_path_str.startswith(root_dir_str):
                    root_relative = entry_path_str[root_dir_len:].lstrip('/')
                else:
                    root_relative = entry.name
                
                items.append({
                    "name": entry.name, 
                    "type": typ, 
                    "path": entry_path_str,
                    "root_relative": root_relative  # ROOT_DIR 기준 절대 경로
                })
        
        directories = [x for x in items if x["type"] == "directory"]
        files = [x for x in items if x["type"] == "file"]
        
        # 🔥 폴더 정렬: 이름 내림차순 (Z→A), depth 무관
        directories.sort(key=lambda x: x["name"].lower(), reverse=True)
        files.sort(key=lambda x: x["name"].lower(), reverse=True)
        
        # 폴더 먼저, 파일 나중에
        items = directories + files
        if should_cache: DIRLIST_CACHE.set(key, items)
    except FileNotFoundError:
        pass
    
    return items

async def build_file_index_background(force: bool = False):
    await index_service.build(force=force, allow_background=False)

# ======================== Thumbnails / Common ========================
def _save_with_turbojpeg(vips_image, thumbnail_path: str, quality: int) -> bool:
    """TurboJPEG로 JPEG 저장 (Q100 FASTDCT + 4:2:2)

    벤치마크 결과 (300개 기준):
      - TurboJPEG Q100 422 FASTDCT: 12,593ms (23.8/s) - 255KB
      - pyvips Q100 subsample1: 13,016ms (23.0/s) - 202KB
      - 속도: 3.4% 빠름, 크기: 26% 증가
    
    4:2:2 선택 이유:
      - 세로 방향 색상 경계 보존 (16색 이미지에도 유리)
      - 속도는 4:2:0과 유사 (단일 이미지에서는 오히려 빠름)
    """
    if not TURBO_JPEG or not HAS_NUMPY:
        return False

    try:
        # pyvips → numpy 변환
        mem_img = vips_image.write_to_memory()
        np_array = np.frombuffer(mem_img, dtype=np.uint8).reshape(
            vips_image.height, vips_image.width, vips_image.bands
        )

        # RGB 변환
        if vips_image.bands == 1:
            # Grayscale → RGB
            np_array = np.stack([np_array] * 3, axis=-1).squeeze()
        elif vips_image.bands == 4:
            # RGBA → RGB
            np_array = np_array[:, :, :3]

        # TurboJPEG 인코딩 (Q100 FASTDCT + 4:2:2)
        base_kwargs = {
            "quality": quality,
            "pixel_format": TJPF_RGB,
        }

        # FASTDCT 플래그 추가
        if TJFLAG_FASTDCT is not None:
            base_kwargs["flags"] = TJFLAG_FASTDCT

        # 4:2:2 chroma subsampling (세로 방향 색상 보존)
        try:
            jpeg_buf = TURBO_JPEG.encode(np_array, jpeg_subsample=TJSAMP_422, **base_kwargs)
        except TypeError:
            try:
                jpeg_buf = TURBO_JPEG.encode(np_array, chroma_subsampling=TJSAMP_422, **base_kwargs)
            except TypeError:
                jpeg_buf = TURBO_JPEG.encode(np_array, **base_kwargs)

        # 파일 저장
        with open(thumbnail_path, "wb") as f:
            f.write(jpeg_buf)

        return True

    except Exception as e:
        # TurboJPEG 실패 시 pyvips 폴백
        return False

def _generate_thumbnail_sync(image_path: Path, thumbnail_path: Path, size: Tuple[int, int], personalized: bool = False, scheme: Optional[str] = None, force_jpeg_encoder: Optional[str] = None):
    try:
        thumbnail_path.parent.mkdir(parents=True, exist_ok=True)

        fmt = THUMBNAIL_FORMAT.upper()

        try:
            import pyvips
            try:
                pyvips.set_log_handler(lambda domain, level, msg: None)
            except AttributeError:
                pass

            # =============================================================
            # 그리드 썸네일 생성 - 개인색 설정 적용
            # =============================================================
            # 🔥 초고속 방식에 PLTE 패치만 추가:
            # 1. 원본 PNG 파일 읽기 및 PLTE 패치 (최우선!)
            # 2. 패치된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
            # 3. pyvips로 리사이즈 (기존 초고속 방식)
            # 4. 저장 (요청된 형식으로)
            if personalized and scheme and image_path.suffix.lower() == '.png':
                logger.debug(f"🎨 [THUMBNAIL] 개인색 설정 적용: personalized={personalized}, scheme={scheme}, path={image_path.name}, fmt={fmt}")
                try:
                    from .personal_colors import plte_inplace_patch_memory
                    
                    # 1. 원본 PNG 파일 읽기 및 PLTE 패치 (최우선!)
                    with open(image_path, 'rb') as f:
                        png_data = bytearray(f.read())
                    
                    png_data = plte_inplace_patch_memory(png_data, scheme)
                    
                    # 2. 패치된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
                    vips_image = pyvips.Image.new_from_buffer(bytes(png_data), "", access='sequential', fail_on='none', memory=True, unlimited=True)
                    
                    logger.debug(f"✅ [PLTE PATCH] 색 변경 완료, 리사이즈 시작: {thumbnail_path.name}")
                except Exception as e:
                    logger.warning(f"⚠️ [PLTE PATCH] 개인색 팔레트 적용 실패: {e}", exc_info=True)
                    # 실패 시 기존 pyvips 로직 사용 (개인색 미적용)
                    vips_image = pyvips.Image.new_from_file(
                        str(image_path),
                        access='sequential',
                        fail_on='none',
                        memory=True,
                        unlimited=True
                    )
            else:
                # 개인색 설정 미적용: 기존 pyvips 로직 사용
                vips_image = pyvips.Image.new_from_file(
                    str(image_path),
                    access='sequential',
                    fail_on='none',
                    memory=True,      # 메모리 캐시 활성화
                    unlimited=True    # 하드웨어 가속 활성화
                )

            def _write(vips_obj):
                if fmt == "PNG":
                    vips_obj.write_to_file(
                        str(thumbnail_path),
                        compression=config.PNG_COMPRESSION_LEVEL,
                        strip=True,
                        interlace=False
                    )
                elif fmt == "WEBP":
                    vips_obj.webpsave(
                        str(thumbnail_path),
                        Q=THUMBNAIL_QUALITY,
                        lossless=False,
                        effort=1,
                        strip=True,
                        smart_subsample=False
                    )
                else:
                    # 최적화 2: JPEG 저장 - TurboJPEG 우선, pyvips 폴백
                    if fmt == "JPEG":
                        # force_jpeg_encoder 파라미터로 인코더 강제 선택 (벤치마크용)
                        if force_jpeg_encoder == 'turbojpeg':
                            # TurboJPEG 강제 사용
                            saved_with_turbo = _save_with_turbojpeg(vips_obj, str(thumbnail_path), THUMBNAIL_QUALITY)
                            if not saved_with_turbo:
                                raise RuntimeError("TurboJPEG 저장 실패 (force_jpeg_encoder='turbojpeg')")
                        elif force_jpeg_encoder == 'pyvips':
                            # pyvips 강제 사용
                            vips_obj.jpegsave(
                                str(thumbnail_path),
                                Q=THUMBNAIL_QUALITY,       # Q=100 (최고 품질)
                                strip=True,                # 메타데이터 제거
                                optimize_coding=False,     # 속도 우선
                                subsample_mode=1,          # 4:2:0 (가장 빠름)
                                interlace=False,           # 인터레이스 비활성화
                                trellis_quant=False,      # 트렐리스 양자화 비활성화
                                quant_table=0,             # 기본 양자화 테이블
                                background=255             # 배경색 설정
                            )
                        else:
                            # 기본 동작: TurboJPEG 시도 → 실패 시 pyvips 폴백
                            saved_with_turbo = _save_with_turbojpeg(vips_obj, str(thumbnail_path), THUMBNAIL_QUALITY)
                            
                            if not saved_with_turbo:
                                # pyvips 폴백
                                vips_obj.jpegsave(
                                    str(thumbnail_path),
                                    Q=THUMBNAIL_QUALITY,       # Q=100 (최고 품질)
                                    strip=True,                # 메타데이터 제거
                                    optimize_coding=False,     # 속도 우선
                                    subsample_mode=1,          # 4:2:0 (가장 빠름)
                                    interlace=False,           # 인터레이스 비활성화
                                    trellis_quant=False,       # 트렐리스 양자화 비활성화
                                    quant_table=0,             # 기본 양자화 테이블
                                    background=255             # 배경색 설정
                                )
                    else:
                        vips_obj.write_to_file(
                            str(thumbnail_path),
                            Q=THUMBNAIL_QUALITY,
                            strip=True
                        )

            # 🔥 리사이즈 로직 (개인색 설정 여부와 관계없이 동일한 방식)
            target_w, target_h = size
            if vips_image.width <= target_w and vips_image.height <= target_h:
                _write(vips_image)
            else:
                # 최적화 3: 공격적인 shrink + resize 로직 적용
                # - 큰 축소(scale < 0.5)의 경우: shrink(정수 배율) + resize(나머지)
                # - 작은 축소의 경우: resize만 사용
                # - shrink는 HW 가속으로 매우 빠름 (정수 배율 축소)
                # - resize는 cubic 커널로 고품질 유지
                scale = min(target_w / vips_image.width, target_h / vips_image.height)
                scale = max(scale, 1.0 / max(vips_image.width, vips_image.height))  # avoid zero
                
                if scale < 0.5:
                    # 큰 축소: shrink + resize 조합
                    # 예: 10000x10000 → 512x512 (scale=0.0512)
                    # shrink_factor = int(1/0.0512) + 1 = 20
                    # shrink로 10000 → 500 (20배 축소, 매우 빠름)
                    # resize로 500 → 512 (1.024배 확대, cubic)
                    shrink_factor = max(int(1.0 / scale) + 1, 1)
                    if shrink_factor > 1:
                        resized = vips_image.shrink(shrink_factor, shrink_factor)
                        # 추가 리사이즈가 필요한 경우만
                        remaining_scale = scale * shrink_factor
                        if abs(remaining_scale - 1.0) > 0.01:
                            resized = resized.resize(
                                remaining_scale,
                                vscale=remaining_scale,
                                kernel='cubic'
                            )
                    else:
                        resized = vips_image.resize(
                            scale,
                            vscale=scale,
                            kernel='cubic'
                        )
                else:
                    # 작은 축소: resize만 사용
                    resized = vips_image.resize(
                        scale,
                        vscale=scale,
                        kernel='cubic'
                    )
                _write(resized)
            return
        except ImportError:
            pass

        with Image.open(image_path) as img:
            if img.mode not in ('RGB', 'RGBA'):
                img = img.convert('RGB')

            target_w, target_h = size
            if img.width <= target_w and img.height <= target_h:
                resized = img.copy()
            else:
                resized = img.copy()
                resized.thumbnail((target_w, target_h), Image.Resampling.BICUBIC)

            save_kwargs: Dict[str, Any] = {"optimize": True}
            if fmt == "PNG":
                save_kwargs["compress_level"] = config.PNG_COMPRESSION_LEVEL
            else:
                save_kwargs["quality"] = THUMBNAIL_QUALITY
                save_kwargs["method"] = 6

            resized.save(thumbnail_path, fmt, **save_kwargs)
    except Exception as e:
        logger.error(f"썸네일 생성 중 오류: {image_path} -> {thumbnail_path}, 오류: {e}")
        raise

async def generate_thumbnail(image_path: Path, size: Tuple[int, int], personalized: bool = False, scheme: Optional[str] = None) -> Optional[Path]:
    start_time = time.time()
    try:
        # 썸네일 경로 생성 (scheme 포함)
        if personalized and scheme:
            logger.debug(f"🎨 [GENERATE_THUMB] Using scheme: {scheme} for {image_path.name}")
            thumb = get_thumbnail_path(image_path, size, scheme=scheme)
        else:
            logger.debug(f"🎨 [GENERATE_THUMB] No scheme (personalized={personalized}, scheme={scheme}) for {image_path.name}")
            thumb = get_thumbnail_path(image_path, size, scheme=None)
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
            return thumb

        async with THUMBNAIL_SEM:
            # 다시 한번 확인 (레이스 컨디션 방지)
            if thumb.exists() and thumb.stat().st_size > 0:
                try:
                    if thumb.stat().st_mtime >= image_mtime:
                        THUMB_STAT_CACHE.set(key, True)
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
            try:
                await asyncio.get_running_loop().run_in_executor(
                    THUMBNAIL_EXECUTOR, _generate_thumbnail_sync, image_path, thumb, size, personalized, scheme
                )
                gen_elapsed = time.time() - gen_start
                
                # 생성된 썸네일 확인
                if thumb.exists() and thumb.stat().st_size > 0:
                    THUMB_STAT_CACHE.set(key, True)
                    return thumb
                else:
                    return None
            except Exception as e:
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
    mode: Literal["wafer", "chip"] = "wafer"

class ClassifyDeleteRequest(BaseModel):
    image_path: Optional[str] = None
    image_name: Optional[str] = None
    class_name: str
    mode: Literal["wafer", "chip"] = "wafer"

# 프런트 호환: 배치 삭제용 요청 스키마 (POST /api/classify/delete)
class ClassifyDeleteBatchReq(BaseModel):
    images: List[str]
    class_: str = Field(alias="class")
    mode: Literal["wafer", "chip"] = "wafer"

# ======================== Endpoints ========================
@app.get("/api/files")
async def get_files(path: Optional[str] = None, prefer: Optional[str] = None):
    global current_folder
    try:
        target = safe_resolve_path(path)
        # 디버그 로그 제거 (너무 자주 출력됨)
        # logger.info(f"📁 [/api/files] path: {path}, target: {target}")
        if not target.exists() or not target.is_dir():
            logger.warning(f"⚠️ [/api/files] 폴더 없음: {target}")
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)

        # 🔥 current_folder 업데이트 제거: 오직 changeFolder에서만 변경됨
        # 이미지 클릭이나 폴더 탐색 시 current_folder를 변경하지 않음
        # current_folder는 제품 선택(changeFolder) 시에만 변경됨
        # 디버그 로그 제거
        # logger.info(f"⏭️ [/api/files] current_folder 유지 (변경 안 함): {current_folder}")
        # 🔥 라벨 썸네일 캐시는 유지하고, classification 폴더만 무효화
        if 'classification' in str(target).replace('\\', '/'):
            _dircache_invalidate(target)
        
        # 🔥 ThreadPoolExecutor로 병렬 처리 (고성능)
        loop = asyncio.get_running_loop()
        items = await loop.run_in_executor(DIRLIST_EXECUTOR, list_dir_fast, target)

        # 🔥 특정 폴더 제외: classification, classification_chips, chip_annotations, thumbnails, composite_map
        excluded_folders = ['classification', 'classification_chips', 'chip_annotations', 'thumbnails', 'composite_map']
        items = [item for item in items if item['name'] not in excluded_folders]
        
        # 디버그 로그 제거 (너무 자주 출력됨)
        # logger.info(f"📁 [/api/files] 반환 항목 수: {len(items)} (폴더: {sum(1 for x in items if x['type']=='directory')}, 파일: {sum(1 for x in items if x['type']=='file')})")
        
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
        if ("/classification/" not in p and not p.startswith("classification/") and
                "/classification_chips/" not in p and not p.startswith("classification_chips/")):
            return None
        filename = Path(p).name
        
        # 🔥 최적화: FILE_INDEX_BY_NAME 캐시 사용 (빠른 O(1) 룩업)
        if not hasattr(_lookup_original_relpath_from_classification_path, '_name_cache'):
            _lookup_original_relpath_from_classification_path._name_cache = {}
            _lookup_original_relpath_from_classification_path._cache_timestamp = 0
        
        # 🔥 캐시 갱신 주기 확인 (30초마다 갱신)
        current_time = time.time()
        if current_time - _lookup_original_relpath_from_classification_path._cache_timestamp > 30:
            with FILE_INDEX_LOCK:
                keys_snapshot = list(FILE_INDEX_KEYS)
            
            # 파일명 → 경로 매핑 생성 (같은 파일명이 여러 개 있을 수 있으므로 리스트로)
            name_cache = {}
            for rel in keys_snapshot:
                fname = Path(rel).name
                if fname not in name_cache:
                    name_cache[fname] = []
                name_cache[fname].append(rel)
            
            _lookup_original_relpath_from_classification_path._name_cache = name_cache
            _lookup_original_relpath_from_classification_path._cache_timestamp = current_time
        
        # 🔥 캐시에서 빠른 조회
        candidates = _lookup_original_relpath_from_classification_path._name_cache.get(filename, [])
        if candidates:
            # 첫 번째 매칭 반환 (같은 파일명이 여러 개면 첫 번째 사용)
            return candidates[0]
        
        # 🔥 캐시에 없으면 NULL 반환 (os.walk 건너뛰기 - 너무 느림)
        # relkey_from_any_path()가 폴백으로 처리할 것임
        return None
    except Exception:
        return None

_pyramid_lock_guard = Lock()
_pyramid_generation_locks: Dict[str, Lock] = {}


@contextmanager
def _pyramid_path_lock(path: Path):
    """Ensure single-writer semantics per pyramid output path."""
    key = str(path)
    with _pyramid_lock_guard:
        lock = _pyramid_generation_locks.get(key)
        if lock is None:
            lock = Lock()
            _pyramid_generation_locks[key] = lock
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def _generate_pyramid_sync(image_path: Path, pyramid_path: Path, level: float, personalized: bool = False, scheme: Optional[str] = None, grade_filter: Optional[str] = None):
    """🚀 피라미드 레벨 이미지 생성 (속도 극대화)"""
    import time
    start_time = time.time()

    target_format = config.PYRAMID_FORMAT.upper()
    quality = max(1, min(100, int(config.PYRAMID_Q)))
    png_compression = max(0, min(9, int(config.PYRAMID_PNG_COMPRESSION)))
    png_effort = max(1, min(10, int(config.PYRAMID_PNG_EFFORT)))
    # 고품질 리사이즈를 위해 BICUBIC 강제 사용 (LANCZOS 사용 금지)
    kernel_name = 'cubic'
    loader_mode = getattr(config, "PYRAMID_LOADER_MODE", "random_late_copy").strip().lower()

    def _log_completion(width: int, height: int) -> None:
        elapsed = time.time() - start_time
        if pyramid_path.exists():
            file_size = pyramid_path.stat().st_size
            logger.info(f"✅ [PYRAMID] 완료: {width}×{height} ({file_size:,} bytes) - {elapsed:.2f}초")
        else:
            logger.error(f"❌ [PYRAMID] 파일 생성 실패 - {elapsed:.2f}초")

    def _safe_unlink(path: Path) -> None:
        try:
            path.unlink()
        except FileNotFoundError:
            return
        except Exception as unlink_err:
            logger.debug(f"⚠️ [PYRAMID] 임시 파일 삭제 실패: {unlink_err}")

    def _atomic_replace(src: Path, dest: Path) -> None:
        try:
            src.replace(dest)
        except PermissionError:
            try:
                dest.unlink()
            except FileNotFoundError:
                pass
            src.replace(dest)

    with _pyramid_path_lock(pyramid_path):
        # 🔥 디렉토리 생성 안전성 강화
        try:
            pyramid_path.parent.mkdir(parents=True, exist_ok=True)
            # 디렉토리가 실제로 생성되었는지 확인
            if not pyramid_path.parent.exists():
                raise OSError(f"디렉토리 생성 실패: {pyramid_path.parent}")
        except OSError as dir_err:
            logger.error(f"❌ [PYRAMID] 디렉토리 생성 실패: {pyramid_path.parent}, 오류: {dir_err}")
            raise
        except Exception as dir_err:
            logger.error(f"❌ [PYRAMID] 디렉토리 생성 예외: {pyramid_path.parent}, 오류: {dir_err}")
            raise
        
        temp_path = pyramid_path.with_name(pyramid_path.name + ".tmp")
        _safe_unlink(temp_path)
        expected_w: Optional[int] = None
        expected_h: Optional[int] = None

        try:
            try:
                import pyvips  # type: ignore
            except ImportError:
                pyvips = None  # type: ignore[assignment]
                logger.info("🚀 [PILLOW] PyVips 없음 - Pillow 사용")
            else:
                # ============================================================
                # 🔥 피라미드 생성 워크플로우:
                # 1. 원본 PNG 파일 읽기 및 PLTE 패치 (최우선!)
                # 2. 패치된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
                # 3. pyvips로 리사이즈 (기존 초고속 방식)
                # 4. 저장
                # ============================================================
                image = None
                
                # [1단계] 원본 이미지 로드
                # 🔥 초고속 방식에 PLTE 패치만 추가
                # Grade 필터가 우선, 그 다음 개인색 설정
                # 원본 이미지가 PNG이면 팔레트 필터링 적용 (저장 포맷과 무관 - JPEG로 저장해도 적용)
                if grade_filter and image_path.suffix.lower() == '.png':
                    logger.info(f"🎯 [PYRAMID] Grade 필터 적용: grade_filter={grade_filter}, path={image_path.name}, target_format={target_format}")
                    try:
                        from .personal_colors import plte_grade_filter_memory, plte_inplace_patch_memory

                        # grade_filter 파싱: "3" 또는 "2,4,7"
                        grade_indices = [int(g.strip()) for g in grade_filter.split(',') if g.strip().isdigit()]

                        if grade_indices:
                            # 1. 원본 PNG 파일 읽기
                            with open(image_path, 'rb') as f:
                                png_data = bytearray(f.read())

                            # 2. 먼저 개인색 설정 적용 (Grade0-7을 인덱스 0-7로 매핑)
                            if personalized and scheme:
                                png_data = plte_inplace_patch_memory(png_data, scheme)
                                logger.debug(f"🎨 [PYRAMID GRADE FILTER] 개인색 설정 먼저 적용: scheme={scheme}")

                            # 3. 그 다음 Grade PLTE 필터 (인덱스 0-7 필터링)
                            png_data = plte_grade_filter_memory(png_data, grade_indices)

                            # 4. 필터링된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
                            image = pyvips.Image.new_from_buffer(bytes(png_data), "", access='sequential', fail_on='none', memory=True, unlimited=True)

                            logger.debug(f"✅ [PYRAMID GRADE FILTER] Grade {grade_filter} 필터링 완료, 리사이즈 시작: {pyramid_path.name}")
                        else:
                            image = None
                    except Exception as e:
                        logger.warning(f"⚠️ [PYRAMID GRADE FILTER] 필터링 실패, 폴백: {e}", exc_info=True)
                        # 폴백: 기존 방식 사용
                        image = None
                elif personalized and scheme and image_path.suffix.lower() == '.png':
                    logger.info(f"🎨 [PYRAMID] 개인색 설정 적용: personalized={personalized}, scheme={scheme}, path={image_path.name}, target_format={target_format}")
                    try:
                        from .personal_colors import plte_inplace_patch_memory

                        # 1. 원본 PNG 파일 읽기 및 PLTE 패치 (최우선!)
                        with open(image_path, 'rb') as f:
                            png_data = bytearray(f.read())

                        png_data = plte_inplace_patch_memory(png_data, scheme)

                        # 2. 패치된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
                        image = pyvips.Image.new_from_buffer(bytes(png_data), "", access='sequential', fail_on='none', memory=True, unlimited=True)

                        logger.debug(f"✅ [PYRAMID PLTE PATCH] 색 변경 완료, 리사이즈 시작: {pyramid_path.name}")
                    except Exception as e:
                        logger.warning(f"⚠️ [PYRAMID PLTE] PLTE 인-place 실패, 폴백: {e}", exc_info=True)
                        # 폴백: 기존 방식 사용
                        image = None
                else:
                    # 개인색 설정이 없거나 PNG가 아닌 경우: pyvips로 바로 로드 (빠름)
                    try:
                        try:
                            pyvips.set_log_handler(lambda domain, lvl, msg: None)
                        except AttributeError:
                            pass

                        # =============================================================
                        # 피라미드 썸네일 생성 최적화 (2025-10-23)
                        # 원복 시점: commit dce1bb2
                        # =============================================================
                        # 최적화 1: 하드웨어 가속 및 메모리 캐시 활성화
                        # - memory=True: libvips 내부 캐시 활성화로 반복 접근 속도 향상
                        # - unlimited=True: 하드웨어 가속 기능 활성화 (SIMD, 멀티코어)
                        # - 그리드 썸네일과 동일한 로딩 최적화 적용
                        image = pyvips.Image.new_from_file(
                            str(image_path),
                            access='sequential',
                            fail_on='none',
                            memory=True,      # 메모리 캐시 활성화
                            unlimited=True    # 하드웨어 가속 활성화
                        )
                        logger.info(f"✅ [STEP1] 원본 이미지 로드 완료 - {image.width}x{image.height}")
                    except pyvips.Error as vips_err:  # type: ignore[attr-defined]
                        logger.warning(f"⚠️ [PYVIPS] 오류 - Pillow 폴백 진행: {vips_err}")
                        image = None
                    except Exception as vips_generic:
                        logger.exception(f"⚠️ [PYVIPS] 예기치 않은 오류 - Pillow 폴백: {vips_generic}")
                        image = None
                
                # [3단계] level별 생성 (개인색 설정 여부와 관계없이 동일한 방식)
                if image is not None:
                    try:
                        orig_w, orig_h = image.width, image.height
                        expected_w = max(1, int(orig_w * level))
                        expected_h = max(1, int(orig_h * level))

                        # 최적화 2: copy_memory() 완전 제거 - 스트리밍 방식 사용
                        # - 기존: seq_early_copy 모드에서 image.copy_memory() 호출
                        # - 문제: 메모리 복사 오버헤드로 30-40% 속도 저하
                        # - 개선: 스트리밍 방식으로 처리하여 메모리 복사 제거
                        work_image = image
                        if level < 1.0:
                            # 최적화 3: 공격적인 shrink 로직 적용 (그리드 썸네일과 동일)
                            # - 큰 축소(scale < 0.5)의 경우 shrink + resize 조합 사용
                            # - shrink: 정수 배율 고속 축소 (HW 가속)
                            # - resize: 나머지 scale 조정 (cubic 커널)
                            scale = level
                            if scale < 0.5:
                                # 큰 축소의 경우 더 공격적인 shrink 사용
                                shrink_factor = max(int(1.0 / scale) + 1, 1)
                                if shrink_factor > 1:
                                    work_image = work_image.shrink(shrink_factor, shrink_factor)
                                    
                                    # 추가 리사이즈가 필요한 경우만
                                    remaining_scale = scale * shrink_factor
                                    if abs(remaining_scale - 1.0) > 0.01:
                                        work_image = work_image.resize(remaining_scale, vscale=remaining_scale, kernel=kernel_name)
                                else:
                                    work_image = work_image.resize(scale, vscale=scale, kernel=kernel_name)
                            else:
                                # 작은 축소의 경우 직접 resize
                                work_image = work_image.resize(scale, vscale=scale, kernel=kernel_name)

                        final_w, final_h = work_image.width, work_image.height
                        temp_target = str(temp_path)
                        if target_format == "PNG":
                            work_image.pngsave(
                                temp_target,
                                compression=png_compression,
                                interlace=False,
                                strip=True,
                                effort=png_effort,
                                keep=pyvips.enums.ForeignKeep.NONE,
                            )
                        elif target_format == "WEBP":
                            work_image.webpsave(
                                temp_target,
                                Q=quality,
                                lossless=False,
                                effort=1,
                                strip=True,
                                smart_subsample=False,
                            )
                        else:
                            # JPEG 저장 (pyvips Q95 - 벤치마크 검증 완료)
                            # 벤치마크 결과: pyvips Q95 > TurboJPEG (24% 빠름, 58% 작음)
                            # - pyvips Q95: 321ms, 8.4MB
                            # - TurboJPEG Q100: 420ms, 20.2MB
                            try:
                                work_image.jpegsave(
                                    temp_target,
                                    Q=95,                      # Q=95 (그리드 썸네일과 동일, 벤치마크 최적화)
                                    strip=True,                # 메타데이터 제거
                                    optimize_coding=False,     # 속도 우선
                                    subsample_mode=1,          # 4:2:0 (가장 빠름)
                                    interlace=False            # 인터레이스 비활성화
                                )
                            except pyvips.Error as jpeg_err:
                                logger.error(f"❌ [JPEG SAVE] 저장 실패: {temp_target}, 오류: {jpeg_err}")
                                # 디렉토리 다시 확인
                                if not temp_path.parent.exists():
                                    logger.error(f"❌ [JPEG SAVE] 디렉토리 없음: {temp_path.parent}")
                                    try:
                                        temp_path.parent.mkdir(parents=True, exist_ok=True)
                                        work_image.jpegsave(
                                            temp_target,
                                            Q=95,
                                            strip=True,
                                            optimize_coding=False,
                                            subsample_mode=1,
                                            interlace=False
                                        )
                                    except Exception as retry_err:
                                        logger.error(f"❌ [JPEG SAVE] 재시도 실패: {retry_err}")
                                        raise
                                else:
                                    raise
                        _atomic_replace(temp_path, pyramid_path)
                        _log_completion(final_w, final_h)
                        return
                    except pyvips.Error as vips_err:  # type: ignore[attr-defined]
                        logger.warning(f"⚠️ [PYVIPS] 오류 - Pillow 폴백 진행: {vips_err}")
                    except Exception as vips_generic:
                        logger.exception(f"⚠️ [PYVIPS] 예기치 않은 오류 - Pillow 폴백: {vips_generic}")

            from PIL import Image

            with Image.open(image_path) as img:
                orig_w, orig_h = img.size
                expected_w = max(1, int(orig_w * level))
                expected_h = max(1, int(orig_h * level))

                resample_map = {
                    "nearest": Image.Resampling.NEAREST,
                    "linear": Image.Resampling.BILINEAR,
                    "bilinear": Image.Resampling.BILINEAR,
                    "cubic": Image.Resampling.BICUBIC,
                    "bicubic": Image.Resampling.BICUBIC,
                    "lanczos": Image.Resampling.LANCZOS,
                    "lanczos2": Image.Resampling.LANCZOS,
                    "lanczos3": Image.Resampling.LANCZOS,
                }
                resample = resample_map.get(kernel_name, Image.Resampling.BICUBIC)

                if level < 1.0:
                    resized = img.resize((expected_w, expected_h), resample=resample)
                else:
                    resized = img.copy()

                if target_format in {"JPEG", "WEBP", "JPG"} and resized.mode not in ("RGB", "L"):
                    resized = resized.convert("RGB")
                elif target_format == "PNG" and resized.mode == "P" and "transparency" in resized.info:
                    resized = resized.convert("RGBA")

                pillow_kwargs: Dict[str, Any] = {}
                if target_format == "PNG":
                    pillow_kwargs["compress_level"] = png_compression
                elif target_format == "WEBP":
                    pillow_kwargs["quality"] = quality
                    pillow_kwargs["method"] = 1
                    pillow_kwargs["lossless"] = False
                else:
                    pillow_kwargs["quality"] = quality
                    pillow_kwargs["optimize"] = True
                    pillow_kwargs["progressive"] = True

                resized.save(str(temp_path), format=target_format, **pillow_kwargs)
                _atomic_replace(temp_path, pyramid_path)
                _log_completion(resized.width, resized.height)
                return

        except Exception as e:
            elapsed = time.time() - start_time
            logger.error(f"❌ [PYRAMID] 오류: {e} - {elapsed:.2f}초")

            try:
                shutil.copy2(image_path, str(temp_path))
                _atomic_replace(temp_path, pyramid_path)
                logger.info(f"🚑 [SPEED FALLBACK] 원본 복사: {pyramid_path}")
                try:
                    from PIL import Image as _ImageForFallback
                    with _ImageForFallback.open(image_path) as orig_img:
                        _log_completion(orig_img.width, orig_img.height)
                except Exception as size_err:
                    logger.debug(f"⚠️ [PYRAMID] 원본 크기 확인 실패: {size_err}")
                    elapsed = time.time() - start_time
                    logger.info(f"✅ [PYRAMID] 완료(원본 복사): {pyramid_path} - {elapsed:.2f}초")
                return
            except Exception as copy_error:
                logger.exception(f"🚑 [SPEED COPY FAILED] {copy_error}")
                raise
        finally:
            _safe_unlink(temp_path)


# 🔥 Background 피라미드 생성 (동시 생성 제한)
_pyramid_bg_executor = ThreadPoolExecutor(max_workers=config.PYRAMID_BG_WORKERS)
_pyramid_bg_generating = set()  # 현재 생성 중인 파일 경로

async def _generate_other_levels_background(image_path: Path, current_level: float, stem: str, personalized: bool = False, scheme: Optional[str] = None, grade_filter: Optional[str] = None):
    """다른 피라미드 레벨들을 background에서 생성 (원본 재사용 파이프라인)"""
    format_ext = config.PYRAMID_FORMAT.lower()
    try:
        # 생성할 레벨 목록 (현재 레벨 제외, 1.0 제외)
        other_levels = [l for l in config.PYRAMID_LEVELS if l != current_level and l < 1.0]

        if not other_levels:
            logger.info("⏭️ [BG SKIP] 생성할 레벨이 없음")
            return

        # 레벨을 크기 순으로 정렬 (큰 레벨부터)
        other_levels.sort(reverse=True)

        # 🔥 Grade 필터 또는 개인색 설정 확인 및 로깅
        logger.info(f"🚀 [BG PIPELINE] Background 파이프라인 시작: levels={other_levels}, personalized={personalized}, scheme={scheme}, grade_filter={grade_filter}")
        if grade_filter:
            logger.info(f"🎯 [BG PIPELINE] Grade 필터 활성화: grade_filter={grade_filter}, levels={other_levels}")
        elif personalized and scheme:
            logger.info(f"🎨 [BG PIPELINE] 개인색 설정 활성화: scheme={scheme}, levels={other_levels}")
        else:
            logger.info(f"⚪ [BG PIPELINE] 개인색 설정 비활성화: personalized={personalized}, scheme={scheme}")

        # 파이프라인 실행 (ThreadPoolExecutor 사용)
        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(
            _pyramid_bg_executor,
            _generate_pyramid_pipeline,
            image_path,
            other_levels,
            stem,
            format_ext,
            personalized,
            scheme,
            grade_filter
        )
        
        # 결과 로깅
        success_count = sum(1 for _, success, _ in results if success)
        total_count = len(results)
        logger.info(f"✅ [BG PIPELINE] 완료: {success_count}/{total_count} 성공")
        
        for level, success, status in results:
            if not success and status != "EXISTS":
                logger.warning(f"⚠️ [BG PIPELINE] Level {level} 실패: {status}")

    except Exception as e:
        logger.warning(f"⚠️ [BG PYRAMID] Background 생성 오류: {e}")


def _generate_pyramid_bg_worker(image_path: Path, pyramid_path: Path, level: float, path_key: str):
    """Background 워커 (ThreadPoolExecutor에서 실행)"""
    try:
        logger.info(f"🔄 [BG START] Background 피라미드 생성: level={level}, path={image_path.name}")
        _generate_pyramid_sync(image_path, pyramid_path, level, personalized=False, scheme=None)
        logger.info(f"✅ [BG DONE] Background 피라미드 완료: level={level}")
    except Exception as e:
        logger.warning(f"⚠️ [BG ERROR] Background 생성 실패: {e}")
    finally:
        _pyramid_bg_generating.discard(path_key)


def _generate_pyramid_pipeline(image_path: Path, levels: list, stem: str, format_ext: str, personalized: bool = False, scheme: Optional[str] = None, grade_filter: Optional[str] = None):
    """원본 이미지를 한 번만 읽고 여러 레벨을 연속 생성하는 파이프라인
    🔥 Grade 필터 또는 개인색 설정이 있으면 원본을 먼저 메모리에서 변경하고,
    그 변경된 이미지로 모든 레벨을 생성"""
    import pyvips
    import time

    # 🔥 파이프라인 시작 시 Grade 필터 또는 개인색 설정 확인 및 로깅
    logger.info(f"🎯 [PIPELINE START] levels={levels}, personalized={personalized}, scheme={scheme}, grade_filter={grade_filter}, path={image_path.name}")

    # 🔥 Grade 필터와 개인색 설정 검증 (디버깅용)
    if personalized and not scheme:
        logger.warning(f"⚠️ [PIPELINE] personalized=True인데 scheme이 None입니다! path={image_path.name}, levels={levels}")
        personalized = False  # scheme이 없으면 개인색 비활성화

    try:
        # 🔥 Step 1: 원본 이미지를 먼저 Grade 필터 또는 개인색으로 변경 (메모리에서)
        original_image = None
        if grade_filter and image_path.suffix.lower() == '.png':
            # Grade 필터 (개인색 설정 먼저 적용 후 필터링)
            try:
                from .personal_colors import plte_grade_filter_memory, plte_inplace_patch_memory

                logger.info(f"🎯 [PIPELINE] Grade 필터 적용 시작: grade_filter={grade_filter}, levels={levels}, path={image_path.name}")

                # grade_filter 파싱: "3" 또는 "2,4,7"
                grade_indices = [int(g.strip()) for g in grade_filter.split(',') if g.strip().isdigit()]

                if grade_indices:
                    # 1. 원본 PNG 파일 읽기
                    with open(image_path, 'rb') as f:
                        png_data = bytearray(f.read())

                    # 2. 먼저 개인색 설정 적용 (Grade0-7을 인덱스 0-7로 매핑)
                    if personalized and scheme:
                        png_data = plte_inplace_patch_memory(png_data, scheme)
                        logger.debug(f"🎨 [PIPELINE] 개인색 설정 먼저 적용: scheme={scheme}")

                    # 3. 메모리에서 Grade PLTE 필터 적용 (인덱스 0-7 필터링)
                    png_data = plte_grade_filter_memory(png_data, grade_indices)

                    # 4. 필터링된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
                    original_image = pyvips.Image.new_from_buffer(
                        bytes(png_data),
                        "",
                        access='sequential',
                        fail_on='none',
                        memory=True,
                        unlimited=True
                    )
                    logger.info(f"✅ [PIPELINE] 원본 이미지를 메모리에서 Grade 필터 완료: grade_filter={grade_filter}, size={original_image.width}x{original_image.height}, levels={levels}")
            except Exception as e:
                logger.warning(f"⚠️ [PIPELINE] Grade 필터 실패, 폴백: {e}", exc_info=True)
                original_image = None
        elif personalized and scheme and image_path.suffix.lower() == '.png':
            # 개인색 설정
            try:
                from .personal_colors import plte_inplace_patch_memory

                logger.info(f"🎨 [PIPELINE] 개인색 적용 시작: scheme={scheme}, levels={levels}, path={image_path.name}")

                # 원본 PNG 파일 읽기 및 PLTE 패치 (메모리에서)
                with open(image_path, 'rb') as f:
                    png_data = bytearray(f.read())

                # 메모리에서 PLTE 패치 적용
                png_data = plte_inplace_patch_memory(png_data, scheme)

                # 패치된 PNG를 메모리에서 pyvips로 직접 로드 (초고속!)
                original_image = pyvips.Image.new_from_buffer(
                    bytes(png_data),
                    "",
                    access='sequential',
                    fail_on='none',
                    memory=True,
                    unlimited=True
                )
                logger.info(f"✅ [PIPELINE] 원본 이미지를 메모리에서 개인색으로 변경 완료: scheme={scheme}, size={original_image.width}x{original_image.height}, levels={levels}")
            except Exception as e:
                logger.error(f"❌ [PIPELINE] 개인색 적용 실패: scheme={scheme}, levels={levels}, error={e}", exc_info=True)
                # 개인색 적용 실패 시 원본 로드 (fallback)
                original_image = None
        
        # 개인색 적용 실패 시 또는 개인색 설정이 없는 경우 원본 로드
        if original_image is None:
            if personalized and scheme:
                logger.warning(f"⚠️ [PIPELINE] 개인색 적용 실패로 원본 이미지 사용: scheme={scheme}, levels={levels}")
            original_image = pyvips.Image.new_from_file(
                str(image_path),
                access='sequential',
                fail_on='none',
                memory=True,
                unlimited=True
            )
        
        results = []
        
        for level in levels:
            try:
                # 피라미드 경로 생성 (Grade 필터 또는 개인색 설정인 경우 별도 폴더 사용)
                # 🔥 Grade 필터가 우선순위가 높음
                if grade_filter:
                    # Grade 필터 전용 피라미드 디렉토리
                    grade_suffix = grade_filter.replace(',', '_')
                    pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_grade_{grade_suffix}_{int(level*100)}"
                    logger.debug(f"🎯 [PIPELINE] level={level}: Grade 필터 경로 사용, grade_filter={grade_filter}, dir={pyramid_dir.name}")
                elif personalized and scheme:
                    # 개인색 설정 피라미드 디렉토리
                    from .personal_colors import load_color_legends
                    legends = load_color_legends()
                    scheme_data = legends.get(scheme, {})
                    timestamp = scheme_data.get('lastModified')

                    if timestamp:
                        # scheme/timestamp 폴더 안에 pyramid_{level} 폴더 생성
                        pyramid_dir = config.THUMBNAIL_DIR / scheme / timestamp / f"pyramid_{int(level*100)}"
                    else:
                        # lastModified가 없으면 기존 방식 (하위 호환성)
                        pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{scheme}_{int(level*100)}"

                    # 🔥 개인색 설정이 활성화된 경우 비개인색 경로는 절대 사용하지 않음
                    logger.debug(f"🎨 [PIPELINE] level={level}: 개인색 경로 사용, scheme={scheme}, dir={pyramid_dir.name}")
                else:
                    # 🔥 기본 피라미드 디렉토리
                    pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{int(level*100)}"
                    if personalized and not scheme:
                        logger.warning(f"⚠️ [PIPELINE] level={level}: personalized=True인데 scheme이 None! 비개인색 경로 사용: {pyramid_dir.name}")
                
                # 🔥 디렉토리 생성 안전성 강화
                try:
                    pyramid_dir.mkdir(parents=True, exist_ok=True)
                    if not pyramid_dir.exists():
                        raise OSError(f"디렉토리 생성 실패: {pyramid_dir}")
                except OSError as dir_err:
                    logger.error(f"❌ [PIPELINE] 디렉토리 생성 실패: {pyramid_dir}, 오류: {dir_err}")
                    results.append((level, False, f"DIR_ERROR: {dir_err}"))
                    continue
                
                pyramid_path = pyramid_dir / f"{stem}_L{int(level*100)}.{format_ext}"
                
                # 🔥 개인색 설정이 있으면 캐시 무시하고 항상 재생성
                # (개인색 설정이 바뀌었을 수 있으므로 캐시된 파일을 사용하지 않음)
                if personalized and scheme:
                    # 🔥 개인색 설정이 있으면 비개인색 경로의 캐시 파일 확인 및 삭제
                    non_personalized_dir = config.THUMBNAIL_DIR / f"pyramid_{int(level*100)}"
                    non_personalized_path = non_personalized_dir / f"{stem}_L{int(level*100)}.{format_ext}"
                    if non_personalized_path.exists():
                        try:
                            non_personalized_path.unlink()
                            logger.debug(f"🗑️ [PIPELINE] 비개인색 캐시 파일 삭제: level={level}, path={non_personalized_path}")
                        except Exception as e:
                            logger.warning(f"⚠️ [PIPELINE] 비개인색 캐시 파일 삭제 실패: {e}")
                    
                    # 🔥 개인색 경로의 파일이 있더라도 확인 후 재생성 여부 결정
                    # (타임스탬프가 최신이고 파일이 유효하면 사용, 아니면 재생성)
                    if pyramid_path.exists():
                        try:
                            image_mtime = image_path.stat().st_mtime
                            if pyramid_path.stat().st_mtime >= image_mtime and pyramid_path.stat().st_size > 0:
                                logger.info(f"✅ [PIPELINE] 개인색 캐시 사용: level={level}, scheme={scheme}")
                                results.append((level, True, "EXISTS"))
                                continue
                            else:
                                # 캐시가 오래되었거나 손상된 경우 재생성
                                logger.debug(f"🔄 [PIPELINE] 개인색 캐시 무효 - 재생성: level={level}, scheme={scheme}")
                                try:
                                    pyramid_path.unlink()
                                except Exception:
                                    pass
                        except Exception as e:
                            logger.debug(f"🔄 [PIPELINE] 개인색 캐시 확인 실패 - 재생성: {e}")
                    else:
                        logger.debug(f"🔄 [PIPELINE] 개인색 캐시 없음 - 재생성: level={level}, scheme={scheme}")
                else:
                    # 개인색 설정이 없을 때만 캐시 확인
                    if pyramid_path.exists():
                        try:
                            image_mtime = image_path.stat().st_mtime
                            if pyramid_path.stat().st_mtime >= image_mtime:
                                logger.info(f"⏭️ [PIPELINE SKIP] 이미 존재: level={level}")
                                results.append((level, True, "EXISTS"))
                                continue
                        except Exception:
                            pass
                
                # 레벨 생성
                work_image = original_image
                
                # 레벨에 따른 리사이즈
                if level < 1.0:
                    scale = level
                    new_width = int(original_image.width * scale)
                    new_height = int(original_image.height * scale)
                    
                    # 리사이즈 커널 선택 (BICUBIC 고품질 강제)
                    kernel = pyvips.enums.Kernel.CUBIC
                    
                    work_image = work_image.resize(scale, kernel=kernel)
                
                # 저장
                temp_path = pyramid_path.with_suffix('.tmp')
                
                # 포맷별 저장
                if format_ext == "png":
                    work_image.pngsave(
                        str(temp_path),
                        compression=6,
                        interlace=False,
                        strip=True,
                        effort=1,
                        keep=pyvips.enums.ForeignKeep.NONE,
                    )
                elif format_ext == "webp":
                    work_image.webpsave(
                        str(temp_path),
                        Q=85,
                        lossless=False,
                        effort=1,
                        strip=True,
                        smart_subsample=False,
                    )
                else:  # jpeg
                    # pyvips만 사용 (TurboJPEG 제거)
                    try:
                        work_image.jpegsave(
                            str(temp_path),
                            Q=85,
                            strip=True,
                            optimize_coding=False,     # 속도 우선
                            subsample_mode=1,          # 4:2:0 (가장 빠름)
                            interlace=False,           # 인터레이스 비활성화
                            trellis_quant=False        # 트렐리스 양자화 비활성화
                        )
                    except pyvips.Error as jpeg_err:
                        logger.error(f"❌ [PIPELINE JPEG] 저장 실패: {temp_path}, 오류: {jpeg_err}")
                        # 디렉토리 다시 확인
                        if not temp_path.parent.exists():
                            logger.error(f"❌ [PIPELINE JPEG] 디렉토리 없음: {temp_path.parent}")
                            try:
                                temp_path.parent.mkdir(parents=True, exist_ok=True)
                                work_image.jpegsave(
                                    str(temp_path),
                                    Q=85,
                                    strip=True,
                                    optimize_coding=False,
                                    subsample_mode=1,
                                    interlace=False,
                                    trellis_quant=False
                                )
                            except Exception as retry_err:
                                logger.error(f"❌ [PIPELINE JPEG] 재시도 실패: {retry_err}")
                                results.append((level, False, f"JPEG_SAVE_ERROR: {retry_err}"))
                                continue
                        else:
                            results.append((level, False, f"JPEG_SAVE_ERROR: {jpeg_err}"))
                            continue
                
                # 임시 파일을 최종 파일로 안전하게 이동
                # 이미 파일이 존재하면 스킵 (백그라운드에서 동시 생성 방지)
                if pyramid_path.exists():
                    # 임시 파일만 삭제
                    try:
                        temp_path.unlink()
                    except:
                        pass
                    results.append((level, True, "EXISTS_OTHER"))
                    continue
                
                # 안전한 파일 이동 (원자적 교체)
                try:
                    temp_path.replace(pyramid_path)
                except (PermissionError, OSError) as err:
                    # 권한 오류 시 임시 파일 삭제만 (다른 프로세스가 사용 중일 수 있음)
                    try:
                        temp_path.unlink()
                    except:
                        pass
                    # 파일이 생성 중이거나 사용 중이면 스킵
                    if pyramid_path.exists():
                        results.append((level, True, "EXISTS_LOCKED"))
                    else:
                        raise Exception(f"파일 이동 실패: {err}")
                else:
                    results.append((level, True, "SUCCESS"))
                
            except Exception as e:
                # temp 파일이 남아있으면 정리
                if 'temp_path' in locals() and temp_path.exists():
                    try:
                        temp_path.unlink()
                    except:
                        pass
                logger.warning(f"⚠️ [PIPELINE ERROR] Level {level} 생성 실패: {e}")
                results.append((level, False, str(e)))
        
        return results
        
    except Exception as e:
        logger.error(f"❌ [PIPELINE ERROR] 파이프라인 실패: {e}")
        return [(level, False, str(e)) for level in levels]


@app.get("/api/image/size")
async def get_image_size(path: str):
    """이미지 크기만 빠르게 조회 (메타데이터만)"""
    try:
        # 경로 해석
        if Path(path).is_absolute():
            image_path = Path(path)
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Access denied")
        else:
            image_path = ROOT_DIR / path
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Access denied")
        
        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        
        # pyvips로 빠르게 크기만 조회
        import pyvips
        # VIPS 로그 억제 (set_log_handler는 일부 버전에서만 지원)
        try:
            pyvips.set_log_handler(lambda domain, level, msg: None)
        except AttributeError:
            # set_log_handler가 없는 버전은 무시
            pass
        img = pyvips.Image.new_from_file(str(image_path), access='sequential')
        
        return {
            "width": img.width,
            "height": img.height,
            "path": path
        }
    except Exception as e:
        logger.error(f"이미지 크기 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get image size: {str(e)}")

@app.get("/api/image/crop")
async def get_image_crop(
    request: Request,
    path: str,
    x: int,
    y: int,
    width: int,
    height: int,
    personalized: bool = False,
    scheme: Optional[str] = None
):
    """Chip 영역 이미지 crop (개인색 설정 지원)"""
    try:
        # 🔥 개인색 설정이 활성화되었지만 scheme이 없으면 'change'로 기본값 설정
        if personalized and not scheme:
            scheme = 'change'

        # 🔥 ROOT_DIR 기준으로 경로 해석 (상대 경로 지원)
        if Path(path).is_absolute():
            image_path = Path(path)
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Access denied: Path outside ROOT_DIR")
        else:
            image_path = ROOT_DIR / path
            try:
                image_path.resolve().relative_to(ROOT_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Access denied: Path outside ROOT_DIR")

        if not image_path.exists() or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")

        # pyvips로 이미지 crop
        import pyvips
        try:
            pyvips.set_log_handler(lambda domain, level, msg: None)
        except AttributeError:
            pass

        # 🎨 개인색 설정이 활성화되고 PNG인 경우 PLTE 패치 적용
        if personalized and scheme and image_path.suffix.lower() == '.png':
            try:
                from .personal_colors import plte_inplace_patch_memory

                # 원본 이미지 파일 읽기 및 PLTE 패치
                with open(image_path, 'rb') as f:
                    png_data = bytearray(f.read())

                png_data = plte_inplace_patch_memory(png_data, scheme)

                # PLTE 패치된 PNG를 메모리에서 pyvips로 로드
                img = pyvips.Image.new_from_buffer(bytes(png_data), '', access='sequential')

                # Crop 영역 검증
                if x < 0 or y < 0 or x + width > img.width or y + height > img.height:
                    raise HTTPException(status_code=400, detail="Crop region out of bounds")

                # Crop 수행
                cropped = img.crop(x, y, width, height)

                # PNG로 인코딩하여 반환
                png_buffer = cropped.pngsave_buffer(compression=6, interlace=False, strip=True)

                return Response(
                    content=bytes(png_buffer),
                    media_type="image/png",
                    headers={
                        "Cache-Control": "public, max-age=3600",
                        "X-Personalized": "true",
                        "X-Scheme": scheme
                    }
                )
            except Exception as e:
                logger.warning(f"⚠️ [CHIP CROP PLTE] PLTE 패치 실패, 원본으로 crop: {e}")
                # 폴백: 원본 이미지 사용

        # 일반 crop (개인색 설정 없음 또는 폴백)
        img = pyvips.Image.new_from_file(str(image_path), access='sequential')

        # Crop 영역 검증
        if x < 0 or y < 0 or x + width > img.width or y + height > img.height:
            raise HTTPException(status_code=400, detail="Crop region out of bounds")

        # Crop 수행
        cropped = img.crop(x, y, width, height)

        # PNG로 인코딩하여 반환
        png_buffer = cropped.pngsave_buffer(compression=6, interlace=False, strip=True)

        return Response(
            content=bytes(png_buffer),
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=3600"
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chip crop 실패: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to crop image: {str(e)}")

@app.head("/api/image")
@app.get("/api/image")
async def get_image(
    request: Request,
    path: str,
    level: Optional[float] = None,
    personalized: bool = False,
    scheme: Optional[str] = None,
    grade_filter: Optional[str] = None
):
    try:
        is_head = request.method == "HEAD"
        
        # 🔥 개인색 설정이 활성화되었지만 scheme이 없으면 'change'로 기본값 설정
        if personalized and not scheme:
            scheme = 'change'

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

        # 🔥 최적화: 디버그 로그 제거 (대량 이미지 로드 시 성능 저하 방지)

        # 🎯 피라미드 레벨이 요청된 경우
        if level is not None:
            format_ext = config.PYRAMID_FORMAT.lower()
            content_type = f"image/{format_ext}"
            # 🔥 캐시 히트 시에는 로그 생략 (대량 요청 시 로그 폭주 방지)

            # 레벨 검증
            if level not in config.PYRAMID_LEVELS:
                level = min(config.PYRAMID_LEVELS, key=lambda x: abs(x - level))
                if not is_head:
                    logger.info(f"🎯 [LEVEL FIXED] {level}")

            # 🔥 Grade 필터와 개인색 설정은 동시에 사용할 수 없음
            # Grade 필터가 우선순위가 높음
            if grade_filter:
                # Grade 필터 전용 피라미드 디렉토리
                grade_suffix = grade_filter.replace(',', '_')
                pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_grade_{grade_suffix}_{int(level*100)}"
            elif personalized and scheme:
                # 개인색 설정 피라미드 디렉토리
                from .personal_colors import load_color_legends
                legends = load_color_legends()
                scheme_data = legends.get(scheme, {})
                timestamp = scheme_data.get('lastModified')

                if timestamp:
                    # scheme/timestamp 폴더 안에 pyramid_{level} 폴더 생성
                    pyramid_dir = config.THUMBNAIL_DIR / scheme / timestamp / f"pyramid_{int(level*100)}"
                else:
                    # lastModified가 없으면 기존 방식 (하위 호환성)
                    pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{scheme}_{int(level*100)}"
            else:
                # 기본 피라미드 디렉토리
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

            pyramid_path = pyramid_dir / f"{stem}_L{int(level*100)}.{format_ext}"

            # 🚀 캐시 확인: 이미 존재하고 최신이면 즉시 반환 (개인색 설정 경로 확인)
            image_mtime = image_path.stat().st_mtime
            
            # 🔥 개인색 설정이 활성화된 경우, 비개인색 캐시는 절대 사용하지 않음
            # 개인색 설정이 활성화되어 있으면 반드시 개인색 경로의 파일만 확인
            if personalized and scheme:
                # 🔥 비개인색 경로 확인 (존재하더라도 무시하고 삭제)
                non_personalized_dir = config.THUMBNAIL_DIR / f"pyramid_{int(level*100)}"
                non_personalized_path = non_personalized_dir / f"{stem}_L{int(level*100)}.{format_ext}"
                if non_personalized_path.exists():
                    logger.debug(f"🔍 [CACHE] 비개인색 피라미드 존재하지만 무시: {non_personalized_path}")
                    # 🔥 비개인색 캐시 파일 삭제 (혼동 방지)
                    try:
                        non_personalized_path.unlink()
                        logger.debug(f"🗑️ [CACHE] 비개인색 캐시 파일 삭제: {non_personalized_path}")
                    except Exception as e:
                        logger.warning(f"⚠️ [CACHE] 비개인색 캐시 파일 삭제 실패: {e}")
            
            # 🔥 개인색 설정이 비활성화된 경우, 개인색 경로의 파일은 무시
            if not personalized or not scheme:
                # 개인색 경로 확인 (존재하더라도 무시하고 비개인색 경로만 사용)
                if not is_head:
                    logger.debug(f"🎨 [NON-PERSONALIZED] 개인색 설정 비활성화 - 기본 피라미드 사용")
            
            # 🔥 개인색 설정이 활성화된 경우, 반드시 개인색 경로의 파일만 확인
            # 비개인색 경로의 파일이 있어도 절대 사용하지 않음
            if personalized and scheme:
                # 개인색 경로의 파일만 확인
                if not pyramid_path.exists():
                    # 🔥 개인색 경로에 파일이 없으면 강제로 재생성 (비개인색 캐시 사용 안 함)
                    if not is_head:
                        logger.info(f"🔄 [CACHE] 개인색 경로에 캐시 없음 - 재생성: level={level}, scheme={scheme}")
                elif pyramid_path.stat().st_size > 0 and pyramid_path.stat().st_mtime >= image_mtime:
                    st = pyramid_path.stat()
                    # 🔥 캐시 히트는 debug 레벨로 (대량 요청 시 로그 폭주 방지)
                    if not is_head:
                        logger.debug(f"✅ [CACHE HIT] 파일: {st.st_size/(1024*1024):.1f}MB (personalized={personalized}, scheme={scheme})")

                    headers = {
                        "Cache-Control": "public, max-age=31536000, immutable",
                        "Content-Type": content_type,
                        "ETag": compute_etag(st),
                        "X-Pyramid-Level": str(level),
                        "X-Cache-Status": "HIT",
                        "X-File-Size": str(st.st_size)
                    }
                    response = FileResponse(pyramid_path, headers=headers)
                    return response
            else:
                # 비개인색 설정인 경우: 기존 로직 유지
                if pyramid_path.exists() and pyramid_path.stat().st_size > 0:
                    if pyramid_path.stat().st_mtime >= image_mtime:
                        st = pyramid_path.stat()
                        # 🔥 캐시 히트는 debug 레벨로 (대량 요청 시 로그 폭주 방지)
                        if not is_head:
                            logger.debug(f"✅ [CACHE HIT] 파일: {st.st_size/(1024*1024):.1f}MB (personalized={personalized}, scheme={scheme})")

                        headers = {
                            "Cache-Control": "public, max-age=31536000, immutable",
                            "Content-Type": content_type,
                            "ETag": compute_etag(st),
                            "X-Pyramid-Level": str(level),
                            "X-Cache-Status": "HIT",
                            "X-File-Size": str(st.st_size)
                        }
                        response = FileResponse(pyramid_path, headers=headers)
                        return response

            # 캐시 미스: 피라미드 이미지 생성
            # 🔥 개인색 설정 또는 Grade 필터가 있으면 _generate_pyramid_sync에서 메모리에서 직접 처리
            # (임시 파일 생성 제거, 메모리에서 직접 PLTE 패치 후 pyvips로 로드)
            if not is_head:
                logger.info(f"🎯 [CACHE MISS] 피라미드 생성 시작: level={level}, path={pyramid_path}, personalized={personalized}, scheme={scheme}, grade_filter={grade_filter}")
            _generate_pyramid_sync(image_path, pyramid_path, level, personalized=personalized, scheme=scheme, grade_filter=grade_filter)

            # 🔥 Background에서 다른 레벨들도 생성 시작 (사용자 대기 없음)
            # 개인별 설정 또는 Grade 필터가 활성화된 경우 background에서도 동일한 설정으로 생성
            asyncio.create_task(_generate_other_levels_background(image_path, level, stem, personalized=personalized, scheme=scheme, grade_filter=grade_filter))

            # 생성된 파일 확인 및 반환
            if pyramid_path.exists():
                st = pyramid_path.stat()
                file_size_mb = st.st_size / (1024*1024)
                if not is_head:
                    logger.info(f"✅ [PYRAMID SUCCESS] 파일: {file_size_mb:.1f}MB ({st.st_size:,} bytes)")

                headers = {
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Content-Type": content_type,
                    "ETag": compute_etag(st),
                    "X-Pyramid-Level": str(level),
                    "X-Cache-Status": "MISS",
                    "X-File-Size": str(st.st_size)
                }
                response = FileResponse(pyramid_path, headers=headers)
                return response
            else:
                if not is_head:
                    logger.error(f"❌ [GENERATION FAILED] {pyramid_path}")
                raise HTTPException(status_code=500, detail="Pyramid generation failed")
        else:
            # 원본 이미지 반환 (개인색 설정 적용 또는 Grade 필터링)
            if not is_head:
                logger.info(f"🎯 [ORIGINAL MODE] {image_path} - personalized={personalized}, scheme={scheme}, grade_filter={grade_filter}")

            # 🔥 Grade 필터링이 활성화되고 PNG인 경우 PLTE Grade 필터 적용
            # 개인색 설정을 먼저 적용한 후 Grade 필터 적용
            if grade_filter and image_path.suffix.lower() == '.png':
                try:
                    from .personal_colors import plte_grade_filter_memory, plte_inplace_patch_memory

                    # grade_filter 파싱: "3" 또는 "2,4,7"
                    grade_indices = [int(g.strip()) for g in grade_filter.split(',') if g.strip().isdigit()]

                    if grade_indices:
                        # 1. 원본 이미지 파일 읽기
                        with open(image_path, 'rb') as f:
                            png_data = bytearray(f.read())

                        # 2. 먼저 개인색 설정 적용 (Grade0-7을 인덱스 0-7로 매핑)
                        if personalized and scheme:
                            png_data = plte_inplace_patch_memory(png_data, scheme)
                            if not is_head:
                                logger.info(f"🎨 [GRADE FILTER] 개인색 설정 먼저 적용: scheme={scheme}")

                        # 3. 그 다음 Grade 필터 적용 (인덱스 0-7 필터링)
                        png_data = plte_grade_filter_memory(png_data, grade_indices)

                        # 메모리에서 직접 반환
                        headers = {
                            "Cache-Control": "public, max-age=3600",
                            "Content-Type": "image/png",
                            "X-Grade-Filter": grade_filter
                        }
                        if personalized and scheme:
                            headers["X-Personalized"] = "true"
                            headers["X-Scheme"] = scheme

                        if not is_head:
                            logger.info(f"✅ [GRADE FILTER] Grade {grade_filter} 필터링 완료: {image_path.name}")

                        return Response(content=bytes(png_data), headers=headers, media_type="image/png")
                except Exception as e:
                    logger.warning(f"⚠️ [GRADE FILTER] PLTE 필터 실패, 원본 반환: {e}", exc_info=True)
                    # 폴백: 원본 이미지 반환

            # 🔥 개인색 설정이 활성화되고 PNG인 경우 PLTE 패치 적용 (grade_filter가 없을 때만)
            elif personalized and scheme and image_path.suffix.lower() == '.png':
                try:
                    from .personal_colors import plte_inplace_patch_memory

                    # 원본 이미지 파일 읽기 및 PLTE 패치
                    with open(image_path, 'rb') as f:
                        png_data = bytearray(f.read())

                    png_data = plte_inplace_patch_memory(png_data, scheme)

                    # 메모리에서 직접 반환
                    headers = {
                        "Cache-Control": "public, max-age=3600",
                        "Content-Type": "image/png",
                        "X-Personalized": "true",
                        "X-Scheme": scheme
                    }

                    if not is_head:
                        logger.info(f"✅ [ORIGINAL PLTE] 색 변경 완료: {image_path.name}")

                    return Response(content=bytes(png_data), headers=headers, media_type="image/png")
                except Exception as e:
                    logger.warning(f"⚠️ [ORIGINAL PLTE] PLTE 패치 실패, 원본 반환: {e}", exc_info=True)
                    # 폴백: 원본 이미지 반환
            
            # 일반 원본 이미지 반환
            st = image_path.stat()
            resp_304 = maybe_304(request, st)
            if resp_304: return resp_304
            headers = {
                "Cache-Control": "public, max-age=3600",
                "ETag": compute_etag(st)
            }
            return FileResponse(image_path, headers=headers)

    except Exception as e:
        logger.exception(f"❌ [IMAGE API ERROR] {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/thumbnail")
async def get_thumbnail(
    request: Request,
    path: str,
    size: int = THUMBNAIL_SIZE_DEFAULT,
    personalized: bool = False,
    scheme: Optional[str] = None
):
    try:
        # 🔥 개인색 설정이 활성화되었지만 scheme이 없으면 'change'로 기본값 설정
        if personalized and not scheme:
            scheme = 'change'

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

        # 파일 존재 확인
        if not image_path.exists() or not image_path.is_file():
            logger.warning(f"이미지 파일이 존재하지 않습니다: {image_path}")
            raise HTTPException(status_code=404, detail="Image not found")

        # 이미지 형식 확인
        if not is_supported_image(image_path):
            logger.warning(f"지원하지 않는 이미지 형식: {image_path}")
            raise HTTPException(status_code=415, detail="Unsupported image format")

        try:
            # 기본 썸네일 생성 (개인색 설정 포함)
            thumb = await generate_thumbnail(image_path, (size, size), personalized=personalized, scheme=scheme)
            if thumb and thumb.exists():
                st = thumb.stat()
                resp_304 = maybe_304(request, st)
                if resp_304: return resp_304
                
                # 🔥 FileResponse 대신 메모리에서 직접 응답 (Content-Length 오류 방지)
                try:
                    content = thumb.read_bytes()
                    content_type = "image/jpeg" if thumb.suffix.lower() in ['.jpg', '.jpeg'] else "image/png"
                    headers = {
                        "Cache-Control": "public, max-age=604800, immutable",
                        "ETag": compute_etag(st),
                        "Content-Length": str(len(content))
                    }
                    return Response(content=content, media_type=content_type, headers=headers)
                except Exception as read_error:
                    logger.warning(f"썸네일 읽기 실패, FileResponse 폴백: {read_error}")
                    return FileResponse(thumb, headers={"Cache-Control": "public, max-age=604800, immutable", "ETag": compute_etag(st)})
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
        
        # Batch thumbnail generation (async fan-out)
        max_batch = min(len(valid_paths), 64)
        targets = valid_paths[:max_batch]

        async def _generate(path_str: str) -> Dict[str, Any]:
            try:
                image_path = Path(path_str)
                thumb = await generate_thumbnail(image_path, (preload_req.size, preload_req.size))
                return {
                    "path": path_str,
                    "success": thumb is not None and thumb.exists(),
                    "thumbnail": str(thumb) if thumb else None
                }
            except Exception as e:
                return {
                    "path": path_str,
                    "success": False,
                    "error": str(e)
                }

        if not targets:
            results: List[Dict[str, Any]] = []
        else:
            results = await asyncio.gather(*(_generate(path_str) for path_str in targets))

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


@app.get("/api/index/status")
async def get_index_status():
    return index_service.status()

@app.get("/api/search")
async def search_files(q: str = Query("", description="파일명 검색(대소문자 무시, 부분일치)"),
                       limit: int = Query(3000, ge=1, le=10000),
                       offset: int = Query(0, ge=0),
                       lot_multi: Optional[str] = Query(None, alias="lot_multi"),
                       folder: Optional[str] = Query(None, description="검색할 폴더 경로 (ROOT_DIR 기준 상대경로, 하위폴더 포함)")):
    """
    파일 검색 API
    
    - q: 검색어 (파일명 검색, AND/OR/NOT 논리 연산 지원)
    - limit: 최대 결과 수 (기본 3000, 최대 10000)
    - offset: 결과 오프셋 (페이지네이션용)
    - lot_multi: LOT 필터 (쉼표로 구분된 LOT 목록)
    - folder: 검색 폴더 경로 (지정 시 해당 폴더와 모든 하위 폴더 검색, 미지정 시 전체 검색)
    """
    try:
        global current_folder
        THUMB_STAT_CACHE.clear()
        lot_filter_values = _parse_lot_filter(lot_multi)
        lot_filter = set(lot_filter_values) if lot_filter_values else set()
        if lot_multi:
            logger.info(f"LOT_MULTI 원본: {lot_multi}, 파싱 결과: {lot_filter_values}, 개수: {len(lot_filter_values)}")
        
        # 🔥 folder 파라미터 처리
        # - folder가 None이면: current_folder 사용 (기존 동작)
        # - folder가 빈 문자열("")이면: ROOT_DIR 전체 검색 (명시적 전체 검색)
        # - folder가 경로이면: 해당 폴더와 하위 폴더 검색
        if folder is not None:
            if folder == "":
                # 🔥 빈 문자열은 명시적으로 전체 검색 요청
                search_root = ROOT_DIR
                logger.info(f"[SEARCH] folder='' → ROOT_DIR 전체 검색")
            else:
                folder_path = safe_resolve_path(folder)
                if folder_path.exists() and folder_path.is_dir():
                    search_root = folder_path
                    logger.info(f"[SEARCH] folder 파라미터 지정: {folder} → {search_root}")
                else:
                    logger.warning(f"[SEARCH] 잘못된 folder 경로: {folder}, 전체 검색으로 폴백")
                    search_root = ROOT_DIR
        else:
            # folder 미지정 시 current_folder 또는 ROOT_DIR (전체 검색)
            search_root = current_folder if current_folder.exists() else ROOT_DIR
        
        result = await search_service.search(
            query=q or "",
            lot_filter=lot_filter,
            limit=limit,
            offset=offset,
            current_folder=search_root,
        )
        return result
    except Exception as e:
        logger.exception(f"검색 중 오류: {e}")
        raise HTTPException(status_code=500, detail=str(e))
@app.get("/api/files/all")
async def get_all_files():
    try:
        with FILE_INDEX_LOCK:
            keys = list(FILE_INDEX_KEYS)
        if not keys and not index_service.building:
            asyncio.create_task(index_service.build(force=True, allow_background=True))
        return {"success": True, "files": keys}
    except Exception as e:
        logger.exception(f"전체 파일 목록 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/recursive")
async def get_files_recursive(path: str):
    """폴더 내 모든 파일을 재귀적으로 가져오기 (ROOT_DIR 기준 절대 경로, 파일명 정렬)"""
    try:
        target = safe_resolve_path(path)
        if not target.exists() or not target.is_dir():
            raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")

        files = []
        for root, dirs, filenames in os.walk(target):
            # SKIP_DIRS 제외
            for skip in list(SKIP_DIRS):
                if skip in dirs:
                    dirs.remove(skip)
            # classification, thumbnails, composite_map 제외
            dirs[:] = [d for d in dirs if d not in ['classification', 'thumbnails', 'composite_map']]

            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in SUPPORTED_EXTENSIONS:
                    continue

                full_path = Path(root) / fn
                try:
                    # ROOT_DIR 기준 절대 경로
                    rel_to_root = full_path.relative_to(ROOT_DIR)
                    root_relative = str(rel_to_root).replace('\\', '/')
                    files.append(root_relative)
                except ValueError:
                    continue

        # 🔥 파일명 기준 정렬 (대소문자 구분 없이)
        files.sort(key=lambda x: x.split('/')[-1].lower())

        return {"success": True, "files": files}
    except Exception as e:
        logger.exception(f"재귀 파일 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Classes ----------------
@app.get("/api/classes")
async def get_classes(mode: str = Query("wafer", pattern="^(wafer|chip)$", description="wafer 또는 chip 모드")):
    try:
        classification_dir = _classification_dir(mode=mode)
        # 디버그 로그 제거 (너무 자주 출력됨)
        # logger.info(f"🔍 [/api/classes] mode={mode}, current_folder={current_folder}, classification_dir={classification_dir}")

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
            # 디버그 로그 제거 (너무 자주 출력됨)
            # logger.info(f"✅ [/api/classes] 클래스 조회 완료: {len(classes)}개 ({classes})")
        except FileNotFoundError:
            logger.warning(f"⚠️ [/api/classes] FileNotFoundError - classification_dir: {classification_dir}")
            pass
        return {"success": True, "classes": sorted(classes, key=str.lower)}
    except Exception as e:
        logger.exception(f"분류 클래스 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classes")
async def create_class(request: Request,
                      req: CreateClassReq,
                      mode: str = Query("wafer", pattern="^(wafer|chip)$", description="wafer 또는 chip 모드"),
                      _=Depends(labels_classes_sync_dep)):
    try:
        # 권한 검사: 클래스 관리 권한 필요
        _check_folder_permission(request, "*", "CLASS_MANAGE")

        name = req.name.strip()
        if not name or name.isspace(): raise HTTPException(status_code=400, detail="클래스명이 비어있습니다")
        if any(ord(c) < 32 or ord(c) > 126 for c in name):
            raise HTTPException(status_code=400, detail="클래스명에 특수문자/한글 자모 사용 불가 (A-Z,a-z,0-9,_,-)")
        if not _CLASS_NAME_RE.match(name): raise HTTPException(status_code=400, detail="클래스명 형식 오류")
        if len(name) > 50: raise HTTPException(status_code=400, detail="클래스명이 너무 깁니다 (최대 50자)")

        classification_dir = _classification_dir(mode=mode)

        # classification 디렉토리가 없으면 생성
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)

        class_dir = classification_dir / name

        if class_dir.exists(): raise HTTPException(status_code=409, detail="Class already exists")

        class_dir.mkdir(parents=True, exist_ok=False)
        _sync_labels_if_classes_changed()
        for p in (classification_dir, class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()
        log_access_row(tag="INFO", note=f"클래스 '{name}' 생성 완료")
        return {"success": True, "class": name, "refresh_required": True, "message": f"클래스 '{name}' 생성됨"}
    except Exception as e:
        logger.exception(f"클래스 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/classes/{class_name}")
async def delete_class(request: Request,
                       class_name: str = PathParam(..., min_length=1, max_length=128),
                       force: bool = Query(False, description="True면 내용 포함 통째 삭제"),
                       mode: str = Query("wafer", pattern="^(wafer|chip)$", description="wafer 또는 chip 모드"),
                       _=Depends(labels_classes_sync_dep)):
    try:
        # 권한 검사: 클래스 관리 권한 필요
        _check_folder_permission(request, "*", "CLASS_MANAGE")

        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")
        classification_dir = _classification_dir(mode=mode)
        class_dir = classification_dir / class_name
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
        for p in (classification_dir, class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()
        log_access_row(tag="INFO", note=f"클래스 '{class_name}' 삭제 완료")
        return {"success": True, "deleted": class_name, "force": force, "labels_cleaned": removed_cnt, "refresh_required": True}
    except Exception as e:
        logger.exception(f"클래스 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class RenameClassReq(BaseModel):
    old_name: str = Field(..., min_length=1, max_length=128)
    new_name: str = Field(..., min_length=1, max_length=128)

@app.post("/api/classes/rename")
async def rename_class(request: Request,
                       req: RenameClassReq,
                       mode: str = Query("wafer", pattern="^(wafer|chip)$", description="wafer 또는 chip 모드"),
                       _=Depends(labels_classes_sync_dep)):
    try:
        # 권한 검사: 클래스 관리 권한 필요
        _check_folder_permission(request, "*", "CLASS_MANAGE")

        old_name = req.old_name.strip()
        new_name = req.new_name.strip()

        # 검증
        if not _CLASS_NAME_RE.match(old_name): raise HTTPException(status_code=400, detail="Invalid old class name")
        if not _CLASS_NAME_RE.match(new_name): raise HTTPException(status_code=400, detail="Invalid new class name")
        if old_name == new_name: raise HTTPException(status_code=400, detail="Old and new names are the same")

        classification_dir = _classification_dir(mode=mode)
        old_class_dir = classification_dir / old_name
        new_class_dir = classification_dir / new_name

        # 존재 확인
        if not old_class_dir.exists() or not old_class_dir.is_dir():
            raise HTTPException(status_code=404, detail="Old class not found")
        if new_class_dir.exists():
            raise HTTPException(status_code=409, detail="New class name already exists")

        # 폴더 이름 변경
        old_class_dir.rename(new_class_dir)

        # labels.json에서 라벨 이름 변경
        renamed_count = 0
        with LABELS_LOCK:
            for img_path, labels in list(LABELS.items()):
                if old_name in labels:
                    labels = [new_name if lbl == old_name else lbl for lbl in labels]
                    LABELS[img_path] = labels
                    renamed_count += 1

        _labels_save()
        _labels_load()

        # 캐시 무효화
        for p in (classification_dir, old_class_dir, new_class_dir, ROOT_DIR): _dircache_invalidate(p)
        DIRLIST_CACHE.clear()

        log_access_row(tag="INFO", note=f"클래스 '{old_name}' → '{new_name}' 이름 변경 완료 ({renamed_count}개 이미지)")
        return {"success": True, "old_name": old_name, "new_name": new_name, "renamed_count": renamed_count, "refresh_required": True}
    except Exception as e:
        logger.exception(f"클래스 이름 변경 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class DeleteClassesReq(BaseModel):
    names: List[str] = Field(..., min_items=1)

@app.post("/api/classes/delete")
async def delete_classes(req: DeleteClassesReq,
                         mode: str = Query("wafer", pattern="^(wafer|chip)$", description="wafer 또는 chip 모드"),
                         _=Depends(labels_classes_sync_dep)):
    try:
        if not req.names: raise HTTPException(status_code=400, detail="클래스명 목록이 비어있습니다")
        classification_dir = _classification_dir(mode=mode)
        deleted, failed, total_cleaned = [], [], 0
        for class_name in req.names:
            try:
                class_name = class_name.strip()
                if not _CLASS_NAME_RE.match(class_name): raise ValueError("Invalid class name")
                class_dir = classification_dir / class_name
                logger.info(f"🔍 [DELETE_CLASS] class_dir: {class_dir}, exists: {class_dir.exists()}")
                if not class_dir.exists() or not class_dir.is_dir(): raise FileNotFoundError("Class not found")
                shutil.rmtree(class_dir); deleted.append(class_name)
                total_cleaned += _remove_label_from_all_images(class_name)
            except Exception as e:
                failed.append({"class": class_name, "error": str(e)})
                logger.exception(f"클래스 {class_name} 삭제 실패: {e}")
        if total_cleaned > 0: _labels_load()
        _dircache_invalidate(classification_dir)
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
                       mode: str = Query("wafer", regex="^(wafer|chip)$", description="wafer 또는 chip 모드")):
    try:
        # 디버그 로그 제거 (너무 자주 출력됨)
        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")

        classification_base = _classification_dir(mode=mode)
        class_dir = classification_base / class_name

        if not class_dir.exists() or not class_dir.is_dir():
            logger.warning(f"⚠️ [/api/classes/{{class_name}}/images] class_dir 없음 또는 디렉토리 아님: {class_dir}")
            raise HTTPException(status_code=404, detail="Class not found")

        found: List[str] = []; goal = offset + limit
        for p in class_dir.rglob("*"):
            if p.is_file() and is_supported_image(p):
                rel = str(p.relative_to(ROOT_DIR)).replace("\\", "/")
                found.append(rel)
                if len(found) >= goal: break

        # 디버그 로그 제거 (너무 자주 출력됨)
        # logger.info(f"✅ [/api/classes/{{class_name}}/images] 이미지 조회 완료: {len(found)}개 (offset={offset}, limit={limit})")
        return {"success": True, "class": class_name, "results": found[offset: offset + limit], "offset": offset, "limit": limit}
    except HTTPException:
        raise
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
async def get_labels(image_path: str):
    try:
        _labels_reload_if_stale()  # 📖 조회 API: labels.json 파일만 리로드
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

@app.get("/api/stats/department")
async def get_department_stats():
    """부서별 사용자 분포 및 활동량 통계 - 실제 stats.json 데이터 사용"""
    try:
        # 실제 stats.json 데이터에서 부서별 통계 생성
        department_data = logger_instance.get_department_stats()
        return department_data
    except Exception as e:
        logger.error(f"부서 통계 생성 실패: {e}")
        return {"departments": {}, "activity": {}}

@app.get("/api/stats/export-csv")
async def export_detail_access_csv():
    """detail_access.csv 파일 다운로드"""
    csv_path = Path("logs/detail_access.csv")
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="CSV file not found")
    return FileResponse(
        path=str(csv_path),
        media_type="text/csv; charset=utf-8",
        filename="detail_access.csv",
        headers={
            "Content-Disposition": "attachment; filename=detail_access.csv"
        }
    )

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
async def classify_images(req: Request,
                         request: ClassifyRequest,
                         _=Depends(labels_classes_sync_dep)):
    """이미지를 클래스로 분류하고 classification 디렉토리에 복사/링크"""
    try:
        mode = request.mode

        # classification 경로가 들어오면 원본 상대경로로 역매핑 시도
        rel_path = _lookup_original_relpath_from_classification_path(request.image_path) or relkey_from_any_path(request.image_path)
        abs_path = ROOT_DIR / rel_path
        if not abs_path.exists() or not abs_path.is_file():
            raise HTTPException(status_code=404, detail="Image not found")
        if not is_supported_image(abs_path):
            raise HTTPException(status_code=400, detail="Unsupported image format")

        # 권한 검사: 이미지가 속한 폴더에 대한 라벨 쓰기 권한 필요
        folder_path = str(Path(rel_path).parent)
        _check_folder_permission(req, folder_path, "LABEL_WRITE")
        
        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")
            
        # 클래스 디렉토리 생성
        classification_dir = _classification_dir(mode=mode)
        class_dir = classification_dir / class_name
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
    mode: Literal["wafer", "chip"] = "wafer"

class ChipCoord(BaseModel):
    x_abs: int
    y_abs: int

class ChipClassifyRequest(BaseModel):
    class_name: str
    image_path: str
    chip_coords: List[ChipCoord]
    folder_prefix: Optional[str] = None

@app.post("/api/classify/batch")
async def classify_images_batch(request: BatchClassifyRequest,
                                _=Depends(labels_classes_sync_dep)):
    """배치 이미지 분류"""
    batch_start_time = time.perf_counter()
    try:
        mode = request.mode

        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")

        # 클래스 디렉토리 생성
        classification_dir = _classification_dir(mode=mode)
        class_dir = classification_dir / class_name
        class_dir.mkdir(parents=True, exist_ok=True)
        
        # 🔥 성능 최적화: 드라이브 체크는 한 번만 수행
        class_dir_dev = class_dir.stat().st_dev
        
        results = []
        errors = []
        labels_batch_update = {}  # 🔥 배치 업데이트용 딕셔너리
        
        lookup_time = 0
        file_check_time = 0
        link_time = 0
        
        for image_path in request.images:
            try:
                # 🔥 경로 조회 최적화 - 분류 작업은 classification 경로 조회 불필요 (너무 느림)
                lookup_start = time.perf_counter()
                # _lookup_original_relpath_from_classification_path는 FILE_INDEX 전체 순회로 매우 느림
                # 분류 작업은 이미 원본 파일 경로이므로 relkey_from_any_path만 사용
                rel_path = relkey_from_any_path(image_path)
                lookup_time += time.perf_counter() - lookup_start
                
                abs_path = ROOT_DIR / rel_path
                
                # 🔥 파일 체크 최적화
                check_start = time.perf_counter()
                if not abs_path.exists() or not abs_path.is_file():
                    errors.append(f"{rel_path}: 파일 없음")
                    file_check_time += time.perf_counter() - check_start
                    continue
                    
                if not is_supported_image(abs_path):
                    errors.append(f"{rel_path}: 지원하지 않는 형식")
                    file_check_time += time.perf_counter() - check_start
                    continue
                file_check_time += time.perf_counter() - check_start
                
                # 대상 파일 경로
                target_file = class_dir / abs_path.name
                
                # 🔥 파일 복사/하드링크 최적화 - 간결한 로직
                link_start = time.perf_counter()
                # 이미 존재하면 스킵 (stat 체크 제거)
                if target_file.exists():
                    pass  # 파일이 이미 있으면 아무 작업 안 함
                else:
                    try:
                        # 같은 드라이브면 하드링크, 아니면 복사
                        if abs_path.stat().st_dev == class_dir_dev:
                            os.link(str(abs_path), str(target_file))
                        else:
                            shutil.copy2(abs_path, target_file)
                    except (OSError, PermissionError):
                        shutil.copy2(abs_path, target_file)
                link_time += time.perf_counter() - link_start
                
                # 🔥 라벨 배치 업데이트 (락 없이 임시 저장)
                labels_batch_update[rel_path] = class_name
                results.append(rel_path)
                
            except Exception as e:
                errors.append(f"{image_path}: {str(e)}")
        
        # 🔥 라벨 배치 업데이트 (락 한 번만 획득)
        label_update_start = time.perf_counter()
        if labels_batch_update:
            with LABELS_LOCK:
                for rel_path, cls_name in labels_batch_update.items():
                    cur_labels = set(LABELS.get(rel_path, []))
                    cur_labels.add(cls_name)
                    LABELS[rel_path] = sorted(cur_labels)
        label_update_time = time.perf_counter() - label_update_start
        
        # 🔥 파일 저장 및 캐시 무효화 (간결한 로직)
        save_start = time.perf_counter()
        if results:
            _labels_save()
            _dircache_invalidate(class_dir)
        save_time = time.perf_counter() - save_start
        
        batch_total_time = time.perf_counter() - batch_start_time
        
        # 🔥 성능 로그
        logger.info(f"⚡ [BATCH_PERF] 총 {len(request.images)}개 처리 - "
                   f"총 시간: {batch_total_time*1000:.1f}ms, "
                   f"경로조회: {lookup_time*1000:.1f}ms, "
                   f"파일체크: {file_check_time*1000:.1f}ms, "
                   f"링크생성: {link_time*1000:.1f}ms, "
                   f"라벨업데이트: {label_update_time*1000:.1f}ms, "
                   f"저장: {save_time*1000:.1f}ms")
        
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

@app.post("/api/classify/chips")
async def classify_chips(request: ChipClassifyRequest,
                         req: Request,
                         _=Depends(labels_classes_sync_dep)):
    """Chip 크롭 및 분류"""
    chip_start_time = time.perf_counter()
    try:
        username = _current_username(req, default="system")

        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")

        # 🔥 Chip classification 폴더 사용
        class_dir = _classification_dir(mode="chip") / class_name
        class_dir.mkdir(parents=True, exist_ok=True)

        # 원본 이미지 경로
        rel_path = relkey_from_any_path(request.image_path)
        wafer_path = ROOT_DIR / rel_path
        rel_path_obj = Path(rel_path)
        folder_key = _chip_annotation_folder_key(rel_path_obj, folder_prefix=request.folder_prefix)

        if not wafer_path.exists() or not wafer_path.is_file():
            raise HTTPException(status_code=404, detail="Wafer image not found")

        # positions.json 파일 찾기
        wafer_stem = wafer_path.stem
        positions_path = _resolve_positions_path(rel_path_obj)

        if not positions_path.exists():
            raise HTTPException(status_code=404, detail="Positions file not found")

        # positions.json 로드
        with open(positions_path, 'r', encoding='utf-8') as f:
            positions_data = json.load(f)

        chips = positions_data.get('chips', [])

        # Wafer 이미지 로드
        wafer_img = Image.open(wafer_path)

        # 이미지 파일명 (확장자 제외)
        wafer_name = wafer_path.stem

        saved_count = 0
        errors = []
        chip_updates: List[Dict[str, Any]] = []

        # 각 chip 크롭 및 저장
        for chip_coord in request.chip_coords:
            try:
                # chip 좌표로 칩 찾기
                chip = None
                for c in chips:
                    if c.get('x_abs') == chip_coord.x_abs and c.get('y_abs') == chip_coord.y_abs:
                        chip = c
                        break

                if not chip:
                    errors.append(f"Chip ({chip_coord.x_abs}, {chip_coord.y_abs}) not found in positions")
                    continue

                # rect 정보 가져오기
                rect = chip.get('rect')
                if not rect:
                    errors.append(f"Chip ({chip_coord.x_abs}, {chip_coord.y_abs}) has no rect info")
                    continue

                x0, y0 = rect['x0'], rect['y0']
                x1, y1 = rect['x1'], rect['y1']

                # 칩 크롭
                chip_img = wafer_img.crop((x0, y0, x1, y1))

                # 파일명 생성: 원본파일명_x{x}_y{y}.png
                chip_filename = f"{wafer_name}_x{abs(chip_coord.x_abs)}_y{abs(chip_coord.y_abs)}.png"
                chip_path = class_dir / chip_filename

                # 저장
                chip_img.save(chip_path, format='PNG')
                saved_count += 1
                chip_updates.append({
                    "x_abs": chip_coord.x_abs,
                    "y_abs": chip_coord.y_abs,
                    "class_name": class_name,
                    "filename": chip_filename
                })

                # 🔥 라벨 추가 (chip 파일 경로는 classification 하위에만 있음)
                chip_rel_path = str(chip_path.relative_to(ROOT_DIR)).replace("\\", "/")
                with LABELS_LOCK:
                    cur_labels = set(LABELS.get(chip_rel_path, []))
                    cur_labels.add(class_name)
                    LABELS[chip_rel_path] = sorted(cur_labels)

            except Exception as e:
                errors.append(f"Chip ({chip_coord.x_abs}, {chip_coord.y_abs}): {str(e)}")

        # 라벨 저장
        if saved_count > 0:
            _labels_save()
            _dircache_invalidate(class_dir)
            _upsert_chip_annotations(rel_path_obj, folder_key, chip_updates, username=username)

        chip_time = time.perf_counter() - chip_start_time
        log_access_row(tag="ACTION", note=f"Chip 분류: {saved_count}개 성공, {len(errors)}개 실패 -> {class_name} (소요시간: {chip_time*1000:.1f}ms)")

        return {
            "success": True,
            "class": class_name,
            "saved_count": saved_count,
            "errors": errors,
            "error_count": len(errors)
        }

    except Exception as e:
        logger.exception(f"Chip 분류 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/classify/chips/{wafer_name}")
async def get_chip_labels(
    wafer_name: str,
    path: Optional[str] = Query(None),
    folder: Optional[str] = Query(None)
):
    """특정 wafer의 chip 라벨 조회"""
    try:
        if path:
            rel_path = _get_relative_path_from_image(path)
            rel_path_obj = Path(rel_path)
            folder_key = _chip_annotation_folder_key(rel_path_obj, folder_prefix=folder)
            _, _, entry = _load_annotation_entry(rel_path_obj, folder_key)
            return {"chips": entry.get("marked_chips", [])}

        # 🔥 Chip classification 폴더 사용
        classification_dir = _classification_dir(mode="chip")
        if not classification_dir.exists():
            return {"chips": []}

        chip_labels = []

        # 모든 클래스 폴더 순회
        for class_dir in classification_dir.iterdir():
            if not class_dir.is_dir():
                continue

            class_name = class_dir.name
            pattern = f"{wafer_name}_x*_y*.png"

            for chip_file in class_dir.glob(pattern):
                try:
                    parsed = _parse_chip_filename(chip_file.stem)
                    if not parsed:
                        continue
                    wafer_stem, x_abs, y_abs = parsed
                    if wafer_stem != wafer_name:
                        continue

                    chip_labels.append({
                        "x_abs": x_abs,
                        "y_abs": y_abs,
                        "class": class_name,
                        "filename": chip_file.name
                    })
                except Exception as e:
                    logger.warning(f"Failed to parse chip filename {chip_file.name}: {e}")
                    continue

        return {"chips": chip_labels}

    except Exception as e:
        logger.exception(f"Chip 라벨 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/classify")
async def delete_classification(request: ClassifyDeleteRequest,
                                req: Request,
                                _=Depends(labels_classes_sync_dep)):
    """classification 디렉토리에서 이미지 제거"""
    try:
        mode = request.mode
        username = _current_username(req, default="system")

        class_name = request.class_name.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")
            
        classification_dir = _classification_dir(mode=mode)
        class_dir = classification_dir / class_name
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
        try:
            classification_rel_path = str(target_file.relative_to(ROOT_DIR)).replace("\\", "/")
        except ValueError:
            classification_rel_path = target_file.as_posix()
        
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

        if mode == "chip":
            _remove_chip_annotations_from_classification_path(
                classification_rel_path,
                class_name=class_name,
                filename=target_file.name,
                username=username,
            )
        
        log_access_row(tag="ACTION", note=f"분류 제거: {rel_path} from {class_name}")
        
        return {"success": True, "removed": str(target_file.relative_to(ROOT_DIR)), "class": class_name}
        
    except Exception as e:
        logger.exception(f"분류 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# 프런트엔드가 사용하는 엔드포인트: POST /api/classify/delete
@app.post("/api/classify/delete")
async def classify_delete_batch(request: ClassifyDeleteBatchReq,
                                req: Request,
                                _=Depends(labels_classes_sync_dep)):
    try:
        mode = request.mode
        username = _current_username(req, default="system")

        class_name = request.class_.strip()
        if not class_name or not _CLASS_NAME_RE.match(class_name):
            raise HTTPException(status_code=400, detail="Invalid class name")

        classification_dir = _classification_dir(mode=mode)
        class_dir = classification_dir / class_name
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
                try:
                    classification_rel_path = str(target_file.relative_to(ROOT_DIR)).replace("\\", "/")
                except ValueError:
                    classification_rel_path = target_file.as_posix()
                with LABELS_LOCK:
                    labels = set(LABELS.get(rel_path, []))
                    if class_name in labels:
                        labels.discard(class_name)
                        LABELS[rel_path] = sorted(labels) if labels else LABELS.pop(rel_path, None) or []
                if mode == "chip":
                    _remove_chip_annotations_from_classification_path(
                        classification_rel_path,
                        class_name=class_name,
                        filename=target_file.name,
                        username=username,
                    )
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
app.mount("/logs", StaticFiles(directory="logs"), name="logs")
app.mount("/static", StaticFiles(directory="."), name="static")
# NOTE: /logs, /static 노출은 내부 환경 전제. 공개 서비스에서는 제거/인증 필요.

@app.get("/")
async def read_root(request: Request):
    try:
        # AUTO_LOGIN=True일 때: SAML 인증 완료 후가 아니면 무조건 /saml/login으로 리다이렉트
        # 이렇게 하면 index.html 로드 전에 인증이 완료됨
        if AUTO_LOGIN:
            if not request.query_params.get("saml_success"):
                logger.info("🔐 [AUTO_LOGIN] SAML 인증 미완료 → /saml/login으로 리다이렉트")
                return RedirectResponse("/saml/login", status_code=302)

            # SAML 인증 완료 후 → index.html 제공
            logger.info("✅ [AUTO_LOGIN] SAML 인증 완료 → index.html 제공")

        # AUTO_LOGIN=False 또는 SAML 인증 완료 → index.html 제공
        html_path = Path("index.html")
        if html_path.exists():
            # HTML에 캐시 헤더만 추가 (preload 제거로 경고 해결)
            headers = {
                "Cache-Control": "public, max-age=3600"
            }
            return FileResponse(html_path, headers=headers)
        return {"message": "index.html not found"}
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
    # 🔥 ROOT_DIR 기준 상대 경로 계산
    try:
        rel_path = str(current_folder.resolve().relative_to(ROOT_DIR.resolve())).replace('\\', '/')
        # 상대 경로가 있으면 뒤에 / 추가
        current_folder_prefix = rel_path + '/' if rel_path and rel_path != '.' else ''
    except ValueError:
        # ROOT_DIR 외부이면 빈 값
        current_folder_prefix = ''
    
    return {
        "current_folder": str(current_folder),
        "current_folder_prefix": current_folder_prefix  # 파일 경로 앞에 붙일 접두사
    }

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
        index_service.clear()
        try:
            INDEX_CACHE_FILE.unlink(missing_ok=True)  # type: ignore[arg-type]
        except Exception:
            pass
        
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
        
        # 🔥 ROOT_DIR과 THUMBNAIL_DIR은 절대 변경하지 않음
        # 썸네일과 라벨은 원래 ROOT_DIR 기준으로 관리

        DIRLIST_CACHE.clear();  THUMB_STAT_CACHE.clear()
        # 인덱스는 ROOT_DIR 기준이므로 유지 (폴더 변경 시 재사용)

        classification_dir = _classification_dir()
        if not classification_dir.exists():
            classification_dir.mkdir(parents=True, exist_ok=True)
            log_access_row(tag="INFO", note=f"새 폴더의 classification 폴더 생성: {classification_dir}")

        _labels_load()
        
        # 🔥 ROOT_DIR 기준 상대 경로 계산 (파일 경로 접두사)
        try:
            rel_path = str(current_folder.resolve().relative_to(ROOT_DIR.resolve())).replace('\\', '/')
            current_folder_prefix = rel_path + '/' if rel_path and rel_path != '.' else ''
        except ValueError:
            current_folder_prefix = ''
        
        return {
            "success": True, 
            "message": f"검색 폴더가 '{new_path}'로 변경되었습니다", 
            "root_dir": str(ROOT_DIR),
            "current_folder": str(current_folder),
            "current_folder_prefix": current_folder_prefix
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
        
        # 🔥 1depth 폴더 수집
        skip_dir_names = {'classification', 'classification_chips', 'thumbnails', 'labels'}
        skip_dir_names.update(SKIP_DIRS)

        try:
            with os.scandir(target_path) as it:
                for entry in it:
                    if (
                        entry.is_dir(follow_symlinks=False)
                        and not entry.name.startswith('.')
                        and entry.name not in skip_dir_names
                    ):
                        folders.append({
                            "name": entry.name,
                            "path": str(entry.path),
                            "type": "folder",
                            "depth": 1,
                            "entry": entry  # 2depth 스캔을 위해 entry 전달
                        })
        except PermissionError:
            raise HTTPException(status_code=403, detail="폴더 접근 권한이 없습니다")
        
        # 🔥 2depth 폴더 병렬 처리 (워커 여러 개 사용)
        def scan_2depth(entry_info):
            try:
                subfolders_list = []
                with os.scandir(entry_info["path"]) as sub_it:
                    for sub_entry in sub_it:
                        if (
                            sub_entry.is_dir(follow_symlinks=False)
                            and not sub_entry.name.startswith('.')
                            and sub_entry.name not in skip_dir_names
                        ):
                            subfolders_list.append({
                                "name": f"{entry_info['name']} / {sub_entry.name}", 
                                "path": str(sub_entry.path), 
                                "type": "folder", 
                                "depth": 2,
                                "parent": entry_info['name']
                            })
                return subfolders_list
            except PermissionError:
                return []  # 하위 폴더 접근 권한이 없으면 빈 리스트 반환
            except Exception as e:
                logger.debug(f"2depth 스캔 오류 ({entry_info['name']}): {e}")
                return []
        
        # 🔥 ThreadPoolExecutor로 병렬 처리 (SEARCH_WORKERS 사용)
        with ThreadPoolExecutor(max_workers=config.SEARCH_WORKERS) as executor:
            results = executor.map(scan_2depth, folders)
            for subfolder_list in results:
                subfolders.extend(subfolder_list)
        
        # 🔥 1depth 폴더에서 entry 제거 (반환 시 불필요)
        for folder in folders:
            folder.pop("entry", None)

        # 🔥 모든 폴더를 이름 내림차순으로 정렬 (depth 무관)
        all_folders = folders + subfolders
        all_folders.sort(key=lambda x: x["name"].lower(), reverse=True)
        
        return {"folders": all_folders}
    except Exception as e:
        logger.error(f"폴더 브라우징 실패: {e}")
        raise HTTPException(status_code=500, detail=f"폴더 브라우징 실패: {str(e)}")

# ======================== Chip Annotation APIs ========================

def _get_relative_path_from_image(image_path: str) -> str:
    """이미지 경로에서 ROOT_DIR 기준 상대 경로 추출

    classification 경로가 오면 원본 경로로 역매핑
    """
    # 🔬 classification 경로면 원본 경로로 변환
    original_rel = _lookup_original_relpath_from_classification_path(image_path)
    if original_rel:
        return original_rel

    # 일반 경로 처리
    img_path = Path(image_path)
    try:
        rel_path = img_path.relative_to(ROOT_DIR)
    except ValueError:
        # ROOT_DIR 외부 경로면 이미 상대 경로일 수 있음
        rel_path = Path(image_path)
    return str(rel_path).replace("\\", "/")

_CHIP_ANNOTATION_VERSION = 2
_CHIP_ANNOTATION_VERSION_KEY = "_version"
_CHIP_ANNOTATION_DEFAULT_FOLDER = "."

def _folder_key_from_prefix(folder_prefix: Optional[str]) -> Optional[str]:
    if folder_prefix is None:
        return None
    cleaned = str(folder_prefix).strip()
    cleaned = cleaned.replace("\\", "/")
    cleaned = cleaned.strip("/")
    if not cleaned or cleaned == ".":
        return _CHIP_ANNOTATION_DEFAULT_FOLDER
    candidate = Path(cleaned)
    if ".." in candidate.parts:
        logger.warning(f"⚠️ [CHIP] Invalid folder_prefix detected: {folder_prefix}")
        return _CHIP_ANNOTATION_DEFAULT_FOLDER
    return candidate.as_posix()

def _chip_annotation_folder_key(
    rel_path: Path,
    base_folder: Optional[Path] = None,
    folder_prefix: Optional[str] = None
) -> str:
    override = _folder_key_from_prefix(folder_prefix)
    if override is not None:
        return override
    folder_source = base_folder or current_folder
    try:
        current_rel = folder_source.relative_to(ROOT_DIR)
        current_key = current_rel.as_posix()
    except ValueError:
        current_key = ""
    if current_key:
        return current_key or _CHIP_ANNOTATION_DEFAULT_FOLDER
    folder = rel_path.parent.as_posix()
    return folder or _CHIP_ANNOTATION_DEFAULT_FOLDER

def _empty_chip_annotation_payload() -> Dict[str, Any]:
    return {
        "marked_chips": [],
        "metadata": {
            "status": "empty",
            "total_marked_chips": 0,
            "created_at": None,
            "updated_at": None,
            "created_by": None,
            "updated_by": None,
            "class_distribution": {}
        }
    }

def _load_chip_annotation_entries(annot_file: Path, legacy_key: str) -> Dict[str, Any]:
    if not annot_file.exists():
        return {}
    try:
        with annot_file.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}

    if isinstance(data, dict) and "marked_chips" in data:
        return {legacy_key: data}

    if isinstance(data, dict):
        return {
            key: value for key, value in data.items()
            if key != _CHIP_ANNOTATION_VERSION_KEY and isinstance(value, dict)
        }
    return {}

def _write_chip_annotation_entries(annot_file: Path, entries: Dict[str, Any]) -> None:
    annot_file.parent.mkdir(parents=True, exist_ok=True)
    payload: Dict[str, Any] = {_CHIP_ANNOTATION_VERSION_KEY: _CHIP_ANNOTATION_VERSION}
    payload.update(entries)
    tmp = annot_file.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, annot_file)

def _chip_annotation_file_for_relpath(rel_path: Path) -> Path:
    """
    Chip annotation 파일 경로 생성
    현재 폴더 기준: {current_folder}/chip_annotations/{이미지명}_chips.json
    """
    global current_folder
    rel_path = Path(rel_path)
    # 🔥 current_folder 내 chip_annotations 디렉토리 사용 (classification_chips와 동일한 방식)
    chip_annotations_dir = current_folder / "chip_annotations"
    return chip_annotations_dir / rel_path.parent / f"{rel_path.stem}_chips.json"

def _load_annotation_entry(rel_path: Path, folder_key: str) -> Tuple[Path, Dict[str, Any], Dict[str, Any]]:
    annot_file = _chip_annotation_file_for_relpath(rel_path)
    entries = _load_chip_annotation_entries(annot_file, legacy_key=folder_key)
    entry = entries.get(folder_key, _empty_chip_annotation_payload())
    if "marked_chips" not in entry or not isinstance(entry["marked_chips"], list):
        entry["marked_chips"] = []
    if "metadata" not in entry or not isinstance(entry["metadata"], dict):
        entry["metadata"] = _empty_chip_annotation_payload()["metadata"]
    return annot_file, entries, entry

def _save_annotation_entry(annot_file: Path, entries: Dict[str, Any], folder_key: str, entry: Dict[str, Any]) -> None:
    entries[folder_key] = entry
    _write_chip_annotation_entries(annot_file, entries)

def _chip_id_from_coords(x_abs: int, y_abs: int) -> str:
    return f"abs:{x_abs}:{y_abs}"

_CHIP_COORD_RE = re.compile(r"^(?P<wafer>.+)_x(?P<x>-?\d+)_y(?P<y>-?\d+)$")
_CHIP_CLASSIFICATION_SEGMENT = "/classification_chips"

def _parse_chip_filename(stem: str) -> Optional[Tuple[str, int, int]]:
    """
    filename_x12_y34 → (filename, 12, 34)
    과거 음수 좌표도 허용하기 위해 - 기호 허용
    """
    match = _CHIP_COORD_RE.match(stem)
    if not match:
        return None
    try:
        return (
            match.group("wafer"),
            int(match.group("x")),
            int(match.group("y")),
        )
    except ValueError:
        return None

def _normalize_annotation_record(record: Dict[str, Any]) -> Dict[str, Any]:
    if "chip_id" not in record and "x_abs" in record and "y_abs" in record:
        record["chip_id"] = _chip_id_from_coords(record["x_abs"], record["y_abs"])
    return record

def _refresh_annotation_metadata(entry: Dict[str, Any], username: str = "system") -> None:
    metadata = entry.setdefault("metadata", {})
    now_iso = datetime.now().isoformat()
    if not metadata.get("created_at"):
        metadata["created_at"] = now_iso
        metadata["created_by"] = username
    metadata["updated_at"] = now_iso
    metadata["updated_by"] = username
    marked = entry.get("marked_chips", [])
    metadata["total_marked_chips"] = len(marked)
    metadata["status"] = "active" if marked else "empty"
    from collections import Counter
    metadata["class_distribution"] = dict(Counter([chip.get("class") for chip in marked if chip.get("class")]))

def _upsert_chip_annotations(rel_path: Path, folder_key: str, updates: List[Dict[str, Any]], username: str) -> None:
    if not updates:
        return
    annot_file, entries, entry = _load_annotation_entry(rel_path, folder_key)
    existing = {}
    for chip in entry.get("marked_chips", []):
        chip = _normalize_annotation_record(chip)
        existing[chip.get("chip_id")] = chip
    for update in updates:
        x_abs = int(update["x_abs"])
        y_abs = int(update["y_abs"])
        chip_id = _chip_id_from_coords(x_abs, y_abs)
        record = existing.get(chip_id, {"chip_id": chip_id})
        record.update({
            "x_abs": x_abs,
            "y_abs": y_abs,
            "class": update.get("class_name"),
            "filename": update.get("filename"),
            "updated_at": datetime.now().isoformat(),
            "updated_by": username,
        })
        existing[chip_id] = record
    entry["marked_chips"] = list(existing.values())
    _refresh_annotation_metadata(entry, username=username)
    _save_annotation_entry(annot_file, entries, folder_key, entry)

def _remove_chip_annotations(
    rel_path: Path,
    folder_key: str,
    coords: Optional[List[Tuple[int, int]]] = None,
    filenames: Optional[Iterable[str]] = None,
    class_name: Optional[str] = None,
    username: str = "system"
) -> None:
    annot_file, entries, entry = _load_annotation_entry(rel_path, folder_key)
    if not entry.get("marked_chips"):
        return

    coord_ids = set()
    if coords:
        for x, y in coords:
            coord_ids.add(_chip_id_from_coords(int(x), int(y)))

    filename_set = set()
    if filenames:
        for name in filenames:
            if not name:
                continue
            filename_set.add(Path(name).name)

    def should_remove(chip: Dict[str, Any]) -> bool:
        chip = _normalize_annotation_record(chip)
        cid = chip.get("chip_id")
        if coord_ids:
            if cid not in coord_ids:
                return False
            if class_name and chip.get("class") != class_name:
                return False
            return True
        if filename_set:
            chip_filename = Path(str(chip.get("filename") or "")).name
            if not chip_filename or chip_filename not in filename_set:
                return False
            if class_name and chip.get("class") != class_name:
                return False
            return True
        if class_name:
            return chip.get("class") == class_name
        return False

    entry["marked_chips"] = [chip for chip in entry["marked_chips"] if not should_remove(chip)]
    _refresh_annotation_metadata(entry, username=username)
    _save_annotation_entry(annot_file, entries, folder_key, entry)

def _derive_annotation_target_from_classification_path(class_rel_path: str) -> Optional[Tuple[Path, Path]]:
    """
    classification 경로에서 chip_annotations 상대 경로와 base 폴더를 유추한다.
    예) wafer/product/classification_chips/class/foo_x1_y2.png →
        (Path("wafer/product/foo.png"), ROOT_DIR/"wafer/product")
    """
    if not class_rel_path:
        return None
    normalized = class_rel_path.replace("\\", "/")
    segment = _CHIP_CLASSIFICATION_SEGMENT
    if segment not in normalized:
        return None
    prefix, remainder = normalized.split(segment, 1)
    remainder = remainder.strip("/")
    if not remainder:
        return None
    filename = Path(remainder).name
    parsed = _parse_chip_filename(Path(filename).stem)
    if not parsed:
        return None
    wafer_stem, _, _ = parsed
    rel_parent = Path(prefix.strip("/")) if prefix.strip("/") else Path(".")
    rel_path_obj = rel_parent / f"{wafer_stem}.png"
    folder_base = (ROOT_DIR / rel_parent).resolve()
    return rel_path_obj, folder_base

def _remove_chip_annotations_from_classification_path(
    classification_rel_path: str,
    class_name: str,
    filename: str,
    username: str = "system"
) -> None:
    derived = _derive_annotation_target_from_classification_path(classification_rel_path)
    if not derived:
        logger.debug(f"[CHIP] 삭제 대상 경로 해석 실패: {classification_rel_path}")
        return
    rel_path_obj, folder_base = derived
    folder_key = _chip_annotation_folder_key(rel_path_obj, base_folder=folder_base)
    _remove_chip_annotations(
        rel_path_obj,
        folder_key,
        filenames=[filename],
        class_name=class_name,
        username=username,
    )

def _trim_leading_component(path_obj: Path) -> Path:
    parts = [p for p in path_obj.parts if p not in (".", "")]
    if not parts:
        return Path()
    if len(parts) == 1:
        return Path(parts[0])
    return Path(*parts[1:])

def _candidate_positions_paths(rel_path: Path) -> List[Path]:
    """positions.json 파일 경로 후보 목록 반환 (파일명.json만 사용)"""
    trimmed_parent = _trim_leading_component(rel_path.parent)
    trimmed_parts = [p for p in trimmed_parent.parts if p not in ("", ".")]
    base_dir = config.POSITIONS_ROOT
    paths = []
    
    # 🔥 파일명.json 형식만 사용 (우선순위 1: trimmed 경로)
    if trimmed_parts:
        paths.append(base_dir.joinpath(*trimmed_parts) / f"{rel_path.stem}.json")
    else:
        paths.append(base_dir / f"{rel_path.stem}.json")
    
    # 🔥 우선순위 2: 레거시 경로 (파일명.json)
    legacy = config.POSITIONS_ROOT / rel_path.parent / f"{rel_path.stem}.json"
    if legacy not in paths:
        paths.append(legacy)
    
    return paths

def _resolve_positions_path(rel_path: Path) -> Path:
    for candidate in _candidate_positions_paths(rel_path):
        if candidate.exists():
            return candidate
    return _candidate_positions_paths(rel_path)[0]

def _current_username(req: Optional[Request], default: str = "system") -> str:
    if req is None:
        return default
    try:
        session = req.session  # type: ignore[attr-defined]
    except Exception:
        return default
    try:
        session_user = session.get("session_user", {})
    except AttributeError:
        return default
    if isinstance(session_user, dict):
        return session_user.get("username") or default
    if hasattr(session, "get"):
        return session.get("username", default)
    return default

@app.get("/api/chip-positions")
async def get_chip_positions(path: str):
    """주어진 이미지 경로에 대응하는 positions.json 반환"""
    try:
        # 이미지 경로에서 상대 경로 추출
        rel_path = _get_relative_path_from_image(path)

        logger.info(f"🔍 [CHIP_POS] Input path: {path}")
        logger.info(f"🔍 [CHIP_POS] Converted rel_path: {rel_path}")

        rel_path_obj = Path(rel_path)
        positions_file = _resolve_positions_path(rel_path_obj)

        logger.info(f"🔍 Chip positions requested: {path} -> {positions_file}")

        if not positions_file.exists():
            logger.warning(f"❌ Positions file not found: {positions_file}")
            raise HTTPException(status_code=404, detail=f"Positions file not found: {positions_file}")

        with open(positions_file, 'r', encoding='utf-8') as f:
            positions_data = json.load(f)

        chip_count = len(positions_data.get('chips', []))
        logger.info(f"✅ Loaded {chip_count} chip positions from {positions_file.name}")

        return JSONResponse(content=positions_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed to load chip positions: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/chip-annotations")
async def get_chip_annotations(path: str, folder: Optional[str] = Query(None)):
    """chip_annotations.json 반환 (없으면 빈 템플릿)"""
    try:
        # 이미지 경로에서 상대 경로 추출
        rel_path = _get_relative_path_from_image(path)
        rel_path_obj = Path(rel_path)
        folder_key = _chip_annotation_folder_key(rel_path_obj, folder_prefix=folder)

        _, _, entry = _load_annotation_entry(rel_path_obj, folder_key)

        return JSONResponse(content=entry)

    except Exception as e:
        logger.exception(f"Failed to load chip annotations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ChipAnnotationRequest(BaseModel):
    image_path: str
    marked_chips: List[Dict[str, Any]]
    folder_prefix: Optional[str] = None

class FolderPermission(BaseModel):
    path: str
    allow_label: bool = True
    allow_class: bool = True

class RoleUserEntry(BaseModel):
    login_id: str = Field(..., alias="loginId")
    username: Optional[str] = ""
    dept_name: Optional[str] = Field("", alias="deptName")
    role: str = ROLE_DEFAULT
    folders: List[FolderPermission] = []

class CompositeMapRequest(BaseModel):
    image_paths: List[str]
    loader_mode: Optional[str] = None
    max_workers: Optional[int] = None
    batch_size: Optional[int] = None
    palette_mode: bool = False
    focus_index: Optional[int] = 3
    highlight_threshold: int = 8
    scheme: Optional[str] = None


async def run_composite_map_task(
    task_id: str,
    image_paths: List[str],
    palette_mode: bool,
    focus_index: Optional[int],
    highlight_threshold: int,
    loader_mode: Optional[str],
    max_workers: Optional[int],
    batch_size: Optional[int],
    scheme: str,
    login_id: Optional[str]
):
    """
    백그라운드에서 composite map 생성 실행 (동시 실행 수 제한)
    """
    global COMPOSITE_SEMAPHORE

    # Lazy initialization of semaphore
    if COMPOSITE_SEMAPHORE is None:
        COMPOSITE_SEMAPHORE = asyncio.Semaphore(COMPOSITE_CONCURRENCY_LIMIT)

    # Semaphore로 동시 실행 수 제한 (최대 2개)
    async with COMPOSITE_SEMAPHORE:
        try:
            async with COMPOSITE_TASKS_LOCK:
                COMPOSITE_TASKS[task_id]["status"] = "processing"
                COMPOSITE_TASKS[task_id]["started_at"] = datetime.now().isoformat()

            # 동기 함수를 executor에서 실행 (이벤트 루프 블로킹 방지)
            from .composite_map import create_composite_heatmaps, create_palette_overlay

            loop = asyncio.get_event_loop()

            if palette_mode:
                # 팔레트 오버레이 모드
                from functools import partial
                task_fn = partial(
                    create_palette_overlay,
                    image_paths=image_paths,
                    focus_index=focus_index,
                    highlight_threshold=highlight_threshold,
                    loader_mode=loader_mode,
                    max_workers=max_workers,
                    login_id=login_id
                )
                result = await loop.run_in_executor(IO_POOL, task_fn)
                response = {
                    "success": True,
                    "mode": "palette",
                    "image_count": result["source_images"],
                    "output_dir": result["output_dir"],
                    "overlay_path": result["overlay_path"],
                    "focus_index": result["focus_index"],
                    "highlight_threshold": result["highlight_threshold"],
                    "processing_time": result["processing_time"],
                    "generated_at": result["output_dir"].split("/")[-1]
                }
            else:
                # 히트맵 모드
                from functools import partial
                task_fn = partial(
                    create_composite_heatmaps,
                    image_paths=image_paths,
                    indices=list(range(8)),
                    create_sum=True,
                    loader_mode=loader_mode,
                    max_workers=max_workers,
                    batch_size=batch_size,
                    scheme=scheme,
                    login_id=login_id
                )
                result = await loop.run_in_executor(IO_POOL, task_fn)
                response = {
                    "success": True,
                    "mode": "heatmap",
                    "image_count": result["source_images"],
                    "output_dir": result["output_dir"],
                    "heatmaps": result["heatmaps"],
                    "width": result["image_size"]["width"],
                    "height": result["image_size"]["height"],
                    "processing_time": result["processing_time"],
                    "generated_at": result["output_dir"].split("/")[-1]
                }
                if "sum_map_path" in result:
                    response["sum_map_path"] = result["sum_map_path"]
                if "sum_maps" in result:
                    response["sum_maps"] = result["sum_maps"]

            async with COMPOSITE_TASKS_LOCK:
                COMPOSITE_TASKS[task_id]["status"] = "completed"
                COMPOSITE_TASKS[task_id]["progress"] = 100
                COMPOSITE_TASKS[task_id]["result"] = response
                COMPOSITE_TASKS[task_id]["completed_at"] = datetime.now().isoformat()

        except Exception as e:
            logger.exception(f"Composite map task {task_id} failed: {e}")
            async with COMPOSITE_TASKS_LOCK:
                COMPOSITE_TASKS[task_id]["status"] = "failed"
                COMPOSITE_TASKS[task_id]["error"] = str(e)
                COMPOSITE_TASKS[task_id]["failed_at"] = datetime.now().isoformat()


@app.post("/api/chip-annotations")
async def save_chip_annotations(request: ChipAnnotationRequest, req: Request):
    """사용자가 마킹한 Chip 정보 저장"""
    try:
        # 세션에서 사용자 정보 가져오기
        username = _current_username(req, default="anonymous")

        # 이미지 경로에서 상대 경로 추출
        rel_path = _get_relative_path_from_image(request.image_path)

        # chip_annotations 폴더 경로 생성
        rel_path_obj = Path(rel_path)
        folder_key = _chip_annotation_folder_key(rel_path_obj, folder_prefix=request.folder_prefix)

        annot_file, entries, entry = _load_annotation_entry(rel_path_obj, folder_key)

        metadata = entry.setdefault("metadata", _empty_chip_annotation_payload()["metadata"])
        now_iso = datetime.now().isoformat()
        if not metadata.get("created_at"):
            metadata["created_at"] = now_iso
            metadata["created_by"] = username

        entry["marked_chips"] = request.marked_chips
        metadata["updated_at"] = now_iso
        metadata["updated_by"] = username
        metadata["total_marked_chips"] = len(request.marked_chips)
        metadata["status"] = "active" if request.marked_chips else "empty"

        from collections import Counter
        class_counts = Counter([chip.get('class') for chip in request.marked_chips if chip.get('class')])
        metadata["class_distribution"] = dict(class_counts)

        _save_annotation_entry(annot_file, entries, folder_key, entry)

        log_access_row(tag="CHIP", note=f"Saved {len(request.marked_chips)} chip annotations for {rel_path}")

        return {"success": True, "saved_chips": len(request.marked_chips), "file": str(annot_file)}

    except Exception as e:
        logger.exception(f"Failed to save chip annotations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/roles/users")
async def get_role_users():
    data = _load_roles_data()
    return {
        "users": data.get("users", []),
        "updated_at": data.get("updated_at")
    }

@app.post("/api/roles/users")
async def upsert_role_user(entry: RoleUserEntry, req: Request):
    _ensure_admin_access(req)
    payload = entry.dict(by_alias=True)
    payload["role"] = _normalize_role(payload.get("role", ROLE_DEFAULT))
    folders = payload.get("folders") or []
    normalized_folders = []
    
    # ADMIN/SUPER 역할은 자동으로 * 설정
    role = payload.get("role", ROLE_DEFAULT)
    if role in ["ROLE_ADMIN", "ROLE_SUPER"]:
        normalized_folders = [{
            "path": "*",
            "allow_label": True,
            "allow_class": True
        }]
    else:
        for folder in folders:
            path = str(folder.get("path", "")).strip()
            if not path:
                continue
            # *이면 그대로 사용
            if path == "*":
                normalized_folders.append({
                    "path": "*",
                    "allow_label": bool(folder.get("allow_label", True)),
                    "allow_class": bool(folder.get("allow_class", True))
                })
            else:
                # 2depth 처리: positions/ASDF 형식
                # 이미 /가 포함되어 있으면 그대로 사용, 아니면 positions/ 추가
                if "/" not in path:
                    # positions/ prefix 추가 (2depth)
                    from . import config
                    # POSITIONS_ROOT의 상대 경로로 변환
                    # 예: ASDF → positions/ASDF
                    # 대소문자 구별 없이 저장 (소문자로 정규화)
                    path = f"positions/{path.lower()}"
                else:
                    # 이미 /가 포함되어 있으면 경로 부분은 소문자로 정규화
                    # 예: positions/ASDF → positions/asdf
                    path_parts = path.split('/', 1)
                    if len(path_parts) == 2:
                        path = f"{path_parts[0]}/{path_parts[1].lower()}"
                    else:
                        path = path.lower()
                normalized_folders.append({
                    "path": path,
                    "allow_label": bool(folder.get("allow_label", True)),
                    "allow_class": bool(folder.get("allow_class", True))
                })
    
    payload["folders"] = normalized_folders
    with ROLES_FILE_LOCK:
        data = _load_roles_data()
        users = data.get("users", [])
        replaced = False
        for idx, user in enumerate(users):
            if user.get("loginId") == payload["loginId"]:
                users[idx] = payload
                replaced = True
                break
        if not replaced:
            users.append(payload)
        data["users"] = users
        _save_roles_data(data)
    return {"success": True, "user": payload}

@app.delete("/api/roles/users/{login_id}")
async def delete_role_user(login_id: str, req: Request):
    _ensure_admin_access(req)
    with ROLES_FILE_LOCK:
        data = _load_roles_data()
        users = data.get("users", [])
        new_users = [user for user in users if user.get("loginId") != login_id]
        data["users"] = new_users
        _save_roles_data(data)
    return {"success": True, "removed": login_id}

class ChipImageExtractRequest(BaseModel):
    image_path: str
    chips: List[Dict[str, Any]]
    class_name: str
    create_label: bool = True

@app.post("/api/chip-images/extract")
async def extract_chip_images(request: ChipImageExtractRequest):
    """마킹된 Chip 영역을 별도 이미지로 추출"""
    try:
        from PIL import Image

        # 이미지 경로 확인
        rel_path = _get_relative_path_from_image(request.image_path)
        img_path = ROOT_DIR / rel_path

        if not img_path.exists():
            raise HTTPException(status_code=404, detail=f"Image not found: {img_path}")

        # 이미지 열기
        img = Image.open(img_path)

        # Chip 이미지 저장 경로
        chip_images_dir = config.CHIP_IMAGES_ROOT / request.class_name
        chip_images_dir.mkdir(parents=True, exist_ok=True)

        extracted_chips = []

        for idx, chip in enumerate(request.chips):
            bbox = chip.get('bbox', {})

            # Crop 영역 추출
            x0, y0 = bbox.get('x0', 0), bbox.get('y0', 0)
            x1, y1 = bbox.get('x1', 0), bbox.get('y1', 0)

            chip_img = img.crop((x0, y0, x1, y1))

            # 파일명 생성
            chip_filename = f"{img_path.stem}_chip_{chip.get('x_abs')}_{chip.get('y_abs')}.png"
            chip_path = chip_images_dir / chip_filename

            # 저장
            chip_img.save(chip_path, "PNG")

            # 라벨 정보도 저장
            if request.create_label:
                label_filename = f"{chip_filename}.json"
                label_path = chip_images_dir / label_filename

                label_info = {
                    "class": request.class_name,
                    "label": chip.get('label'),
                    "bbox": bbox,
                    "coordinates": {
                        "x_abs": chip.get('x_abs'),
                        "y_abs": chip.get('y_abs')
                    },
                    "source_image": str(rel_path),
                    "extracted_at": datetime.now().isoformat()
                }

                with open(label_path, 'w', encoding='utf-8') as f:
                    json.dump(label_info, f, ensure_ascii=False, indent=2)

            extracted_chips.append({
                "chip_image": str(chip_path),
                "coordinates": f"({chip.get('x_abs')}, {chip.get('y_abs')})"
            })

        log_access_row(tag="CHIP", note=f"Extracted {len(extracted_chips)} chip images to {request.class_name}")

        return {
            "success": True,
            "extracted_count": len(extracted_chips),
            "class_name": request.class_name,
            "output_dir": str(chip_images_dir),
            "chips": extracted_chips
        }

    except Exception as e:
        logger.exception(f"Failed to extract chip images: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/composite-map")
async def create_composite_map_endpoint(
    payload: CompositeMapRequest,
    req: Request,
    background_tasks: BackgroundTasks
):
    """
    선택한 이미지들의 인덱스(0~7) 출현 빈도를 Heatmap으로 생성 (백그라운드)

    즉시 task_id를 반환하고 백그라운드에서 처리
    상태 확인은 /api/composite-map/status/{task_id}로 가능
    """
    if not HAS_NUMPY:
        raise HTTPException(status_code=500, detail="numpy가 필요합니다. 서버에 numpy를 설치해주세요.")

    image_paths = payload.image_paths or []
    if not image_paths:
        raise HTTPException(status_code=400, detail="image_paths가 필요합니다.")

    max_images = 256
    if len(image_paths) > max_images:
        raise HTTPException(status_code=400, detail=f"최대 {max_images}개의 이미지만 지원합니다.")

    # Task ID 생성
    task_id = str(uuid.uuid4())

    # 작업 상태 초기화
    async with COMPOSITE_TASKS_LOCK:
        COMPOSITE_TASKS[task_id] = {
            "status": "queued",
            "progress": 0,
            "result": None,
            "error": None,
            "created_at": datetime.now().isoformat()
        }

    # 파라미터 준비
    loader_mode = payload.loader_mode or config.COMPOSITE_LOADER_MODE
    max_workers = payload.max_workers if payload.max_workers is not None else None
    batch_size = payload.batch_size if payload.batch_size is not None else None
    login_id = _current_login_id(req)
    resolved_scheme = payload.scheme or (get_user_color_scheme(login_id) if login_id else "change")

    # 백그라운드 작업 추가
    background_tasks.add_task(
        run_composite_map_task,
        task_id=task_id,
        image_paths=image_paths,
        palette_mode=payload.palette_mode,
        focus_index=payload.focus_index,
        highlight_threshold=payload.highlight_threshold,
        loader_mode=loader_mode,
        max_workers=max_workers,
        batch_size=batch_size,
        scheme=resolved_scheme,
        login_id=login_id
    )

    return {
        "success": True,
        "task_id": task_id,
        "status": "processing",
        "message": "Composite map generation started in background"
    }


@app.get("/api/composite-map/status/{task_id}")
async def get_composite_map_status(task_id: str):
    """
    Composite map 작업 상태 조회
    """
    async with COMPOSITE_TASKS_LOCK:
        if task_id not in COMPOSITE_TASKS:
            raise HTTPException(status_code=404, detail="Task not found")
        return COMPOSITE_TASKS[task_id]


class SubsetMapRequest(BaseModel):
    output_dir: str = Field(..., description="Composite map 디렉토리 (NPZ 파일 위치)")
    selected_grades: List[int] = Field(..., description="선택된 grade 리스트 (예: [3, 5])")
    scheme: Optional[str] = Field(None, description="Color scheme")
    override_colors: Optional[List[str]] = Field(None, description="색상 오버라이드")


@app.post("/api/composite-subset")
async def create_subset_map_endpoint(payload: SubsetMapRequest, req: Request):
    """
    선택된 grade만으로 Subset Map 생성

    Request body:
    {
        "output_dir": "composite_map/user/20250125_123456",
        "selected_grades": [3, 5],
        "scheme": "change",
        "override_colors": ["#ff0000", ...]
    }

    Returns:
    {
        "success": true,
        "subset_maps": [
            {
                "path": "composite_map/.../square_average_35.png",
                "type": "square_mean",
                "display_name": "Composite SqMean [Grade 3, 5]",
                "filename": "square_average_35.png",
                "selected_grades": [3, 5]
            },
            {
                "path": "composite_map/.../square_weighted_average_35.png",
                "type": "weighted_square_mean",
                "display_name": "Composite Weighted SqMean [Grade 3, 5]",
                "filename": "square_weighted_average_35.png",
                "selected_grades": [3, 5]
            }
        ]
    }
    """
    if not HAS_NUMPY:
        raise HTTPException(status_code=500, detail="numpy가 필요합니다.")

    if not payload.selected_grades:
        raise HTTPException(status_code=400, detail="selected_grades가 필요합니다.")

    # Grade 범위 검증 (0-7만 허용)
    for grade in payload.selected_grades:
        if not (0 <= grade <= 7):
            raise HTTPException(status_code=400, detail=f"Grade는 0-7 범위여야 합니다: {grade}")

    try:
        from .composite_map import create_subset_map
        from .config import IMAGES_ROOT

        # output_dir을 절대 경로로 변환
        output_dir = IMAGES_ROOT / payload.output_dir
        if not output_dir.exists():
            raise HTTPException(status_code=404, detail=f"디렉토리가 존재하지 않습니다: {payload.output_dir}")

        # Subset Map 생성
        subset_maps = create_subset_map(
            output_dir=output_dir,
            selected_grades=payload.selected_grades,
            scheme=payload.scheme,
            override_colors=payload.override_colors,
        )

        return {
            "success": True,
            "subset_maps": subset_maps,
            "selected_grades": sorted(payload.selected_grades),
        }

    except FileNotFoundError as e:
        logger.error(f"Subset map 생성 실패 (파일 없음): {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        logger.error(f"Subset map 생성 실패 (잘못된 값): {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Subset map 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ======================== Role & Access Control API ========================

class UserCreateRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    display_name: str = Field(..., min_length=1, max_length=100)
    email: str = Field(..., min_length=5, max_length=100)
    role: Role = Field(default=Role.USER)
    folders: str = Field(default="", description="쉼표 구분 폴더 목록 (ABCD,FESD) 또는 * (전체)")

class RoleUpdateRequest(BaseModel):
    new_role: Role

class GrantAddRequest(BaseModel):
    folder: str = Field(..., min_length=1)
    level: Role

class GrantRemoveRequest(BaseModel):
    folder: str = Field(..., min_length=1)


def get_current_user(request: Request) -> Optional[str]:
    """현재 로그인한 사용자 이름 반환"""
    # 🔥 세션 미들웨어가 없어도 안전하게 처리
    try:
        session = request.session  # type: ignore[attr-defined]
        username = session.get("session_user") or session.get("username")
        if username:
            return str(username)
    except Exception:
        # 세션 미들웨어가 없거나 세션에 접근할 수 없는 경우
        pass
    
    # cookie fallback
    login_id = request.cookies.get("session_user")
    if login_id:
        return str(login_id)
    
    # SAML 세션 확인 (메모리 기반)
    try:
        # SAML_USER_SESSIONS에서 현재 요청의 쿠키나 헤더로 사용자 찾기
        # 간단하게 쿠키에서 LoginId 확인
        saml_login_id = request.cookies.get("saml_login_id")
        if saml_login_id and saml_login_id in SAML_USER_SESSIONS:
            return saml_login_id
    except Exception:
        pass
    
    return None


@app.get("/api/users")
async def get_users(request: Request):
    """모든 사용자 목록 조회"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # SUPER 또는 ADMIN만 조회 가능
        if not checker.has_permission(current_user, Permission.GRANT_MANAGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        users = user_manager.get_all_users()

        return {"success": True, "users": users}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"사용자 목록 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/users/{username}")
async def get_user(username: str, request: Request):
    """특정 사용자 정보 조회"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # 본인 또는 SUPER/ADMIN만 조회 가능
        if current_user != username and not checker.has_permission(current_user, Permission.GRANT_MANAGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        user = user_manager.get_user(username)

        if not user:
            raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")

        return {"success": True, "user": user}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"사용자 정보 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/users")
async def create_user(payload: UserCreateRequest, request: Request):
    """사용자 생성"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # SUPER만 사용자 생성 가능
        if not checker.has_permission(current_user, Permission.ROLE_CHANGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        user = user_manager.create_user(
            username=payload.username,
            display_name=payload.display_name,
            email=payload.email,
            role=payload.role,
            folders=payload.folders,
            actor=current_user
        )

        return {"success": True, "user": user}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"사용자 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class CreateManualEntryReq(BaseModel):
    mode: str
    group: str
    lot: str
    wafer: Optional[str] = ""

@app.post("/api/my-lot/manual")
async def create_my_lot_manual_entry(req: CreateManualEntryReq, request: Request):
    """이미지 없이 수동으로 항목 생성"""
    try:
        current_user = get_current_user(request)
        result = my_lot_create_manual_entry(
            current_user,
            req.mode,
            req.group,
            req.lot,
            req.wafer
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"MY LOT 수동 생성 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/users/{username}/role")
async def update_user_role(username: str, payload: RoleUpdateRequest, request: Request):
    """사용자 역할 변경"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # SUPER만 역할 변경 가능
        if not checker.can_modify_user(current_user, username):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        user = user_manager.update_role(
            username=username,
            new_role=payload.new_role,
            actor=current_user
        )

        return {"success": True, "user": user}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"역할 변경 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/users/{username}/grants")
async def add_user_grant(username: str, payload: GrantAddRequest, request: Request):
    """사용자에게 폴더 권한 부여"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # ADMIN 이상만 권한 부여 가능
        if not checker.has_permission(current_user, Permission.GRANT_MANAGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        user = user_manager.add_grant(
            username=username,
            folder=payload.folder,
            level=payload.level,
            actor=current_user
        )

        return {"success": True, "user": user}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"권한 부여 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/users/{username}/grants")
async def remove_user_grant(username: str, payload: GrantRemoveRequest, request: Request):
    """사용자의 폴더 권한 제거"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # ADMIN 이상만 권한 제거 가능
        if not checker.has_permission(current_user, Permission.GRANT_MANAGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        user = user_manager.remove_grant(
            username=username,
            folder=payload.folder,
            actor=current_user
        )

        return {"success": True, "user": user}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"권한 제거 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/users/{username}")
async def delete_user(username: str, request: Request):
    """사용자 삭제"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # SUPER만 사용자 삭제 가능
        if not checker.has_permission(current_user, Permission.ROLE_CHANGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        # 본인은 삭제 불가
        if current_user == username:
            raise HTTPException(status_code=400, detail="본인은 삭제할 수 없습니다.")

        user_manager = get_user_manager()
        user_manager.delete_user(username, actor=current_user)

        return {"success": True, "message": f"사용자 '{username}'이(가) 삭제되었습니다."}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"사용자 삭제 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/audit-logs")
async def get_audit_logs(
    request: Request,
    date: Optional[str] = Query(None, description="YYYYMMDD 형식"),
    limit: int = Query(100, ge=1, le=1000)
):
    """감사 로그 조회"""
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # SUPER만 감사 로그 조회 가능
        if not checker.has_permission(current_user, Permission.ROLE_CHANGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        user_manager = get_user_manager()
        logs = user_manager.get_audit_logs(date=date, limit=limit)

        return {"success": True, "logs": logs, "count": len(logs)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"감사 로그 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/users/search")
async def search_users_from_stats(
    request: Request,
    query: str = Query(..., min_length=1, description="Username 또는 LoginId 검색어"),
    limit: int = Query(10, ge=1, le=50, description="최대 검색 결과 수")
):
    """
    stats.json에서 사용자 검색 (Username 또는 LoginId)

    Args:
        query: 검색어 (Username 또는 LoginId에서 검색)
        limit: 최대 결과 수 (기본: 10)

    Returns:
        {
            "success": True,
            "users": [
                {
                    "username": "홍길동",
                    "login_id": "12345",
                    "dept_name": "개발부",
                    "ip": "192.168.1.100",
                    "last_seen": "2025-10-17 21:26:16"
                },
                ...
            ],
            "count": 5
        }
    """
    try:
        current_user = get_current_user(request)
        checker = get_permission_checker()

        # 권한 검사: ADMIN 이상만 사용자 검색 가능
        if not checker.has_permission(current_user, Permission.GRANT_MANAGE):
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        # stats.json 파일 경로
        stats_file = Path(__file__).parent.parent / "logs" / "stats.json"

        if not stats_file.exists():
            return {"success": True, "users": [], "count": 0}

        # stats.json 로드
        with open(stats_file, 'r', encoding='utf-8') as f:
            stats_data = json.load(f)

        query_lower = query.lower()
        matched_users = []

        # 모든 사용자 순회하며 검색
        for ip_key, user_data in stats_data.get("users", {}).items():
            profile = user_data.get("profile", {})
            username = profile.get("Username", "")
            login_id = profile.get("LoginId", "")

            # Username 또는 LoginId에 검색어가 포함되어 있는지 확인
            if query_lower in username.lower() or query_lower in login_id.lower():
                matched_users.append({
                    "username": username,
                    "login_id": login_id,
                    "dept_name": profile.get("DeptName", ""),
                    "grade_name": profile.get("GrdName", ""),
                    "sabun": profile.get("Sabun", ""),
                    "ip": ip_key,
                    "last_seen": user_data.get("last_access_time", ""),
                    "total_requests": user_data.get("total_requests", 0)
                })

                # limit 도달 시 중단
                if len(matched_users) >= limit:
                    break

        # 최근 접속 순으로 정렬
        matched_users.sort(key=lambda x: x.get("last_seen", ""), reverse=True)

        return {
            "success": True,
            "users": matched_users[:limit],
            "count": len(matched_users)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"사용자 검색 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ======================== __main__ ========================
if __name__ == "__main__":
    import uvicorn

    if not config.SSL_ENABLED:
        logger.error("[SSL] SSL_ENABLED=0 입니다. 이 실행파일은 HTTPS만 지원합니다.")
        sys.exit(2)

    cert_path = Path(str(config.SSL_CERTFILE)).resolve()
    key_path  = Path(str(config.SSL_KEYFILE)).resolve()
    if not cert_path.exists() or not key_path.exists():
        logger.error(f"[SSL] 인증서/키 파일이 없습니다.\n  CERT: {cert_path}\n  KEY : {key_path}")
        sys.exit(2)

    reload_flag = os.getenv("RELOAD", "0") == "1"
    logger.info(f"[SSL] HTTPS 모드 활성화: 포트 {config.HTTPS_PORT}")
    logger.info(f"[SSL] CERTFILE={cert_path}")
    logger.info(f"[SSL] KEYFILE={key_path}")

    # 디버그 로그 제거 (초기 로드 시에만 필요하면 주석 해제)
    # logger.info(f"🔍 [SERVER START] ROOT_DIR: {ROOT_DIR}")
    # logger.info(f"🔍 [SERVER START] current_folder: {current_folder}")
    # logger.info(f"🔍 [SERVER START] THUMBNAIL_DIR: {THUMBNAIL_DIR}")

    requested_workers = os.getenv("UVICORN_WORKERS") or os.getenv("WORKERS")
    if requested_workers and requested_workers.strip() not in {"", "1"}:
        serverlog = logging.getLogger("uvicorn.error")
        serverlog.warning(f"[WORKERS] FastAPI는 단일 워커로 고정됩니다. 요청된 워커 수({requested_workers})는 무시됩니다.")

    # 클라이언트 연결 끊김 관련 에러 필터링 (그리드 스크롤 시 이미지 로드 취소 등)
    class SuppressClientDisconnectFilter(logging.Filter):
        def filter(self, record):
            # EndOfStream, "No response returned" 등 클라이언트 연결 끊김 관련 로그 필터링
            if record.levelno == logging.ERROR:
                msg = record.getMessage() if hasattr(record, 'getMessage') else str(record.msg)
                if any(keyword in msg for keyword in [
                    "EndOfStream",
                    "No response returned",
                    "unhandled errors in a TaskGroup"
                ]):
                    return False
            return True

    # uvicorn 에러 로거에 필터 추가
    uvicorn_error_logger = logging.getLogger("uvicorn.error")
    uvicorn_error_logger.addFilter(SuppressClientDisconnectFilter())

    print(f"[DEBUG] Starting uvicorn with reload={reload_flag}", flush=True)
    print(f"[DEBUG] Port: {config.HTTPS_PORT}", flush=True)
    print(f"[DEBUG] SSL Cert: {cert_path}", flush=True)
    print(f"[DEBUG] SSL Key: {key_path}", flush=True)

    # 🔥 로깅 설정: uvicorn의 기본 로깅을 사용하되, 필요한 로거만 설정
    # log_config=None 제거 - 이 설정이 lifespan 로그를 숨기는 원인이었음
    logging_config = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "()": "uvicorn.logging.DefaultFormatter",
                "format": "%(levelprefix)s %(asctime)s     %(message)s",
                "datefmt": "%Y-%m-%d %H:%M:%S"
            },
            "access": {
                "()": "uvicorn.logging.AccessFormatter",
                "format": "%(levelprefix)s %(asctime)s     %(client_addr)s - \"%(request_line)s\" %(status_code)s"
            }
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout"
            },
            "access": {
                "formatter": "access",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout"
            }
        },
        "loggers": {
            "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"level": "INFO"},
            "uvicorn.access": {"handlers": ["access"], "level": "INFO", "propagate": False}
        }
    }

    try:
        uvicorn.run(
            "api.main:app",
            host="0.0.0.0",
            port=int(config.HTTPS_PORT),        # 기본 8443
            reload=reload_flag,                 # 개발 편의
            workers=1,
            lifespan="on",                      # FastAPI lifespan 강제 활성화 (인덱스/캐시 초기화 보장)
            log_level="info",
            access_log=False,                   # 커스텀 테이블 로그 사용
            use_colors=True,
            log_config=logging_config,          # 🔥 기본 로깅 설정 사용 (None 대신)
            ssl_certfile=str(cert_path),
            ssl_keyfile=str(key_path),
        )
    except Exception as e:
        print(f"[ERROR] Failed to start uvicorn: {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
