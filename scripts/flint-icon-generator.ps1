<#
.SYNOPSIS
    Updates Flint app icon assets from a source image using ffmpeg.

.DESCRIPTION
    This script updates icon assets used by the app in:
    - static\ (favicon + web icon set)
    - src-tauri\icons\ (Windows/macOS bundle + Windows tile assets)

    SVG generation is intentionally excluded.

.PARAMETER SourceImage
    Path to the source image file (PNG recommended).

.PARAMETER RepositoryRoot
    Path to repository root. Defaults to parent folder of this script's directory.

.EXAMPLE
    .\flint-icon-generator.ps1 -SourceImage ".\flint-logo.png"

.EXAMPLE
    .\flint-icon-generator.ps1 -SourceImage "C:\logos\myapp.png" -RepositoryRoot "F:\git\flint"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$SourceImage,

    [string]$RepositoryRoot = (Split-Path -Path $PSScriptRoot -Parent)
)

# Check if ffmpeg is available
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error 'ffmpeg is not installed or not in your PATH. Please install ffmpeg first.'
    exit 1
}

# Validate source image exists and resolve full path
$resolvedSourceImage = Resolve-Path -LiteralPath $SourceImage -ErrorAction SilentlyContinue
if (-not $resolvedSourceImage) {
    Write-Error "Source image not found: $($SourceImage)"
    exit 1
}
$sourceImagePath = $resolvedSourceImage.ProviderPath

# Resolve and validate repository directories
$resolvedRepositoryRoot = Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction SilentlyContinue
if (-not $resolvedRepositoryRoot) {
    Write-Error "Repository root not found: $($RepositoryRoot)"
    exit 1
}
$repositoryRootPath = $resolvedRepositoryRoot.ProviderPath
$staticFolder = Join-Path $repositoryRootPath 'static'
$tauriIconsFolder = Join-Path $repositoryRootPath 'src-tauri\icons'

if (-not (Test-Path -LiteralPath $staticFolder)) {
    Write-Error "Missing static folder: $($staticFolder)"
    exit 1
}
if (-not (Test-Path -LiteralPath $tauriIconsFolder)) {
    Write-Error "Missing Tauri icons folder: $($tauriIconsFolder)"
    exit 1
}

function New-ResizedImage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InputPath,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath,

        [Parameter(Mandatory = $true)]
        [int]$Size
    )
    $resolvedInputPath = (Resolve-Path -LiteralPath $InputPath).ProviderPath
    $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    $ffmpegOutputPath = $resolvedOutputPath
    $usesTemporaryOutput = $false

    if ($resolvedInputPath.Equals($resolvedOutputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        $ffmpegOutputPath = Join-Path (Split-Path -Path $resolvedOutputPath -Parent) ([System.IO.Path]::GetRandomFileName() + '.png')
        $usesTemporaryOutput = $true
    }

    ffmpeg -y -i $InputPath -vf "scale=${Size}:${Size}:flags=lanczos" -frames:v 1 $ffmpegOutputPath 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed for output path: $($OutputPath)"
    }

    if ($usesTemporaryOutput) {
        Move-Item -LiteralPath $ffmpegOutputPath -Destination $resolvedOutputPath -Force
    }

    if (-not (Test-Path -LiteralPath $resolvedOutputPath)) {
        throw "Output file was not created: $($OutputPath)"
    }
}

Write-Host "`nUpdating Flint icon assets from: $($sourceImagePath)" -ForegroundColor Cyan
Write-Host "Repository root: $($repositoryRootPath)`n" -ForegroundColor Cyan

$staticTargets = @(
    @{ Name = 'icon-32x32.png'; Size = 32 },
    @{ Name = 'icon-64x64.png'; Size = 64 },
    @{ Name = 'icon-128x128.png'; Size = 128 },
    @{ Name = 'icon-256x256.png'; Size = 256 },
    @{ Name = 'icon-512x512.png'; Size = 512 },
    @{ Name = 'favicon.png'; Size = 32 },
    @{ Name = 'flint-master-1024.png'; Size = 1024 }
)

foreach ($target in $staticTargets) {
    $destinationPath = Join-Path $staticFolder $target.Name
    Write-Host "Updating static\$($target.Name)..." -NoNewline
    New-ResizedImage -InputPath $sourceImagePath -OutputPath $destinationPath -Size $target.Size
    Write-Host ' Done' -ForegroundColor Green
}

$staticIcoPath = Join-Path $staticFolder 'icon.ico'
Write-Host "Updating static\icon.ico..." -NoNewline
New-ResizedImage -InputPath $sourceImagePath -OutputPath $staticIcoPath -Size 256
Write-Host ' Done' -ForegroundColor Green

$tauriTargets = @(
    @{ Name = '32x32.png'; Size = 32 },
    @{ Name = '128x128.png'; Size = 128 },
    @{ Name = '128x128@2x.png'; Size = 256 },
    @{ Name = 'icon.png'; Size = 512 },
    @{ Name = 'Square30x30Logo.png'; Size = 30 },
    @{ Name = 'Square44x44Logo.png'; Size = 44 },
    @{ Name = 'Square71x71Logo.png'; Size = 71 },
    @{ Name = 'Square89x89Logo.png'; Size = 89 },
    @{ Name = 'Square107x107Logo.png'; Size = 107 },
    @{ Name = 'Square142x142Logo.png'; Size = 142 },
    @{ Name = 'Square150x150Logo.png'; Size = 150 },
    @{ Name = 'Square284x284Logo.png'; Size = 284 },
    @{ Name = 'Square310x310Logo.png'; Size = 310 },
    @{ Name = 'StoreLogo.png'; Size = 50 }
)

foreach ($target in $tauriTargets) {
    $destinationPath = Join-Path $tauriIconsFolder $target.Name
    Write-Host "Updating src-tauri\icons\$($target.Name)..." -NoNewline
    New-ResizedImage -InputPath $sourceImagePath -OutputPath $destinationPath -Size $target.Size
    Write-Host ' Done' -ForegroundColor Green
}

$tauriIcoPath = Join-Path $tauriIconsFolder 'icon.ico'
Write-Host 'Updating src-tauri\icons\icon.ico...' -NoNewline
New-ResizedImage -InputPath $sourceImagePath -OutputPath $tauriIcoPath -Size 256
Write-Host ' Done' -ForegroundColor Green

$tauriIcnsPath = Join-Path $tauriIconsFolder 'icon.icns'
Write-Host 'Updating src-tauri\icons\icon.icns...' -NoNewline
$png2Icns = Get-Command png2icns -ErrorAction SilentlyContinue
if ($png2Icns) {
    $tempIcnsPng = Join-Path $tauriIconsFolder 'icon.icns.source.1024.png'
    New-ResizedImage -InputPath $sourceImagePath -OutputPath $tempIcnsPng -Size 1024
    & $png2Icns.Path $tauriIcnsPath $tempIcnsPng
    if ($LASTEXITCODE -ne 0) {
        throw 'png2icns failed while generating src-tauri\icons\icon.icns'
    }
    Remove-Item -LiteralPath $tempIcnsPng -Force
    Write-Host ' Done' -ForegroundColor Green
} else {
    Write-Host ' Skipped' -ForegroundColor Yellow
    Write-Warning 'png2icns is not available on this machine, so src-tauri\icons\icon.icns was not regenerated. Run this script on macOS with png2icns installed to refresh icon.icns.'
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host 'App icon asset update complete!' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "`nUpdated folders:" -ForegroundColor White
Write-Host "  $($staticFolder)" -ForegroundColor Gray
Write-Host "  $($tauriIconsFolder)" -ForegroundColor Gray
Write-Host ''