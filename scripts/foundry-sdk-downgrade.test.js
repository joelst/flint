import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Foundry 1.2.4 install over a newer SDK', () => {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const hooks = readFileSync(join(root, 'src-tauri', 'windows', 'hooks.nsh'), 'utf8');
  const wxs = readFileSync(
    join(root, 'src-tauri', 'windows', 'fragments', 'foundry-sdk-downgrade.wxs'),
    'utf8',
  );

  it('removes the installed SDK tree before NSIS copies 1.2.4', () => {
    expect(conf.bundle.windows.nsis.installerHooks).toBe('./windows/hooks.nsh');
    expect(hooks).toContain('!macro NSIS_HOOK_PREINSTALL');
    expect(hooks).toContain('CheckIfAppIsRunning');
    expect(hooks).toContain('Rename "$INSTDIR\\foundry-local-sdk" "$INSTDIR\\foundry-local-sdk.previous"');
    const preinstall = hooks.slice(hooks.indexOf('NSIS_HOOK_PREINSTALL'), hooks.indexOf('NSIS_HOOK_POSTINSTALL'));
    expect(preinstall).toContain('Call RestoreFoundrySdkBackup');
    expect(preinstall).toContain('foundry-local-sdk.previous-kept');
    expect(preinstall).toContain('The installed SDK was not changed.');
    expect(hooks).toContain('!define MUI_CUSTOMFUNCTION_ABORT RestoreFoundrySdkOnAbort');
    expect(hooks).toContain('prebuilds\\win32-arm64\\onnxruntime.dll');
    expect(hooks).toContain('foundry-local-core\\win32-arm64\\Microsoft.AI.Foundry.Local.Core.dll');
    expect(hooks).toContain('!macro NSIS_HOOK_POSTINSTALL');
    expect(hooks).toContain('foundry-local-sdk.failed');
    expect(hooks).toContain('rename foundry-local-sdk.previous to foundry-local-sdk');
    expect(hooks).toContain('Function .onInstFailed');
    expect(hooks).toContain('Abort');
    expect(hooks).toContain('SetOverwrite on');
  });

  it('removes the installed SDK tree before MSI InstallFiles', () => {
    expect(conf.bundle.windows.wix.fragmentPaths).toContain(
      './windows/fragments/foundry-sdk-downgrade.wxs',
    );
    expect(conf.bundle.windows.wix.componentRefs).toContain('FoundrySdkDowngradeMarker');
    expect(wxs).toContain('foundry-local-sdk.previous');
    expect(wxs).toContain('exit /b 1');
    expect(wxs).toContain('Execute="rollback"');
    expect(wxs).toContain('if exist &quot;foundry-local-sdk.previous&quot; exit /b 1');
    expect(wxs).toContain('Execute="commit"');
    expect(wxs).toContain('Id="MoveFoundrySdk"');
    const move = wxs.slice(wxs.indexOf('Id="MoveFoundrySdk"'), wxs.indexOf('Id="RestoreFoundrySdk"'));
    expect(move).toContain('foundry-local-core\\win32-arm64\\Microsoft.AI.Foundry.Local.Core.dll');
    expect(move).toContain('foundry-local-sdk.previous-kept');
    expect(wxs).toMatch(/Id="DiscardFoundryBackup"[\s\S]*Return="ignore"/);
    expect(wxs).toContain('Warning: foundry-local-sdk.previous could not be removed.');
    expect(wxs).toContain('Return="check"');
    expect(wxs).toContain('Directory="INSTALLDIR"');
    expect(wxs).not.toContain('[INSTALLDIR]');
    expect(wxs).toContain('Before="InstallFiles"');
    expect(wxs).toContain('Action="DiscardFoundryBackup" After="InstallFinalize"');
    expect(wxs).not.toContain('Before="InstallFinalize"');
  });
});

describe('light mode Check and Recheck', () => {
  const page = readFileSync(join(root, 'src', 'routes', '+page.svelte'), 'utf8');

  it('paints tiny buttons with the theme foreground so they stay visible on a white panel', () => {
    expect(page).toContain('button.tiny:not(.danger-btn)');
    expect(page).toMatch(/button\.tiny:not\(\.danger-btn\)\s*\{[^}]*color:\s*var\(--fg\)/s);
  });

  it('paints Recheck Providers on the panel fill with a visible border', () => {
    expect(page).toContain('class="secondary accel-recheck"');
    expect(page).toMatch(
      /button\.accel-recheck\s*\{[^}]*background:\s*var\(--panel-bg\);[^}]*color:\s*var\(--fg\);[^}]*border:\s*1px solid var\(--muted\);/s,
    );
  });
});
