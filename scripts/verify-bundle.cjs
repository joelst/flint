// Simple verification for Tauri bundle resources
// Run after tauri build to check if SDK runtime files are included
const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, '..', 'src-tauri', 'target');

console.log('Verifying Foundry Local SDK bundling...');

// Check if build artifacts exist
const releaseDir = path.join(targetDir, 'release');
if (!fs.existsSync(releaseDir)) {
  console.log('No release build found. Run `npm run tauri:build` first.');
  process.exit(0);
}

console.log('Checking for bundled SDK resources...');

// Look for common bundle locations (platform dependent)
const bundlePaths = [
  path.join(releaseDir, 'bundle', 'msi'),  // Windows
  path.join(releaseDir, 'bundle', 'dmg'),  // mac
  path.join(releaseDir, 'bundle', 'appimage'), // linux
];

let found = false;
for (const p of bundlePaths) {
  if (fs.existsSync(p)) {
    console.log(`Found bundle dir: ${p}`);
    // Rough check for large files indicating core dll/node
    const files = fs.readdirSync(p, { recursive: true });
    const hasLarge = files.some(f => {
      try {
        const stat = fs.statSync(path.join(p, f));
        return stat.isFile() && stat.size > 10 * 1024 * 1024; // >10MB
      } catch { return false; }
    });
    if (hasLarge) {
      console.log('Likely includes large runtime files (SDK core).');
    }
    found = true;
  }
}

if (!found) {
  console.log('No standard bundle dirs found. Check target/release/bundle manually.');
}

console.log('Verification complete. Manually inspect the installer for foundry-local-core and prebuilds if needed.');
console.log('Note: In production, test on a clean machine without standalone Foundry Local installed.');