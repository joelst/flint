import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Foundry SDK install replaces the previous ONNX Runtime', () => {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const hooks = readFileSync(join(root, 'src-tauri', 'windows', 'hooks.nsh'), 'utf8');
  const wxs = readFileSync(
    join(root, 'src-tauri', 'windows', 'fragments', 'foundry-sdk-replace.wxs'),
    'utf8',
  );

  it('removes the installed SDK tree before NSIS copies this package', () => {
    expect(conf.bundle.windows.nsis.installerHooks).toBe('./windows/hooks.nsh');
    expect(hooks).toContain('!macro NSIS_HOOK_PREINSTALL');
    expect(hooks).toContain('CheckIfAppIsRunning');
    expect(hooks).toContain('RMDir /r "$INSTDIR\\foundry-local-sdk"');
    expect(hooks).toContain('SetOverwrite on');
  });

  it('removes the installed SDK tree before MSI InstallFiles', () => {
    expect(conf.bundle.windows.wix.fragmentPaths).toContain(
      './windows/fragments/foundry-sdk-replace.wxs',
    );
    expect(conf.bundle.windows.wix.componentRefs).toContain('FoundrySdkReplaceMarker');
    expect(wxs).toContain('rmdir /s /q');
    expect(wxs).toContain('[INSTALLDIR]foundry-local-sdk');
    expect(wxs).toContain('Before="InstallFiles"');
  });
});
