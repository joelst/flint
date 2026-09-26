/**
 * The header status bar is a single line. Native model-load failures arrive as a
 * long managed message with a stack appended, which is useless in a status line
 * and — before the line was reduced — stretched the header. These helpers turn
 * such an error into one sentence for the status line and its hover title, while
 * the untouched text goes to the app log.
 *
 * Nothing is truncated to fit the bar: the visible width is a CSS concern
 * (`text-overflow: ellipsis`), and truncating here would also truncate the
 * `title` a user hovers to read the whole sentence. The only cap is a guard
 * against a pathologically large message reaching a DOM attribute.
 */

/** Hard ceiling for a status line, far above any real sentence. */
const MAX_STATUS_LENGTH = 2000;

/** The full, unmodified text of an error, for the app log. */
export function errorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  // An Error with an empty message must stay empty: String(error) would report
  // the useless "Error" as if it were a detail.
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") return message;
  return String(error);
}

/** `<prefix>: <full error text>` — what the app log records. */
export function failureLogLine(prefix: string, error: unknown): string {
  const text = errorText(error);
  return text ? `${prefix}: ${text}` : prefix;
}

/**
 * One-line summary of a failure for the status bar and its hover title.
 *
 * Prefers the `JSON Error:` sentence the native loader embeds, otherwise drops
 * everything from the first stack frame onwards, then collapses whitespace.
 */
export function summarizeFailure(prefix: string, error: unknown): string {
  const raw = errorText(error);
  if (!raw.trim()) return prefix;
  const json = raw.match(/JSON Error:\s*(.+?)\s+at line/i);
  const body = json
    ? json[1]
    : raw
        // Managed frames ("   at Microsoft.AI.Foundry...") and JS frames
        // ("\n    at load (file:...)") both end the useful sentence.
        .split(/\n\s*at\s/)[0]
        .split(/\s+at\s+Microsoft\./)[0];
  const detail = body.replace(/\s+/g, " ").trim();
  const withoutPrefix = detail.toLowerCase().startsWith(`${prefix.toLowerCase()}: `)
    ? detail.slice(prefix.length + 2).trim()
    : detail;
  const line = withoutPrefix ? `${prefix}: ${withoutPrefix}` : prefix;
  return line.length > MAX_STATUS_LENGTH ? `${line.slice(0, MAX_STATUS_LENGTH - 1)}…` : line;
}
