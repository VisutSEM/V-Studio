<#
.SYNOPSIS
    Packages VideoGen into a clean, distributable folder ready to share with others.
.PARAMETER IncludeModels
    If specified, copies local pre-downloaded model weights (tools/models/VoxCPM2) for 100% offline use.
#>
param(
    [switch]$IncludeModels
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
$OutputDir = Join-Path $ProjectRoot "dist-package\VideoGen"
$ExeSource = Join-Path $ProjectRoot "src-tauri\target\release\videogen.exe"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " VideoGen Distribution Packager" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path $ExeSource)) {
    Write-Host "Release binary not found. Building release binary now..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    npm run tauri build -- --no-bundle
    Pop-Location
}

if (-not (Test-Path $ExeSource)) {
    Write-Error "Failed to locate release binary at $ExeSource"
    exit 1
}

Write-Host "`n1. Creating clean output directory at: $OutputDir" -ForegroundColor Green
if (Test-Path $OutputDir) {
    Remove-Item -Recurse -Force $OutputDir
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OutputDir "tools") -Force | Out-Null

Write-Host "2. Copying VideoGen application files..." -ForegroundColor Green
Copy-Item $ExeSource (Join-Path $OutputDir "videogen.exe") -Force
Write-Host "   - videogen.exe"

if (Test-Path (Join-Path $ProjectRoot "ffmpeg.exe")) {
    Copy-Item (Join-Path $ProjectRoot "ffmpeg.exe") (Join-Path $OutputDir "ffmpeg.exe") -Force
    Write-Host "   - ffmpeg.exe"
}
if (Test-Path (Join-Path $ProjectRoot "ffprobe.exe")) {
    Copy-Item (Join-Path $ProjectRoot "ffprobe.exe") (Join-Path $OutputDir "ffprobe.exe") -Force
    Write-Host "   - ffprobe.exe"
}
if (Test-Path (Join-Path $ProjectRoot "WebView2Loader.dll")) {
    Copy-Item (Join-Path $ProjectRoot "WebView2Loader.dll") (Join-Path $OutputDir "WebView2Loader.dll") -Force
    Write-Host "   - WebView2Loader.dll"
}

# Copy voxcpm_server.py
Copy-Item (Join-Path $ProjectRoot "tools\voxcpm_server.py") (Join-Path $OutputDir "tools\voxcpm_server.py") -Force
Write-Host "   - tools/voxcpm_server.py"

if (Test-Path (Join-Path $ProjectRoot "tools\tts_cli.py")) {
    Copy-Item (Join-Path $ProjectRoot "tools\tts_cli.py") (Join-Path $OutputDir "tools\tts_cli.py") -Force
    Write-Host "   - tools/tts_cli.py"
}

if (Test-Path (Join-Path $ProjectRoot "tools\voices")) {
    $TargetVoices = Join-Path $OutputDir "tools\voices"
    New-Item -ItemType Directory -Path $TargetVoices -Force | Out-Null
    Copy-Item (Join-Path $ProjectRoot "tools\voices\*") $TargetVoices -Force
    Write-Host "   - tools/voices"
}

# Create Setup_VoxCPM2.bat in the output directory
$SetupBatPath = Join-Path $OutputDir "Setup_VoxCPM2.bat"
$SetupBatContent = @'
@echo off
title VideoGen - Setup Local Voice Engine (VoxCPM 2)
echo ======================================================================
echo VideoGen: Setup Local Voice Engine (VoxCPM 2)
echo ======================================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [!] Python was not detected on your computer.
    echo Attempting to install Python 3.11 via winget...
    winget install -e --id Python.Python.3.11 --accept-package-agreements --accept-source-agreements
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [ERROR] Python is required for local offline voice generation.
        echo Please install Python 3.10 or 3.11 from: https://www.python.org/downloads/
        echo (IMPORTANT: Check the box "Add python.exe to PATH" during installation)
        echo.
        pause
        exit /b 1
    )
    echo Python installed! Please restart this setup script to continue.
    pause
    exit /b 0
)

echo [OK] Python detected:
python --version
echo.

