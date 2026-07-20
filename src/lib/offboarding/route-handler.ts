import { NextResponse, type NextRequest } from "next/server";
import { offboardingApiKey } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { applyLifecycleByEmail } from "@/lib/offboarding/service";
import type { LifecycleAction } from "@/lib/offboarding/plan";

// The consolidated endpoint's public verbs (#282). The internal state machine
// uses "reactivate"; the automation-facing URL uses "activate" so both the
// bookable-toggle API (#281) and this one share one email+action mental model.
const API_ACTION_TO_INTERNAL: Record<string, LifecycleAction> = {
  activate: "reactivate",
  deactivate: "deactivate",
};

/**
 * Bearer gate shared by the lifecycle endpoints: OFFBOARDING_API_KEY, header
 * only (no ?secret= query param), 503 when unset (like the reassign API), 401 on
 * a bad token. Returns the failing response, or null when the caller may proceed.
 */
function lifecycleAuthFailure(req: NextRequest): NextResponse | null {
  const key = offboardingApiKey();
  if (!key) {
    return NextResponse.json({ error: "offboarding api not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), key)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return null;
}

/**
 * Applies the lifecycle change and maps the result to a response. Idempotent:
 * deactivating a user who isn't in Slate is a 200 no-op (the desired end state,
 * not active, already holds), so the caller's automation doesn't trip on it;
 * reactivating a missing user IS a real error (can't restore someone never
 * synced) and stays a 404.
 */
async function applyAndRespond(email: string, action: LifecycleAction): Promise<NextResponse> {
  const result = await applyLifecycleByEmail(email, action);
  if (result.status === "not_found") {
    if (action === "deactivate") {
      return NextResponse.json({ status: "not_found", message: "user not found" });
    }
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}

/**
 * Builds the POST handler for the fixed-action lifecycle endpoints
 * (/api/users/deactivate and /api/users/reactivate), kept so existing callers
 * keep working after #282 introduced the consolidated URL below.
 *
 *   POST { email } -> 200 { status, userId?, deactivate? } | 400 | 401 | 404 | 503
 */
export function makeLifecycleHandler(action: LifecycleAction) {
  return async function POST(req: NextRequest) {
    const fail = lifecycleAuthFailure(req);
    if (fail) return fail;
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = String(body.email ?? "").trim();
    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }
    return applyAndRespond(email, action);
  };
}

/**
 * Builds the POST handler for the consolidated lifecycle endpoint
 * (/api/users/lifecycle, #282): one URL taking email + action, so the
 * offboarding automation integrates against a single endpoint instead of
 * knowing both /deactivate and /reactivate.
 *
 *   POST { email, action: "activate" | "deactivate" }
 *     -> 200 { status, userId?, deactivate? } | 400 | 401 | 404 | 503
 */
export function makeLifecycleActionHandler() {
  return async function POST(req: NextRequest) {
    const fail = lifecycleAuthFailure(req);
    if (fail) return fail;
    const body = (await req.json().catch(() => ({}))) as { email?: string; action?: string };
    const email = String(body.email ?? "").trim();
    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }
    const action = API_ACTION_TO_INTERNAL[String(body.action ?? "").trim()];
    if (!action) {
      return NextResponse.json(
        { error: "action must be 'activate' or 'deactivate'" },
        { status: 400 },
      );
    }
    return applyAndRespond(email, action);
  };
}
