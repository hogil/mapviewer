# python3-saml 미설치 오류 원인 및 해결

## 🔍 문제 원인

### **1️⃣ Ubuntu 24에서 python3-saml이 설치되지 않은 이유**

Ubuntu에서 서버를 시작할 때 다음 오류가 발생했습니다:

```
ERROR: python3-saml 미설치
```

---

## 📋 현재 코드 상태

### **api/main.py (Line 52-58)**

```python
# SAML (thumbnail_service보다 먼저 import - SAML은 필수, thumbnail은 optional)
try:
    from onelogin.saml2.auth import OneLogin_Saml2_Auth
    from onelogin.saml2.settings import OneLogin_Saml2_Settings
except Exception:
    OneLogin_Saml2_Auth = None
    OneLogin_Saml2_Settings = None
```

**동작:**
- `python3-saml` 라이브러리가 없으면 **조용히 무시**
- `OneLogin_Saml2_Auth`와 `OneLogin_Saml2_Settings`를 `None`으로 설정

---

### **SAML 엔드포인트에서 체크 (Line 519-520, 647-648)**

```python
def _saml_auth(req: Request) -> OneLogin_Saml2_Auth:
    if OneLogin_Saml2_Auth is None:
        raise HTTPException(status_code=500, detail="python3-saml 미설치")
    return OneLogin_Saml2_Auth(_prepare_fastapi_request(req), custom_base_path=str(SAML_DIR))
```

```python
@app.post("/saml/acs")
async def saml_acs(request: Request):
    if OneLogin_Saml2_Auth is None:
        return PlainTextResponse("python3-saml 미설치", status_code=500)
    # ...
```

**동작:**
- SAML 로그인 시도 시 `python3-saml`이 없으면 **500 에러 반환**

---

## 🐛 실제 오류 발생 시나리오

### **Ubuntu 24 서버 시작 시:**

1. **서버 시작**: `./start.sh` 실행
   ```bash
   export AUTO_LOGIN=True  # SAML 자동 로그인 활성화
   python3 -m api.main
   ```

2. **api/main.py 로드**: `python3-saml` import 실패 (설치 안 됨)
   ```python
   OneLogin_Saml2_Auth = None  # 조용히 무시
   ```

3. **브라우저 접속**: 사용자가 웹페이지 접속

4. **AUTO_LOGIN=True**: 자동으로 `/saml/login`으로 리다이렉트

5. **`/saml/login` 호출**: 
   ```python
   auth = _saml_auth(request)  # OneLogin_Saml2_Auth is None!
   # HTTPException 500: "python3-saml 미설치"
   ```

6. **에러 표시**: 사용자에게 "python3-saml 미설치" 오류 표시

---

## 🔧 해결 방법

### **방법 1: python3-saml 설치 (권장)**

Ubuntu 24에서 다음 명령을 실행:

```bash
# 1. 필수 시스템 패키지 설치
sudo apt update
sudo apt install -y libxml2-dev libxslt1-dev python3-dev pkg-config

# 2. python3-saml 설치
pip3 install python3-saml

# 3. requirements.txt 전체 설치 (확실하게)
pip3 install -r requirements.txt
```

**설치 후 확인:**
```bash
python3 -c "from onelogin.saml2.auth import OneLogin_Saml2_Auth; print('OK')"
# 출력: OK
```

---

### **방법 2: AUTO_LOGIN 비활성화 (임시 해결)**

SAML이 필요 없는 경우 `start.sh`에서 비활성화:

```bash
# start.sh
export AUTO_LOGIN=False  # 또는 0

# 또는 라인 삭제/주석 처리
# export AUTO_LOGIN=True
```

**효과:**
- SAML 자동 로그인 비활성화
- 사용자가 직접 로그인 버튼 클릭 시에만 SAML 호출
- `python3-saml` 없어도 서버는 정상 시작

---

### **방법 3: SAML 완전 제거 (비권장)**

SAML 기능이 전혀 필요 없는 경우:

```bash
# start.sh
export AUTO_LOGIN=False

# api/main.py에서 SAML 관련 라우트 주석 처리
# @app.get("/saml/login")
# @app.post("/saml/acs")
# @app.get("/saml/metadata")
```

---

## 🐧 Ubuntu 24 환경 설정 자동화

**scripts/ubuntu_setup.sh** 스크립트를 제공했습니다:

```bash
chmod +x scripts/ubuntu_setup.sh
./scripts/ubuntu_setup.sh
```

**스크립트가 하는 일:**
1. ✅ 시스템 패키지 설치 (libxml2, libxslt)
2. ✅ `python3-saml` 설치
3. ✅ libvips 버전 확인
4. ✅ TurboJPEG 라이브러리 확인
5. ✅ requirements.txt 패키지 설치
6. ✅ 환경 설정 비교 (Windows vs Ubuntu)

