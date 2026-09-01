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
4. Add a federated credential for this repository, with:
   - **Entity type**: GitHub Actions deploying Azure resources (or "Environment" scenario)
   - **Organization**: `joelst`, **Repository**: `flint`
   - **Entity**: `Environment`, **GitHub environment name**: `release`
   - This produces a subject of `repo:joelst/flint:environment:release`, which stays valid for every future release tag. Do **not** use the "Tag" entity type here — GitHub issues a distinct OIDC subject per tag (e.g. `repo:joelst/flint:ref:refs/tags/v0.4.1`), so a tag-scoped federated credential only works for that one tag and every new release tag fails with `AADSTS700213: No matching federated identity record found`. The release workflow's job runs under the `release` GitHub environment (`environment: release` in `.github/workflows/release.yml`) specifically so its OIDC subject stays constant across tags. The workflow also preflights the OIDC token before Azure login and fails with the observed subject if GitHub does not issue the expected environment-scoped token.
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

Before configuring production, provision a separate test/staging Trusted Signing account and private trust certificate profile with the GitHub OIDC federated credential and `Artifact Signing Certificate Profile Signer` role described above. Set the release workflow's Azure secrets and Trusted Signing variables to those staging values, then use **Actions → Release → Run workflow** from the default branch with a test version.

Download a produced Windows `.exe` or `.msi` and verify that Windows recognizes its signature:

```powershell
Get-ChildItem -Path . -File -Filter 'Flint_*' |
  Where-Object { $_.Extension -in '.msi', '.exe' } |
  ForEach-Object { Get-AuthenticodeSignature -FilePath $_.FullName } |
  Format-List Status, StatusMessage, SignerCertificate
```

Confirm `Status` is `Valid` and the signer certificate is the expected staging profile before changing the secrets and variables to production values.

### macOS

Any app downloaded through a browser gets a quarantine attribute. Unless it is signed with an Apple **Developer ID Application** certificate *and* notarized, Gatekeeper reports it as **"Flint is damaged and can't be opened"**. There is no free signing route: Developer ID is not an App Store thing — it is Apple's certificate for distributing *outside* the App Store, and it still requires the paid ($99/yr) developer account. Self-signed and ad-hoc signatures do not satisfy Gatekeeper.

Flint currently ships **unsigned** macOS builds and works around quarantine instead:

