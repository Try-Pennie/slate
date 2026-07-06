import { NextResponse } from "next/server";

/**
 * Thrown by the role guards (`requireRole` & friends) when a caller lacks the
 * required rank. A distinct type so the HTTP layer can map an authorization
 * failure to a 403 while letting genuine faults surface as 500s (#606).
 */
export class NotAuthorizedError extends Error {
  constructor(message = "Not authorized") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

/**
 * Map a guard throw to a clean 403 for a role-gated route. Anything that isn't an
 * authorization failure is rethrown, so a real server fault still becomes a 500.
 * The single place admin routes funnel their guard rejection through (#606).
 */
export function forbiddenResponse(err: unknown): NextResponse {
  if (err instanceof NotAuthorizedError) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  throw err;
}
