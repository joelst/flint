import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

/**
 * Open a file with no sharing, the way a loaded DLL blocks delete and rename.
 * Node opens files with delete sharing, so a child PowerShell holds the lock.
 * @param {string} file
 * @returns {Promise<() => Promise<void>>}
 */
function holdExclusive (file) {
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); `
    + "[Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $f.Close()";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('locked')) return;
      resolve(async () => {
        child.stdin.end('\n');
        await exited;
      });
    });
    exited.then((code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

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
    expect(hooks).toContain('CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe"');
    expect(hooks).toContain('Rename "$INSTDIR\\foundry-local-sdk" "$INSTDIR\\foundry-local-sdk.previous"');
    expect(hooks).toContain('prebuilds\\win32-x64\\onnxruntime.dll');
    expect(hooks).toContain('prebuilds\\win32-arm64\\onnxruntime.dll');
    expect(hooks).toContain('foundry-local-core\\win32-x64\\onnxruntime.dll');
    expect(hooks).toContain('foundry-local-core\\win32-arm64\\onnxruntime.dll');
    expect(hooks).not.toContain('win32-${ARCH}');
    const preinstall = hooks.slice(hooks.indexOf('NSIS_HOOK_PREINSTALL'), hooks.indexOf('NSIS_HOOK_POSTINSTALL'));
    expect(preinstall).toContain('Call RestoreFoundrySdkBackup');
    expect(preinstall).toContain('foundry-local-sdk.previous-kept');
    expect(preinstall).toContain('The installed SDK was not changed.');
    expect(preinstall).toContain('RMDir /r "$INSTDIR\\foundry-local-sdk.failed"');
    expect(hooks).toContain('!macro NSIS_HOOK_POSTINSTALL');
    expect(hooks).toContain('foundry-local-sdk.failed');
    expect(hooks).toContain('rename foundry-local-sdk.previous to foundry-local-sdk');
    expect(hooks).toContain('Function .onInstFailed');
    expect(hooks).toContain('!define MUI_CUSTOMFUNCTION_ABORT RestoreFoundrySdkOnAbort');
    expect(hooks).toContain('Function RestoreFoundrySdkOnAbort');
    expect(hooks).not.toContain('Function .onUserAbort');
    expect(hooks).toContain('Abort');
    expect(hooks).toContain('SetOverwrite on');
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

  it('never waits on a message box in a silent install', () => {
    for (const line of hooks.split('\n').filter((l) => /^\s*MessageBox\b/.test(l))) {
      expect(line).toMatch(/\/SD IDOK\s*$/);
    }
  });

  it('removes the installed SDK tree before MSI InstallFiles', () => {
    expect(conf.bundle.windows.wix.fragmentPaths).toContain(
      './windows/fragments/foundry-sdk-replace.wxs',
    );
    expect(conf.bundle.windows.wix.componentRefs).toContain('FoundrySdkReplaceMarker');
    expect(wxs).toContain('Execute="rollback"');
    expect(wxs).toContain('Execute="commit"');
    expect(wxs).toMatch(/Id="DiscardFoundryBackup"[\s\S]*Return="check"/);
    expect(wxs).toContain('Action="RestoreFoundrySdk" Before="MoveFoundrySdk"');
    expect(wxs).toContain('Action="MoveFoundrySdk" Before="InstallFiles"');
    expect(wxs).toContain('Action="DiscardFoundryBackup" Before="InstallFinalize"');
    expect(wxs).not.toContain('After="InstallFinalize"');
    expect(wxs).toContain('<CreateFolder />');
    expect(wxs).toContain('Action="CheckFoundryRuntime" After="InstallFiles"');
    expect(wxs).toMatch(/Id="CheckFoundryRuntime"[\s\S]*?Execute="deferred"[\s\S]*?Return="check"/);
    expect(Object.keys(msiCommands(wxs)).sort()).toEqual(
      ['CheckFoundryRuntime', 'DiscardFoundryBackup', 'MoveFoundrySdk', 'RestoreFoundrySdk'],
    );
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

    // An on-access scan of a just-written .dll briefly holds it, and `ren`
    // then reports Access is denied. Wait until each fixture folder can be
    // renamed before the command runs, so a failure is the command's own.
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
    // A scan of a new file can start after the first free rename, so wait
    // for three in a row.
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
    const tree = (name, tag, { runtime = true } = {}) => {
      const root = join(dir, name);
      mkdirSync(join(root, 'prebuilds', 'win32-x64'), { recursive: true });
      writeFileSync(join(root, 'tag.txt'), tag);
      // Empty, so an on-access scanner has nothing to hold open.
      if (runtime) writeFileSync(join(root, 'prebuilds', 'win32-x64', 'onnxruntime.dll'), '');
      return root;
    };
    const state = () => Object.fromEntries(readdirSync(dir).sort().map((name) => {
      const tag = join(dir, name, 'tag.txt');
      return [name, existsSync(tag) ? readFileSync(tag, 'utf8') : true];
    }));

    it('moves the installed SDK aside on an upgrade and marks it as this install\'s copy', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [`${SDK}.moved`]: true, [`${SDK}.previous`]: 'installed' });
    });

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
      tree(SDK, 'installed');
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
      tree(SDK, 'broken', { runtime: false });
      tree(`${SDK}.previous`, 'known good');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({
        [`${SDK}.failed`]: 'broken',
        [`${SDK}.moved`]: true,
        [`${SDK}.previous`]: 'known good',
      });
    });

    it('keeps a marked backup from an install that did not commit, even beside a runtime', () => {
      tree(SDK, 'partial new');
      tree(`${SDK}.previous`, 'known good');
      writeFileSync(join(dir, `${SDK}.moved`), '');
      expect(run('MoveFoundrySdk')).toBe(0);
      expect(state()).toEqual({
        [`${SDK}.failed`]: 'partial new',
        [`${SDK}.moved`]: true,
        [`${SDK}.previous`]: 'known good',
      });
    });

    it('rolls back to the copy this install moved aside', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      tree(SDK, 'partial new');
      expect(run('RestoreFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'installed', [`${SDK}.failed`]: 'partial new' });
    });

    it('fails the install when the new tree has no runtime, so rollback restores the backup', () => {
      tree(SDK, 'installed');
      expect(run('MoveFoundrySdk')).toBe(0);
      tree(SDK, 'no runtime', { runtime: false });
      expect(run('CheckFoundryRuntime')).toBe(1);
      expect(run('RestoreFoundrySdk')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'installed', [`${SDK}.failed`]: 'no runtime' });
    });

    it('lets the install continue when the new tree has a runtime', () => {
      tree(SDK, 'new');
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
      tree(SDK, 'new');
      tree(`${SDK}.previous-kept`, 'older leftover');
      expect(run('DiscardFoundryBackup')).toBe(0);
      expect(state()).toEqual({ [SDK]: 'new' });
    });

    it('stops without changing the installed SDK when a leftover backup is locked, and rollback leaves it alone', async () => {
      tree(SDK, 'installed');
      const leftover = tree(`${SDK}.previous`, 'leftover');
      settle();
      const release = await holdExclusive(join(leftover, 'prebuilds', 'win32-x64', 'onnxruntime.dll'));
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

  it('never puts the install location on a command line', () => {
    for (const command of wxs.match(/ExeCommand="[^"]*"/g) ?? []) {
      expect(command.match(/\[[^\]]*\]/g) ?? []).toEqual(['[SystemFolder]']);
    }
    expect(wxs).toContain('Directory="INSTALLDIR"');
    expect(wxs).not.toContain('[INSTALLDIR]');
  });
});
