/**
 * The one way an error is allowed to reach alert copy (#1135).
 *
 * An alert is read on a phone, during an incident, by someone deciding whether to
 * get out of bed. Pasting an external system's error body into it fails that
 * reader twice: the useful fact is buried in machine punctuation, and a fixed
 * width slice cuts the text off mid-word. The 2026-07-28 sync page (#1133) was
 * eight lines of Google's pretty-printed JSON ending at `"mess`.
 *
 * #1133 fixed that one alert and left this helper behind for the sweep. This
 * module is that sweep's home: every alert that carries an error routes through
 * `shortFailureReason`, so the rule lives in one place instead of being
 * re-decided, differently, at each call site.
 *
 * The division of labour, which is the whole point: the ALERT carries a short
 * human reason, and the LOG carries the full text. Cloudflare stores every
 * console line with the `Error` object serialized (see
 * docs/cloudflare-platform-notes.md), so nothing is lost by keeping the body out
 * of Slack, and `log.error(tag, fields, err)` is how you get it back.
 *
 * Pure and dependency free, so it is node-testable (scripts/test-alerts.ts).
 */

/** Longest reason a routine alert carries. Its copy already names the condition,
 *  so the error is a supporting detail and one clause is enough. */
export const MAX_REASON_CHARS = 80;

/**
 * The wider budget for an alert about a fault nobody predicted, where the error
 * text IS the diagnosis rather than a supporting detail (`reportInternalError`).
 *
 * Kept as a named exception rather than a per-call-site number, so the question
 * "how much error goes in a page" stays answered in one place. Everything else
 * about the formatting is unchanged: still one line, still cut on a word boundary.
 */
export const DIAGNOSTIC_REASON_CHARS = 300;

/**
 * A SHORT human reason for a failure, never a raw external body.
 *
 * Three shapes, in order:
 *
 * 1. An HTTP failure stored as `` `${label} failed: ${status} ${body}` `` (what
 *    `src/lib/google/calendar.ts` throws): return the status plus the machine
 *    reason parsed out of the body ("503 backendError"), and drop the body.
 * 2. Anything else, single line and short enough: return it as-is.
 * 3. Anything else, long or multi-line (a Snowflake SQL error, a stack, a driver
 *    message): collapse to one line and truncate ON A WORD BOUNDARY, so the
 *    reader never gets a half word.
 *
 * Extraction happens on READ rather than at write time, so rows already holding a
 * full body render readably too, with no migration and no write-path change.
 *
 * Returns null for no error, so a caller can omit the clause entirely rather than
 * printing "(null)".
 */
export function shortFailureReason(
  raw: string | null | undefined,
  maxChars: number = MAX_REASON_CHARS,
): string | null {
  if (!raw) return null;
  const status = /\bfailed: (\d{3})\b/.exec(raw)?.[1];
  if (status) {
    // Google's structured `reason` ("backendError", "rateLimitExceeded") is the
    // useful half; some endpoints answer with a bare string `error` instead.
    const reason =
      /"reason"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ??
      /"error"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    return reason ? `${status} ${reason}` : status;
  }
  // Not an HTTP failure (an abort, a timeout, a thrown Error, a SQL compilation
  // error): keep its own text, collapsed to one line so a stack or a multi-line
  // message can't flood Slack.
  const oneLine = raw.split("\n").join(" ").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  // Cut on a word boundary when there is one, so the reader never gets a
  // half-word like `"mess`. The boundary search only gives up (and cuts mid-token)
  // on a "word" longer than half the budget, which is a hash or a URL, not prose.
  const cut = oneLine.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * `shortFailureReason` for a caught `unknown`, with a stated fallback.
 *
 * Every catch block was independently deciding between `err.message`,
 * `String(err)`, and a slice of one of them. This is that decision, once.
 */
export function shortErrorReason(
  err: unknown,
  opts: { fallback?: string; maxChars?: number } = {},
): string {
  const raw = err instanceof Error ? err.message : String(err);
  return shortFailureReason(raw, opts.maxChars) ?? (opts.fallback ?? "no detail");
}
