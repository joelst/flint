$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

# Try common locations for the built exe
$candidates = @(
    (Join-Path $projectRoot "src-tauri\target\release\Flint.exe"),
    (Join-Path $projectRoot "src-tauri\target\release\tauri-app.exe"),
    (Join-Path $projectRoot "src-tauri\target\debug\Flint.exe")
)

$exe = $null
foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
        $exe = $candidate
        break
    }
}

if (-not $exe) {
    Write-Error "Could not find a built Flint.exe. Run 'npm run tauri:build' first (or tauri build --debug)."
}

Write-Host "Launching built Flint from: $exe" -ForegroundColor Green
& $exe
