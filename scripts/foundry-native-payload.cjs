'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TRIPLE_TO_PLATFORM_KEY = {
  'x86_64-pc-windows-msvc': 'win32-x64',
  'x86_64-pc-windows-gnu': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
};

const INSTALLABLE_PLATFORM_KEYS = new Set([
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
]);

function platformKeyForTriple(triple) {
  return TRIPLE_TO_PLATFORM_KEY[triple] || null;
}

function readDependencies(sdkRoot) {
  const depsPath = path.join(sdkRoot, 'deps_versions.json');
  const deps = JSON.parse(fs.readFileSync(depsPath, 'utf8'));
  const ortVersion = deps?.onnxruntime?.version;
  const genaiVersion = deps?.['onnxruntime-genai']?.version;
  if (typeof ortVersion !== 'string' || typeof genaiVersion !== 'string') {
    throw new Error(`Invalid Foundry dependency metadata: ${depsPath}`);
  }
  return { ortVersion, genaiVersion };
}

function requiredNativeFiles(platformKey, dependencies) {
  const { ortVersion } = dependencies;
  const ortMajor = ortVersion.split('.')[0];
  if (!ortMajor) throw new Error(`Invalid ONNX Runtime version: ${ortVersion}`);

  const common = [
    { name: 'foundry_local_node.node', minBytes: 10_000, role: 'Node native addon' },
    { name: 'foundry_local_preload.node', minBytes: 10_000, role: 'native preload addon' },
  ];

  if (platformKey.startsWith('win32-')) {
    return [
      ...common,
      { name: 'foundry_local.dll', minBytes: 1_000_000, role: 'Foundry Local core' },
      { name: 'onnxruntime.dll', minBytes: 1_000_000, role: 'ONNX Runtime' },
      {
        name: 'onnxruntime_providers_shared.dll',
        minBytes: 10_000,
        role: 'ONNX Runtime shared provider bridge',
      },
      { name: 'onnxruntime-genai.dll', minBytes: 1_000_000, role: 'ONNX Runtime GenAI' },
      {
        name: 'Microsoft.Windows.AI.MachineLearning.dll',
        minBytes: 100_000,
        role: 'Windows AI Machine Learning runtime',
      },
    ];
  }
  if (platformKey === 'darwin-arm64') {
    return [
      ...common,
      { name: 'libfoundry_local.dylib', minBytes: 1_000_000, role: 'Foundry Local core' },
      {
        name: `libonnxruntime.${ortMajor}.dylib`,
        minBytes: 1_000_000,
        role: 'ONNX Runtime',
      },
      {
        name: 'libonnxruntime.dylib',
        minBytes: 1_000_000,
        role: 'ONNX Runtime unversioned alias',
        // The SDK installer symlinks this name at the versioned dylib. Tauri's
        // resource copy replaces that symlink with a regular file of the same
        // bytes (tauri-apps/tauri#13219). Either form can load.
        symlinkTo: `libonnxruntime.${ortMajor}.dylib`,
      },
      { name: 'libonnxruntime-genai.dylib', minBytes: 1_000_000, role: 'ONNX Runtime GenAI' },
    ];
  }
  if (platformKey.startsWith('linux-')) {
    return [
      ...common,
      { name: 'libfoundry_local.so', minBytes: 1_000_000, role: 'Foundry Local core' },
      { name: 'libonnxruntime.so.1', minBytes: 1_000_000, role: 'ONNX Runtime' },
      { name: 'libonnxruntime-genai.so', minBytes: 1_000_000, role: 'ONNX Runtime GenAI' },
    ];
  }
  throw new Error(`Unsupported Foundry platformKey: ${platformKey}`);
}

function inspectNativeFile(filePath) {
  try {
    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink()) {
      let size = 0;
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) size = stat.size;
      } catch {
        size = 0;
      }
      return { size, linkTarget: path.basename(fs.readlinkSync(filePath)) };
    }
    if (linkStat.isFile()) return { size: linkStat.size, linkTarget: null };
  } catch {
    // Missing. Reported with the rest of the payload.
  }
  return { size: 0, linkTarget: null };
}

function nativeFileProblem(file, inspected) {
  const { size, linkTarget } = inspected;
  if (linkTarget && file.symlinkTo && linkTarget !== file.symlinkTo) return 'wrong-link';
  if (size < file.minBytes) return size === 0 ? 'missing' : 'truncated';
  return null;
}

function describeInvalidNativeFile(file) {
  if (file.reason === 'missing') return 'missing';
  if (file.reason === 'wrong-link') {
    return `a symlink to ${file.linkTarget || 'nothing'}, not ${file.symlinkTo}`;
  }
  return `only ${file.size} bytes`;
}

function validateNativePayload(sdkRoot, platformKey) {
  const dependencies = readDependencies(sdkRoot);
  const platformDir = path.join(sdkRoot, 'prebuilds', platformKey);
  const files = requiredNativeFiles(platformKey, dependencies);
  const invalid = [];

  for (const file of files) {
    const filePath = path.join(platformDir, file.name);
    const inspected = inspectNativeFile(filePath);
    const reason = nativeFileProblem(file, inspected);
    if (reason) {
      invalid.push({ ...file, filePath, ...inspected, reason });
    }
  }

  return { dependencies, files, invalid, platformDir };
}

module.exports = {
  INSTALLABLE_PLATFORM_KEYS,
  describeInvalidNativeFile,
  platformKeyForTriple,
  readDependencies,
  requiredNativeFiles,
  validateNativePayload,
};
