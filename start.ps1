# 사외 windows11 개발 서버 시작 스크립트(saml 불가)
# PowerShell에서 실행: .\start.ps1

# UTF-8 인코딩 설정 (한글 로그 깨짐 방지)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
chcp 65001 | Out-Null

# 환경변수 설정
$env:AUTO_LOGIN="0"      # 0=자동로그인비활성화(개발), 1=SAML강제(운영)
$env:HOST="0.0.0.0"
$env:PORT="8080"
$env:SSL_ENABLED="1"
$env:HTTPS_PORT="443"
$env:SSL_CERTFILE="cert/fullchain.pem"
$env:SSL_KEYFILE="cert/server.key"
$env:THUMBNAIL_SIZE="512"
$env:THUMBNAIL_FORMAT="WEBP"
$env:THUMBNAIL_QUALITY="100"
$env:IO_THREADS="32"     # Windows는 낮춤
$env:THUMBNAIL_SEM="64"  # Windows는 낮춤
$env:PYVIPS_CONCURRENCY="256"
$env:PYVIPS_CACHE_SIZE="1024"
$env:PYVIPS_MEMORY_ALIGN="64"
$env:STATS_LOG_ENABLED="0"
$env:WORKERS="1"         # Windows 개발은 1
$env:RELOAD="1"          # 개발 시 핫 리로드

# 서버 시작
python -m api.main
