import { modelPrefillsThink } from './message-rendering';

/**
 * Presentation string for a stored benchmark reply. Raw view and copy keep the
 * original text; only the formatted renderer sees this result.
 *
 * Qwen3-family and QwQ templates open `<think>` in the prompt, so a reply that
 * stops before `</think>` has no tags. The settled chat renderer then shows that
 * unfinished thought as the answer. This helper does not apply there. A later
 * "qwen" in another model's name does not.
 */

const THINK_TAG = /<\/?think(?:ing)?>/i;

export function presentBenchmarkResponse(
  text: string | null,
  modelLabels: readonly (string | null | undefined)[],
): string {
  if (typeof text !== 'string') return '';
  const prefilled = modelLabels.some((label) => modelPrefillsThink(label));
  if (!prefilled || text.trim() === '' || THINK_TAG.test(text)) return text;
  return `<think>\n${text}`;
}
