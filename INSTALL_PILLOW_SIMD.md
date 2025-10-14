# Pillow-SIMD 설치 가이드 (Ubuntu 24)

Pillow-SIMD는 SIMD 명령어를 사용하여 Pillow보다 **10-100배 빠릅니다**.

## 설치 방법

### 1. 기존 Pillow 제거
```bash
pip uninstall Pillow -y
```

### 2. Pillow-SIMD 설치
```bash
pip install Pillow-SIMD
```

### 3. 설치 확인
```bash
python3 -c "from PIL import Image; print(Image.__version__)"
```

출력 예시:
```
10.0.0.post1
```

## 성능 비교

### Pillow (일반)
- 썸네일 생성: ~100ms/이미지
- 1000개 이미지: ~100초

### Pillow-SIMD (최적화)
- 썸네일 생성: ~10ms/이미지
- 1000개 이미지: ~10초

**10배 빠른 성능!**

## 추가 최적화

### Ubuntu 24, 32코어 환경
```bash
# 환경변수 설정
export OMP_NUM_THREADS=32
export OPENBLAS_NUM_THREADS=32
export MKL_NUM_THREADS=32
```

### start.sh에 추가
```bash
export OMP_NUM_THREADS=32
export OPENBLAS_NUM_THREADS=32
export MKL_NUM_THREADS=32
```

## 문제 해결

### libjpeg 오류
```bash
sudo apt-get install libjpeg-dev libopenjp2-7-dev libtiff-dev
```

### libwebp 오류
```bash
sudo apt-get install libwebp-dev
```

## 참고

- Pillow-SIMD는 Pillow의 드롭인 대체제입니다
- 기존 코드 수정 불필요
- Ubuntu 24, 32코어 환경에서 최적 성능

