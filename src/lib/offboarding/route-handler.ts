import { NextResponse, type NextRequest } from "next/server";
import { offboardingApiKey } from "@/lib/env";
import { applyLifecycleByEmail } from "@/lib/offboarding/service";
import type { LifecycleAction } from "@/lib/offboarding/plan";

/**
 * Builds the POST handler for the offboarding lifecycle endpoints
 * (/api/users/deactivate and /api/users/reactivate). Bearer-authed with
 * OFFBOARDING_API_KEY (503 when unset, like the reassign API), idempotent.
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
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  };
}
