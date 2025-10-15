#!/bin/bash
# Ubuntu 24 사내 운영 서버 시작 스크립트 (SAML Auto Login + 초고속 성능)

# SAML 설정
export AUTO_LOGIN=True                    # 1=자동SAML로그인강제

# 서버 설정
export HOST="0.0.0.0"
export PORT="8080"

# SSL/TLS 설정
export SSL_ENABLED="1"
export HTTPS_PORT="443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# 초고속 성능 설정 (Ubuntu 24, 32코어, 198GB RAM) - 웹서버 최적화
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="100"           # 무손실 유지 (lossless mode)
export IO_THREADS="64"                   # 32코어 * 2 (I/O 스레드)
export THUMBNAIL_SEM="32"                # 물리 코어 수와 동일 (32개)

# libvips 최적화 (웹서버 환경 - 핵심 변경사항)
export VIPS_CONCURRENCY="1"              # ⚠️ 32→1로 변경 필수 (웹서버 성능 최적화)
export VIPS_DISC_THRESHOLD="3000m"       # 3GB (198GB RAM 활용)
export VIPS_MAX_CACHE="3000"             # 캐시 3000개로 증가
export VIPS_MAX_CACHE_MEM="6000m"        # 6GB로 대폭 증가

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정 (자동 프로세스 고려하여 워커 수 조정)
export WORKERS="24"                      # 32코어 * 0.75 (자동 프로세스 고려하여 안정적)
export RELOAD="0"                        # 운영 환경에서는 0

# 서버 시작
python3 -m api.main

