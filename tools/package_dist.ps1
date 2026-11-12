<#
.SYNOPSIS
    Packages VideoGen into a clean, distributable folder ready to share with others.
#>

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

if (Test-Path (Join-Path $ProjectRoot "tools\tts_cli.py")) {
    Copy-Item (Join-Path $ProjectRoot "tools\tts_cli.py") (Join-Path $OutputDir "tools\tts_cli.py") -Force
    Write-Host "   - tools/tts_cli.py"
}

# Create README_FIRST.txt
$ReadmePath = Join-Path $OutputDir "README_FIRST.txt"
$ReadmeContent = @'
===============================================================================
 VideoGen - Khmer & English AI Ghost Story Video Studio
===============================================================================

HOW TO RUN:
1. Double-click 'videogen.exe' to launch VideoGen.
2. Go to 'Settings' (gear icon on sidebar) -> 'Voice'.
3. Voice Options:
   - Edge TTS: Free, crystal-clear cloud neural speech in Khmer (Piseth & Sreymom) and English.
   - Meta MMS (Khmer CPU): Ultra-fast offline Khmer speech on any laptop CPU.
   - Kiri TTS / Azure Speech: Cloud AI voices with API keys.

REQUIREMENTS:
- Windows 10 or 11 (64-bit).
- Internet connection for Edge TTS, Gemini, or Cloud AI features.
===============================================================================
'@
Set-Content -Path $ReadmePath -Value $ReadmeContent -Encoding UTF8
Write-Host "   - README_FIRST.txt"

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host " Package created successfully!" -ForegroundColor Green
Write-Host " Location: $OutputDir" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "`nHow to share with another computer:" -ForegroundColor Yellow
Write-Host "1. Right-click '$OutputDir' -> Send to -> Compressed (zipped) folder."
Write-Host "2. Send the ZIP to the other PC and extract it."
Write-Host "3. Double-click 'videogen.exe'.`n"
