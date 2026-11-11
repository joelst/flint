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
