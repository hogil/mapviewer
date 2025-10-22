import os
from pathlib import Path
from math import floor

# ===== 경로 / 포맷 =====
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", "/appdata/appuser/images")).resolve()
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"

THUMBNAIL_SIZE_DEFAULT = int(os.getenv("THUMBNAIL_SIZE", "512"))
THUMBNAIL_FORMAT = os.getenv("THUMBNAIL_FORMAT", "PNG")
THUMBNAIL_QUALITY = int(os.getenv("THUMBNAIL_QUALITY", "100"))
PNG_COMPRESSION_LEVEL = int(os.getenv("PNG_COMPRESSION_LEVEL", "3"))

SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}
# 검색/인덱싱에서 건너뛸 폴더(쉼표로 구분)
SKIP_DIRS = set(os.getenv("SKIP_DIRS", "classification,thumbnails").split(","))

# ===== 동시성 / 성능 =====
CPU_COUNT = os.cpu_count() or 8
IO_THREADS = int(os.getenv("IO_THREADS", "0")) or max(16, CPU_COUNT * 2)   # Ubuntu 24 최적화: CPU * 2
THUMBNAIL_SEM = int(os.getenv("THUMBNAIL_SEM", "128"))                     # Ubuntu 24 최적화: 128로 증가

# 캐시 크기/TTL
DIRLIST_CACHE_SIZE = int(os.getenv("DIRLIST_CACHE_SIZE", "1024"))
THUMB_STAT_TTL_SECONDS = float(os.getenv("THUMB_STAT_TTL_SECONDS", "5"))
THUMB_STAT_CACHE_CAPACITY = int(os.getenv("THUMB_STAT_CACHE_CAPACITY", "8192"))

# ===== 라벨 저장 =====
LABELS_DIR = ROOT_DIR / "classification"
LABELS_FILE = LABELS_DIR / "labels.json"

# ===== 서버 기본값 =====
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("PORT", "8080"))
# reload 기본은 OFF (RELOAD=1이면 ON)
DEFAULT_RELOAD = os.getenv("RELOAD", "0").strip().lower() in {"1", "true", "yes", "y", "on"}

# 워커 기본: CPU의 75%에서 최소 24개
def _default_workers():
    return max(24, floor((os.cpu_count() or 8) * 0.75))

DEFAULT_WORKERS = int(os.getenv("WORKERS", str(_default_workers())))

# ===== HTTPS 설정 =====
SSL_ENABLED = os.getenv("SSL_ENABLED", "1").strip().lower() in {"1", "true", "yes", "y", "on"}
HTTPS_PORT = int(os.getenv("HTTPS_PORT", "8443"))
SSL_CERTFILE = os.getenv("SSL_CERTFILE", "cert/fullchain.pem")
SSL_KEYFILE = os.getenv("SSL_KEYFILE", "cert/server.key")

# ===== 이미지 피라미드 설정 =====
# 피라미드 레벨 (쉼표로 구분, 기본: 0.2,0.5,0.7,1.0)
PYRAMID_LEVELS = [float(x) for x in os.getenv("PYRAMID_LEVELS", "0.2,0.5,0.7,1.0").split(",")]
# zoom 기준 (쉼표로 구분, 기본: 0.25,0.5,0.75) - ≤0.25→0.2, ≤0.5→0.5, ≤0.75→0.7, >0.75→1.0
PYRAMID_ZOOM_THRESHOLDS = [float(x) for x in os.getenv("PYRAMID_ZOOM_THRESHOLDS", "0.25,0.5,0.75").split(",")]
THUMB_PREFETCH_BATCH = int(os.getenv("THUMB_PREFETCH_BATCH", "32"))
THUMB_CLIENT_MAX_CONCURRENCY = int(os.getenv("THUMB_CLIENT_MAX_CONCURRENCY", "12"))
PYRAMID_FORMAT = os.getenv("PYRAMID_FORMAT", "WEBP").upper()
PYRAMID_Q = int(os.getenv("PYRAMID_Q", "100"))
PYRAMID_PNG_COMPRESSION = int(os.getenv("PYRAMID_PNG_COMPRESSION", "3"))
PYRAMID_PNG_EFFORT = int(os.getenv("PYRAMID_PNG_EFFORT", "1"))
PYRAMID_KERNEL = os.getenv("PYRAMID_KERNEL", "cubic").lower()
VIPS_CONCURRENCY = int(os.getenv("VIPS_CONCURRENCY", "6"))
PYRAMID_LOADER_MODE = os.getenv("PYRAMID_LOADER_MODE", "seq_early_copy").strip().lower()
USE_TURBOJPEG = os.getenv("USE_TURBOJPEG", "1").strip().lower() in {"1", "true", "yes", "on"}
TURBOJPEG_PATH = os.getenv("TURBOJPEG_PATH", "").strip()
