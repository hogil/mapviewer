#!/bin/bash
# Ubuntu 24 계열 운영 서버용 스크립트 (SAML Auto Login + 운영값) - 32C / 198GB RAM

# SAML 설정
export AUTO_LOGIN="0"                      # 0=수동 로그인, 1=자동 SAML 리다이렉트

# Python 출력/인코딩
export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"
export UVICORN_LIFESPAN="on"   # FastAPI lifespan 강제 (인덱스 초기화/재빌드 보장)
export UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN="15" # restart 시 종료 대기 상한(초)

# 서버 설정
export HOST="0.0.0.0"
export PORT="5354"
export UVICORN_WORKERS="1"              # 메인 워커 1개 (인덱스/캐시 공유)
export HTTP2="1"                        # legacy marker: 현재 python uvicorn.run 경로의 HTTP/2 스위치로는 사용되지 않음
export KEEP_ALIVE="1"                   # legacy marker: keep-alive는 uvicorn 기본 동작에 맡김

# SSL/TLS 설정
export SSL_ENABLED="1"
export HTTPS_PORT="8443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# 경로 설정
export IMAGES_ROOT="/appdata/appuser/images"        # 이미지 루트 경로
export POSITIONS_ROOT="/appdata/appuser/positions"  # Positions 루트 경로
export LAYOUT_ROOT="/appdata/appuser/project"       # Layout 루트 경로
export LAYOUT_FILE="/appdata/appuser/project/layout.parquet" # Layout Parquet 단일 파일

# 성능 설정 (Ubuntu 24, 32코어, 198GB RAM)
# - 32C/고속 SSD/대용량 RAM 기준 최고속 우선값
# - CPU/IO 포화가 보이면 실제 composite/thumbnail 시간을 비교해 낮춘다.
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="JPEG"           # JPEG가 PNG보다 훨씬 빠름 (139ms vs 수백ms)
export THUMBNAIL_QUALITY="100"           # Q=100 최고 품질
export PNG_COMPRESSION_LEVEL="0"          # PNG 경로 최고속값
export IO_THREADS="384"                  # 32C 서버에서 I/O 대기시간 숨김 (12x CPU)
export THUMBNAIL_SEM="512"               # 여유 메모리 활용해 썸네일 동시 생성 확대
export THUMB_PREFETCH_BATCH="128"
export THUMB_CLIENT_MAX_CONCURRENCY="20" # 클라이언트/ThumbnailManager 동시 요청
export GRID_MAX_CONCURRENCY="64"         # 그리드 썸네일 동시 요청 상한
export MEASURE_PREFETCH_CONCURRENCY="8"  # measure-thumb-batch 동시 워밍업 상한
export THUMBNAIL_EXECUTOR_WORKERS="96"   # 32C 운영 서버 기준 3x core 최고속
export COMPOSITE_FAST_MODE="1"           # ✅ Fast 모드 활성화 (워커 자동 상향 + 비-palette 저장 vips 우선)
# Composite 로더 병렬도. 최고속 설정은 32C/고속 SSD에서 I/O 대기시간을 최대한 숨긴다.
export COMPOSITE_MAX_WORKERS="72"        # Composite 로더: 32C 서버 최고속 실험값
export COMPOSITE_LOADER_MODE="thread"
export COMPOSITE_BATCH_SIZE="72"         # 대용량 이미지용 배치 상향
export COMPOSITE_NUMBA_BATCH_MB="8192"   # 198GB RAM 서버에서 256장 composite를 단일 batch에 가깝게 처리
export COMPOSITE_PALETTE_PNG_COMPRESSION_LEVEL="0" # Composite palette PNG 저장 최고속
export COMPOSITE_CACHE_COMPRESS="0"      # subset용 NPZ persist 최고속(파일 크기 증가 허용)
export DAILY_CLEANUP_ENABLED="1"          # 매일 composite_map + thumbnails 정리 활성화
export DAILY_CLEANUP_HOUR="2"             # 매일 AM 2시 실행
export DAILY_CLEANUP_MINUTE="0"
# 참고: main Composite heatmap/sum-map은 개인색 PLTE 패치를 위해 palette PNG로 저장한다.
# 아래 저장 설정은 palette overlay 등 비-palette 저장 경로에만 적용된다.
export COMPOSITE_SAVE_BACKEND="vips"     # 비-palette 저장 백엔드 vips 우선
export COMPOSITE_FORMAT="JPEG"           # 비-palette 저장 포맷: JPEG (속도 우선)
export COMPOSITE_JPEG_QUALITY="95"       # 비-palette JPEG 품질 (속도/품질 균형)
export COMPOSITE_USE_NUMBA="1"
export COMPOSITE_NUMBA_CACHE="1"
export OMP_NUM_THREADS="32"              # Numba/OpenMP 스레드
# 32C 서버에서 단일 composite 요청 기준 전체 코어를 쓰도록 32 유지 권장.
# 40/48로 올려도 물리 코어를 넘어가면 context switching과 I/O 경합으로 흔들릴 수 있으니, 올릴 경우 실제 composite 시간을 비교해야 한다.
export NUMBA_NUM_THREADS="32"
export SEARCH_WORKERS="24"               # 검색 병렬 워커 수 (32코어 기준, 논리 검색 가속)

