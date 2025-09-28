import os
from pathlib import Path
from math import floor

# ===== 경로 / 포맷 =====
ROOT_DIR = Path(os.getenv("PROJECT_ROOT", "/appdata/appuser/images")).resolve()
THUMBNAIL_DIR = ROOT_DIR / "thumbnails"

THUMBNAIL_SIZE_DEFAULT = int(os.getenv("THUMBNAIL_SIZE", "512"))
THUMBNAIL_FORMAT = os.getenv("THUMBNAIL_FORMAT", "WEBP")
THUMBNAIL_QUALITY = int(os.getenv("THUMBNAIL_QUALITY", "100"))

SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}
# 검색/인덱싱에서 건너뛸 폴더(쉼표로 구분)
SKIP_DIRS = set(os.getenv("SKIP_DIRS", "classification,thumbnails").split(","))

# ===== 동시성 / 성능 =====
CPU_COUNT = os.cpu_count() or 8
IO_THREADS = int(os.getenv("IO_THREADS", "0")) or max(8, CPU_COUNT)   # 디코딩/파일 I/O 풀
# 최종 과부하: 9000/s 돌파를 위한 극한 설정
THUMBNAIL_SEM = int(os.getenv("THUMBNAIL_SEM", str(max(256, CPU_COUNT * 12))))  # CPU * 12개 극한 동시 처리

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
# 기본 포트를 443으로 전환 (사용자가 요청)
HTTPS_PORT = int(os.getenv("HTTPS_PORT", "443"))
SSL_CERTFILE = os.getenv("SSL_CERTFILE", "cert/fullchain.pem")
SSL_KEYFILE = os.getenv("SSL_KEYFILE", "cert/server.key")
