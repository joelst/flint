// End-to-end coverage for the BYOM import path.
//
// These tests drive the real sidecar over its JSON-lines protocol and then ask the real
// Foundry SDK whether the imported model is discoverable. That last step is the point:
// unit tests can prove Flint writes the files it intends to, but only the native scanner
// can prove those files add up to a model Foundry will load.
//
// Everything happens under a throwaway appName, so the developer's own ~/.flint is never
// touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const APP = `flint-byom-test-${process.pid}`;
const appHome = path.join(os.homedir(), `.${APP}`);
const cacheRoot = path.join(appHome, 'cache', 'models');
const libraryPath = path.resolve(
  'node_modules/foundry-local-sdk/foundry-local-core/win32-x64/Microsoft.AI.Foundry.Local.Core.dll',
);

let proc: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function send(cmd: string, payload: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
  });
}

/** A synthetic repo shaped like a real HF ONNX export: nested, no inference_model.json. */
function makeSourceRepo(options: { nested?: boolean; chatTemplate?: string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byom-src-'));
  const dir = options.nested === false ? root : path.join(root, 'onnx');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'genai_config.json'),
    JSON.stringify({ model: { type: 'qwen3', context_length: 4096, decoder: { filename: 'model.onnx' } } }),
  );
  fs.writeFileSync(path.join(dir, 'model.onnx'), Buffer.alloc(1024, 7));
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{"version":"1.0"}');
  const tpl = options.chatTemplate === undefined ? '<|im_start|>user\n{{ x }}<|im_end|>' : options.chatTemplate;
  if (tpl !== null) fs.writeFileSync(path.join(dir, 'chat_template.jinja'), tpl);
  return root;
}

const tempDirs: string[] = [];
function track(dir: string) { tempDirs.push(dir); return dir; }

beforeAll(async () => {
  proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 15000);
    const probe = readline.createInterface({ input: proc.stderr });
    probe.on('line', () => {});
    const check = setInterval(() => {
      if (proc.pid) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });
  // init binds the cache root to our throwaway appName.
  await send('init', { appName: APP, logLevel: 'error' });
}, 60000);

afterAll(() => {
  if (proc && !proc.killed) proc.kill();
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(appHome, { recursive: true, force: true }); } catch {}
});

describe('BYOM inspect', () => {
  it('accepts a nested HF-style export and reads its metadata', async () => {
    const src = track(makeSourceRepo());
    const res = await send('inspectModelFolder', { folderPath: src });
    expect(res.ok).toBe(true);
    expect(res.result.ok).toBe(true);
    expect(res.result.nested).toBe(true);
    expect(res.result.detected.architecture).toBe('qwen3');
    expect(res.result.detected.contextLength).toBe(4096);
    expect(res.result.detected.templateConfident).toBe(true);
  });

  it('rejects a GGUF folder with an explicit reason', async () => {
    const bad = track(fs.mkdtempSync(path.join(os.tmpdir(), 'byom-bad-')));
    fs.writeFileSync(path.join(bad, 'model.gguf'), 'x');
    const res = await send('inspectModelFolder', { folderPath: bad });
    expect(res.ok).toBe(true);
    expect(res.result.ok).toBe(false);
    expect(JSON.stringify(res.result.reasons)).toMatch(/genai_config/);
  });

  it('errors on a folder that does not exist', async () => {
    const res = await send('inspectModelFolder', { folderPath: path.join(os.tmpdir(), 'definitely-not-here-xyz') });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/does not exist/i);
  });
});