# libvips 최적화 (32C/198GB — 대형 이미지 연산 가속)
# VIPS_CONCURRENCY: 단일 이미지 연산의 내부 병렬 스레드 수
# 28 = 4000x4000 리사이즈를 28스레드로 분할 처리 (단일 스레드 대비 ~10x 빠름)
# 동시 요청 경합은 THUMBNAIL_SEM(512)으로 제어
export VIPS_CONCURRENCY="32"             # 32C 서버: 대형 이미지 연산 최고속
export VIPS_DISC_THRESHOLD="10000m"      # 198GB RAM → 디스크 스필 기준 상향
export VIPS_MAX_CACHE="10000"            # 캐시 항목 수 (고성능 서버)
export VIPS_MAX_CACHE_MEM="20000m"       # 메모리 캐시 20GB (198GB 중)
export VIPS_MAX_CACHE_FILES="800"        # 열린 파일 캐시 (누락 보완)

# 검색 폴백 비활성화 (인덱스 결과만 활용)
export SEARCH_FALLBACK_MAX_FILES="0"      # 0=폴백 탐색 비활성화
export SEARCH_FALLBACK_TIMEOUT_MS="0"     # 0=시간 제한 없음

# 인덱스 구축 워커 수 (병렬 디렉터리 스캔 가속)
export INDEX_WORKERS="24"                 # 32C 서버 기준 CPU 75% 상한 (API/썸네일 여유 확보)
export INDEX_REFRESH_INTERVAL_MINUTES="30" # 파일 인덱스 자동 재빌드 간격(분)

# startup background warm 완화
# - restart 직후 초기 self-warm이 AUTO_LOGIN/SAML, recursive warm, composite import와 경합하지 않도록 기본 비활성화
export STARTUP_THUMB_WARM_FOLDERS=""
export STARTUP_THUMB_WARM_COUNT="0"
export STARTUP_WARM_COMPOSITE_MODULES="1"
export STARTUP_WARM_COMPOSITE_NUMBA="1"

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
export PYRAMID_PNG_COMPRESSION="0"           # PNG pyramid 경로 최고속
export PYRAMID_PNG_EFFORT="1"                # PNG effort (1=가장 빠름)
export PYRAMID_KERNEL="cubic"                # 리사이즈 커널 (cubic, 최고 품질)
export PYRAMID_LOADER_MODE="random"          # 로더 모드 (random=스트리밍, copy_memory 오버헤드 없음)
export PYRAMID_BG_WORKERS="32"                # 백그라운드 피라미드 최고속

# 접근 로그 최소화
export ACCESS_LOG_ENABLED="0"                # uvicorn access log 비활성화 (필요 시 1로 전환)
export ACCESS_LOG_LEVEL="WARNING"            # 활성화할 때의 기본 레벨

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
exec python3 -m api.main
