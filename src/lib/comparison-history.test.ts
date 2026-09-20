import { describe, it, expect } from 'vitest';
import {
  COMPARE_HISTORY_KEY,
  COMPARE_HISTORY_BACKUP_KEY,
  COMPARE_HISTORY_MAX,
  compareSlotKey,
  loadComparisonHistory,
  saveComparisonHistory,
  renderComparisonMarkdown,
  type SavedComparison,
  type CompareSlot,
  type CompareResult,
} from './comparison-history';
import type { StorageAdapter } from './conversation-repository';

class MemoryStorage implements StorageAdapter {
  map = new Map<string, string>();
  failReadsOn: string | null = null;
  failWrites = false;

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }
  getItem(key: string): string | null {
    if (this.failReadsOn === key) throw new Error('SecurityError: storage blocked');
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const slot = (over: Partial<CompareSlot> = {}): CompareSlot => ({
  key: 'model-a::default',
  alias: 'model-a',
  variantId: null,
  label: 'Model A',
  ...over,
});

const result = (over: Partial<CompareResult> = {}): CompareResult => ({
  content: 'hello',
  latencyMs: 100,
  tokensIn: 5,
  tokensOut: 10,
  rating: null,
  ...over,
});

const savedRun = (over: Partial<SavedComparison> = {}): SavedComparison => ({
  id: 'cmp-1',
  createdAt: 1700000000000,
  prompt: 'Say hi',
  slots: [slot()],
  results: { 'model-a::default': result() },
  ...over,
});

describe('compareSlotKey', () => {
  it('distinguishes variants of the same alias', () => {
    expect(compareSlotKey('model-a', null)).toBe('model-a::default');
    expect(compareSlotKey('model-a', 'v2')).toBe('model-a::v2');
    expect(compareSlotKey('model-a', 'v2')).not.toBe(compareSlotKey('model-a', null));
  });
});

describe('loadComparisonHistory', () => {
  it('returns an empty writable history when nothing is saved yet', () => {
    const storage = new MemoryStorage();
    const loaded = loadComparisonHistory(storage);
    expect(loaded).toEqual({ history: [], writable: true, backedUp: false, notice: null });
  });

  it('loads previously saved runs unchanged', () => {
    const run = savedRun();
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: JSON.stringify([run]) });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([run]);
    expect(loaded.writable).toBe(true);
    expect(loaded.notice).toBeNull();
  });

  it('blocks writes and reports the reason when storage cannot be read at all', () => {
    const storage = new MemoryStorage();
    storage.failReadsOn = COMPARE_HISTORY_KEY;
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.writable).toBe(false);
    expect(loaded.notice).toMatch(/could not be read/i);
  });

  it('backs up corrupt bytes and allows a fresh history when the array itself does not parse as JSON', () => {
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: '{not json' });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.writable).toBe(true);
    expect(loaded.backedUp).toBe(true);
    expect(storage.getItem(COMPARE_HISTORY_BACKUP_KEY)).toBe('{not json');
    expect(loaded.notice).toMatch(/not in the expected format/i);
  });

  it('backs up corrupt bytes and allows a fresh history when an entry is missing required fields', () => {
    const raw = JSON.stringify([{ id: 'cmp-1' }]);
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.writable).toBe(true);
    expect(loaded.backedUp).toBe(true);
    expect(storage.getItem(COMPARE_HISTORY_BACKUP_KEY)).toBe(raw);
  });

  it('backs up an entry whose results field is an array rather than a record', () => {
    const run = savedRun();
    const raw = JSON.stringify([{ ...run, results: [] }]);
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.writable).toBe(true);
    expect(loaded.backedUp).toBe(true);
    expect(storage.getItem(COMPARE_HISTORY_BACKUP_KEY)).toBe(raw);
  });

  it('backs up slots and results whose optional fields have the wrong type', () => {
    const badSlot = savedRun({
      slots: [{ ...slot(), deviceType: {} as unknown as string }],
    });
    const badLatency = savedRun({
      results: { 'model-a::default': { ...result(), latencyMs: 'unknown' as unknown as number } },
    });
    const badRating = savedRun({
      results: { 'model-a::default': { ...result(), rating: 'other' as unknown as 'up' } },
    });
    for (const run of [badSlot, badLatency, badRating]) {
      const raw = JSON.stringify([run]);
      const loaded = loadComparisonHistory(new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw }));
      expect(loaded.history).toEqual([]);
      expect(loaded.writable).toBe(true);
      expect(loaded.backedUp).toBe(true);
    }
  });

  it('backs up an overflow createdAt timestamp as corrupt', () => {
    const run = savedRun();
    const raw = JSON.stringify([run]).replace(`"createdAt":${run.createdAt}`, '"createdAt":1e400');
    expect(JSON.parse(raw)[0].createdAt).toBe(Infinity);
    const loaded = loadComparisonHistory(new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw }));
    expect(loaded.history).toEqual([]);
    expect(loaded.writable).toBe(true);
    expect(loaded.backedUp).toBe(true);
  });

  it('backs up a finite createdAt outside the Date range as corrupt', () => {
    const run = savedRun({ createdAt: 8.65e15 });
    expect(Number.isFinite(run.createdAt)).toBe(true);
    expect(Number.isFinite(new Date(run.createdAt).getTime())).toBe(false);
    const loaded = loadComparisonHistory(new MemoryStorage({ [COMPARE_HISTORY_KEY]: JSON.stringify([run]) }));
    expect(loaded.history).toEqual([]);
    expect(loaded.writable).toBe(true);
    expect(loaded.backedUp).toBe(true);
  });

  it('rejects an entry whose results field is missing', () => {
    const run = savedRun();
    const raw = JSON.stringify([{ ...run, results: undefined }]);
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.backedUp).toBe(true);
  });

  it('rejects an entry whose slot is missing a required field', () => {
    const run = savedRun({ slots: [{ alias: 'model-a' } as unknown as CompareSlot] });
    const raw = JSON.stringify([run]);
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.backedUp).toBe(true);
  });

  it('rejects an entry whose result entry has no content field', () => {
    const run = savedRun({ results: { 'model-a::default': { latencyMs: 1 } as unknown as CompareResult } });
    const raw = JSON.stringify([run]);
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    const loaded = loadComparisonHistory(storage);
    expect(loaded.history).toEqual([]);
    expect(loaded.backedUp).toBe(true);
  });

  it('does not allow writes at all when even the backup write fails', () => {
    const raw = '{not json';
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    storage.failWrites = true;
    const loaded = loadComparisonHistory(storage);
    expect(loaded.writable).toBe(false);
    expect(loaded.backedUp).toBe(false);
    expect(loaded.notice).toMatch(/backup copy could not be written/i);
  });

  it('does not re-park identical bytes on a repeated failed-write attempt', () => {
    const raw = '{not json';
    const storage = new MemoryStorage({ [COMPARE_HISTORY_KEY]: raw });
    loadComparisonHistory(storage);
    loadComparisonHistory(storage);
    // Only the live key and one backup slot should exist — no second backup was created.
    expect([...storage.map.keys()].filter((k) => k.startsWith(COMPARE_HISTORY_BACKUP_KEY))).toEqual([
      COMPARE_HISTORY_BACKUP_KEY,
    ]);
  });
});

