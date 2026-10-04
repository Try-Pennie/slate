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
 * Pure, and its imports are the pure contact data scrub and the pure deadline
 * reader, so it is node-testable
 * (scripts/test-alerts.ts, scripts/test-error-text.ts).
 */
import { scrubContactData } from "../api/client-error-scrub.ts";
import { findDeadlineExceeded, type DeadlineFound } from "../fetch-within-deadline.ts";

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
  // #3263: a missed deadline says what happened in words, whole, because the
  // words are ours and the dependency they name is the one fact worth having.
  const deadline = findDeadlineExceeded({ message: raw }) ?? bareDeadline(raw);
  if (deadline) return deadlineReason(deadline);
  const status = /\bfailed: (\d{3})\b/.exec(raw)?.[1];
  if (status) {
    // Google's structured `reason` ("backendError", "rateLimitExceeded") is the
    // useful half; some endpoints answer with a bare string `error` instead.
    const reason =
      /"reason"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ??
      /"error"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    return reason ? `${status} ${reason}` : status;
  }
  // A Snowflake SQL API failure, thrown by src/lib/snowflake/client.ts as
  // `Snowflake <status>: <json body>`. Without this branch the JSON prefix eats
  // the whole budget and the reader gets `400 {"code":"000904","message":"SQL
  // compilation error: invalid…`, losing the only fact that matters: WHICH
  // identifier. That is the exact diagnosis #1197 needed and did not have.
  const snowflake = /^Snowflake (\d{3}): /.exec(raw);
  const text = snowflake
    ? `${snowflake[1]} ${
        /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw.slice(snowflake[0].length))?.[1]?.replace(/\\"/g, '"') ??
        raw.slice(snowflake[0].length)
      }`
    : raw;

  // Not an HTTP failure (an abort, a timeout, a thrown Error, a SQL compilation
  // error): keep its own text, collapsed to one line so a stack or a multi-line
  // message can't flood Slack.
  const oneLine = text.split("\n").join(" ").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  // Cut on a word boundary when there is one, so the reader never gets a
  // half-word like `"mess`. The boundary search only gives up (and cuts mid-token)
  // on a "word" longer than half the budget, which is a hash or a URL, not prose.
  const cut = oneLine.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A missed deadline as a person reads it (#3263), for every alert that carries
 * one, the booking failure page included (`dependencyTimeoutAlert`).
 *
 * The error's own sentence, "supabase did not answer within 0ms", is right for a
 * log and misleading on a page: a call refused because the request's budget was
 * ALREADY spent never reached the dependency at all, so it reads as supabase
 * being slow when the time went somewhere before it. So the three cases say three
 * different things:
 *
 *  - refused before it started: the budget was used up before Slate asked;
 *  - cut short by the budget: the call was still running when the budget ran out;
 *  - out of its own limit: the call did not answer within that limit.
 */
export function deadlineReason(found: DeadlineFound): string {
  const { label, timeoutMs, budget } = found;
  if (!budget) return `${label} did not answer within ${span(timeoutMs)}`;
  if (timeoutMs === 0) return `${budget.label} had used up its ${span(budget.totalMs)} before Slate asked ${label}`;
  return `${label} was still running when ${budget.label} ran out of its ${span(budget.totalMs)}`;
}

/** A duration in the unit a person would say it in. */
function span(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  return secs === 1 ? "1 second" : `${secs} seconds`;
}

/**
 * The deadline sentence on its own, as an Error's own message stores it (a
 * reservation's last_error, say), with nothing either side. Anchored at both ends,
 * so prose that merely contains the words is never rewritten.
 */
function bareDeadline(raw: string): DeadlineFound | null {
  const m = /^(\S.*?) did not answer within (\d+)ms(?:, when (.+) ran out of its (\d+)ms)?$/.exec(raw.trim());
  if (!m) return null;
  return {
    label: m[1],
    timeoutMs: Number(m[2]),
    budget: m[3] ? { label: m[3], totalMs: Number(m[4]) } : null,
  };
}

/**
 * The text of a caught `unknown`, whatever shape was thrown.
 *
 * `String(err)` is right for an Error subclass only by accident and wrong for the
 * commonest non-Error throw in this codebase: a supabase-js `PostgrestError` is a
 * plain `{ message, code, details, hint }` object, and `String` renders it as
 * "[object Object]", which is how a page lost the one fact it carried. So an
 * object with a string `message` gives that message (plus its `code` when it has
 * one, since a Postgres code like 23505 is the diagnosis), and nothing gives the
 * empty string so the caller's fallback applies.
 *
 * An object with NO message is never serialized. A thrown row or payload carries
 * a lead's contact data, and `shortErrorReason` reaches Slack from call sites that
 * do no scrubbing of their own, so a JSON dump here would page with somebody's
 * address in it. It is named by its code, its numeric status, or its type, which
 * is the diagnosis and not the data.
 *
 * And whatever this produces is scrubbed of contact data HERE (the shapes in
 * `client-error-scrub.ts`), so every caller is covered rather than the ones that
 * remembered to. A name has no shape and is not caught; that residue is stated in
 * the scrub module.
 */
export function errorText(err: unknown): string {
  return scrubContactData(rawErrorText(err));
}

function rawErrorText(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const { message, code, status } = err as { message?: unknown; code?: unknown; status?: unknown };
    const codeText =
      (typeof code === "string" && code) || typeof code === "number" ? String(code) : null;
    if (typeof message === "string" && message) {
      return codeText ? `${message} (code ${codeText})` : message;
    }
    if (codeText) return `an error object with code ${codeText} and no message`;
    if (typeof status === "number") return `an error object with status ${status} and no message`;
    const type = (err as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof type === "string" && type && type !== "Object"
      ? `a thrown ${type} with no message`
      : "a thrown object with no message";
  }
  return String(err);
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
  // #3263: a deadline anywhere in the cause chain is the reason, said in words.
  const deadline = findDeadlineExceeded(err);
  if (deadline) return deadlineReason(deadline);
  return shortFailureReason(errorText(err), opts.maxChars) ?? (opts.fallback ?? "no detail");
}
