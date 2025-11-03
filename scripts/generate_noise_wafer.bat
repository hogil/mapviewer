@echo off
REM Wafer 이미지 생성 스크립트 실행 (Conda 환경 활성화 포함)
REM CUDA 사용을 위해 conda 환경 활성화

echo ========================================
echo Wafer 이미지 생성 스크립트
echo PyTorch + CUDA 지원 버전
echo ========================================
echo.

REM Conda 환경 활성화 (PyTorch + CUDA 설치된 환경)
REM 예: conda activate pytorch, conda activate base 등
REM 필수: PyTorch with CUDA 설치 필요 (conda install pytorch torchvision torchaudio pytorch-cuda -c pytorch -c nvidia)
if exist "%CONDA_PREFIX%\Scripts\activate.bat" (
    call "%CONDA_PREFIX%\Scripts\activate.bat"
    echo [INFO] Conda 환경 활성화됨
) else (
    REM 직접 conda activate 시도
    call conda activate base 2>nul
    if errorlevel 1 (
        echo [WARN] Conda 환경 자동 활성화 실패
        echo [INFO] 수동으로 conda activate를 실행한 후 스크립트를 실행하세요
    )
)

echo.
echo [INFO] Python 실행 중...
echo.

REM Python 스크립트 실행
python scripts/generate_noise_wafer.py

pause

