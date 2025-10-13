# 환경 변수 설정 가이드

## 🐧 Ubuntu 24 (사내 운영 서버 - SAML Auto Login + 초고속)

```bash
# start_ubuntu.sh 사용
chmod +x start_ubuntu.sh
./start_ubuntu.sh

# 또는 수동 설정:
export AUTO_LOGIN="1"
export HOST="0.0.0.0"
export PORT="8080"
export SSL_ENABLED="1"
export HTTPS_PORT="443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="100"
export IO_THREADS="256"                  # ⚡ 초고속: 256
export THUMBNAIL_SEM="512"               # ⚡ 초고속: 512
export PYVIPS_CONCURRENCY="4096"         # ⚡⚡ 초고속: 4096
export PYVIPS_CACHE_SIZE="16383"         # ⚡⚡ 초고속: 16383
export PYVIPS_MEMORY_ALIGN="64"          # 64
export STATS_LOG_ENABLED="1"
export WORKERS="24"                      # ⚡⚡ 초고속: 24 workers
export RELOAD="0"
python3 -m api.main
```

## 🪟 Windows 11 (개발 환경)

```powershell
# start.ps1에 설정
$env:AUTO_LOGIN="1"                      # 1=자동SAML로그인강제, 0=비활성화
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
$env:STATS_LOG_ENABLED="0"               # 0=통계 수집 비활성화 (개발)
$env:WORKERS="6"
$env:RELOAD="1"                          # 1=핫 리로드 (개발)
```

## 🔑 주요 환경 변수 설명

### SAML 관련
- `AUTO_LOGIN`: 1=세션 없을 때 자동으로 SAML 로그인 강제
- `DEV_SAML`: **코드에서 고정값 사용 (환경변수 사용 안 함)**

### 서버 설정
- `HOST`: 바인드할 호스트 주소
- `PORT`: HTTP 포트
- `SSL_ENABLED`: SSL/TLS 활성화 여부
- `HTTPS_PORT`: HTTPS 포트

### 성능 설정
- `THUMBNAIL_SIZE`: 썸네일 크기 (픽셀)
- `IO_THREADS`: I/O 스레드 풀 크기
- `THUMBNAIL_SEM`: 동시 썸네일 생성 제한
- `PYVIPS_*`: PyVips 이미지 처리 성능 설정

### 개발/운영 차이
- **운영**: `RELOAD=0`, `STATS_LOG_ENABLED=1`
- **개발**: `RELOAD=1`, `STATS_LOG_ENABLED=0`

