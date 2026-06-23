import { NextResponse, type NextRequest } from "next/server";
import { offboardingApiKey } from "@/lib/env";
import { applyLifecycleByEmail } from "@/lib/offboarding/service";
import type { LifecycleAction } from "@/lib/offboarding/plan";

/**
 * Builds the POST handler for the offboarding lifecycle endpoints
 * (/api/users/deactivate and /api/users/reactivate). Bearer-authed with
 * OFFBOARDING_API_KEY (503 when unset, like the reassign API), idempotent.
 * Deactivating an unknown user is a 200 no-op (already not active); a 404 only
 * comes from reactivating an unknown user.
 *
 *   POST { email } -> 200 { status, userId?, deactivate? } | 400 | 401 | 404 | 503
 */
export function makeLifecycleHandler(action: LifecycleAction) {
  return async function POST(req: NextRequest) {
    const key = offboardingApiKey();
    if (!key) {
      return NextResponse.json({ error: "offboarding api not configured" }, { status: 503 });
    }
    if (req.headers.get("authorization") !== `Bearer ${key}`) {
      return new NextResponse("unauthorized", { status: 401 });
    }
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = String(body.email ?? "").trim();
    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }
    const result = await applyLifecycleByEmail(email, action);
    if (result.status === "not_found") {
      // Deactivating a user who isn't in Slate is idempotent — the desired end
      // state (not active) already holds — so report success, not an error the
      // caller's automation trips on. Reactivating a missing user IS a real
      // error (can't restore someone who was never synced), so keep that a 404.
      if (action === "deactivate") {
        return NextResponse.json({ status: "not_found", message: "user not found" });
      }
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  };
}
