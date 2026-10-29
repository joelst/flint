// Register a Flint-owned ONNX folder on Foundry's local catalog so ChatSession,
// EmbeddingsSession, and AudioSession see a task. Foundry 2.1.0's scanner still
// does not read a task out of inference_model.json. registerModel copies metadata
// and does not delete the folder. removeFromCache throws for a LocalRegistration;
// delete unregisters the catalog row, then removes a Flint-owned copy or the
// junction and never the linked folder.
//
// The SDK classes are passed in. This module does not import foundry-local-sdk,
// so unit tests never load the native core.

import fs from 'node:fs';
import path from 'node:path';
import { localModelTask, OWNERSHIP_MARKER } from './byom-import.js';

function cleanTask(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function taskOf(model) {
  return cleanTask(model?.info?.task);
}

function idOf(model) {
  const id = model?.info?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function alreadyRegistered(error) {
  return /already registered/i.test(String(error?.message || error || ''));
}

function modelNotFound(error) {
  return error?.status === 404
    || error?.statusCode === 404
    || error?.code === 404
    || /(?:model|registration).*(?:not found|does not exist)|no model matching/i
      .test(String(error?.message || error || ''));
}

function aliasFromModelId(modelId) {
  return String(modelId).replace(/:\d+$/, '');
}

function sameOrNested(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  if (root === target) return true;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function realOrResolved(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * Which cache paths a local-registration delete may remove.
 *
 * The owned root is the Flint import directory that contains the ownership
 * marker. Junctions are links whose target is the registered folder, or that
 * contain it. A catalog folder with no marker and no junction is left alone.
 *
 * @param {string} cacheRoot
 * @param {string} modelPath
 * @returns {{ ownedRoot: string | null, junctions: string[] }}
 */
export function localRegistrationDeletePlan(cacheRoot, modelPath) {
  const empty = { ownedRoot: null, junctions: [] };
  if (typeof cacheRoot !== 'string' || !cacheRoot || typeof modelPath !== 'string' || !modelPath) {
    return empty;
  }
  if (!fs.existsSync(cacheRoot)) return empty;

  const rootReal = realOrResolved(cacheRoot);
  const modelReal = realOrResolved(modelPath);
  let ownedRoot = null;
  if (sameOrNested(rootReal, modelReal) && path.resolve(rootReal) !== path.resolve(modelReal)) {
    let cursor = modelReal;
    while (sameOrNested(rootReal, cursor) && path.resolve(cursor) !== path.resolve(rootReal)) {
      let linked = false;
      try {
        linked = fs.lstatSync(cursor).isSymbolicLink();
      } catch {
        break;
      }
      if (linked) break;
      if (fs.existsSync(path.join(cursor, OWNERSHIP_MARKER))) {
        ownedRoot = cursor;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  const junctions = [];
  let publishers = [];
  try {
    publishers = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return { ownedRoot, junctions };
  }
  for (const publisher of publishers) {
    if (!publisher.isDirectory() || publisher.isSymbolicLink()) continue;
    const publisherDir = path.join(cacheRoot, publisher.name);
    let models = [];
    try {
      models = fs.readdirSync(publisherDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const model of models) {
      if (!model.isSymbolicLink()) continue;
      const linkPath = path.join(publisherDir, model.name);
      let linkReal;
      try {
        linkReal = fs.realpathSync(linkPath);
      } catch {
        continue;
      }
      if (sameOrNested(linkReal, modelReal)) junctions.push(linkPath);
    }
  }
  return { ownedRoot, junctions };
}

/**
 * Remove the paths from `localRegistrationDeletePlan`. A junction is removed
 * as a link. An owned root must be a real directory carrying the ownership
 * marker. Anything else throws before it is deleted.
 *
 * @param {{ ownedRoot?: string | null, junctions?: string[] }} plan
 */
export function removeLocalRegistrationAssets(plan) {
  const junctions = Array.isArray(plan?.junctions) ? plan.junctions : [];
  for (const junction of junctions) {
    let stat;
    try {
      stat = fs.lstatSync(junction);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove ${junction}: it is not a link.`);
    }
    fs.rmSync(junction, { recursive: false, force: true });
  }

  const ownedRoot = typeof plan?.ownedRoot === 'string' ? plan.ownedRoot : '';
  if (!ownedRoot) return;
  let stat;
  try {
    stat = fs.lstatSync(ownedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove ${ownedRoot}: an owned import is a real directory.`);
  }
  if (!fs.existsSync(path.join(ownedRoot, OWNERSHIP_MARKER))) {
    throw new Error(`Refusing to remove ${ownedRoot}: it has no Flint import marker.`);
  }
  fs.rmSync(ownedRoot, { recursive: true, force: true });
}

/**
 * @param {{ setStringProperty: Function, setIntProperty: Function }} info
 * @param {{ task: string, contextLength?: number | null }} metadata
 */
export function applyLocalModelMetadata(info, metadata) {
  if (!info || typeof info.setStringProperty !== 'function' || typeof info.setIntProperty !== 'function') {
    throw new TypeError('Local model registration needs MutableModelInfo.');
  }
  const task = cleanTask(metadata?.task);
  if (!task) throw new TypeError('Local model registration needs a task.');
  info.setStringProperty('task', task);
  const contextLength = metadata?.contextLength;
  if (typeof contextLength === 'number' && Number.isSafeInteger(contextLength) && contextLength > 0) {
    info.setIntProperty('context_length', contextLength);
  }
  return info;
}

function disposeMetadata(info) {
  try {
    if (info && info.disposed !== true && typeof info.dispose === 'function') info.dispose();
  } catch {
    // A failed dispose must not hide the registration result.
  }
}

function outcomeFrom(model, { registered, replaced, task }) {
  return {
    registered,
    replaced,
    id: idOf(model),
    task: taskOf(model) || task,
    skipped: null,
    error: null,
  };
}

async function lookupExisting(catalog, modelId) {
  if (typeof catalog?.getModel !== 'function') {
    throw new Error(`Cannot verify the existing registration for ${modelId}: this SDK cannot read the local catalog.`);
  }
  const alias = aliasFromModelId(modelId);
  const names = alias === modelId ? [alias] : [alias, modelId];
  for (const name of names) {
    try {
      const model = await catalog.getModel(name);
      if (model) return model;
    } catch (error) {
      if (!modelNotFound(error)) {
        throw new Error(`Cannot verify the existing registration for ${modelId}: ${error?.message || error}`, {
          cause: error,
        });
      }
    }
  }
  return null;
}

function sameModelPath(existingPath, requestedPath) {
  if (typeof existingPath !== 'string' || !existingPath.trim()) return false;
  const existing = realOrResolved(existingPath);
  const requested = realOrResolved(requestedPath);
  return process.platform === 'win32'
    ? existing.toLowerCase() === requested.toLowerCase()
    : existing === requested;
}

/**
 * Register `modelId` at `modelPath` with a session task.
 *
 * A model that is already registered with the same task is left alone. A model
 * registered with an empty task is unregistered once and registered again.
 * A different non-empty task is kept. Metadata is never reused after registerModel,
 * which disposes it.
 *
 * @param {{ catalog: { registerModel: Function, getModel?: Function, unregisterModel?: Function }, MutableModelInfo: Function, modelPath: string, modelId: string, task: string, contextLength?: number | null }} input
 */
export async function ensureRegisteredLocalModel(input) {
  const catalog = input?.catalog;
  const MutableModelInfo = input?.MutableModelInfo;
  const modelPath = input?.modelPath;
  const modelId = input?.modelId;
  const task = cleanTask(input?.task);
  if (!catalog || typeof catalog.registerModel !== 'function') {
    throw new TypeError('This Foundry SDK has no local catalog registerModel.');
  }
  if (typeof MutableModelInfo !== 'function') {
    throw new TypeError('This Foundry SDK has no MutableModelInfo.');
  }
  if (typeof modelPath !== 'string' || !modelPath.trim() || typeof modelId !== 'string' || !modelId.trim()) {
    throw new TypeError('Local model registration needs a model path and id.');
  }
  if (!task) throw new TypeError('Local model registration needs a task.');

  const metadata = { task, contextLength: input?.contextLength };
  const first = new MutableModelInfo();
  applyLocalModelMetadata(first, metadata);
  try {
    const model = await catalog.registerModel(modelPath, modelId, first);
    return outcomeFrom(model, { registered: true, replaced: false, task });
  } catch (error) {
    if (!alreadyRegistered(error)) throw error;
  } finally {
    disposeMetadata(first);
  }

  const existing = await lookupExisting(catalog, modelId);
  if (!existing) {
    throw new Error(
      `Model ${modelId} is already registered, but the local catalog did not return its row; refusing to unregister an unknown registration.`,
    );
  }
  const existingTask = taskOf(existing);
  if (existingTask === task) {
    return outcomeFrom(existing, { registered: true, replaced: false, task: existingTask });
  }
  if (existingTask) {
    return {
      registered: false,
      replaced: false,
      id: idOf(existing),
      task: existingTask,
      skipped: 'task-already-set',
      error: null,
    };
  }
  if (!sameModelPath(existing?.path, modelPath)) {
    throw new Error(
      `Model ${modelId} is already registered without a task at a different or unreadable path; refusing to replace it.`,
    );
  }

  if (typeof catalog.unregisterModel !== 'function') {
    throw new Error(`Model ${modelId} is already registered without a task, and this SDK cannot replace it.`);
  }
  await catalog.unregisterModel(idOf(existing) || modelId);

  const second = new MutableModelInfo();
  applyLocalModelMetadata(second, metadata);
  try {
    const model = await catalog.registerModel(modelPath, modelId, second);
    return outcomeFrom(model, { registered: true, replaced: true, task });
  } finally {
    disposeMetadata(second);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Flint-owned copy imports under a cache root. Linked junctions are skipped
 * here; `linkedLocalRegistrationTargets` registers those without a marker.
 *
 * @param {string} cacheRoot
 * @returns {{ modelPath: string, modelId: string, task: string, contextLength: number | null }[]}
 */
export function ownedLocalRegistrationTargets(cacheRoot) {
  if (typeof cacheRoot !== 'string' || !cacheRoot || !fs.existsSync(cacheRoot)) return [];
  let publishers = [];
  try {
    publishers = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets = [];
  for (const publisher of publishers) {
    if (!publisher.isDirectory() || publisher.isSymbolicLink()) continue;
    const publisherDir = path.join(cacheRoot, publisher.name);
    let models = [];
    try {
      models = fs.readdirSync(publisherDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const model of models) {
      if (!model.isDirectory() || model.isSymbolicLink()) continue;
      const modelDir = path.join(publisherDir, model.name);
      const marker = readJson(path.join(modelDir, OWNERSHIP_MARKER));
      const name = typeof marker?.name === 'string' ? marker.name.trim() : '';
      const version = marker?.version;
      if (!name || !Number.isInteger(version) || version < 1) continue;
      const modelPath = path.join(modelDir, `v${version}`);
      if (!fs.existsSync(path.join(modelPath, 'genai_config.json'))) continue;
      const genai = readJson(path.join(modelPath, 'genai_config.json'));
      const declared = genai?.model?.context_length;
      const contextLength = typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
        ? declared
        : null;
      targets.push({
        modelPath,
        modelId: `${name}:${version}`,
        task: localModelTask({
          architecture: typeof genai?.model?.type === 'string' ? genai.model.type : null,
          dirName: name,
          task: null,
        }),
        contextLength,
      });
    }
  }
  return targets;
}

function registrationFromGenai(modelPath, name, version, genaiPath) {
  const genai = readJson(genaiPath);
  const declared = genai?.model?.context_length;
  const contextLength = typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : null;
  let resolved = modelPath;
  try { resolved = fs.realpathSync(modelPath); } catch { /* The link path is still readable. */ }
  return {
    modelPath: resolved,
    modelId: `${name}:${version}`,
    task: localModelTask({
      architecture: typeof genai?.model?.type === 'string' ? genai.model.type : null,
      dirName: name,
      task: null,
    }),
    contextLength,
  };
}

/**
 * Directory junctions created by link import. The files stay in the user's
 * folder. Registration points at that folder and does not write to it.
 *
 * @param {string} cacheRoot
 * @returns {{ modelPath: string, modelId: string, task: string, contextLength: number | null }[]}
 */
export function linkedLocalRegistrationTargets(cacheRoot) {
  if (typeof cacheRoot !== 'string' || !cacheRoot || !fs.existsSync(cacheRoot)) return [];
  let publishers = [];
  try {
    publishers = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets = [];
  for (const publisher of publishers) {
    if (!publisher.isDirectory() || publisher.isSymbolicLink()) continue;
    const publisherDir = path.join(cacheRoot, publisher.name);
    let models = [];
    try {
      models = fs.readdirSync(publisherDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const model of models) {
      // A Windows junction is a symbolic link and is not reported as a directory.
      if (!model.isSymbolicLink()) continue;
      const linkPath = path.join(publisherDir, model.name);
      const direct = path.join(linkPath, 'genai_config.json');
      if (fs.existsSync(direct)) {
        targets.push(registrationFromGenai(linkPath, model.name, 1, direct));
        continue;
      }
      let children = [];
      try {
        children = fs.readdirSync(linkPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const match = /^v(\d+)$/.exec(child.name);
        if (!child.isDirectory() || !match) continue;
        const version = Number(match[1]);
        const genaiPath = path.join(linkPath, child.name, 'genai_config.json');
        if (!fs.existsSync(genaiPath)) continue;
        targets.push(registrationFromGenai(path.join(linkPath, child.name), model.name, version, genaiPath));
      }
    }
  }
  return targets;
}