describe('BYOM import', () => {
  it('imports, authors inference_model.json, and leaves no staging directory', async () => {
    const src = track(makeSourceRepo());
    const res = await send('importModelFolder', { folderPath: src, name: 'imported-a' });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const dir = res.result.path;
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(path.dirname(dir)).some((n) => n.startsWith('.staging'))).toBe(false);

    const inf = JSON.parse(fs.readFileSync(path.join(dir, 'v1', 'inference_model.json'), 'utf8'));
    expect(inf.Name).toBe('imported-a:1');
    expect(inf.PromptTemplate.user).toContain('<|im_start|>');

    // Ownership marker is what lets Flint know it may delete this directory later.
    expect(fs.existsSync(path.join(dir, '.flint-import.json'))).toBe(true);
  });

  it('refuses to overwrite an existing model', async () => {
    const src = track(makeSourceRepo());
    await send('importModelFolder', { folderPath: src, name: 'imported-dup' });
    const again = await send('importModelFolder', { folderPath: src, name: 'imported-dup' });
    expect(again.ok).toBeFalsy();
    expect(String(again.error)).toMatch(/already exists/i);
  });

  it('refuses a source folder that already lives in the cache', async () => {
    const src = track(makeSourceRepo());
    const first = await send('importModelFolder', { folderPath: src, name: 'imported-b' });
    expect(first.ok).toBe(true);
    const res = await send('importModelFolder', { folderPath: first.result.path, name: 'imported-b-copy' });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/already inside/i);
  });

  it('sanitizes a traversal name instead of escaping the cache root', async () => {
    const src = track(makeSourceRepo());
    const res = await send('importModelFolder', { folderPath: src, name: '../../escape-attempt' });
    expect(res.ok).toBe(true);
    const rel = path.relative(path.resolve(cacheRoot), path.resolve(res.result.path));
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
  });

  it('leaves nothing behind when validation fails', async () => {
    const bad = track(fs.mkdtempSync(path.join(os.tmpdir(), 'byom-bad2-')));
    fs.writeFileSync(path.join(bad, 'readme.md'), 'not a model');
    const res = await send('importModelFolder', { folderPath: bad, name: 'should-not-exist' });
    expect(res.ok).toBeFalsy();
    const publisherDir = path.join(cacheRoot, 'Imported');
    if (fs.existsSync(publisherDir)) {
      expect(fs.readdirSync(publisherDir).some((n) => n.includes('should-not-exist'))).toBe(false);
    }
  });

  it('rejects an unknown field on the command', async () => {
    const res = await send('importModelFolder', { folderPath: 'x', name: 'y', evil: 1 });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/unknown field/i);
  });

  it('rejects a non-integer version', async () => {
    const res = await send('importModelFolder', { folderPath: 'x', name: 'y', version: 1.5 });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/positive integer/i);
  });
});

describe('BYOM link', () => {
  it('refuses to link a folder lacking inference_model.json', async () => {
    // Linking must never write to the source, so it cannot author the missing file.
    const src = track(makeSourceRepo());
    const res = await send('linkModelFolder', { folderPath: src, name: 'linked-a' });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/no inference_model\.json/i);
  });

  it('links a complete model without copying or modifying the source', async () => {
    const src = track(makeSourceRepo({ nested: false }));
    fs.writeFileSync(
      path.join(src, 'inference_model.json'),
      JSON.stringify({ Name: 'linked-b:1', PromptTemplate: { user: '<|im_start|>user\n{Content}<|im_end|>' } }),
    );
    const before = fs.readdirSync(src).sort();

    const res = await send('linkModelFolder', { folderPath: src, name: 'linked-b' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(fs.existsSync(res.result.linkPath)).toBe(true);
    expect(fs.lstatSync(res.result.linkPath).isSymbolicLink()).toBe(true);

    // The source must be untouched: no marker file, no metadata rewrite.
    expect(fs.readdirSync(src).sort()).toEqual(before);
  });
});

describe('BYOM discovery by the Foundry SDK', () => {
  it('surfaces an imported model as a Local provider resolvable by alias', async () => {
    const src = track(makeSourceRepo());
    const imported = await send('importModelFolder', { folderPath: src, name: 'discoverable-model' });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);

    const { FoundryLocalManager } = await import('foundry-local-sdk');
    const mgr = (FoundryLocalManager as any).create({ appName: APP, logLevel: 'error', libraryPath });
    const cached = await mgr.catalog.getCachedModels();

    const found = cached.find((m: any) => String(m.id).startsWith('discoverable-model'));
    expect(found, `cached: ${cached.map((m: any) => m.id).join(', ')}`).toBeTruthy();
    expect(found.info.providerType).toBe('Local');
    expect(found.info.uri).toBe('local://discoverable-model');

    const byAlias = await mgr.catalog.getModel('discoverable-model');
    expect(byAlias.id).toBe('discoverable-model:1');
  }, 60000);
});

