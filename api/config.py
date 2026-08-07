import os
from pathlib import Path
from math import floor

# ===== 경로 / 포맷 =====
# Windows 개발환경과 Ubuntu 운영환경 모두 지원
_images_root_default = "E:/data/images" if os.name == "nt" else "/appdata/appuser/images"
IMAGES_ROOT = Path(os.getenv("IMAGES_ROOT", _images_root_default)).resolve()
ROOT_DIR = IMAGES_ROOT

# 로그인/스킴 fallback 값 (단일 소스)
FALLBACK_LOGIN_ID = (os.getenv("FALLBACK_LOGIN_ID", "notsaml").strip() or "notsaml")

# Positions는 별도 경로로 관리 (이미지와 분리)
_positions_root_default = "E:/data/positions" if os.name == "nt" else "/appdata/appuser/positions"
POSITIONS_ROOT = Path(os.getenv("POSITIONS_ROOT", _positions_root_default)).resolve()

# [NEW] Layout feature data lives beside images/ and positions/.
_layout_root_default = POSITIONS_ROOT.parent / "layout"
LAYOUT_ROOT = Path(os.getenv("LAYOUT_ROOT", str(_layout_root_default))).resolve()
LAYOUT_FILE = LAYOUT_ROOT / "layout.txt"

# IMAGES_ROOT 하위 경로
THUMBNAIL_DIR = IMAGES_ROOT / "thumbnails"
LABELS_DIR = IMAGES_ROOT / "classification"              # Wafer 모드
CHIP_LABELS_DIR = IMAGES_ROOT / "classification_chips"   # Chip 모드
_chip_annotations_default = IMAGES_ROOT / "chip_annotations"
CHIP_ANNOTATIONS_ROOT = Path(os.getenv("CHIP_ANNOTATIONS_ROOT", str(_chip_annotations_default))).resolve()
_chip_images_default = IMAGES_ROOT / "chip_images"
CHIP_IMAGES_ROOT = Path(os.getenv("CHIP_IMAGES_ROOT", str(_chip_images_default))).resolve()
YOLO_EXPORT_ROOT = IMAGES_ROOT / "yolo_datasets"

THUMBNAIL_SIZE_DEFAULT = int(os.getenv("THUMBNAIL_SIZE", "512"))
THUMBNAIL_FORMAT = os.getenv("THUMBNAIL_FORMAT", "PNG")
THUMBNAIL_QUALITY = int(os.getenv("THUMBNAIL_QUALITY", "100"))
PNG_COMPRESSION_LEVEL = int(os.getenv("PNG_COMPRESSION_LEVEL", "3"))

SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.gif'}
# 검색/인덱싱에서 건너뛸 폴더 (모두 IMAGES_ROOT 하위, 원본 이미지가 아닌 파생 데이터)
SKIP_DIRS = set(os.getenv(
    "SKIP_DIRS",
    "classification,classification_chips,thumbnails,chip_annotations,chip_images,yolo_datasets,composite_map,my-lot"
).split(","))
# 인덱스 빌드 시 스캔할 폴더: classification/my-lot은 인덱스에 포함 (Label Explorer, MY LOT 즉시 조회용)
INDEX_SKIP_DIRS = set(os.getenv(
    "INDEX_SKIP_DIRS",
    "thumbnails,chip_annotations,chip_images,yolo_datasets,composite_map"
).split(","))

# ===== 동시성 / 성능 =====
CPU_COUNT = os.cpu_count() or 8
IO_THREADS = int(os.getenv("IO_THREADS", "0")) or max(16, CPU_COUNT * 2)   # Ubuntu 24 최적화: CPU * 2
THUMBNAIL_SEM = int(os.getenv("THUMBNAIL_SEM", "128"))                     # Ubuntu 24 최적화: 128로 증가
# Composite pipeline tuning via COMPOSITE_* env (see start scripts)
_default_composite_workers = max(4, min(32, (os.cpu_count() or 8) * 2))
COMPOSITE_MAX_WORKERS = int(os.getenv("COMPOSITE_MAX_WORKERS", str(_default_composite_workers)))
COMPOSITE_LOADER_MODE = "thread"  # Fixed: loader mode is thread-only for composite pipeline
_default_composite_batch = max(2, (os.cpu_count() or 8) // 2)
COMPOSITE_BATCH_SIZE = max(1, int(os.getenv("COMPOSITE_BATCH_SIZE", str(_default_composite_batch))))

# SEARCH_WORKERS: CPU 코어수의 2배 (I/O 바운드 작업에 최적)
# 최소 4개, 최대 CPU_COUNT * 2개
SEARCH_WORKERS = int(os.getenv("SEARCH_WORKERS", "16"))
INDEX_WORKERS = int(os.getenv("INDEX_WORKERS", str(max(4, (os.cpu_count() or 8) // 2))))  # 파일 인덱싱 병렬 워커 수
INDEX_REFRESH_INTERVAL_MINUTES = int(os.getenv("INDEX_REFRESH_INTERVAL_MINUTES", "10"))   # 인덱스 자동 재빌드 주기(분). 0이면 비활성화


# 캐시 크기/TTL
DIRLIST_CACHE_SIZE = int(os.getenv("DIRLIST_CACHE_SIZE", "1024"))
THUMB_STAT_TTL_SECONDS = float(os.getenv("THUMB_STAT_TTL_SECONDS", "5"))
THUMB_STAT_CACHE_CAPACITY = int(os.getenv("THUMB_STAT_CACHE_CAPACITY", "8192"))

# 위에서 이미 정의됨 (중복 제거)

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
THUMB_PREFETCH_BATCH = int(os.getenv("THUMB_PREFETCH_BATCH", "84"))
THUMB_CLIENT_MAX_CONCURRENCY = int(os.getenv("THUMB_CLIENT_MAX_CONCURRENCY", "42"))
GRID_MAX_CONCURRENCY = int(os.getenv("GRID_MAX_CONCURRENCY", "48"))
MEASURE_PREFETCH_CONCURRENCY = int(os.getenv("MEASURE_PREFETCH_CONCURRENCY", "8"))
_default_thumb_exec_workers = max(8, min(THUMBNAIL_SEM, CPU_COUNT * 4))
THUMBNAIL_EXECUTOR_WORKERS = int(
    os.getenv("THUMBNAIL_EXECUTOR_WORKERS", str(_default_thumb_exec_workers))
)
PYRAMID_FORMAT = os.getenv("PYRAMID_FORMAT", "WEBP").upper()
PYRAMID_Q = int(os.getenv("PYRAMID_Q", "100"))
PYRAMID_PNG_COMPRESSION = int(os.getenv("PYRAMID_PNG_COMPRESSION", "3"))
PYRAMID_PNG_EFFORT = int(os.getenv("PYRAMID_PNG_EFFORT", "1"))
PYRAMID_KERNEL = os.getenv("PYRAMID_KERNEL", "cubic").lower()
VIPS_CONCURRENCY = int(os.getenv("VIPS_CONCURRENCY", "6"))
PYRAMID_LOADER_MODE = os.getenv("PYRAMID_LOADER_MODE", "seq_early_copy").strip().lower()
PYRAMID_BG_WORKERS = int(os.getenv("PYRAMID_BG_WORKERS", str(max(2, CPU_COUNT))))

# ===== TurboJPEG 설정 (그리드 썸네일 전용) =====
USE_TURBOJPEG = os.getenv("USE_TURBOJPEG", "1").strip().lower() in {"1", "true", "yes", "on"}
TURBOJPEG_PATH = os.getenv("TURBOJPEG_PATH", "").strip()
