#!/bin/bash
# Ubuntu 24 사내 운영 서버 시작 스크립트 (SAML Auto Login + 초고속 성능)

# SAML 설정
export AUTO_LOGIN=True                    # 1=자동SAML로그인강제

# 서버 설정
export HOST="0.0.0.0"
export PORT="8080"

# SSL/TLS 설정
export SSL_ENABLED="1"
export HTTPS_PORT="8443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# 초고속 성능 설정 (Ubuntu 24, 32코어, 198GB RAM)
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="100"           # 최고품질 (Q=100, Lanczos3)
export IO_THREADS="128"                  # 32코어 * 4 (I/O 집약적 워크로드)
export THUMBNAIL_SEM="256"               # 동시 썸네일 생성 (충분한 RAM 활용)

# libvips 최적화 (웹서버 환경 - 핵심 변경사항)
export VIPS_CONCURRENCY="1"              # ⚠️ 웹서버 성능 최적화 (멀티프로세스 환경)
export VIPS_DISC_THRESHOLD="10000m"      # 10GB (198GB RAM 활용)
export VIPS_MAX_CACHE="10000"            # 캐시 10000개로 대폭 증가
export VIPS_MAX_CACHE_MEM="20000m"       # 20GB 메모리 캐시 (초고속)

# Python/시스템 최적화
export PYTHONUNBUFFERED="1"              # 실시간 로그 출력
export MALLOC_ARENA_MAX="4"              # 메모리 fragmentation 방지

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정 (최대 성능)
export WORKERS="28"                      # 32코어 * 0.875 (더 많은 워커, 4코어는 시스템용)
export RELOAD="0"                        # 운영 환경에서는 0

# 캐시 설정
export DIRLIST_CACHE_SIZE="8192"         # 디렉토리 캐시 대폭 증가
export THUMB_STAT_CACHE_CAPACITY="32768" # 썸네일 stat 캐시 증가

# 서버 시작
python3 -m api.main

