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
IO_THREADS = int(os.getenv("IO_THREADS", "0")) or max(8, CPU_COUNT * 2)   # 디코딩/파일 I/O 풀 (CPU * 2)
THUMBNAIL_SEM = int(os.getenv("THUMBNAIL_SEM", "128"))                 # 썸네일 동시 생성 제한 (기본값 증가)

# 캐시 크기/TTL (로드 속도 개선)
DIRLIST_CACHE_SIZE = int(os.getenv("DIRLIST_CACHE_SIZE", "4096"))      # 디렉토리 리스트 캐시 (4배 증가)
THUMB_STAT_TTL_SECONDS = float(os.getenv("THUMB_STAT_TTL_SECONDS", "10"))  # 캐시 유지 시간 (2배 증가)
THUMB_STAT_CACHE_CAPACITY = int(os.getenv("THUMB_STAT_CACHE_CAPACITY", "16384"))  # 썸네일 통계 캐시 (2배 증가)

# ===== 라벨 저장 =====
LABELS_DIR = ROOT_DIR / "classification"
LABELS_FILE = LABELS_DIR / "labels.json"

# ===== 서버 기본값 =====
DEFAULT_HOST = os.getenv("HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("PORT", "8080"))
# reload 기본은 OFF (RELOAD=1이면 ON)
DEFAULT_RELOAD = os.getenv("RELOAD", "0").strip().lower() in {"1", "true", "yes", "y", "on"}

# 워커 기본: CPU의 87.5%에서 최소 24개 (고성능 서버 최적화)
def _default_workers():
    return max(24, floor((os.cpu_count() or 8) * 0.875))

DEFAULT_WORKERS = int(os.getenv("WORKERS", str(_default_workers())))

# ===== HTTPS 설정 =====
SSL_ENABLED = os.getenv("SSL_ENABLED", "1").strip().lower() in {"1", "true", "yes", "y", "on"}
HTTPS_PORT = int(os.getenv("HTTPS_PORT", "8443"))
SSL_CERTFILE = os.getenv("SSL_CERTFILE", "cert/fullchain.pem")
SSL_KEYFILE = os.getenv("SSL_KEYFILE", "cert/server.key")

# ===== 이미지 피라미드 설정 =====
PYRAMID_LEVELS = [0.2, 0.4, 0.7, 1.0]  # 피라미드 레벨 (0.2=20%, 0.4=40%, 0.7=70%, 1.0=100%) - 고품질 Q=100, Lanczos3
