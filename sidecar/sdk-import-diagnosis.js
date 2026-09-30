/**
 * Classifying the bare `import('foundry-local-sdk')` failure.
 *
 * Installed builds ship the SDK beside the sidecar with no `node_modules` tree, so bare
 * specifier resolution always fails there before the packaged-path candidates are tried.
 * That is the expected layout, not a fault, and warning about it on every launch trains
 * users to ignore the warnings that do matter.
 *
 * The error code alone cannot make that call. `ERR_MODULE_NOT_FOUND` is also what Node
 * raises when the SDK *is* resolvable but one of its own internal imports is missing —
 * a genuinely broken install, which must stay a warning. Only a failure naming the
 * specifier the sidecar asked for is the expected one.
 */

const NOT_FOUND_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

/**
 * Node names the unresolved specifier in the message: ESM reports `Cannot find package
 * 'x' imported from …`, CJS reports `Cannot find module 'x'`. A missing file *inside* a
 * resolved package names that file's path instead, which is why the name is matched
 * rather than merely checking for the substring anywhere in the text.
 */
const ABSENT_SPECIFIER = /Cannot find (?:package|module) '([^']*)'/;

/**
 * True when `err` says the named package itself could not be resolved.
 *
 * @param {unknown} err Rejection from a dynamic `import()`.
 * @param {string} specifier Bare specifier that was requested.
 * @returns {boolean}
 */
export function isPackageAbsentError (err, specifier) {
  if (!err || typeof err !== 'object') return false;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (typeof code !== 'string' || !NOT_FOUND_CODES.has(code)) return false;
  const message = /** @type {{ message?: unknown }} */ (err).message;
  if (typeof message !== 'string') return false;
  const match = ABSENT_SPECIFIER.exec(message);
  return match !== null && match[1] === specifier;
}