- **Recommended install path** — `scripts/install-macos.sh` fetches the latest release with `curl`, which never applies the quarantine attribute, so the app runs with no Gatekeeper interaction at all:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
  ```

- **Manual DMG install** — after dragging Flint to Applications, clear the quarantine attribute (the "damaged" dialog offers no "Open Anyway" path for unsigned apps, so right-click → Open does not help):

  ```bash
  xattr -cr /Applications/Flint.app
  ```

- Once installed, the built-in Tauri updater downloads updates itself (not through a browser), so updates are not re-quarantined.

The release workflow warns when building unsigned, and fails only on the half-configured state (certificate present but notarization secrets missing), because a signed-but-unnotarized app is still blocked.

#### Optional: Developer ID signing + notarization

If a paid Apple Developer account is ever added, set the secrets below and `tauri-action` signs and notarizes automatically — no workflow changes needed:

1. In the Apple Developer portal, create a **Developer ID Application** certificate and export it (with its private key) as a `.p12` from Keychain Access.
2. Base64-encode the `.p12` (`base64 -i cert.p12 | pbcopy`) → `APPLE_CERTIFICATE` secret; its password → `APPLE_CERTIFICATE_PASSWORD`.
3. Set `APPLE_SIGNING_IDENTITY` to the certificate's full identity name, e.g. `Developer ID Application: Your Name (TEAMID)`.
4. For notarization, create an app-specific password at appleid.apple.com → `APPLE_PASSWORD`, plus `APPLE_ID` (the account email) and `APPLE_TEAM_ID`.

`tauri-action` imports the certificate into a temporary keychain, signs the bundle with the hardened runtime, and submits it to `notarytool` when the notarization secrets are present.

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
| `APPLE_CERTIFICATE` | *Optional* — Base64-encoded `.p12` (macOS). Unset = unsigned macOS builds (see section 1) |
| `APPLE_CERTIFICATE_PASSWORD` | *Optional* — `.p12` password |
| `APPLE_SIGNING_IDENTITY` | *Optional* — certificate identity, e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | *Optional* — Apple ID; required if `APPLE_CERTIFICATE` is set (notarization) |
| `APPLE_PASSWORD` | *Optional* — app-specific password; required if `APPLE_CERTIFICATE` is set |
| `APPLE_TEAM_ID` | *Optional* — Apple Team ID; required if `APPLE_CERTIFICATE` is set |

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

### Updater endpoint

The endpoint is the floating "latest release" URL:

```
https://github.com/joelst/flint/releases/latest/download/latest.json
```

GitHub's `/releases/latest/` pointer **skips drafts and pre-releases**. A release
left as a draft, or published with "Set as a pre-release" checked, is invisible to
the updater and every installed client silently reports "up to date". Publishing a
release as the latest full release is therefore a required release step, not a
cosmetic one.

> **Do not** use `releases/download/v{{current_version}}/latest.json`. That resolves
> to the manifest attached to the version the user is *already running*, so it always
> reports the current version and the updater can never discover a newer one. Flint
> shipped this bug through v0.4.4; those builds cannot self-update, but none were
> distributed, so no rescue was needed.

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

### Rebuild an existing tag after workflow fixes

GitHub runs tag-triggered workflows from the workflow file stored at the tagged commit. If a tag was created before the `release` environment OIDC fix, rerunning that tag's workflow will keep requesting a tag-scoped OIDC subject such as `repo:joelst/flint:ref:refs/tags/v0.4.1`.

To rebuild that existing source without retagging:

1. Open **Actions → Release → Run workflow**.
2. Select the default branch that contains the fixed workflow, not the old tag.
3. Set `version` to the release version, for example `0.4.1`.
4. Set `checkout_ref` to the tag to build, for example `v0.4.1`.

This runs the fixed workflow under the `release` environment while checking out the tagged source for the build.

### Expected artifacts

- Windows: `*.msi`, `*-setup.exe`
- macOS: `.dmg` / app zip
- Updater: `latest.json`, `*.sig`

---

## 5. Cut a real release

Ship checklist (status and blockers) lives in [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md). In short:

1. Reconcile `CHANGELOG.md` / changesets for the version.
2. Updater pubkey + endpoint configured (not placeholders).
3. Azure Trusted Signing secrets/variables present (Windows). Apple secrets are optional — without them the macOS build ships unsigned (see section 1 for user install instructions).
4. Green CI on the release branch / PR to `main`.
5. Tag `vX.Y.Z` → release workflow → review draft → publish.
6. Publish as the **latest full release** — leave "Set as a pre-release" unchecked,
   or the updater will not see it (see section 3).

Versioning details: [DEVELOPMENT.md](./DEVELOPMENT.md#versioning--changesets).

---

## 6. Common issues

| Problem | Likely cause | Fix |
|---|---|---|
| Cannot create release | Missing `contents: write` | Permissions block + repo Actions settings |
| Windows signing fails before build upload | Azure secrets/variables missing, OIDC not federated, or signer role missing | Verify Azure GitHub OIDC setup and `Artifact Signing Certificate Profile Signer` on the private trust profile |
| `AADSTS700213: No matching federated identity record found for presented assertion subject 'repo:joelst/flint:ref:refs/tags/vX.Y.Z'` | Federated credential is scoped to a specific tag, or the workflow is running from an old tag that predates the `release` environment fix | Recreate the federated credential using the `Environment` entity type with GitHub environment `release`, so the subject is `repo:joelst/flint:environment:release` (see section 1 above). If rebuilding an existing tag, run `workflow_dispatch` from the fixed default branch and put the tag in `checkout_ref`. |
| macOS notarization fails | Apple ID / team ID | App-specific password + correct team |
| macOS says the app is "damaged" after install | Unsigned build downloaded through a browser gets quarantined; Gatekeeper blocks it (expected for Flint's unsigned releases) | Install via `scripts/install-macos.sh`, or run `xattr -cr /Applications/Flint.app` after a DMG install; signing/notarization secrets (section 1) make it go away entirely |
| macOS app shows the wrong icon | `src-tauri/icons/icon.icns` is stale (it is generated separately from the PNG/ICO icons) | Regenerate with `npx tauri icon` from the master `icon.png` |
| `latest.json` missing | Updater plugin / pubkey not configured | `tauri.conf.json` plugins.updater |
| Updater always reports "up to date" | Release is still a draft or is flagged pre-release, so `/releases/latest/` skips it | Publish as the latest full release (see section 3) |
| “Resource not accessible” | Token scope | Repo workflow permissions |

---

## Related

- [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) — release status and ship checklist
- [DEVELOPMENT.md](./DEVELOPMENT.md) — local build and versioning
- `src-tauri/tauri.conf.json` — updater plugin config
- `.github/workflows/release.yml` — release workflow

Update this document when secret names, workflow variables, or signing requirements change.
