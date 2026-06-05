import { NextResponse, type NextRequest } from "next/server";
import { resolveRouting } from "@/lib/availability/service";

export const dynamic = "force-dynamic";

/**
 * Routing API. POST `{ xbc }` (plus any optional properties, currently ignored)
 * and get back the agents eligible for that bucket — routing to ONLY eligible
 * agents instead of a global round-robin — with the top pick by
 * least-recently-booked. No auth: it exposes no sensitive data (just opaque
 * agent ids for a public bucket code, derivable from the public booking flow).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { xbc?: string };
  const xbc = String(body.xbc ?? "").trim();
  if (!xbc) {
    return NextResponse.json({ error: "xbc is required" }, { status: 400 });
  }

  const routing = await resolveRouting(xbc);
  if (!routing) {
    return NextResponse.json({ error: "unknown bucket" }, { status: 404 });
  }

  return NextResponse.json({
    bucket: { code: routing.bucket.code, name: routing.bucket.name },
    eligibleAgentIds: routing.eligibleIds,
    routedAgentId: routing.routedAgentId,
    fallbackApplied: routing.fallbackApplied,
  });
}
