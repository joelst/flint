// Audio container sniffing for the transcription path.
//
// The transcribe handler renames whatever it receives to `.wav` because the
// model's AudioDecoder is strict and cannot detect most containers. If the bytes
// are not actually WAV, the decoder fails deep inside native code with an opaque
// message. Sniffing the container up front turns that into an actionable error.

/** Bytes needed before a verdict is possible. */
const MIN_SNIFF_BYTES = 12;

function hasAscii(buffer, offset, text) {
  if (buffer.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (buffer[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Identify the audio container from its magic bytes.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {'wav'|'webm'|'ogg'|'mp3'|'mp4'|'flac'|'aiff'|'empty'|'unknown'}
 */
export function sniffAudioFormat (buffer) {
  if (!buffer || buffer.length === 0) return 'empty';
  if (buffer.length < MIN_SNIFF_BYTES) return 'unknown';

  // RIFF....WAVE
  if (hasAscii(buffer, 0, 'RIFF') && hasAscii(buffer, 8, 'WAVE')) return 'wav';
  // EBML header shared by WebM and Matroska.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'webm';
  }
  if (hasAscii(buffer, 0, 'OggS')) return 'ogg';
  if (hasAscii(buffer, 0, 'fLaC')) return 'flac';
  if (hasAscii(buffer, 4, 'ftyp')) return 'mp4';
  if (hasAscii(buffer, 0, 'FORM') && hasAscii(buffer, 8, 'AIF')) return 'aiff';
  // ID3v2 tag, or a bare MPEG audio frame sync (11 set bits).
  if (hasAscii(buffer, 0, 'ID3')) return 'mp3';
  if (buffer[0] === 0xff && (buffer[1] & 0xe6) === 0xe2) return 'mp3';

  return 'unknown';
}

const FORMAT_LABELS = {
  webm: 'WebM/Matroska',
  ogg: 'Ogg',
  mp3: 'MP3',
  mp4: 'MP4/M4A',
  flac: 'FLAC',
  aiff: 'AIFF',
};

/**
 * Throw a clear error unless `buffer` is a RIFF/WAVE payload.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [fileName] original name, for the message only
 */
export function assertWavBuffer (buffer, fileName) {
  const format = sniffAudioFormat(buffer);
  if (format === 'wav') return;

  const source = fileName ? ` (${fileName})` : '';
  if (format === 'empty') {
    throw new Error(`Audio payload${source} is empty. Re-record or re-select the file.`);
  }
  if (format === 'unknown') {
    throw new Error(
      `Audio payload${source} is not a WAV file and its format could not be identified. ` +
        'Convert it to 16-bit PCM WAV before transcribing.',
    );
  }
  throw new Error(
    `Audio payload${source} is ${FORMAT_LABELS[format] ?? format}, not WAV. ` +
      'The speech model only decodes WAV; convert to 16-bit PCM WAV before transcribing.',
  );
}
