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
import { parseStampMs } from "@/lib/date/stamp";
import { agentLinkAvailabilityLive } from "@/lib/agent-link/service";
import { bookingRescheduleTimesLive } from "@/lib/booking/reschedule-times-live";
import { wakeConfirmLineForCode } from "@/lib/booking/confirm-line-live";
import { createServerTimer, SERVER_TIMING_NAMES } from "@/lib/api/server-timing";
import { makeFreshnessReader } from "@/lib/api/isolate-runs";
import { coloFromRay } from "@/lib/http/cf-ray";
import { PROGRAM_LEAD_HEADER, PROGRAM_LEAD_ZONE_PARAM } from "@/lib/booking/program-lead-header";
import { programLeadTimesLive } from "@/lib/booking/program-lead-times-live";

export const dynamic = "force-dynamic";

// #3713: this module's own count of the requests it has handled in this isolate, beside the
// Worker's count of the isolate's runs. Module scope on purpose: see isolate-runs.ts.
const isolateFreshness = makeFreshnessReader();

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
  // #3653: the Worker's own clock for this request, reported on the pooled read as a
  // Server-Timing so the latency canary can tell time spent here from time in transit
  // (#3652). It measures I/O waits, not CPU after the last I/O: see server-timing.ts.
  const timer = createServerTimer();
  // #3713: counted before any branch can return, so a request this module answered with
  // a 429, a 404 or an advisor's times still counts toward how warm the module is.
  const fresh = isolateFreshness(Date.now());

  // Edge-throttle (#56) — in-datacenter, no DB round-trip, so the cached hot
  // path stays fast. Fails open.
  if (!(await timer.span(SERVER_TIMING_NAMES.limiter, () => availabilityWithinLimit(clientIp(req.headers))))) {
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
  // credential-throttle-ok: a failed key here refuses nothing, it only leaves the test
  // buckets hidden, and the availability ceiling above already counts every request (#3142).
  let authorizedForTest = authenticateBearer(req.headers.get("authorization"), keys).ok;
  if (!authorizedForTest && isPublicTestBucket(code)) {
    const refused = refuseUnlessTestPass(req.headers, code, "availability");
    if (refused) return NextResponse.json(refused.body, { status: refused.status });
    authorizedForTest = true;
  }

  // #3713: the same timer goes in, so the slot read's parts (edge cache, business
  // hours, stored row, live compute, tier fallback) land on this request's header.
  const result = await timer.span(SERVER_TIMING_NAMES.slots, () =>
    getBucketSlotsWithFallback(code, from, authorizedForTest, now, timer),
  );
  if (!result) {
    // Unknown code and an unauthorized hidden test bucket both land here with
    // the identical response.
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }

  // #3775: wake the line this lead's confirm will join, after the response, so an
  // object idle for minutes is back by the time they pick a time.
  wakeConfirmLineForCode(code);

  // #2220: every served time lies inside the window asked about. `from` used to
  // reach only the cache read, which answers with the stored horizon wherever it is
  // asked, so a week past it came back with this week's times under a 200. An
  // unreadable bound filters nothing (the #3366 line logs it as unreadable): an
  // unreadable `to` used to compare every time against NaN, drop them all, and
  // explain the empty list as a full calendar.
  const realOffered = filterSlotsFromNow(result.slots, now, result.eventType.min_notice_min);
  const realSlots = slotsInWindow(realOffered, params.get("from"), toParam);

  // #4390: a program lead (the texted link's token, in a header so the address Cloudflare
  // logs never carries it) is shown the placeholder's starts beside the real ones, under
  // the placeholder day limit. Every failure inside is real slots only, counted. An
  // ordinary lead never reaches it, so their read is unchanged.
  const programToken = req.headers.get(PROGRAM_LEAD_HEADER);
  const program = programToken
    ? await programLeadTimesLive({
        token: programToken,
        leadZone: params.get(PROGRAM_LEAD_ZONE_PARAM),
        realSlots: realOffered,
        eventType: result.eventType,
      })
    : null;
  const slots = program ? slotsInWindow(program.slots, params.get("from"), toParam) : realSlots;

  // Observability headers (#257/#234): freshness of the served slots and which
  // tier of the read path answered (L1 cache hit / L2 precomputed row / cold live
  // compute). Diagnostic only, never routing internals (#259). A stuck refresher
  // shows as an old x-slots-computed-at; a persistent x-slot-cache=nostore means
  // rows aren't being precomputed.
  const headers: Record<string, string> = {
    "x-slot-cache": { hit: "hit", row: "miss", compute: "nostore" }[result.source],
  };
  if (result.computedAt) headers["x-slots-computed-at"] = result.computedAt;

  // #3366: the same facts in the log, with the UTC day the caller's `from` anchors
  // to and the colo, because on 2026-10-06 leads were re-offered times full for
  // hours and nothing recorded which layer served them. The next occurrence names
  // its layer: a `hit` whose stamp is old is the edge cache, a `miss` whose stamp
  // is fresh is the stored row. Bucket codes and stamps only, nothing about the lead.
  log.info("availability", {
    msg: "slots served",
    bucket: code,
    effective_code: result.routing.effective_code,
    slot_cache: headers["x-slot-cache"],
    computed_at: result.computedAt,
    from_anchor: utcDayOf(from),
    // #2220: a `to` that cannot be read filters nothing, so it is recorded here, the
    // one place a caller's bad bound can be seen later.
    ...(toParam !== null && parseStampMs(toParam) === null ? { to_anchor: "unreadable" } : {}),
    colo: requestColo(req),
    slots: slots.length,
    // #4390: how a program lead's read went, never the token.
    ...(program ? { program_times: program.outcome } : {}),
    // #3381: which path wrote what was served, and the newest booking splice since its
    // compute. Null is not recorded (an entry from before it was), never a writer.
    written_by: result.writtenBy ?? null,
    spliced: result.spliced ?? null,
    // #3653: the Worker's own time up to this line (the limiter and the slot read),
    // so the Worker logs can answer #3652 as well as the canary. An empty result's
    // explanation and an alert send come after it and are in the header's total only.
    worker_ms: timer.totalMs(),
    // #3713: each span by its Server-Timing name (`limit_ms`, `slots_ms`, then the slot
    // read's parts `cache_ms`, `hours_ms`, `row_ms`, `compute_ms`, `fallback_ms`). A part
    // that did not run is absent, never 0. On the Worker's clock a span is I/O waits
    // plus the CPU since the previous I/O, and CPU after a span's last I/O is in none of
    // them, so worker_ms minus the spans is not a measured CPU figure: Cloudflare's own
    // invocation CPU time is the number for that.
    ...spanFields(timer),
    // #3713: whether the isolate was fresh. No key outside the Worker, never a guess.
    ...(fresh.isolateRuns === null ? {} : { isolate_runs: fresh.isolateRuns }),
    ...(fresh.isolateAgeMs === null ? {} : { isolate_age_ms: fresh.isolateAgeMs }),
    route_requests: fresh.routeRequests,
  });

  // #1328: with nothing to offer, the booker needs to know WHY. "All times are
  // taken right now" is untrue in both halves when the reason is a closure, and a
  // lead reads it as a busy week and comes back tomorrow to the same screen.
  // Computed only when the result is actually empty, so the ordinary hot path pays
  // nothing extra, and best-effort: if the reason cannot be worked out the client
  // falls back to the vaguer copy rather than the request failing.
  //
  // #4390: asked of the REAL slots, so a program lead's extra times never hide an
  // unstaffed pool from the notice below; the lead is told why only when nothing at all
  // is on their screen.
  const realEmptyBecause: AvailabilityEmptyReason | null =
    realSlots.length === 0
      ? (beyondOffered(realOffered, params.get("from")) ?? (await whyEmpty(now, result.bucket)))
      : null;
  const emptyBecause = slots.length === 0 ? realEmptyBecause : null;

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
  if (realEmptyBecause?.kind === "unstaffed" && !result.bucket.is_test) {
    // alert-key: booker_unstaffed:*
    await sendThrottledAlert(
      `booker_unstaffed:${result.bucket.code}`,
      BOOKER_UNSTAFFED_COOLDOWN_MS,
      bookerUnstaffedAlert(result.bucket.code),
    ).catch(logAlertSendFailure(`booker_unstaffed:${result.bucket.code}`));
  }

  // #2841: every tier this lead's cascade may use was full for the whole window of
  // offered open days, so times past it were served. The lead can still book, so
  // the response is unchanged; somebody should look. Keyed to the code the lead
  // ASKED for, which is what the landing page sent, and throttled per code, because
  // this is the hot path. A failed send never costs the lead their times.
  //
  // #3922: the alert names the offered open days the request used. An extended
  // window was by construction a MEASURED one, so `offered_open_days` is set
  // whenever `window_extended` is; the second test narrows the type, it filters
  // nothing.
  const extendedPast = result.routing.window_extended ? result.routing.offered_open_days : null;
  if (extendedPast !== null && !result.bucket.is_test) {
    // alert-key: booking_window_extended:*
    await sendThrottledAlert(
      `booking_window_extended:${result.routing.requested_code}`,
      BOOKING_WINDOW_EXTENDED_COOLDOWN_MS,
      bookingWindowExtendedAlert(result.routing.requested_code, extendedPast),
    ).catch(logAlertSendFailure(`booking_window_extended:${result.routing.requested_code}`));
  }

  // #4390: on a program lead's read, the served starts only the placeholder offers, so the
  // confirm (#4391) can tell them from the real slots. Never rendered. Undefined for every
  // other lead, which JSON leaves out, so their body is unchanged.
  const placeholderStarts = program ? program.placeholderStarts.filter((s) => slots.includes(s)) : undefined;

  // Rule #259: leads must never see routing internals. Tier-drop is intentionally
  // invisible: we report the REQUESTED bucket code (what the lead asked for) and
  // serve the EFFECTIVE tier's slots, and the `routing` meta stays server-side.
  // The one routing fact the payload carries is `shownTier` (#3495), which the
  // booker hands back with its confirm so the confirm records it instead of reading
  // the cache for it, and never renders. Dan, 2026-10-07: "I don't want the lead to
  // see it. I don't care if it's in the background in a spot they'll never see".
  // #3797: `slotsComputedAt` is the same stamp as x-slots-computed-at, handed back with
  // the confirm so a refused time can be judged a lost race. A freshness fact, not
  // routing (#259), and never rendered.
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
      shownTier: result.routing.booked_tier,
      slotsComputedAt: result.computedAt ?? null,
      placeholderStarts,
    },
    // Server-Timing is added LAST, so its total covers everything above. Only this
    // 200 carries it: the 404 an unknown and a hidden bucket share stays identical
    // (#601). Diagnostic timing, never routing internals (#259).
    { headers: { ...headers, "server-timing": timer.header() } },
  );
}

