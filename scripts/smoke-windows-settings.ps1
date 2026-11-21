<#
.SYNOPSIS
Checks the packaged Windows Settings view through native accessibility.
.DESCRIPTION
Requires Windows PowerShell 5.1, Windows UI Automation, and WebView2.
Uses an isolated profile, loads no model, and verifies that Shared Foundry host
appears once in Settings under Startup and does not appear in Models.
This is a shell smoke test, not import, inference, or Benchmark qualification.
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$exePath = (Join-Path $PSScriptRoot '..\src-tauri\target\debug\Flint.exe'),

    [Parameter()]
    [ValidateRange(5, 120)]
    [int]$timeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "Flint executable not found: $($exePath)"
}
$exePath = (Resolve-Path -LiteralPath $exePath).Path
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $windowsPowerShell -NoProfile -NonInteractive -File $PSCommandPath -exePath $exePath -timeoutSeconds $timeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw "Windows Settings smoke failed with exit $($LASTEXITCODE)." }
    return
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$probeProfile = Join-Path ([System.IO.Path]::GetTempPath()) ('flint-settings-smoke-' + [Guid]::NewGuid().ToString('N'))
$environment = @{
    HOME = $probeProfile
    USERPROFILE = $probeProfile
    APPDATA = (Join-Path $probeProfile 'Roaming')
    LOCALAPPDATA = (Join-Path $probeProfile 'Local')
    WEBVIEW2_USER_DATA_FOLDER = (Join-Path $probeProfile 'WebView2')
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
    CUDA_VISIBLE_DEVICES = ''
    FLINT_RUNTIME_SMOKE = $null
}
$previousEnvironment = @{}
$appProcess = $null
$failure = $null
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
try {
    New-Item -ItemType Directory -Path $probeProfile | Out-Null
    foreach ($name in $environment.Keys) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    $startParameters = @{ FilePath = $exePath; PassThru = $true }
    $appProcess = Start-Process @startParameters
    $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
    do {
        $appProcess.Refresh()
        if ($appProcess.HasExited) { throw "Flint exited before inspection with code $($appProcess.ExitCode)." }
        if ($appProcess.MainWindowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($appProcess.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Flint did not open an accessible window.' }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($appProcess.MainWindowHandle)
    foreach ($view in @('Models', 'Settings')) {
        $condition = [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $view),
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
        )
        do {
            $navigation = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
            if ($navigation) { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $navigation) { throw "The $($view) navigation button was not accessible." }
        $navigation.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        do {
            Start-Sleep -Milliseconds 200
            $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $toggles = @($controls | Where-Object {
                $_.Current.Name -eq 'Shared Foundry host' -and
                $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox
            })
            if ($view -eq 'Models') {
                $catalog = @($controls | Where-Object {
                    $_.Current.Name -eq 'Model Catalog' -and
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text
                })
                if ($catalog.Count -ne 1) { continue }
                if ($toggles.Count -ne 0) { throw 'Shared Foundry host still appears in Models.' }
                break
            }
            $startup = @($controls | Where-Object {
                $_.Current.Name -eq 'Startup' -and
                $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text
            })
            if ($toggles.Count -eq 1 -and $startup.Count -eq 1) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($view -eq 'Models' -and $catalog.Count -ne 1) {
            throw 'The Model Catalog view did not become accessible.'
        }
        if ($view -eq 'Settings' -and ($toggles.Count -ne 1 -or $startup.Count -ne 1)) {
            throw 'Settings must expose one Shared Foundry host checkbox and one Startup heading.'
        }
    }
} catch {
    $failure = $_
} finally {
    if ($appProcess) {
        try {
            $appProcess.Refresh()
            if (-not $appProcess.HasExited) {
                [void]$appProcess.CloseMainWindow()
                if (-not $appProcess.WaitForExit(20000)) {
                    Stop-Process -Id $appProcess.Id -Force
                    $cleanupErrors.Add('Flint needed forced termination.')
                }
            }
            $children = @(Get-CimInstance Win32_Process | Where-Object {
                ($_.CommandLine -and $_.CommandLine.Contains($probeProfile) -and $_.Name -eq 'msedgewebview2.exe') -or
                ($_.ParentProcessId -eq $appProcess.Id -and $_.ExecutablePath -eq (Join-Path (Split-Path $exePath -Parent) 'node.exe'))
            })
            foreach ($child in $children) {
                try { $childProcess = [System.Diagnostics.Process]::GetProcessById($child.ProcessId) }
                catch [ArgumentException] {
                    Write-Verbose "Owned child $($child.ProcessId) already exited."
                    continue
                }
                if (-not $childProcess.WaitForExit(5000)) {
                    Stop-Process -Id $child.ProcessId -Force
                    if ($child.Name -eq 'node.exe') { $cleanupErrors.Add('Sidecar termination required escalation.') }
                }
                $childProcess.Dispose()
            }
            $appProcess.Dispose()
        } catch {
            $cleanupErrors.Add($_.Exception.Message)
        }
    }
    try {
        if (Test-Path -LiteralPath $probeProfile) { Remove-Item -LiteralPath $probeProfile -Recurse -Force }
    } catch {
        $cleanupErrors.Add($_.Exception.Message)
    }
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
if ($cleanupErrors.Count -gt 0) {
    if (-not $failure) { throw ('Settings smoke cleanup failed: ' + ($cleanupErrors -join '; ')) }
    Write-Warning ('Settings smoke cleanup failed: ' + ($cleanupErrors -join '; '))
}
if ($failure) { throw $failure }
Write-Output 'Windows Settings smoke passed: Shared Foundry host is in Settings, not Models.'
