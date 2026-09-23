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
    expect(hooks).toContain('RMDir /r "$INSTDIR\\foundry-local-sdk"');
    expect(hooks).toContain('SetOverwrite on');
  });

  it('removes the installed SDK tree before MSI InstallFiles', () => {
    expect(conf.bundle.windows.wix.fragmentPaths).toContain(
      './windows/fragments/foundry-sdk-downgrade.wxs',
    );
    expect(conf.bundle.windows.wix.componentRefs).toContain('FoundrySdkDowngradeMarker');
    expect(wxs).toContain('rmdir /s /q');
    expect(wxs).toContain('[INSTALLDIR]foundry-local-sdk');
    expect(wxs).toContain('Before="InstallFiles"');
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
