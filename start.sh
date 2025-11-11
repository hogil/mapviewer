#!/bin/bash
# Ubuntu 24 사내 운영 서버 시작 스크립트 (SAML Auto Login + 초고속 성능)

# SAML 설정
export AUTO_LOGIN=True                    # 1=자동SAML로그인강제

# 서버 설정
export HOST="0.0.0.0"
export PORT="8080"
export UVICORN_WORKERS="1"              # 메인 워커 1개 (인덱스/캐시 공유)

# SSL/TLS 설정
export SSL_ENABLED="1"
export HTTPS_PORT="8443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# 경로 설정
export IMAGES_ROOT="/appdata/appuser/images"        # 이미지 루트 경로
export POSITIONS_ROOT="/appdata/appuser/positions"  # Positions 루트 경로

# 성능 설정 (Ubuntu 24, 32코어, 192GB RAM)
# - 벤치마크 기반 중간값 (원본 고성능 vs 보수적 최적화 사이)
# - 실제 워크로드에 따라 조정 권장
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="JPEG"           # JPEG가 PNG보다 훨씬 빠름 (139ms vs 수백ms)
export THUMBNAIL_QUALITY="100"           # Q=100 최고 품질
export PNG_COMPRESSION_LEVEL="3"
export IO_THREADS="160"                  # 중간값 (256→64→160) - I/O 병렬화
export THUMBNAIL_SEM="288"               # 중간값 (512→64→288) - 동시 썸네일 생성
export THUMB_PREFETCH_BATCH="64"
export THUMB_CLIENT_MAX_CONCURRENCY="12"
export COMPOSITE_MAX_WORKERS="12"
export COMPOSITE_LOADER_MODE="thread"
export SEARCH_WORKERS="24"               # 검색 병렬 워커 수 (32코어 기준, 논리 검색 가속)

# libvips 최적화 (웹서버 환경)
export VIPS_CONCURRENCY="20"             # 중간값 (24→16→20) - 병렬 처리
export VIPS_DISC_THRESHOLD="5500m"       # 중간값 (10000m→1000m→5500m) - 디스크 사용 기준
export VIPS_MAX_CACHE="7000"             # 중간값 (10000→4000→7000) - 캐시 항목 수
export VIPS_MAX_CACHE_MEM="11024m"       # 중간값 (20000m→2048m→11024m) - 메모리 캐시

# 검색 폴백 비활성화 (인덱스 결과만 활용)
export SEARCH_FALLBACK_LIMIT="0"          # 0=폴백 결과 제한 없음 → 폴백 비활성화
export SEARCH_FALLBACK_MAX_FILES="0"      # 0=폴백 탐색 비활성화
export SEARCH_FALLBACK_TIMEOUT_MS="0"     # 0=시간 제한 없음

# 인덱스 구축 워커 수 (병렬 디렉터리 스캔 가속)
export INDEX_WORKERS="32"                 # 서버 사양에 맞게 조정 (예: 32~64)
export INDEX_REFRESH_INTERVAL_MINUTES="30" # 파일 인덱스 자동 재빌드 간격(분)

# Python/시스템 최적화
export PYTHONUNBUFFERED="1"              # 실시간 로그 출력
export MALLOC_ARENA_MAX="4"              # 메모리 fragmentation 방지

# 통계 로깅
export STATS_LOG_ENABLED="1"             # 1=통계 수집 활성화

# Uvicorn 설정
# FastAPI는 단일 워커 고정 (인덱스/캐시 공유)
export WORKERS="1"
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
export PYRAMID_BG_WORKERS="24"                # 백그라운드 피라미드 워커

# TurboJPEG 설정 (그리드 썸네일 전용)
# 2025-10-24: 그리드 썸네일 TurboJPEG 4:2:2 적용
# - 벤치마크 결과 (300개): TurboJPEG Q100 422 FASTDCT (12,593ms) > pyvips (13,016ms) = 3.4% 빠름
# - 4:2:2 선택 이유: 세로 방향 색상 경계 보존, 속도는 4:2:0과 유사
# - 피라미드는 pyvips 사용, 그리드는 TurboJPEG 422 사용
export USE_TURBOJPEG="1"
export TURBOJPEG_PATH="/usr/lib/x86_64-linux-gnu/libturbojpeg.so.0"

# 🧹 Python 캐시 정리 (서버 시작 전)
echo "🧹 Python 캐시 정리 중..."
find . -type d -name "__pycache__" -exec rm -r {} + 2>/dev/null
find . -type f -name "*.pyc" -delete 2>/dev/null
echo "✅ 캐시 정리 완료"
echo ""

# 서버 시작
python3 -m api.main

