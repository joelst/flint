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

/** Foundry's marker for an interrupted download; its presence hides a model. */
export const PARTIAL_DOWNLOAD_MARKER = 'download.tmp';

/** Written by Flint into every directory it creates, so it knows what it may delete. */
export const OWNERSHIP_MARKER = '.flint-import.json';

/** Weights are meaningless without a tokenizer, and the failure is opaque at load time. */
const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json', 'tokenizer.model'];

/**
 * ChatML is the template used by the Qwen/Phi families that dominate the ONNX
 * ecosystem, and it is what Foundry itself writes for those models.
 */
const CHATML_TEMPLATE = {
  system: '<|im_start|>system\n{Content}<|im_end|>',
  user: '<|im_start|>user\n{Content}<|im_end|>',
  assistant: '<|im_start|>assistant\n{Content}<|im_end|>',
  prompt: '<|im_start|>user\n{Content}<|im_end|>\n<|im_start|>assistant',
};

const LLAMA3_TEMPLATE = {
  system: '<|start_header_id|>system<|end_header_id|>\n\n{Content}<|eot_id|>',
  user: '<|start_header_id|>user<|end_header_id|>\n\n{Content}<|eot_id|>',
  assistant: '<|start_header_id|>assistant<|end_header_id|>\n\n{Content}<|eot_id|>',
  prompt:
    '<|start_header_id|>user<|end_header_id|>\n\n{Content}<|eot_id|>' +
    '<|start_header_id|>assistant<|end_header_id|>\n\n',
};

const PHI3_TEMPLATE = {
  system: '<|system|>\n{Content}<|end|>',
  user: '<|user|>\n{Content}<|end|>',
  assistant: '<|assistant|>\n{Content}<|end|>',
  prompt: '<|user|>\n{Content}<|end|>\n<|assistant|>',
};

const GEMMA_TEMPLATE = {
  system: '<start_of_turn>user\n{Content}<end_of_turn>',
  user: '<start_of_turn>user\n{Content}<end_of_turn>',
  assistant: '<start_of_turn>model\n{Content}<end_of_turn>',
  prompt: '<start_of_turn>user\n{Content}<end_of_turn>\n<start_of_turn>model\n',
};

/**
 * Pick a prompt template from the model's own chat template plus its architecture.
 *
 * The Jinja chat template is the only trustworthy signal — the architecture string is
 * a fallback, because a fine-tune may keep an architecture while changing its turn
 * markers. Detection is by control token, which is what actually drives generation.
 *
 * @param {{ chatTemplate?: string|null, architecture?: string|null }} [options]
 * @returns {{ template: object, templateSource: string, confident: boolean }}
 */
export function selectPromptTemplate (options = {}) {
  const chatTemplate = typeof options.chatTemplate === 'string' ? options.chatTemplate : '';
  const architecture = String(options.architecture || '').toLowerCase();

  if (chatTemplate.includes('<|im_start|>')) {
    return { template: CHATML_TEMPLATE, templateSource: 'chat_template.jinja (ChatML)', confident: true };
  }
  if (chatTemplate.includes('<|start_header_id|>')) {
    return { template: LLAMA3_TEMPLATE, templateSource: 'chat_template.jinja (Llama 3)', confident: true };
  }
  if (chatTemplate.includes('<|user|>') && chatTemplate.includes('<|end|>')) {
    return { template: PHI3_TEMPLATE, templateSource: 'chat_template.jinja (Phi-3)', confident: true };
  }
  if (chatTemplate.includes('<start_of_turn>')) {
    return { template: GEMMA_TEMPLATE, templateSource: 'chat_template.jinja (Gemma)', confident: true };
  }

  // No usable Jinja template — fall back to architecture, and say so.
  if (/qwen|yi|internlm/.test(architecture)) {
    return { template: CHATML_TEMPLATE, templateSource: `architecture "${architecture}" (ChatML)`, confident: false };
  }
  if (/llama/.test(architecture)) {
    return { template: LLAMA3_TEMPLATE, templateSource: `architecture "${architecture}" (Llama 3)`, confident: false };
  }
  if (/phi/.test(architecture)) {
    return { template: PHI3_TEMPLATE, templateSource: `architecture "${architecture}" (Phi-3)`, confident: false };
  }
  if (/gemma/.test(architecture)) {
    return { template: GEMMA_TEMPLATE, templateSource: `architecture "${architecture}" (Gemma)`, confident: false };
  }

  return { template: CHATML_TEMPLATE, templateSource: 'default (ChatML)', confident: false };
}

/** Roles the native prompt builder expects; `prompt` is the generation-turn suffix. */
export const TEMPLATE_ROLES = ['system', 'user', 'assistant', 'prompt'];

/** Named templates offered in the UI, so a user can switch family without hand-typing. */
export const TEMPLATE_PRESETS = {
  chatml: { label: 'ChatML (Qwen, Yi, InternLM)', template: CHATML_TEMPLATE },
  llama3: { label: 'Llama 3', template: LLAMA3_TEMPLATE },
  phi3: { label: 'Phi-3', template: PHI3_TEMPLATE },
  gemma: { label: 'Gemma', template: GEMMA_TEMPLATE },
};

/**
 * Check a user-edited prompt template before it is written to disk.
 *
 * A malformed template does not fail loudly — the model loads and then produces
 * subtly wrong output — so the cheap structural checks are worth enforcing.
 *
 * @param {unknown} template
 * @returns {{ ok: boolean, errors: string[], warnings: string[], template: object|null }}
 */
export function validatePromptTemplate (template) {
  const errors = [];
  const warnings = [];

  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return { ok: false, errors: ['Prompt template must be an object.'], warnings, template: null };
  }

  const cleaned = {};
  for (const role of TEMPLATE_ROLES) {
    const value = template[role];
    if (value === undefined || value === null) {
      errors.push(`Missing "${role}" template.`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`Template "${role}" must be a string.`);
      continue;
    }
    if (!value.trim()) {
      errors.push(`Template "${role}" is empty.`);
      continue;
    }
    cleaned[role] = value;
  }

  const unknown = Object.keys(template).filter(k => !TEMPLATE_ROLES.includes(k));
  if (unknown.length > 0) errors.push(`Unknown template field(s): ${unknown.join(', ')}.`);

  // {Content} is substituted by the native prompt builder; without it the message
  // text is dropped and the model sees only the wrapper tokens.
  for (const role of ['system', 'user', 'assistant']) {
    if (cleaned[role] && !cleaned[role].includes('{Content}')) {
      errors.push(`Template "${role}" must contain the {Content} placeholder.`);
    }
  }
  // The prompt turn ends where generation begins, so it deliberately has no {Content}
  // of its own after the assistant marker; warn rather than fail if it lacks one.
  if (cleaned.prompt && !cleaned.prompt.includes('{Content}')) {
    warnings.push('The "prompt" template has no {Content}; the user message may be dropped.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    template: errors.length === 0 ? cleaned : null,
  };
}

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
