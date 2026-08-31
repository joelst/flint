// Validation and metadata synthesis for BYOM (bring-your-own-model) imports.
//
// Foundry Local's native scanner treats a directory as a model when it holds
// `genai_config.json` and an `inference_model.json` carrying a `Name`, and has no
// `download.tmp`. Almost no public ONNX repository ships `inference_model.json` — it
// is Foundry-specific — so Flint has to author it. This module decides whether a
// folder is importable and builds the metadata the scanner needs.
//
// Everything here is pure: no filesystem writes and no SDK calls, so it can be unit
// tested and reused from either the sidecar or a future Rust bridge.

import path from 'node:path';

// Template detection and validation live in a Node-free module so the UI can run the
// exact same rules before sending anything to the sidecar.
import {
  selectPromptTemplate,
  validatePromptTemplate,
  TEMPLATE_ROLES,
  TEMPLATE_PRESETS,
} from './prompt-template.js';

export { selectPromptTemplate, validatePromptTemplate, TEMPLATE_ROLES, TEMPLATE_PRESETS };

/** Foundry's marker for an interrupted download; its presence hides a model. */
export const PARTIAL_DOWNLOAD_MARKER = 'download.tmp';

/** Written by Flint into every directory it creates, so it knows what it may delete. */
export const OWNERSHIP_MARKER = '.flint-import.json';

/** Weights are meaningless without a tokenizer, and the failure is opaque at load time. */
const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json', 'tokenizer.model'];

/**
 * Foundry model names appear in URLs and on disk, so keep them conservative.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeModelName (raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .replace(/-{2,}/g, '-');
  return cleaned.slice(0, 96);
}

/**
 * Build the `inference_model.json` payload the native scanner requires.
 *
 * A caller-supplied `promptTemplate` always wins over detection, so a user can correct
 * a wrong guess without editing files by hand.
 *
 * @param {{ name: string, version?: number, chatTemplate?: string|null, architecture?: string|null, promptTemplate?: object|null }} options
 * @returns {{ content: object, templateSource: string, confident: boolean }}
 */
export function buildInferenceModel (options) {
  const name = sanitizeModelName(options?.name);
  if (!name) throw new Error('A model name is required to build inference_model.json.');

  const version = Number.isInteger(options?.version) && options.version > 0 ? options.version : 1;

  if (options?.promptTemplate) {
    const check = validatePromptTemplate(options.promptTemplate);
    if (!check.ok) throw new Error(`Invalid prompt template:\n- ${check.errors.join('\n- ')}`);
    return {
      content: { Name: `${name}:${version}`, PromptTemplate: { ...check.template } },
      templateSource: 'user-supplied',
      confident: true,
    };
  }

  const { template, templateSource, confident } = selectPromptTemplate(options);

  return {
    content: { Name: `${name}:${version}`, PromptTemplate: { ...template } },
    templateSource,
    confident,
  };
}

/**
 * Reject paths that would escape the cache root or follow a link out of it.
 *
 * Import copies attacker-influenced directory trees, so traversal has to be blocked
 * on the resolved path rather than the string the caller supplied.
 *
 * @param {string} cacheRoot
 * @param {string} candidate
 * @returns {boolean} true when `candidate` resolves inside `cacheRoot`
 */
export function isInsideRoot (cacheRoot, candidate) {
  const root = path.resolve(cacheRoot);
  const target = path.resolve(candidate);
  if (root === target) return true;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Decide whether a directory listing describes an importable ONNX model.
 *
 * Takes a plain listing rather than touching disk so the rules stay testable.
 *
 * @param {{ files: string[], dirName?: string, genaiConfig?: object|null, chatTemplate?: string|null }} input
 * @returns {{ ok: boolean, reasons: string[], warnings: string[], detected: object }}
 */
export function validateModelFolder (input) {
  const files = Array.isArray(input?.files) ? input.files.map(f => String(f)) : [];
  const base = new Set(files.map(f => path.basename(f).toLowerCase()));
  const reasons = [];
  const warnings = [];

  if (files.length === 0) reasons.push('The folder is empty.');

  if (!base.has('genai_config.json')) {
    reasons.push(
      'No genai_config.json found. Foundry Local runs onnxruntime-genai models; ' +
        'a plain .onnx export or a GGUF file will not load.',
    );
  }
  if (base.has(PARTIAL_DOWNLOAD_MARKER)) {
    reasons.push(`A ${PARTIAL_DOWNLOAD_MARKER} marker is present, so the download is incomplete.`);
  }

  const onnxFiles = files.filter(f => f.toLowerCase().endsWith('.onnx'));
  if (onnxFiles.length === 0) reasons.push('No .onnx weights found in the folder.');

  if (files.some(f => f.toLowerCase().endsWith('.gguf'))) {
    reasons.push('This looks like a GGUF model. Foundry Local is ONNX-only and cannot load GGUF.');
  }

  if (!TOKENIZER_FILES.some(t => base.has(t))) {
    reasons.push('No tokenizer found (expected tokenizer.json, tokenizer_config.json, or tokenizer.model).');
  }

  const genai = input?.genaiConfig ?? null;
  const architecture = genai?.model?.type ? String(genai.model.type) : null;
  const contextLength = Number.isFinite(genai?.model?.context_length) ? genai.model.context_length : null;

  // The scanner reads weights via genai_config's decoder.filename; a mismatch loads nothing.
  const declaredWeights = genai?.model?.decoder?.filename ? String(genai.model.decoder.filename) : null;
  if (declaredWeights && !base.has(path.basename(declaredWeights).toLowerCase())) {
    reasons.push(`genai_config.json expects weights named "${declaredWeights}", which are missing.`);
  }

  // External-data files are separate and easy to leave behind when copying by hand.
  const hasExternalData = files.some(f => f.toLowerCase().endsWith('.onnx.data'));
  if (hasExternalData && onnxFiles.length > 0) {
    warnings.push('Weights use external .onnx.data files; all of them must be copied together.');
  }

  if (base.has('inference_model.json')) {
    warnings.push('The folder already has inference_model.json; Flint will keep the existing file.');
  }

  const { template, templateSource, confident } = selectPromptTemplate({
    chatTemplate: input?.chatTemplate,
    architecture,
  });
  if (!confident) {
    warnings.push(
      `Prompt template guessed from ${templateSource}. Review it before importing — a wrong ` +
        'template is the usual cause of malformed replies.',
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    detected: {
      name: sanitizeModelName(input?.dirName || ''),
      architecture,
      contextLength,
      onnxFiles,
      hasExternalData,
      hasInferenceModel: base.has('inference_model.json'),
      templateSource,
      templateConfident: confident,
      // The resolved template travels with the report so the UI can show and edit it
      // before anything is written.
      promptTemplate: { ...template },
      fileCount: files.length,
    },
  };
}
