# start.ps1 vs start.sh 비교

## 공통점 ⚠️ **중요!**

### 둘 다 `RELOAD="0"` 설정
- **Windows (start.ps1)**: `$env:RELOAD="0"`
- **Linux (start.sh)**: `export RELOAD="0"`

**의미**: 코드 변경 시 **자동 재로드가 안 됩니다!** 
→ 파일 변경 후 **반드시 수동으로 서버를 재시작**해야 합니다.

## 차이점

### 1. 실행 환경
- **start.ps1**: Windows 개발 환경 (PowerShell)
- **start.sh**: Linux Ubuntu 운영 서버 (Bash)

### 2. Python 실행 명령
- **start.ps1**: `python -m api.main`
- **start.sh**: `python3 -m api.main`

### 3. AUTO_LOGIN 설정
- **start.ps1**: `AUTO_LOGIN="0"` (수동 로그인)
- **start.sh**: `AUTO_LOGIN=True` (자동 SAML 로그인)

### 4. 성능 설정 (워커 수, 캐시 크기)
- **start.ps1**: 개발 환경용 (작은 값)
  - `IO_THREADS="80"`
  - `THUMBNAIL_SEM="48"`
  - `VIPS_CONCURRENCY="4"`
  
- **start.sh**: 운영 서버용 (큰 값, 32코어 서버)
  - `IO_THREADS="160"`
  - `THUMBNAIL_SEM="288"`
  - `VIPS_CONCURRENCY="20"`

### 5. SSL 포트
- **start.ps1**: `HTTPS_PORT="443"`
- **start.sh**: `HTTPS_PORT="8443"`

## 🔥 문제 해결: 코드 변경이 반영되지 않는 경우

### 원인
둘 다 `RELOAD="0"`이므로 코드 변경 후 자동 재로드가 안 됩니다.

### 해결 방법
1. **서버를 완전히 종료**
   ```bash
   # Linux
   pkill -f "python.*api.main"
   
   # Windows PowerShell
   taskkill /F /IM python.exe
   ```

2. **Python 캐시 삭제**
   ```bash
   # Linux
   find . -type d -name "__pycache__" -exec rm -r {} + 2>/dev/null
   find . -type f -name "*.pyc" -delete 2>/dev/null
   
   # Windows PowerShell
   Get-ChildItem -Path . -Include __pycache__ -Recurse -Directory | Remove-Item -Recurse -Force
   Get-ChildItem -Path . -Include *.pyc -Recurse -File | Remove-Item -Force
   ```

3. **서버 재시작**
   ```bash
   # Linux
   ./start.sh
   
   # Windows PowerShell
   .\start.ps1
   ```

4. **브라우저 캐시 강제 새로고침**
   - `Ctrl+Shift+R` (Windows/Linux)
   - `Cmd+Shift+R` (Mac)

## 개발 환경에서 자동 재로드 사용하려면

### 임시로 자동 재로드 활성화
```bash
# Linux
export RELOAD="1"
export UVICORN_WORKERS="1"  # RELOAD 사용 시 워커는 1개만 가능
python3 -m api.main

# Windows PowerShell
$env:RELOAD="1"
$env:UVICORN_WORKERS="1"
python -m api.main
```

**주의**: 운영 환경에서는 `RELOAD="0"`을 유지하세요. 자동 재로드는 개발 환경에서만 사용하세요.

