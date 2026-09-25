// Model-name classification heuristics shared between the sidecar and the browser bundle.
//
// Some catalog models carry no discriminating task/capability metadata (an opaque ASR
// model like `nemotron-3.5-asr-streaming-0.6b` reports neither), so classification must
// fall back to matching the alias/variant-id text itself. Two independent call sites need
// the exact same answer -- the sidecar's `getSTTModels` IPC query (Audio picker) and the
// frontend's endpoint self-test / chat-vs-audio classifier -- so this module deliberately
// imports nothing, not even Node builtins, and is required by the sidecar and re-exported
// into `src/lib` for the frontend, the same way `prompt-template.js` is shared.

/**
 * Whether a model/variant name looks like a speech (ASR/STT) model based on naming
 * conventions alone, for models whose task/capabilities metadata doesn't say so.
 *
 * `nemotron-speech-...` is the original English-only Nemotron ASR family; newer
 * generations (e.g. `nemotron-3.5-asr-streaming-0.6b`) use an `-asr-` marker instead of
 * `-speech-`, so match either rather than only the original naming.
 *
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeSpeech(name) {
  return /(whisper|parakeet|-stt(?:-|$)|(?:^|-)stt-|nemotron.*(?:speech|asr))/.test(
    (name || '').toLowerCase(),
  );
}

/**
 * Classify whether the currently proven AudioSession URI request shape should
 * be attempted for a speech model.
 *
 * `supported` is intentionally narrow: only Whisper has been verified with
 * Item.audioFromUri() in the pinned SDK. Nemotron needs an ItemQueue/raw-PCM
 * request and Parakeet has no working AudioSession shape yet. Unknown families
 * remain `unknown` so a new model can still probe the additive path and fall
 * back safely if the runtime rejects it.
 *
 * @param {{ alias?: unknown, id?: unknown, info?: {
 *   alias?: unknown, id?: unknown, modelType?: unknown, task?: unknown, capabilities?: unknown
 * } }|null|undefined} model
 * @returns {'supported'|'unsupported'|'unknown'}
 */
function audioSessionUriSupport(model) {
  const info = model?.info || {};
  const names = [
    model?.alias,
    model?.id,
    info.alias,
    info.id,
    info.modelType,
    info.task,
    info.capabilities,
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();

  if (/parakeet/.test(names) || /nemotron.*(?:speech|asr)/.test(names)) {
    return 'unsupported';
  }
  if (/whisper/.test(names)) return 'supported';
  return 'unknown';
}

export { looksLikeSpeech, audioSessionUriSupport };