/**
 * Every span the timer recorded, as `<name>_ms`, derived from the names so a part added
 * to the read is logged without a second list to keep in step (L41). The total is
 * logged on its own as `worker_ms`, as it was before #3713. A span that never ran gets
 * no key at all, so it cannot be read as a measured 0.
 */
function spanFields(timer: ReturnType<typeof createServerTimer>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.values(SERVER_TIMING_NAMES)) {
    if (name === SERVER_TIMING_NAMES.total) continue;
    const ms = timer.spanMs(name);
    if (ms !== null) out[`${name}_ms`] = ms;
  }
  return out;
}

/**
 * Why this route's answer is empty: the shared reasons (#1328), plus one only this
 * route can give (#2220). `beyond_horizon` is a window that starts after the last
 * time offered, so nothing in it is offered at all, which is neither a closure nor
 * a full calendar. It stays off the shared `EmptyReason`: the booker always asks
 * from today, so it can never receive it, and a lead facing sentence for it would
 * be copy nobody reads.
 */
type AvailabilityEmptyReason = EmptyReason | { kind: "beyond_horizon"; lastOfferedAt: string };

/** `offered` narrowed to the asked window; an unreadable bound narrows nothing. */
function slotsInWindow(offered: string[], fromParam: string | null, toParam: string | null): string[] {
  const fromMs = fromParam === null ? null : parseStampMs(fromParam);
  const toMs = toParam === null ? null : parseStampMs(toParam);
  return offered.filter((s) => {
    const ms = parseStampMs(s);
    // parse-ok: a stored slot that cannot be read is served as it always was; the
    // window decides only what it can measure.
    if (ms === null) return true;
    return (fromMs === null || ms >= fromMs) && (toMs === null || ms <= toMs);
  });
}

