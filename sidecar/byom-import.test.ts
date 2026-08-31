import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  validateModelFolder,
  selectPromptTemplate,
  buildInferenceModel,
  sanitizeModelName,
  isInsideRoot,
  validatePromptTemplate,
  TEMPLATE_PRESETS,
  TEMPLATE_ROLES,
} from './byom-import.js';

/** File list mirroring a real Foundry model dir (qwen3-0.6b-generic-cpu-4/v4). */
function goodFiles(extra: string[] = []) {
  return [
    'genai_config.json',
    'model.onnx',
    'tokenizer.json',
    'tokenizer_config.json',
    'config.json',
    'chat_template.jinja',
    ...extra,
  ];
}

const genaiConfig = {
  model: {
    type: 'qwen3',
    context_length: 40960,
    decoder: { filename: 'model.onnx' },
  },
};

describe('validateModelFolder', () => {
  it('accepts a well-formed onnxruntime-genai folder', () => {
    const r = validateModelFolder({
      files: goodFiles(),
      dirName: 'qwen3-0.6b',
      genaiConfig,
      chatTemplate: '{% for m in messages %}<|im_start|>{{ m.role }}',
    });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.detected.architecture).toBe('qwen3');
    expect(r.detected.contextLength).toBe(40960);
    expect(r.detected.templateConfident).toBe(true);
  });

  it('rejects a folder with no genai_config.json', () => {
    const files = goodFiles().filter(f => f !== 'genai_config.json');
    const r = validateModelFolder({ files, dirName: 'x', genaiConfig: null });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/genai_config\.json/);
  });

  it('rejects GGUF explicitly rather than failing later in native code', () => {
    const r = validateModelFolder({
      files: ['model.gguf', 'tokenizer.json', 'genai_config.json'],
      dirName: 'llama',
      genaiConfig,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/GGUF/);
  });

  it('rejects an interrupted download', () => {
    const r = validateModelFolder({
      files: goodFiles(['download.tmp']),
      dirName: 'x',
      genaiConfig,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/incomplete/i);
  });

  it('rejects a folder with no tokenizer', () => {
    const files = goodFiles().filter(f => !f.startsWith('tokenizer'));
    const r = validateModelFolder({ files, dirName: 'x', genaiConfig });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/tokenizer/i);
  });

  it('rejects weights that genai_config.json does not point at', () => {
    const r = validateModelFolder({
      files: goodFiles().filter(f => f !== 'model.onnx').concat('other.onnx'),
      dirName: 'x',
      genaiConfig, // still declares model.onnx
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/expects weights named "model\.onnx"/);
  });

  it('rejects a folder with no .onnx weights at all', () => {
    const r = validateModelFolder({
      files: ['genai_config.json', 'tokenizer.json'],
      dirName: 'x',
      genaiConfig: { model: { type: 'qwen3' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/No \.onnx weights/);
  });

  it('warns, but does not fail, when weights use external .onnx.data', () => {
    const r = validateModelFolder({
      files: goodFiles(['model.onnx.data']),
      dirName: 'x',
      genaiConfig,
      chatTemplate: '<|im_start|>',
    });
    expect(r.ok).toBe(true);
    expect(r.detected.hasExternalData).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/external \.onnx\.data/);
  });

  it('warns when the prompt template had to be guessed', () => {
    const r = validateModelFolder({
      files: goodFiles(),
      dirName: 'mystery',
      genaiConfig: { model: { type: 'someunknownarch', decoder: { filename: 'model.onnx' } } },
      chatTemplate: null,
    });
    expect(r.ok).toBe(true);
    expect(r.detected.templateConfident).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/guessed/i);
  });

  it('reports an empty folder', () => {
    const r = validateModelFolder({ files: [], dirName: 'x' });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/empty/i);
  });
});

