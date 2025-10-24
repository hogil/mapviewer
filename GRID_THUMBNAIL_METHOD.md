# 현재 그리드 썸네일 생성 방식

## 📋 개요

**위치**: `api/main.py` → `_generate_thumbnail_sync()` 함수 (Line 1401-1540)

---

## 🔧 전체 프로세스

### **1️⃣ 이미지 로드**
```python
vips_image = pyvips.Image.new_from_file(
    str(image_path),
    access='sequential',      # 순차 접근 (스트리밍)
    fail_on='none',          # 오류 무시하고 계속
    memory=True,             # libvips 내부 캐시 활성화
    unlimited=True           # 하드웨어 가속 (SIMD, 멀티코어)
)
```

**최적화 포인트**:
- `memory=True`: 반복 접근 시 캐시 효과
- `unlimited=True`: CPU 하드웨어 가속 활성화

---

### **2️⃣ 리사이즈 로직 (공격적 최적화)**

#### **Case 1: 이미지가 이미 작은 경우**
```python
if vips_image.width <= target_w and vips_image.height <= target_h:
    # 리사이즈 없이 그대로 저장
    _write(vips_image)
```

#### **Case 2: 큰 축소가 필요한 경우 (scale < 0.5)**
```python
# 예: 10000x10000 → 512x512 (scale = 0.0512)

# Step 1: shrink (정수 배율 축소, 하드웨어 가속)
shrink_factor = int(1.0 / scale) + 1  # = 20
resized = vips_image.shrink(20, 20)   # 10000 → 500 (매우 빠름!)

# Step 2: resize (나머지 조정, cubic 커널)
remaining_scale = 0.0512 * 20 = 1.024
resized = resized.resize(1.024, vscale=1.024, kernel='cubic')  # 500 → 512
```

**왜 이렇게 하나?**
- `shrink`: 정수 배율 축소, 단순 평균, **HW 가속으로 매우 빠름**
- `resize`: 고품질 cubic 커널, 느림
- **조합 효과**: 대부분의 축소를 빠른 shrink로, 마무리만 고품질 resize로

#### **Case 3: 작은 축소 (scale >= 0.5)**
```python
# 예: 1000x1000 → 512x512 (scale = 0.512)
resized = vips_image.resize(0.512, vscale=0.512, kernel='cubic')
```

---

### **3️⃣ JPEG 저장 (TurboJPEG 우선, pyvips 폴백)**

#### **방법 1: TurboJPEG (우선 시도)**
```python
saved_with_turbo = _save_with_turbojpeg(vips_obj, thumbnail_path, THUMBNAIL_QUALITY)
```

**프로세스**:
```
pyvips 이미지
  ↓ write_to_memory()
numpy 배열
  ↓ TurboJPEG.encode()
JPEG 파일

파라미터:
  - quality: 100
  - subsample: 4:2:2 (TJSAMP_422) ← 세로 방향 색상 보존
  - flags: FASTDCT
```

#### **방법 2: pyvips (폴백)**
```python
vips_obj.jpegsave(
    thumbnail_path,
    Q=100,                    # 최고 품질
    strip=True,               # 메타데이터 제거
    optimize_coding=False,    # 속도 우선
    subsample_mode=1,         # 4:2:0
    interlace=False,          # 인터레이스 비활성화
    trellis_quant=False,      # 트렐리스 양자화 비활성화
    quant_table=0,            # 기본 양자화 테이블
    background=255            # 배경색
)
```

---

## ⚙️ 현재 설정 (start.ps1)

```powershell
$env:THUMBNAIL_FORMAT="JPEG"        # 포맷
$env:THUMBNAIL_QUALITY="100"        # Q=100 (최고 품질)
$env:THUMBNAIL_SIZE="512"           # 512x512

# TurboJPEG
$env:USE_TURBOJPEG="1"              # 활성화
$env:TURBOJPEG_PATH="C:\libjpeg-turbo64\bin\turbojpeg.dll"

# 병렬 처리
$env:THUMBNAIL_SEM="32"             # 동시 썸네일 생성 수
$env:IO_THREADS="40"                # I/O 스레드
$env:VIPS_CONCURRENCY="12"          # pyvips 워커 수
```

---

## 📊 성능 특성

### **벤치마크 결과 (300개 이미지)**

| 방법 | Total Time | Avg Time | Size | Throughput |
|------|------------|----------|------|------------|
| **TurboJPEG Q100 422 FASTDCT** | **12,593ms** | 622ms | 255KB | **23.8/s** |
| TurboJPEG Q100 420 FASTDCT | 12,326ms | 589ms | 202KB | 24.3/s |
| pyvips Q100 subsample1 | 13,016ms | 643ms | 202KB | 23.0/s |

**현재 설정 (422)**: pyvips 대비 3.4% 빠름, 세로 색상 경계 보존!

---

## 🔍 코드 흐름도

