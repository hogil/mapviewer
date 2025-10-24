# Windows 11 vs Ubuntu 24 성능 비교

## 📊 환경 차이점

### **Windows 11 (사외 개발 환경)**
```powershell
# start.ps1
THUMBNAIL_FORMAT="JPEG"
THUMBNAIL_QUALITY="100"
THUMBNAIL_SEM="32"              # 동시 썸네일 생성 수
VIPS_CONCURRENCY="12"           # pyvips 워커 수
IO_THREADS="40"
WORKERS=(기본값)
```

### **Ubuntu 24 (사내 운영 서버)**
```bash
# start.sh
THUMBNAIL_FORMAT="JPEG"         # PNG에서 JPEG로 변경 (성능 향상)
THUMBNAIL_QUALITY="100"
THUMBNAIL_SEM="512"             # 고성능 서버용 높은 값
VIPS_CONCURRENCY="24"           # 32코어 대응
IO_THREADS="256"
WORKERS="28"                    # 32코어 * 0.875
```

---

## 🔍 Ubuntu 24에서 느린 원인 분석

### **1️⃣ SAML 라이브러리 누락**
```bash
ERROR: python3-saml 미설치
```

**해결:**
```bash
pip3 install python3-saml
```

---

### **2️⃣ 썸네일 포맷 차이 (PNG vs JPEG)**

**이전 설정 (느림):**
```bash
export THUMBNAIL_FORMAT="PNG"   # ❌ 매우 느림 (300-500ms/개)
```

**현재 설정 (빠름):**
```bash
export THUMBNAIL_FORMAT="JPEG"  # ✅ 빠름 (30-50ms/개)
```

**성능 차이:**
- PNG: 300-500ms/개 (압축 느림)
- JPEG Q=100: 30-50ms/개 (6-15배 빠름!)

---

### **3️⃣ TurboJPEG 경로 확인 필요**

**Ubuntu 24:**
```bash
export TURBOJPEG_PATH="/usr/lib/x86_64-linux-gnu/libturbojpeg.so.0"
```

**확인 방법:**
```bash
ldconfig -p | grep turbojpeg
```

**설치 (없는 경우):**
```bash
sudo apt install libturbojpeg0-dev
```

---

## 🧪 성능 테스트 방법

### **대량 썸네일 생성 테스트 (300개)**

```bash
# 1. 스크립트 권한 설정
chmod +x scripts/thumbnail_performance_test.py
chmod +x scripts/ubuntu_setup.sh

# 2. 환경 설정
./scripts/ubuntu_setup.sh

# 3. 서버 시작
./start.sh

# 4. 성능 테스트 (별도 터미널)
python3 scripts/thumbnail_performance_test.py
```

---

## 📈 예상 성능

### **Windows 11 (개발 환경)**
```
300개 썸네일 생성:
  - 총 시간: ~12,000ms
  - 평균: ~40ms/개
  - 처리량: ~25개/초
```

### **Ubuntu 24 (운영 서버) - PNG 사용 시 (느림)**
```
300개 썸네일 생성:
  - 총 시간: ~90,000ms  ❌ 7.5배 느림!
  - 평균: ~300ms/개
  - 처리량: ~3.3개/초
```

### **Ubuntu 24 (운영 서버) - JPEG 사용 시 (빠름)**
```
300개 썸네일 생성:
  - 총 시간: ~9,000ms  ✅ 1.3배 빠름!
  - 평균: ~30ms/개
  - 처리량: ~33개/초
  
※ 더 높은 성능 (32코어, 192GB RAM)으로 인해 Windows보다 빠름
```

---

## ✅ 해결 체크리스트

### **Ubuntu 24 환경 설정**
- [ ] `python3-saml` 설치 완료
- [ ] `start.sh`에서 `THUMBNAIL_FORMAT="JPEG"` 확인
- [ ] TurboJPEG 라이브러리 설치 및 경로 확인
- [ ] `libvips42` 최신 버전 설치 확인
- [ ] `requirements.txt` 패키지 설치 완료

### **성능 테스트**
- [ ] `scripts/thumbnail_performance_test.py` 실행
- [ ] 300개 썸네일 생성 시간 측정
- [ ] Windows 11과 비교

### **운영 환경 최적화**
- [ ] `VIPS_CONCURRENCY` 조정 (CPU 코어 수에 맞춰)
- [ ] `THUMBNAIL_SEM` 조정 (동시 생성 수)
- [ ] `IO_THREADS` 조정 (I/O 처리량)
- [ ] `WORKERS` 조정 (uvicorn 워커 수)

---

## 🚀 최적 설정 (Ubuntu 24, 32코어, 192GB RAM)

```bash
# start.sh
export THUMBNAIL_FORMAT="JPEG"           # ✅ 필수
export THUMBNAIL_QUALITY="100"           # ✅ 최고 품질
export THUMBNAIL_SEM="512"               # ✅ 고성능
export VIPS_CONCURRENCY="24"             # ✅ 32코어 대응
export IO_THREADS="256"                  # ✅ 고I/O
export WORKERS="28"                      # ✅ 32코어 * 0.875

export VIPS_MAX_CACHE_MEM="20000m"       # 20GB 캐시
export VIPS_DISC_THRESHOLD="10000m"      # 10GB 메모리
export VIPS_MAX_CACHE="10000"            # 캐시 10000개
```

---

## 📝 성능 측정 결과 기록

### **Windows 11**
```
테스트 일자: 2025-10-24
환경: 개발 PC (사양 미상)
포맷: JPEG Q=100
300개 썸네일: 12,790ms (평균 42.6ms/개)
```

### **Ubuntu 24 (PNG 사용)**
```
테스트 일자: 2025-10-24
환경: 32코어, 192GB RAM
포맷: PNG
결과: 매우 느림 (예상 90,000ms+)
```

### **Ubuntu 24 (JPEG 사용)**
```
테스트 일자: 2025-10-24 (예정)
환경: 32코어, 192GB RAM
포맷: JPEG Q=100
예상: 9,000ms (평균 30ms/개)
```

---

## 🔧 문제 해결

### **SAML 로그인 오류**
```
ERROR: python3-saml 미설치
```
**해결:**
```bash
pip3 install python3-saml
```

### **썸네일 생성 느림**
```
평균 300ms 이상 소요
```
**확인:**
```bash
# start.sh에서 포맷 확인
cat start.sh | grep THUMBNAIL_FORMAT
# 결과: export THUMBNAIL_FORMAT="JPEG"  (PNG가 아닌지 확인)
```

### **TurboJPEG 오류**
```
ERROR: unable to load turbojpeg library
```
**해결:**
```bash
# 1. 설치
sudo apt install libturbojpeg0-dev

# 2. 경로 확인
ldconfig -p | grep turbojpeg

# 3. start.sh 수정
export TURBOJPEG_PATH="/usr/lib/x86_64-linux-gnu/libturbojpeg.so.0"
```

---

## 📞 지원

문제 발생 시:
1. `scripts/ubuntu_setup.sh` 실행
2. `scripts/thumbnail_performance_test.py` 실행
3. 결과를 GitHub Issue에 첨부

---

**마지막 업데이트**: 2025-10-24
**버전**: 1.0

