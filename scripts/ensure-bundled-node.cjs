// Download a pinned Node.js binary and stage it as a Tauri externalBin sidecar.
//
// Output (gitignored):
//   src-tauri/binaries/node-<target-triple>[.exe]
//   src-tauri/binaries/node.VERSION
//
// Usage:
//   node scripts/ensure-bundled-node.cjs
//   node scripts/ensure-bundled-node.cjs --target x86_64-pc-windows-msvc
//   node scripts/ensure-bundled-node.cjs --force
//
// Env:
//   NODE_BUNDLE_VERSION=22.18.0
//   NODE_BUNDLE_DOWNLOAD_TIMEOUT_MS=120000  (per request; default 120s)
//   TAURI_ENV_TARGET_TRIPLE when set by `tauri build --target …`
//
// Security:
//   - HTTPS only (including redirects); never follows http://
//   - Per-request timeout
//   - Verifies archive SHA-256 against official SHASUMS256.txt before extract

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { execFileSync, spawnSync } = require('child_process');
const { createWriteStream } = require('fs');

const root = path.resolve(__dirname, '..');
const binariesDir = path.join(root, 'src-tauri', 'binaries');
const stagingRoot = path.join(root, 'runtime', 'node-staging');

/** Pinned Node 22 LTS line for the spike (override with NODE_BUNDLE_VERSION). */
const DEFAULT_NODE_VERSION = process.env.NODE_BUNDLE_VERSION || '22.18.0';

/** Per HTTPS request timeout (ms). Large archives need headroom on slow links. */
const DOWNLOAD_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.NODE_BUNDLE_DOWNLOAD_TIMEOUT_MS) || 120_000,
);

const MAX_REDIRECTS = 5;

const TRIPLE_TO_NODE_DIST = {
  'x86_64-pc-windows-msvc': { dist: 'win-x64', archive: 'zip', binary: 'node.exe', outExt: '.exe' },
  'aarch64-pc-windows-msvc': { dist: 'win-arm64', archive: 'zip', binary: 'node.exe', outExt: '.exe' },
  'x86_64-apple-darwin': { dist: 'darwin-x64', archive: 'tar.gz', binary: 'bin/node', outExt: '' },
  'aarch64-apple-darwin': { dist: 'darwin-arm64', archive: 'tar.gz', binary: 'bin/node', outExt: '' },
  'x86_64-unknown-linux-gnu': { dist: 'linux-x64', archive: 'tar.xz', binary: 'bin/node', outExt: '' },
  'aarch64-unknown-linux-gnu': { dist: 'linux-arm64', archive: 'tar.xz', binary: 'bin/node', outExt: '' },
};

function hostTriple() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  throw new Error(`Unsupported host for bundled Node: ${platform}-${arch}`);
}

function parseArgs(argv) {
  let target = process.env.TAURI_ENV_TARGET_TRIPLE || null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--target' && argv[i + 1]) {
      target = argv[++i];
    } else if (a.startsWith('--target=')) {
      target = a.slice('--target='.length);
    }
  }
  return { target: target || hostTriple(), force };
}

function distUrl(version, distKey, archive) {
  const base = `node-v${version}-${distKey}`;
  const file = archive === 'zip' ? `${base}.zip` : `${base}.${archive}`;
  return {
    url: `https://nodejs.org/dist/v${version}/${file}`,
    shasumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    fileName: file,
    folderName: base,
  };
}

/**
 * Parse and require an absolute https: URL. Rejects http and other schemes.
 * @returns {URL}
 */
