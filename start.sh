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

# 최적화된 성능 설정 (Ubuntu 24, 32코어, 192GB RAM)
# - 과도한 병렬화는 오히려 성능 저하 (컨텍스트 스위칭, 메모리 경합)
# - "More is not always better" - 코어 수에 맞춘 적절한 병렬화
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="JPEG"           # JPEG가 PNG보다 훨씬 빠름 (139ms vs 수백ms)
export THUMBNAIL_QUALITY="100"           # Q=100 최고 품질
export PNG_COMPRESSION_LEVEL="3"
export IO_THREADS="64"                   # 32코어 * 2 (적절한 I/O 병렬화)
export THUMBNAIL_SEM="64"                # 동시 썸네일 생성 (메모리 경합 방지)
export THUMB_PREFETCH_BATCH="64"
export THUMB_CLIENT_MAX_CONCURRENCY="12"

# libvips 최적화 (웹서버 환경 - 적절한 병렬화)
export VIPS_CONCURRENCY="16"             # 32코어의 50% (과도한 병렬화 방지)
export VIPS_DISC_THRESHOLD="1000m"       # 1GB (적절한 메모리 사용)
export VIPS_MAX_CACHE="4000"             # 캐시 4000개 (관리 오버헤드 감소)
export VIPS_MAX_CACHE_MEM="2048m"        # 2GB 메모리 캐시 (효율적 사용)

# Python/시스템 최적화
export PYTHONUNBUFFERED="1"              # 실시간 로그 출력
export MALLOC_ARENA_MAX="4"              # 메모리 fragmentation 방지

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정 (최적 성능)
export WORKERS="16"                      # 32코어의 50% (프로세스 간 통신 오버헤드 감소)
export RELOAD="0"                        # 운영 환경에서는 0

# 캐시 설정
export DIRLIST_CACHE_SIZE="8192"         # 디렉토리 캐시
export THUMB_STAT_CACHE_CAPACITY="32768" # 썸네일 stat 캐시

# 이미지 피라미드 설정
# 2025-10-24: 피라미드 썸네일 품질 및 속도 최적화
# - PYRAMID_Q: 95→100 (그리드 썸네일과 동일한 최고 품질)
# - PYRAMID_LOADER_MODE: seq_early_copy→random (copy_memory() 오버헤드 제거)
# 원복 시점: commit dce1bb2 (2025-10-23)
export PYRAMID_LEVELS="0.2,0.5,0.7,1.0"      # 피라미드 레벨
export PYRAMID_ZOOM_THRESHOLDS="0.25,0.5,0.75"  # zoom 기준 (≤0.25→0.2, ≤0.5→0.5, ≤0.75→0.7, >0.75→1.0)
export PYRAMID_FORMAT="JPEG"                 # JPEG 포맷
export PYRAMID_Q="100"                       # JPEG 품질 Q=100 (최고 품질)
export PYRAMID_PNG_COMPRESSION="3"           # PNG 압축 레벨
export PYRAMID_PNG_EFFORT="1"                # PNG effort (1=가장 빠름)
export PYRAMID_KERNEL="cubic"                # 리사이즈 커널 (cubic, 최고 품질)
export PYRAMID_LOADER_MODE="random"          # 로더 모드 (random=스트리밍, copy_memory 오버헤드 없음)

# TurboJPEG 설정 (그리드 썸네일 전용)
# 2025-10-24: 그리드 썸네일 TurboJPEG 4:2:2 적용
# - 벤치마크 결과 (300개): TurboJPEG Q100 422 FASTDCT (12,593ms) > pyvips (13,016ms) = 3.4% 빠름
# - 4:2:2 선택 이유: 세로 방향 색상 경계 보존, 속도는 4:2:0과 유사
# - 피라미드는 pyvips 사용, 그리드는 TurboJPEG 422 사용
export USE_TURBOJPEG="1"
export TURBOJPEG_PATH="/usr/lib/x86_64-linux-gnu/libturbojpeg.so.0"

# 서버 시작
python3 -m api.main

