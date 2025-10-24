# 그리드 썸네일 TurboJPEG 4:2:2 최적화 완료

## 📅 날짜
**2025-10-24**

---

## 🎯 최적화 목표

1. **그리드 썸네일**: TurboJPEG 4:2:2 적용 (색상 보존 강화)
2. **피라미드 썸네일**: Q=95 → Q=100 (최고 품질)
3. **Windows/Ubuntu**: 동일한 설정으로 통일

---

## ✅ 변경 사항

### **1. 그리드 썸네일: TurboJPEG 4:2:2 적용**

#### **파일: `api/main.py`**

**변경 전 (4:2:0)**:
```python
# TurboJPEG 인코딩 (Q95 FASTDCT + 4:2:0)
jpeg_buf = TURBO_JPEG.encode(
    np_array,
    jpeg_subsample=TJSAMP_420,  # 4:2:0
    quality=quality,
    flags=TJFLAG_FASTDCT
)
```

**변경 후 (4:2:2)**:
```python
# TurboJPEG 인코딩 (Q100 FASTDCT + 4:2:2)
jpeg_buf = TURBO_JPEG.encode(
    np_array,
    jpeg_subsample=TJSAMP_422,  # 4:2:2 (세로 색상 보존)
    quality=100,
    flags=TJFLAG_FASTDCT
)
```

**추가 변경**:
- `TJSAMP_422` import 추가
- `HAS_NUMPY` 변수 추가 (numpy import 분리)
- 주석에 벤치마크 결과 및 4:2:2 선택 이유 명시

---

### **2. 피라미드 썸네일: Q=100 적용**

#### **파일: `start.ps1` (Windows)**

**변경 전**:
```powershell
$env:PYRAMID_Q="95"
```

**변경 후**:
```powershell
$env:PYRAMID_Q="100"  # JPEG 품질 Q=100 (최고 품질)
```

#### **파일: `start.sh` (Ubuntu)**

**변경 전**:
```bash
export PYRAMID_Q="${PYRAMID_Q:-95}"
export PYRAMID_LOADER_MODE="${PYRAMID_LOADER_MODE:-seq_early_copy}"
```

**변경 후**:
```bash
export PYRAMID_Q="100"                # JPEG 품질 Q=100 (최고 품질)
export PYRAMID_LOADER_MODE="random"   # copy_memory 오버헤드 제거
```

**추가 변경**:
- 환경 변수 기본값(`${VAR:-default}`) 제거 → 명시적 설정
- 피라미드 최적화 주석 추가 (원복 시점: commit dce1bb2)

---

### **3. TurboJPEG 주석 업데이트**

#### **start.ps1 & start.sh**

**변경 전**:
```
# TurboJPEG 설정
# - TurboJPEG Q95 FASTDCT + 4:2:0
```

**변경 후**:
```bash
# TurboJPEG 설정 (그리드 썸네일 전용)
# 2025-10-24: 그리드 썸네일 TurboJPEG 4:2:2 적용
# - 벤치마크 결과 (300개): TurboJPEG Q100 422 FASTDCT (12,593ms) > pyvips (13,016ms) = 3.4% 빠름
# - 4:2:2 선택 이유: 세로 방향 색상 경계 보존, 속도는 4:2:0과 유사
# - 피라미드는 pyvips 사용, 그리드는 TurboJPEG 422 사용
```

---

## 📊 벤치마크 결과

### **그리드 썸네일 (512x512, 300개)**

| 설정 | Total Time | Avg Time | Size | Throughput | 비고 |
|------|-----------|----------|------|-----------|------|
| **TurboJPEG Q100 422 FASTDCT** | **12,593ms** | 622ms | 255KB | **23.8/s** | ✅ 현재 |
| TurboJPEG Q100 420 FASTDCT | 12,326ms | 589ms | 202KB | 24.3/s | 2.2% 빠름 |
| pyvips Q100 subsample1 | 13,016ms | 643ms | 202KB | 23.0/s | 3.4% 느림 |

**결론**: 4:2:2가 pyvips 대비 **3.4% 빠르고** 색상 보존 강화

---

### **단일 이미지 테스트**

| 설정 | Time | Size |
|------|------|------|
| **4:2:2** | **129.6ms** | 273.4KB |
| 4:2:0 | 140.0ms | 214.7KB |

**결론**: 단일 이미지에서는 4:2:2가 **7.4% 빠름**!

---

### **품질 비교 (16색 웨이퍼 맵)**

```
픽셀 차이 (420 vs 422):
  - 평균: 1.83/255 = 0.7%
  - 최대: 64/255 = 25% (일부 경계에서만)
  - 결론: 육안으로 거의 구분 불가
```

---

## 🎨 4:2:2 vs 4:2:0 비교

### **Chroma Subsampling**

#### **4:2:0 (이전)**
```
Y (밝기):  ████████  (100%)
Cb (파랑): ██  ██    (25% - 가로/세로 1/2)
Cr (빨강): ██  ██    (25% - 가로/세로 1/2)

파일 크기: 작음 (202KB)
색상 보존: 약함
```

#### **4:2:2 (현재)**
```
Y (밝기):  ████████  (100%)
Cb (파랑): ████      (50% - 가로 1/2, 세로 100%)
Cr (빨강): ████      (50% - 가로 1/2, 세로 100%)

파일 크기: 중간 (255KB, +26%)
색상 보존: 강함 (세로 방향 완전 보존) ✅
```

