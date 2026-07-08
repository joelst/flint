# Release Guide

How to produce **signed installers** and **updater-compatible artifacts** for Flint.

Self-signed certificates are fine for dogfood / 0.3. They trigger SmartScreen / “unidentified developer” warnings. Plan to migrate to proper EV / Developer ID certificates before a wide 1.0 release.

---

## 1. Local certificates (code signing)

### Windows (self-signed PFX)

```powershell
# Run as Administrator
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=Flint Local Dev" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My"

$pwd = ConvertTo-SecureString -String "your-strong-password" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "flint-selfsigned.pfx" -Password $pwd
```

Base64-encode for GitHub:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("flint-selfsigned.pfx")) | Out-File -Encoding ascii flint-selfsigned.pfx.base64
```

### macOS

**Self-signed (quickest):**

```bash
security create-keypair -t rsa -b 2048 -s "Flint Dev" -k ~/Library/Keychains/login.keychain-db
codesign --force --options runtime --sign "Flint Dev" path/to/Flint.app
```

**Long-term:** Apple Developer ID Application certificate (export `.p12`), plus app-specific password for notarization. Notarization can be skipped while using self-signed certs.

### Future migration

When you obtain real certificates: replace secrets, enable full `notarytool` + hardened runtime on macOS, consider Azure Trusted Signing or an EV cert on Windows.

---

## 2. GitHub repository setup

### Actions permissions

**Settings → Actions → General**

- Workflow permissions: **Read and write permissions** (or rely on the workflow `permissions: contents: write` block).
- Optional: artifact retention (e.g. 90 days).

### Required secrets

**Settings → Secrets and variables → Actions**

| Secret | Description |
|---|---|
| `WINDOWS_CERTIFICATE` | Base64-encoded `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX password |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` (macOS) |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_ID` | Apple ID (notarization) |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Team ID |

You can start with **Windows-only** secrets for the first self-signed pipeline.

### Workflow permissions (already in YAML)

`.github/workflows/release.yml` declares:

```yaml
permissions:
  contents: write
```

This lets `tauri-action` create releases and upload installers + updater metadata.

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
3. Signing secrets present.
4. Green CI on the release branch / PR to `main`.
5. Tag `vX.Y.Z` → release workflow → review draft → publish.

Versioning details: [DEVELOPMENT.md](./DEVELOPMENT.md#versioning--changesets).

---

## 6. Common issues

| Problem | Likely cause | Fix |
|---|---|---|
| Cannot create release | Missing `contents: write` | Permissions block + repo Actions settings |
| Signing skipped | Secrets missing/empty | Exact secret names (case-sensitive) |
| macOS notarization fails | Apple ID / team ID | App-specific password + correct team |
| `latest.json` missing | Updater plugin / pubkey not configured | `tauri.conf.json` plugins.updater |
| “Resource not accessible” | Token scope | Repo workflow permissions |

---

## Related

- [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) — release status and ship checklist
- [DEVELOPMENT.md](./DEVELOPMENT.md) — local build and versioning
- `src-tauri/tauri.conf.json` — updater plugin config
- `.github/workflows/release.yml` — release workflow

Update this document when secret names, workflow behavior, or signing requirements change.
