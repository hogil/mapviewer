"""
L3Tracker - Wafer Map Viewer API (HTTPS, Pretty Table Logs, Noise-free)
"""

# ======================== Imports ========================
import os, re, sys, json, time, shutil, asyncio, logging, logging.config, hashlib
from pathlib import Path
from contextlib import contextmanager
from typing import List, Optional, Dict, Any, Tuple
from collections import OrderedDict
from bisect import bisect_left, bisect_right
from threading import RLock, Lock
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

# TurboJPEG 인스턴스 (그리드 썸네일 최적화)
TURBO_JPEG = None
if TURBOJPEG_AVAILABLE and getattr(config, "USE_TURBOJPEG", False):
    try:
        turbo_path = getattr(config, "TURBOJPEG_PATH", "") or None
        TURBO_JPEG = TurboJPEG(lib_path=turbo_path if turbo_path else None)
        print(f"[main.py] TurboJPEG Q95 FASTDCT + 4:2:0 초기화 완료")
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

SKIP_DIRS = {d.strip() for d in config.SKIP_DIRS if d.strip()}

LABELS_DIR = config.LABELS_DIR
LABELS_FILE = config.LABELS_FILE

# ======================== Pools / State / Caches ========================
IO_POOL = ThreadPoolExecutor(max_workers=IO_THREADS)
THUMBNAIL_SEM = asyncio.Semaphore(THUMBNAIL_SEM_SIZE)
_THUMBNAIL_EXECUTOR_WORKERS = max(4, min(THUMBNAIL_SEM_SIZE, (os.cpu_count() or 4) * 2))
THUMBNAIL_EXECUTOR = ThreadPoolExecutor(max_workers=_THUMBNAIL_EXECUTOR_WORKERS)

USER_ACTIVITY_FLAG = False
BACKGROUND_TASKS_PAUSED = False
INDEX_BUILDING = False
INDEX_READY = False

FILE_INDEX: Dict[str, Dict[str, Any]] = {}
FILE_INDEX_LOCK = RLock()
FILE_INDEX_KEYS: List[str] = []

def _file_index_clear() -> None:
    with FILE_INDEX_LOCK:
        FILE_INDEX.clear()
        FILE_INDEX_KEYS.clear()

def file_index_set(path: str, meta: Dict[str, Any]) -> None:
    with FILE_INDEX_LOCK:
        FILE_INDEX[path] = meta
        idx = bisect_left(FILE_INDEX_KEYS, path)
        if idx == len(FILE_INDEX_KEYS) or FILE_INDEX_KEYS[idx] != path:
            FILE_INDEX_KEYS.insert(idx, path)

def _search_index_slice(keys: List[str], query: str, goal: int) -> List[str]:
    """단일 청크 검색 (병렬 처리의 작업 단위)"""
    results: List[str] = []
    for rel in keys:
        try:
            meta = FILE_INDEX[rel]
        except KeyError:
            continue
        if query in meta["name_lower"]:
            results.append(rel)
            if len(results) >= goal:
                break
    return results

def _search_index_slice_parallel(keys: List[str], query: str, goal: int, num_chunks: int = 4) -> List[str]:
    """병렬 검색 (멀티청크)

    Args:
        keys: 검색할 키 목록
        query: 검색어 (소문자)
        goal: 목표 결과 개수
        num_chunks: 청크 개수 (기본 4, 권장 범위: 4~8)

    Returns:
        검색 결과 리스트 (최대 goal개)
    """
    if not keys:
        return []

    # 청크가 너무 작으면 단일 스레드가 더 효율적
    if len(keys) < num_chunks * 10:
        return _search_index_slice(keys, query, goal)

    # 청크 분할
    chunk_size = len(keys) // num_chunks
    chunks = []
    for i in range(num_chunks):
        start = i * chunk_size
        end = start + chunk_size if i < num_chunks - 1 else len(keys)
        chunks.append(keys[start:end])

    # 병렬 실행
    from concurrent.futures import ThreadPoolExecutor, as_completed
    results = []

    with ThreadPoolExecutor(max_workers=num_chunks) as executor:
        # 각 청크마다 goal만큼 검색 (오버 페칭)
        futures = [
            executor.submit(_search_index_slice, chunk, query, goal)
            for chunk in chunks
        ]

        # 결과 수집 (완료되는 대로)
        for future in as_completed(futures):
            try:
                chunk_results = future.result()
                results.extend(chunk_results)
                # Early termination: 목표 도달 시 중단
                if len(results) >= goal:
                    break
            except Exception as e:
                logger.error(f"청크 검색 실패: {e}")
                continue

    # goal만큼만 반환
    return results[:goal]

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
            # ① LoginId 기준으로 IP 기록 정리 및 삭제
            removed = logger_instance.remove_ip_login_record(client_ip, LoginId)
            if removed:
                bootlog.info(f"🗑️ [IP CLEANUP] IP 로그인 기록 삭제됨: {client_ip} → LoginId: {LoginId}")
            
            # ② SAML 인증 시간 추가
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
    except Exception as e:
        bootlog.error(f"❌ [SAML SESSION] 사용자 정보 저장 실패: {e}")
    
    # 🔥 SAML 로그인 성공 - URL 파라미터로 사용자 정보 전달
    Username = meta.get("Username", "")
    DeptName = meta.get("DeptName", "")
    Sabun = meta.get("Sabun", "")  # 로그용으로만 사용

    # 🔥 보안: Sabun은 URL에 노출하지 않음 (프론트엔드에서 미사용)
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

    resp = FastAPIResponse(status_code=302)
    resp.headers["Location"] = "/"
    
    # 🔥 개발 모드 로그인 - 서버 메모리에 사용자 정보 저장 (LoginId 기준)
    try:
        LoginId = meta.get("LoginId", "")
        if LoginId:
            # LoginId 기준으로 저장
            SAML_USER_SESSIONS[LoginId] = meta
        else:
            logger.warning(f"⚠️ [DEV SESSION] LoginId가 없어서 저장하지 않음")
    except Exception as e:
        logger.error(f"❌ [DEV SESSION] 사용자 정보 저장 실패: {e}")
    
    # 🔥 개발 모드 로그인 - URL 파라미터로 사용자 정보 전달
    LoginId = meta.get("LoginId", "")
    Username = meta.get("Username", "")
    DeptName = meta.get("DeptName", "")
    Sabun = meta.get("Sabun", "")  # 로그용으로만 사용

    # 🔥 보안: Sabun은 URL에 노출하지 않음 (프론트엔드에서 미사용)
    redirect_url = f"/?dev_success=true&LoginId={LoginId}&Username={Username}&DeptName={DeptName}"
    resp.headers["Location"] = redirect_url

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
    return resp

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