describe('selectPromptTemplate', () => {
  it('prefers the jinja template over the architecture', () => {
    // Architecture says llama, but the actual turn markers are ChatML.
    const r = selectPromptTemplate({ chatTemplate: '<|im_start|>system', architecture: 'llama' });
    expect(r.confident).toBe(true);
    expect(r.template.user).toContain('<|im_start|>');
  });

  it.each([
    ['<|im_start|>', '<|im_start|>'],
    ['<|start_header_id|>', '<|start_header_id|>'],
    ['<start_of_turn>', '<start_of_turn>'],
  ])('detects %s from the chat template', (marker, expected) => {
    const r = selectPromptTemplate({ chatTemplate: `x ${marker} y` });
    expect(r.confident).toBe(true);
    expect(r.template.prompt).toContain(expected);
  });

  it('detects Phi-3 style templates', () => {
    const r = selectPromptTemplate({ chatTemplate: '<|user|>\n{{ x }}<|end|>' });
    expect(r.confident).toBe(true);
    expect(r.template.prompt).toContain('<|assistant|>');
  });

  it('falls back to architecture with confident=false', () => {
    const r = selectPromptTemplate({ chatTemplate: null, architecture: 'phi3' });
    expect(r.confident).toBe(false);
    expect(r.template.user).toContain('<|user|>');
  });

  it('defaults to ChatML when nothing is known', () => {
    const r = selectPromptTemplate({});
    expect(r.confident).toBe(false);
    expect(r.templateSource).toMatch(/default/);
  });
});

describe('buildInferenceModel', () => {
  it('produces the Name:version shape the native scanner requires', () => {
    const { content } = buildInferenceModel({ name: 'my-model', version: 3, chatTemplate: '<|im_start|>' });
    expect(content.Name).toBe('my-model:3');
    expect(content.PromptTemplate).toHaveProperty('system');
    expect(content.PromptTemplate).toHaveProperty('prompt');
  });

  it('matches the real Foundry file byte-for-byte in structure', () => {
    // Verbatim from ~/.flint/cache/models/Microsoft/qwen3-0.6b-generic-cpu-4/v4.
    const { content } = buildInferenceModel({
      name: 'qwen3-0.6b-generic-cpu',
      version: 4,
      chatTemplate: '<|im_start|>',
    });
    expect(content).toEqual({
      Name: 'qwen3-0.6b-generic-cpu:4',
      PromptTemplate: {
        system: '<|im_start|>system\n{Content}<|im_end|>',
        user: '<|im_start|>user\n{Content}<|im_end|>',
        assistant: '<|im_start|>assistant\n{Content}<|im_end|>',
        prompt: '<|im_start|>user\n{Content}<|im_end|>\n<|im_start|>assistant',
      },
    });
  });

  it('defaults to version 1 for absent or invalid versions', () => {
    expect(buildInferenceModel({ name: 'm' }).content.Name).toBe('m:1');
    expect(buildInferenceModel({ name: 'm', version: 0 }).content.Name).toBe('m:1');
    expect(buildInferenceModel({ name: 'm', version: -2 }).content.Name).toBe('m:1');
    expect(buildInferenceModel({ name: 'm', version: 1.5 }).content.Name).toBe('m:1');
  });

  it('throws when the name sanitizes away to nothing', () => {
    expect(() => buildInferenceModel({ name: '///' })).toThrow(/name is required/i);
  });
});

describe('sanitizeModelName', () => {
  it('strips path separators so a name cannot become a traversal', () => {
    expect(sanitizeModelName('../../evil')).toBe('evil');
    expect(sanitizeModelName('a/b\\c')).toBe('a-b-c');
  });

  it('collapses runs and trims leading/trailing punctuation', () => {
    expect(sanitizeModelName('  --my $$ model--  ')).toBe('my-model');
  });

  it('caps length', () => {
    expect(sanitizeModelName('x'.repeat(300)).length).toBe(96);
  });
});

