# Release Signing Guide (Self-Signed Bootstrap for 0.3)

This document describes how to set up code signing for Flint releases using **self-signed certificates** to get the CI/CD pipeline working quickly.

**Important:** Self-signed builds will trigger security warnings on end-user machines (Windows SmartScreen, macOS "unidentified developer"). This is acceptable for internal/dogfood 0.3 builds. Plan to migrate to proper EV / Developer ID certificates before a wider 1.0 release.

## 1. Windows (Self-Signed PFX)

### Generate the certificate locally (PowerShell)
```powershell
# Run as Administrator
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=Flint Local Dev" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My"

# Export as PFX (you will be prompted for a password)
$pwd = ConvertTo-SecureString -String "your-strong-password" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "flint-selfsigned.pfx" -Password $pwd
```

### Prepare the secret
1. Base64-encode the PFX:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("flint-selfsigned.pfx")) | Out-File -Encoding ascii flint-selfsigned.pfx.base64
   ```
2. In GitHub repo → Settings → Secrets and variables → Actions, create:
   - `WINDOWS_CERTIFICATE` → paste the entire base64 content
   - `WINDOWS_CERTIFICATE_PASSWORD` → the password you used

### In the workflow
Uncomment / adapt the Windows signing step in `.github/workflows/release.yml`.

The tauri-action can also pick up signing via environment variables in some configurations.

## 2. macOS (Self-Signed or Developer ID)

### Option A – Pure self-signed (quickest)
```bash
# Create a self-signed cert
security create-keypair -t rsa -b 2048 -s "Flint Dev" -k ~/Library/Keychains/login.keychain-db

# Then use codesign with the identity
codesign --force --options runtime --sign "Flint Dev" path/to/Flint.app
```

### Option B – Proper (recommended long-term)
1. Get an Apple Developer ID Application certificate from Apple Developer portal.
2. Export as .p12 / .p12 + password.
3. Base64 the .p12 and store as `APPLE_CERTIFICATE`.
4. Store the password as `APPLE_CERTIFICATE_PASSWORD`.
5. Also store `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), and `APPLE_TEAM_ID`.

Use the `apple-actions/import-codesign-certs` action (already referenced in the workflow).

Notarization (`xcrun notarytool`) can be skipped while using self-signed certs.

## 3. Generating the Tauri Updater Key (separate from code signing)

This is required for the updater feature (even with self-signed app bundles).

```bash
npx tauri signer generate -w ~/.tauri/flint.key
```

- Keep the **private** key extremely safe (never commit).
- Put the **public key** into `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- The private key is used when you run `tauri signer sign ...` or when the release workflow produces signatures.

## 4. Testing the Pipeline

1. Use **workflow_dispatch** on the Release workflow (no tag required) for dry runs.
2. Create a throwaway tag like `v0.3.0-test` to exercise the full path.
3. Check that:
   - Signed installers appear in the GitHub release.
   - `latest.json` and `*.sig` files are present.

## 5. Future Migration

When you obtain real certificates:
- Replace the self-signed secrets.
- Enable full `notarytool` + hardened runtime on macOS.
- Consider Azure Trusted Signing or a proper EV cert on Windows for reduced SmartScreen friction.

Update this document and the release workflow comments when you switch.

---

**Next:** After adding the secrets, run a workflow_dispatch or tag to verify signed artifacts + updater metadata are produced.
