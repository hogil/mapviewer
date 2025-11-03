#!/bin/bash
# Wafer 이미지 생성 스크립트 실행 (Conda 환경 활성화 포함)
# CUDA 사용을 위해 conda 환경 활성화

echo "========================================"
echo "Wafer 이미지 생성 스크립트"
echo "PyTorch + CUDA 지원 버전"
echo "========================================"
echo ""

# Conda 환경 활성화 (PyTorch + CUDA 설치된 환경)
# 예: conda activate pytorch, conda activate base 등
# 필수: PyTorch with CUDA 설치 필요 (conda install pytorch torchvision torchaudio pytorch-cuda -c pytorch -c nvidia)
if [ -n "$CONDA_PREFIX" ]; then
    echo "[INFO] Conda 환경이 이미 활성화되어 있습니다: $CONDA_PREFIX"
else
    # Conda 초기화 (필요한 경우)
    if [ -f "$HOME/anaconda3/etc/profile.d/conda.sh" ]; then
        source "$HOME/anaconda3/etc/profile.d/conda.sh"
    elif [ -f "$HOME/miniconda3/etc/profile.d/conda.sh" ]; then
        source "$HOME/miniconda3/etc/profile.d/conda.sh"
    fi
    
    # 기본 conda 환경 활성화 시도
    conda activate base 2>/dev/null || {
        echo "[WARN] Conda 환경 자동 활성화 실패"
        echo "[INFO] 수동으로 'conda activate <환경명>'을 실행한 후 스크립트를 실행하세요"
    }
fi

echo ""
echo "[INFO] Python 실행 중..."
echo ""

# Python 스크립트 실행
python scripts/generate_noise_wafer.py