function assertHttpsUrl(urlString, context) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL (${context}): ${urlString}`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(
      `Refusing non-HTTPS URL (${context}): ${urlString} (protocol=${u.protocol})`,
    );
  }
  return u;
}

/**
 * HTTPS GET to a file on disk. Follows redirects only when the next hop is HTTPS.
 */
function downloadHttpsToFile(urlString, dest, redirectCount = 0) {
  const u = assertHttpsUrl(urlString, 'download');
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many HTTPS redirects (>${MAX_REDIRECTS}) for ${urlString}`));
  }

  return new Promise((resolve, reject) => {
    const req = https.get(
      u,
      {
        headers: { 'User-Agent': 'flint-ensure-bundled-node' },
        timeout: DOWNLOAD_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let nextHref;
          try {
            nextHref = new URL(res.headers.location, u).href;
          } catch {
            reject(new Error(`Bad redirect Location from ${urlString}: ${res.headers.location}`));
            return;
          }
          // Enforce HTTPS on the resolved redirect target before following.
          try {
            assertHttpsUrl(nextHref, 'redirect');
          } catch (e) {
            reject(e);
            return;
          }
          downloadHttpsToFile(nextHref, dest, redirectCount + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${urlString} → HTTP ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close((err) => (err ? reject(err) : resolve(dest))));
        out.on('error', reject);
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${urlString}`));
    });
    req.on('error', reject);
  });
}

/**
 * HTTPS GET entire body as utf8 string (for SHASUMS256.txt).
 */
function downloadHttpsText(urlString, redirectCount = 0) {
  const u = assertHttpsUrl(urlString, 'download-text');
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many HTTPS redirects (>${MAX_REDIRECTS}) for ${urlString}`));
  }

  return new Promise((resolve, reject) => {
    const req = https.get(
      u,
      {
        headers: { 'User-Agent': 'flint-ensure-bundled-node' },
        timeout: DOWNLOAD_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let nextHref;
          try {
            nextHref = new URL(res.headers.location, u).href;
          } catch {
            reject(new Error(`Bad redirect Location from ${urlString}: ${res.headers.location}`));
            return;
          }
          try {
            assertHttpsUrl(nextHref, 'redirect');
          } catch (e) {
            reject(e);
            return;
          }
          downloadHttpsText(nextHref, redirectCount + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${urlString} → HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${urlString}`));
    });
    req.on('error', reject);
  });
}

/** SHA-256 hex digest of a file (streaming). */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Parse official SHASUMS256.txt and return expected hex digest for fileName.
 * Lines: `<64-hex>  <filename>` (two spaces per Node dist convention).
 */
function expectedSha256FromSums(sumsText, fileName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64})\s+(\S+)\s*$/);
    if (m && m[2] === fileName) {
      return m[1].toLowerCase();
    }
  }
  throw new Error(`No SHASUMS256 entry for ${fileName}`);
}

function verifyArchiveSha256(archivePath, fileName, sumsText) {
  const expected = expectedSha256FromSums(sumsText, fileName);
  const actual = sha256File(archivePath);
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${fileName}: expected ${expected}, got ${actual}. Refusing to extract.`,
    );
  }
  return expected;
}

function extractZipWindows(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
}

function extractTar(archivePath, destDir, kind) {
  fs.mkdirSync(destDir, { recursive: true });
  const args =
    kind === 'tar.xz'
      ? ['-xJf', archivePath, '-C', destDir]
      : ['-xzf', archivePath, '-C', destDir];
  const r = spawnSync('tar', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`tar extract failed for ${archivePath} (exit ${r.status})`);
  }
}

function outputBinaryPath(triple, outExt) {
  return path.join(binariesDir, `node-${triple}${outExt}`);
}

function alreadyStaged(outPath, version) {
  if (!fs.existsSync(outPath)) return false;
  const verFile = path.join(binariesDir, 'node.VERSION');
  if (!fs.existsSync(verFile)) return false;
  const staged = fs.readFileSync(verFile, 'utf8').trim();
  return staged === version;
}

async function main() {
  const { target, force } = parseArgs(process.argv.slice(2));
  const version = DEFAULT_NODE_VERSION;
  const mapping = TRIPLE_TO_NODE_DIST[target];
  if (!mapping) {
    console.error(`Unknown target triple: ${target}`);
    console.error(`Supported: ${Object.keys(TRIPLE_TO_NODE_DIST).join(', ')}`);
    process.exit(1);
  }

  const outPath = outputBinaryPath(target, mapping.outExt);
  fs.mkdirSync(binariesDir, { recursive: true });

  if (!force && alreadyStaged(outPath, version)) {
    const st = fs.statSync(outPath);
    console.log(
      `Bundled Node already staged: ${path.relative(root, outPath)} (${(st.size / (1024 * 1024)).toFixed(1)} MB, v${version})`,
    );
    return;
  }

  const { url, shasumsUrl, fileName, folderName } = distUrl(
    version,
    mapping.dist,
    mapping.archive,
  );
  fs.mkdirSync(stagingRoot, { recursive: true });
  const archivePath = path.join(stagingRoot, fileName);
  const extractDir = path.join(stagingRoot, `extract-${target}`);
  const sumsPath = path.join(stagingRoot, `SHASUMS256-v${version}.txt`);

  console.log(`Fetching Node v${version} for ${target}…`);
  console.log(`  archive:  ${url}`);
  console.log(`  checksum: ${shasumsUrl}`);
  console.log(`  timeout:  ${DOWNLOAD_TIMEOUT_MS}ms per request (HTTPS only)`);

  console.log('  downloading SHASUMS256.txt…');
  const sumsText = await downloadHttpsText(shasumsUrl);
  fs.writeFileSync(sumsPath, sumsText, 'utf8');

  console.log(`  downloading ${fileName}…`);
  await downloadHttpsToFile(url, archivePath);
  const archMb = fs.statSync(archivePath).size / (1024 * 1024);
  console.log(`  downloaded ${archMb.toFixed(1)} MB → ${path.relative(root, archivePath)}`);

  const digest = verifyArchiveSha256(archivePath, fileName, sumsText);
  console.log(`  ✓ SHA-256 verified (${digest.slice(0, 12)}…)`);

  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });

  if (mapping.archive === 'zip') {
    if (process.platform === 'win32') {
      extractZipWindows(archivePath, extractDir);
    } else {
      const r = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new Error('Failed to extract Node zip (need unzip/tar)');
      }
    }
  } else {
    extractTar(archivePath, extractDir, mapping.archive);
  }

  const extractedBinary = path.join(extractDir, folderName, mapping.binary);
  const altBinary = path.join(extractDir, mapping.binary);
  let sourceBinary = null;
  if (fs.existsSync(extractedBinary)) sourceBinary = extractedBinary;
  else if (fs.existsSync(altBinary)) sourceBinary = altBinary;
  else {
    const walk = (dir, depth) => {
      if (depth > 3 || sourceBinary) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isFile() && (ent.name === 'node.exe' || ent.name === 'node')) {
          sourceBinary = p;
          return;
        }
        if (ent.isDirectory()) walk(p, depth + 1);
      }
    };
    walk(extractDir, 0);
  }

  if (!sourceBinary || !fs.existsSync(sourceBinary)) {
    console.error(`Could not find Node binary inside archive (looked for ${mapping.binary})`);
    process.exit(1);
  }

  fs.copyFileSync(sourceBinary, outPath);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(outPath, 0o755);
    } catch {
      /* ignore */
    }
  }

  fs.writeFileSync(path.join(binariesDir, 'node.VERSION'), `${version}\n`, 'utf8');
  fs.writeFileSync(
    path.join(binariesDir, 'node.README.txt'),
    [
      'Generated by scripts/ensure-bundled-node.cjs — do not commit node-* binaries.',
      `Node version: ${version}`,
      `Target: ${target}`,
      `Archive SHA-256: ${digest}`,
      'Tauri externalBin name: binaries/node',
      'Download: HTTPS-only + SHASUMS256 verify',
      '',
    ].join('\n'),
    'utf8',
  );

  const outMb = fs.statSync(outPath).size / (1024 * 1024);
  console.log(`Staged ${path.relative(root, outPath)} (${outMb.toFixed(1)} MB)`);
  console.log('Done. Tauri externalBin key: binaries/node');
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
