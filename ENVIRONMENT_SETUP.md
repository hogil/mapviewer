# 환경변수 설정 가이드

## 개요
L3Tracker 웨이퍼맵 뷰어의 환경변수 설정 방법을 Windows 11과 Ubuntu 24에서 설명합니다.

## 필수 환경변수

### 1. UVICORN_WORKERS (서버 워커 수)
서버의 동시 처리 워커 수를 설정합니다.

#### Ubuntu 24
```bash
# 시스템 전체 설정
echo 'export UVICORN_WORKERS=16' | sudo tee -a /etc/environment

# 사용자 설정
echo 'export UVICORN_WORKERS=16' >> ~/.bashrc
source ~/.bashrc

# 현재 세션에서만
export UVICORN_WORKERS=16

# 환경변수 확인
echo $UVICORN_WORKERS
```

#### Windows 11
```powershell
# 시스템 환경변수 (영구)
[Environment]::SetEnvironmentVariable("UVICORN_WORKERS", "16", "Machine")

# 사용자 환경변수 (영구)
[Environment]::SetEnvironmentVariable("UVICORN_WORKERS", "16", "User")

# 현재 세션에서만
$env:UVICORN_WORKERS = "16"

# 환경변수 확인
echo $env:UVICORN_WORKERS
```

### 2. PROJECT_ROOT (이미지 루트 디렉토리)
웨이퍼맵 이미지가 저장된 루트 디렉토리를 설정합니다.

#### Ubuntu 24
```bash
echo 'export PROJECT_ROOT="/home/user/wafer_images"' >> ~/.bashrc
source ~/.bashrc
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("PROJECT_ROOT", "D:\\wafer_images", "User")
```

### 3. HOST, PORT (서버 주소/포트)
서버가 바인딩할 주소와 포트를 설정합니다.

#### Ubuntu 24
```bash
echo 'export HOST="0.0.0.0"' >> ~/.bashrc
echo 'export PORT="8080"' >> ~/.bashrc
source ~/.bashrc
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("HOST", "0.0.0.0", "User")
[Environment]::SetEnvironmentVariable("PORT", "8080", "User")
```

### 4. HTTPS 설정
HTTPS 사용 여부와 인증서 경로를 설정합니다.

#### Ubuntu 24
```bash
echo 'export SSL_ENABLED="1"' >> ~/.bashrc
echo 'export HTTPS_PORT="8443"' >> ~/.bashrc
echo 'export SSL_CERTFILE="cert/fullchain.pem"' >> ~/.bashrc
echo 'export SSL_KEYFILE="cert/server.key"' >> ~/.bashrc
source ~/.bashrc
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("SSL_ENABLED", "1", "User")
[Environment]::SetEnvironmentVariable("HTTPS_PORT", "8443", "User")
[Environment]::SetEnvironmentVariable("SSL_CERTFILE", "cert/fullchain.pem", "User")
[Environment]::SetEnvironmentVariable("SSL_KEYFILE", "cert/server.key", "User")
```

## SAML / 자동 로그인 관련 환경변수

#### Ubuntu 24
```bash
# 개발 모드 SAML 허용(없으면 0)
echo 'export DEV_SAML=1' >> ~/.bashrc
# 자동 로그인 강제 (세션 없으면 /saml/login으로 리다이렉트)
echo 'export AUTO_LOGIN=1' >> ~/.bashrc
# 사내 org_url 기본값(필요 시)
echo 'export DEFAULT_ORG_URL="stsds.secsso.net"' >> ~/.bashrc
source ~/.bashrc
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("DEV_SAML","1","User")
[Environment]::SetEnvironmentVariable("AUTO_LOGIN","1","User")
[Environment]::SetEnvironmentVariable("DEFAULT_ORG_URL","stsds.secsso.net","User")
```

## 선택적 환경변수

### 5. 썸네일 설정

#### Ubuntu 24
```bash
echo 'export THUMBNAIL_SIZE="512"' >> ~/.bashrc
echo 'export THUMBNAIL_FORMAT="WEBP"' >> ~/.bashrc
echo 'export THUMBNAIL_QUALITY="100"' >> ~/.bashrc
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("THUMBNAIL_SIZE", "512", "User")
[Environment]::SetEnvironmentVariable("THUMBNAIL_FORMAT", "WEBP", "User")
[Environment]::SetEnvironmentVariable("THUMBNAIL_QUALITY", "100", "User")
```

### 6. 성능 튜닝

#### Ubuntu 24
```bash
echo 'export IO_THREADS="16"' >> ~/.bashrc
echo 'export THUMBNAIL_SEM="32"' >> ~/.bashrc
echo 'export DIRLIST_CACHE_SIZE="1024"' >> ~/.bashrc
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("IO_THREADS", "16", "User")
[Environment]::SetEnvironmentVariable("THUMBNAIL_SEM", "32", "User")
[Environment]::SetEnvironmentVariable("DIRLIST_CACHE_SIZE", "1024", "User")
```

### 7. 디버그/개발 설정

#### Ubuntu 24
```bash
echo 'export RELOAD="0"' >> ~/.bashrc  # 개발 시 1로 설정
```

#### Windows 11
```powershell
[Environment]::SetEnvironmentVariable("RELOAD", "0", "User")  # 개발 시 1로 설정
```

## 환경변수 확인

### Windows 11
```powershell
# 모든 환경변수 확인
Get-ChildItem Env: | Where-Object Name -like "*UVICORN*"
Get-ChildItem Env: | Where-Object Name -like "*PROJECT*"
Get-ChildItem Env: | Where-Object Name -like "*SSL*"
Get-ChildItem Env: | Where-Object Name -like "*SAML*"
```

### Ubuntu 24
```bash
# 모든 환경변수 확인
env | grep -E "(UVICORN|PROJECT|SSL|HOST|PORT|SAML|AUTO_LOGIN|DEFAULT_ORG_URL)"
```

## 권장 설정값

### 개발 환경
- `UVICORN_WORKERS=4`
- `RELOAD=1`
- `SSL_ENABLED=0` (HTTP만 사용)

### 프로덕션 환경
- `UVICORN_WORKERS=16` (CPU 코어 수의 50-75%)
- `RELOAD=0`
- `SSL_ENABLED=1`
- `PROJECT_ROOT=/path/to/wafer/images`

## 서버 시작

### Windows 11
```powershell
cd D:\project\l3tracker
python -m api.main
```

### Ubuntu 24
```bash
cd /path/to/l3tracker
python -m api.main
```

## 문제 해결

### 1. 서버가 시작되지 않는 경우
- Python 경로 확인: `python --version`
- 의존성 설치: `pip install -r requirements.txt`
- 포트 사용 중 확인: `netstat -an | findstr :8443` (Windows) / `netstat -tulpn | grep :8443` (Ubuntu)

### 2. HTTPS 인증서 오류
- 인증서 파일 존재 확인
- 파일 권한 확인 (Ubuntu: `chmod 600 cert/*.pem`)
- 인증서 유효성 확인: `openssl x509 -in cert/fullchain.pem -text -noout`

### 3. 이미지 로드 실패
- `PROJECT_ROOT` 경로 확인
- 이미지 파일 권한 확인
- 지원되는 파일 형식 확인 (jpg, png, tiff 등)

## 참고사항

- 환경변수 변경 후 서버 재시작 필요
- Windows에서는 관리자 권한으로 실행해야 시스템 환경변수 설정 가능
- Ubuntu에서는 `sudo` 권한으로 시스템 전체 설정 가능
- 개발 시에는 `.env` 파일 사용도 가능 (python-dotenv 패키지 필요)
