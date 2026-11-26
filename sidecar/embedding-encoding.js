export function encodeEmbedding(vector, encodingFormat = 'float') {
  if (encodingFormat === 'float') return vector;
  if (encodingFormat !== 'base64') throw new Error('Unsupported embedding encoding.');

  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index++) {
    const component = Math.fround(vector[index]);
    if (!Number.isFinite(component)) {
      throw new Error(`Embedding component ${index} cannot be represented as float32.`);
    }
    bytes.writeFloatLE(component, index * 4);
  }
  return bytes.toString('base64');
}

export function encodeEmbeddingResponse(body) {
  const response = JSON.parse(body);
  if (!response || !Array.isArray(response.data)) {
    throw new Error('Upstream embedding response has no data array.');
  }
  let converted = false;
  const data = response.data.map((item, index) => {
    if (typeof item?.embedding === 'string') return item;
    if (!Array.isArray(item?.embedding)
        || !item.embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`Upstream embedding at index ${index} is invalid.`);
    }
    converted = true;
    return { ...item, embedding: encodeEmbedding(item.embedding, 'base64') };
  });
  return converted ? JSON.stringify({ ...response, data }) : body;
}
