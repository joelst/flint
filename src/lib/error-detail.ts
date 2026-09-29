/**
 * Format an unknown thrown value as a short, displayable string.
 *
 * Everything here exists because this runs on the error path, where a second failure has
 * nowhere to go: the caller is an error banner or an error boundary's fallback, so a throw
 * while formatting replaces the message the user needed with a blank view.
 *
 * `String(value)` is not safe for a thrown value. JavaScript can throw anything, and several
 * shapes reachable in a browser make it throw again:
 *
 * - `Object.create(null)` has no `toString`, so `String()` throws `TypeError`.
 * - A `toString`/`@@toPrimitive` that throws (a getter, a Proxy trap, a partly-constructed
 *   object) propagates out of `String()`.
 * - A revoked `Proxy` throws on every access, including reading `.message`.
 * - A bare `Symbol` throws `TypeError` on implicit string conversion.
 *
 * The result is only ever shown to a human, so an unformattable value degrades to a fixed
 * label rather than being retried or rethrown.
 */

/** Longest detail kept. Long enough for a real stack-free message, short enough for a banner. */
export const MAX_ERROR_DETAIL = 300;

function truncate(text: string): string {
  if (text.length <= MAX_ERROR_DETAIL) return text;
  return `${text.slice(0, MAX_ERROR_DETAIL - 1)}…`;
}

/**
 * Best-effort `name: message` for a thrown value.
 *
 * Returns a non-empty string for every input, including values that throw when converted.
 */
export function formatErrorDetail(value: unknown): string {
  try {
    if (value instanceof Error) {
      // `name` and `message` are ordinary properties and can be absent, non-string, or
      // throwing getters; the surrounding try/catch is what makes reading them safe.
      const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Error';
      const message = typeof value.message === 'string' ? value.message.trim() : '';
      return truncate(message ? `${name}: ${message}` : name);
    }
    if (value === null || value === undefined) return 'unknown error';
    if (typeof value === 'symbol') return truncate(value.toString());
    if (typeof value === 'object') {
      // A non-Error object is frequently `{message}` from a rejected promise or an IPC reply.
      const message = (value as { message?: unknown }).message;
      // Trimmed before the emptiness test: a whitespace-only message would otherwise pass the
      // check and render as a blank line where the reason should be.
      if (typeof message === 'string' && message.trim()) return truncate(message.trim());
    }
    const text = String(value).trim();
    // `[object Object]` is what a plain object without a usable `message` or `toString`
    // stringifies to. It is non-empty, so it passes every emptiness check while telling the
    // user nothing; a custom `toString` that returns something real is still preferred.
    if (!text || text === '[object Object]') return 'unknown error';
    return truncate(text);
  } catch {
    // Reached when the value itself resists conversion. There is no better description
    // available, and claiming a specific cause here would be inventing one.
    return 'an error that could not be displayed';
  }
}

/**
 * Compose the banner line for an uncaught failure.
 *
 * Kept next to {@link formatErrorDetail} so the whole error-path string building is covered
 * by the same tests; the context label is supplied by the caller and is never user data.
 */
export function formatUncaughtError(context: string, value: unknown): string {
  const label = typeof context === 'string' && context.trim() ? context.trim() : 'Unexpected error';
  return `${label} — ${formatErrorDetail(value)}`;
}