---

## ❓ 왜 Windows 11에서는 오류가 없었나?

### **Windows 11 환경:**

1. **AUTO_LOGIN 설정 확인:**
   ```powershell
   # start.ps1에 AUTO_LOGIN 설정이 없음!
   cat start.ps1 | Select-String "AUTO_LOGIN"
   # 결과: (없음)
   ```

2. **기본값:**
   ```python
   # api/main.py
   AUTO_LOGIN = os.getenv("AUTO_LOGIN", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
   # 환경 변수 없으면 False (비활성화)
   ```

3. **동작:**
   - SAML 자동 로그인 **비활성화**
   - 사용자가 직접 로그인 버튼 클릭 전까지 SAML 미호출
   - `python3-saml` 없어도 서버 정상 동작

---

### **Ubuntu 24 환경:**

1. **AUTO_LOGIN 설정:**
   ```bash
   # start.sh (Line 5)
   export AUTO_LOGIN=True  # ✅ 활성화됨!
   ```

2. **동작:**
   - 사용자 접속 시 **자동으로** `/saml/login` 리다이렉트
   - `python3-saml` 없으면 즉시 오류 발생
   - 서버는 시작되지만 웹페이지 접속 불가

---

## ✅ 해결 완료 체크리스트

Ubuntu 24에서 다음을 확인하세요:

- [ ] **python3-saml 설치 확인**
  ```bash
  pip3 list | grep python3-saml
  # 출력: python3-saml  1.16.0 (또는 최신 버전)
  ```

- [ ] **Import 테스트**
  ```bash
  python3 -c "from onelogin.saml2.auth import OneLogin_Saml2_Auth; print('OK')"
  # 출력: OK
  ```

- [ ] **SAML 디렉토리 확인**
  ```bash
  ls -la saml/
  # 출력: settings.json, advanced_settings.json, certs/
  ```

- [ ] **서버 시작 테스트**
  ```bash
  ./start.sh
  # 오류 없이 시작되어야 함
  ```

- [ ] **웹 접속 테스트**
  ```
  https://your-server:8443/
  # SAML 로그인 화면으로 자동 리다이렉트
  ```

---

## 📊 환경별 비교

| 항목 | Windows 11 (사외) | Ubuntu 24 (사내) |
|------|-------------------|------------------|
| **AUTO_LOGIN** | False (기본값) | True (설정됨) |
| **python3-saml** | 없어도 OK | 필수! |
| **SAML 동작** | 수동 (버튼 클릭) | 자동 (접속 시) |
| **오류 발생** | ❌ (SAML 미호출) | ✅ (즉시 호출) |

---

## 🔍 추가 진단

만약 설치 후에도 오류가 계속된다면:

```bash
# 1. Python 경로 확인
which python3
# /usr/bin/python3

# 2. pip3 경로 확인
which pip3
# /usr/bin/pip3

# 3. 설치된 패키지 경로 확인
python3 -c "import sys; print('\n'.join(sys.path))"

# 4. onelogin 모듈 위치 확인
python3 -c "import onelogin; print(onelogin.__file__)"

# 5. 가상 환경 확인 (혹시 venv 사용 중?)
echo $VIRTUAL_ENV
# 비어있어야 함 (전역 설치)
```

---

## 🚀 최종 권장 설정

### **Ubuntu 24 (사내 운영 서버)**

```bash
# start.sh
export AUTO_LOGIN=True              # ✅ SAML 자동 로그인
export THUMBNAIL_FORMAT="JPEG"      # ✅ 성능 최적화
export THUMBNAIL_QUALITY="100"      # ✅ 최고 품질
```

**필수 조건:**
- ✅ `python3-saml` 설치 완료
- ✅ `saml/settings.json` 설정 완료
- ✅ `saml/certs/` 인증서 준비 완료

---

### **Windows 11 (사외 개발 환경)**

```powershell
# start.ps1
# AUTO_LOGIN 설정 없음 (기본값 False)
$env:THUMBNAIL_FORMAT="JPEG"
$env:THUMBNAIL_QUALITY="100"
```

**선택 사항:**
- `python3-saml` 설치 (선택)
- SAML 수동 테스트 가능

---

**마지막 업데이트**: 2025-10-24  
**문제**: Ubuntu 24에서 python3-saml 미설치 오류  
**원인**: AUTO_LOGIN=True이지만 python3-saml 미설치  
**해결**: `pip3 install python3-saml` 또는 `./scripts/ubuntu_setup.sh`

