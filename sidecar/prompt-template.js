// Prompt template definitions, detection and validation.
//
// Foundry builds a prompt by substituting `{Content}` into four turn wrappers. A wrong
// template does not fail loudly: the model loads and produces subtly wrong output, and a
// template missing `{Content}` silently drops the message text altogether. That makes
// these rules worth enforcing before anything reaches disk.
//
// This module deliberately imports nothing — not even Node builtins — so the same code
// validates in the sidecar and in the browser bundle, and the two can never drift.

/**
 * @typedef {object} PromptTemplate
 * @property {string} system
 * @property {string} user
 * @property {string} assistant
 * @property {string} prompt
 */

/**
 * ChatML is the template used by the Qwen/Phi families that dominate the ONNX
 * ecosystem, and it is what Foundry itself writes for those models.
 * @type {PromptTemplate}
 */
export const CHATML_TEMPLATE = {
  system: '<|im_start|>system\n{Content}<|im_end|>',
  user: '<|im_start|>user\n{Content}<|im_end|>',
  assistant: '<|im_start|>assistant\n{Content}<|im_end|>',
  prompt: '<|im_start|>user\n{Content}<|im_end|>\n<|im_start|>assistant',
};

/** @type {PromptTemplate} */
export const LLAMA3_TEMPLATE = {
  system: '<|start_header_id|>system<|end_header_id|>\n\n{Content}<|eot_id|>',
  user: '<|start_header_id|>user<|end_header_id|>\n\n{Content}<|eot_id|>',
  assistant: '<|start_header_id|>assistant<|end_header_id|>\n\n{Content}<|eot_id|>',
  prompt:
    '<|start_header_id|>user<|end_header_id|>\n\n{Content}<|eot_id|>' +
    '<|start_header_id|>assistant<|end_header_id|>\n\n',
};

/** @type {PromptTemplate} */
export const PHI3_TEMPLATE = {
  system: '<|system|>\n{Content}<|end|>',
  user: '<|user|>\n{Content}<|end|>',
  assistant: '<|assistant|>\n{Content}<|end|>',
  prompt: '<|user|>\n{Content}<|end|>\n<|assistant|>',
};

/** @type {PromptTemplate} */
export const GEMMA_TEMPLATE = {
  system: '<start_of_turn>user\n{Content}<end_of_turn>',
  user: '<start_of_turn>user\n{Content}<end_of_turn>',
  assistant: '<start_of_turn>model\n{Content}<end_of_turn>',
  prompt: '<start_of_turn>user\n{Content}<end_of_turn>\n<start_of_turn>model\n',
};

/** Roles the native prompt builder expects; `prompt` is the generation-turn suffix. */
export const TEMPLATE_ROLES = /** @type {const} */ (['system', 'user', 'assistant', 'prompt']);

/** Named templates offered in the UI, so a user can switch family without hand-typing. */
export const TEMPLATE_PRESETS = {
  chatml: { label: 'ChatML (Qwen, Yi, InternLM)', template: CHATML_TEMPLATE },
  llama3: { label: 'Llama 3', template: LLAMA3_TEMPLATE },
  phi3: { label: 'Phi-3', template: PHI3_TEMPLATE },
  gemma: { label: 'Gemma', template: GEMMA_TEMPLATE },
};

/**
 * Pick a prompt template from the model's own chat template plus its architecture.
 *
 * The Jinja chat template is the only trustworthy signal — the architecture string is
 * a fallback, because a fine-tune may keep an architecture while changing its turn
 * markers. Detection is by control token, which is what actually drives generation.
 *
 * @param {{ chatTemplate?: string|null, architecture?: string|null }} [options]
 * @returns {{ template: PromptTemplate, templateSource: string, confident: boolean }}
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

/**
 * Check a user-edited prompt template before it is written to disk.
 *
 * @param {unknown} template
 * @returns {{ ok: boolean, errors: string[], warnings: string[], template: PromptTemplate|null }}
 */
export function validatePromptTemplate (template) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return { ok: false, errors: ['Prompt template must be an object.'], warnings, template: null };
  }

  const source = /** @type {Record<string, unknown>} */ (template);
  /** @type {Record<string, string>} */
  const cleaned = {};
  for (const role of TEMPLATE_ROLES) {
    const value = source[role];
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

  const unknown = Object.keys(source).filter(k => !(/** @type {readonly string[]} */ (TEMPLATE_ROLES)).includes(k));
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
    template: errors.length === 0 ? /** @type {PromptTemplate} */ (/** @type {unknown} */ (cleaned)) : null,
  };
}
