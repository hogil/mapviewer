"""
L3Tracker bootstrap app.

Cold-path endpoints are served directly here so the first explorer render does not pay
the full FastAPI/Pydantic registration cost from the legacy application module.
The original application is lazy-loaded from `api.full_app` in the background and
receives every non-bootstrap request once it is ready.
"""

import asyncio
import gzip
import hashlib
import html
import importlib
import io
import json
import logging
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.staticfiles import StaticFiles

from . import config
from .access_logger import logger_instance
from .index_service import IndexService
from .search_service import SearchService


def _has_interactive_console() -> bool:
    try:
        return bool(
            getattr(sys.stdout, "isatty", lambda: False)()
            or getattr(sys.stderr, "isatty", lambda: False)()
        )
    except Exception:
        return False


if sys.platform == "win32" and _has_interactive_console():
    try:
        if sys.stdout.encoding != "utf-8":
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        if sys.stderr.encoding != "utf-8":
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
        os.system("chcp 65001 > nul 2>&1")
    except Exception:
        pass


ROOT_DIR = config.ROOT_DIR
current_folder = config.IMAGES_ROOT
AUTO_LOGIN = os.getenv("AUTO_LOGIN", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
DEFAULT_ORG_URL = os.getenv("DEFAULT_ORG_URL", "")
_THUMBNAIL_EXECUTOR_WORKERS = config.THUMBNAIL_EXECUTOR_WORKERS
SUPPORTED_EXTS = {ext.lower() for ext in config.SUPPORTED_EXTS}
SKIP_DIRS = set(config.SKIP_DIRS)
DIRLIST_EXECUTOR = ThreadPoolExecutor(max_workers=max(4, min(16, (os.cpu_count() or 8))))
SEARCH_EXECUTOR = ThreadPoolExecutor(max_workers=max(8, min(16, config.SEARCH_WORKERS)))
_BOOT_HOT_FOLDER = (os.getenv("BOOTSTRAP_HOT_FOLDER", "unknown").strip() or "unknown")

INDEX_SKIP_DIRS = {d.strip() for d in config.INDEX_SKIP_DIRS if d.strip()}
INDEX_CACHE_FILE = ROOT_DIR / ".file_index_cache.txt"
_lock_port = os.getenv("HTTPS_PORT", str(config.HTTPS_PORT))
INDEX_LOCK_FILE = ROOT_DIR / f".file_index_cache_{_lock_port}.lock"
SEARCH_FALLBACK_MAX_FILES = int(os.getenv("SEARCH_FALLBACK_MAX_FILES", "2000") or "0")
SEARCH_FALLBACK_TIMEOUT_MS = int(os.getenv("SEARCH_FALLBACK_TIMEOUT_MS", "5000") or "0")
_fallback_timeout_sec = SEARCH_FALLBACK_TIMEOUT_MS / 1000 if SEARCH_FALLBACK_TIMEOUT_MS > 0 else 5.0

bootstrap_index_service = IndexService(
    root_dir=ROOT_DIR,
    skip_dirs=INDEX_SKIP_DIRS,
    cache_file=INDEX_CACHE_FILE,
    lock_file=INDEX_LOCK_FILE,
    index_workers=config.INDEX_WORKERS,
    lock_wait_seconds=int(os.getenv("INDEX_LOCK_WAIT_SECONDS", "600")),
    logger=logging.getLogger("uvicorn.error"),
)
bootstrap_index_service._io_pool = SEARCH_EXECUTOR
bootstrap_search_service = SearchService(
    index_service=bootstrap_index_service,
    io_executor=SEARCH_EXECUTOR,
    logger=logging.getLogger("uvicorn.error"),
    search_workers=config.SEARCH_WORKERS,
    excluded_folders=[
        "classification",
        "classification_chips",
        "chip_annotations",
        "chip-object-v1",
        "obj_id_maps",
        "thumbnails",
        "composite_map",
        "yolo_datasets",
    ],
    supported_exts=config.SUPPORTED_EXTS,
    fallback_max_files=SEARCH_FALLBACK_MAX_FILES,
    fallback_timeout_sec=_fallback_timeout_sec,
)
_BOOTSTRAP_SEARCH_PREWARM_STARTED = False

_DIRLIST_CACHE: Dict[str, Dict[str, Any]] = {}
_BROWSE_FOLDERS_CACHE: Optional[Dict[str, Any]] = None
_BROWSE_FOLDERS_CACHE_TIME: float = 0.0


def _iter_static_asset_paths() -> Iterable[Path]:
    yield Path("index.html")
    for root_name in ("js", "css"):
        root = Path(root_name)
        if not root.exists():
            continue
        for child in sorted(root.glob("*")):
            if child.is_file():
                yield child


def _compute_static_asset_signature() -> str:
    parts: List[str] = []
    for asset_path in _iter_static_asset_paths():
        try:
            st = asset_path.stat()
        except OSError:
            continue
        parts.append(f"{asset_path.as_posix()}:{st.st_mtime_ns}:{st.st_size}")
    if not parts:
        return str(int(time.time()))
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()[:12]


def _compose_js_version(signature: str) -> str:
    return signature


_STATIC_ASSET_SIGNATURE = _compute_static_asset_signature()
_JS_VERSION = _compose_js_version(_STATIC_ASSET_SIGNATURE)


def _refresh_static_asset_version_if_modified() -> bool:
    global _STATIC_ASSET_SIGNATURE, _JS_VERSION
    new_signature = _compute_static_asset_signature()
    if new_signature == _STATIC_ASSET_SIGNATURE:
        return False
    _STATIC_ASSET_SIGNATURE = new_signature
    _JS_VERSION = _compose_js_version(new_signature)
    _JS_CACHE.clear()
    return True


_CACHED_INDEX_HTML: Optional[str] = None
_CACHED_INDEX_HTML_GZ: bytes = b""
_CACHED_INDEX_MTIME_NS: int = 0
_BOOTSTRAP_USER_IDLE_SECONDS = max(0.25, float(os.getenv("BOOTSTRAP_USER_IDLE_SECONDS", "1.5") or "1.5"))
_BOOTSTRAP_FULL_APP_DELAY_SECONDS = max(0.0, float(os.getenv("BOOTSTRAP_FULL_APP_DELAY_SECONDS", "0.3") or "0.3"))
_USER_ACTIVITY_UNTIL = 0.0
_ANONYMOUS_LOGIN_ID = (config.FALLBACK_LOGIN_ID or "notsaml").strip() or "notsaml"
_LOGIN_ID_SENTINELS = {_ANONYMOUS_LOGIN_ID.lower(), "guest"}


def _mark_user_activity() -> None:
    global _USER_ACTIVITY_UNTIL
    _USER_ACTIVITY_UNTIL = time.monotonic() + _BOOTSTRAP_USER_IDLE_SECONDS


def _user_priority_active() -> bool:
    return time.monotonic() < _USER_ACTIVITY_UNTIL


def _is_internal_bootstrap_request(request: Request) -> bool:
    return request.headers.get("X-L3-Startup-Warm") == "1"


def _normalize_login_id_candidate(value: Any) -> Optional[str]:
    if value is None:
        return None
    candidate = str(value).strip()
    if not candidate:
        return None
    if candidate.lower() in _LOGIN_ID_SENTINELS:
        return None
    return candidate


def _bootstrap_current_login_id(request: Request) -> Optional[str]:
    loaded_module = _FULL_APP.get_loaded_module()
    if loaded_module is not None:
        resolver = getattr(loaded_module, "_current_login_id", None)
        if callable(resolver):
            try:
                login_id = resolver(request)
            except Exception:
                login_id = None
            if login_id:
                return login_id

    try:
        for key in ("LoginId", "loginId", "login_id"):
            candidate = _normalize_login_id_candidate(request.query_params.get(key))
            if candidate:
                return candidate
    except Exception:
        pass

    for cookie_name in ("session_user", "saml_login_id"):
        candidate = _normalize_login_id_candidate(request.cookies.get(cookie_name))
        if candidate:
            return candidate

    return None


def _track_bootstrap_page_visit(request: Request, status_code: int) -> None:
    if _is_internal_bootstrap_request(request):
        return

    login_id = _bootstrap_current_login_id(request)
    if not login_id:
        return

    try:
        request.state.session_user = login_id
        logger_instance.log_access(request, str(request.url.path), status_code, is_page_visit=True)
    except Exception:
        logging.getLogger("uvicorn.error").exception("bootstrap page visit logging failed")


def _dir_state_signature(path: Path) -> Optional[str]:
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{st.st_mtime_ns}:{st.st_ctime_ns}"


def list_dir_fast(target: Path) -> List[Dict[str, str]]:
    key = str(target)
    current_signature = _dir_state_signature(target)
    cached = _DIRLIST_CACHE.get(key)
    if cached and cached.get("signature") == current_signature and isinstance(cached.get("items"), list):
        return cached["items"]

    items: List[Dict[str, str]] = []
    root_dir_str = str(ROOT_DIR.resolve()).replace("\\", "/")
    root_dir_len = len(root_dir_str)

    with os.scandir(target) as it:
        for entry in it:
            name = entry.name
            if name.startswith(".") or name == "__pycache__" or name in SKIP_DIRS:
                continue
            entry_path = str(entry.path).replace("\\", "/")
            if entry_path.startswith(root_dir_str):
                root_relative = entry_path[root_dir_len:].lstrip("/")
            else:
                root_relative = name
            items.append({
                "name": name,
                "type": "directory" if entry.is_dir(follow_symlinks=False) else "file",
                "path": entry_path,
                "root_relative": root_relative,
            })

    _DIRLIST_CACHE[key] = {"signature": current_signature, "items": items}
    return items


def _scan_browse_folders_tree(target_path: Path) -> Dict[str, List[Dict[str, Any]]]:
    folders: List[Dict[str, Any]] = []
    subfolders: List[Dict[str, Any]] = []
    skip_dir_names = {"classification", "classification_chips", "thumbnails", "labels"}
    skip_dir_names.update(SKIP_DIRS)

    with os.scandir(target_path) as it:
        for entry in it:
            if entry.is_dir(follow_symlinks=False) and not entry.name.startswith(".") and entry.name not in skip_dir_names:
                folders.append({
                    "name": entry.name,
                    "path": str(entry.path),
                    "type": "folder",
                    "depth": 1,
                })

    for folder in folders:
        try:
            with os.scandir(folder["path"]) as sub_it:
                for sub_entry in sub_it:
                    if (
                        sub_entry.is_dir(follow_symlinks=False)
                        and not sub_entry.name.startswith(".")
                        and sub_entry.name not in skip_dir_names
                    ):
                        subfolders.append({
                            "name": f"{folder['name']} / {sub_entry.name}",
                            "path": str(sub_entry.path),
                            "type": "folder",
                            "depth": 2,
                            "parent": folder["name"],
                        })
        except PermissionError:
            continue
        except Exception:
            continue

    all_folders = folders + subfolders
    all_folders.sort(key=lambda item: item["name"].lower(), reverse=True)
    return {"folders": all_folders}


def _build_bootstrap_folder_links(folder_name: str, limit: int = 12) -> str:
    folder_path = ROOT_DIR / folder_name
    if not folder_path.exists() or not folder_path.is_dir():
        return ""

    try:
        items = list_dir_fast(folder_path)
    except Exception:
        return ""

    file_items = [item for item in items if item["type"] == "file" and Path(item["name"]).suffix.lower() in SUPPORTED_EXTS]
    if not file_items:
        return ""

    links = ["<ul>"]
    for item in file_items[:limit]:
        full_path = item.get("root_relative") or f"{folder_name}/{item['name']}"
        links.append(
            f'<li><a href="#" data-path="{html.escape(full_path, quote=True)}" draggable="true">📄 {html.escape(item["name"])}</a></li>'
        )
    links.append("</ul>")
    return "".join(links)


def _build_bootstrap_explorer_html() -> str:
    try:
        folders = _scan_browse_folders_tree(ROOT_DIR).get("folders", [])
    except Exception:
        return '<p style="padding: 10px; color: var(--text-secondary-color);">Loading files...</p>'

    root_folders = [folder for folder in folders if folder and (folder.get("depth") == 1 or folder.get("depth") is None)]
    if not root_folders:
        return '<p style="padding: 10px; color: var(--text-secondary-color);">Loading files...</p>'

    parts = ["<ul>"]
    for folder in root_folders:
        name = str(folder.get("name") or "")
        if not name:
            continue
        safe_name = html.escape(name)
        safe_path = html.escape(name, quote=True)
        content = '<div class="folder-content" style="padding-left: 0.5rem;"></div>'
        boot_attr = ""
        if name == _BOOT_HOT_FOLDER:
            preloaded_links = _build_bootstrap_folder_links(name)
            if preloaded_links:
                content = f'<div class="folder-content" style="padding-left: 0.5rem;">{preloaded_links}</div>'
                boot_attr = ' data-boot-hydrated="true"'
        parts.append(
            f'<li><details{boot_attr}><summary data-path="{safe_path}" class="folder">📁 {safe_name}</summary>{content}</details></li>'
        )
    parts.append("</ul>")
    return "".join(parts)


def _build_index_cache() -> None:
    global _CACHED_INDEX_HTML, _CACHED_INDEX_HTML_GZ, _CACHED_INDEX_MTIME_NS
    html_path = Path("index.html")
    if not html_path.exists():
        _CACHED_INDEX_HTML = None
        _CACHED_INDEX_HTML_GZ = b""
        _CACHED_INDEX_MTIME_NS = 0
        return

    content = html_path.read_text(encoding="utf-8")
    content = re.sub(r'(/js/[^"\']+\.js)(?:\?v=[^"\']*)?', rf"\1?v={_JS_VERSION}", content)
    content = re.sub(r'(/css/[^"\']+\.css)(?:\?v=[^"\']*)?', rf"\1?v={_JS_VERSION}", content)
    explorer_markup = _build_bootstrap_explorer_html()
    content = re.sub(
        r'<nav id="file-explorer" aria-label="폴더 및 파일 목록">.*?</nav>',
        f'<nav id="file-explorer" aria-label="폴더 및 파일 목록" data-server-prerendered="true">{explorer_markup}</nav>',
        content,
        count=1,
        flags=re.S,
    )
    _CACHED_INDEX_HTML = content
    _CACHED_INDEX_HTML_GZ = gzip.compress(content.encode("utf-8"), compresslevel=5)
    try:
        _CACHED_INDEX_MTIME_NS = html_path.stat().st_mtime_ns
    except OSError:
        _CACHED_INDEX_MTIME_NS = 0


def _refresh_index_cache_if_modified() -> None:
    html_path = Path("index.html")
    try:
        current_mtime = html_path.stat().st_mtime_ns
    except OSError:
        current_mtime = 0
    static_changed = _refresh_static_asset_version_if_modified()
    if current_mtime != _CACHED_INDEX_MTIME_NS or static_changed:
        _build_index_cache()


_JS_DIR = Path("js")
_JS_CACHE: Dict[str, Tuple[bytes, bytes, str, int]] = {}
_CRITICAL_JS_PRELOAD = frozenset({
    "boot-explorer.js",
    "fetch-optimizer.js",
    "page-manager.js",
    "search.js",
})
_JS_IMPORT_FROM_RE = re.compile(r"((?:from\s+))(['\"])((?:\./|\.\./)[^'\"]+\.js(?:\?[^'\"]*)?)(['\"])", re.MULTILINE)
_JS_DYNAMIC_IMPORT_RE = re.compile(r"((?:import\s*\(\s*))(['\"])((?:\./|\.\./)[^'\"]+\.js(?:\?[^'\"]*)?)(['\"])", re.MULTILINE)
_JS_WORKER_RE = re.compile(r"((?:new\s+Worker\s*\(\s*))(['\"])((?:/js/|\./|\.\./)[^'\"]+\.js(?:\?[^'\"]*)?)(['\"])", re.MULTILINE)
_JS_PATH_ASSIGN_RE = re.compile(r"((?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)(['\"])((?:/js/|\./|\.\./)[^'\"]+\.js(?:\?[^'\"]*)?)(['\"])", re.MULTILINE)


def _append_version_query(url: str, version: str) -> str:
    base, sep, query = url.partition("?")
    if not sep:
        return f"{url}?v={version}"
    kept = [part for part in query.split("&") if part and not part.startswith("v=")]
    kept.insert(0, f"v={version}")
    return f"{base}?{'&'.join(kept)}"


def _transform_js_source(text: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        return f"{match.group(1)}{match.group(2)}{_append_version_query(match.group(3), _JS_VERSION)}{match.group(4)}"

    text = _JS_IMPORT_FROM_RE.sub(_replace, text)
    text = _JS_DYNAMIC_IMPORT_RE.sub(_replace, text)
    text = _JS_WORKER_RE.sub(_replace, text)
    text = _JS_PATH_ASSIGN_RE.sub(_replace, text)
    return text


def _build_js_entry(path: Path) -> Tuple[bytes, bytes, str, int]:
    text = path.read_text(encoding="utf-8")
    raw = _transform_js_source(text).encode("utf-8")
    gz = gzip.compress(raw, compresslevel=6)
    etag = hashlib.md5(raw).hexdigest()[:12]
    mtime_ns = path.stat().st_mtime_ns
    return raw, gz, etag, mtime_ns


def _preload_js_assets() -> None:
    return


def _get_js_entry(filename: str) -> Optional[Tuple[bytes, bytes, str, int]]:
    path = _JS_DIR / filename
    cached = _JS_CACHE.get(filename)
    try:
        current_mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        _JS_CACHE.pop(filename, None)
        return None
    if cached is None or len(cached) != 4 or cached[3] != current_mtime:
        try:
            _JS_CACHE[filename] = _build_js_entry(path)
        except Exception:
            return cached if cached and len(cached) == 4 else None
    return _JS_CACHE.get(filename)


_CSS_DIR = Path("css")
_CSS_CACHE: Dict[str, Tuple[bytes, bytes, str, int]] = {}


def _build_css_entry(path: Path) -> Tuple[bytes, bytes, str, int]:
    raw = path.read_bytes()
    gz = gzip.compress(raw, compresslevel=6)
    etag = hashlib.md5(raw).hexdigest()[:12]
    mtime_ns = path.stat().st_mtime_ns
    return raw, gz, etag, mtime_ns


def _preload_css_assets() -> None:
    return


def _get_css_entry(filename: str) -> Optional[Tuple[bytes, bytes, str, int]]:
    path = _CSS_DIR / filename
    cached = _CSS_CACHE.get(filename)
    try:
        current_mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        _CSS_CACHE.pop(filename, None)
        return None
    if cached is None or len(cached) != 4 or cached[3] != current_mtime:
        try:
            _CSS_CACHE[filename] = _build_css_entry(path)
        except Exception:
            return cached if cached and len(cached) == 4 else None
    return _CSS_CACHE.get(filename)


_build_index_cache()
_preload_js_assets()
_preload_css_assets()


class LazyFullAppManager:
    def __init__(self, module_name: str = "api.full_app") -> None:
        self.module_name = module_name
        self._load_task: Optional[asyncio.Task[None]] = None
        self._ready_event = asyncio.Event()
        self._module: Optional[Any] = None
        self._app: Optional[Any] = None
        self._lifespan_cm: Optional[Any] = None
        self._load_error: Optional[BaseException] = None
        self._lock = asyncio.Lock()
        self._load_mode = "idle"
        self._load_started = False

    @property
    def loading(self) -> bool:
        return self._load_task is not None and not self._load_task.done()

    @property
    def load_error(self) -> Optional[BaseException]:
        return self._load_error

    def get_loaded_module(self) -> Optional[Any]:
        return self._module

    def ensure_loading(self, immediate: bool = False) -> None:
        if self._app is not None:
            return
        if self._ready_event.is_set():
            self._ready_event.clear()
        desired_mode = "immediate" if immediate else "idle"
        if self._load_task is not None and not self._load_task.done():
            if self._load_mode == desired_mode or (immediate and self._load_started):
                return
            self._load_task.cancel()
        self._load_error = None
        self._load_mode = desired_mode
        task_name = "l3-full-app-loader-now" if immediate else "l3-full-app-loader-idle"
        loader = self._load_full_app_now() if immediate else self._load_full_app_when_idle()
        self._load_task = asyncio.create_task(loader, name=task_name)

    async def _load_full_app_when_idle(self) -> None:
        if _BOOTSTRAP_FULL_APP_DELAY_SECONDS > 0:
            await asyncio.sleep(_BOOTSTRAP_FULL_APP_DELAY_SECONDS)
        while _user_priority_active():
            await asyncio.sleep(0.05)
        await self._load_full_app_now()

    async def _load_full_app_now(self) -> None:
        async with self._lock:
            if self._app is not None:
                return
            self._load_started = True
            bootlog = logging.getLogger("uvicorn.error")
            started = time.perf_counter()
            try:
                loop = asyncio.get_running_loop()
                module = await loop.run_in_executor(None, importlib.import_module, self.module_name)
                if hasattr(module, "current_folder"):
                    module.current_folder = current_folder
                app = getattr(module, "app", None)
                if app is None:
                    raise RuntimeError(f"{self.module_name} does not expose app")
                lifespan_cm = app.router.lifespan_context(app)
                await lifespan_cm.__aenter__()
                self._module = module
                self._app = app
                self._lifespan_cm = lifespan_cm
                bootlog.info("✅ [BOOTSTRAP] full app ready in %.0fms", (time.perf_counter() - started) * 1000.0)
                self._ready_event.set()
            except asyncio.CancelledError:
                bootlog.warning("⚠️ [BOOTSTRAP] full app load cancelled before ready")
                raise
            except BaseException as exc:
                self._load_error = exc
                bootlog.exception("❌ [BOOTSTRAP] full app load failed: %s", exc)
            finally:
                self._load_started = False

    async def wait_until_ready(self, timeout: Optional[float] = None) -> Optional[Any]:
        self.ensure_loading(immediate=True)
        task = self._load_task
        if task is None:
            return self._app
        try:
            if timeout is None:
                await asyncio.shield(task)
            else:
                await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            return None
        return self._app

    def sync_runtime_state(self) -> None:
        module = self._module
        if module is not None and hasattr(module, "current_folder"):
            module.current_folder = current_folder

    async def shutdown(self) -> None:
        task = self._load_task
        if task is not None and not task.done():
            try:
                task.cancel()
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        if self._lifespan_cm is not None:
            try:
                await self._lifespan_cm.__aexit__(None, None, None)
            except Exception:
                logging.getLogger("uvicorn.error").exception("❌ [BOOTSTRAP] full app shutdown failed")


_FULL_APP = LazyFullAppManager()


def _parse_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _parse_int(value: Optional[str], default: int) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except Exception:
        return default


_LOT_FILE_TOKEN_EXT_RE = re.compile(r"\.(?:png|jpe?g|bmp|tiff?|webp)$", re.IGNORECASE)


def _split_simple_lot_slash_list(value: str) -> List[str]:
    if "/" not in value or "\\" in value:
        return []
    parts = [part.strip() for part in value.split("/") if part.strip()]
    if len(parts) < 2:
        return []
    if all("_" not in part and not _LOT_FILE_TOKEN_EXT_RE.search(part) for part in parts):
        return parts
    return []


def _iter_lot_filter_candidates(raw: str):
    for part in re.split(r"[,\n\r;]+", raw):
        cleaned = re.sub(r"[\t ]+", " ", part.strip())
        if not cleaned:
            continue
        fields = [field for field in cleaned.split(" ") if field]
        if not fields:
            continue
        first = fields[0]
        slash_lots = _split_simple_lot_slash_list(first)
        if slash_lots:
            yield from slash_lots
        else:
            yield first


def _parse_lot_filter(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    tokens: List[str] = []
    seen: set[str] = set()
    for part in _iter_lot_filter_candidates(raw):
        cleaned = part.strip().lower()
        if not cleaned:
            continue
        basename = cleaned.replace("\\", "/").split("/")[-1]
        lot_token = basename.split("_", 1)[0].strip()
        if "." in lot_token:
            dot_idx = lot_token.index(".")
            if dot_idx > 0:
                lot_token = lot_token[:dot_idx]
        if not lot_token or lot_token in seen:
            continue
        seen.add(lot_token)
        tokens.append(lot_token)
        if len(tokens) >= 1000:
            break
    return tokens


def _parse_lot_wafer(raw: Optional[str]) -> List[Tuple[str, str]]:
    if not raw:
        return []
    pairs: List[Tuple[str, str]] = []
    seen: set[str] = set()
    for part in re.split(r"[,\n\r\t;]+", raw):
        part = part.strip().lower()
        if not part or ":" not in part:
            continue
        lot_raw, wafer_raw = part.split(":", 1)
        lot = lot_raw.strip()
        wafer = wafer_raw.strip()
        if "." in lot:
            dot_idx = lot.index(".")
            if dot_idx > 0:
                lot = lot[:dot_idx]
        if "." in wafer:
            dot_idx = wafer.index(".")
            if dot_idx > 0:
                wafer = wafer[:dot_idx]
        if not lot or not wafer:
            continue
        key = f"{lot}:{wafer}"
        if key in seen:
            continue
        seen.add(key)
        pairs.append((lot, wafer))
        if len(pairs) >= 1000:
            break
    return pairs


def _ensure_bootstrap_search_prewarm() -> None:
    global _BOOTSTRAP_SEARCH_PREWARM_STARTED
    if _BOOTSTRAP_SEARCH_PREWARM_STARTED:
        return
    _BOOTSTRAP_SEARCH_PREWARM_STARTED = True

    async def _run() -> None:
        bootlog = logging.getLogger("uvicorn.error")
        loop = asyncio.get_running_loop()
        started = time.perf_counter()
        try:
            loaded = await loop.run_in_executor(
                SEARCH_EXECUTOR,
                lambda: bootstrap_index_service.load_cache(log=False),
            )
            if loaded and bootstrap_index_service.keys:
                bootlog.info(
                    "✅ [BOOTSTRAP] search cache ready: %d files (%.0fms)",
                    len(bootstrap_index_service.keys),
                    (time.perf_counter() - started) * 1000.0,
                )
            else:
                bootlog.warning(
                    "⚠️ [BOOTSTRAP] search cache not ready after preload (%.0fms)",
                    (time.perf_counter() - started) * 1000.0,
                )
        except Exception as exc:
            bootlog.exception("❌ [BOOTSTRAP] search cache preload failed: %s", exc)

    asyncio.create_task(_run(), name="bootstrap-search-cache-prewarm")


def safe_resolve_path(path: Optional[str]) -> Path:
    if not path:
        return current_folder
    try:
        root_resolved = ROOT_DIR.resolve()
        raw_path = str(path).strip()
        path_obj = Path(raw_path)
        if path_obj.is_absolute():
            target = path_obj.resolve()
        else:
            normalized = os.path.normpath(raw_path.lstrip("/\\"))
            target = (root_resolved / normalized).resolve()
        target.relative_to(root_resolved)
        return target
    except ValueError:
        raise ValueError("Invalid path")
    except Exception as exc:
        raise ValueError(f"Invalid path: {exc}") from exc


async def _maybe_forward_to_full_app(handler_name: str, *args: Any, **kwargs: Any) -> Optional[Any]:
    module = _FULL_APP.get_loaded_module()
    if module is None:
        return None
    _FULL_APP.sync_runtime_state()
    handler = getattr(module, handler_name, None)
    if handler is None:
        return None
    result = handler(*args, **kwargs)
    if asyncio.iscoroutine(result):
        return await result
    return result


def _bootstrap_search_state() -> Dict[str, Any]:
    status = bootstrap_index_service.status()
    indexed_files = int(status.get("indexed_files") or 0)
    ready = bool(status.get("index_ready") and indexed_files > 0)
    return {
        "backend": "bootstrap",
        "loaded": True,
        "ready": ready,
        "indexed_files": indexed_files,
        "building": bool(status.get("index_building")),
        "loading_cache": bool(status.get("index_cache_loading")),
        "timestamp": status.get("timestamp"),
    }


def _full_app_search_state() -> Dict[str, Any]:
    module = _FULL_APP.get_loaded_module()
    if module is None:
        return {
            "backend": "full-app",
            "loaded": False,
            "ready": False,
            "indexed_files": 0,
            "building": _FULL_APP.loading,
            "loading_cache": False,
            "load_error": str(_FULL_APP.load_error) if _FULL_APP.load_error is not None else None,
        }

    index_service = getattr(module, "index_service", None)
    if index_service is None:
        return {
            "backend": "full-app",
            "loaded": True,
            "ready": False,
            "indexed_files": 0,
            "building": False,
            "loading_cache": False,
            "load_error": "full_app.index_service missing",
        }

    status = index_service.status() if hasattr(index_service, "status") else {}
    indexed_files = int(status.get("indexed_files") or 0)
    ready = bool(status.get("index_ready") and indexed_files > 0)
    return {
        "backend": "full-app",
        "loaded": True,
        "ready": ready,
        "indexed_files": indexed_files,
        "building": bool(status.get("index_building")),
        "loading_cache": bool(status.get("index_cache_loading")),
        "timestamp": status.get("timestamp"),
        "load_error": str(_FULL_APP.load_error) if _FULL_APP.load_error is not None else None,
    }


def _active_search_backend_state() -> Dict[str, Any]:
    full_app_state = _full_app_search_state()
    bootstrap_state = _bootstrap_search_state()
    active_backend = "full-app" if full_app_state["ready"] else "bootstrap"
    active_state = full_app_state if active_backend == "full-app" else bootstrap_state
    return {
        "backend": active_backend,
        "ready": bool(active_state["ready"]),
        "indexed_files": int(active_state["indexed_files"]),
        "building": bool(active_state["building"]),
        "loading_cache": bool(active_state["loading_cache"]),
        "bootstrap": bootstrap_state,
        "full_app": full_app_state,
    }


class LazyFullAppProxy:
    def __init__(self, manager: LazyFullAppManager) -> None:
        self.manager = manager

    async def __call__(self, scope: Dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            response = PlainTextResponse("Unsupported scope", status_code=500)
            await response(scope, receive, send)
            return

        app = await self.manager.wait_until_ready(timeout=15.0)
        if app is None:
            detail = "full app is still warming up"
            if self.manager.load_error is not None:
                detail = f"full app load failed: {self.manager.load_error}"
            response = JSONResponse({"success": False, "detail": detail}, status_code=503)
            await response(scope, receive, send)
            return

        self.manager.sync_runtime_state()
        await app(scope, receive, send)


@asynccontextmanager
async def lifespan(app: Starlette):
    bootlog = logging.getLogger("uvicorn.error")
    bootlog.info("🚀 [BOOTSTRAP] L3Tracker bootstrap starting")
    scheme = "HTTPS" if config.SSL_ENABLED else "HTTP"
    port_to_log = config.HTTPS_PORT if config.SSL_ENABLED else config.DEFAULT_PORT
    bootlog.info("📍 호스트: %s", config.DEFAULT_HOST)
    bootlog.info("🔌 포트: %s (%s)", port_to_log, scheme)
    bootlog.info("📁 ROOT_DIR: %s", config.ROOT_DIR)
    _ensure_bootstrap_search_prewarm()
    _FULL_APP.ensure_loading(immediate=False)
    bootlog.info("🚀 [BOOTSTRAP] full app idle import scheduled")
    yield
    await _FULL_APP.shutdown()
    try:
        SEARCH_EXECUTOR.shutdown(wait=False, cancel_futures=False)
    except Exception:
        pass
    try:
        DIRLIST_EXECUTOR.shutdown(wait=False, cancel_futures=False)
    except Exception:
        pass


app = Starlette(debug=False, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], allow_credentials=False)


class UserPriorityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not _is_internal_bootstrap_request(request):
            _mark_user_activity()
        return await call_next(request)


app.add_middleware(UserPriorityMiddleware)


async def api_config(request: Request):
    forwarded = await _maybe_forward_to_full_app("api_config")
    if forwarded is not None:
        return JSONResponse(forwarded)
    return JSONResponse({
        "AUTO_LOGIN": AUTO_LOGIN,
        "DEFAULT_ORG_URL": DEFAULT_ORG_URL,
        "PYRAMID_LEVELS": config.PYRAMID_LEVELS,
        "PYRAMID_ZOOM_THRESHOLDS": config.PYRAMID_ZOOM_THRESHOLDS,
        "THUMB_BATCH_SIZE": config.THUMB_PREFETCH_BATCH,
        "THUMB_MAX_CONCURRENCY": config.THUMB_CLIENT_MAX_CONCURRENCY,
        "GRID_MAX_CONCURRENCY": config.GRID_MAX_CONCURRENCY,
        "MEASURE_PREFETCH_CONCURRENCY": config.MEASURE_PREFETCH_CONCURRENCY,
        "THUMBNAIL_EXECUTOR_WORKERS": _THUMBNAIL_EXECUTOR_WORKERS,
    })


async def api_index_status(request: Request):
    forwarded = await _maybe_forward_to_full_app("api_index_status")
    if forwarded is not None:
        return JSONResponse(forwarded)
    return JSONResponse({
        "ready": False,
        "building": _FULL_APP.loading,
        "total_files": 0,
        "total_dirs": 0,
    })


async def get_current_folder(request: Request):
    forwarded = await _maybe_forward_to_full_app("get_current_folder")
    if forwarded is not None:
        return JSONResponse(forwarded)
    try:
        rel_path = str(current_folder.resolve().relative_to(ROOT_DIR.resolve())).replace("\\", "/")
        current_folder_prefix = rel_path + "/" if rel_path and rel_path != "." else ""
    except ValueError:
        current_folder_prefix = ""
    return JSONResponse({
        "current_folder": str(current_folder),
        "current_folder_prefix": current_folder_prefix,
    })


async def get_root_folder(request: Request):
    forwarded = await _maybe_forward_to_full_app("get_root_folder")
    if forwarded is not None:
        return JSONResponse(forwarded)
    return JSONResponse({"root_folder": str(ROOT_DIR)})


async def change_folder(request: Request):
    global current_folder, _BROWSE_FOLDERS_CACHE, _BROWSE_FOLDERS_CACHE_TIME
    forwarded = await _maybe_forward_to_full_app("change_folder", request)
    if forwarded is not None:
        module = _FULL_APP.get_loaded_module()
        if module is not None and hasattr(module, "current_folder"):
            current_folder = module.current_folder
        return JSONResponse(forwarded)

    data = json.loads((await request.body()) or b"{}")
    new_path = data.get("path")
    if not new_path:
        return JSONResponse({"detail": "폴더 경로가 필요합니다"}, status_code=400)

    new_path_obj = Path(new_path).resolve()
    if not new_path_obj.exists():
        return JSONResponse({"detail": "폴더가 존재하지 않습니다"}, status_code=404)
    if not new_path_obj.is_dir():
        return JSONResponse({"detail": "유효한 폴더가 아닙니다"}, status_code=400)

    current_folder = new_path_obj
    _DIRLIST_CACHE.clear()
    _BROWSE_FOLDERS_CACHE = None
    _BROWSE_FOLDERS_CACHE_TIME = 0.0

    try:
        rel_path = str(current_folder.resolve().relative_to(ROOT_DIR.resolve())).replace("\\", "/")
        current_folder_prefix = rel_path + "/" if rel_path and rel_path != "." else ""
    except ValueError:
        current_folder_prefix = ""

    return JSONResponse({
        "success": True,
        "message": f"검색 폴더가 '{new_path}'로 변경되었습니다",
        "root_dir": str(ROOT_DIR),
        "current_folder": str(current_folder),
        "current_folder_prefix": current_folder_prefix,
    })


async def clear_cache(request: Request):
    global _BROWSE_FOLDERS_CACHE, _BROWSE_FOLDERS_CACHE_TIME
    forwarded = await _maybe_forward_to_full_app("clear_cache", request)
    if forwarded is not None:
        return JSONResponse(forwarded)
    _DIRLIST_CACHE.clear()
    _BROWSE_FOLDERS_CACHE = None
    _BROWSE_FOLDERS_CACHE_TIME = 0.0
    return JSONResponse({
        "success": True,
        "message": "bootstrap caches cleared",
        "cleared_caches": ["dirlist", "browse-folders"],
    })


async def clear_all_cache(request: Request):
    global _BROWSE_FOLDERS_CACHE, _BROWSE_FOLDERS_CACHE_TIME
    forwarded = await _maybe_forward_to_full_app("clear_all_cache", request)
    if forwarded is not None:
        return JSONResponse(forwarded)
    _DIRLIST_CACHE.clear()
    _BROWSE_FOLDERS_CACHE = None
    _BROWSE_FOLDERS_CACHE_TIME = 0.0
    return JSONResponse({
        "success": True,
        "message": "bootstrap caches cleared",
        "cleared_caches": ["dirlist", "browse-folders"],
    })


async def browse_folders(request: Request):
    global _BROWSE_FOLDERS_CACHE, _BROWSE_FOLDERS_CACHE_TIME
    path = request.query_params.get("path")
    forwarded = await _maybe_forward_to_full_app("browse_folders", path)
    if forwarded is not None:
        return JSONResponse(forwarded)

    if _BROWSE_FOLDERS_CACHE and (time.time() - _BROWSE_FOLDERS_CACHE_TIME) < 60.0:
        return JSONResponse(_BROWSE_FOLDERS_CACHE)

    target_path = ROOT_DIR
    if not target_path.exists() or not target_path.is_dir():
        return JSONResponse({"detail": "ROOT_DIR을 찾을 수 없습니다"}, status_code=404)

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(DIRLIST_EXECUTOR, _scan_browse_folders_tree, target_path)
    except PermissionError:
        return JSONResponse({"detail": "폴더 접근 권한이 없습니다"}, status_code=403)

    _BROWSE_FOLDERS_CACHE = result
    _BROWSE_FOLDERS_CACHE_TIME = time.time()
    return JSONResponse(result)


async def get_files(request: Request):
    path = request.query_params.get("path")
    prefer = request.query_params.get("prefer")
    forwarded = await _maybe_forward_to_full_app("get_files", path, prefer)
    if forwarded is not None:
        return JSONResponse(forwarded)

    try:
        target = safe_resolve_path(path)
    except ValueError as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    if not target.exists() or not target.is_dir():
        return JSONResponse({"success": False, "error": "Not found"}, status_code=404)

    loop = asyncio.get_running_loop()
    items = await loop.run_in_executor(DIRLIST_EXECUTOR, list_dir_fast, target)

    excluded_folders = {"classification", "classification_chips", "thumbnails", "composite_map"}
    items = [
        item for item in items
        if item["name"] not in excluded_folders
        and (item["type"] == "directory" or Path(item["name"]).suffix.lower() in SUPPORTED_EXTS)
    ]

    if prefer:
        prefer_low = prefer.lower()
        items.sort(key=lambda item: (0 if item["type"] == "directory" and item["name"].lower() == prefer_low else 1, item["name"].lower()), reverse=True)

    return JSONResponse({"success": True, "items": items})


async def get_files_recursive(request: Request):
    path = request.query_params.get("path")
    limit = max(0, min(5000, _parse_int(request.query_params.get("limit"), 0)))
    forwarded = await _maybe_forward_to_full_app("get_files_recursive", path, limit)
    if forwarded is not None:
        if isinstance(forwarded, Response):
            return forwarded
        return JSONResponse(forwarded)

    try:
        target = safe_resolve_path(path)
    except ValueError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    if not target.exists() or not target.is_dir():
        return JSONResponse({"detail": "폴더를 찾을 수 없습니다"}, status_code=404)

    def _walk() -> Tuple[List[str], bool]:
        files: List[str] = []
        truncated = False
        for root, dirs, filenames in os.walk(target):
            dirs[:] = [name for name in dirs if name not in SKIP_DIRS and not name.startswith(".")]
            for filename in filenames:
                if Path(filename).suffix.lower() not in SUPPORTED_EXTS:
                    continue
                full_path = Path(root) / filename
                try:
                    rel_path = str(full_path.resolve().relative_to(ROOT_DIR.resolve())).replace("\\", "/")
                except ValueError:
                    rel_path = str(full_path).replace("\\", "/")
                files.append(rel_path)
                if limit > 0 and len(files) >= limit:
                    truncated = True
                    return files, truncated
        return files, truncated

    loop = asyncio.get_running_loop()
    files, truncated = await loop.run_in_executor(DIRLIST_EXECUTOR, _walk)
    return JSONResponse({
        "success": True,
        "files": files,
        "total": len(files),
        "truncated": truncated,
    })


async def get_thumbnail(request: Request):
    module = _FULL_APP.get_loaded_module()
    if module is None:
        await _FULL_APP.wait_until_ready(timeout=15.0)
        module = _FULL_APP.get_loaded_module()
    if module is None:
        return JSONResponse({"detail": "thumbnail service warming up"}, status_code=503)

    _FULL_APP.sync_runtime_state()
    qp = request.query_params
    return await module.get_thumbnail(
        request,
        path=qp.get("path"),
        size=_parse_int(qp.get("size"), config.THUMBNAIL_SIZE_DEFAULT),
        personalized=_parse_bool(qp.get("personalized"), False),
        scheme=qp.get("scheme"),
        grade_filter=qp.get("grade_filter"),
        bottom_filter=qp.get("bottom_filter"),
        border_normalize=_parse_bool(qp.get("border_normalize"), False),
        measure_overlay=qp.get("measure_overlay"),
        bin_overlay=_parse_bool(qp.get("bin_overlay"), False),
        gradient_filter=qp.get("gradient_filter"),
    )


async def serve_js(request: Request):
    filename = request.path_params["filename"]
    entry = _get_js_entry(filename)
    if entry is not None:
        raw, gz, etag, _mtime = entry
        if_none = request.headers.get("if-none-match", "").strip('"')
        if if_none == etag:
            return Response(status_code=304, headers={"ETag": f'"{etag}"', "Cache-Control": "no-cache"})
        accept_encoding = request.headers.get("accept-encoding", "")
        if "gzip" in accept_encoding:
            return Response(
                content=gz,
                media_type="application/javascript; charset=utf-8",
                headers={
                    "Cache-Control": "no-cache",
                    "ETag": f'"{etag}"',
                    "Content-Encoding": "gzip",
                    "Vary": "Accept-Encoding",
                },
            )
        return Response(
            content=raw,
            media_type="application/javascript; charset=utf-8",
            headers={"Cache-Control": "no-cache", "ETag": f'"{etag}"', "Vary": "Accept-Encoding"},
        )

    path_obj = _JS_DIR / filename
    if path_obj.exists() and path_obj.is_file():
        return FileResponse(path_obj, media_type="application/javascript")
    return PlainTextResponse("Not found", status_code=404)


async def serve_css(request: Request):
    filename = request.path_params["filename"]
    entry = _get_css_entry(filename)
    if entry is not None:
        raw, gz, etag, _mtime = entry
        if_none = request.headers.get("if-none-match", "").strip('"')
        if if_none == etag:
            return Response(status_code=304, headers={"ETag": f'"{etag}"', "Cache-Control": "no-cache"})
        accept_encoding = request.headers.get("accept-encoding", "")
        if "gzip" in accept_encoding:
            return Response(
                content=gz,
                media_type="text/css; charset=utf-8",
                headers={
                    "Cache-Control": "no-cache",
                    "ETag": f'"{etag}"',
                    "Content-Encoding": "gzip",
                    "Vary": "Accept-Encoding",
                },
            )
        return Response(
            content=raw,
            media_type="text/css; charset=utf-8",
            headers={"Cache-Control": "no-cache", "ETag": f'"{etag}"', "Vary": "Accept-Encoding"},
        )

    path_obj = _CSS_DIR / filename
    if path_obj.exists() and path_obj.is_file():
        return FileResponse(path_obj, media_type="text/css")
    return PlainTextResponse("Not found", status_code=404)


async def read_root(request: Request):
    if AUTO_LOGIN and not request.query_params.get("saml_success"):
        return RedirectResponse("/saml/login", status_code=302)

    _refresh_index_cache_if_modified()
    _FULL_APP.ensure_loading(immediate=False)
    if _CACHED_INDEX_HTML is None:
        return JSONResponse({"message": "index.html not found"})

    accept_encoding = request.headers.get("accept-encoding", "")
    status_code = 200
    if "gzip" in accept_encoding and _CACHED_INDEX_HTML_GZ:
        response = Response(
            content=_CACHED_INDEX_HTML_GZ,
            media_type="text/html; charset=utf-8",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate",
                "Content-Encoding": "gzip",
                "Vary": "Accept-Encoding",
            },
        )
        _track_bootstrap_page_visit(request, status_code)
        return response

    response = HTMLResponse(
        content=_CACHED_INDEX_HTML,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )
    _track_bootstrap_page_visit(request, status_code)
    return response


async def get_main_js(request: Request):
    request.scope["path_params"] = {"filename": "main.js"}
    return await serve_js(request)


async def api_warmup(request: Request):
    """boot-explorer.js가 페이지 로드 직후 호출하여 full_app 즉시 로딩을 트리거한다."""
    _FULL_APP.ensure_loading(immediate=True)
    return JSONResponse({"warming": True})


async def api_internal_composite_numba_warmup(request: Request):
    if not _is_internal_bootstrap_request(request):
        return JSONResponse({"detail": "Not found"}, status_code=404)

    started = time.perf_counter()

    def _warm() -> Dict[str, Any]:
        from . import composite_map

        return composite_map.warm_numba_kernels()

    try:
        loop = asyncio.get_running_loop()
        info = await loop.run_in_executor(None, _warm)
        return JSONResponse(
            {
                "success": True,
                "numba": info,
                "elapsed": round(time.perf_counter() - started, 3),
            },
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
    except Exception as exc:
        logging.getLogger("uvicorn.error").exception("composite numba warmup failed")
        return JSONResponse({"success": False, "detail": str(exc)}, status_code=500)


async def api_search_ready(request: Request):
    _ensure_bootstrap_search_prewarm()
    _FULL_APP.ensure_loading(immediate=False)
    return JSONResponse(
        _active_search_backend_state(),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


async def api_search(request: Request):
    params = request.query_params
    q = params.get("q", "")
    limit = max(1, min(_parse_int(params.get("limit"), 3000), 10000))
    offset = max(0, _parse_int(params.get("offset"), 0))
    lot_multi = params.get("lot_multi")
    lot_wafer = params.get("lot_wafer")
    folder = params.get("folder")

    search_backend_state = _active_search_backend_state()
    if search_backend_state["backend"] == "full-app":
        forwarded = await _maybe_forward_to_full_app(
            "search_files",
            q=q,
            limit=limit,
            offset=offset,
            lot_multi=lot_multi,
            lot_wafer=lot_wafer,
            folder=folder,
        )
        if forwarded is not None:
            return forwarded if isinstance(forwarded, Response) else JSONResponse(forwarded)

    lot_filter_values = _parse_lot_filter(lot_multi)
    lot_filter = set(lot_filter_values) if lot_filter_values else set()
    lot_wafer_pairs = _parse_lot_wafer(lot_wafer)

    try:
        if folder is not None:
            if folder == "":
                search_root = ROOT_DIR
            else:
                folder_path = safe_resolve_path(folder)
                search_root = folder_path if folder_path.exists() and folder_path.is_dir() else ROOT_DIR
        else:
            search_root = current_folder if current_folder.exists() else ROOT_DIR

        result = await bootstrap_search_service.search(
            query=q or "",
            lot_filter=lot_filter,
            lot_wafer_pairs=lot_wafer_pairs,
            limit=limit,
            offset=offset,
            current_folder=search_root,
        )
        return JSONResponse(result)
    except Exception as exc:
        logging.getLogger("uvicorn.error").exception("검색 중 오류: %s", exc)
        return JSONResponse({"success": False, "detail": str(exc)}, status_code=500)


app.add_route("/api/config", api_config, methods=["GET"])
app.add_route("/api/index-status", api_index_status, methods=["GET"])
app.add_route("/api/current-folder", get_current_folder, methods=["GET"])
app.add_route("/api/root-folder", get_root_folder, methods=["GET"])
app.add_route("/api/change-folder", change_folder, methods=["POST"])
app.add_route("/api/cache", clear_cache, methods=["POST"])
app.add_route("/api/cache/all", clear_all_cache, methods=["POST"])
app.add_route("/api/warmup", api_warmup, methods=["GET", "POST"])
app.add_route("/api/internal/composite-numba-warmup", api_internal_composite_numba_warmup, methods=["POST"])
app.add_route("/api/search-ready", api_search_ready, methods=["GET"])
app.add_route("/api/search", api_search, methods=["GET"])
app.add_route("/api/browse-folders", browse_folders, methods=["GET"])
app.add_route("/api/files", get_files, methods=["GET"])
app.add_route("/api/files/recursive", get_files_recursive, methods=["GET"])
app.add_route("/api/thumbnail", get_thumbnail, methods=["GET", "HEAD"])
app.add_route("/js/{filename:path}", serve_js, methods=["GET"])
app.add_route("/css/{filename:path}", serve_css, methods=["GET"])
app.add_route("/", read_root, methods=["GET"])
app.add_route("/main.js", get_main_js, methods=["GET"])
app.mount("/logs", StaticFiles(directory="logs", check_dir=False), name="logs")
app.mount("/static", StaticFiles(directory=".", check_dir=False), name="static")
app.mount("/", LazyFullAppProxy(_FULL_APP), name="full-app-proxy")


if __name__ == "__main__":
    import uvicorn

    cert_path = Path(config.SSL_CERTFILE)
    key_path = Path(config.SSL_KEYFILE)
    reload_flag = config.DEFAULT_RELOAD
    access_log_enabled = os.getenv("ACCESS_LOG_ENABLED", "0").strip().lower() not in ("0", "false", "no", "")
    access_log_level = os.getenv("ACCESS_LOG_LEVEL", "WARNING").upper()
    logging_config = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "()": "uvicorn.logging.DefaultFormatter",
                "format": "%(levelprefix)s %(asctime)s     %(message)s",
                "datefmt": "%Y-%m-%d %H:%M:%S",
            },
            "access": {
                "()": "uvicorn.logging.AccessFormatter",
                "format": "%(levelprefix)s %(asctime)s     %(client_addr)s - \"%(request_line)s\" %(status_code)s",
            },
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
            },
            "access": {
                "formatter": "access",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"level": "INFO"},
            "uvicorn.access": {
                "handlers": ["access"] if access_log_enabled else [],
                "level": access_log_level if access_log_enabled else "CRITICAL",
                "propagate": False,
            },
        },
    }

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=int(config.HTTPS_PORT),
        reload=reload_flag,
        reload_excludes=["logs/*", "*.log", "thumbnails/*", "*.pyc", "__pycache__/*"] if reload_flag else None,
        workers=1,
        lifespan="on",
        log_level="info",
        access_log=access_log_enabled,
        use_colors=True,
        log_config=logging_config,
        ssl_certfile=str(cert_path),
        ssl_keyfile=str(key_path),
    )
