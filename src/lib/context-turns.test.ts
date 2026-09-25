import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONTEXT_TURNS,
  MIN_CONTEXT_TURNS,
  clampContextTurns,
  recommendedMaxTurns,
} from './context-turns';

describe('context-turns', () => {
  it('falls back to 12 when context length is unknown', () => {
    expect(recommendedMaxTurns(null)).toBe(12);
    expect(recommendedMaxTurns(undefined)).toBe(12);
    expect(recommendedMaxTurns(0)).toBe(12);
  });

  it('clamps to the slider bounds for very small and very large context windows', () => {
    expect(recommendedMaxTurns(1000)).toBe(MIN_CONTEXT_TURNS);
    expect(recommendedMaxTurns(1_000_000)).toBe(MAX_CONTEXT_TURNS);
  });

  it('produces off-preset values that the old fixed-option select could not represent', () => {
    // The old <select> only listed 4/8/12/20/30; these context lengths intentionally produce
    // values outside that list (e.g. 17, 23, 6) to prove the control must support any integer
    // in range, not just the old presets.
    expect(recommendedMaxTurns(8500)).toBe(17);
    expect(recommendedMaxTurns(11500)).toBe(23);
    expect(recommendedMaxTurns(3000)).toBe(6);
  });

  it('clampContextTurns bounds any input to [MIN_CONTEXT_TURNS, MAX_CONTEXT_TURNS]', () => {
    expect(clampContextTurns(-5)).toBe(MIN_CONTEXT_TURNS);
    expect(clampContextTurns(0)).toBe(MIN_CONTEXT_TURNS);
    expect(clampContextTurns(17)).toBe(17);
    expect(clampContextTurns(1000)).toBe(MAX_CONTEXT_TURNS);
  });

  it('the Context slider clamps both the thumb and the displayed label through clampContextTurns', () => {
    // A stored contextTurns value can be any positive integer (conversation-store.ts only
    // rejects non-integers and values <= 0), so a legacy or hand-edited value like 100 must not
    // silently diverge from what the range input actually displays: a native range input clamps
    // its own value to [min, max], so binding the unclamped state to both the input and its
    // adjacent "N turns" label would show a thumb at 40 next to a label reading "100 turns".
    const source = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const start = source.indexOf('id="ctx-select"');
    const end = source.indexOf('context-estimate', start);
    const controlFlow = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(controlFlow).toContain('value={clampContextTurns(contextTurns)}');
    expect(controlFlow).toContain('{clampContextTurns(contextTurns)} turns');
  });

  it('clamps contextTurns at both points a legacy/persisted value enters live state', () => {
    // A display-only clamp is not enough on its own: the actual context-window trimming (e.g.
    // `maxRecent = contextTurns * 2`) reads the live `contextTurns` variable directly, so if the
    // live value itself is not also clamped where it's restored from storage, the slider could
    // show 40 while inference still uses an out-of-range legacy value like 100 underneath it.
    const source = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    expect(source).toContain('contextTurns = clampContextTurns(effective.contextTurns);');
    expect(source).toContain('contextTurns = clampContextTurns(appSettingDefaults.contextTurns);');
  });
});