@app.get("/api/auth/user")
async def api_auth_user(request: Request, LoginId: Optional[str] = None):
    """현재 사용자 정보 반환 - 서버 메모리에서 SAML 로그인 정보 확인"""
    try:
        # LoginId가 제공된 경우 해당 사용자 정보 조회
        if LoginId and LoginId in SAML_USER_SESSIONS:
            user_info = SAML_USER_SESSIONS[LoginId]
            
            # SAML 속성들을 프론트엔드로 전달
            saml_attributes = user_info.get("saml_attributes", {})
            
            # 🔥 보안: Sabun은 프론트엔드로 전달하지 않음 (미사용 필드)
            return {
                "authenticated": True,
                "LoginId": user_info.get("LoginId", ""),
                "Username": user_info.get("Username", ""),
                "DeptName": user_info.get("DeptName", ""),
                "GrdName_EN": user_info.get("GrdName_EN", ""),
                "GrdName": user_info.get("GrdName", ""),
                "metadata": user_info.get("metadata", {}),
                "saml_attributes": saml_attributes  # 🔥 SAML 속성들을 프론트엔드로 전달
            }

        return {
            "authenticated": False,
            "LoginId": "",
            "Username": "",
            "DeptName": "",
            "GrdName_EN": "",
            "GrdName": "",
            "metadata": {},
            "saml_attributes": {}
        }
        
    except Exception as e:
        logger.error(f"❌ [API /auth/user] 오류 발생: {e}")
        # 오류 발생 시 Guest 반환
        return {
            "authenticated": False,
            "LoginId": "",
            "Username": "",
            "DeptName": "",
            "GrdName_EN": "",
            "GrdName": "",
            "metadata": {},
            "saml_attributes": {}
        }


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
        
        # 🔥 ROOT_DIR 기준으로 경로 해석 (current_folder 무시)
        # 프론트엔드에서 전달하는 path는 이미 ROOT_DIR 기준 상대경로
        target = (ROOT_DIR / normalized).resolve()
        
        if not str(target).startswith(str(ROOT_DIR)):
            raise HTTPException(status_code=400, detail="Invalid path")
        
        logger.info(f"🔍 [safe_resolve_path] input: {path}, normalized: {normalized}, target: {target}")
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
    root_dir_str = str(ROOT_DIR.resolve())
    root_dir_len = len(root_dir_str)
    
    try:
        with os.scandir(target) as it:
            for entry in it:
                name = entry.name
                # 🔥 classification, thumbnails 폴더 제외
                if name.startswith('.') or name == '__pycache__' or name in SKIP_DIRS or name in ['classification', 'thumbnails']: 
                    continue
                typ = "directory" if entry.is_dir(follow_symlinks=False) else "file"
                
                # 🚀 빠른 경로 계산: 문자열 조작으로 ROOT_DIR 제거
                entry_path_str = str(entry.path).replace('\\', '/')
                # ROOT_DIR 부분을 제거하여 상대 경로 생성
                if entry_path_str.startswith(root_dir_str.replace('\\', '/')):
                    root_relative = entry_path_str[root_dir_len:].lstrip('/')
                else:
                    root_relative = name
                
                items.append({
                    "name": name, 
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

async def build_file_index_background():
    global INDEX_BUILDING, INDEX_READY
    if INDEX_BUILDING: return
    INDEX_BUILDING, INDEX_READY = True, False

    def _walk_and_index():
        global INDEX_READY
        start = time.time()
        _file_index_clear()
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
                    file_index_set(rel, rec)
                except Exception:
                    continue
            time.sleep(0.001)
        INDEX_READY = True

    try:
        await asyncio.get_running_loop().run_in_executor(ThreadPoolExecutor(max_workers=1), _walk_and_index)
    finally:
        INDEX_BUILDING = False

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

def _generate_thumbnail_sync(image_path: Path, thumbnail_path: Path, size: Tuple[int, int]):
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
            # 그리드 썸네일 생성 최적화 (2025-10-23)
            # 원복 시점: commit dce1bb2
            # =============================================================
            # 최적화 1: 하드웨어 가속 및 메모리 캐시 활성화
            # - memory=True: libvips 내부 캐시 활성화
            # - unlimited=True: 하드웨어 가속 기능 활성화 (SIMD, 멀티코어)
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
                        # TurboJPEG 시도
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
                                kernel=config.PYRAMID_KERNEL or 'cubic'
                            )
                    else:
                        resized = vips_image.resize(
                            scale,
                            vscale=scale,
                            kernel=config.PYRAMID_KERNEL or 'cubic'
                        )
                else:
                    # 작은 축소: resize만 사용
                    resized = vips_image.resize(
                        scale,
                        vscale=scale,
                        kernel=config.PYRAMID_KERNEL or 'cubic'
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
                    THUMBNAIL_EXECUTOR, _generate_thumbnail_sync, image_path, thumb, size
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
        logger.info(f"📁 [/api/files] path: {path}, target: {target}")
        if not target.exists() or not target.is_dir():
            logger.warning(f"⚠️ [/api/files] 폴더 없음: {target}")
            return JSONResponse({"success": False, "error": "Not found"}, status_code=404)
        # 🔥 라벨 썸네일 캐시는 유지하고, classification 폴더만 무효화
        if 'classification' in str(target).replace('\\', '/'):
            _dircache_invalidate(target)
        items = list_dir_fast(target)
        logger.info(f"📁 [/api/files] 반환 항목 수: {len(items)} (폴더: {sum(1 for x in items if x['type']=='directory')}, 파일: {sum(1 for x in items if x['type']=='file')})")
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
            keys_snapshot = list(FILE_INDEX_KEYS)
        for rel in keys_snapshot:
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


def _generate_pyramid_sync(image_path: Path, pyramid_path: Path, level: float):
    """🚀 피라미드 레벨 이미지 생성 (속도 극대화)"""
    import time
    start_time = time.time()

    logger.info(f"🚀 [PYRAMID] 시작: level={level}")

    target_format = config.PYRAMID_FORMAT.upper()
    quality = max(1, min(100, int(config.PYRAMID_Q)))
    png_compression = max(0, min(9, int(config.PYRAMID_PNG_COMPRESSION)))
    png_effort = max(1, min(10, int(config.PYRAMID_PNG_EFFORT)))
    kernel_name = (config.PYRAMID_KERNEL or "cubic").lower()
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
        pyramid_path.parent.mkdir(parents=True, exist_ok=True)
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
                    orig_w, orig_h = image.width, image.height
                    expected_w = max(1, int(orig_w * level))
                    expected_h = max(1, int(orig_h * level))
                    logger.info(f"⏱️ [DEBUG] 크기 계산 ({orig_w}x{orig_h} → {expected_w}x{expected_h})")

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
                                t_shrink = time.time()
                                work_image = work_image.shrink(shrink_factor, shrink_factor)
                                logger.info(f"⏱️ [DEBUG] shrink x{shrink_factor}: {(time.time()-t_shrink)*1000:.0f}ms")
                                
                                # 추가 리사이즈가 필요한 경우만
                                remaining_scale = scale * shrink_factor
                                if abs(remaining_scale - 1.0) > 0.01:
                                    t_resize = time.time()
                                    work_image = work_image.resize(remaining_scale, vscale=remaining_scale, kernel=kernel_name)
                                    logger.info(f"⏱️ [DEBUG] resize({kernel_name}): {(time.time()-t_resize)*1000:.0f}ms")
                            else:
                                t_resize = time.time()
                                work_image = work_image.resize(scale, vscale=scale, kernel=kernel_name)
                                logger.info(f"⏱️ [DEBUG] resize({kernel_name}): {(time.time()-t_resize)*1000:.0f}ms")
                        else:
                            # 작은 축소의 경우 직접 resize
                            t_resize = time.time()
                            work_image = work_image.resize(scale, vscale=scale, kernel=kernel_name)
                            logger.info(f"⏱️ [DEBUG] resize({kernel_name}): {(time.time()-t_resize)*1000:.0f}ms")
                    else:
                        logger.info("⏱️ [DEBUG] Level 1.0 - 원본 해상도 유지")

                    final_w, final_h = work_image.width, work_image.height
                    t_save = time.time()
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
                        work_image.jpegsave(
                            temp_target,
                            Q=95,                      # Q=95 (그리드 썸네일과 동일, 벤치마크 최적화)
                            strip=True,                # 메타데이터 제거
                            optimize_coding=False,     # 속도 우선
                            subsample_mode=1,          # 4:2:0 (가장 빠름)
                            interlace=False            # 인터레이스 비활성화
                        )
                        logger.info(
                            "⏱️ [DEBUG] 저장 완료: %.0fms (pyvips Q95)",
                            (time.time() - t_save) * 1000.0,
                        )
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
                logger.info(f"⏱️ [DEBUG] Pillow 크기 계산 ({orig_w}x{orig_h} → {expected_w}x{expected_h})")

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
_pyramid_bg_executor = ThreadPoolExecutor(max_workers=4)  # 최대 4개 동시 생성
_pyramid_bg_generating = set()  # 현재 생성 중인 파일 경로

async def _generate_other_levels_background(image_path: Path, current_level: float, stem: str):
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
        
        logger.info(f"🚀 [BG PIPELINE] Background 파이프라인 시작: levels={other_levels}")
        
        # 파이프라인 실행 (ThreadPoolExecutor 사용)
        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(
            _pyramid_bg_executor,
            _generate_pyramid_pipeline,
            image_path,
            other_levels,
            stem,
            format_ext
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
        _generate_pyramid_sync(image_path, pyramid_path, level)
        logger.info(f"✅ [BG DONE] Background 피라미드 완료: level={level}")
    except Exception as e:
        logger.warning(f"⚠️ [BG ERROR] Background 생성 실패: {e}")
    finally:
        _pyramid_bg_generating.discard(path_key)


def _generate_pyramid_pipeline(image_path: Path, levels: list, stem: str, format_ext: str):
    """원본 이미지를 한 번만 읽고 여러 레벨을 연속 생성하는 파이프라인"""
    import pyvips
    import time
    
    try:
        # 원본 이미지를 한 번만 읽기
        t_read_start = time.time()
        original_image = pyvips.Image.new_from_file(str(image_path))
        t_read_end = time.time()
        logger.info(f"⏱️ [PIPELINE] 원본 읽기: {(t_read_end - t_read_start)*1000:.0f}ms")
        
        results = []
        
        for level in levels:
            try:
                # 피라미드 경로 생성
                pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{int(level*100)}"
                pyramid_path = pyramid_dir / f"{stem}_L{int(level*100)}.{format_ext}"
                
                # 이미 존재하면 스킵
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
                t_level_start = time.time()
                work_image = original_image
                
                # 레벨에 따른 리사이즈
                if level < 1.0:
                    scale = level
                    new_width = int(original_image.width * scale)
                    new_height = int(original_image.height * scale)
                    
                    # 리사이즈 커널 선택
                    if scale < 0.5:
                        kernel = pyvips.enums.Kernel.MITCHELL
                    else:
                        kernel = pyvips.enums.Kernel.LANCZOS3
                    
                    work_image = work_image.resize(scale, kernel=kernel)
                    logger.info(f"⏱️ [PIPELINE] resize({kernel}): {(time.time()-t_level_start)*1000:.0f}ms")
                else:
                    logger.info("⏱️ [PIPELINE] Level 1.0 - 원본 해상도 유지")
                
                # 저장
                t_save_start = time.time()
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
                    work_image.jpegsave(
                        str(temp_path),
                        Q=85,
                        strip=True,
                        optimize_coding=False,     # 속도 우선
                        subsample_mode=1,          # 4:2:0 (가장 빠름)
                        interlace=False,           # 인터레이스 비활성화
                        trellis_quant=False        # 트렐리스 양자화 비활성화
                    )
                
                # 임시 파일을 최종 파일로 이동
                temp_path.replace(pyramid_path)
                t_save_end = time.time()
                
                logger.info(f"✅ [PIPELINE] Level {level} 완료: {(t_save_end - t_save_start)*1000:.0f}ms")
                results.append((level, True, "SUCCESS"))
                
            except Exception as e:
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

@app.head("/api/image")
@app.get("/api/image")
async def get_image(request: Request, path: str, level: Optional[float] = None):
    try:
        is_head = request.method == "HEAD"

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
            if not is_head:
                logger.info(f"🎯 [PYRAMID MODE] 활성화됨")

            # 레벨 검증
            if level not in config.PYRAMID_LEVELS:
                level = min(config.PYRAMID_LEVELS, key=lambda x: abs(x - level))
                if not is_head:
                    logger.info(f"🎯 [LEVEL FIXED] {level}")

            # 🚀 Level 1.0은 원본 파일 직접 반환 (최고속)
            if level >= 1.0:
                if not is_head:
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

            pyramid_path = pyramid_dir / f"{stem}_L{int(level*100)}.{format_ext}"
            if not is_head:
                logger.info(f"🎯 [PYRAMID PATH] {pyramid_path}")

            # 🚀 캐시 확인: 이미 존재하고 최신이면 즉시 반환
            import time
            t_cache_start = time.time()
            image_mtime = image_path.stat().st_mtime
            if pyramid_path.exists() and pyramid_path.stat().st_size > 0:
                if pyramid_path.stat().st_mtime >= image_mtime:
                    st = pyramid_path.stat()
                    file_size_mb = st.st_size / (1024*1024)
                    if not is_head:
                        logger.info(f"✅ [CACHE HIT] 파일: {file_size_mb:.1f}MB")

                    t_resp_start = time.time()
                    headers = {
                        "Cache-Control": "public, max-age=31536000, immutable",
                        "Content-Type": content_type,
                        "ETag": compute_etag(st),
                        "X-Pyramid-Level": str(level),
                        "X-Cache-Status": "HIT",
                        "X-File-Size": str(st.st_size)
                    }
                    response = FileResponse(pyramid_path, headers=headers)
                    if not is_head:
                        logger.info(f"⏱️ [DEBUG] FileResponse 생성: {(time.time()-t_resp_start)*1000:.0f}ms")
                        logger.info(f"⏱️ [DEBUG] 캐시 전체 시간: {(time.time()-t_cache_start)*1000:.0f}ms")
                    return response

            # 캐시 미스: 피라미드 이미지 생성
            if not is_head:
                logger.info(f"🎯 [CACHE MISS] 피라미드 생성 시작: level={level}")
            _generate_pyramid_sync(image_path, pyramid_path, level)

            # 🔥 Background에서 다른 레벨들도 생성 시작 (사용자 대기 없음)
            asyncio.create_task(_generate_other_levels_background(image_path, level, stem))

            # 생성된 파일 확인 및 반환
            if pyramid_path.exists():
                st = pyramid_path.stat()
                file_size_mb = st.st_size / (1024*1024)
                if not is_head:
                    logger.info(f"✅ [PYRAMID SUCCESS] 파일: {file_size_mb:.1f}MB ({st.st_size:,} bytes)")

                t_resp_start = time.time()
                headers = {
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Content-Type": content_type,
                    "ETag": compute_etag(st),
                    "X-Pyramid-Level": str(level),
                    "X-Cache-Status": "MISS",
                    "X-File-Size": str(st.st_size)
                }
                response = FileResponse(pyramid_path, headers=headers)
                if not is_head:
                    logger.info(f"⏱️ [DEBUG] FileResponse 생성: {(time.time()-t_resp_start)*1000:.0f}ms")
                return response
            else:
                if not is_head:
                    logger.error(f"❌ [GENERATION FAILED] {pyramid_path}")
                raise HTTPException(status_code=500, detail="Pyramid generation failed")
        else:
            # 원본 이미지 반환
            if not is_head:
                logger.info(f"🎯 [ORIGINAL MODE] {image_path}")
            st = image_path.stat()
            headers = {"Cache-Control": "public, max-age=86400", "ETag": compute_etag(st)}
            return FileResponse(image_path, headers=headers)

    except Exception as e:
        logger.exception(f"❌ [IMAGE API ERROR] {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/thumbnail")
async def get_thumbnail(request: Request, path: str, size: int = THUMBNAIL_SIZE_DEFAULT):
    try:
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

        # 🔍 current_folder 기준 루트 계산
        global current_folder
        search_root = current_folder.resolve()
        if not search_root.exists():
            search_root = ROOT_DIR
            current_folder = ROOT_DIR

        logger.info(f"🔍 [SEARCH DEBUG] current_folder: {current_folder}")
        logger.info(f"🔍 [SEARCH DEBUG] search_root: {search_root}")
        logger.info(f"🔍 [SEARCH DEBUG] ROOT_DIR: {ROOT_DIR}")
        logger.info(f"🔍 [SEARCH DEBUG] 검색어: {query}")
        logger.info(f"🔍 [SEARCH DEBUG] current_folder == ROOT_DIR: {current_folder.resolve() == ROOT_DIR.resolve()}")
        logger.info(f"🔍 [SEARCH DEBUG] limit: {limit}, offset: {offset}")

        # 🔄 썸네일 캐시 초기화 (검색 시 즉시 반영)
        THUMB_STAT_CACHE.clear()
        logger.info("🔍 [SEARCH DEBUG] 썸네일 캐시 초기화 완료")

        # 📁 current_folder 기준 prefix 계산
        try:
            prefix = str(search_root.relative_to(ROOT_DIR)).replace('\\', '/')
        except ValueError:
            prefix = ""
        if prefix == '.':
            prefix = ''
        prefix_with_sep = prefix.rstrip('/') + '/' if prefix else ""

        # 📚 인덱스 기반 1차 검색
        with FILE_INDEX_LOCK:
            if prefix:
                start_key = prefix_with_sep
                end_key = prefix_with_sep + '\uffff'
                start_idx = bisect_left(FILE_INDEX_KEYS, start_key)
                end_idx = bisect_right(FILE_INDEX_KEYS, end_key)
                keys_slice = FILE_INDEX_KEYS[start_idx:end_idx]
            else:
                keys_slice = list(FILE_INDEX_KEYS)

        loop = asyncio.get_running_loop()
        # 병렬 검색 사용 (환경변수 SEARCH_WORKERS로 조정 가능, 기본: 4)
        index_hits = await loop.run_in_executor(
            IO_POOL,
            _search_index_slice_parallel,
            keys_slice,
            query,
            goal,
            config.SEARCH_WORKERS
        )
        bucket.extend(index_hits)

        # 🗂️ 인덱스로 부족하면 현재 폴더 직접 스캔
        if len(bucket) < goal:
            seen = set(bucket)
            need = goal - len(bucket)

            def _scan():
                nonlocal need
                for root, dirs, files in os.walk(search_root):
                    for skip in list(SKIP_DIRS):
                        if skip in dirs: dirs.remove(skip)
                    for fn in files:
                        ext = os.path.splitext(fn)[1].lower()
                        if ext not in SUPPORTED_EXTENSIONS:
                            continue
                        low = fn.lower()
                        if query not in low:
                            continue
                        full = Path(root) / fn
                        try:
                            rel_to_root = str(full.relative_to(ROOT_DIR)).replace('\\', '/')
                        except Exception:
                            continue
                        if rel_to_root in seen:
                            continue
                        seen.add(rel_to_root)
                        bucket.append(rel_to_root)
                        try:
                            st = full.stat()
                            file_index_set(rel_to_root, {
                                "name_lower": low,
                                "size": st.st_size,
                                "modified": st.st_mtime
                            })
                        except Exception:
                            pass
                        need -= 1
                        if need <= 0:
                            return

            if need > 0:
                await loop.run_in_executor(IO_POOL, _scan)

        results = bucket[offset: offset + limit]

        logger.info(f"🔍 [SEARCH DEBUG] 검색결과수: {len(bucket)}")
        logger.info(f"🔍 [SEARCH DEBUG] 반환되는파일수: {len(results)}")
        if bucket:
            logger.info(f"🔍 [SEARCH DEBUG] 첫 결과: {bucket[0]}")
            if len(bucket) > 1:
                logger.info(f"🔍 [SEARCH DEBUG] 마지막 결과: {bucket[-1]}")

        return {"success": True, "results": results, "offset": offset, "limit": limit, "total": len(bucket)}
    except Exception as e:
        logger.exception(f"검색 중 오류: {e}")
        raise HTTPException(status_code=500, detail=str(e))
@app.get("/api/files/all")
async def get_all_files():
    try:
        with FILE_INDEX_LOCK:
            keys = list(FILE_INDEX_KEYS)
        if not keys and not INDEX_BUILDING:
            asyncio.create_task(build_file_index_background())
        return {"success": True, "files": keys}
    except Exception as e:
        logger.exception(f"전체 파일 목록 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/recursive")
async def get_files_recursive(path: str):
    """폴더 내 모든 파일을 재귀적으로 가져오기 (ROOT_DIR 기준 절대 경로)"""
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
            # classification, thumbnails 제외
            dirs[:] = [d for d in dirs if d not in ['classification', 'thumbnails']]
            
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
        
        return {"success": True, "files": files}
    except Exception as e:
        logger.exception(f"재귀 파일 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Classes ----------------
@app.get("/api/classes")
async def get_classes(folder: Optional[str] = Query(None, description="특정 폴더의 클래스만 조회"),
                     request: Request = None):
    try:
        # 🔍 디버그: 입력 파라미터
        logger.info(f"🔍 [/api/classes] ===== API 요청 받음 =====")
        logger.info(f"🔍 [/api/classes] folder 파라미터: {folder}")
        logger.info(f"🔍 [/api/classes] folder 파라미터 타입: {type(folder)}")
        logger.info(f"🔍 [/api/classes] folder 파라미터 길이: {len(folder) if folder else 0}")
        logger.info(f"🔍 [/api/classes] 전체 URL: {request.url if request else 'N/A'}")
        logger.info(f"🔍 [/api/classes] 쿼리 파라미터: {request.query_params if request else 'N/A'}")
        logger.info(f"🔍 [/api/classes] ROOT_DIR: {ROOT_DIR}")
        logger.info(f"🔍 [/api/classes] current_folder: {current_folder}")

        # 폴더가 지정된 경우 해당 폴더의 classification 디렉토리 사용
        if folder:
            target_folder = safe_resolve_path(folder)
            classification_dir = target_folder / "classification"
            logger.info(f"🔍 [/api/classes] folder 지정됨 - target_folder: {target_folder}")
        else:
            classification_dir = _classification_dir()
            logger.info(f"🔍 [/api/classes] folder 미지정 - current_folder: {current_folder}")

        # 🔍 디버그: 최종 classification 경로
        logger.info(f"✅ [/api/classes] 최종 classification_dir: {classification_dir}")
        logger.info(f"🔍 [/api/classes] classification_dir.exists(): {classification_dir.exists()}")

        _dircache_invalidate(classification_dir)
        if not classification_dir.exists():
            logger.warning(f"⚠️ [/api/classes] classification 폴더 없음 - 생성 시작: {classification_dir}")
            classification_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"✅ [/api/classes] classification 폴더 생성 완료: {classification_dir}")
            log_access_row(tag="INFO", note=f"classification 폴더 생성: {classification_dir}")
            return {"success": True, "classes": []}

        classes = []
        try:
            with os.scandir(classification_dir) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False): classes.append(entry.name)
            logger.info(f"✅ [/api/classes] 클래스 조회 완료: {len(classes)}개 ({classes})")
        except FileNotFoundError:
            logger.warning(f"⚠️ [/api/classes] FileNotFoundError - classification_dir: {classification_dir}")
            pass
        return {"success": True, "classes": sorted(classes, key=str.lower)}
    except Exception as e:
        logger.exception(f"분류 클래스 조회 실패: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/classes")
async def create_class(req: CreateClassReq,
                      folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                      _=Depends(labels_classes_sync_dep)):
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

        logger.info(f"🔍 [CREATE_CLASS] folder 파라미터: '{folder}'")
        logger.info(f"🔍 [CREATE_CLASS] ROOT_DIR: {ROOT_DIR}")
        logger.info(f"🔍 [CREATE_CLASS] current_folder: {current_folder}")
        logger.info(f"🔍 [CREATE_CLASS] _classification_dir(): {_classification_dir()}")

        name = req.name.strip()
        if not name or name.isspace(): raise HTTPException(status_code=400, detail="클래스명이 비어있습니다")
        if any(ord(c) < 32 or ord(c) > 126 for c in name):
            raise HTTPException(status_code=400, detail="클래스명에 특수문자/한글 자모 사용 불가 (A-Z,a-z,0-9,_,-)")
        if not _CLASS_NAME_RE.match(name): raise HTTPException(status_code=400, detail="클래스명 형식 오류")
        if len(name) > 50: raise HTTPException(status_code=400, detail="클래스명이 너무 깁니다 (최대 50자)")

        classification_dir = _classification_dir()
        logger.info(f"🔍 [CREATE_CLASS] classification_dir: {classification_dir}, exists: {classification_dir.exists()}")

        # classification 디렉토리가 없으면 생성
        if not classification_dir.exists():
            logger.info(f"🔍 [CREATE_CLASS] classification 디렉토리 생성: {classification_dir}")
            classification_dir.mkdir(parents=True, exist_ok=True)

        class_dir = classification_dir / name
        logger.info(f"🔍 [CREATE_CLASS] class_dir: {class_dir}, exists: {class_dir.exists()}")

        if class_dir.exists(): raise HTTPException(status_code=409, detail="Class already exists")

        logger.info(f"🔍 [CREATE_CLASS] 클래스 디렉토리 생성 시작: {class_dir}")
        logger.info(f"🔍 [CREATE_CLASS] 절대 경로: {class_dir.resolve()}")
        class_dir.mkdir(parents=True, exist_ok=False)
        logger.info(f"🔍 [CREATE_CLASS] 클래스 디렉토리 생성 완료: {class_dir}, exists: {class_dir.exists()}")
        logger.info(f"🔍 [CREATE_CLASS] 생성된 절대 경로: {class_dir.resolve()}")
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
                       folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                       _=Depends(labels_classes_sync_dep)):
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

        logger.info(f"🔍 [DELETE_CLASS] folder 파라미터: '{folder}'")
        logger.info(f"🔍 [DELETE_CLASS] ROOT_DIR: {ROOT_DIR}")
        logger.info(f"🔍 [DELETE_CLASS] current_folder: {current_folder}")
        logger.info(f"🔍 [DELETE_CLASS] _classification_dir(): {_classification_dir()}")

        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")
        class_dir = _classification_dir() / class_name
        logger.info(f"🔍 [DELETE_CLASS] class_dir: {class_dir}, 절대 경로: {class_dir.resolve()}")
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

class RenameClassReq(BaseModel):
    old_name: str = Field(..., min_length=1, max_length=128)
    new_name: str = Field(..., min_length=1, max_length=128)

@app.post("/api/classes/rename")
async def rename_class(req: RenameClassReq,
                       folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                       _=Depends(labels_classes_sync_dep)):
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

        old_name = req.old_name.strip()
        new_name = req.new_name.strip()

        # 검증
        if not _CLASS_NAME_RE.match(old_name): raise HTTPException(status_code=400, detail="Invalid old class name")
        if not _CLASS_NAME_RE.match(new_name): raise HTTPException(status_code=400, detail="Invalid new class name")
        if old_name == new_name: raise HTTPException(status_code=400, detail="Old and new names are the same")

        classification_dir = _classification_dir()
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
        for p in (_classification_dir(), old_class_dir, new_class_dir, ROOT_DIR): _dircache_invalidate(p)
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
                         folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                         _=Depends(labels_classes_sync_dep)):
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
            logger.info(f"🔍 [DELETE_CLASS] folder 파라미터: {folder}, current_folder: {current_folder}")
        else:
            current_folder = ROOT_DIR
            logger.info(f"🔍 [DELETE_CLASS] folder 파라미터 없음, current_folder: {current_folder}")

        if not req.names: raise HTTPException(status_code=400, detail="클래스명 목록이 비어있습니다")
        deleted, failed, total_cleaned = [], [], 0
        for class_name in req.names:
            try:
                class_name = class_name.strip()
                if not _CLASS_NAME_RE.match(class_name): raise ValueError("Invalid class name")
                class_dir = _classification_dir() / class_name
                logger.info(f"🔍 [DELETE_CLASS] class_dir: {class_dir}, exists: {class_dir.exists()}")
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
                       folder: Optional[str] = Query(None, description="특정 폴더의 클래스 이미지만 조회")):
    try:
        # 🔍 디버그: 입력 파라미터
        logger.info(f"🔍 [/api/classes/{{class_name}}/images] class_name: {class_name}")
        logger.info(f"🔍 [/api/classes/{{class_name}}/images] folder 파라미터: {folder}")
        logger.info(f"🔍 [/api/classes/{{class_name}}/images] current_folder: {current_folder}")
        logger.info(f"🔍 [/api/classes/{{class_name}}/images] ROOT_DIR: {ROOT_DIR}")

        if not _CLASS_NAME_RE.match(class_name): raise HTTPException(status_code=400, detail="Invalid class_name")

        # 폴더가 지정된 경우 해당 폴더의 classification 디렉토리 사용
        if folder:
            target_folder = safe_resolve_path(folder)
            class_dir = target_folder / "classification" / class_name
            logger.info(f"🔍 [/api/classes/{{class_name}}/images] folder 지정됨 - target_folder: {target_folder}")
        else:
            classification_base = _classification_dir()
            class_dir = classification_base / class_name
            logger.info(f"🔍 [/api/classes/{{class_name}}/images] folder 미지정 - classification_base: {classification_base}")

        # 🔍 디버그: 최종 class_dir 경로
        logger.info(f"✅ [/api/classes/{{class_name}}/images] 최종 class_dir: {class_dir}")
        logger.info(f"🔍 [/api/classes/{{class_name}}/images] class_dir.exists(): {class_dir.exists()}")

        if not class_dir.exists() or not class_dir.is_dir():
            logger.warning(f"⚠️ [/api/classes/{{class_name}}/images] class_dir 없음 또는 디렉토리 아님: {class_dir}")
            raise HTTPException(status_code=404, detail="Class not found")

        found: List[str] = []; goal = offset + limit
        for p in class_dir.rglob("*"):
            if p.is_file() and is_supported_image(p):
                rel = str(p.relative_to(ROOT_DIR)).replace("\\", "/")
                found.append(rel)
                if len(found) >= goal: break

        logger.info(f"✅ [/api/classes/{{class_name}}/images] 이미지 조회 완료: {len(found)}개 (offset={offset}, limit={limit})")
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
async def classify_images(request: ClassifyRequest,
                         folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                         _=Depends(labels_classes_sync_dep)):
    """이미지를 클래스로 분류하고 classification 디렉토리에 복사/링크"""
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

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
async def classify_images_batch(request: BatchClassifyRequest,
                                folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                                _=Depends(labels_classes_sync_dep)):
    """배치 이미지 분류"""
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

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

