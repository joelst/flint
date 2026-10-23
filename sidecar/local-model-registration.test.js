import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNERSHIP_MARKER } from './byom-import.js';
import {
  applyLocalModelMetadata,
  ensureRegisteredLocalModel,
  linkedLocalRegistrationTargets,
  localRegistrationDeletePlan,
  ownedLocalRegistrationTargets,
  removeLocalRegistrationAssets,
} from './local-model-registration.js';

const temps = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-local-reg-'));
  temps.push(dir);
  return dir;
}

function metadataClass() {
  const created = [];
  class MutableModelInfo {
    constructor() {
      this.disposed = false;
      this.props = {};
      created.push(this);
    }
    setStringProperty(key, value) {
      this.props[key] = value;
      return this;
    }
    setIntProperty(key, value) {
      this.props[key] = value;
      return this;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { MutableModelInfo, created };
}

describe('applyLocalModelMetadata', () => {
  it('sets task and a positive integer context length', () => {
    const info = { props: {}, setStringProperty(k, v) { this.props[k] = v; return this; }, setIntProperty(k, v) { this.props[k] = v; return this; } };
    applyLocalModelMetadata(info, { task: 'chat-completion', contextLength: 4096 });
    expect(info.props).toEqual({ task: 'chat-completion', context_length: 4096 });
  });

  it('omits a context length that is not a positive integer', () => {
    const info = { props: {}, setStringProperty(k, v) { this.props[k] = v; return this; }, setIntProperty(k, v) { this.props[k] = v; return this; } };
    applyLocalModelMetadata(info, { task: ' chat-completion ', contextLength: 1.5 });
    applyLocalModelMetadata(info, { task: 'chat-completion', contextLength: 0 });
    expect(info.props).toEqual({ task: 'chat-completion' });
  });

  it('rejects a metadata object that cannot set properties', () => {
    expect(() => applyLocalModelMetadata(null, { task: 'chat-completion' })).toThrow(/MutableModelInfo/);
    expect(() => applyLocalModelMetadata({
      setStringProperty() {},
      setIntProperty() {},
    }, { task: ' ' })).toThrow(/needs a task/);
  });
});

describe('ensureRegisteredLocalModel', () => {
  it('registers once and disposes the metadata', async () => {
    const { MutableModelInfo, created } = metadataClass();
    const catalog = {
      async registerModel(_modelPath, modelId, info) {
        return { info: { id: modelId, task: info.props.task } };
      },
    };
    const result = await ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
      contextLength: 131072,
    });
    expect(result).toMatchObject({ registered: true, replaced: false, id: 'llama:1', task: 'chat-completion' });
    expect(created).toHaveLength(1);
    expect(created[0].disposed).toBe(true);
    expect(created[0].props.context_length).toBe(131072);
  });

  it('leaves a model that already has the same task', async () => {
    const { MutableModelInfo } = metadataClass();
    const calls = [];
    const catalog = {
      async registerModel() {
        calls.push('register');
        throw new Error('model_id is already registered: llama:1');
      },
      async getModel(name) {
        calls.push(`get:${name}`);
        return { info: { id: 'llama:1', task: 'chat-completion' } };
      },
      async unregisterModel() {
        calls.push('unregister');
      },
    };
    const result = await ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    });
    expect(result).toMatchObject({ registered: true, replaced: false, task: 'chat-completion' });
    expect(calls).toEqual(['register', 'get:llama']);
  });

  it('replaces an already-registered model whose task is unset', async () => {
    const { MutableModelInfo, created } = metadataClass();
    let registered = 0;
    const calls = [];
    const catalog = {
      async registerModel(_modelPath, modelId, info) {
        registered += 1;
        if (registered === 1) throw new Error('already registered');
        return { info: { id: modelId, task: info.props.task } };
      },
      async getModel() {
        return { path: 'C:/models/llama', info: { id: 'llama:1', task: '  ' } };
      },
      async unregisterModel(id) {
        calls.push(id);
      },
    };
    const result = await ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    });
    expect(result).toMatchObject({ registered: true, replaced: true, id: 'llama:1', task: 'chat-completion' });
    expect(calls).toEqual(['llama:1']);
    expect(created).toHaveLength(2);
    expect(created.every((info) => info.disposed)).toBe(true);
  });

  it('does not replace a different non-empty task', async () => {
    const { MutableModelInfo } = metadataClass();
    const catalog = {
      async registerModel() {
        throw new Error('already registered');
      },
      async getModel() {
        return { info: { id: 'embed:1', task: 'embeddings' } };
      },
      async unregisterModel() {
        throw new Error('unregister should not run');
      },
    };
    const result = await ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/embed',
      modelId: 'embed:1',
      task: 'chat-completion',
    });
    expect(result).toMatchObject({
      registered: false,
      replaced: false,
      task: 'embeddings',
      skipped: 'task-already-set',
    });
  });

  it('rethrows a registration error that is not already-registered', async () => {
    const { MutableModelInfo } = metadataClass();
    const catalog = {
      async registerModel() {
        throw new Error('folder is not a model');
      },
    };
    await expect(ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/not a model/);
  });

  it('names a missing register or metadata constructor', async () => {
    await expect(ensureRegisteredLocalModel({
      catalog: {},
      MutableModelInfo: class {},
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/registerModel/);
    await expect(ensureRegisteredLocalModel({
      catalog: { registerModel() {} },
      MutableModelInfo: null,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/MutableModelInfo/);
    await expect(ensureRegisteredLocalModel({
      catalog: { async registerModel() { return { info: {} }; } },
      MutableModelInfo: class {},
      modelPath: ' ',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/model path/);
  });

  it('does not unregister a registration when the catalog lookup fails', async () => {
    const { MutableModelInfo } = metadataClass();
    const removed = [];
    const catalog = {
      async registerModel() {
        throw new Error('already registered');
      },
      async getModel() {
        throw new Error('catalog is unavailable');
      },
      async unregisterModel(id) {
        removed.push(id);
      },
    };
    await expect(ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/catalog is unavailable/);
    expect(removed).toEqual([]);
  });

  it('does not replace a task-less registration at a different path', async () => {
    const { MutableModelInfo } = metadataClass();
    const removed = [];
    const catalog = {
      async registerModel() { throw new Error('already registered'); },
      async getModel() {
        return { path: 'C:/models/other', info: { id: 'llama:1' } };
      },
      async unregisterModel(id) { removed.push(id); },
    };
    await expect(ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/different or unreadable path/);
    expect(removed).toEqual([]);
  });

  it('ignores a dispose failure after a successful register', async () => {
    class MutableModelInfo {
      setStringProperty() { return this; }
      setIntProperty() { return this; }
      dispose() { throw new Error('busy'); }
    }
    const catalog = {
      async registerModel(_modelPath, modelId) {
        return { info: { id: modelId, task: 'chat-completion' } };
      },
    };
    await expect(ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).resolves.toMatchObject({ registered: true, id: 'llama:1' });
  });

  it('refuses to replace an unset task when unregister is missing', async () => {
    const { MutableModelInfo } = metadataClass();
    const catalog = {
      async registerModel() {
        throw new Error('already registered');
      },
      async getModel() {
        return { path: 'C:/models/llama', info: { id: 'llama:1' } };
      },
    };
    await expect(ensureRegisteredLocalModel({
      catalog,
      MutableModelInfo,
      modelPath: 'C:/models/llama',
      modelId: 'llama:1',
      task: 'chat-completion',
    })).rejects.toThrow(/cannot replace/);
  });
});

describe('ownedLocalRegistrationTargets', () => {
  it('returns nothing for a missing cache', () => {
    expect(ownedLocalRegistrationTargets('')).toEqual([]);
    expect(ownedLocalRegistrationTargets(path.join(tempDir(), 'missing'))).toEqual([]);
  });

  it('reads a Flint-owned copy and skips links, files, and incomplete markers', () => {
    const root = tempDir();
    const versionDir = path.join(root, 'Imported', 'llama-1', 'v1');
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'Imported', 'llama-1', OWNERSHIP_MARKER), JSON.stringify({
      name: 'llama',
      version: 1,
    }));
    fs.writeFileSync(path.join(versionDir, 'genai_config.json'), JSON.stringify({
      model: { type: 'llama', context_length: 131072 },
    }));

    fs.writeFileSync(path.join(root, 'Imported', 'note.txt'), 'ignore');
    fs.mkdirSync(path.join(root, 'Imported', 'broken-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Imported', 'broken-1', OWNERSHIP_MARKER), '{');
    fs.mkdirSync(path.join(root, 'Imported', 'noname-1', 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Imported', 'noname-1', OWNERSHIP_MARKER), JSON.stringify({ version: 1 }));
    fs.writeFileSync(path.join(root, 'Imported', 'noname-1', 'v1', 'genai_config.json'), '{}');
    fs.mkdirSync(path.join(root, 'Imported', 'nogenai-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Imported', 'nogenai-1', OWNERSHIP_MARKER), JSON.stringify({
      name: 'nogenai',
      version: 1,
    }));

    const linkParent = path.join(root, 'Imported', 'linked-1');
    const linkTarget = path.join(root, 'elsewhere');
    fs.mkdirSync(path.join(linkTarget, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(linkTarget, 'v1', 'genai_config.json'), JSON.stringify({ model: { type: 'llama' } }));
    fs.symlinkSync(linkTarget, linkParent, 'junction');
    fs.writeFileSync(path.join(linkParent, OWNERSHIP_MARKER), JSON.stringify({ name: 'linked', version: 1 }));

    const speechDir = path.join(root, 'Imported', 'whisper-1', 'v1');
    fs.mkdirSync(speechDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'Imported', 'whisper-1', OWNERSHIP_MARKER), JSON.stringify({
      name: 'whisper-tiny',
      version: 1,
    }));
    fs.writeFileSync(path.join(speechDir, 'genai_config.json'), JSON.stringify({
      model: { type: 'whisper', context_length: 0 },
    }));

    fs.writeFileSync(path.join(root, 'readme.txt'), 'not a publisher');
    const fileRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(fileRoot, 'x');

    const targets = ownedLocalRegistrationTargets(root);
    expect(targets).toHaveLength(2);
    expect(targets.find((target) => target.modelId === 'llama:1')).toEqual({
      modelPath: versionDir,
      modelId: 'llama:1',
      task: 'chat-completion',
      contextLength: 131072,
    });
    expect(targets.find((target) => target.modelId === 'whisper-tiny:1')).toEqual({
      modelPath: speechDir,
      modelId: 'whisper-tiny:1',
      task: 'automatic-speech-recognition',
      contextLength: null,
    });
    expect(ownedLocalRegistrationTargets(fileRoot)).toEqual([]);
  });
});

describe('linkedLocalRegistrationTargets', () => {
  it('discovers versioned linked folders without registering incomplete or unrelated children', () => {
    const root = tempDir();
    const cache = path.join(root, 'cache');
    const source = path.join(root, 'source');
    for (const version of [1, 2, 3]) {
      const versionDir = path.join(source, `v${version}`);
      fs.mkdirSync(versionDir, { recursive: true });
      if (version < 3) {
        fs.writeFileSync(path.join(versionDir, 'genai_config.json'), JSON.stringify({
          model: { type: 'llama', context_length: version * 1024 },
        }));
      }
    }
    fs.mkdirSync(path.join(source, 'notes'));
    fs.writeFileSync(path.join(source, 'readme.txt'), 'not a model');
    const link = path.join(cache, 'Linked', 'my-llama');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, 'junction');

    expect(linkedLocalRegistrationTargets(cache).sort((a, b) => a.modelId.localeCompare(b.modelId)))
      .toEqual([1, 2].map((version) => ({
        modelPath: fs.realpathSync(path.join(source, `v${version}`)),
        modelId: `my-llama:${version}`,
        task: 'chat-completion',
        contextLength: version * 1024,
      })));
    expect(fs.readFileSync(path.join(source, 'readme.txt'), 'utf8')).toBe('not a model');
  });

  it('points registration at the junction target and skips ordinary copies', () => {
    const root = tempDir();
    const source = path.join(root, 'source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'genai_config.json'), JSON.stringify({
      model: { type: 'llama', context_length: 4096 },
    }));
    const link = path.join(root, 'Linked', 'my-llama');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, 'junction');

    const copy = path.join(root, 'Imported', 'llama-1', 'v1');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'genai_config.json'), '{}');

    expect(linkedLocalRegistrationTargets(root)).toEqual([{
      modelPath: fs.realpathSync(source),
      modelId: 'my-llama:1',
      task: 'chat-completion',
      contextLength: 4096,
    }]);
    expect(linkedLocalRegistrationTargets('')).toEqual([]);
  });
});

