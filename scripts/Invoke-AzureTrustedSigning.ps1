param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath
)

$ErrorActionPreference = 'Stop'

# Tauri invokes this script as a custom `signCommand` and discards the child
# process output, surfacing only `failed to run pwsh`. Mirror every diagnostic
# to a log file so the release workflow can publish the real failure reason.
$logPath = $env:FLINT_SIGNING_LOG_PATH
if ([string]::IsNullOrWhiteSpace($logPath)) {
    $logPath = Join-Path $PSScriptRoot '..\src-tauri\target\flint-signing.log'
}

function Write-SigningLog {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message,

        [ValidateSet('INFO', 'ERROR')]
        [string] $Level = 'INFO'
    )

    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'o'), $Level, $Message
    Write-Output $line

    try {
        $logDirectory = Split-Path -Path $logPath -Parent
        if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory)) {
            New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        }
        Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
    } catch {
        # Logging must never mask the signing result.
        Write-Output "[WARN] Unable to write signing log '$($logPath)': $($_.Exception.Message)"
    }
}

function Format-SigningError {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.ErrorRecord] $ErrorRecord
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("Message: $($ErrorRecord.Exception.Message)")
    $lines.Add("Category: $($ErrorRecord.CategoryInfo.ToString())")
    $lines.Add("FullyQualifiedErrorId: $($ErrorRecord.FullyQualifiedErrorId)")

    $exception = $ErrorRecord.Exception
    $depth = 0
    while ($exception) {
        $lines.Add("Exception[$($depth)]: $($exception.GetType().FullName): $($exception.Message)")
        $exception = $exception.InnerException
        $depth++
    }

    if ($ErrorRecord.ScriptStackTrace) {
        $lines.Add("ScriptStackTrace: $($ErrorRecord.ScriptStackTrace)")
    }

    return ($lines.ToArray() -join [Environment]::NewLine)
}

$requiredEnvironmentVariables = @(
    'AZURE_TRUSTED_SIGNING_ENDPOINT',
    'AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
    'AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME'
)

$missingEnvironmentVariables = @(
    foreach ($name in $requiredEnvironmentVariables) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            $name
        }
    }
)

if ($missingEnvironmentVariables.Count -gt 0) {
    $message = "Azure Trusted Signing is not configured. Missing: $($missingEnvironmentVariables -join ', ')"
    if ($env:CI -eq 'true') {
        throw $message
    }

    Write-Warning "$message. Skipping local Windows code signing."
    exit 0
}

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "File to sign does not exist: $FilePath"
}

Write-SigningLog "Signing '$($FilePath)' with account '$($env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME)', profile '$($env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME)', endpoint '$($env:AZURE_TRUSTED_SIGNING_ENDPOINT)'."

try {
    Import-Module ArtifactSigning -ErrorAction Stop
} catch {
    Write-SigningLog -Level ERROR "Failed to import the ArtifactSigning module.$([Environment]::NewLine)$(Format-SigningError -ErrorRecord $_)"
    exit 1
}

try {
    Invoke-ArtifactSigning `
        -Endpoint $env:AZURE_TRUSTED_SIGNING_ENDPOINT `
        -CodeSigningAccountName $env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME `
        -CertificateProfileName $env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME `
        -Files $FilePath `
        -FileDigest SHA256 `
        -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
        -TimestampDigest SHA256 `
        -Description 'Flint' `
        -DescriptionUrl 'https://github.com/joelst/flint'
} catch {
    Write-SigningLog -Level ERROR "Azure Trusted Signing failed for '$($FilePath)'.$([Environment]::NewLine)$(Format-SigningError -ErrorRecord $_)"
    exit 1
}

Write-SigningLog "Successfully signed '$($FilePath)'."
