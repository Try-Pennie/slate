import { NextResponse, type NextRequest } from "next/server";
import { getBucketSlotsWithFallback } from "@/lib/availability/slot-cache";
import { filterSlotsFromNow } from "@/lib/availability/compute";
import { availabilityWithinLimit, clientIp } from "@/lib/rate-limit";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { internalErrorResponse } from "@/lib/api/errors";
import { emptyReason, type EmptyReason } from "@/lib/availability/empty-reason";
import { searchWindowDays } from "@/lib/availability/bookable-days";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { DateTime } from "luxon";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * GET /api/availability?bucket=411&from=ISO&to=ISO
 * Reads precomputed slots from the cache — no live Google calls.
 */
export async function GET(req: NextRequest) {
  // #1049: an UNPREDICTED fault here used to fall through to a framework 500
  // with nothing told to anyone. This is the booker's hot path, and its failure
  // mode is the worst kind: the lead sees NO times, which looks exactly like a
  // genuinely full calendar, so a broken deploy reads as a quiet day (the #277
  // shape). Every expected outcome below (429, 400, 404) is returned from inside
  // and keeps its own status, so the catch only ever sees a real fault.
  try {
    return await handle(req);
  } catch (err) {
    return internalErrorResponse(err, "availability");
  }
}

async function handle(req: NextRequest) {
  // Edge-throttle (#56) — in-datacenter, no DB round-trip, so the cached hot
  // path stays fast. Fails open.
  if (!(await availabilityWithinLimit(clientIp(req.headers)))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

  const params = req.nextUrl.searchParams;
  const code = params.get("bucket");
  if (!code) {
    return NextResponse.json({ error: "Missing bucket" }, { status: 400 });
  }

  const now = Date.now();
  const from = params.get("from") ?? new Date(now).toISOString();
  const toParam = params.get("to");

  // A synthetic test bucket (#396) is invisible to the public: only the
  // key-authed smoke test may read its slots. Resolve auth up front (DB-free:
  // parse the bearer against env keys) and gate the test bucket BEFORE the tier
  // cascade, so an unauthorized hidden bucket 404s doing the same single resolve
  // an unknown code does (no timing signal that it exists, #601).
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const authorizedForTest = authenticateBearer(
    req.headers.get("authorization"),
    keys,
  ).ok;

  const result = await getBucketSlotsWithFallback(code, from, authorizedForTest);
  if (!result) {
    // Unknown code and an unauthorized hidden test bucket both land here with
    // the identical response.
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }

  let slots = filterSlotsFromNow(result.slots, now, result.eventType.min_notice_min);
  if (toParam) {
    const toMs = Date.parse(toParam);
    slots = slots.filter((s) => Date.parse(s) <= toMs);
  }

  // Observability headers (#257/#234): freshness of the served slots and which
  // tier of the read path answered (L1 cache hit / L2 precomputed row / cold live
  // compute). Diagnostic only, never routing internals (#259). A stuck refresher
  // shows as an old x-slots-computed-at; a persistent x-slot-cache=nostore means
  // rows aren't being precomputed.
  const headers: Record<string, string> = {
    "x-slot-cache": { hit: "hit", row: "miss", compute: "nostore" }[result.source],
  };
  if (result.computedAt) headers["x-slots-computed-at"] = result.computedAt;

  // #1328: with nothing to offer, the booker needs to know WHY. "All times are
  // taken right now" is untrue in both halves when the reason is a closure, and a
  // lead reads it as a busy week and comes back tomorrow to the same screen.
  // Computed only when the result is actually empty, so the ordinary hot path pays
  // nothing extra, and best-effort: if the reason cannot be worked out the client
  // falls back to the vaguer copy rather than the request failing.
  const emptyBecause = slots.length === 0 ? await whyEmpty(now) : null;

  // Rule #259: leads must never see routing internals, even in the network
  // payload. Tier-drop is intentionally invisible: we report the REQUESTED
  // bucket code (what the lead asked for) and serve the EFFECTIVE tier's slots,
  // but the `routing` meta stays server-side only — never sent to the client.
  return NextResponse.json(
    {
      bucket: { code: result.routing.requested_code },
      orgName: result.orgName,
      eventType: {
        name: result.eventType.name,
        description: result.eventType.description,
        durationMin: result.eventType.duration_min,
      },
      slots,
      emptyBecause,
    },
    { headers },
  );
}

/**
 * Why an empty result is empty (#1328), or null when it cannot be told.
 *
 * Null rather than a guess: the client then shows the vaguer existing copy, which
 * is merely unhelpful, whereas a wrongly claimed closure names a date the lead
 * will act on. Reads the same cached hours the gate uses, so no extra round trip
 * on a warm isolate.
 */
async function whyEmpty(nowMs: number): Promise<EmptyReason | null> {
  try {
    const [hours, horizonDays] = await Promise.all([
      loadBusinessHoursCached(),
      loadBookingHorizonDays(),
    ]);
    const fromDay = DateTime.fromMillis(nowMs).setZone(hours.zone).toISODate();
    if (!fromDay) return null;
    return emptyReason({
      businessHours: hours.rules,
      fromDay,
      // The same window the slots were searched over, so "every day we looked at
      // was shut" means exactly that rather than some other span.
      searchedDays: searchWindowDays(horizonDays),
      zone: hours.zone,
    });
  } catch (err) {
    log.warn("availability", { msg: "could not tell why availability is empty" }, err);
    return null;
  }
}
