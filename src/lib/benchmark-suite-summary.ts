/**
 * Read-only labels for a stored suite. The suite panel renders these after Edit locks
 * (the first run freezes the definition), so the prompts stay visible without loading
 * attempt bodies.
 */

import type { BenchmarkCase, BenchmarkSuite, BenchmarkTarget } from './benchmark-suite';

export function targetVariantLabel(variantId: string | null): string {
  return variantId ?? 'default';
}

/** Blank generation settings are not zero — the run uses whatever the runtime defaults to. */
export function generationSettingLabel(value: number | undefined): string {
  return value === undefined ? 'runtime default' : String(value);
}

/** Prompt text, or a count when the case is a messages array the form cannot edit as one prompt. */
export function caseBodyLabel(entry: Pick<BenchmarkCase, 'prompt' | 'messages'>): string {
  if (typeof entry.prompt === 'string') return entry.prompt;
  const count = entry.messages?.length ?? 0;
  return count === 1 ? '1 message' : `${count} messages`;
}

export interface SuiteDefinitionView {
  description?: string;
  warmupCount: number;
  repeatCount: number;
  temperatureLabel: string;
  maxTokensLabel: string;
  targets: Array<{ alias: string; variantLabel: string }>;
  cases: Array<{ id: string; body: string; tags: string[]; expected?: string }>;
}

export function suiteDefinitionView(suite: BenchmarkSuite): SuiteDefinitionView {
  const view: SuiteDefinitionView = {
    warmupCount: suite.warmupCount,
    repeatCount: suite.repeatCount,
    temperatureLabel: generationSettingLabel(suite.temperature),
    maxTokensLabel: generationSettingLabel(suite.maxTokens),
    targets: suite.targets.map((target: BenchmarkTarget) => ({
      alias: target.alias,
      variantLabel: targetVariantLabel(target.variantId),
    })),
    cases: suite.cases.map((entry) => {
      const row: SuiteDefinitionView['cases'][number] = {
        id: entry.id,
        body: caseBodyLabel(entry),
        tags: entry.tags ? [...entry.tags] : [],
      };
      if (entry.expected !== undefined) row.expected = entry.expected;
      return row;
    }),
  };
  if (suite.description !== undefined) view.description = suite.description;
  return view;
}
