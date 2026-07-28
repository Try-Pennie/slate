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

/** Longest reason we will put in an alert line before truncating. */
export const MAX_REASON_CHARS = 80;

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
export function shortFailureReason(raw: string | null | undefined): string | null {
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
  if (oneLine.length <= MAX_REASON_CHARS) return oneLine;
  // Cut on a word boundary when there is one, so the reader never gets a
  // half-word like `"mess`.
  const cut = oneLine.slice(0, MAX_REASON_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * `shortFailureReason` for a caught `unknown`, with a stated fallback.
 *
 * Every catch block was independently deciding between `err.message`,
 * `String(err)`, and a slice of one of them. This is that decision, once.
 */
export function shortErrorReason(err: unknown, fallback = "no detail"): string {
  const raw = err instanceof Error ? err.message : String(err);
  return shortFailureReason(raw) ?? fallback;
}
