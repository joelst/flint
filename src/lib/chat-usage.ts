/** Shared chat usage parsing: the sidecar reports either OpenAI or SDK token field names. */

export function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function usageFromChatCompletion(usage: unknown): {
  promptTokens?: number;
  completionTokens?: number;
} | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const promptTokens = finiteToken(u.prompt_tokens) ?? finiteToken(u.input_tokens);
  const completionTokens = finiteToken(u.completion_tokens) ?? finiteToken(u.output_tokens);
  if (promptTokens == null && completionTokens == null) return undefined;
  return {
    ...(promptTokens != null ? { promptTokens } : {}),
    ...(completionTokens != null ? { completionTokens } : {}),
  };
}
