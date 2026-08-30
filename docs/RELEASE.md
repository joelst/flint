# Release Guide

How to produce **signed installers** and **updater-compatible artifacts** for Flint.

Windows release builds use Azure Trusted Signing with a private trust certificate profile. Local Windows builds skip code signing unless the Azure Trusted Signing environment variables are present.

---

## 1. Code signing

### Windows (Azure Trusted Signing private trust)

Windows release builds sign through Azure Trusted Signing using `scripts/Invoke-AzureTrustedSigning.ps1` as Tauri's custom `signCommand`. The release workflow authenticates with Azure by GitHub OIDC, installs the `ArtifactSigning` PowerShell module, and signs each Windows binary/installer during `tauri build`.

Azure setup:

1. Create an Azure Trusted Signing account.
2. Create a **Private Trust** certificate profile in that account.
3. Create a Microsoft Entra app registration or managed identity for GitHub Actions OIDC.
4. Add a federated credential for this repository/environment.
5. Assign `Artifact Signing Certificate Profile Signer` on the private trust certificate profile (or the narrowest parent scope that is acceptable).

GitHub Actions secrets:

| Secret | Description |
|---|---|
| `AZURE_CLIENT_ID` | Client/application ID for the OIDC-enabled Entra app or managed identity |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID containing the Trusted Signing account |

GitHub Actions variables:

| Variable | Description |
|---|---|
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Trusted Signing endpoint, for example `https://eus.codesigning.azure.net/` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Private trust certificate profile name |

The signing script fails in CI if any Azure Trusted Signing variable is missing. For local Windows release builds, the script warns and skips code signing when these variables are absent.

#### Smoke-test the real signing path

Before configuring production, provision a separate test/staging Trusted Signing account and private trust certificate profile with the GitHub OIDC federated credential and `Artifact Signing Certificate Profile Signer` role described above. Set the release workflow's Azure secrets and Trusted Signing variables to those staging values, then use **Actions → Release → Run workflow** with a test version.

Download a produced Windows `.exe` or `.msi` and verify that Windows recognizes its signature:

```powershell
Get-AuthenticodeSignature -FilePath .\Flint_*.msi | Format-List Status, StatusMessage, SignerCertificate
```

Confirm `Status` is `Valid` and the signer certificate is the expected staging profile before changing the secrets and variables to production values.

### macOS

**Self-signed (quickest):**

```bash
security create-keypair -t rsa -b 2048 -s "Flint Dev" -k ~/Library/Keychains/login.keychain-db
codesign --force --options runtime --sign "Flint Dev" path/to/Flint.app
```

**Long-term:** Apple Developer ID Application certificate (export `.p12`), plus app-specific password for notarization. Notarization can be skipped while using self-signed certs.

### Future migration

Before a broad macOS release: enable full `notarytool` + hardened runtime with Apple Developer ID credentials.

---

## 2. GitHub repository setup

### Actions permissions

**Settings → Actions → General**

- Workflow permissions: **Read and write permissions** (or rely on the workflow `permissions` block).
- Optional: artifact retention (e.g. 90 days).

### Required secrets

**Settings → Secrets and variables → Actions**

| Secret | Description |
|---|---|
| `AZURE_CLIENT_ID` | Client/application ID for GitHub OIDC Azure login |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` (macOS) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_ID` | Apple ID (notarization) |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Team ID |

Set the Azure secrets plus the Azure Trusted Signing repository variables before cutting Windows releases.

### Workflow permissions (already in YAML)

`.github/workflows/release.yml` declares:

```yaml
permissions:
  contents: write
  id-token: write
```

This lets `tauri-action` create releases and upload installers + updater metadata, and lets `azure/login` request an OIDC token for Azure Trusted Signing.

### Optional environment hardening

**Settings → Environments → `release`**: required reviewers / protected branches, then set `environment: release` on the release job. Not required for dogfood 0.3.

---

## 3. Tauri updater signing key

Separate from OS code signing. Required for `plugins.updater`.

```bash
npx tauri signer generate -w ~/.tauri/flint.key
```

- **Never commit** the private key.
- Put the **public key** in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- Fix any `YOUR_ORG` / placeholder updater endpoint URL to the real `owner/repo`.

Private key stays offline (or a secure secret store). Standard Tauri release flow produces `latest.json` + `.sig` when the plugin is configured.

---

## 4. Test the pipeline

### Dry run (no tag)

1. **Actions → Release → Run workflow**
2. Enter a version such as `0.3.0-rc1`
3. Confirm draft release + artifacts when secrets are present

### Full path with throwaway tag

```bash
git tag v0.3.0-test
git push origin v0.3.0-test
```

### Expected artifacts

- Windows: `*.msi`, `*-setup.exe`
- macOS: `.dmg` / app zip
- Updater: `latest.json`, `*.sig`

---

## 5. Cut a real release

Ship checklist (status and blockers) lives in [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md). In short:

1. Reconcile `CHANGELOG.md` / changesets for the version.
2. Updater pubkey + endpoint configured (not placeholders).
3. Azure Trusted Signing secrets/variables present.
4. Green CI on the release branch / PR to `main`.
5. Tag `vX.Y.Z` → release workflow → review draft → publish.

Versioning details: [DEVELOPMENT.md](./DEVELOPMENT.md#versioning--changesets).

---

## 6. Common issues

| Problem | Likely cause | Fix |
|---|---|---|
| Cannot create release | Missing `contents: write` | Permissions block + repo Actions settings |
| Windows signing fails before build upload | Azure secrets/variables missing, OIDC not federated, or signer role missing | Verify Azure GitHub OIDC setup and `Artifact Signing Certificate Profile Signer` on the private trust profile |
| macOS notarization fails | Apple ID / team ID | App-specific password + correct team |
| `latest.json` missing | Updater plugin / pubkey not configured | `tauri.conf.json` plugins.updater |
| “Resource not accessible” | Token scope | Repo workflow permissions |

---

## Related

- [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) — release status and ship checklist
- [DEVELOPMENT.md](./DEVELOPMENT.md) — local build and versioning
- `src-tauri/tauri.conf.json` — updater plugin config
- `.github/workflows/release.yml` — release workflow

Update this document when secret names, workflow variables, or signing requirements change.
