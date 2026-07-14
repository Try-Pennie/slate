import { NextResponse } from "next/server";

/** The one client-facing message for an unexpected server fault. Shared so every
 *  route (the six #598 mutation routes and the direct bot API, #707) says the
 *  same thing and none leak internal detail. */
export const GENERIC_ERROR_MESSAGE =
  "Something went wrong on our end. Please try again.";

/**
 * The single generic 500 for an UNEXPECTED fault on a client- or admin-facing
 * mutation route (#598). Typed, expected errors (409/404/503/400/403) keep
 * their own messages and are mapped before this is reached; this is only the
 * fallthrough.
 *
 * The real error (table names, Google error text, stack) is logged server-side
 * with its route context but NEVER returned to the client. Neither a public
 * lead nor a compromised admin session must see internal detail. Low-grade info
 * disclosure that aids recon otherwise leaks straight through `err.message`.
 *
 * Logging is `console.error`, matching the rest of the app. Cloudflare DOES
 * capture it: verified in production (#708) with a canary that logged a unique
 * token, which came back at level `error` with the Error object serialized. To
 * read it, filter on the bare `message`/`level` fields, NOT `$metadata.message`
 * /`$metadata.level`: those hold only invocation records, so filtering on them
 * returns nothing and makes the logs look empty. See AGENTS.md.
 */
export function internalErrorResponse(err: unknown, context: string): NextResponse {
  console.error(`[${context}] unexpected error`, err);
  return NextResponse.json({ error: GENERIC_ERROR_MESSAGE }, { status: 500 });
}
