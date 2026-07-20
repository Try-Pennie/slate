import { NextResponse, type NextRequest } from "next/server";
import { bookableApiKey } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { applyBookableByEmail } from "@/lib/bookable/service";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * Move an agent in/out of the bookable pool programmatically (#281). Mirrors the
 * offboarding lifecycle API's shape (Bearer, email + value, one URL both
 * directions) so the roster automation has one mental model. Auth is
 * BOOKABLE_API_KEY (503 when unset, like the reassign/offboarding APIs).
 *
 *   POST { email, bookable: boolean }
 *     -> 200 { status: "applied" | "noop", userId, bookable }
 *     -> 404 unknown user
 *     -> 409 { status: "blocked", reason: "google_unreachable" } (activation guard)
 *     -> 400 | 401 | 503
 *
 * The activation guard blocks making an agent bookable when their Google
 * calendar is unreachable, and fires a named alert (see the service).
 */
export async function POST(req: NextRequest) {
  const key = bookableApiKey();
  if (!key) {
    return NextResponse.json({ error: "bookable api not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), key)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { email?: string; bookable?: unknown };
  const email = String(body.email ?? "").trim();
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  // Require a real boolean: never coerce the string "false" into a truthy flip.
  if (typeof body.bookable !== "boolean") {
    return NextResponse.json({ error: "bookable must be a boolean (true or false)" }, { status: 400 });
  }

  try {
    const result = await applyBookableByEmail(email, body.bookable);
    if (result.status === "not_found") {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    if (result.status === "blocked") {
      return NextResponse.json(result, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return internalErrorResponse(err, "users/bookable");
  }
}
