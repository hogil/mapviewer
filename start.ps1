# Windows 11 개발 서버 시작 스크립트
# PowerShell에서 실행: .\start.ps1

# UTF-8 인코딩 설정 (한글 로그 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
$env:UVICORN_LIFESPAN = "on"   # FastAPI lifespan 강제 (인덱스 초기화/재빌드 보장)
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
$env:PNG_COMPRESSION_LEVEL="1"           # PNG 경로 최속값
$env:IO_THREADS="128"                    # 8C dev 박스 기준 초고속 I/O
$env:THUMBNAIL_SEM="64"                  # 썸네일 동시 생성 상향
$env:THUMB_PREFETCH_BATCH="48"           # 프리페치 버스트 상향
$env:THUMB_CLIENT_MAX_CONCURRENCY="12"   # 클라이언트 동시 요청 (grid.js 큐와 맞춤)
$env:COMPOSITE_MAX_WORKERS="24"          # Composite: fast path 워커 상향
$env:COMPOSITE_LOADER_MODE="thread"
$env:COMPOSITE_BATCH_SIZE="12"
$env:COMPOSITE_RETENTION_HOURS="24"      # Composite 결과 보관: 24시간
$env:COMPOSITE_CLEANUP_INTERVAL_SECONDS="86400" # 정리 주기: 24시간마다
$env:COMPOSITE_CLEANUP_MODE="daily"      # 정리 스케줄: daily | interval
$env:COMPOSITE_CLEANUP_HOUR="2"          # 매일 AM 2시 실행
$env:COMPOSITE_CLEANUP_MINUTE="0"
$env:COMPOSITE_CLEANUP_RUN_ON_STARTUP="0" # 시작 즉시 정리 비활성화 (하루 1회만)
$env:COMPOSITE_COUNT_MODE="cython"
$env:OMP_NUM_THREADS="8"                 # Numba/OpenMP 스레드 (물리 코어 수)
$env:NUMBA_NUM_THREADS="8"               # 명시적으로 numba 스레드 제한
$env:VIPS_CONCURRENCY="6"                # pyvips 내부 스레드 (Windows dev 최적)
$env:VIPS_MAX_CACHE="3000"               # libvips 연산 캐시 개수
$env:VIPS_MAX_CACHE_MEM="1073741824"     # libvips 캐시 메모리 (1GB)
$env:VIPS_MAX_CACHE_FILES="400"          # 열린 파일 캐시
$env:VIPS_DISC_THRESHOLD="1500m"         # 디스크 스필 기준 (SSD 전제)

# 검색 폴백 비활성화 (인덱스 결과만 사용)
$env:SEARCH_WORKERS="4"                  # 검색 병렬 워커 수 (AND/OR 최적화)
$env:SEARCH_FALLBACK_LIMIT="0"          # 0=폴백 결과 제한 없음(실제로 폴백 비활성화)
$env:SEARCH_FALLBACK_MAX_FILES="0"      # 0=폴백 탐색 비활성화
$env:SEARCH_FALLBACK_TIMEOUT_MS="0"     # 0=시간 제한 없음

# 인덱스 구축 워커 수 (병렬 디렉터리 스캔 가속)
$env:INDEX_WORKERS = "4" # CPU 수 대비 2배, 최대 64
$env:INDEX_REFRESH_INTERVAL_MINUTES="30" # 파일 인덱스 자동 재빌드 간격(분)

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