```
이미지 파일
  ↓
[1] pyvips.new_from_file()
  - memory=True (캐시)
  - unlimited=True (HW 가속)
  ↓
[2] 크기 확인
  ├─ 작음 → 그대로 저장
  └─ 큼 → 리사이즈 필요
      ├─ scale < 0.5
      │   ├─ shrink(정수배) ← 매우 빠름
      │   └─ resize(cubic) ← 고품질
      └─ scale >= 0.5
          └─ resize(cubic) ← 한번에
  ↓
[3] JPEG 저장
  ├─ TurboJPEG 시도
  │   ├─ write_to_memory()
  │   ├─ numpy 변환
  │   ├─ TurboJPEG.encode(Q=100, 4:2:2, FASTDCT)
  │   └─ 성공 → 완료
  └─ 실패 시
      └─ pyvips.jpegsave(Q=100, subsample=1, optimize=False)
  ↓
썸네일 파일 (512x512, JPEG Q=100)
```

---

## 💡 최적화 포인트

### **1. 하드웨어 가속**
- `memory=True`: 캐시 활용
- `unlimited=True`: SIMD, 멀티코어 사용
- `shrink()`: 정수 배율 축소, CPU 가속

### **2. 공격적 shrink + resize**
```
기존: resize(0.0512) → 느림
현재: shrink(20) + resize(1.024) → 빠름!

이유:
  - shrink(20): 10000→500 (단순 평균, 매우 빠름)
  - resize(1.024): 500→512 (cubic, 작은 범위라 빠름)
```

### **3. TurboJPEG 우선 사용 (4:2:2)**
```
TurboJPEG Q100 422: 12,593ms ← 현재 설정
TurboJPEG Q100 420: 12,326ms (2.2% 빠르지만 색상 보존 약함)
pyvips:             13,016ms (+3.4%)

4:2:2 선택 이유:
  - 세로 방향 색상 경계 보존
  - 속도는 420과 유사 (단일: 오히려 빠름)
  - 파일 크기 증가(26%)는 내부 LAN에서 무시 가능
```

### **4. JPEG 파라미터 최적화**
```
Q=100: 최고 품질 (quantization 최적화 건너뛰어 더 빠름!)
subsample=1 (4:2:0): 가장 빠르고 작은 파일
optimize_coding=False: 속도 우선
trellis_quant=False: 5.7% 빠름
```

---

## 🚀 성능 개선 이력

### **2025-10-23 최적화**

**이전**:
```python
# 단순 resize
resized = image.resize(scale, kernel='cubic')
```

**현재**:
```python
# 공격적 shrink + resize
if scale < 0.5:
    shrink_factor = int(1.0 / scale) + 1
    resized = image.shrink(shrink_factor, shrink_factor)
    resized = resized.resize(remaining_scale, kernel='cubic')
```

**효과**:
- 10000x10000 → 512x512 변환 시 **대폭 개선**
- HW 가속 shrink 활용

---

## ⚠️ 주의사항

### **1. TurboJPEG 의존성**
```python
if not TURBO_JPEG or not HAS_NUMPY:
    return False  # pyvips 폴백
```

- TurboJPEG 없어도 작동 (pyvips 폴백)
- numpy 필요

### **2. 메모리 사용**
```python
memory=True  # 캐시 활성화
```

- 메모리 사용량 증가
- 반복 접근 시 성능 향상

### **3. 병렬 처리**
```python
THUMBNAIL_SEM = 32  # 동시 생성 수
```

- 메모리 충분해야 함
- CPU 코어 수에 맞춰 조정

---

## 📈 비교: 피라미드 vs 그리드

| 항목 | 그리드 썸네일 | 피라미드 썸네일 |
|------|--------------|----------------|
| **크기** | 512x512 고정 | 원본 비율 유지 |
| **Quality** | Q=100 | Q=100 |
| **커널** | cubic | cubic |
| **최적화** | shrink + resize | shrink + resize |
| **TurboJPEG** | ✅ 우선 사용 | ❌ 미사용 |
| **속도** | 12,326ms (300개) | 더 느림 (큰 파일) |

---

## 🔧 문제 해결

### **이미지가 안 보이는 경우**

1. **서버 확인**
   ```powershell
   # 프로세스 확인
   Get-Process | Where-Object {$_.ProcessName -like "*python*"}
   
   # 포트 확인
   netstat -ano | findstr "8080"
   ```

2. **TurboJPEG 확인**
   ```python
   python -c "from api import main; print('OK')"
   # [main.py] TurboJPEG ... 초기화 완료
   ```

3. **로그 확인**
   ```powershell
   # 서버 로그에서 썸네일 생성 오류 찾기
   # "썸네일 생성 중 오류" 메시지 확인
   ```

4. **브라우저 콘솔**
   ```javascript
   // F12 → Console 탭
   // 빨간색 오류 메시지 확인
   ```

---

**마지막 업데이트**: 2025-10-24  
**코드 위치**: `api/main.py` Line 1401-1540  
**최적화 기준**: commit dce1bb2 (2025-10-23)

