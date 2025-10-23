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
$env:SSL_ENABLED="1"
$env:HTTPS_PORT="443"
$env:SSL_CERTFILE="cert/fullchain.pem"
$env:SSL_KEYFILE="cert/server.key"
$env:THUMBNAIL_SIZE="512"
$env:THUMBNAIL_FORMAT="JPEG"
$env:THUMBNAIL_QUALITY="100"
$env:PNG_COMPRESSION_LEVEL="3"
$env:IO_THREADS="40"                     # Dev box (8C/64GB)
$env:THUMBNAIL_SEM="32"                 # Concurrent thumbnail jobs
$env:THUMB_PREFETCH_BATCH="32"          # Prefetch batch size
$env:THUMB_CLIENT_MAX_CONCURRENCY="10"  # Frontend concurrent loads
$env:VIPS_CONCURRENCY="12"              # pyvips worker count (동시 PNG 압축 가속)
$env:VIPS_MAX_CACHE="2000"              # libvips 연산 캐시 개수
$env:VIPS_MAX_CACHE_MEM="536870912"     # libvips 캐시 메모리 (512MB)
$env:VIPS_MAX_CACHE_FILES="200"         # 열린 파일 캐시
$env:VIPS_DISC_THRESHOLD="500m"         # 디스크 스필 기준 (RAM 디스크/SSD 사용 시 안전치)

# 이미지 피라미드 설정
# 2025-10-23: 피라미드 썸네일 품질 및 속도 최적화
# - PYRAMID_Q: 95→100 (그리드 썸네일과 동일한 최고 품질)
# - PYRAMID_LOADER_MODE: seq_early_copy→random (copy_memory() 오버헤드 제거)
# 원복 시점: commit dce1bb2 (2025-10-23)
$env:PYRAMID_LEVELS="0.2,0.5,0.7,1.0"
$env:PYRAMID_ZOOM_THRESHOLDS="0.25,0.5,0.75"
$env:PYRAMID_FORMAT="JPEG"
$env:PYRAMID_Q="95"                   # JPEG/WEBP 품질 (Q=100, 최고 품질)
$env:PYRAMID_PNG_COMPRESSION="3"       # 무손실 유지, 네트워크 전송량과 생성시간 밸런스
$env:PYRAMID_PNG_EFFORT="1"            # PNG effort (1=가장 빠름)
$env:PYRAMID_KERNEL="cubic"            # 리사이즈 커널 (cubic, 최고 품질)
$env:PYRAMID_LOADER_MODE="random"      # 로더 모드 (random=스트리밍, seq_early_copy=메모리 복사)
$env:USE_TURBOJPEG="1"
$env:TURBOJPEG_PATH = "C:\libjpeg-turbo64\bin\turbojpeg.dll"

python -m api.main
