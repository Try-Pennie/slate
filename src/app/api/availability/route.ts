import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import {
  bookerUnstaffedAlert,
  bookingWindowExtendedAlert,
  BOOKER_UNSTAFFED_COOLDOWN_MS,
  BOOKING_WINDOW_EXTENDED_COOLDOWN_MS,
} from "@/lib/booking/alert-copy";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import type { Bucket } from "@/lib/db/types";
import { NextResponse, type NextRequest } from "next/server";
import { getBucketSlotsWithFallback } from "@/lib/availability/slot-cache";
import { filterSlotsFromNow } from "@/lib/availability/compute";
import { availabilityWithinLimit, clientIp } from "@/lib/rate-limit";
import { authenticateBearer, CANARY_CALLERS } from "@/lib/booking/api-auth";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";
import { refuseUnlessTestPass } from "@/lib/embed/test-pass-gate";
import { internalErrorResponse } from "@/lib/api/errors";
import { explainEmptyWindow, type EmptyReason } from "@/lib/availability/empty-reason";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { log } from "@/lib/log";
import { agentLinkAvailabilityLive } from "@/lib/agent-link/service";
import { bookingRescheduleTimesLive } from "@/lib/booking/reschedule-times-live";

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

  // #2073: an agent's own booking link names ONE agent and never routes, so it
  // is served from that agent's live times rather than a pool's cached ones.
  // Behind the same rate limit as every public read (above), and inside the same
  // catch, so a fault answers 500 rather than an empty week.
  const advisor = params.get("advisor");
  if (advisor !== null) {
    const reply = await agentLinkAvailabilityLive(
      advisor,
      { from: params.get("from"), to: params.get("to") },
      Date.now(),
    );
    return NextResponse.json(reply.body, { status: reply.status });
  }

  // #2827: the times a call booked through an advisor's link may MOVE to, keyed
  // on the booking's manage token. Its move keeps the advisor or refuses, so it is
  // offered that advisor's times through the same compute as the branch above,
  // never the pool of the bucket it is stored in. The token already lets its
  // holder move this booking, and it unlocks only this booking's own advisor: the
  // request names nobody. A routed booking is refused here and reads its pool
  // through `bucket=` below, exactly as it always has.
  const booking = params.get("booking");
  if (booking !== null) {
    const reply = await bookingRescheduleTimesLive(
      { manageToken: booking },
      { from: params.get("from"), to: params.get("to") },
      Date.now(),
    );
    return NextResponse.json(reply.body, { status: reply.status });
  }

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
  // #2645, #2854: the canary's own key only, never a partner's.
  // #2660: OR the code is the PUBLIC test bucket and (#2666) the caller carries a
  // good pass for it, which `/book` hands only to a page on an approved website. The
  // pass is checked against THIS code, so it can never authorise a hidden bucket or
  // a real one, and the hidden buckets' single resolve timing is unchanged. A
  // refused pass answers 403 with its own code, never the 404: the public bucket's
  // existence is no secret, and the Booker has to tell an expired pass apart.
  const keys = configuredBookingApiKeys(CANARY_CALLERS);
  let authorizedForTest = authenticateBearer(req.headers.get("authorization"), keys).ok;
  if (!authorizedForTest && isPublicTestBucket(code)) {
    const refused = refuseUnlessTestPass(req.headers, code, "availability");
    if (refused) return NextResponse.json(refused.body, { status: refused.status });
    authorizedForTest = true;
  }

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
  const emptyBecause =
    slots.length === 0 ? await whyEmpty(now, result.bucket) : null;

  // #2158, Dan's call: a lead meeting a bucket with nobody in it is worth
  // knowing about the moment it happens, not only when the hourly sweep next
  // looks. It fires only on a REAL bucket (the SMOKE fixtures are staffed on
  // purpose and the canary watches them), only when the pool is genuinely empty
  // rather than merely unread, and it is throttled per bucket, because this is
  // the hot path and one bot can load it as often as it likes.
  //
  // It is deliberately a SECOND signal rather than a replacement for
  // `empty_tier:*`: that one measures the state whether or not anybody is
  // looking, which matters because before cutover almost nobody is (#1394). This
  // one says a person just met it.
  if (emptyBecause?.kind === "unstaffed" && !result.bucket.is_test) {
    // alert-key: booker_unstaffed:*
    await sendThrottledAlert(
      `booker_unstaffed:${result.bucket.code}`,
      BOOKER_UNSTAFFED_COOLDOWN_MS,
      bookerUnstaffedAlert(result.bucket.code),
    ).catch(logAlertSendFailure(`booker_unstaffed:${result.bucket.code}`));
  }

  // #2841: every tier this lead's cascade may use was full for the whole three
  // open day window, so times past it were served. The lead can still book, so
  // the response is unchanged; somebody should look. Keyed to the code the lead
  // ASKED for, which is what the landing page sent, and throttled per code, because
  // this is the hot path. A failed send never costs the lead their times.
  if (result.routing.window_extended && !result.bucket.is_test) {
    // alert-key: booking_window_extended:*
    await sendThrottledAlert(
      `booking_window_extended:${result.routing.requested_code}`,
      BOOKING_WINDOW_EXTENDED_COOLDOWN_MS,
      bookingWindowExtendedAlert(result.routing.requested_code),
    ).catch(logAlertSendFailure(`booking_window_extended:${result.routing.requested_code}`));
  }

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
 *
 * The assembly itself lives in `explainEmptyWindow`, shared with the monitor lane
 * (#1420). This function is only the two reads and their failure handling. The lane
 * watches whether an answer is REACHABLE at all, and it has to ask the same
 * question this does or it could only ever confirm its own copy of it (L107).
 *
 * Each read is caught on its own rather than under one try, so the blocker names
 * which input was missing instead of collapsing both into "something failed". The
 * blocker is dropped here (the lead is served the vaguer copy either way) and kept
 * in the log line, which is where a forensic reader looks.
 */
async function whyEmpty(nowMs: number, bucket: Bucket): Promise<EmptyReason | null> {
  const [hours, horizonDays, pooledAgents] = await Promise.all([
    loadBusinessHoursCached().catch((err) => {
      log.warn("availability", { msg: "could not read the org's week" }, err);
      return null;
    }),
    loadBookingHorizonDays().catch((err) => {
      log.warn("availability", { msg: "could not read the booking horizon" }, err);
      return null;
    }),
    // #2158: the one thing that can tell a full bucket from an empty one, since
    // both produce the same empty list. Through the 60s cached resolver, and only
    // on this branch, so the ordinary hot path pays nothing. A failed read is
    // NULL, never zero: zero would tell every lead nobody works here on the
    // strength of a query that never ran.
    eligibleAgentIdsCached(bucket)
      .then((r) => r.ids.length)
      .catch((err) => {
        log.warn("availability", { msg: "could not count the bucket's pool" }, err);
        return null;
      }),
  ]);
  // An UNEXPECTED throw from the classifier still serves the window. This route's
  // whole failure mode is that showing a lead no times looks exactly like a full
  // calendar, so a fault in the explanation must never take out the response that
  // carries the times themselves (#1049).
  let outcome: ReturnType<typeof explainEmptyWindow>;
  try {
    outcome = explainEmptyWindow({ hours, horizonDays, nowMs, pooledAgents });
  } catch (err) {
    log.warn("availability", { msg: "the empty-window classifier threw" }, err);
    return null;
  }
  if (outcome.reason === null) {
    // The lead sees "We could not work out what is available right now" (#1414).
    // Honest, and invisible to us on its own, which is why the monitor lane asks the
    // same question every minute rather than waiting for this line to appear (#1420).
    log.warn("availability", {
      msg: "could not tell why availability is empty",
      blocked_by: outcome.blockedBy,
    });
  }
  return outcome.reason;
}
