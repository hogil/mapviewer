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
$env:THUMBNAIL_FORMAT="WEBP"
$env:THUMBNAIL_QUALITY="100"

# Windows 11 최적화 (CPU 8코어, RAM 32GB 기준)
$env:IO_THREADS="64"                    # 8코어 * 8 (I/O 스레드 대폭 증가)
$env:THUMBNAIL_SEM="128"                # 8코어 * 16 (동시 썸네일 생성 대폭 증가)
$env:PYVIPS_CONCURRENCY="8"             # 8코어 활용
$env:PYVIPS_CACHE_SIZE="8191"           # 최대 캐시 8191개 (2배 증가)
$env:PYVIPS_MEMORY_ALIGN="64"           # 메모리 정렬
$env:VIPS_DISC_THRESHOLD="2000m"        # 2GB 임계값
$env:VIPS_MAX_CACHE="6000"              # 최대 캐시 6000개 (2배 증가)
$env:VIPS_MAX_CACHE_MEM="2000m"         # 최대 캐시 메모리 2GB (2배 증가)
$env:VIPSHOME="C:\vips-dev-8.14"        # VIPS 홈 디렉토리 (Windows)
$env:PATH="$env:VIPSHOME\bin;$env:PATH" # VIPS 바이너리 경로
$env:G_MESSAGES_DEBUG=""                # VIPS 로그 완전 억제

# 캐시 최적화 (로드 속도 개선)
$env:DIRLIST_CACHE_SIZE="4096"          # 디렉토리 리스트 캐시 (2배 증가)
$env:THUMB_STAT_TTL_SECONDS="15"        # 캐시 유지 시간 (1.5배 증가)
$env:THUMB_STAT_CACHE_CAPACITY="16384"  # 썸네일 통계 캐시 (2배 증가)

$env:STATS_LOG_ENABLED="0"
$env:WORKERS="7"                        # 8코어 * 0.875 (87.5% 활용)
$env:RELOAD="1"

# 서버 시작
python -m api.main
