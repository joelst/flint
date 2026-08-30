Describe 'Invoke-AzureTrustedSigning.ps1' {
    BeforeEach {
        Remove-Item Env:AZURE_TRUSTED_SIGNING_ENDPOINT -ErrorAction SilentlyContinue
        Remove-Item Env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME -ErrorAction SilentlyContinue
        Remove-Item Env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME -ErrorAction SilentlyContinue
        Remove-Item Env:CI -ErrorAction SilentlyContinue
    }

    It 'signs an existing file when Azure Trusted Signing is configured' {
        $scriptPath = Join-Path $PSScriptRoot '../scripts/Invoke-AzureTrustedSigning.ps1'
        $testFilePath = Join-Path $TestDrive 'Flint.exe'
        Set-Content -LiteralPath $testFilePath -Value 'test artifact'
        $env:AZURE_TRUSTED_SIGNING_ENDPOINT = 'https://test.codesigning.azure.net/'
        $env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME = 'flint-test'
        $env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME = 'flint-test-profile'
        function Invoke-ArtifactSigning {
            param(
                $Endpoint,
                $CodeSigningAccountName,
                $CertificateProfileName,
                [string[]] $Files,
                $FileDigest,
                $TimestampRfc3161,
                $TimestampDigest,
                $Description,
                $DescriptionUrl
            )
        }
        Mock Import-Module {}
        Mock Invoke-ArtifactSigning {}
        Mock Write-Warning {}

        { & $scriptPath -FilePath $testFilePath } | Should -Not -Throw

        Should -Invoke Import-Module -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'ArtifactSigning' -and $ErrorAction -eq 'Stop'
        }
        Should -Invoke Invoke-ArtifactSigning -Times 1 -Exactly -ParameterFilter {
            $Endpoint -eq 'https://test.codesigning.azure.net/' -and
            $CodeSigningAccountName -eq 'flint-test' -and
            $CertificateProfileName -eq 'flint-test-profile' -and
            $Files -eq $testFilePath -and
            $FileDigest -eq 'SHA256' -and
            $TimestampRfc3161 -eq 'https://timestamp.acs.microsoft.com' -and
            $TimestampDigest -eq 'SHA256' -and
            $Description -eq 'Flint' -and
            $DescriptionUrl -eq 'https://github.com/joelst/flint'
        }
        Should -Invoke Write-Warning -Times 0 -Exactly
    }

    It 'warns and skips signing locally when Azure Trusted Signing is not configured' {
        $scriptPath = Join-Path $PSScriptRoot '../scripts/Invoke-AzureTrustedSigning.ps1'
        $testFilePath = Join-Path $TestDrive 'Flint.exe'
        Set-Content -LiteralPath $testFilePath -Value 'test artifact'
        $powerShell = Join-Path $PSHOME 'pwsh.exe'
        if (-not (Test-Path -LiteralPath $powerShell)) {
            $powerShell = Join-Path $PSHOME 'pwsh'
        }

        $output = & $powerShell -NoProfile -File $scriptPath -FilePath $testFilePath 2>&1

        $LASTEXITCODE | Should -Be 0
        $output | Should -Match 'Azure Trusted Signing is not configured'
        $output | Should -Match 'Skipping local Windows code signing'
    }

    It 'throws in CI when Azure Trusted Signing is not configured' {
        $scriptPath = Join-Path $PSScriptRoot '../scripts/Invoke-AzureTrustedSigning.ps1'
        $testFilePath = Join-Path $TestDrive 'Flint.exe'
        Set-Content -LiteralPath $testFilePath -Value 'test artifact'
        $env:CI = 'true'

        { & $scriptPath -FilePath $testFilePath } | Should -Throw '*Azure Trusted Signing is not configured*'
    }

    It 'throws when the file to sign does not exist' {
        $scriptPath = Join-Path $PSScriptRoot '../scripts/Invoke-AzureTrustedSigning.ps1'
        $env:AZURE_TRUSTED_SIGNING_ENDPOINT = 'https://test.codesigning.azure.net/'
        $env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME = 'flint-test'
        $env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME = 'flint-test-profile'

        { & $scriptPath -FilePath (Join-Path $TestDrive 'missing.exe') } |
            Should -Throw '*File to sign does not exist*'
    }
}
