import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdExclusive } from '../src/test/hold-exclusive.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Command line after cmd.exe for each MSI custom action, XML-decoded, as
 * Windows Installer passes it to CreateProcess.
 * @param {string} wxs
 * @returns {Record<string, string>}
 */
function msiCommands (wxs) {
  const decode = (s) => s
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const commands = {};
  for (const [, body] of wxs.matchAll(/<CustomAction\b([^>]*)\/>/g)) {
    const id = body.match(/\bId="([^"]+)"/)?.[1];
    const exe = body.match(/\bExeCommand="([^"]*)"/)?.[1];
    expect(exe, `${id} has an ExeCommand`).toBeTruthy();
    const line = decode(exe);
    const prefix = '"[SystemFolder]cmd.exe" ';
    expect(line.startsWith(prefix), `${id} starts cmd.exe`).toBe(true);
    commands[id] = line.slice(prefix.length);
  }
  return commands;
}

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
    expect(preinstall).toContain('RMDir /r "$INSTDIR\\foundry-local-sdk.failed"');
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
    expect(wxs).toContain('Execute="commit"');
    const move = wxs.slice(wxs.indexOf('Id="MoveFoundrySdk"'), wxs.indexOf('Id="RestoreFoundrySdk"'));
    expect(move).toContain('foundry-local-core\\win32-arm64\\Microsoft.AI.Foundry.Local.Core.dll');
    expect(wxs).toMatch(/Id="DiscardFoundryBackup"[\s\S]*?Return="ignore"/);
    expect(wxs).toContain('Warning: foundry-local-sdk.previous could not be removed.');
    expect(wxs).toContain('Directory="INSTALLDIR"');
    expect(wxs).not.toContain('[INSTALLDIR]');
    expect(wxs).toContain('Action="RestoreFoundrySdk" Before="MoveFoundrySdk"');
    expect(wxs).toContain('Action="MoveFoundrySdk" Before="InstallFiles"');
    expect(wxs).toContain('Action="CheckFoundryRuntime" After="InstallFiles"');
    expect(wxs).toMatch(/Id="CheckFoundryRuntime"[\s\S]*?Execute="deferred"[\s\S]*?Return="check"/);
    // ICE77: a commit action outside InstallInitialize..InstallFinalize is
    // never written into the script. It still runs after the install commits.
    expect(wxs).toContain('Action="DiscardFoundryBackup" Before="InstallFinalize"');
    expect(wxs).not.toContain('After="InstallFinalize"');
    expect(wxs).toContain('<CreateFolder />');
    expect(Object.keys(msiCommands(wxs)).sort()).toEqual(
      ['CheckFoundryRuntime', 'DiscardFoundryBackup', 'MoveFoundrySdk', 'RestoreFoundrySdk'],
    );
  });

  it('restores only a backup this NSIS run moved aside', () => {
    const body = (name) => {
      const start = hooks.indexOf(`Function ${name}`);
      return hooks.slice(start, hooks.indexOf('FunctionEnd', start));
    };
    expect(hooks).toContain('Var FoundrySdkMovedAside');
    const preinstall = hooks.slice(hooks.indexOf('NSIS_HOOK_PREINSTALL'), hooks.indexOf('NSIS_HOOK_POSTINSTALL'));
    const liveRename = preinstall.indexOf('Rename "$INSTDIR\\foundry-local-sdk" "$INSTDIR\\foundry-local-sdk.previous"');
    expect(preinstall.indexOf('StrCpy $FoundrySdkMovedAside "1"')).toBeGreaterThan(liveRename);
    expect(preinstall.match(/StrCpy \$FoundrySdkMovedAside "1"/g)).toHaveLength(1);
    for (const handler of ['.onInstFailed', 'RestoreFoundrySdkOnAbort']) {
      const fn = body(handler);
      expect(fn.indexOf('StrCmp $FoundrySdkMovedAside "1"')).toBeGreaterThan(-1);
      expect(fn.indexOf('StrCmp $FoundrySdkMovedAside "1"')).toBeLessThan(fn.indexOf('Call RestoreFoundrySdkBackup'));
    }
    const postinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'));
    expect(postinstall.indexOf('StrCpy $FoundrySdkMovedAside ""'))
      .toBeLessThan(postinstall.indexOf('Call RestoreFoundrySdkBackup'));
    const keptRemoved = preinstall.indexOf('RMDir /r "$INSTDIR\\foundry-local-sdk.previous-kept"');
    expect(keptRemoved).toBeGreaterThan(-1);
    expect(keptRemoved).toBeLessThan(
      preinstall.indexOf('Rename "$INSTDIR\\foundry-local-sdk.previous" "$INSTDIR\\foundry-local-sdk.previous-kept"'),
    );
  });

  it('keeps NSIS backup ownership on disk, so a later run never judges a marked backup by one DLL', () => {
    const marker = '"$INSTDIR\\foundry-local-sdk.moved"';
    const section = (start, end) => hooks.slice(hooks.indexOf(start), hooks.indexOf(end, hooks.indexOf(start)));
    const preinstall = section('!macro NSIS_HOOK_PREINSTALL', '!macroend');
    // A marked backup goes to recovery before the one-DLL check runs.
    expect(preinstall.indexOf(`IfFileExists ${marker} foundry_sdk_recover`))
      .toBeLessThan(preinstall.indexOf('Call FoundryLiveRuntimeExists'));
    expect(preinstall.indexOf('foundry_sdk_recover:')).toBeLessThan(preinstall.indexOf('Call RestoreFoundrySdkBackup'));
    // Ownership is written and checked before the installed SDK moves, and dropped if it does not.
    const liveRename = preinstall.indexOf('Rename "$INSTDIR\\foundry-local-sdk" "$INSTDIR\\foundry-local-sdk.previous"');
    expect(preinstall.indexOf(`FileOpen $1 ${marker} w`)).toBeLessThan(liveRename);
    expect(preinstall.indexOf(`IfFileExists ${marker} foundry_sdk_owned`)).toBeLessThan(liveRename);
    expect(preinstall.indexOf(`Delete ${marker}`, liveRename)).toBeGreaterThan(liveRename);
    // A finished install drops it before trying to delete .previous.
    const postinstall = section('!macro NSIS_HOOK_POSTINSTALL', '!macroend');
    const ok = postinstall.slice(postinstall.indexOf('foundry_sdk_new_ok:'));
    expect(ok.indexOf(`Delete ${marker}`)).toBeGreaterThan(-1);
    expect(ok.indexOf(`Delete ${marker}`)).toBeLessThan(ok.indexOf('RMDir /r "$INSTDIR\\foundry-local-sdk.previous"'));
    // A restore drops it only once the backup is back; a stranded restore keeps it.
    const restore = section('Function RestoreFoundrySdkBackup', 'FunctionEnd');
    expect(restore.slice(restore.indexOf('restore_foundry_none:'), restore.indexOf('restore_foundry_ok:'))).toContain(`Delete ${marker}`);
    expect(restore.slice(restore.indexOf('restore_foundry_ok:'), restore.indexOf('restore_foundry_stranded:'))).toContain(`Delete ${marker}`);
    expect(restore.slice(restore.indexOf('restore_foundry_stranded:'))).not.toContain(marker);
  });

  it('removes the parked .failed tree once NSIS has finished or restored', () => {
    const removeFailed = 'RMDir /r "$INSTDIR\\foundry-local-sdk.failed"';
    const postinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'), hooks.indexOf('!macroend', hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL')));
    expect(postinstall.slice(postinstall.indexOf('foundry_sdk_new_ok:'))).toContain(removeFailed);
    const restore = hooks.slice(hooks.indexOf('Function RestoreFoundrySdkBackup'), hooks.indexOf('FunctionEnd', hooks.indexOf('Function RestoreFoundrySdkBackup')));
    const ok = restore.slice(restore.indexOf('restore_foundry_ok:'), restore.indexOf('restore_foundry_stranded:'));
    expect(ok).toContain(removeFailed);
    // A stranded restore changes nothing else, so it keeps the parked tree too.
    expect(restore.slice(restore.indexOf('restore_foundry_stranded:'))).not.toContain(removeFailed);
  });

  it('closes every WiX comment where it ends, with no stray text after it', () => {
    // A `-->` inside a comment still parses as XML: the rest becomes stray text in <Fragment>.
    for (const [, after] of wxs.matchAll(/-->([^<]*)</g)) {
      expect(after.trim()).toBe('');
    }
  });

  it('never waits on a message box in a silent install', () => {
    for (const line of hooks.split('\n').filter((l) => /^\s*MessageBox\b/.test(l))) {
      expect(line).toMatch(/\/SD IDOK\s*$/);
    }
  });

  // A string check cannot see cmd's grouping: everything after `if exist X`
  // on the same line, including later `&` commands, belongs to that `if`.
  // These run the real command lines the way Windows Installer starts them.
  describe.runIf(process.platform === 'win32')('MSI command lines against folder fixtures', () => {
    const commands = msiCommands(wxs);
    const SDK = 'foundry-local-sdk';
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flint-msi-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    const renameWhenFree = (from, to) => {
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(from, to);
          return;
        } catch (error) {
          if (attempt >= 100 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    };
    // An on-access scan of a just-written .dll briefly holds it, and `ren`
    // then reports Access is denied. A scan can start after the first free
    // rename, so wait for three in a row before the command runs.
    const settle = () => {
      for (let round = 0; round < 3; round++) {
        for (const name of readdirSync(dir)) {
          const from = join(dir, name);
          renameWhenFree(from, `${from}.settle`);
          renameWhenFree(`${from}.settle`, from);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    };
    const run = (id, { settled = true } = {}) => {
      if (settled) settle();
      return spawnSync(process.env.ComSpec || 'cmd.exe', [commands[id]], {
        cwd: dir,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      }).status;
    };
    // runtime: '2.0.1' is the 0.9.1 layout, '1.2.4' is this release's layout.
    const RUNTIME_FILE = {
      '2.0.1': join('prebuilds', 'win32-x64', 'onnxruntime.dll'),
      '1.2.4': join('foundry-local-core', 'win32-x64', 'Microsoft.AI.Foundry.Local.Core.dll'),
    };
    const tree = (name, tag, { runtime = '2.0.1' } = {}) => {
      const root = join(dir, name);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'tag.txt'), tag);
      if (runtime) {
        const file = join(root, RUNTIME_FILE[runtime]);
        mkdirSync(dirname(file), { recursive: true });
        // Empty, so an on-access scanner has nothing to hold open.
        writeFileSync(file, '');
      }
      return root;
    };
    const state = () => Object.fromEntries(readdirSync(dir).sort().map((name) => {
      const tag = join(dir, name, 'tag.txt');
      return [name, existsSync(tag) ? readFileSync(tag, 'utf8') : true];
    }));

    it('moves the installed 2.0.1 SDK aside and marks it as this install\'s copy', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [`${SDK}.moved`]: true, [`${SDK}.previous`]: 'installed' });
    });

    it('moves an installed 1.2.4 SDK aside on a reinstall of a newer build', () => {
      tree(SDK, 'installed', { runtime: '1.2.4' });
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [`${SDK}.moved`]: true, [`${SDK}.previous`]: 'installed' });
    });

    // The step that moves the installed SDK. Everything before it, including the ownership
    // marker, has to be in place before it runs.
    const MOVE_LIVE = `(if exist "${SDK}" ren "${SDK}" "${SDK}.previous")`;

    it('owns the backup before renaming anything', () => {
      const move = commands.MoveFoundrySdk;
      const owned = move.indexOf(`(if exist "${SDK}" if not exist "${SDK}.moved" exit /b 1)`);
      expect(owned).toBeGreaterThan(move.indexOf(`(if exist "${SDK}" type nul> "${SDK}.moved")`));
      expect(owned).toBeLessThan(move.indexOf(MOVE_LIVE));
      expect(owned).toBeLessThan(move.indexOf(`ren "${SDK}" "${SDK}.failed"`));
      // Nothing is left to mark after the move.
      expect(move.slice(move.indexOf(MOVE_LIVE))).not.toContain('type nul>');
    });

    it('rolls back when the move is the last thing that ran before the action died', () => {
      tree(SDK, 'installed');
      const move = commands.MoveFoundrySdk;
      const upToMove = move.slice(0, move.indexOf(MOVE_LIVE) + MOVE_LIVE.length);
      settle();
      spawnSync(process.env.ComSpec || 'cmd.exe', [upToMove], {
        cwd: dir, windowsVerbatimArguments: true, encoding: 'utf8',
      });
      expect(state()).toEqual({ [`${SDK}.moved`]: true, [`${SDK}.previous`]: 'installed' });
      expect(run('RestoreFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'installed' });
    });

    it('leaves no marker when the installed SDK cannot be moved', async () => {
      const live = tree(SDK, 'installed');
      settle();
      const release = await holdExclusive(join(live, RUNTIME_FILE['2.0.1']));
      try {
        expect(run('MoveFoundrySdk', { settled: false })).toBe(1);
        expect(state()).toEqual({ [SDK]: 'installed' });
        expect(run('RestoreFoundrySdk', { settled: false })).toBe(0);
        expect(state()).toEqual({ [SDK]: 'installed' });
      } finally {
        await release();
      }
    }, 30_000);

    it('does nothing on a first install', () => {
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({});
    });

    it('clears a leftover failed tree before moving the installed SDK', () => {
      tree(SDK, 'installed');
      tree(`${SDK}.failed`, 'partial');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [`${SDK}.moved`]: true, [`${SDK}.previous`]: 'installed' });
    });

    it('removes a leftover backup beside a working SDK instead of restoring it', () => {
      tree(SDK, 'installed', { runtime: '1.2.4' });
      tree(`${SDK}.previous`, 'leftover');
      tree(`${SDK}.previous-kept`, 'older leftover');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({
        [`${SDK}.moved`]: true,
        [`${SDK}.previous`]: 'installed',
        [`${SDK}.previous-kept`]: 'older leftover',
      });
    });

    it('keeps the recovery copy as the backup and parks a tree with no runtime at .failed', () => {
      tree(SDK, 'broken', { runtime: null });
      tree(`${SDK}.previous`, 'known good');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({
        [`${SDK}.failed`]: 'broken',
        [`${SDK}.moved`]: true,
        [`${SDK}.previous`]: 'known good',
      });
    });

    it('keeps a marked backup from an install that did not commit, even beside a runtime', () => {
      tree(SDK, 'partial new', { runtime: '1.2.4' });
      tree(`${SDK}.previous`, 'known good');
      writeFileSync(join(dir, `${SDK}.moved`), '');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({
        [`${SDK}.failed`]: 'partial new',
        [`${SDK}.moved`]: true,
        [`${SDK}.previous`]: 'known good',
      });
    });

    it('rolls back to the copy this install moved aside and removes the partial copy', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      tree(SDK, 'partial new', { runtime: '1.2.4' });
      expect(run('RestoreFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'installed' });
    });

    it('fails the install when the new tree has no runtime, so rollback restores the backup', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      tree(SDK, 'no runtime', { runtime: null });
      expect(run('CheckFoundryRuntime')).toBe(1);
      expect(run('RestoreFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'installed' });
    });

    it('removes the tree a recovery parked at .failed once that install commits', () => {
      tree(SDK, 'broken', { runtime: null });
      tree(`${SDK}.previous`, 'known good');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()[`${SDK}.failed`]).toBe('broken');
      tree(SDK, 'new', { runtime: '1.2.4' });
      expect(run('DiscardFoundryBackup')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'new' });
    });

    it('lets the install continue when the new 1.2.4 tree has its core', () => {
      tree(SDK, 'new', { runtime: '1.2.4' });
      expect(run('CheckFoundryRuntime')).toBe(0);
    });

    it('does not put an unmarked leftover backup over the installed SDK on rollback', () => {
      tree(SDK, 'installed');
      tree(`${SDK}.previous`, 'leftover');
      expect(run('RestoreFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'installed', [`${SDK}.previous`]: 'leftover' });
    });

    it('removes the backup, the marker, and a kept leftover once the install commits', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      tree(SDK, 'new', { runtime: '1.2.4' });
      tree(`${SDK}.previous-kept`, 'older leftover');
      expect(run('DiscardFoundryBackup')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'new' });
    });

    it('stops without changing the installed SDK when a leftover backup is locked, and rollback leaves it alone', async () => {
      tree(SDK, 'installed', { runtime: '1.2.4' });
      const leftover = tree(`${SDK}.previous`, 'leftover');
      settle();
      const release = await holdExclusive(join(leftover, RUNTIME_FILE['2.0.1']));
      try {
        expect(run('MoveFoundrySdk', { settled: false })).toBe(1);
        expect(run('RestoreFoundrySdk', { settled: false })).toBe(0);
        expect(state()[SDK]).toBe('installed');
        expect(existsSync(join(dir, `${SDK}.moved`))).toBe(false);
      } finally {
        await release();
      }
    }, 30_000);
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
