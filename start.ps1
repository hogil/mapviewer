# Windows 11 개발 서버 시작 스크립트
# PowerShell에서 실행: .\start.ps1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# UTF-8 인코딩 설정 (한글 로그 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
$env:UVICORN_LIFESPAN = "on"   # FastAPI lifespan 강제 (인덱스 초기화/재빌드 보장)
$env:UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN = "15" # restart 시 종료 대기 상한(초)
chcp 65001 | Out-Null

# 환경변수 설정
$env:AUTO_LOGIN="0"      # 0=수동 로그인 (/saml/login 직접 호출)
                         # 1=자동 로그인 (domain 접속 시 자동 리다이렉트) - Ubuntu 사내 서버용
$env:HOST="0.0.0.0"
$env:PORT="5354"
$env:RELOAD="0"          # PowerShell 스크립트 실행 시 uvicorn reload 비활성화 (이중 실행 방지)
$env:UVICORN_WORKERS="1" # 개발 환경: 단일 워커 (중복 인덱스 방지)
$env:WORKERS="1"         # FastAPI 워커 단일 고정
$env:HTTP2="1"           # legacy marker: 현재 python uvicorn.run 경로의 HTTP/2 스위치로는 사용되지 않음
$env:KEEP_ALIVE="1"      # legacy marker: keep-alive는 uvicorn 기본 동작에 맡김
$env:SSL_ENABLED="1"
$env:HTTPS_PORT="8443"
$env:SSL_CERTFILE="cert/fullchain.pem"
$env:SSL_KEYFILE="cert/server.key"

# 경로 설정
$env:IMAGES_ROOT="E:/data/images"          # 이미지 루트 경로
$env:POSITIONS_ROOT="E:/data/positions"    # Positions 루트 경로

$env:THUMBNAIL_SIZE="512"
$env:THUMBNAIL_FORMAT="JPEG"
$env:THUMBNAIL_QUALITY="100"
$env:PNG_COMPRESSION_LEVEL="0"           # PNG 경로 최고속값
$env:IO_THREADS="128"                    # 8C dev 박스 기준 초고속 I/O
$env:THUMBNAIL_SEM="64"                  # 썸네일 동시 생성 상향
$env:THUMB_PREFETCH_BATCH="48"           # 프리페치 버스트 상향
$env:THUMB_CLIENT_MAX_CONCURRENCY="12"   # 클라이언트 동시 요청 (grid.js 큐와 맞춤)
$env:COMPOSITE_FAST_MODE="1"             # Composite fast path 명시
$env:COMPOSITE_MAX_WORKERS="32"          # Composite: 개발 PC 최고속 로더 워커
$env:COMPOSITE_LOADER_MODE="thread"      # 현재 composite loader는 thread-only
$env:COMPOSITE_BATCH_SIZE="32"
$env:COMPOSITE_NUMBA_BATCH_MB="2048"     # 개발 PC 메모리 cap: batch round-trip 완화
$env:COMPOSITE_PALETTE_PNG_COMPRESSION_LEVEL="0" # Composite palette PNG 저장 최고속
$env:COMPOSITE_CACHE_COMPRESS="0"        # subset용 NPZ persist 최고속(파일 크기 증가 허용)
$env:DAILY_CLEANUP_ENABLED="1"           # 매일 composite_map + thumbnails 정리 활성화
$env:DAILY_CLEANUP_HOUR="2"              # 매일 AM 2시 실행
$env:DAILY_CLEANUP_MINUTE="0"
$env:COMPOSITE_USE_NUMBA="1"             # Composite mask/count/sum-map Numba fast path
$env:COMPOSITE_NUMBA_CACHE="1"           # JIT 캐시 사용으로 재시작 후 첫 요청 단축
$env:OMP_NUM_THREADS="8"                 # Numba/OpenMP 스레드 (물리 코어 수)
$env:NUMBA_NUM_THREADS="8"               # 명시적으로 numba 스레드 제한
$env:VIPS_CONCURRENCY="6"                # 개발 PC: 대형 이미지 연산 병렬화 (코어 수에 맞춤)
$env:VIPS_MAX_CACHE="3000"               # libvips 연산 캐시 개수
$env:VIPS_MAX_CACHE_MEM="1073741824"     # libvips 캐시 메모리 (1GB)
$env:VIPS_MAX_CACHE_FILES="400"          # 열린 파일 캐시
$env:VIPS_DISC_THRESHOLD="1500m"         # 디스크 스필 기준 (SSD 전제)

# 검색 폴백 비활성화 (인덱스 결과만 사용)
$env:SEARCH_WORKERS="4"                  # 검색 병렬 워커 수 (AND/OR 최적화)
$env:SEARCH_FALLBACK_MAX_FILES="0"      # 0=폴백 탐색 비활성화
$env:SEARCH_FALLBACK_TIMEOUT_MS="0"     # 0=시간 제한 없음

# 인덱스 구축 워커 수 (병렬 디렉터리 스캔 가속)
$env:INDEX_WORKERS = "4" # CPU 수 대비 2배, 최대 64
$env:INDEX_REFRESH_INTERVAL_MINUTES="30" # 파일 인덱스 자동 재빌드 간격(분)

# startup background warm 완화
$env:STARTUP_THUMB_WARM_FOLDERS=""
$env:STARTUP_THUMB_WARM_COUNT="0"
$env:STARTUP_WARM_COMPOSITE_MODULES="1"
$env:STARTUP_WARM_COMPOSITE_NUMBA="1"

# 이미지 피라미드 설정
# 2025-10-23: 피라미드 썸네일 품질 및 속도 최적화
# - PYRAMID_Q: 95→100 (그리드 썸네일과 동일한 최고 품질)
# - PYRAMID_LOADER_MODE: seq_early_copy→random (copy_memory() 오버헤드 제거)
# 원복 시점: commit dce1bb2 (2025-10-23)
$env:PYRAMID_LEVELS="0.2,0.5,0.7,1.0"
$env:PYRAMID_ZOOM_THRESHOLDS="0.25,0.5,0.75"
$env:PYRAMID_FORMAT="JPEG"
$env:PYRAMID_Q="100"                  # JPEG 품질 Q=100 (최고 품질)
$env:PYRAMID_PNG_COMPRESSION="0"       # PNG pyramid 경로 최고속
$env:PYRAMID_PNG_EFFORT="1"            # PNG effort (1=가장 빠름)
$env:PYRAMID_KERNEL="cubic"            # 리사이즈 커널 (cubic, 최고 품질)
$env:PYRAMID_LOADER_MODE="random"      # 로더 모드 (random=스트리밍, seq_early_copy=메모리 복사)
$env:PYRAMID_BG_WORKERS="8"            # 개발 환경 백그라운드 피라미드 최고속

# 접근 로그 최소화
$env:ACCESS_LOG_ENABLED="0"            # uvicorn access log 비활성화 (필요 시 1로)
$env:ACCESS_LOG_LEVEL="WARNING"        # 활성 시 레벨

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
