# 환경 변수 설정 가이드

## 🖥️ 사내 Ubuntu 24 서버 (운영 환경 - SAML 자동 로그인)

### 필수 환경변수
```bash
# SAML 자동 로그인 활성화
export AUTO_LOGIN="1"

# 서버 설정
export HOST="0.0.0.0"
export PORT="8080"

# SSL/TLS 설정 (필수)
export SSL_ENABLED="1"
export HTTPS_PORT="443"
export SSL_CERTFILE="cert/fullchain.pem"
export SSL_KEYFILE="cert/server.key"

# 성능 최적화 (고성능 서버)
export IO_THREADS="128"
export THUMBNAIL_SEM="256"
export PYVIPS_CONCURRENCY="1024"
export PYVIPS_CACHE_SIZE="4095"
export PYVIPS_MEMORY_ALIGN="64"
export WORKERS="8"  # CPU 코어 수에 맞게 조정

# 썸네일 설정
export THUMBNAIL_SIZE="512"
export THUMBNAIL_FORMAT="WEBP"
export THUMBNAIL_QUALITY="100"

# 통계 로그 (선택)
export STATS_LOG_ENABLED="1"

# 개발 모드 비활성화 (자동)
export RELOAD="0"
```

### 실행 방법
```bash
# 1. 환경변수 설정
source /path/to/env_production.sh

# 2. 가상환경 활성화
source .venv/bin/activate

# 3. 서버 실행
python -m api.main

# 또는 uvicorn으로 실행 (워커 여러 개)
uvicorn api.main:app --host 0.0.0.0 --port 8080 --workers 8 \
  --ssl-keyfile cert/server.key \
  --ssl-certfile cert/fullchain.pem
```

---

## 💻 Windows 11 개발 환경 (로컬 개발 - SAML 테스트)

### start.ps1 설정
```powershell
# 환경변수 설정
$env:AUTO_LOGIN="0"      # 0=자동로그인 비활성화 (개발용)
$env:HOST="0.0.0.0"
$env:PORT="8080"
$env:SSL_ENABLED="1"
$env:HTTPS_PORT="443"
$env:SSL_CERTFILE="cert/fullchain.pem"
$env:SSL_KEYFILE="cert/server.key"
$env:THUMBNAIL_SIZE="512"
$env:THUMBNAIL_FORMAT="WEBP"
$env:THUMBNAIL_QUALITY="100"
$env:IO_THREADS="32"     # Windows는 낮춤
$env:THUMBNAIL_SEM="64"  # Windows는 낮춤
$env:PYVIPS_CONCURRENCY="256"
$env:PYVIPS_CACHE_SIZE="1024"
$env:PYVIPS_MEMORY_ALIGN="64"
$env:STATS_LOG_ENABLED="0"
$env:WORKERS="1"         # Windows 개발 시 1개
$env:RELOAD="1"          # 개발 시 핫 리로드

# 서버 시작
python -m api.main
```

### 실행 방법
```powershell
# PowerShell에서 실행
.\start.ps1

# 또는 직접 실행
.venv\Scripts\Activate.ps1
python -m api.main
```

---

## 🔧 SAML 설정 (saml/settings.json)

### 사내 Ubuntu 서버용
```json
{
  "sp": {
    "entityId": "l3tracker-sp",
    "assertionConsumerService": {
      "url": "https://실제서버주소.회사도메인.com/saml/acs",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
    },
    "singleLogoutService": {
      "url": "https://실제서버주소.회사도메인.com/saml/sls",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
    },
    "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
  },
  "idp": {
    "entityId": "https://사내IdP주소/adfs/services/trust",
    "singleSignOnService": {
      "url": "https://사내IdP주소/adfs/ls",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
    },
    "singleLogoutService": {
      "url": "https://사내IdP주소/adfs/ls/?wa=wsignoutcleanup1.0",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
    },
    "x509cert": "-----BEGIN CERTIFICATE-----\n실제인증서내용\n-----END CERTIFICATE-----"
  }
}
```

### Windows 개발용 (localhost)
```json
{
  "sp": {
    "entityId": "l3tracker-sp",
    "assertionConsumerService": {
      "url": "https://localhost/saml/acs",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
    },
    "singleLogoutService": {
      "url": "https://localhost/saml/sls",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
    },
    "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
  },
  "idp": {
    "entityId": "https://your-idp.example.com/adfs/services/trust",
    "singleSignOnService": {
      "url": "https://your-idp.example.com/adfs/ls",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
    },
    "singleLogoutService": {
      "url": "https://your-idp.example.com/adfs/ls/?wa=wsignoutcleanup1.0",
      "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
    },
    "x509cert": ""
  }
}
```

---

## ⚙️ DEV_SAML 설정 (코드 내 고정)

**api/main.py**에서 고정값으로 설정:
```python
DEV_SAML = 0  # 0=개발모드폴백허용, 1=SAML필수(운영)
```

- **사내 Ubuntu 운영 환경**: `DEV_SAML = 1` (SAML 필수)
- **Windows 개발 환경**: `DEV_SAML = 0` (개발 모드 폴백)

---

## 📊 환경변수 요약표

| 환경변수 | Ubuntu 운영 | Windows 개발 | 설명 |
|---------|------------|--------------|------|
| AUTO_LOGIN | 1 | 0 | SAML 자동 로그인 강제 |
| HOST | 0.0.0.0 | 0.0.0.0 | 바인드 주소 |
| PORT | 8080 | 8080 | HTTP 포트 |
| SSL_ENABLED | 1 | 1 | HTTPS 활성화 |
| HTTPS_PORT | 443 | 443 | HTTPS 포트 |
| IO_THREADS | 128 | 32 | I/O 스레드 수 |
| THUMBNAIL_SEM | 256 | 64 | 썸네일 동시 생성 수 |
| PYVIPS_CONCURRENCY | 1024 | 256 | PyVips 동시성 |
| WORKERS | 8 | 1 | Uvicorn 워커 수 |
| RELOAD | 0 | 1 | 핫 리로드 (개발 전용) |
| STATS_LOG_ENABLED | 1 | 0 | 통계 로그 활성화 |

---

## 🔍 문제 해결

### "saml-user"로 표시되는 문제
서버 로그에서 다음을 확인:
```
🔍 [DEBUG] meta.get('LoginId'): None 또는 실제값
🔍 [DEBUG] auth.get_nameid(): None 또는 실제값
```

둘 다 None이면 → SAML attributes에서 LoginId를 못 찾는 것
→ 백엔드 로그의 `[SAML ATTRIBUTES]`에서 실제 필드명 확인

### 쿠키가 업데이트 안 되는 문제
브라우저에서:
1. F12 → Application → Cookies → `https://서버주소`
2. `session_user`, `session_meta` 쿠키 삭제
3. 페이지 새로고침 (Ctrl+Shift+R)
