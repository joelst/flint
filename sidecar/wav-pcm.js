function readAscii (view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

/**
 * @typedef {Object} WavHeader
 * @property {DataView} view
 * @property {number} formatCode
 * @property {number} numChannels
 * @property {number} sampleRate
 * @property {number} bitsPerSample
 * @property {number} bytesPerSample
 * @property {number} frameSize
 * @property {number} frameCount
 * @property {number} dataOffset
 * @property {number} dataLength
 * @property {boolean} isFloat
 * @property {boolean} isInt
 */

/**
 * Walk a RIFF/WAVE buffer's chunks and validate its `fmt `/`data` chunks without reading
 * or allocating sample data.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {WavHeader}
 */
export function parseWavHeader (input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE buffer.');
  }

  let formatCode = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let dataDeclaredSize = 0;
  let dataAvailable = 0;
  let hasFormat = false;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    const chunkSize = Math.min(declaredSize, Math.max(0, bytes.byteLength - bodyOffset));

    if (chunkId === 'fmt ' && !hasFormat) {
      if (declaredSize < 16) {
        throw new Error(`WAV fmt chunk is too short: declared ${declaredSize} bytes, requires at least 16.`);
      }
      if (chunkSize < declaredSize) {
        throw new Error(`WAV fmt chunk is truncated: declared ${declaredSize} bytes but only ${chunkSize} are present.`);
      }
      hasFormat = true;
      formatCode = view.getUint16(bodyOffset, true);
      numChannels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
      if (formatCode === 0xfffe && chunkSize >= 26) {
        formatCode = view.getUint16(bodyOffset + 24, true);
      }
    } else if (chunkId === 'data' && dataOffset < 0) {
      dataOffset = bodyOffset;
      dataLength = chunkSize;
      dataDeclaredSize = declaredSize;
      dataAvailable = Math.max(0, bytes.byteLength - bodyOffset);
    }

    offset = bodyOffset + declaredSize + (declaredSize % 2);
  }

  if (dataOffset >= 0 && dataDeclaredSize > dataAvailable) {
    throw new Error(
      `WAV data chunk is truncated: declared ${dataDeclaredSize} bytes but only ${dataAvailable} are present.`,
    );
  }
  if (!numChannels || !sampleRate || !bitsPerSample) {
    throw new Error('WAV file is missing a usable fmt chunk.');
  }
  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error('WAV file has no data chunk.');
  }

  const isFloat = formatCode === 3;
  const isInt = formatCode === 1;
  if (!isFloat && !isInt) {
    throw new Error(`Unsupported WAV sample format code ${formatCode}.`);
  }
  const supportedIntDepths = [8, 16, 24, 32];
  const supportedFloatDepths = [32];
  const supportedDepths = isFloat ? supportedFloatDepths : supportedIntDepths;
  if (bitsPerSample % 8 !== 0 || !supportedDepths.includes(bitsPerSample)) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample} for format code ${formatCode}.`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  const frameCount = Math.floor(dataLength / frameSize);

  return {
    view,
    formatCode,
    numChannels,
    sampleRate,
    bitsPerSample,
    bytesPerSample,
    frameSize,
    frameCount,
    dataOffset,
    dataLength,
    isFloat,
    isInt,
  };
}

/**
 * Return the raw sample bytes for Nemotron's supported PCM input.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Uint8Array}
 */
export function extractNemotronPcm (input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = parseWavHeader(bytes);
  if (
    header.formatCode !== 1
    || header.sampleRate !== 16000
    || header.numChannels !== 1
    || header.bitsPerSample !== 16
    || header.dataLength % 2 !== 0
  ) {
    throw new Error('Nemotron speech requires 16 kHz, mono, 16-bit PCM WAV audio.');
  }
  return bytes.subarray(header.dataOffset, header.dataOffset + header.dataLength);
}
