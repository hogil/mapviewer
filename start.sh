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

# 초고속 성능 설정 (Ubuntu 24, 32코어, 198GB RAM)
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="90"            # 품질과 속도 균형
export IO_THREADS="64"                   # 32코어 * 2 (I/O 스레드)
export THUMBNAIL_SEM="128"               # 32코어 * 4 (동시 썸네일 생성)
export PYVIPS_CONCURRENCY="8192"         # vips 동시성
export PYVIPS_CACHE_SIZE="32767"         # 캐시 크기
export PYVIPS_MEMORY_ALIGN="64"          # 메모리 정렬

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정 (파일 기반 세션 사용으로 worker 증가 가능)
export WORKERS="32"                      # 파일 세션 공유로 worker 증가 가능
export RELOAD="0"                        # 운영 환경에서는 0

# 서버 시작
python3 -m api.main