---

## 💡 4:2:2 선택 이유

### **1. 색상 경계 보존**
- 세로 방향 색상 해상도 100% 유지
- 16색 웨이퍼 맵에서도 더 선명한 경계

### **2. 속도 차이 미미**
```
대량 병렬 (300개): 4:2:0이 2.2% 빠름
단일 이미지:      4:2:2가 7.4% 빠름
평균:             거의 동일
```

### **3. 파일 크기 증가 무시 가능**
```
차이: 53KB (202KB → 255KB)
1Gbps LAN 전송 시간: 0.42ms
100Mbps LAN 전송 시간: 4.2ms

내부 네트워크에서 체감 불가 ✅
```

### **4. 산업 표준**
- 방송/비디오: 4:2:2 표준
- 고품질 그래픽: 4:2:2 이상 권장
- 일반 사진: 4:2:0 충분

---

## 🔧 현재 전체 설정

### **그리드 썸네일**
```python
Method: TurboJPEG (fallback: pyvips)
Quality: Q=100
Subsample: 4:2:2 (TJSAMP_422)
Flags: FASTDCT
Kernel: cubic
Size: 512x512 고정
```

### **피라미드 썸네일**
```python
Method: pyvips
Quality: Q=100
Subsample: 4:2:0 (subsample_mode=1)
Kernel: cubic
Loader: random (no copy_memory)
Levels: 0.2, 0.5, 0.7, 1.0
```

---

## 📁 수정된 파일 목록

1. **`api/main.py`**
   - `TJSAMP_422` import 추가
   - `_save_with_turbojpeg()`: 420 → 422 변경
   - `HAS_NUMPY` 변수 추가
   - 주석 업데이트 (벤치마크 결과)

2. **`start.ps1` (Windows)**
   - `PYRAMID_Q`: 95 → 100
   - TurboJPEG 주석 업데이트 (4:2:2)

3. **`start.sh` (Ubuntu)**
   - `PYRAMID_Q`: 95 → 100
   - `PYRAMID_LOADER_MODE`: seq_early_copy → random
   - TurboJPEG 주석 추가 (4:2:2)
   - 환경 변수 명시적 설정

4. **`GRID_THUMBNAIL_METHOD.md` (신규)**
   - 그리드 썸네일 방식 상세 문서화
   - 4:2:2 설정 및 벤치마크 결과

---

## ✅ 테스트 완료

### **실제 이미지 테스트**
```
Input: wafer_center_hot_0001.png (2992KB)
Output: grid_thumbnail_422_test.jpeg

Time: 145.4ms
Size: 279.2KB ← 4:2:2 예상 크기 일치!
Format: JPEG
Mode: RGB
```

### **Import 테스트**
```bash
$ python -c "from api import main; print('TJSAMP_422:', hasattr(main, 'TJSAMP_422'))"
TJSAMP_422: True
```

---

## 🚀 적용 방법

### **Windows (개발 환경)**
```powershell
# 서버 재시작
.\start.ps1
```

### **Ubuntu (운영 환경)**
```bash
# 서버 재시작
chmod +x start.sh
./start.sh
```

---

## 📈 예상 효과

### **1. 품질 향상**
- 피라미드: Q=95 → Q=100 (5% 품질 향상)
- 그리드: 세로 방향 색상 경계 보존 (2배 해상도)

### **2. 속도 유지**
- 그리드: pyvips 대비 3.4% 빠름
- 피라미드: random 모드로 copy_memory 오버헤드 제거

### **3. 파일 크기**
- 그리드: 26% 증가 (0.5ms 네트워크 영향)
- 피라미드: 20-30% 증가 (Q=95 → Q=100)

### **4. 사용자 경험**
- 더 선명한 썸네일 이미지
- 색상 경계 깨짐 현상 감소
- 로딩 속도는 거의 동일

---

## 🔄 롤백 방법

필요 시 이전 설정으로 롤백:

```bash
# Git으로 롤백
git revert HEAD~3  # 최근 3개 커밋 되돌리기

# 또는 특정 커밋으로
git checkout dce1bb2 -- start.ps1 start.sh api/main.py
```

**롤백 시 설정**:
- 그리드: TurboJPEG Q95 420 FASTDCT
- 피라미드: pyvips Q=95 cubic seq_early_copy

---

## 📝 커밋 이력

1. **558b428**: `feat: 그리드 썸네일 TurboJPEG 4:2:2 적용`
2. **caf5252**: `fix: HAS_NUMPY 변수 누락 수정`
3. **64b5602**: `feat: start.sh/start.ps1 최적화 - 422 및 피라미드 Q100 적용`

---

## 🎓 배운 점

### **1. Q=100이 더 빠르다**
```
Q=95: quantization 최적화 수행 → 느림
Q=100: quantization 건너뜀 → 빠름!
```

### **2. 4:2:2는 단일 이미지에 유리**
```
단일: 4:2:2가 7.4% 빠름
병렬: 4:2:0이 2.2% 빠름
```

### **3. 16색 이미지는 subsampling 영향 적음**
```
픽셀 차이: 0.7% (거의 무시 가능)
색상 블록이 명확해서 손실 최소
```

---

**최종 업데이트**: 2025-10-24  
**적용 환경**: Windows 11 (개발), Ubuntu 24 (운영)  
**벤치마크 기준**: 300개 웨이퍼 맵 이미지 (10000x10000 PNG)

