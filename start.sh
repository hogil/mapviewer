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

# 초고속 성능 설정 (Ubuntu 24, 32코어, 192GB RAM)
# - 서버 스펙이 더 높다면 아래 값들을 올려도 됩니다.
#   * IO_THREADS: 코어 수에 맞춰 8배까지 확장 가능 (예: 32C → 256)
#   * THUMBNAIL_SEM: 동시에 생성할 썸네일 개수, 충분한 RAM이 있다면 512 이상도 가능
#   * THUMB_PREFETCH_BATCH / THUMB_CLIENT_MAX_CONCURRENCY: 프론트 프리패치 배치/동시수
#   * VIPS_CONCURRENCY: pyvips 내부 워커 수, CPU 사용량에 맞춰 조정
# - 조정 후에는 반드시 `/api/config` 응답과 프런트 콘솔 로그를 확인해 적용 여부를 점검하세요.
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="PNG"
export THUMBNAIL_QUALITY="100"           # PNG 무손실, Q=100 유지
export PNG_COMPRESSION_LEVEL="3"
export IO_THREADS="256"                  # 32코어 * 8 (I/O 집약적 워크로드)
export THUMBNAIL_SEM="512"               # 동시 썸네일 생성 (충분한 RAM 활용)
export THUMB_PREFETCH_BATCH="64"
export THUMB_CLIENT_MAX_CONCURRENCY="12"

# libvips 최적화 (웹서버 환경 - 핵심 변경사항)
export VIPS_CONCURRENCY="24"             # 고코어 서버용 병렬 처리
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

# 이미지 피라미드 설정
export PYRAMID_LEVELS="0.2,0.5,0.7,1.0"      # 피라미드 레벨 (최고품질 Q=100, Lanczos3)
export PYRAMID_ZOOM_THRESHOLDS="0.25,0.5,0.75"  # zoom 기준 (≤0.25→0.2, ≤0.5→0.5, ≤0.75→0.7, >0.75→1.0)
export PYRAMID_FORMAT="${PYRAMID_FORMAT:-JPEG}"
export PYRAMID_Q="${PYRAMID_Q:-95}"
export PYRAMID_PNG_COMPRESSION="${PYRAMID_PNG_COMPRESSION:-3}"
export PYRAMID_PNG_EFFORT="${PYRAMID_PNG_EFFORT:-1}"
export PYRAMID_KERNEL="${PYRAMID_KERNEL:-cubic}"
export PYRAMID_LOADER_MODE="${PYRAMID_LOADER_MODE:-seq_early_copy}"
export USE_TURBOJPEG="${USE_TURBOJPEG:-1}"
export TURBOJPEG_PATH="${TURBOJPEG_PATH:-/usr/lib/x86_64-linux-gnu/libturbojpeg.so.0}"

# 서버 시작
python3 -m api.main

