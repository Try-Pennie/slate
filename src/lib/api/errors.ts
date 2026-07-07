import { NextResponse } from "next/server";

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
 * Logging is `console.error`, matching the rest of the app; see #708 on whether
 * Cloudflare reliably captures it.
 */
export function internalErrorResponse(err: unknown, context: string): NextResponse {
  console.error(`[${context}] unexpected error`, err);
  return NextResponse.json(
    { error: "Something went wrong on our end. Please try again." },
    { status: 500 },
  );
}
