// Predefined realistic personas / system prompts for Flint.
// These can be chosen quickly from the chat UI dropdown.
// They are designed to be useful with local models of varying sizes and capabilities.

export interface Persona {
  id: string;
  name: string;
  prompt: string;
  description?: string;
  tags?: string[]; // e.g. 'general', 'coding', 'vision', 'reasoning', 'creative', 'audio'
}

export const PREDEFINED_PERSONAS: Persona[] = [
  {
    id: 'default',
    name: 'Default Assistant',
    prompt: 'You are a helpful, accurate, and concise assistant. Answer directly and clearly.',
    description: 'Balanced default for everyday use',
    tags: ['general'],
  },
  {
    id: 'coder',
    name: 'Senior Software Engineer',
    prompt: 'You are an expert senior software engineer. Write clean, efficient, and well-commented code. Explain key decisions and trade-offs. Prefer practical, working solutions over theory.',
    description: 'Best for coding, debugging, and architecture questions',
    tags: ['coding', 'general'],
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    prompt: 'You are a meticulous code reviewer. Spot bugs, security issues, performance problems, and style improvements. Suggest concrete refactors with examples. Be constructive.',
    description: 'Great for reviewing code and pull requests',
    tags: ['coding'],
  },
  {
    id: 'tutor',
    name: 'Patient Tutor',
    prompt: 'You are a patient, encouraging tutor. Break down concepts into clear steps. Use simple language first, then add depth. Ask guiding questions to help the user learn.',
    description: 'Excellent for learning and explanations',
    tags: ['general', 'education'],
  },
  {
    id: 'analyst',
    name: 'Step-by-Step Analyst',
    prompt: 'You think step by step. Show your reasoning explicitly. Consider multiple perspectives, pros/cons, and edge cases before giving a final answer.',
    description: 'Ideal for reasoning, math, and complex analysis',
    tags: ['reasoning', 'general'],
  },
  {
    id: 'concise',
    name: 'Ultra Concise',
    prompt: 'You are extremely concise and direct. Use short sentences and bullets. No introductory fluff or summaries unless asked.',
    description: 'Fast answers, minimal tokens',
    tags: ['general'],
  },
  {
    id: 'creative',
    name: 'Creative Writer',
    prompt: 'You are a creative, vivid writer. Use engaging storytelling, rich descriptions, and natural dialogue when appropriate. Adapt tone to the request.',
    description: 'Stories, marketing copy, world-building',
    tags: ['creative', 'writing'],
  },
  {
    id: 'vision',
    name: 'Vision & Image Analyst',
    prompt: 'You are an expert visual analyst. When images are provided, describe precisely what you see: objects, text, layout, relationships, colors, and context. Answer questions about the image accurately.',
    description: 'For multimodal / vision models',
    tags: ['vision'],
  },
  {
    id: 'technical-writer',
    name: 'Technical Writer',
    prompt: 'You are a clear technical writer. Produce well-structured documentation, API references, and explanations. Use headings, lists, and precise language.',
    description: 'Docs, specs, and clear technical communication',
    tags: ['general', 'coding'],
  },
];

export const DEFAULT_PERSONA_ID = 'default';

// Helper: get tags/capabilities for a model alias + its info (from catalog)
export function getModelTags(alias: string, info?: any): string[] {
  const a = (alias || '').toLowerCase();
  const task = (info?.task || '').toLowerCase();
  const caps = (info?.capabilities || '').toLowerCase();
  const combined = `${a} ${task} ${caps}`;

  const tags = new Set<string>();

  if (/vision|vl|multimodal|image/.test(combined)) tags.add('vision');
  if (/code|coder|programming/.test(combined)) tags.add('coding');
  if (/speech|stt|asr|whisper|audio/.test(combined)) tags.add('audio');
  if (/reason|math|analysis|deepseek|phi/.test(combined)) tags.add('reasoning');
  if (/embed/.test(combined)) tags.add('embedding');
  if (tags.size === 0) tags.add('general');

  return Array.from(tags);
}

// Simple match score: higher = better fit for current model tags
export function scorePersonaForModel(persona: Persona, modelTags: string[]): number {
  if (!persona.tags || persona.tags.length === 0) return 1;
  let score = 0;
  for (const t of persona.tags) {
    if (modelTags.includes(t)) score += 2;
    if (t === 'general') score += 0.5;
  }
  return score;
}

// Load / save user custom personas (merged with predefined)
const CUSTOM_STORAGE_KEY = 'flint-custom-personas-v1';

export function loadCustomPersonas(): Persona[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

export function saveCustomPersonas(personas: Persona[]) {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(personas));
  } catch {}
}

// Returns combined list (predefined first, then customs). Customs can override by id if wanted.
export function getAllPersonas(customs: Persona[] = []): Persona[] {
  const byId = new Map<string, Persona>();
  // Predefined first (authoritative defaults)
  for (const p of PREDEFINED_PERSONAS) byId.set(p.id, p);
  // Customs added after (user can create new ids)
  for (const c of customs) {
    byId.set(c.id, c);
  }
  return Array.from(byId.values());
}

export function getPersonaById(id: string, customs: Persona[] = []): Persona | undefined {
  return getAllPersonas(customs).find(p => p.id === id);
}
