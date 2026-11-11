@echo off
title VideoGen - Enable NVIDIA GPU Acceleration (CUDA)
echo ======================================================================
echo VideoGen: Enabling NVIDIA GPU CUDA Acceleration for VoxCPM 2
echo ======================================================================
echo.
cd /d "%~dp0\.."

if not exist ".venv-voxcpm\Scripts\pip.exe" (
    echo [ERROR] Virtual environment .venv-voxcpm was not found.
    echo Please make sure .venv-voxcpm exists in %CD%.
    pause
    exit /b 1
)

echo Checking GPU via nvidia-smi...
nvidia-smi
echo.
echo Installing PyTorch with CUDA 12.4 for your NVIDIA GPU...
echo This will replace the CPU build with the high-performance CUDA build.
echo.
.venv-voxcpm\Scripts\pip.exe install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124

echo.
echo ======================================================================
echo Testing CUDA in .venv-voxcpm...
.venv-voxcpm\Scripts\python.exe -c "import torch; print('PyTorch:', torch.__version__); print('CUDA Available:', torch.cuda.is_available()); print('Active GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None (CPU)')"
echo ======================================================================
echo.
echo Done! Please restart VideoGen (or click 'Restart Server' in Settings).
pause

