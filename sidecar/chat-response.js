const NON_STANDARD_RESPONSE_FIELDS = new Set([
  'IsDelta',
  'Successful',
  'HttpStatusCode',
]);

function copyStandardFields (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !NON_STANDARD_RESPONSE_FIELDS.has(key)),
  );
}

function normalizeChoice (choice, stream) {
  const source = copyStandardFields(choice);
  const content = stream ? (source.delta ?? source.message) : (source.message ?? source.delta);
  const normalized = {
    index: source.index ?? 0,
    finish_reason: source.finish_reason ?? null,
  };
  if (source.logprobs !== undefined) normalized.logprobs = source.logprobs;
  if (stream) normalized.delta = copyStandardFields(content);
  else normalized.message = copyStandardFields(content);
  return normalized;
}

/**
 * Convert Foundry's completion variants into the OpenAI response shape.
 * Transport-specific fields such as Flint's acceleration metadata are retained.
 */
export function normalizeChatResponse (response, { stream = false } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('Chat response must be an object');
  }
  const normalized = copyStandardFields(response);
  if (Array.isArray(response.choices)) {
    normalized.choices = response.choices.map((choice) => normalizeChoice(choice, stream));
  }
  return normalized;
}
