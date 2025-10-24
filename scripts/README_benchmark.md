# TurboJPEG vs pyvips 벤치마크 스크립트

## 📋 개요

실제 그리드 썸네일 생성 방식으로 TurboJPEG와 pyvips의 성능을 비교하는 스크립트입니다.

---

## 🚀 사용법

### **기본 사용**
```bash
python scripts/turbojpeg_vs_pyvips_benchmark.py <폴더경로>
```

### **옵션**
```bash
python scripts/turbojpeg_vs_pyvips_benchmark.py <폴더경로> \
  --limit 300 \           # 테스트할 이미지 개수 (기본: 300)
  --output _bench_out \   # 출력 폴더 (기본: _bench_turbo_vs_pyvips)
  --workers 16            # 병렬 워커 수 (기본: 16)
```

---

## 📊 예제

### **Windows**
```powershell
# wafer 폴더의 300개 이미지 테스트
python scripts/turbojpeg_vs_pyvips_benchmark.py wafer

# 100개만 테스트
python scripts/turbojpeg_vs_pyvips_benchmark.py wafer --limit 100

# 32 워커로 테스트
python scripts/turbojpeg_vs_pyvips_benchmark.py wafer --workers 32
```

### **Ubuntu**
```bash
# 300개 이미지 테스트
python3 scripts/turbojpeg_vs_pyvips_benchmark.py /path/to/images

# 출력 폴더 변경
python3 scripts/turbojpeg_vs_pyvips_benchmark.py /path/to/images --output /tmp/bench
```

---

## 🧪 테스트 조건

스크립트는 다음 조건들을 자동으로 테스트합니다:

### **TurboJPEG**
1. **TurboJPEG_Q100_420_FASTDCT**
   - Quality: 100
   - Subsample: 4:2:0
   - Flags: FASTDCT

2. **TurboJPEG_Q100_420_NoFlags**
   - Quality: 100
   - Subsample: 4:2:0
   - Flags: None

### **pyvips**
1. **pyvips_Q100_subsample1**
   - Quality: 100
   - Subsample: 1 (4:2:0)
   - optimize_coding: False

2. **pyvips_Q100_subsample1_opt**
   - Quality: 100
   - Subsample: 1 (4:2:0)
   - optimize_coding: True ← 파일 크기 작음

3. **pyvips_Q100_subsample2**
   - Quality: 100
   - Subsample: 2 (4:2:2)
   - optimize_coding: False

---

## 📈 결과 예시

```
================================================================================
SUMMARY RESULTS (300 images, 512x512, cubic)
================================================================================
Method                              Total      Avg        Size       Throughput     
--------------------------------------------------------------------------------
TurboJPEG_Q100_420_NoFlags             12490ms   561.35ms    202.1KB          24.0/s
pyvips_Q100_subsample2                 12558ms   618.04ms    341.5KB          23.9/s
pyvips_Q100_subsample1                 12646ms   599.84ms    202.1KB          23.7/s
pyvips_Q100_subsample1_opt             12672ms   604.81ms    185.2KB          23.7/s
TurboJPEG_Q100_420_FASTDCT             13074ms   601.37ms    202.1KB          22.9/s
================================================================================

FASTEST: TurboJPEG_Q100_420_NoFlags
  Total Time: 12490ms
  Avg Time:   561.35ms
  Throughput: 24.0 images/sec
  Images:     300
```

---

## 🔍 결과 해석

### **Total Time**
- 300개 이미지를 모두 처리하는데 걸린 시간
- **가장 중요한 지표** (실제 성능)

### **Avg Time**
- 이미지당 평균 처리 시간
- 병렬 처리 오버헤드 포함

### **Size**
- 생성된 JPEG 파일의 평균 크기
- 작을수록 저장 공간 절약

### **Throughput**
- 초당 처리 가능한 이미지 개수
- 높을수록 빠름

---

## ⚙️ 그리드 썸네일 방식

스크립트는 실제 `api/main.py`의 그리드 썸네일 생성 로직과 동일하게 작동합니다:

### **1. 이미지 로드**
```python
vips_image = pyvips.Image.new_from_file(
    str(input_path),
    access='sequential',
    fail_on='none',
    memory=True,
    unlimited=True
)
```

### **2. 최적화된 리사이즈**
```python
# shrink + resize 조합
if scale < 0.5:
    shrink_factor = max(int(1.0 / scale) + 1, 1)
else:
    shrink_factor = int(1.0 / scale)

if shrink_factor > 1:
    vips_image = vips_image.shrink(shrink_factor, shrink_factor)
    scale = target_w / vips_image.width

vips_image = vips_image.resize(scale, vscale=scale, kernel='cubic')
```

### **3. JPEG 저장**
- **TurboJPEG**: pyvips → numpy → TurboJPEG encode
- **pyvips**: 직접 jpegsave

---

## 📝 요구사항

### **필수**
- Python 3.7+
- pyvips
- numpy (TurboJPEG 사용 시)

### **선택**
- TurboJPEG (없으면 pyvips만 테스트)

---

## 🐛 문제 해결

### **TurboJPEG not available**
```bash
# Windows
# C:\libjpeg-turbo64\bin\turbojpeg.dll 설치 필요

# Ubuntu
sudo apt install libturbojpeg0-dev
pip3 install PyTurboJPEG
```

### **No images found**
- 폴더 경로가 올바른지 확인
- 지원 포맷: .png, .jpg, .jpeg, .bmp, .tif, .tiff, .webp

### **Memory error**
- `--workers` 값을 줄이세요 (예: 8 또는 4)

---

## 📌 주의사항

1. **실제 성능은 환경에 따라 다를 수 있습니다**
   - CPU 코어 수
   - RAM 크기
   - 디스크 속도
   - 이미지 크기/복잡도

2. **첫 실행은 캐시 워밍업으로 느릴 수 있습니다**
   - 2번째 실행부터 정확한 성능 측정

3. **출력 폴더는 자동으로 삭제됩니다**
   - 기존 결과를 보관하려면 `--output` 옵션 사용

---

**마지막 업데이트**: 2025-10-24  
**버전**: 2.0

