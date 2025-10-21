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
$env:THUMBNAIL_FORMAT="PNG"
$env:THUMBNAIL_QUALITY="100"
$env:PNG_COMPRESSION_LEVEL="3"
$env:IO_THREADS="32"                     # 개발환경에 적합한 I/O 스레드
$env:THUMBNAIL_SEM="24"
$env:THUMB_PREFETCH_BATCH="24"
$env:THUMB_CLIENT_MAX_CONCURRENCY="8"
$env:VIPS_CONCURRENCY="4"               # 웹서버 최적화 (pyvips 환경변수명 통일)
$env:VIPS_DISC_THRESHOLD="500m"         # 개발환경에 적합한 임계값
$env:VIPS_MAX_CACHE="500"               # 개발환경에 적합한 캐시 수
$env:VIPS_MAX_CACHE_MEM="1000m"         # 개발환경에 적합한 캐시 메모리
$env:STATS_LOG_ENABLED="0"
$env:WORKERS="6"
$env:RELOAD="1"

# 이미지 피라미드 설정
$env:PYRAMID_LEVELS="0.2,0.5,0.7,1.0"           # 피라미드 레벨 (최고품질 Q=100, Lanczos3)
$env:PYRAMID_ZOOM_THRESHOLDS="0.25,0.5,0.75"   # zoom 기준 (≤0.25→0.2, ≤0.5→0.5, ≤0.75→0.7, >0.75→1.0)
$env:PYRAMID_FORMAT="PNG"
$env:PYRAMID_PNG_COMPRESSION="3"
$env:PYRAMID_KERNEL="cubic"

# 서버 시작
python -m api.main

