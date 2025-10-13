#!/bin/bash
# Ubuntu 24 사내 운영 서버 시작 스크립트 (SAML Auto Login)

# SAML 설정
export AUTO_LOGIN="1"                    # 1=자동SAML로그인강제

# 서버 설정
export HOST="0.0.0.0"
export PORT="8080"

# SSL/TLS 설정
export SSL_ENABLED="1"
export HTTPS_PORT="443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# 성능 설정
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="100"
export IO_THREADS="128"
export THUMBNAIL_SEM="256"
export PYVIPS_CONCURRENCY="1024"
export PYVIPS_CACHE_SIZE="4095"
export PYVIPS_MEMORY_ALIGN="64"

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정
export WORKERS="6"
export RELOAD="0"                        # 운영 환경에서는 0

# 서버 시작
python3 -m api.main

