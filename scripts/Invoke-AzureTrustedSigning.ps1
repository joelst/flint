param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath
)

$ErrorActionPreference = 'Stop'

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

Import-Module ArtifactSigning -ErrorAction Stop

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
