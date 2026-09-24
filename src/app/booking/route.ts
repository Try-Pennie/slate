import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createBooking,
  bookingDetailExtras,
  findDuplicateBookingWarning,
  ExistingCallError,
  ExistingCallCheckUnavailableError,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
} from "@/lib/booking/service";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";
import { validateAttendee } from "@/lib/attendee";
import { HONEYPOT_FIELD, honeypotTripped } from "@/lib/booking/honeypot";
import {
  bucketCodeSchema,
  startSchema,
  timezoneSchema,
  salesforceIdSchema,
  prefillSchema,
} from "@/lib/booking/input-schema";
import {
  allowRequest,
  refundRequest,
  bookingWithinLimit,
  clientIp,
  contactRateKeys,
  BOOKING_HOURLY_RATE_RULES,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
} from "@/lib/rate-limit";
// The policy half is pure data with no Cloudflare imports, and is imported from the core
// module rather than through the limiter so a route test that mocks the limiter still sees
// the REAL decision (#1557).
import { BOOKING_LIMITER, type CallerKey } from "@/lib/rate-limit-core";
import { judgePublicBooking } from "@/lib/booking/kill-switch";
import { readPublicBookingPaused } from "@/lib/booking/settings";
import { BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";
import { internalErrorResponse } from "@/lib/api/errors";
import { noStore } from "@/lib/api/no-store";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const schema = z.object({
  // Bounded, shared with the API parser so the size caps can't drift (#1034).
  bucketCode: bucketCodeSchema,
  // The `xbc` exactly as it arrived. Optional, because an older embed still in a
  // cached page will not send it, and a missing one must not refuse the booking.
  // It is used ONLY to record whether the catch-all was applied (#1908), never to
  // decide routing, so a client that lies about it corrupts a metric and nothing
  // else. Bounded so a long value cannot be used to bloat a stored row.
  requestedCode: z.string().max(64).optional(),
  start: startSchema, // ISO instant of the chosen slot
  timezone: timezoneSchema,
  salesforceId: salesforceIdSchema.nullish(),
  // Field-level rules live in validateAttendee (shared with the Booker form),
  // which also enforces the contact length cap.
  attendee: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  prefill: prefillSchema,
});

/**
 * The bucket code off the RAW body, for the one refusal that happens because the
 * body did not parse (#1318). The parsed value does not exist there by definition,
 * and the tally's bucket column coalesces a missing value to "", so an unreadable
 * body is recorded as not bucket scoped rather than not recorded at all.
 */
function rawBucketCode(raw: unknown): string {
  const v = (raw as Record<string, unknown> | null)?.bucketCode;
  return typeof v === "string" ? v.slice(0, 16) : "";
}

/**
 * #2561: one wrapper rather than a header on each of the returns below. Every
 * ending of this handler, the confirmations and the refusals alike, describes one
 * lead's request at one moment, and a return added later carries the directive by
 * construction instead of by somebody remembering (L96).
 */
export async function POST(req: NextRequest) {
  return noStore(await handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ip = clientIp(req.headers);
  // #1557: the address ceilings on this endpoint SERVE a caller they cannot identify rather
  // than counting them into one shared bucket. Refusing one refuses a customer at the last
  // step of the funnel; the per contact cap below needs no address and still bounds abuse.
  const bookingCaller: CallerKey = { kind: "address", ip, policy: BOOKING_LIMITER };
  // Light monitoring (#962): the edge per-minute window has no refund path, so a
  // transient server outage (503) still consumes one of the lead's 3/min (the
  // hourly DB cap is refunded on an outage; see the catch below). A block is
  // normally a spammy visitor, so it is deliberately NOT alerted (that would be
  // noise). But every booking 429 is logged with its scope + IP at a queryable
  // tag/level, so a too-tight limit surfaces: a cluster of edge-minute 429s from
  // many distinct IPs (rather than one flooding host) is the signal to revisit
  // 3/min. The hourly 10/hr cap already bounds sustained abuse, so the per-minute
  // window only shapes bursts.
  const tooMany = (scope: "edge-minute" | "hourly" | "contact") => {
    log.info("booking-rate-limit", { msg: "throttled", scope, ip });
    // refusal: rate_limit_ip_minute
    // refusal: rate_limit_ip_hour
    // refusal: rate_limit_contact_hour
    // Deliberately UNCOUNTED (#1318). Counting a throttle would put bot volume in the
    // denominator the booking failure share is measured against, so a flood would make
    // a real outage look proportionally smaller. The reasoning is in refusal-catalog.ts.
    return NextResponse.json(
      { error: "Too many booking attempts from your network. Please try again in a few minutes." },
      { status: 429 },
    );
  };
  // Per-minute burst window at the edge (#237): in-datacenter, no DB round-trip,
  // so it doesn't add latency to the Confirm tap. Checked first so a flood is
  // shed before we touch Postgres.
  if (!(await bookingWithinLimit(ip))) return tooMany("edge-minute");

  // The kill switch (#2297). Placed HERE on purpose: after the edge burst window, so
  // a flood is still shed in-datacenter without a database read, and BEFORE the
  // hourly and per-contact caps, so a refusal the lead did not cause never spends
  // their budget. A pause that lasted an hour would otherwise leave real leads
  // throttled after it was lifted.
  //
  // It runs before the body is read, so neither refusal can name a bucket. That is
  // recorded as `unidentifiable` rather than as an empty code, because both states
  // this gate refuses in are org-wide: no bucket would explain either one.
  const publicBooking = judgePublicBooking(await readPublicBookingPaused());
  if (!publicBooking.allow) {
    if (publicBooking.refusal === "booking_paused") {
      log.info("booking-paused", { msg: "refused, bookings are paused", ip });
      // refusal: booking_paused
      // Deliberately UNCOUNTED. Somebody turned this on a moment ago and is watching;
      // recording it as an error would page them about their own action, and recording
      // it as an attempt would put a window in which everything is refused by design
      // into the denominator the real failure share is measured against. The count that
      // IS worth having, how many leads met a paused booker, is a total over a known
      // window rather than a rate, and the log line above answers it.
      return NextResponse.json({ error: BOOKING_ERROR_COPY.bookingsPaused }, { status: 503 });
    }
    log.error("booking-paused", { msg: "pause flag unreadable, refusing the booking", ip });
    recordApiOutcome("error", "", "booking_pause_unreadable", {
      by: "unidentifiable",
      why: "the kill switch is judged before the body is read, so no bucket is known",
    });
    // refusal: booking_pause_unreadable
    return NextResponse.json({ error: BOOKING_ERROR_COPY.bookingPauseUnreadable }, { status: 503 });
  }
  // Strict hourly anti-spam cap stays in the DB (a 1-hour window the native
  // binding can't express).
  if (!(await allowRequest(bookingCaller, BOOKING_HOURLY_RATE_RULES))) return tooMany("hourly");

  const raw = await req.json().catch(() => null);

  // Honeypot (#1033): a hidden decoy field a real user never sees or fills, so a
  // value here means a scripted bot filling every field. Reject with the SAME
  // generic 400 a schema failure returns (revealing nothing bot-specific), before
  // touching the booking path. Logged at a queryable tag so trips are observable;
  // a honeypot hit is expected background noise, so it does NOT alert.
  if (raw && typeof raw === "object" && honeypotTripped((raw as Record<string, unknown>)[HONEYPOT_FIELD])) {
    log.info("booking-honeypot", { msg: "tripped", ip });
    // refusal: honeypot
    // Deliberately uncounted (#1318): a real user cannot fill a field they never see,
    // so every trip is a script, and volume here measures bot traffic rather than
    // customers being refused.
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // refusal: invalid_request
    // One malformed request is a stray caller; a WAVE means the embed or an integration
    // is sending a shape Slate rejects, so every lead arriving through it is turned away
    // and nothing said so (#1318). Counted as an error, so the existing failure-rate
    // window (#1313) pages on the share and names the code. The bucket is read off the
    // raw body rather than the parsed one, which is exactly what failed to parse.
    recordApiOutcome("error", rawBucketCode(raw), "invalid_request", { by: "bucket", code: rawBucketCode(raw) });
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const attendeeErrors = validateAttendee(parsed.data.attendee);
  if (Object.keys(attendeeErrors).length > 0) {
    // refusal: invalid_contact
    // One is a typo the lead fixes in the field. A wave is the contact rules and the
    // incoming data disagreeing, which turns every lead from that source away at once,
    // and #1425 made that concrete: a number carrying an extension is now refused, so any
    // upstream source still sending one fails every time (#1318).
    recordApiOutcome("error", parsed.data.bucketCode, "invalid_contact", { by: "bucket", code: parsed.data.bucketCode });
    return NextResponse.json(
      { error: "Please check your contact details.", fieldErrors: attendeeErrors },
      { status: 400 },
    );
  }

  // Per-contact hourly cap (#1033), keyed on the attendee identity rather than the
  // IP: a distributed bot spreading fake bookings across many IPs is bounded by
  // the fake identity it reuses. Checked AFTER attendee validation (so email/phone
  // are present and valid) and after the per-IP caps. Refunded on a verify outage
  // below, exactly like the IP hourly cap, so a server fault never burns a real
  // lead's contact budget.
  const contactKeys = contactRateKeys({
    email: parsed.data.attendee.email,
    phone: parsed.data.attendee.phone,
  });
  for (const key of contactKeys) {
    if (!(await allowRequest({ kind: "opaque", key }, BOOKING_CONTACT_HOURLY_RATE_RULES)))
      return tooMany("contact");
  }

  // Give back the IP cap AND the per-contact caps for a failure that ISN'T the
  // lead's doing, so a server outage or a lost slot race can't consume their
  // booking budget. The edge per-minute window has no refund path, but it's a
  // short burst that clears within a minute.
  const refundAll = async () => {
    await refundRequest(bookingCaller, BOOKING_HOURLY_RATE_RULES);
    for (const key of contactKeys) {
      await refundRequest({ kind: "opaque", key }, BOOKING_CONTACT_HOURLY_RATE_RULES);
    }
  };

  // #2660: whether this confirm is a TEST booking, decided by the one constant
  // that establishes the mode (L319). It is what lets the service book the public
  // test bucket, and it is what the response tells the host page. Exact on this
  // route: a hidden test bucket is refused below before anything is created, and
  // a real code can never cascade into a test bucket (the ladder is XBC only), so
  // a booking made here is a test one exactly when the code is the public test
  // code. Never read from the client's body beyond the code itself.
  const isTest = isPublicTestBucket(parsed.data.bucketCode);

  try {
    const { booking, manageUrl } = await createBooking({
      // One call per person, enforced here and only here (#1337): the direct
      // booking API owns its own richer decision and must keep creating on a
      // cross-bucket rebook (#364).
      refuseIfPersonHasCall: true,
      allowTestBuckets: isTest,
      bucketCode: parsed.data.bucketCode,
      requestedCode: parsed.data.requestedCode,
      startIso: parsed.data.start,
      timezone: parsed.data.timezone,
      salesforceId: parsed.data.salesforceId ?? null,
      attendee: {
        name: parsed.data.attendee.name?.trim(),
        email: parsed.data.attendee.email?.trim(),
        phone: parsed.data.attendee.phone?.trim(),
      },
      prefill: parsed.data.prefill,
    });
    // Backstop, not the ordinary path (#1337): a second booking is normally
    // DECLINED above before anything is created. Since #1641 the window it
    // covers is two simultaneous confirms both passing the check, and no longer
    // a failed lookup, which is refused rather than booked. When a duplicate does
    // reach here, the lead is told about it (#626).
    const duplicateWarning = await findDuplicateBookingWarning({
      excludeBookingId: booking.id,
      salesforceId: parsed.data.salesforceId ?? null,
      attendee: {
        email: parsed.data.attendee.email?.trim(),
        phone: parsed.data.attendee.phone?.trim(),
      },
      // The same world the booking was made in (#2660): a tester's confirmation
      // never names a real lead's call, and a real lead's never names a test one.
      isTest,
    });

    recordApiOutcome("created", parsed.data.bucketCode, null, { by: "bucket", code: parsed.data.bucketCode });
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
      duplicateWarning,
      // #2660: the Booker posts this response to the host page, so a host can
      // label its own confirmed page as a test booking. The same field the by id
      // lookup carries, so both routes to the confirmed page say one thing.
      isTest,
      // #2643: the add to calendar links, from the one builder the booking lookup
      // uses. The Booker posts this response to the host page, so the host learns
      // them however it ends the booking. The lead's contact is deliberately left
      // off: this travels as a browser message to a host that already holds it.
      calendarLinks: bookingDetailExtras(booking).calendarLinks,
    });
  } catch (err) {
    // The lead already has an active call, so nothing was created (#1337). Refund
    // the rate-limit hit: being declined is not an attempt they should pay for,
    // and the Move they are about to make is a separate request.
    if (err instanceof ExistingCallError) {
      await refundAll();
      recordApiOutcome("deduped", parsed.data.bucketCode, "existing_call", { by: "bucket", code: parsed.data.bucketCode });
      // refusal: existing_call
      return NextResponse.json({ existingCall: err.existingCall }, { status: 409 });
    }
    // The one-call-per-person check could not be MADE (#1641), so nothing is
    // known about what this lead already holds and nothing was created. Treated
    // like the other transient server faults: a retriable 503 carrying one short
    // sentence (the detail is already in the log), and the rate-limit hit handed
    // back, because a failed read on our side is not an attempt the lead should
    // pay for. Refusing is the deliberate reversal of the old fail-open; see
    // ExistingCallCheckUnavailableError for why the confirmation-screen backstop
    // could never cover this case.
    if (err instanceof ExistingCallCheckUnavailableError) {
      await refundAll();
      recordApiOutcome("error", parsed.data.bucketCode, "existing_call_unavailable", { by: "bucket", code: parsed.data.bucketCode });
      // refusal: existing_call_unavailable
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // Couldn't verify any candidate (likely a Google/DB outage), not a full
    // slot — tell the lead it's temporary and let them retry (#319). Refund the
    // rate-limit hit: a server-side outage must not burn their booking budget.
    if (err instanceof VerifyUnavailableError) {
      // Couldn't verify any candidate (a Google/DB outage), not the lead's fault.
      await refundAll();
      recordApiOutcome("error", parsed.data.bucketCode, "verify_unavailable", { by: "bucket", code: parsed.data.bucketCode });
      // refusal: verify_unavailable
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A genuinely-full slot: someone else took it a moment earlier. Not the lead's
    // fault, and a retry against another slot may well succeed, so hand the budget
    // back (#1089) before surfacing "no times" (409).
    if (err instanceof SlotUnavailableError) {
      await refundAll();
      // The headline case (#1313 / #1315): a customer refused at confirm on a slot
      // WE ADVERTISED. One lost race is ordinary contention, which is why this
      // does not page on its own; fifty in two hours is the cal.com failure of
      // 2026-08-06, and it is indistinguishable from the one without a count.
      recordApiOutcome("error", parsed.data.bucketCode, "slot_unavailable", { by: "bucket", code: parsed.data.bucketCode });
      // refusal: slot_unavailable
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // An empty/misconfigured pool ALSO surfaces as "no times" (409) to the consumer
    // (the API route #358 distinguishes them), but it is a config problem, not a
    // slot race: a retry won't help, so we deliberately do NOT refund here.
    if (err instanceof NoEligibleAgentsError) {
      recordApiOutcome("error", parsed.data.bucketCode, "no_eligible_agents", { by: "bucket", code: parsed.data.bucketCode });
      // refusal: no_eligible_agents
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // The code names no bucket, or names a HIDDEN test bucket (#2667). A client
    // refusal, not a fault of ours: the same 422 UNKNOWN_BUCKET the key authed API
    // answers, with the booker's own sentence, and ONE body for both causes so the
    // response can never say a hidden bucket exists (#601). Counted like
    // invalid_request, because a wave of these is an embed sending a code Slate
    // does not serve; not refunded, because a retry cannot help.
    if (err instanceof UnknownBucketError) {
      recordApiOutcome("error", parsed.data.bucketCode, "unknown_bucket", { by: "bucket", code: parsed.data.bucketCode });
      // refusal: unknown_bucket
      return NextResponse.json(
        { error: BOOKING_ERROR_COPY.unknownBucket, code: "UNKNOWN_BUCKET" },
        { status: 422 },
      );
    }
    recordApiOutcome("error", parsed.data.bucketCode, "internal", { by: "bucket", code: parsed.data.bucketCode });
    // refusal: internal
    return internalErrorResponse(err, "booking");
  }
}
