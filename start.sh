#!/bin/bash
# Ubuntu 24 사내 운영 서버 시작 스크립트 (SAML Auto Login + 초고속 성능)

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

# 초고속 성능 설정 (Ubuntu 운영 서버)
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="85"            # 100 → 85 (품질 약간 낮춰서 속도 향상)
export IO_THREADS="512"                  # 256 → 512 (I/O 스레드 증가)
export THUMBNAIL_SEM="1024"              # 512 → 1024 (동시 썸네일 생성 증가)
export PYVIPS_CONCURRENCY="8192"         # 4096 → 8192 (vips 동시성 증가)
export PYVIPS_CACHE_SIZE="32767"         # 16383 → 32767 (캐시 크기 2배)
export PYVIPS_MEMORY_ALIGN="64"          # 64 유지

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정 (메모리 세션 사용으로 worker 1개 고정)
export WORKERS="1"                       # 메모리 세션 공유 문제로 1개로 고정
export RELOAD="0"                        # 운영 환경에서는 0

# 서버 시작
python3 -m api.main

