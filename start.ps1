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
$env:IO_THREADS="128"
$env:THUMBNAIL_SEM="256"
$env:PYVIPS_CONCURRENCY="1024"
$env:PYVIPS_CACHE_SIZE="4095"
$env:PYVIPS_MEMORY_ALIGN="64"
$env:G_MESSAGES_DEBUG=""               # VIPS 로그 완전 억제 (성능 향상)
$env:STATS_LOG_ENABLED="0"
$env:WORKERS="6"
$env:RELOAD="1"

# 서버 시작
python -m api.main
