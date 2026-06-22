import { NextResponse, type NextRequest } from "next/server";
import { resolveRouting } from "@/lib/availability/service";

export const dynamic = "force-dynamic";

/**
 * Routing API. POST `{ xbc }` (plus any optional properties, currently ignored)
 * and get back the agents eligible for that bucket — routing to ONLY eligible
 * agents instead of a global round-robin — with the top pick by
 * least-recently-booked. No auth: it returns only opaque agent ids + the public
 * bucket code (both derivable from the public booking flow). The internal bucket
 * NAME (the XBC routing descriptor) is deliberately NOT returned — it's an
 * internal label and this endpoint is unauthenticated (#351, sibling of #259).
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
    bucket: { code: routing.bucket.code },
    eligibleAgentIds: routing.eligibleIds,
    routedAgentId: routing.routedAgentId,
    fallbackApplied: routing.fallbackApplied,
  });
}
