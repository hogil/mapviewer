# libvips 설치 가이드 (Ubuntu 24)

pyvips는 libvips 기반으로 Pillow보다 **10-100배 빠릅니다**.

## 설치 방법

### 1. libvips 설치
```bash
sudo apt-get update
sudo apt-get install -y libvips libvips-dev
```

### 2. Python 패키지 설치
```bash
pip install pyvips
```

### 3. 설치 확인
```bash
python3 -c "import pyvips; print(pyvips.version(0))"
```

출력 예시:
```
8.15.0
```

## 성능 비교

### Pillow (일반)
- 썸네일 생성: ~100ms/이미지
- 1000개 이미지: ~100초
- 메모리: ~500MB

### pyvips (libvips)
- 썸네일 생성: ~5ms/이미지
- 1000개 이미지: ~5초
- 메모리: ~50MB

**20배 빠른 성능 + 10배 적은 메모리!**

## Ubuntu 24, 32코어 환경 최적화

### 환경변수 설정
```bash
# start.sh에 추가
export VIPS_CONCURRENCY=32
export VIPS_DISC_THRESHOLD=1000m
```

### start.sh 업데이트
```bash
# libvips 최적화
export VIPS_CONCURRENCY=32              # 32코어 활용
export VIPS_DISC_THRESHOLD=1000m        # 1GB 임계값
export VIPS_MAX_CACHE=1000              # 최대 캐시 1000개
```

## 문제 해결

### libvips 설치 오류
```bash
# Ubuntu 24 패키지 업데이트
sudo apt-get update
sudo apt-get install -y software-properties-common
sudo add-apt-repository universe
sudo apt-get update
sudo apt-get install -y libvips libvips-dev
```

### pyvips 설치 오류
```bash
# 의존성 설치
sudo apt-get install -y python3-dev python3-pip
pip install --upgrade pip
pip install pyvips
```

## 참고

- pyvips는 libvips 기반으로 매우 빠릅니다
- Ubuntu 24, 32코어 환경에서 최적 성능
- Pillow 폴백 지원 (pyvips 없을 때 자동 전환)

