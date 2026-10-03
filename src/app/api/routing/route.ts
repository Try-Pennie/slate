import { NextResponse, type NextRequest } from "next/server";
import { resolveRouting } from "@/lib/availability/service";
import {
  allowRequest,
  clientIp,
  routingWithinLimit,
  ROUTING_HOURLY_RATE_RULES,
} from "@/lib/rate-limit";
import { ROUTING_LIMITER } from "@/lib/rate-limit-core";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";

export const dynamic = "force-dynamic";

/**
 * Routing API. POST `{ xbc }` (plus any optional properties, currently ignored)
 * and get back the agents eligible for that bucket — routing to ONLY eligible
 * agents instead of a global round-robin — with the top pick by
 * least-recently-booked. No auth: it returns only opaque agent ids + the public
 * bucket code (both derivable from the public booking flow). The internal bucket
 * NAME (the XBC routing descriptor) is deliberately NOT returned — it's an
 * internal label and this endpoint is unauthenticated (#351, sibling of #259).
 * Being unauthenticated, it's throttled per IP (#596) to bound enumeration and
 * DB load; resolveRouting is read-only, so probes never perturb routing state.
 */
export async function POST(req: NextRequest) {
  // Per-IP throttle (#596): this endpoint is unauthenticated and does a
  // DB-backed resolve per call, so bound anonymous enumeration + DB load.
  // Fails open: a limiter hiccup must never break a legitimate lookup. The
  // per-minute burst window runs at the edge (#961, no DB round-trip); the
  // hourly cap stays in the DB.
  const ip = clientIp(req.headers);
  if (
    !(await routingWithinLimit(ip)) ||
    !(await allowRequest({ kind: "address", ip, policy: ROUTING_LIMITER }, ROUTING_HOURLY_RATE_RULES))
  ) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

  // #3135: read under a byte cap rather than buffering whatever arrives.
  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const body = (read.value ?? {}) as { xbc?: string };
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
