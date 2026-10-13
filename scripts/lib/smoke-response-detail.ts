/**
 * What a failed canary check says about the response it judged (#3663).
 *
 * At 03:37 UTC on 2026-10-13 the canary's dry run failed and its page read
 * `got 503/undefined`. A request timeout, the booking kill switch and an
 * unconfigured key all answer 503, and the response's own `code` is what tells
 * them apart, so a failed check that judged a response now prints it.
 *
 * Imports nothing, so the canary carries no dependency it did not already have.
 */

/** The response shape every smoke helper returns: the status and the parsed body. */
export interface SmokeResponse {
  status: number;
  body: { code?: unknown; error?: unknown } | null | undefined;
}

/** Past this an `error` is left out: a page is read on a phone, and the log has it. */
export const MAX_ERROR_CHARS = 120;

/** `HTTP 503, code VERIFY_UNAVAILABLE, error "Booking failed"`, or what is missing. */
export function responseDetail(res: SmokeResponse): string {
  const body = res.body ?? {};
  const code = typeof body.code === "string" && body.code.trim() ? body.code.trim() : null;
  const parts = [`HTTP ${res.status}`, code ? `code ${code}` : "no code in the body"];
  if (typeof body.error === "string") {
    const error = body.error.replace(/\s+/g, " ").trim();
    if (error && error.length <= MAX_ERROR_CHARS) parts.push(`error "${error}"`);
    else if (error) parts.push(`an error of ${error.length} characters, not shown`);
  }
  return parts.join(", ");
}