/**
 * `beyond_horizon` when every offered time is before the asked `from`, naming the
 * last of them; otherwise null, and the ordinary explanation answers. Nothing
 * offered at all is not "beyond": there is no horizon to be past.
 */
function beyondOffered(offered: string[], fromParam: string | null): AvailabilityEmptyReason | null {
  const fromMs = fromParam === null ? null : parseStampMs(fromParam);
  if (fromMs === null) return null;
  let last: { ms: number; iso: string } | null = null;
  for (const s of offered) {
    const ms = parseStampMs(s);
    if (ms === null) return null;
    if (last === null || ms > last.ms) last = { ms, iso: s };
  }
  return last !== null && last.ms < fromMs ? { kind: "beyond_horizon", lastOfferedAt: last.iso } : null;
}

/** The UTC day a `from` anchors to (YYYY-MM-DD), or "unreadable" (#3366). */
function utcDayOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "unreadable";
}

/**
 * The Cloudflare data centre serving this request (#3366), whose edge cache the
 * read used: the runtime's own `cf.colo` when the request carries it, otherwise the
 * suffix Cloudflare puts on every `cf-ray`. Null when neither says, never a guess.
 */
function requestColo(req: NextRequest): string | null {
  const cf = (req as unknown as { cf?: { colo?: unknown } }).cf;
  if (typeof cf?.colo === "string" && cf.colo) return cf.colo;
  return coloFromRay(req.headers.get("cf-ray"));
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
