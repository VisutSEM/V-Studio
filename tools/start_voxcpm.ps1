# Start the local VoxCPM 2 server for VideoGen.
#
#   .\tools\start_voxcpm.ps1            # GPU if it fits, otherwise errors tell you to use -Cpu
#   .\tools\start_voxcpm.ps1 -Cpu       # force CPU (small GPU / no GPU)
#   .\tools\start_voxcpm.ps1 -Port 8000
#
# Uses .venv-voxcpm in the repository root and tools\models\VoxCPM2 (offline
# weights) when they exist, otherwise falls back to python + the HF hub.

param(
    [switch]$Cpu,
    [int]$Port = 8000,
    [string]$Model = ""
)

$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root ".venv-voxcpm\Scripts\python.exe"
$python = if (Test-Path $venvPython) { $venvPython } else { "python" }

$localModel = Join-Path $PSScriptRoot "models\VoxCPM2"
if (-not $Model) {
    $Model = if (Test-Path (Join-Path $localModel "model.safetensors")) {
        $localModel
    } else {
        "openbmb/VoxCPM2"
    }
}

$pyArgs = @(
    (Join-Path $PSScriptRoot "voxcpm_server.py"),
    "--port", "$Port",
    "--model", $Model
)

if ($Cpu) {
    # torch.compile is slow to warm up on CPU and rarely pays off.
    $pyArgs += @("--device", "cpu", "--no-optimize")
}

Write-Host "Starting VoxCPM 2 on http://127.0.0.1:$Port ..." -ForegroundColor Cyan
Write-Host "Model: $Model" -ForegroundColor DarkGray
Write-Host "Keep this window open while VideoGen generates voice." -ForegroundColor DarkGray
& $python @pyArgs
