#!/bin/bash
# Ubuntu 24 환경 설정 스크립트
# Windows 11과 동일한 성능을 위한 패키지 설치 및 설정

echo "==================================================================="
echo "Ubuntu 24 환경 설정 시작"
echo "==================================================================="

# 1. Python SAML 라이브러리 설치
echo ""
echo "[1/5] Python SAML 라이브러리 설치..."

# 시스템 패키지 먼저 설치 (python3-saml 의존성)
echo "  - 시스템 패키지 설치 (libxml2, libxslt)..."
sudo apt update
sudo apt install -y libxml2-dev libxslt1-dev python3-dev pkg-config

# python3-saml 설치
echo "  - python3-saml 설치..."
pip3 install python3-saml

# 설치 확인
echo "  - 설치 확인..."
python3 -c "from onelogin.saml2.auth import OneLogin_Saml2_Auth; print('    ✓ python3-saml 정상 설치')" 2>/dev/null || echo "    ✗ python3-saml 설치 실패!"

# 2. libvips 최신 버전 확인
echo ""
echo "[2/5] libvips 버전 확인..."
vips --version
if [ $? -ne 0 ]; then
    echo "ERROR: libvips가 설치되지 않았습니다!"
    echo "설치 방법: sudo apt install libvips42 libvips-dev libvips-tools"
    exit 1
fi

# 3. TurboJPEG 설치 확인
echo ""
echo "[3/5] TurboJPEG 라이브러리 확인..."
ldconfig -p | grep turbojpeg
if [ $? -ne 0 ]; then
    echo "WARNING: TurboJPEG가 설치되지 않았습니다!"
    echo "설치 방법: sudo apt install libturbojpeg0-dev"
    echo "설치 후 start.sh의 TURBOJPEG_PATH 확인 필요"
else
    TURBO_PATH=$(ldconfig -p | grep turbojpeg | awk '{print $NF}' | head -1)
    echo "TurboJPEG 경로: $TURBO_PATH"
    echo "start.sh의 TURBOJPEG_PATH를 다음으로 설정하세요:"
    echo "  export TURBOJPEG_PATH=\"$TURBO_PATH\""
fi

# 4. Python 패키지 설치
echo ""
echo "[4/5] Python 패키지 설치..."
pip3 install -r requirements.txt

# 5. 환경 설정 비교
echo ""
echo "[5/5] 환경 설정 비교 (Windows 11 vs Ubuntu 24)"
echo "==================================================================="
echo ""
echo "현재 Ubuntu 24 설정 (start.sh):"
echo "  - THUMBNAIL_FORMAT: JPEG"
echo "  - THUMBNAIL_QUALITY: 100"
echo "  - THUMBNAIL_SEM: 512"
echo "  - VIPS_CONCURRENCY: 24"
echo "  - IO_THREADS: 256"
echo "  - WORKERS: 28"
echo ""
echo "Windows 11 설정 (start.ps1):"
echo "  - THUMBNAIL_FORMAT: JPEG"
echo "  - THUMBNAIL_QUALITY: 100"
echo "  - THUMBNAIL_SEM: 32"
echo "  - VIPS_CONCURRENCY: 12"
echo "  - IO_THREADS: 40"
echo "  - WORKERS: N/A (uvicorn 기본값)"
echo ""
echo "==================================================================="
echo "설치 완료!"
echo ""
echo "다음 단계:"
echo "  1. chmod +x scripts/thumbnail_performance_test.py"
echo "  2. chmod +x start.sh"
echo "  3. ./start.sh"
echo "  4. 성능 테스트: python3 scripts/thumbnail_performance_test.py"
echo "==================================================================="