describe('BYOM prompt template editing', () => {
  const custom = {
    system: '[SYS]{Content}[/SYS]',
    user: '[U]{Content}[/U]',
    assistant: '[A]{Content}[/A]',
    prompt: '[U]{Content}[/U][A]',
  };

  it('honours a template supplied at import time', async () => {
    const src = track(makeSourceRepo());
    const res = await send('importModelFolder', { folderPath: src, name: 'tpl-import', promptTemplate: custom });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const inf = JSON.parse(fs.readFileSync(path.join(res.result.path, 'v1', 'inference_model.json'), 'utf8'));
    expect(inf.PromptTemplate).toEqual(custom);
    expect(res.result.templateSource).toBe('user-supplied');
  });

  it('rejects an invalid template at import time and imports nothing', async () => {
    const src = track(makeSourceRepo());
    const res = await send('importModelFolder', {
      folderPath: src,
      name: 'tpl-invalid',
      promptTemplate: { ...custom, user: 'no placeholder' },
    });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/\{Content\}/);
    expect(fs.existsSync(path.join(cacheRoot, 'Imported', 'tpl-invalid'))).toBe(false);
  });

  it('reads back the template of an imported model along with the presets', async () => {
    const src = track(makeSourceRepo());
    await send('importModelFolder', { folderPath: src, name: 'tpl-read' });
    const res = await send('getModelTemplate', { name: 'tpl-read' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.result.modelName).toBe('tpl-read:1');
    expect(res.result.promptTemplate.user).toContain('{Content}');
    expect(Object.keys(res.result.presets)).toContain('chatml');
  });

  it('rewrites the template and the SDK still resolves the model', async () => {
    const src = track(makeSourceRepo());
    await send('importModelFolder', { folderPath: src, name: 'tpl-write' });

    const res = await send('setModelTemplate', { name: 'tpl-write', promptTemplate: custom });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const readBack = await send('getModelTemplate', { name: 'tpl-write' });
    expect(readBack.result.promptTemplate).toEqual(custom);
    expect(readBack.result.templateSource).toBe('user-edited');

    // The Name field must survive the rewrite, or the scanner drops the model.
    const { FoundryLocalManager } = await import('foundry-local-sdk');
    const mgr = (FoundryLocalManager as any).create({ appName: APP, logLevel: 'error', libraryPath });
    const byAlias = await mgr.catalog.getModel('tpl-write');
    expect(byAlias.id).toBe('tpl-write:1');
  }, 60000);

  it('leaves the previous template intact when the new one is invalid', async () => {
    const src = track(makeSourceRepo());
    await send('importModelFolder', { folderPath: src, name: 'tpl-guard' });
    const before = await send('getModelTemplate', { name: 'tpl-guard' });

    const res = await send('setModelTemplate', {
      name: 'tpl-guard',
      promptTemplate: { ...custom, assistant: '' },
    });
    expect(res.ok).toBeFalsy();

    const after = await send('getModelTemplate', { name: 'tpl-guard' });
    expect(after.result.promptTemplate).toEqual(before.result.promptTemplate);
  });

  it('refuses to edit a linked model, whose files belong to the user', async () => {
    const src = track(makeSourceRepo({ nested: false }));
    fs.writeFileSync(
      path.join(src, 'inference_model.json'),
      JSON.stringify({ Name: 'linked-tpl:1', PromptTemplate: { user: '<|im_start|>user\n{Content}<|im_end|>' } }),
    );
    const linked = await send('linkModelFolder', { folderPath: src, name: 'linked-tpl' });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);

    const res = await send('setModelTemplate', { name: 'linked-tpl', promptTemplate: custom });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/only models imported by flint/i);

    // The user's own file must be byte-identical after the refusal.
    const inf = JSON.parse(fs.readFileSync(path.join(src, 'inference_model.json'), 'utf8'));
    expect(inf.PromptTemplate).not.toEqual(custom);
  });

  it('errors for a model Flint never imported', async () => {
    const res = await send('getModelTemplate', { name: 'never-imported-model' });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/no flint-imported model/i);
  });

  it('rejects a non-object promptTemplate on the command', async () => {
    const res = await send('setModelTemplate', { name: 'tpl-read', promptTemplate: 'chatml' });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/must be an object/i);
  });
});

describe('BYOM template ownership guard', () => {
  const custom = {
    system: '[SYS]{Content}[/SYS]',
    user: '[U]{Content}[/U]',
    assistant: '[A]{Content}[/A]',
    prompt: '[U]{Content}[/U][A]',
  };

  /** A catalog-shaped model directory Flint did not create: no ownership marker. */
  function makeForeignModelDir(name: string) {
    const dir = path.join(cacheRoot, 'Microsoft', `${name}-1`);
    fs.mkdirSync(path.join(dir, 'v1'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'v1', 'genai_config.json'),
      JSON.stringify({ model: { type: 'qwen3', decoder: { filename: 'model.onnx' } } }),
    );
    fs.writeFileSync(
      path.join(dir, 'v1', 'inference_model.json'),
      JSON.stringify({ Name: `${name}:1`, PromptTemplate: { user: '<|im_start|>user\n{Content}<|im_end|>' } }),
    );
    return dir;
  }

  it('refuses to rewrite a model directory Flint did not import', async () => {
    const dir = makeForeignModelDir('catalog-owned');
    const infPath = path.join(dir, 'v1', 'inference_model.json');
    const before = fs.readFileSync(infPath, 'utf8');

    const res = await send('setModelTemplate', { name: 'catalog-owned', promptTemplate: custom });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/only models imported by flint/i);
    expect(fs.readFileSync(infPath, 'utf8')).toBe(before);
  });

  it('refuses to read the template of a model Flint did not import', async () => {
    makeForeignModelDir('catalog-owned-read');
    const res = await send('getModelTemplate', { name: 'catalog-owned-read' });
    expect(res.ok).toBeFalsy();
    expect(String(res.error)).toMatch(/no flint-imported model/i);
  });
});