cd /d "%~dp0"
if not exist ".venv-voxcpm\Scripts\python.exe" (
    echo [*] Creating isolated virtual environment in .venv-voxcpm...
    python -m venv .venv-voxcpm
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

echo [OK] Virtual environment ready.
echo.

where nvidia-smi >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [OK] NVIDIA GPU detected:
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
    echo.
    echo [*] Installing PyTorch with CUDA 12.4 acceleration (~2.5 GB)...
    .venv-voxcpm\Scripts\pip.exe install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124
) else (
    echo [i] No NVIDIA GPU detected. Installing standard CPU PyTorch...
    .venv-voxcpm\Scripts\pip.exe install --upgrade torch torchaudio
)

echo.
echo [*] Installing VoxCPM 2 and audio dependencies...
.venv-voxcpm\Scripts\pip.exe install --upgrade "voxcpm>=0.1.0" soundfile

echo.
echo ======================================================================
echo Setup Complete!
echo Testing engine:
.venv-voxcpm\Scripts\python.exe -c "import torch, voxcpm; print('PyTorch:', torch.__version__); print('CUDA Available:', torch.cuda.is_available()); print('VoxCPM 2 Ready!')"
echo ======================================================================
echo.
echo You can now launch 'videogen.exe' and use VoxCPM 2!
pause
'@
Set-Content -Path $SetupBatPath -Value $SetupBatContent -Encoding ASCII
Write-Host "   - Setup_VoxCPM2.bat"

# Create README_FIRST.txt
$ReadmePath = Join-Path $OutputDir "README_FIRST.txt"
$ReadmeContent = @'
===============================================================================
 VideoGen - Khmer & English AI Ghost Story Video Studio
===============================================================================

HOW TO RUN ON THIS PC:
1. Double-click 'videogen.exe' to launch VideoGen.
2. Go to 'Settings' (gear icon on sidebar) -> 'Voice'.
3. Voice Options:
   - VoxCPM 2 (Local GPU/CPU): Free, offline, realistic Khmer speech & voice cloning.
   - Meta MMS (Khmer CPU): Ultra-fast offline Khmer speech on any laptop CPU.
   - Edge TTS: Free online voice (no key required).
   - Kiri TTS / Azure Speech: Cloud AI voices with API keys.

HOW TO ENABLE VOXCPM 2 ON A NEW COMPUTER:
Option A (Inside the App):
   - Open videogen.exe -> Go to Settings -> Voice -> Click "Install Local Voice Engine".
   - The app will automatically configure PyTorch & CUDA for your graphics card!

Option B (1-Click Batch Setup):
   - Simply double-click 'Setup_VoxCPM2.bat'.
   - It will set up the isolated Python environment and download the CUDA packages.

REQUIREMENTS:
- Windows 10 or 11 (64-bit).
- For VoxCPM 2 GPU acceleration: NVIDIA GeForce GTX 1660 / RTX 3050 or higher (6 GB+ VRAM recommended).
- If your PC has no NVIDIA GPU, VoxCPM will run in CPU mode, or you can switch to Meta MMS / Edge TTS.
===============================================================================
'@
Set-Content -Path $ReadmePath -Value $ReadmeContent -Encoding UTF8
Write-Host "   - README_FIRST.txt"

if ($IncludeModels) {
    $ModelsSource = Join-Path $ProjectRoot "tools\models\VoxCPM2"
    if (Test-Path $ModelsSource) {
        Write-Host "3. Copying VoxCPM 2 offline model weights (~4.9 GB)..." -ForegroundColor Yellow
        $TargetModels = Join-Path $OutputDir "tools\models\VoxCPM2"
        New-Item -ItemType Directory -Path $TargetModels -Force | Out-Null
        Copy-Item -Path "$ModelsSource\*" -Destination $TargetModels -Recurse -Force
        Write-Host "   Done copying offline weights." -ForegroundColor Green
    }
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host " Package created successfully!" -ForegroundColor Green
Write-Host " Location: $OutputDir" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "`nHow to share with another computer:" -ForegroundColor Yellow
Write-Host "1. Right-click '$OutputDir' -> Send to -> Compressed (zipped) folder."
Write-Host "2. Send the ZIP to the other PC and extract it."
Write-Host "3. Double-click 'videogen.exe'."
Write-Host "4. Go to Settings -> Voice -> Click 'Install Local Voice Engine'."
Write-Host "   (The app will automatically configure PyTorch & CUDA for their GPU!)`n"

