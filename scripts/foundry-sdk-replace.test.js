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
    expect(hooks).toContain('Rename "$INSTDIR\\foundry-local-sdk" "$INSTDIR\\foundry-local-sdk.previous"');
    expect(hooks).toContain('prebuilds\\win32-arm64\\onnxruntime.dll');
    expect(hooks).toContain('foundry-local-core\\win32-arm64\\onnxruntime.dll');
    expect(hooks).toContain('!macro NSIS_HOOK_POSTINSTALL');
    expect(hooks).toContain('Function .onInstFailed');
    expect(hooks).toContain('Function .onUserAbort');
    expect(hooks).toContain('Abort');
    expect(hooks).toContain('SetOverwrite on');
  });

  it('removes the installed SDK tree before MSI InstallFiles', () => {
    expect(conf.bundle.windows.wix.fragmentPaths).toContain(
      './windows/fragments/foundry-sdk-replace.wxs',
    );
    expect(conf.bundle.windows.wix.componentRefs).toContain('FoundrySdkReplaceMarker');
    expect(wxs).toContain('foundry-local-sdk.previous');
    expect(wxs).toContain('exit /b 1');
    expect(wxs).toContain('Execute="rollback"');
    expect(wxs).toContain('Execute="commit"');
    expect(wxs).toContain('Id="MoveFoundrySdk"');
    expect(wxs).toContain('Return="check"');
    expect(wxs).toContain('Before="InstallFiles"');
  });

  it('never puts the install location on a command line', () => {
    for (const command of wxs.match(/ExeCommand="[^"]*"/g) ?? []) {
      expect(command.match(/\[[^\]]*\]/g) ?? []).toEqual(['[SystemFolder]']);
    }
    expect(wxs).toContain('Directory="INSTALLDIR"');
    expect(wxs).not.toContain('[INSTALLDIR]');
  });
});
