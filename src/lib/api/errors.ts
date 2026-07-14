import { NextResponse } from "next/server";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/** The one client-facing message for an unexpected server fault. Shared so every
 *  route (the six #598 mutation routes and the direct bot API, #707) says the
 *  same thing and none leak internal detail. */
export const GENERIC_ERROR_MESSAGE =
  "Something went wrong on our end. Please try again.";

/** Long enough that a route failing on every request pages once rather than per
 *  request; short enough that a fault still breaking an hour later is news again.
 *  Keyed per route (below), so this is a per-route budget, not a global one. */
export const INTERNAL_ERROR_COOLDOWN_MS = 15 * 60 * 1000;

/** How much real error text to carry into Slack: enough to identify the fault,
 *  bounded so a giant stack can't wreck the message. */
const ALERT_DETAIL_CHARS = 300;

/**
 * The single chokepoint for an UNEXPECTED server fault: log it, and TELL someone.
 *
 * The logging half was always real (#708 verified Cloudflare captures
 * `console.error`), but nothing watches a 7-day log with no alerting on top, so a
 * silent 500 was only ever found by someone going to look (#802). This fires a
 * throttled Slack alert alongside the log.
 *
 * Throttled PER CONTEXT (`internal_error:<route>`), so one persistently-broken
 * route can't throttle away the first alert from a different route breaking at
 * the same time.
 *
 * The alert can never escape: it writes to `alert_state`, so whatever broke the
 * route can break the alert too, and a monitoring failure must not become a
 * booking failure. Its own failure is logged, never swallowed into silence.
 */
export async function reportInternalError(err: unknown, context: string): Promise<void> {
  log.error("api", { msg: "unexpected error", context }, err);

  const detail = (err instanceof Error ? err.message : String(err)).slice(0, ALERT_DETAIL_CHARS);
  await sendThrottledAlert(
    `internal_error:${context}`,
    INTERNAL_ERROR_COOLDOWN_MS,
    `Slate: unexpected server error on ${context} (${detail}). The caller got a generic 500. Full detail is in the Worker logs at level error.`,
  ).catch((alertErr) => {
    log.error("api", { msg: "internal-error alert failed", context }, alertErr);
  });
}

/**
 * The single generic 500 for an UNEXPECTED fault on a client- or admin-facing
 * mutation route (#598). Typed, expected errors (409/404/503/400/403) keep
 * their own messages and are mapped before this is reached; this is only the
 * fallthrough.
 *
 * The real error (table names, Google error text, stack) is logged server-side
 * with its route context and posted to Slack, but NEVER returned to the client.
 * Neither a public lead nor a compromised admin session must see internal detail.
 * Low-grade info disclosure that aids recon otherwise leaks straight through
 * `err.message`.
 *
 * To read the logged detail back, search the bare `message` field, NOT
 * `$metadata.message` (which holds only invocation records). See AGENTS.md.
 */
export async function internalErrorResponse(
  err: unknown,
  context: string,
): Promise<NextResponse> {
  await reportInternalError(err, context);
  return NextResponse.json({ error: GENERIC_ERROR_MESSAGE }, { status: 500 });
}