describe('saveComparisonHistory', () => {
  it('writes and bounds the history to COMPARE_HISTORY_MAX entries', () => {
    const storage = new MemoryStorage();
    const many = Array.from({ length: COMPARE_HISTORY_MAX + 5 }, (_, i) =>
      savedRun({ id: `cmp-${i}` }));
    const saved = saveComparisonHistory(storage, many);
    expect(saved).toEqual({ ok: true, error: null });
    const persisted = JSON.parse(storage.getItem(COMPARE_HISTORY_KEY)!);
    expect(persisted).toHaveLength(COMPARE_HISTORY_MAX);
    expect(persisted[0].id).toBe('cmp-0');
  });

  it('reports failure instead of throwing when storage rejects the write', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const saved = saveComparisonHistory(storage, [savedRun()]);
    expect(saved.ok).toBe(false);
    expect(saved.error).toBeTruthy();
  });

  it('stringifies a non-Error thrown by storage', () => {
    const storage: StorageAdapter = {
      getItem: () => null,
      setItem: () => { throw 'quota exceeded'; },
      removeItem: () => {},
    };
    const saved = saveComparisonHistory(storage, [savedRun()]);
    expect(saved).toEqual({ ok: false, error: 'quota exceeded' });
  });
});

describe('renderComparisonMarkdown', () => {
  it('renders one section per slot with a result, in slot order', () => {
    const slots = [slot(), slot({ key: 'model-b::v1', alias: 'model-b', variantId: 'v1', label: 'Model B' })];
    const results = {
      'model-a::default': result({ content: 'hi from a' }),
      'model-b::v1': result({ content: 'hi from b', rating: 'up' }),
    };
    const md = renderComparisonMarkdown('Say hi', slots, results);
    expect(md).toContain('# Model Arena');
    expect(md).toContain('**Prompt:** Say hi');
    expect(md).toContain('## Model A');
    expect(md).toContain('- Alias: `model-a`');
    expect(md.indexOf('## Model B')).toBeGreaterThan(md.indexOf('## Model A'));
    // The first (variant-less) slot's section must not contain a Variant line of its own.
    const modelASection = md.slice(md.indexOf('## Model A'), md.indexOf('## Model B'));
    expect(modelASection).not.toContain('- Variant:');
    expect(md).toContain('## Model B');
    expect(md).toContain('- Variant: `v1`');
    expect(md).toContain('- Rating: up');
    expect(md).toContain('hi from a');
    expect(md).toContain('hi from b');
  });

  it('skips slots with no result yet', () => {
    const slots = [slot(), slot({ key: 'model-b::default', alias: 'model-b', label: 'Model B' })];
    const md = renderComparisonMarkdown('Say hi', slots, { 'model-a::default': result() });
    expect(md).toContain('## Model A');
    expect(md).not.toContain('## Model B');
  });

  it('renders "?" placeholders when latency/token counts are unavailable', () => {
    const md = renderComparisonMarkdown('Say hi', [slot()], {
      'model-a::default': { content: 'partial' },
    });
    expect(md).toContain('- Latency: ? ms');
    expect(md).toContain('- Tokens: in ? / out ?');
  });
});
