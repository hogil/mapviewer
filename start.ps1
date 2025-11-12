# Windows 11 개발 서버 시작 스크립트
# PowerShell에서 실행: .\start.ps1

# UTF-8 인코딩 설정 (한글 로그 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
chcp 65001 | Out-Null

# 환경변수 설정
$env:AUTO_LOGIN="0"      # 0=수동 로그인 (/saml/login 직접 호출)
                         # 1=자동 로그인 (domain 접속 시 자동 리다이렉트) - Ubuntu 사내 서버용
$env:HOST="0.0.0.0"
$env:PORT="8080"
$env:RELOAD="0"          # PowerShell 스크립트 실행 시 uvicorn reload 비활성화 (이중 실행 방지)
$env:UVICORN_WORKERS="1" # 개발 환경: 단일 워커 (중복 인덱스 방지)
$env:WORKERS="1"         # FastAPI 워커 단일 고정
$env:HTTP2="1"           # 🚀 HTTP/2 활성화 (다중 요청 병렬 처리)
$env:KEEP_ALIVE="1"      # 🚀 Keep-Alive 연결 유지
$env:SSL_ENABLED="1"
$env:HTTPS_PORT="443"
$env:SSL_CERTFILE="cert/fullchain.pem"
$env:SSL_KEYFILE="cert/server.key"

# 경로 설정
$env:IMAGES_ROOT="D:/project/data/wm-811k"          # 이미지 루트 경로
$env:POSITIONS_ROOT="D:/project/data/positions"     # Positions 루트 경로

$env:THUMBNAIL_SIZE="512"
$env:THUMBNAIL_FORMAT="JPEG"
$env:THUMBNAIL_QUALITY="100"
$env:PNG_COMPRESSION_LEVEL="3"
$env:IO_THREADS="80"                     # Dev box (8C/64GB) - I/O 병렬화 2배
$env:THUMBNAIL_SEM="48"                 # Concurrent thumbnail jobs
$env:THUMB_PREFETCH_BATCH="32"          # Prefetch batch size
$env:THUMB_CLIENT_MAX_CONCURRENCY="10"  # Frontend concurrent loads
$env:COMPOSITE_MAX_WORKERS="4"          # Composite map loaders
$env:COMPOSITE_LOADER_MODE="thread"     # Loader strategy (sequential/thread/process)
$env:COMPOSITE_BATCH_SIZE="4"           # Batch size for vectorized accumulation
$env:VIPS_CONCURRENCY="4"               # pyvips 내부 스레드 (최적화됨, 벤치마크 기준 최고 성능)
$env:VIPS_MAX_CACHE="2000"              # libvips 연산 캐시 개수
$env:VIPS_MAX_CACHE_MEM="536870912"     # libvips 캐시 메모리 (512MB)
$env:VIPS_MAX_CACHE_FILES="200"         # 열린 파일 캐시
$env:VIPS_DISC_THRESHOLD="500m"         # 디스크 스필 기준 (RAM 디스크/SSD 사용 시 안전치)

# 검색 폴백 비활성화 (인덱스 결과만 사용)
$env:SEARCH_WORKERS="4"                  # 검색 병렬 워커 수 (AND/OR 최적화)
$env:SEARCH_FALLBACK_LIMIT="0"          # 0=폴백 결과 제한 없음(실제로 폴백 비활성화)
$env:SEARCH_FALLBACK_MAX_FILES="0"      # 0=폴백 탐색 비활성화
$env:SEARCH_FALLBACK_TIMEOUT_MS="0"     # 0=시간 제한 없음

# 인덱스 구축 워커 수 (병렬 디렉터리 스캔 가속)
$env:INDEX_WORKERS = "4" # CPU 수 대비 2배, 최대 64
$env:INDEX_REFRESH_ERVAL_MINUTES="30" # 파일 인덱스 자동 재빌드 간격(분)

# 이미지 피라미드 설정
# 2025-10-23: 피라미드 썸네일 품질 및 속도 최적화
# - PYRAMID_Q: 95→100 (그리드 썸네일과 동일한 최고 품질)
# - PYRAMID_LOADER_MODE: seq_early_copy→random (copy_memory() 오버헤드 제거)
# 원복 시점: commit dce1bb2 (2025-10-23)
$env:PYRAMID_LEVELS="0.2,0.5,0.7,1.0"
$env:PYRAMID_ZOOM_THRESHOLDS="0.25,0.5,0.75"
$env:PYRAMID_FORMAT="JPEG"
$env:PYRAMID_Q="100"                  # JPEG 품질 Q=100 (최고 품질)
$env:PYRAMID_PNG_COMPRESSION="3"       # 무손실 유지, 네트워크 전송량과 생성시간 밸런스
$env:PYRAMID_PNG_EFFORT="1"            # PNG effort (1=가장 빠름)
$env:PYRAMID_KERNEL="cubic"            # 리사이즈 커널 (cubic, 최고 품질)
$env:PYRAMID_LOADER_MODE="random"      # 로더 모드 (random=스트리밍, seq_early_copy=메모리 복사)
$env:PYRAMID_BG_WORKERS="4"            # 개발 환경 백그라운드 피라미드 워커

# TurboJPEG 설정 (그리드 썸네일 전용)
# 2025-10-24: 그리드 썸네일 TurboJPEG 4:2:2 적용
# - 벤치마크 결과 (300개): TurboJPEG Q100 422 FASTDCT (12,593ms) > pyvips (13,016ms) = 3.4% 빠름
# - 4:2:2 선택 이유: 세로 방향 색상 경계 보존, 속도는 4:2:0과 유사
# - 피라미드는 pyvips 사용, 그리드는 TurboJPEG 422 사용
$env:USE_TURBOJPEG="1"
$env:TURBOJPEG_PATH = "C:\libjpeg-turbo64\bin\turbojpeg.dll"

# 🧹 Python 캐시 정리 (서버 시작 전)
Write-Host "🧹 Python 캐시 정리 중..." -ForegroundColor Yellow
Get-ChildItem -Path . -Include __pycache__ -Recurse -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path . -Include *.pyc -Recurse -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "✅ 캐시 정리 완료" -ForegroundColor Green
Write-Host ""

python -m api.main
