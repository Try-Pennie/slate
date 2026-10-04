import { stampSeenIp } from "@/lib/loadtest-echo";
import { NextResponse, type NextRequest } from "next/server";
import { withinBookingCleanupBudget, withinBookingRequest } from "@/lib/booking/confirm-budget";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { authorizeBookingApi } from "@/lib/booking/route-auth";
import { answerTimed, type ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import { parseDirectBookingRequest, parseLookupQuery, parseCancelQuery, parseListQuery, LIST_ONLY_PARAMS } from "@/lib/booking/api-request";
import { respondToDirectCancel, apiErrorBody, mapLookupError } from "@/lib/booking/direct-cancel-http";
import {
  bookViaApi,
  previewBooking,
  pageBookingFailure,
  lookupPersonBookings,
  getPersonBookingById,
  listBookings,
  bookingDetailExtras,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  OutsideCallingWindowError,
  RaceLostRefusalError,
} from "@/lib/booking/service";
import { raceOutcomeForRefusal } from "@/lib/monitor/race-contention";
import { DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES } from "@/lib/rate-limit-core";
import { log } from "@/lib/log";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import type { BookingOriginFacts } from "@/lib/monitor/offsite-origin";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import { mayBookTestBuckets } from "@/lib/booking/api-auth";

export const dynamic = "force-dynamic";

/**
 * Direct booking API (#253/#250, milestone #2). A key-authed endpoint the
 * external AI auto-booker calls to create a fully-routed booking server-side,
 * retiring the headless cal.com/embed scraping it does today.
 *
 * Phase 1 (#355) is the authenticated SKELETON: two-key bearer auth (so the
 * secret rotates with zero downtime), a generous per-key rate ceiling, and
 * per-call key attribution. The request body — schema/validation (#356),
 * person-level dedupe + auto-reschedule (#357), and the machine-readable error
 * contract (#358) — lands in later phases, so a valid call returns 501 for now.
 *
 *   POST (Bearer a caller's own key, BOOKING_API_KEY_<CALLER>[_2]) -> 501 | 401 | 429 | 503
 */
/**
 * #2243: under SLATE_LOADTEST only, every response carries the address the
 * per-address ceiling was keyed on. A load run cannot attribute its own 429s
 * otherwise, because a CI runner behind egress NAT shares an address with
 * everything else on the host. The whole handler is wrapped in one place rather
 * than each of its dozen returns being stamped, so a return added later carries it
 * by construction (L96) and nothing about the production path changes: with the
 * flag unset `stampSeenIp` adds a header to nothing.
 */
export async function POST(req: NextRequest) {
  // #3221: one line per call with how long the caller waited for the answer, kept
  // apart from the work deferred past the response; a dry run says so on it.
  const facts: ConfirmLineFacts = {};
  // #3102: one budget for the whole request; see `confirm-budget.ts`. A deadline
  // from a read before the booking's own try (the key ceilings, the hourly cap) is
  // the same outage the booking path answers with VERIFY_UNAVAILABLE, rather than
  // escaping as an unhandled 500.
  return stampSeenIp(
    await answerTimed(
      "booking-api",
      () =>
        withinBookingRequest(
          () => handlePost(req, facts),
          async (timeout) => {
            await pageBookingFailure(timeout);
            recordApiOutcome("error", "", "VERIFY_UNAVAILABLE", { by: "unidentifiable", why: "a dependency timed out before the request was read" });
            // refusal: api_verify_unavailable
            return NextResponse.json(await apiErrorBody(timeout, "VERIFY_UNAVAILABLE", "book", "Booking failed"), {
              status: 503,
            });
          },
        ),
      { facts },
    ),
    req.headers,
  );
}

async function handlePost(req: NextRequest, facts: ConfirmLineFacts) {
  // Three refusals, decided apart (#1429). The authorizer reports WHICH one it was
  // and records it according to the catalog, so a rotated key and a noisy caller no
  // longer raise the same number:
  //   refusal: api_key_rejected     401, counted as API_KEY_REJECTED
  //   refusal: api_not_configured   503, counted as API_NOT_CONFIGURED
  //   refusal: api_rate_limited     429, deliberately uncounted (it would dilute the share)
  const authd = await authorizeBookingApi(req);
  if (!authd.ok) return authd.response;
  log.info("booking-api", { msg: "authenticated request", key: authd.keyId });

  const parsed = parseDirectBookingRequest(await req.json().catch(() => null));
  if (!parsed.ok) {
    // refusal: api_validation
    // One rejected body is a stray call; a wave means the bot is sending a shape Slate
    // no longer takes, and every lead it is holding is refused until somebody notices
    // (#1318). Counted so the failure-rate window (#1313) sees it.
    recordApiOutcome("error", "", "VALIDATION", {
      by: "unidentifiable",
      why: "the request body did not parse, so no bucket was ever named",
    });
    return NextResponse.json(
      parsed.fieldErrors
        ? { error: parsed.error, code: "VALIDATION", fieldErrors: parsed.fieldErrors }
        : { error: parsed.error, code: "VALIDATION" },
      { status: parsed.status },
    );
  }

  const v = parsed.value;
  // #2752: a server caller has no framing page, and whatever prefill it sends is what
  // the booking row stores, so the tally judges the same facts the off site page would.
  const apiHost: BookingOriginFacts = { prefill: v.prefill, referrer_origin: null };
  // #2669: the test bucket opt in follows the CALLER. The canary's hidden buckets
  // (#396) only for the canary callers, the public one (#2660) for anyone; a partner
  // naming SMOKE meets the same 422 UNKNOWN_BUCKET a typo does (#601).
  const allowTestBuckets = mayBookTestBuckets(authd.caller, v.bucketCode);

  // Dry run (#380): report what WOULD happen, no calendar event / booking / webhook.
  if (v.dryRun) {
    facts.dryRun = true;
    try {
      const preview = await previewBooking({
        bucketCode: v.bucketCode,
        startIso: v.startIso,
        timezone: v.timezone,
        salesforceId: v.salesforceId,
        attendee: v.attendee,
        prefill: v.prefill,
        externalId: v.externalId,
        confirmReschedule: v.confirmReschedule,
        allowTestBuckets,
      });
      return NextResponse.json(preview);
    } catch (err) {
      // #3102: the failure path runs under the cleanup allowance, not the confirm
      // budget, which a timeout has already spent; its outcome and report would
      // otherwise fail at once and the failure would go unrecorded.
      return withinBookingCleanupBudget(async () => {
        // #3102: a dry run that ran out of time hit the same outage a booking
        // would, answered as one by POST rather than as INTERNAL.
        if (isDeadlineExceeded(err)) throw err;
        const { status, code } = mapBookingError(err);
        return NextResponse.json(await apiErrorBody(err, code, "preview", "Preview failed"), { status });
      });
    }
  }

  try {
    const result = await bookViaApi({
      bucketCode: v.bucketCode,
      startIso: v.startIso,
      timezone: v.timezone,
      salesforceId: v.salesforceId,
      attendee: v.attendee,
      prefill: v.prefill,
      externalId: v.externalId,
      confirmReschedule: v.confirmReschedule,
      allowTestBuckets,
      // #2876: from the key that matched, so a call naming no page records who made it.
      apiCaller: authd.caller,
    });

    const body = {
      outcome: result.outcome,
      booking: {
        id: result.booking.id,
        externalId: result.booking.external_id,
        startsAt: result.booking.starts_at,
        endsAt: result.booking.ends_at,
        status: result.booking.status,
        agent: { name: result.booking.agent_name, email: result.booking.agent_email },
        manageUrl: result.manageUrl,
        // #2643: the lead's contact and the add to calendar links, from the same
        // builder the by id lookup uses. Withheld on confirm_required, where the
        // booking named is the one a WEAK match found and may belong to somebody
        // else (#1340): that answer must not hand over another person's phone.
        ...(result.outcome === "confirm_required" ? {} : bookingDetailExtras(result.booking)),
        // #2659: the partner join keys off the booking's OWN prefill (on a
        // deduped or rescheduled outcome that is the booking the lead already
        // held, whose keys are the ones the warehouse joins on), null when the
        // page passed none. Withheld on confirm_required for the same reason
        // as the extras above: an identifier that joins to another person's
        // submission is theirs.
        ...(result.outcome === "confirm_required" ? {} : partnerKeysFrom(result.booking.prefill)),
      },
      // #1515: WHICH TEAM OWNS THE LEAD. The caller is the system of record for
      // that, and until now had to infer it from the agent, which breaks the
      // moment an agent serves more than one bucket and can never show a tier
      // drop at all. Two things move a lead off the bucket that was asked for: a
      // cross bucket rebook (#364, #1465) and routing dropping a rung.
      //
      // `code` is read from the BOOKING's own routing trace, so it describes
      // where the lead actually is on every outcome, including a `deduped` where
      // the booking returned is the one they already held. Null when the trace
      // does not record it (2 of 1,146 production rows, both predating the trace
      // and neither active) rather than echoing the request back, because a
      // requested code presented as the effective one is exactly the misreport
      // this field exists to prevent (L75).
      bucket: {
        code: result.booking.routing_trace?.bucket_code ?? null,
        requestedCode: v.bucketCode,
        // These describe the booking named in the response. A missing flag is a
        // real false, not an unknown: whatever routing placed that booking wrote
        // the trace, and it writes these together.
        tierFallback: result.booking.routing_trace?.tier_fallback ?? false,
        rungsDropped: Math.max(0, result.booking.routing_trace?.rungs_dropped ?? 0),
      },
      // #1465: a same time rebook into a DIFFERENT bucket is a routing request,
      // and it is honoured. When the target bucket had nobody free the lead keeps
      // the appointment they had, in the OLD bucket, and this names that so the
      // caller can tell the bucket it asked for is not the bucket the lead is in.
      // Absent when nothing was declined, so its presence always means something.
      ...(result.bucketChangeDeclined
        ? { bucketChangeDeclined: { requestedBucketCode: v.bucketCode, reason: result.bucketChangeDeclined } }
        : {}),
    };

    // The lead already has an appointment and the match wasn't strong enough to
    // move it silently — 409 so the bot asks the lead, then retries with
    // confirmReschedule:true. Everything else is a success.
    // refusal: api_confirm_required
    // Nobody is refused: the caller is being ASKED, and retries with confirmReschedule.
    const status = result.outcome === "confirm_required" ? 409 : 200;
    log.info("booking-api", {
      msg: "outcome",
      outcome: result.outcome,
      bucket: v.bucketCode,
      key: authd.keyId,
      status,
      ...(result.bucketChangeDeclined
        ? { bucket_change_declined: result.bucketChangeDeclined }
        : {}),
    });
    // L77: a refusal deliberately classified as EXPECTED still needs a VOLUME.
    // One re-tiered lead whose new team happened to be full and a whole bucket
    // refusing every move arrive on the same path and are indistinguishable, so
    // the decline carries its own code into the daily tally rather than counting
    // as an ordinary dedupe. The outcome stays `deduped`, so the outcome mix is
    // unchanged and only the error slice gains a countable row.
    recordApiOutcome(
      result.outcome,
      v.bucketCode,
      result.bucketChangeDeclined ? `bucket_change_declined_${result.bucketChangeDeclined}` : null,
      { by: "bucket", code: v.bucketCode, host: apiHost },
    );
    // #2838, #2861: the race this call's own confirm lost, named by the service on
    // the create arm and on a cross bucket move (rescued or declined). Absent on a
    // replay, a plain dedupe or an in place reschedule, whose booking describes an
    // earlier confirm, so one race is never counted twice.
    if (result.raceOutcome) {
      recordApiOutcome(result.raceOutcome, v.bucketCode, null, { by: "bucket", code: v.bucketCode, host: apiHost });
    }
    return NextResponse.json(body, { status });
  } catch (err) {
    // #3102: the failure path runs under the cleanup allowance, not the confirm
    // budget, which a timeout has already spent; its outcome and report would
    // otherwise fail at once and the failure would go unrecorded.
    return withinBookingCleanupBudget(async () => {
      const { status, code } = mapBookingError(err);
      log.info("booking-api", {
        msg: "outcome",
        outcome: "error",
        bucket: v.bucketCode,
        key: authd.keyId,
        status,
        code,
      });
      recordApiOutcome("error", v.bucketCode, code, { by: "bucket", code: v.bucketCode, host: apiHost });
      // #2838: refused after a lost overlap race, on a row outside the failure share.
      if (err instanceof RaceLostRefusalError) {
        recordApiOutcome(raceOutcomeForRefusal(err), v.bucketCode, null, {
          by: "bucket",
          code: v.bucketCode,
          host: apiHost,
        });
      }
      return NextResponse.json(
        await apiErrorBody(err, code, "book", "Booking failed"),
        { status },
      );
    });
  }
}

/**
 * Lookup (#386) + List (#392). No `externalId` key → list mode (paginated,
 * cross-person); `externalId` present → per-person lookup. Rejects blank
 * externalId and list filters mixed into a lookup request.
 */
export async function GET(req: NextRequest) {
  return stampSeenIp(await handleGet(req), req.headers);
}

async function handleGet(req: NextRequest) {
  // #597: reads deliberately opt OUT of the per-IP ceiling. That ceiling is sized for
  // the write path (60/min), while status polling is cheap and bursty and runs against a
  // ~10x larger per-key budget (#393). Inheriting the write ceiling here would throttle
  // legitimate polling from the integrator's single host. Reads stay bounded by their own
  // per-key ceiling; the threat in #597 is booking FLOODING, which is a write.
  const authd = await authorizeBookingApi(req, DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES, null, true);
  if (!authd.ok) return authd.response;

  const sp = new URL(req.url).searchParams;
  const externalIdKeyPresent = sp.has("externalId");

  // List mode: the externalId KEY is absent entirely.
  if (!externalIdKeyPresent) {
    const parsed = parseListQuery(sp);
    if (!parsed.ok) {
      // refusal: api_query_invalid
      return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
    }
    log.info("booking-api", { msg: "lookup", key: authd.keyId, mode: "list" });
    // #1675: an unreadable page is refused, never answered as an empty one. The
    // caller pages this endpoint, so `bookings: []` with a null cursor is the
    // answer "that is everything" and it moves its watermark past bookings
    // nobody read. A 503 is the one answer that makes it come back.
    let listed;
    try {
      listed = await listBookings(parsed.value);
    } catch (err) {
      // #1709: counted under its own name, outside OUTCOME_ORDER, so a sustained
      // run of these pages without read traffic entering the denominator the
      // booking failure share is measured against. One is a blip the caller's
      // retry clears; a run is the bookings table unreadable, which nothing else
      // sees until the automated booker goes live and the write path fails beside
      // it.
      recordApiOutcome("refused_list_read", "", null, {
        by: "unidentifiable",
        why: "the bookings page could not be read, so no booking is identified",
      });
      log.error("booking-api", { msg: "list read failed", key: authd.keyId }, err);
      // refusal: api_list_unavailable
      return NextResponse.json(
        {
          error: "The bookings list could not be read just now. Please retry.",
          code: "LIST_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({
      bookings: listed.items,
      nextCursor: listed.nextCursor,
    });
  }

  // Lookup mode: externalId present. Reject blank, and reject list filters mixed in.
  if ((sp.get("externalId") ?? "").trim() === "") {
    // refusal: api_query_invalid
    return NextResponse.json({ error: "externalId is required", code: "VALIDATION" }, { status: 400 });
  }
  if (LIST_ONLY_PARAMS.some((k) => sp.has(k))) {
    // refusal: api_query_invalid
    return NextResponse.json(
      { error: "externalId selects per-person lookup; remove list filters or omit externalId", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const parsed = parseLookupQuery(sp);
  if (!parsed.ok) {
    // refusal: api_query_invalid
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { externalId, salesforceId, bookingId, status } = parsed.value;
  // #2645: a successful read names its caller, so the first call from a newly
  // keyed partner shows which key it presented. Refusals are logged by the
  // authorizer; this is the success half.
  log.info("booking-api", { msg: "lookup", key: authd.keyId, mode: bookingId ? "by_id" : "person" });
  try {
    if (bookingId) {
      const booking = await getPersonBookingById({ bookingId, identity: { externalId, salesforceId }, status });
      return NextResponse.json({ booking });
    }
    const list = await lookupPersonBookings({ externalId, salesforceId });
    return NextResponse.json({ bookings: list });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    return NextResponse.json(await apiErrorBody(err, code, "lookup", "Lookup failed"), {
      status: httpStatus,
    });
  }
}

/**
 * Cancel one booking by id (#386). Requires `bookingId` + a strong id; cancels
 * only if the booking is owned and active, else 404 NOT_FOUND.
 */
export async function DELETE(req: NextRequest) {
  // One handler with POST /api/bookings/cancel (#2591), which exists because a Regal
  // journey cannot send DELETE. Only where the fields are read from differs.
  return respondToDirectCancel(req, (allowedCancel) =>
    parseCancelQuery(req.nextUrl.searchParams, allowedCancel),
  );
}

/**
 * Stable, machine-readable error contract (#358) so the bot can act on the
 * outcome without parsing prose: a config error (UNKNOWN_BUCKET /
 * NO_ELIGIBLE_AGENTS) means stop retrying and escalate; SLOT_TAKEN means pick
 * another slot; VERIFY_UNAVAILABLE is transient (retry); INTERNAL is unexpected.
 * OUTSIDE_CALLING_WINDOW (#2310) means the start is before 08:00 or at or after
 * 20:00 in the request's `timezone`: retrying the same time can never succeed,
 * another time can.
 */
function mapBookingError(err: unknown): {
  status: number;
  code:
    | "UNKNOWN_BUCKET"
    | "NO_ELIGIBLE_AGENTS"
    | "SLOT_TAKEN"
    | "VERIFY_UNAVAILABLE"
    | "OUTSIDE_CALLING_WINDOW"
    | "INTERNAL";
} {
  // Each branch names its decision (#1318). The caller records every one of these as an
  // error outcome under the same code, so the failure-rate window sees all five.
  // refusal: api_unknown_bucket
  if (err instanceof UnknownBucketError) return { status: 422, code: "UNKNOWN_BUCKET" };
  // refusal: api_no_eligible_agents
  if (err instanceof NoEligibleAgentsError) return { status: 409, code: "NO_ELIGIBLE_AGENTS" };
  // refusal: api_slot_taken
  if (err instanceof SlotUnavailableError) return { status: 409, code: "SLOT_TAKEN" };
  // refusal: api_verify_unavailable
  if (err instanceof VerifyUnavailableError) return { status: 503, code: "VERIFY_UNAVAILABLE" };
  // refusal: api_outside_calling_window
  if (err instanceof OutsideCallingWindowError) return { status: 422, code: "OUTSIDE_CALLING_WINDOW" };
  // refusal: api_internal
  return { status: 500, code: "INTERNAL" };
}
