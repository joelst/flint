/**
 * embedTexts via EmbeddingsSession. The deprecated EmbeddingClient is the same
 * openai-json round trip; callers still receive that parsed JSON, not raw tensors.
 */

export async function generateEmbeddings(model, inputs, sdk, onWarning = () => {}) {
  const modelId = model?.id;
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('Embedding model has no id');
  }
  const request = new sdk.Request();
  request.addItem(sdk.Item.text(JSON.stringify({ model: modelId, input: inputs }), 'openai-json'));
  const session = new sdk.EmbeddingsSession(model);
  let response;
  let generationError;
  try {
    response = await session.processRequest(request);
  } catch (error) {
    generationError = error;
  }

  let disposeError;
  try {
    session.dispose();
  } catch (error) {
    disposeError = error;
  }

  if (generationError) {
    const cleanupDetail = disposeError
      ? `. Session cleanup also failed: ${
          disposeError instanceof Error ? disposeError.message : String(disposeError)
        }`
      : '';
    throw new Error(
      `Embedding generation failed for model '${modelId}': ${
        generationError instanceof Error ? generationError.message : String(generationError)
      }${cleanupDetail}`,
      { cause: disposeError ? new AggregateError([generationError, disposeError]) : generationError },
    );
  }
  if (disposeError) {
    onWarning(
      `Embedding generation completed for model '${modelId}', but session cleanup failed: ${
        disposeError instanceof Error ? disposeError.message : String(disposeError)
      }`,
    );
  }

  const text = openAiJsonText(response?.output);
  if (text === undefined) {
    throw new Error(`Embedding generation for model '${modelId}' returned no openai-json text item.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Embedding generation for model '${modelId}' returned invalid openai-json: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
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
