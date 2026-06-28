# GitHub Repository Setup for Release Builds (MVP 0.3+)

This document describes the **GitHub-specific configuration** required to produce signed release artifacts and enable the Tauri updater for Flint.

It focuses on what must be done **inside the GitHub web UI or repo settings** (secrets, permissions, etc.). For local certificate generation steps, see [docs/RELEASE_SIGNING.md](./RELEASE_SIGNING.md).

## 1. Repository Permissions

Go to **Settings → Actions → General** (or the Actions permissions section).

- Under "Workflow permissions":
  - Select **"Read and write permissions"** (this allows the release workflow to create GitHub Releases and upload assets).
  - Alternatively, you can keep "Read repository contents permission" and rely on the explicit `permissions:` block in the workflow (we already added `contents: write`).

- Enable **"Allow GitHub Actions to create and approve pull requests"** only if you need it for other workflows (not required for releases).

- (Optional but recommended) Under "Artifact and log retention", set a reasonable default (e.g., 90 days).

## 2. Required Repository Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**.

You will need secrets for code signing. We recommend starting with **self-signed certificates** for the initial 0.3 pipeline (as documented in `RELEASE_SIGNING.md`).

### Windows Secrets
| Secret Name                    | Description                                      | How to obtain |
|--------------------------------|--------------------------------------------------|---------------|
| `WINDOWS_CERTIFICATE`          | Base64-encoded `.pfx` file (code signing cert)   | See `RELEASE_SIGNING.md` (PowerShell export) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the PFX file                        | The password you set when exporting the PFX |

### macOS Secrets (for codesign + optional notarization)
| Secret Name                    | Description                                      | How to obtain |
|--------------------------------|--------------------------------------------------|---------------|
| `APPLE_CERTIFICATE`            | Base64-encoded `.p12` / Developer ID certificate | Export from Keychain Access |
| `APPLE_CERTIFICATE_PASSWORD`   | Password for the `.p12` file                     | Password set during export |
| `APPLE_ID`                     | Your Apple ID email (for notarization)           | Apple Developer account |
| `APPLE_PASSWORD`               | App-specific password (for notarization)         | Generated at appleid.apple.com |
| `APPLE_TEAM_ID`                | Your Apple Team ID                               | Found in Apple Developer portal or `security find-identity` |

> **Tip for self-signed bootstrap**: You can start with only the Windows or Apple certificate secrets. Notarization (`xcrun notarytool`) can be skipped or made optional while using self-signed certs.

### Tauri Updater Signing Key (separate from OS code signing)
This is **required** for the updater feature (`plugins.updater`).

1. Locally (never commit the private key):
   ```bash
   npx tauri signer generate -w ~/.tauri/flint.key
   ```
   This creates a keypair. You will see output like:
   ```
   Public key: <long base64 string>
   ```

2. Copy the **public key** and put it into `src-tauri/tauri.conf.json`:
   ```json
   "plugins": {
     "updater": {
       "pubkey": "<paste the public key here>",
       ...
     }
   }
   ```

3. The **private key** should be kept offline or in a very secure secret store. For GitHub releases with the standard Tauri updater flow, you typically do **not** need to put the private key into GitHub Actions (the `latest.json` + signatures are generated as part of the build when the config is present). If you need manual signing later, store the private key securely outside the repo.

## 3. Workflow Permissions (already configured in YAML)

The release workflow (` .github/workflows/release.yml `) already declares:

```yaml
permissions:
  contents: write
```

This is the minimum needed for `tauri-apps/tauri-action` to:
- Create GitHub Releases
- Upload installer assets
- Upload updater metadata (`latest.json` + `.sig` files)

If you ever see "Resource not accessible by integration" errors when creating releases, double-check the repo-level "Workflow permissions" setting (step 1 above).

## 4. Testing the Pipeline Without a Real Tag

Use the `workflow_dispatch` input:

1. Go to **Actions → Release** in the GitHub UI.
2. Click **"Run workflow"**.
3. Enter a version (e.g. `0.3.0-test`).
4. Run it.

This will:
- Use the provided version instead of parsing a tag.
- Run the full build + signing (if secrets are present) + artifact upload steps.
- Create a draft release (if the action succeeds).

## 5. Full End-to-End Verification Steps

Once secrets are configured:

1. Create a throwaway tag (or use dispatch):
   ```bash
   git tag v0.3.0-test
   git push origin v0.3.0-test
   ```

2. Watch the **Release** workflow run.

3. Expected artifacts in the GitHub Release:
   - Windows: `*.msi`, `*-setup.exe`
   - macOS: `.dmg`, `.app` (zipped)
   - Updater metadata: `latest.json` + `*.sig` files (one per platform)

4. The built installers should contain the updater configuration (you can inspect the bundle or run the app and check the updater endpoint in settings if you later add UI).

## 6. Recommended GitHub Environment (Optional Hardening)

For production releases you may want to protect the release process:

1. Go to **Settings → Environments → New environment** → name it `release`.
2. Add required reviewers or deployment branches (e.g. only `main` or specific tags).
3. In the release workflow, add:
   ```yaml
   environment: release
   ```
   at the job level.

This is not required for the initial self-signed 0.3 pipeline.

## 7. Common Issues & Fixes

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| Workflow cannot create release | Missing `contents: write` | Add the permissions block (already done) + set repo Actions permissions to Read+Write |
| Signing steps skipped | Secrets not set or empty | Verify secret names match exactly (case sensitive) |
| macOS notarization fails | Missing Apple ID/app password or wrong team ID | Use app-specific password + correct team ID |
| Updater `latest.json` missing | `plugins.updater` not configured or build args wrong | Ensure config exists and workflow passes `--bundles ...updater` |
| "Resource not accessible" | GITHUB_TOKEN lacks scope | Use the explicit `permissions:` or increase repo workflow permissions |

## 8. Related Documentation

- [docs/RELEASE_SIGNING.md](./RELEASE_SIGNING.md) — How to generate self-signed (and real) certificates locally.
- [docs/MVP_0.3_REMAINING_IMPLEMENTATION_PLAN.md](./MVP_0.3_REMAINING_IMPLEMENTATION_PLAN.md) — Overall CI/CD plan and scope.
- `src-tauri/tauri.conf.json` — Contains the `plugins.updater` section.
- `.github/workflows/release.yml` — The actual release workflow.

## 9. Next Steps After Setup

- Run a test dispatch or tag.
- Once happy with self-signed artifacts, rotate to real EV / Apple Developer ID certificates.
- (Future) Add a simple "Check for updates" button in the app using `@tauri-apps/plugin-updater` (currently deferred until pre-1.0).

---

**Owner**: Update this document whenever you change secret names, workflow behavior, or add new signing requirements.