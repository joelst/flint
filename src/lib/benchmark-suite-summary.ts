/**
 * Read-only labels for a stored suite. The suite panel renders these after Edit locks
 * (the first run freezes the definition), so the prompts stay visible without loading
 * attempt bodies.
 */

import type { BenchmarkSuite, BenchmarkTarget } from './benchmark-suite';

export function targetVariantLabel(variantId: string | null): string {
  return variantId ?? 'runtime-selected';
}

/** Blank generation settings are not zero — the run uses whatever the runtime defaults to. */
export function generationSettingLabel(value: number | undefined): string {
  return value === undefined ? 'runtime default' : String(value);
}

export interface SuiteCaseMessageView {
  role: string;
  content: string;
}

export interface SuiteDefinitionView {
  description?: string;
  warmupCount: number;
  repeatCount: number;
  temperatureLabel: string;
  maxTokensLabel: string;
  targets: Array<{ alias: string; variantLabel: string }>;
  /**
   * A messages case keeps every role and its text. After the first run the suite is
   * locked, so a count would hide the prompt that was actually measured.
   */
  cases: Array<{
    id: string;
    prompt?: string;
    messages?: SuiteCaseMessageView[];
    tags: string[];
    expected?: string;
  }>;
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
        tags: entry.tags ? [...entry.tags] : [],
      };
      if (typeof entry.prompt === 'string') row.prompt = entry.prompt;
      if (entry.messages) {
        row.messages = entry.messages.map((message) => ({
          role: message.role,
          content: message.content,
        }));
      }
      if (entry.expected !== undefined) row.expected = entry.expected;
      return row;
    }),
  };
  if (suite.description !== undefined) view.description = suite.description;
  return view;
}
