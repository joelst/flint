/**
 * embedTexts via EmbeddingsSession. The deprecated EmbeddingClient is the same
 * openai-json round trip; callers still receive that parsed JSON, not raw tensors.
 */

export async function generateEmbeddings(model, inputs, sdk) {
  const modelId = model?.id;
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('Embedding model has no id');
  }
  const request = new sdk.Request();
  request.addItem(sdk.Item.text(JSON.stringify({ model: modelId, input: inputs }), 'openai-json'));
  const session = new sdk.EmbeddingsSession(model);
  let response;
  try {
    response = await session.processRequest(request);
  } finally {
    // The response is already a snapshot. A dispose failure must not replace
    // the generation error or drop a successful vector.
    try { session.dispose(); } catch { /* best-effort native handle release */ }
  }
  const text = openAiJsonText(response?.output);
  if (text === undefined) {
    throw new Error(`Embedding generation for model '${modelId}' returned no openai-json text item.`);
  }
  return JSON.parse(text);
}

export function openAiJsonText(output) {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (item?.type === 'text' && item.textType === 'openai-json' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}