describe('localRegistrationDeletePlan', () => {
  it('removes an owned copy and leaves a catalog folder and a linked target', () => {
    const root = tempDir();
    const source = path.join(root, 'source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'genai_config.json'), '{"model":{"type":"llama"}}');
    fs.writeFileSync(path.join(source, 'weights.bin'), 'keep');

    const link = path.join(root, 'Linked', 'my-llama');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, 'junction');

    const ownedVersion = path.join(root, 'Imported', 'llama-1', 'v1');
    fs.mkdirSync(ownedVersion, { recursive: true });
    fs.writeFileSync(path.join(root, 'Imported', 'llama-1', OWNERSHIP_MARKER), '{}\n');
    fs.writeFileSync(path.join(ownedVersion, 'model.onnx'), 'owned');

    const catalogDir = path.join(root, 'Microsoft', 'phi-4', 'v2');
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(path.join(catalogDir, 'model.onnx'), 'catalog');

    const linkPlan = localRegistrationDeletePlan(root, source);
    expect(linkPlan.ownedRoot).toBeNull();
    expect(linkPlan.junctions).toEqual([link]);
    removeLocalRegistrationAssets(linkPlan);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(source, 'weights.bin'), 'utf8')).toBe('keep');

    const ownedPlan = localRegistrationDeletePlan(root, ownedVersion);
    expect(ownedPlan.junctions).toEqual([]);
    expect(ownedPlan.ownedRoot).toBe(path.resolve(path.join(root, 'Imported', 'llama-1')));
    removeLocalRegistrationAssets(ownedPlan);
    expect(fs.existsSync(path.join(root, 'Imported', 'llama-1'))).toBe(false);

    const catalogPlan = localRegistrationDeletePlan(root, catalogDir);
    expect(catalogPlan).toEqual({ ownedRoot: null, junctions: [] });
    expect(fs.existsSync(path.join(catalogDir, 'model.onnx'))).toBe(true);
    expect(localRegistrationDeletePlan('', source)).toEqual({ ownedRoot: null, junctions: [] });
  });

  it('refuses to delete a real directory named as a junction or a link named as an owned root', () => {
    const root = tempDir();
    const realDir = path.join(root, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'weights.bin'), 'keep');
    expect(() => removeLocalRegistrationAssets({ ownedRoot: null, junctions: [realDir] }))
      .toThrow(/not a link/);
    expect(fs.readFileSync(path.join(realDir, 'weights.bin'), 'utf8')).toBe('keep');

    const source = path.join(root, 'source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'weights.bin'), 'keep');
    const link = path.join(root, 'Linked', 'my-llama');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, 'junction');
    expect(() => removeLocalRegistrationAssets({ ownedRoot: link, junctions: [] }))
      .toThrow(/real directory/);
    expect(fs.readFileSync(path.join(source, 'weights.bin'), 'utf8')).toBe('keep');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