@app.delete("/api/classify")
async def delete_classification(request: ClassifyDeleteRequest,
                                folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                                _=Depends(labels_classes_sync_dep)):
    """classification 디렉토리에서 이미지 제거"""
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

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
async def classify_delete_batch(request: ClassifyDeleteBatchReq,
                                folder: Optional[str] = Query(None, description="현재 폴더 경로"),
                                _=Depends(labels_classes_sync_dep)):
    try:
        # 🔥 folder 파라미터가 있으면 current_folder 설정
        global current_folder
        if folder:
            current_folder = ROOT_DIR / folder
        else:
            current_folder = ROOT_DIR

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
async def read_root(request: Request):
    try:
        # AUTO_LOGIN=True일 때: SAML 인증 완료 후가 아니면 무조건 /saml/login으로 리다이렉트
        # 이렇게 하면 index.html 로드 전에 인증이 완료되어 Guest가 절대 나오지 않음
        if AUTO_LOGIN:
            # saml_success 파라미터가 없으면 무조건 SAML 로그인으로 리다이렉트
            # (SAML 인증 완료 후에는 saml_success=true와 함께 리다이렉트됨)
            if not request.query_params.get("saml_success"):
                logger.info("🔐 [AUTO_LOGIN] SAML 인증 미완료 → /saml/login으로 리다이렉트")
                return RedirectResponse("/saml/login", status_code=302)

            # SAML 인증 완료 후 → index.html 제공
            logger.info(f"✅ [AUTO_LOGIN] SAML 인증 완료 → index.html 제공")

        # AUTO_LOGIN=False 또는 SAML 인증 완료 → index.html 제공
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
        global INDEX_READY, INDEX_BUILDING
        logger.info("🔍 [CHANGE_FOLDER DEBUG] 썸네일 요청 카운터 리셋")
        
        INDEX_READY = False; INDEX_BUILDING = False

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

        # 🔥 모든 폴더를 이름 내림차순으로 정렬 (depth 무관)
        all_folders = folders + subfolders
        all_folders.sort(key=lambda x: x["name"].lower(), reverse=True)
        
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

    try:
        THUMBNAIL_EXECUTOR.shutdown(wait=False, cancel_futures=False)
    except Exception:
        pass

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