describe('isInsideRoot', () => {
  const root = path.resolve('/cache');

  it('accepts a child path', () => {
    expect(isInsideRoot(root, path.join(root, 'models', 'a'))).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it('rejects traversal out of the root', () => {
    expect(isInsideRoot(root, path.join(root, '..', 'elsewhere'))).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInsideRoot(root, path.resolve('/somewhere/else'))).toBe(false);
  });

  it('rejects a sibling whose name merely shares the prefix', () => {
    // /cache-evil must not count as inside /cache.
    expect(isInsideRoot(root, `${root}-evil`)).toBe(false);
  });
});

describe('validatePromptTemplate', () => {
  const good = TEMPLATE_PRESETS.chatml.template;

  it('accepts every shipped preset', () => {
    for (const [key, preset] of Object.entries(TEMPLATE_PRESETS)) {
      const result = validatePromptTemplate(preset.template);
      expect(result.ok, `${key} should be valid: ${result.errors.join(', ')}`).toBe(true);
    }
  });

  it('returns a cleaned copy rather than the caller object', () => {
    const result = validatePromptTemplate(good);
    expect(result.template).toEqual(good);
    expect(result.template).not.toBe(good);
  });

  it.each(TEMPLATE_ROLES)('rejects a template missing "%s"', (role) => {
    const partial: Record<string, string> = { ...good };
    delete partial[role];
    const result = validatePromptTemplate(partial);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain(role);
  });

  it('rejects a whitespace-only role', () => {
    const result = validatePromptTemplate({ ...good, system: '   ' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/empty/i);
  });

  it('rejects a non-string role', () => {
    const result = validatePromptTemplate({ ...good, user: 42 as unknown as string });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/must be a string/i);
  });

  it('rejects unknown fields so typos are not silently ignored', () => {
    const result = validatePromptTemplate({ ...good, sytem: 'oops' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('sytem');
  });

  it('requires {Content} in system, user and assistant', () => {
    for (const role of ['system', 'user', 'assistant']) {
      const result = validatePromptTemplate({ ...good, [role]: 'no placeholder here' });
      expect(result.ok, `${role} without {Content} must fail`).toBe(false);
      expect(result.errors.join(' ')).toContain('{Content}');
    }
  });

  it('only warns when the prompt turn omits {Content}', () => {
    const result = validatePromptTemplate({ ...good, prompt: '<|im_start|>assistant' });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 'chatml', 42, []])('rejects the non-object %p', (value) => {
    const result = validatePromptTemplate(value as unknown as object);
    expect(result.ok).toBe(false);
    expect(result.template).toBeNull();
  });
});

describe('buildInferenceModel with a user-supplied template', () => {
  const custom = {
    system: '[SYS]{Content}[/SYS]',
    user: '[U]{Content}[/U]',
    assistant: '[A]{Content}[/A]',
    prompt: '[U]{Content}[/U][A]',
  };

  it('prefers the override over a detected jinja template', () => {
    const built = buildInferenceModel({
      name: 'my-model',
      chatTemplate: "{% for m in messages %}<|im_start|>{{ m['role'] }}",
      architecture: 'llama',
      promptTemplate: custom,
    });
    expect(built.content.PromptTemplate).toEqual(custom);
    expect(built.templateSource).toBe('user-supplied');
    expect(built.confident).toBe(true);
  });

  it('throws with the specific errors when the override is invalid', () => {
    expect(() => buildInferenceModel({
      name: 'my-model',
      promptTemplate: { ...custom, assistant: 'missing placeholder' },
    })).toThrow(/\{Content\}/);
  });

  it('falls back to detection when no override is given', () => {
    const built = buildInferenceModel({ name: 'my-model', architecture: 'llama' });
    expect(built.templateSource).not.toBe('user-supplied');
  });
});

describe('validateModelFolder template exposure', () => {
  it('returns the resolved template so the UI can show it before import', () => {
    const report = validateModelFolder({
      files: goodFiles(),
      dirName: 'some-model',
      genaiConfig,
      chatTemplate: null,
    });
    const template = report.detected.promptTemplate;
    expect(template).toBeTruthy();
    expect(validatePromptTemplate(template).ok).toBe(true);
  });
});
