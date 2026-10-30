import { NextResponse, type NextRequest } from "next/server";
import { withinBookingCleanupBudget, withinBookingRequest } from "@/lib/booking/confirm-budget";
import { answerTimed, noteRefusal, type ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import { ROUTE_CHECK_STAGES, timeStage } from "@/lib/booking/confirm-profile";
import { provenOfferRace, refusedLeadId } from "@/lib/booking/refusal-trace";
import { OFFER_RACE_OUTCOME } from "@/lib/booking/offer-race";
import { answerAfterRefusalRefresh } from "@/lib/booking/refusal-stored-offer-live";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { z } from "zod";
import {
  createBooking,
  pageBookingFailure,
  bookingDetailExtras,
  findDuplicateBookingWarning,
  ExistingCallError,
  ExistingCallCheckUnavailableError,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  OutsideCallingWindowError,
  AttendeeEmailRefusedError,
  RaceLostRefusalError,
  LostRaceOutOfTimeError,
} from "@/lib/booking/service";
import { RACE_RETRY_BUDGET_OUTCOME, raceOutcomeForConfirm, raceOutcomeForRefusal } from "@/lib/monitor/race-contention";
import { FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME } from "@/lib/monitor/follow-up-drain-rate";
import { LeadCodeUnavailableError } from "@/lib/routing/lead-code";
import { resolveRequestedCode } from "@/lib/routing/catchall";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";
import { refuseUnlessTestPass } from "@/lib/embed/test-pass-gate";
import { validateAttendee } from "@/lib/attendee";
import { INPUT_LIMITS } from "@/lib/booking/input-limits";
import { HONEYPOT_FIELD, honeypotTripped } from "@/lib/booking/honeypot";
import {
  bucketCodeSchema,
  startSchema,
  timezoneSchema,
  salesforceIdSchema,
  prefillSchema,
  shownTierSchema,
  slotsComputedAtSchema,
} from "@/lib/booking/input-schema";
import {
  allowRequest,
  refundRequest,
  bookingWithinLimit,
  bookingRetryCredit,
  grantBookingRetryCredit,
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
import { AGENT_LINK_COPY, BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";
import { resolveAgentLink } from "@/lib/agent-link/store";
import { AGENT_LINK_UNAVAILABLE_CODE } from "@/lib/agent-link/refusal-sentence";
import { internalErrorResponse } from "@/lib/api/errors";
import { noStore } from "@/lib/api/no-store";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { EMBED_REFUSAL_OUTCOME } from "@/lib/monitor/booking-api-outcome";
import { log } from "@/lib/log";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import { bookingIdentityFrom } from "@/lib/booking/booking-identity";
import { REFERRER_ORIGIN_MAX_CHARS, readReferrerOrigin } from "@/lib/embed/referrer-origin";
import type { BookingOriginFacts } from "@/lib/monitor/offsite-origin";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";
import { startConfirmPrelude } from "@/lib/booking/confirm-line-live";
import type { CreateBookingInput } from "@/lib/booking/orchestration";
import { verifyProgramLeadToken } from "@/lib/booking/program-lead-gate";
import { bookProgramLeadLive } from "@/lib/booking/program-lead-booking-service";
import { PLACEHOLDER_DAY_FULL_CODE, PlaceholderDayFullError } from "@/lib/booking/program-lead-booking";
import { PROGRAM_PLACEHOLDER_OUTCOME } from "@/lib/monitor/booking-api-outcome";
import { namesAdvisorToLead } from "@/lib/booking/advisor-name";

export const dynamic = "force-dynamic";

const schema = z.object({
  // Bounded, shared with the API parser so the size caps can't drift (#1034).
  // Optional since #2073: a confirm through an agent's own link names the link
  // instead, and exactly one of the two must be present (the refine below).
  bucketCode: bucketCodeSchema.optional(),
  // #2073, #3026: an agent's own booking link, their readable name or an old 64
  // hex token. Bounded so a long value cannot reach the read; its SHAPE is judged
  // by resolveAgentLink, the one place that tells a name from a token.
  agentLink: z.string().min(1).max(128).optional(),
  // The same, under the field a booker loaded before #3026 still sends. Accepted
  // so a lead with that page open can still confirm; never sent by the booker now.
  agentLinkToken: z.string().min(1).max(128).optional(),
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
    // #2549: the first name the lead answered in its own field, stored beside the
    // joined `name` rather than split back out of it. Only the booker sends it.
    // Bounded like a contact field; whether it is stored is decided by
    // `storedFirstName`, which keeps only a value `name` begins with.
    firstName: z.string().max(INPUT_LIMITS.contact).optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  prefill: prefillSchema,
  // #2728: the origin of the page that framed the booker. Untrusted and reduced
  // again by createBooking. Bounded like its siblings, at REFERRER_ORIGIN_MAX_CHARS
  // (2048, the database constraint's own ceiling): a real origin is a few dozen
  // characters, and 2048 is the long standing practical URL limit, so nothing a
  // browser sends can reach it. A value that is too long, or not a string, is
  // DROPPED here rather than refusing the booking, because a lead must never lose a
  // call over a field only a monitor reads.
  referrerOrigin: z.string().max(REFERRER_ORIGIN_MAX_CHARS).optional().catch(undefined),
  // #3495: the tier whose times the booker had on show, handed back from its
  // availability answer so the confirm records it instead of reading the cache for
  // it. A measure only, so a value that is not a tier name is dropped, never a refusal.
  shownTier: shownTierSchema,
  // #3797: the computed_at of the list the lead picked from, so a refused time can be
  // judged a lost race. A measure only, dropped rather than refused when malformed.
  slotsComputedAt: slotsComputedAtSchema,
  // #4391: the program lead token the texted link's page minted (`programLeadTokenForLanding`).
  // Judged only by `verifyProgramLeadToken` against the Lead this confirm names; a value
  // that is too long or not a string is DROPPED, and the confirm is an ordinary one.
  programLeadToken: z.string().max(256).optional().catch(undefined),
}).refine(
  (d) =>
    [d.bucketCode, d.agentLink, d.agentLinkToken].filter((v) => v !== undefined).length === 1,
  { message: "Name a bucket or an agent link, exactly once" },
);

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
 * The host page facts this request carries (#2752), in the shape the booking row
 * stores them: the declared `parentOrigin` out of `prefill`, and the framing page
 * reduced by `readReferrerOrigin` exactly as `createBooking` reduces it. Read off the
 * RAW body so the one refusal that happens because the body did not parse is judged
 * too. The tally then classifies these through `bookingHostClass`, the predicate the
 * off site page and the below tier exclusion use, so a test attempt from a page that
 * is not the production site is recorded as one and kept out of the failure rate.
 */
function confirmHost(raw: unknown): BookingOriginFacts {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const prefill = body.prefill && typeof body.prefill === "object" ? (body.prefill as Record<string, unknown>) : null;
  const parentOrigin = prefill?.parentOrigin;
  return {
    prefill: typeof parentOrigin === "string" ? { parentOrigin } : null,
    referrer_origin: readReferrerOrigin(body.referrerOrigin),
  };
}

/**
 * #2561: one wrapper rather than a header on each of the returns below. Every
 * ending of this handler, the confirmations and the refusals alike, describes one
 * lead's request at one moment, and a return added later carries the directive by
 * construction instead of by somebody remembering (L96).
 */
/**
 * What a request has spent and learned so far (#3102), written by the handler as
 * it goes, so a deadline that escapes it is answered from what is actually true
 * at that moment: the caps it really spent are handed back, the attempt is counted
 * against the bucket once one is known, and an advisor link confirm stays out of
 * the routed tally exactly as it does on every other path.
 */
interface ConfirmProgress {
  /** Every rate limit hit this request took, in order, for the refund. */
  spent: { caller: CallerKey; rules: typeof BOOKING_HOURLY_RATE_RULES }[];
  /** Where the attempt is counted, once the body has named a bucket. */
  source: { by: "bucket"; code: string; host: ReturnType<typeof confirmHost> } | null;
  /** #3272: what the confirm line says about this request, a refusal's stage included. */
  facts: ConfirmLineFacts;
  /** An advisor's own link, which is not a routed booking (#2073). */
  agentLink: boolean;
}

/** Hand back every cap a request spent, under the cleanup allowance, because a
 *  failure that is ours must not spend the lead's budget (#1033). */
function refundSpent(progress: ConfirmProgress): Promise<void> {
  return withinBookingCleanupBudget(async () => {
    for (const { caller, rules } of progress.spent) await refundRequest(caller, rules);
  });
}

export async function POST(req: NextRequest) {
  // #3102: the whole request under one budget, so its Supabase and Google calls
  // share one expiry and cannot add up past the booker's 20 second abort. A
  // deadline from a read made before the booking's own try (the limits, the paused
  // flag, an advisor link) is the same outage, answered the same way, rather than
  // escaping as an unhandled 500.
  const progress: ConfirmProgress = { spent: [], source: null, agentLink: false, facts: {} };
  // #3221: one line per confirm with how long the lead waited for the answer,
  // kept apart from the work deferred past the response.
  return noStore(
    await answerTimed("booking", () =>
      withinBookingRequest(
        () => handlePost(req, progress),
        async (timeout) => {
          // #3300: the line says it timed out, and carries the profile and the lead.
          noteRefusal(progress.facts, timeout);
          return timeStage(progress.facts.profile, "failure-path", async () => {
            await refundSpent(progress);
            await pageBookingFailure(timeout);
            if (!progress.agentLink) {
              recordApiOutcome(
                "error",
                progress.source?.code ?? "",
                "verify_unavailable",
                progress.source ?? { by: "unidentifiable", why: "a dependency timed out before the body named a bucket" },
              );
            }
            // refusal: verify_unavailable
            return NextResponse.json({ error: timeout.message }, { status: 503 });
          });
        },
        // #3300: every Supabase and Google call this request makes, for its profile.
        // Read when the request starts, after `answerTimed` has opened the profile.
        progress.facts.profile?.observeCalls(),
      ),
      { facts: progress.facts, kind: "new" },
    ),
  );
}

async function handlePost(req: NextRequest, progress: ConfirmProgress) {
  // #3300: everything the route does before the service, as one stage: the rate
  // limits, the pause flag, reading the body, an advisor link. Ended where the
  // booking starts; a refusal on the way is charged up to its answer.
  const endChecks = progress.facts.profile?.begin("route-checks");
  // #3493: and each check inside it as its own stage, so a slow stretch says which
  // check it was. `timeStage` charges a check that throws too.
  //
  // They still run ONE AFTER ANOTHER, deliberately, because each order below is a
  // decision and running two at once would undo one of them: the edge limit before
  // any database read (a flood must not buy reads, L498); the pause flag before the
  // hourly cap (a refusal the lead did not cause never spends their budget); the
  // hourly cap before the body read, and each contact key in turn (a refused key
  // spends no later one); an advisor link only after every cap (probing for links
  // pays what a booking pays). Overlapping any pair would either spend a cap a
  // refusal must not spend, or add a read a refused request must not make. Whether
  // any of that is worth reworking waits on what these stages measure.
  const check = <T>(stage: string, fn: () => Promise<T>) => timeStage(progress.facts.profile, stage, fn);
  const ip = clientIp(req.headers);
  // #1557: the address ceilings on this endpoint SERVE a caller they cannot identify rather
  // than counting them into one shared bucket. Refusing one refuses a customer at the last
  // step of the funnel; the per contact cap below needs no address and still bounds abuse.
  const bookingCaller: CallerKey = { kind: "address", ip, policy: BOOKING_LIMITER };
  // Light monitoring (#962): the edge per-minute window is Cloudflare's native
  // limiter and has no refund path, so a transient server outage (503) still
  // consumes one of the lead's 3/min (the hourly DB cap is refunded on an outage;
  // see the catch below). A taken time is the exception, through the retry credit
  // below (#3364). One block is normally a spammy visitor, so a single trip never
  // alerts. The per-minute window records nothing and only shapes bursts; every
  // booking 429 is logged with its scope + IP at a queryable tag/level, so a cluster
  // of edge-minute 429s from many distinct IPs is the signal to revisit 3/min. The
  // hourly address and contact caps are recorded (#1727) and page only when several
  // distinct addresses or contacts are locked out at once (`booking_embed_ip_cap`,
  // `booking_embed_contact_cap`), which means the ceiling is turning real leads away.
  const tooMany = (
    scope: "edge-minute" | "hourly" | "contact",
    retry?: string,
    // #1727: where a contact cap trip is recorded. Only that cap knows the bucket;
    // the hourly address cap is judged before the body is read.
    contactSource?: { code: string; host: ReturnType<typeof confirmHost> },
  ) => {
    log.info("booking-rate-limit", { msg: "throttled", scope, ip, ...(retry ? { retry } : {}) });
    // #1727: the two hourly caps are recorded under names OUTSIDE OUTCOME_ORDER, so
    // they never enter the failure share's denominator, and a sustained run is judged
    // on its own by `api-refusal-signals.ts`. The edge minute window stays unrecorded:
    // it sheds a flood before Postgres is touched, and a write per shed request would
    // hand a flood the database writes that window exists to spare.
    if (scope === "hourly") {
      recordApiOutcome(EMBED_REFUSAL_OUTCOME.ipHour, "", null, {
        by: "unidentifiable",
        why: "refused at the hourly address cap, before the body named a bucket",
      });
    } else if (scope === "contact" && contactSource) {
      recordApiOutcome(EMBED_REFUSAL_OUTCOME.contactHour, contactSource.code, null, {
        by: "bucket",
        code: contactSource.code,
        host: contactSource.host,
      });
    }
    // #3364: the minute window clears inside a minute, and it is what a lead refused for
    // taken times meets when they pick again, so it says so rather than sending them away
    // for "a few minutes". The longer caps keep the longer wait.
    const error =
      scope === "edge-minute" ? BOOKING_ERROR_COPY.tooManyTriesJustNow : BOOKING_ERROR_COPY.tooManyTries;
    // refusal: rate_limit_ip_minute
    // refusal: rate_limit_ip_hour
    // refusal: rate_limit_contact_hour
    // Kept OUT of the failure share (#1318). Counting a throttle there would put bot
    // volume in the denominator the booking failure share is measured against, so a
    // flood would make a real outage look proportionally smaller. The two hourly caps
    // are recorded on their own counter above instead (#1727); the reasoning for each
    // is in refusal-catalog.ts.
    return NextResponse.json({ error }, { status: 429 });
  };
  // Per-minute burst window at the edge (#237): in-datacenter, no DB round-trip,
  // so it doesn't add latency to the Confirm tap. Checked first so a flood is
  // shed before we touch Postgres.
  //
  // #3364: a lead refused for a taken time earns one retry past it, at most three a
  // minute per address. The credit is only consulted once the native window has
  // refused, and gates itself per isolate before reading anything, so a flood still
  // costs no more than a handful of reads; the bound and why refusals cannot be used
  // to get around the limit are on `@/lib/rate-limit-retry-credit`.
  const edge = await check(ROUTE_CHECK_STAGES.edgeLimit, async () =>
    (await bookingWithinLimit(ip)) ? null : await bookingRetryCredit(ip),
  );
  if (edge !== null) {
    if (edge !== "allowed") return tooMany("edge-minute", edge);
    log.info("booking-rate-limit", { msg: "retry after a taken time", scope: "edge-minute", ip });
  }

  // #3460, #3355 item 1: the booker carries no key, so the confirm's early reads (the
  // shared line switch and the pool grouping snapshot) start once the address has passed
  // the edge limiter, never before (L498), and run during the pause flag, the caps and
  // the body read. A request the caps below then refuse has started them, which costs
  // per server, never per request (`startConfirmPrelude`). The confirm awaits the
  // grouping before its line key.
  startConfirmPrelude(progress.facts);

  // The kill switch (#2297). Placed HERE on purpose: after the edge burst window, so
  // a flood is still shed in-datacenter without a database read, and BEFORE the
  // hourly and per-contact caps, so a refusal the lead did not cause never spends
  // their budget. A pause that lasted an hour would otherwise leave real leads
  // throttled after it was lifted.
  //
  // It runs before the body is read, so neither refusal can name a bucket. That is
  // recorded as `unidentifiable` rather than as an empty code, because both states
  // this gate refuses in are org-wide: no bucket would explain either one.
  const publicBooking = judgePublicBooking(await check(ROUTE_CHECK_STAGES.pauseFlag, readPublicBookingPaused));
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
  if (!(await check(ROUTE_CHECK_STAGES.hourlyCap, () => allowRequest(bookingCaller, BOOKING_HOURLY_RATE_RULES))))
    return tooMany("hourly");
  progress.spent.push({ caller: bookingCaller, rules: BOOKING_HOURLY_RATE_RULES });

  // #3135: read under a byte cap rather than buffering whatever arrives.
  const read = await check(ROUTE_CHECK_STAGES.bodyRead, () => readJsonCapped(req, PUBLIC_JSON_MAX_BYTES));
  if (read.tooLarge) {
    // refusal: body_too_large
    // Deliberately uncounted: no booker sends one, the reasoning is in refusal-catalog.ts.
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }
  const raw = read.value;
  const host = confirmHost(raw);

  // Honeypot (#1033): a hidden decoy field a real user never sees or fills, so a
  // value here means a scripted bot filling every field. Reject with the SAME
  // generic 400 a schema failure returns (revealing nothing bot-specific), before
  // touching the booking path. Logged at a queryable tag so trips are observable;
  // one honeypot hit is expected background noise, so it does NOT alert; a sustained
  // run does (#1727).
  if (raw && typeof raw === "object" && honeypotTripped((raw as Record<string, unknown>)[HONEYPOT_FIELD])) {
    log.info("booking-honeypot", { msg: "tripped", ip });
    // Out of the failure share (#1318): a real user cannot fill a field they never see,
    // so every trip is a script, and volume here measures bot traffic rather than
    // customers being refused. Recorded under its own name outside OUTCOME_ORDER
    // (#1727), so a sustained run of trips, which is either a campaign against the
    // booker or the field having become reachable by real leads, is judged on its own.
    const trapCode = rawBucketCode(raw);
    recordApiOutcome(EMBED_REFUSAL_OUTCOME.honeypot, trapCode, null, { by: "bucket", code: trapCode, host });
    // refusal: honeypot
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
    recordApiOutcome("error", rawBucketCode(raw), "invalid_request", { by: "bucket", code: rawBucketCode(raw), host });
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // #2073: a confirm through an agent's own link is not a ROUTED booking, so it
  // stays out of the outcome tally every routed rate is judged from (the failure
  // share, the per bucket error mix). Its failures still reach the log and, for a
  // fault, the internal error alert.
  const agentLinkKey = parsed.data.agentLink ?? parsed.data.agentLinkToken;
  const recordRoutedOutcome: typeof recordApiOutcome = agentLinkKey !== undefined ? () => {} : recordApiOutcome;
  const code = parsed.data.bucketCode ?? "";
  progress.source = { by: "bucket", code, host };
  progress.agentLink = agentLinkKey !== undefined;
  // #3300: the lead's Salesforce id, which the line carries if this confirm times out.
  progress.facts.leadId = refusedLeadId({ salesforceId: parsed.data.salesforceId });

  // #2666: the public test bucket is booked only with the pass `/book` handed a page
  // on an approved website. Checked before anything about the attendee, so a pass
  // that ran out while the modal sat open says so instead of a contact error, and
  // before the contact caps, so it spends none of them. The address cap it already
  // spent is handed back: the tester did nothing wrong, and a reload fixes it.
  if (isPublicTestBucket(code)) {
    const refused = refuseUnlessTestPass(req.headers, code, "booking");
    if (refused) {
      await refundRequest(bookingCaller, BOOKING_HOURLY_RATE_RULES);
      // refusal: test_pass_refused
      return NextResponse.json(refused.body, { status: refused.status });
    }
  }

  const attendeeErrors = validateAttendee(parsed.data.attendee);
  if (Object.keys(attendeeErrors).length > 0) {
    // refusal: invalid_contact
    // One is a typo the lead fixes in the field. A wave is the contact rules and the
    // incoming data disagreeing, which turns every lead from that source away at once,
    // and #1425 made that concrete: a number carrying an extension is now refused, so any
    // upstream source still sending one fails every time (#1318).
    recordRoutedOutcome("error", code, "invalid_contact", { by: "bucket", code, host });
    return NextResponse.json(
      { error: BOOKING_ERROR_COPY.checkContactDetails, fieldErrors: attendeeErrors },
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
    if (!(await check(ROUTE_CHECK_STAGES.contactCap, () => allowRequest({ kind: "opaque", key }, BOOKING_CONTACT_HOURLY_RATE_RULES))))
      return tooMany("contact", undefined, { code, host });
    progress.spent.push({ caller: { kind: "opaque", key }, rules: BOOKING_CONTACT_HOURLY_RATE_RULES });
  }

  // Give back the IP cap AND the per-contact caps for a failure that ISN'T the
  // lead's doing, so a server outage or a lost slot race can't consume their
  // booking budget. The edge per-minute window has no refund path; a taken time
  // offsets it with a retry credit instead (#3364), and anything else clears
  // within a minute.
  // Under the cleanup allowance rather than the confirm budget (#3102): a confirm
  // that timed out has spent that budget, and the lead is still owed the refund.
  // By here every cap has been spent, so the list is the IP cap and each contact.
  const refundAll = () => refundSpent(progress);

  // #2660: whether this confirm is a TEST booking, decided by the one constant
  // that establishes the mode (L319). It is what lets the service book the public
  // test bucket, and it is what the response tells the host page. Exact on this
  // route: a hidden test bucket is refused below before anything is created, and
  // a real code can never cascade into a test bucket (the ladder is XBC only), so
  // a booking made here is a test one exactly when the code is the public test
  // code. Never read from the client's body beyond the code itself.
  //
  // #2638: when the link carried no routable code the service decides the pool
  // itself (Salesforce, else the catch-all), and neither can ever be the public
  // test bucket. So a posted test code with such a link is not a test booking,
  // and the link has to name the test code too.
  // #2073: an agent's own link is resolved HERE, after every rate limit and the
  // contact caps, so probing for links pays the same budget a booking does. One
  // refusal for every cause, so the answer cannot say whether a link was ever
  // real; the cause goes to the log, never the name or token.
  let agentLink: { userId: string; bucketCode: string; isTest: boolean } | null = null;
  if (agentLinkKey !== undefined) {
    let judged: Awaited<ReturnType<typeof resolveAgentLink>>;
    try {
      judged = await check(ROUTE_CHECK_STAGES.agentLink, () => resolveAgentLink(agentLinkKey));
    } catch (err) {
      // #3102: the failure path runs under the cleanup allowance, not the confirm
      // budget, which a timeout has already spent; its outcome and report would
      // otherwise fail at once and the failure would go unrecorded.
      return withinBookingCleanupBudget(async () => {
        // #3102: a deadline here is the outage, answered as one by POST.
        if (isDeadlineExceeded(err)) throw err;
        // refusal: agent_link_unreadable
        return internalErrorResponse(err, "booking");
      });
    }
    if (!judged.ok) {
      log.info("agent-link", { msg: "confirm refused, the link books nobody", why: judged.why });
      // refusal: agent_link_unavailable
      return NextResponse.json(
        { error: AGENT_LINK_COPY.unavailable, code: AGENT_LINK_UNAVAILABLE_CODE },
        { status: 404 },
      );
    }
    agentLink = { userId: judged.agent.id, bucketCode: judged.bucketCode, isTest: judged.bucket.is_test };
  }

  const isTest = agentLink
    ? agentLink.isTest
    : isPublicTestBucket(code) &&
    (parsed.data.requestedCode === undefined ||
      resolveRequestedCode(parsed.data.requestedCode).kind === "valid");

  // #4391: a program lead's confirm, recognised only by a token the texted link's page
  // signed for THIS Lead and a new booking. Never through an advisor's own link, which
  // books one named advisor and has no placeholder to fall to.
  const programLead =
    agentLink === null && parsed.data.salesforceId && parsed.data.programLeadToken !== undefined
      ? verifyProgramLeadToken(parsed.data.programLeadToken, { salesforceId: parsed.data.salesforceId })
      : null;

  endChecks?.();
  try {
    const confirm: CreateBookingInput = {
      // One call per person, enforced here and only here (#1337): the direct
      // booking API owns its own richer decision and must keep creating on a
      // cross-bucket rebook (#364).
      // #2073: except through an agent's own link, which is the exception that
      // rule exists to allow (a later call with a lead who already has one).
      refuseIfPersonHasCall: agentLink === null,
      allowTestBuckets: isTest,
      bucketCode: agentLink ? agentLink.bucketCode : code,
      requestedCode: agentLink ? undefined : parsed.data.requestedCode,
      ...(agentLink ? { agentLinkUserId: agentLink.userId } : {}),
      startIso: parsed.data.start,
      timezone: parsed.data.timezone,
      salesforceId: parsed.data.salesforceId ?? null,
      attendee: {
        name: parsed.data.attendee.name?.trim(),
        firstName: parsed.data.attendee.firstName?.trim(),
        email: parsed.data.attendee.email?.trim(),
        phone: parsed.data.attendee.phone?.trim(),
      },
      prefill: parsed.data.prefill,
      referrerOrigin: parsed.data.referrerOrigin,
      // #3495: never through an agent's own link, which routes nothing.
      shownTier: agentLink ? undefined : parsed.data.shownTier,
      // #3797: never through an agent's own link, which records no routing decision.
      servedComputedAt: agentLink ? undefined : parsed.data.slotsComputedAt,
    };
    // #4391: a program lead's confirm books a real advisor on a time the cache serves and
    // the placeholder otherwise (`program-lead-booking.ts`); everybody else, as before.
    const program = programLead?.purpose === "new" ? await bookProgramLeadLive(confirm, progress.facts) : null;
    const { booking, manageUrl, newlyInserted, followUpLeftToDrain } = program
      ? program.result
      : await createBooking(confirm, progress.facts);
    // Backstop, not the ordinary path (#1337): a second booking is normally
    // DECLINED above before anything is created. Since #1641 the window it
    // covers is two simultaneous confirms both passing the check, and no longer
    // a failed lookup, which is refused rather than booked. When a duplicate does
    // reach here, the lead is told about it (#626).
    // #2073: not through an agent's own link, where holding another call is the
    // expected case rather than a mistake to warn about.
    // #3102: the booking exists by now, so nothing read after it may turn it into
    // a failure. The service already answers null on its own errors; this holds
    // the line here too, so a deadline (the confirm's budget can be spent by now)
    // or any later change to that function still returns the booking that was made.
    const duplicateWarning = agentLink
      ? null
      : await timeStage(progress.facts.profile, "duplicate-warning", () => findDuplicateBookingWarning({
          excludeBookingId: booking.id,
          salesforceId: parsed.data.salesforceId ?? null,
          attendee: {
            email: parsed.data.attendee.email?.trim(),
            phone: parsed.data.attendee.phone?.trim(),
          },
          // The same world the booking was made in (#2660): a tester's confirmation
          // never names a real lead's call, and a real lead's never names a test one.
          isTest,
        }).catch((err: unknown) => {
          log.error("booking", { msg: "duplicate warning unreadable after the booking was made", booking_id: booking.id }, err);
          return null;
        }));

    if (program?.onPlaceholder) {
      // #4391: a call on the placeholder is neither a routed booking nor a refusal, so it
      // is counted under its own name outside the failure share, by how it got there.
      const placed = program.path === "lost-race" ? PROGRAM_PLACEHOLDER_OUTCOME.afterRace : PROGRAM_PLACEHOLDER_OUTCOME.straight;
      recordRoutedOutcome(placed, code, null, { by: "bucket", code, host });
    } else {
      recordRoutedOutcome("created", code, null, { by: "bucket", code, host });
      // #2838: a booking made after its first advisor lost the overlap race is
      // counted again, on a row outside the failure share, for the daily race whisper.
      // Only when THIS confirm inserted it: a replay returns an earlier confirm's
      // booking, whose race was counted when that confirm made it.
      const raced = raceOutcomeForConfirm({ booking, newlyInserted });
      if (raced) recordRoutedOutcome(raced, code, null, { by: "bucket", code, host });
    }
    // #3267: answered the booking and left the work after its save to the
    // reservation drain. Counted beside the created row, outside the failure share,
    // so the monitor lane can page on the share of confirms doing it.
    if (followUpLeftToDrain) recordRoutedOutcome(FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME, code, null, { by: "bucket", code, host });
    return NextResponse.json({
      id: booking.id,
      // #2750: the lead ids the booking is STORED under, which the host looks it up
      // by. On a fresh booking they are the page's; they differ on a moved call.
      ...bookingIdentityFrom(booking),
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
      // #2165: who will call, for the Booker's own confirmation. Off the booking
      // just written, so it is the advisor the call is with at this moment; null,
      // never a placeholder, when the booking holds no name (L75). #4391: and never the
      // placeholder advisor's name, who is nobody the lead will speak to.
      advisorName: namesAdvisorToLead(booking) ? (booking.agent_name ?? null) : null,
      // #2659: the partner join keys the host put on the URL, read back off the
      // booking that was actually made, so the host can carry them onto its own
      // confirmed page. Null when the page passed none, so the field is always
      // there to read.
      ...partnerKeysFrom(booking.prefill),
    });
  } catch (err) {
    // #3102: the failure path runs under the cleanup allowance, not the confirm
    // budget, which a timeout has already spent; its outcome and report would
    // otherwise fail at once and the failure would go unrecorded.
    noteRefusal(progress.facts, err);
    // #3300: the refunds, the tally and any page, charged to the profile as one stage.
    // #3366, #3796: answered through the stored row check, which reads the row for a
    // candidate_read_empty refusal alongside the failure path and holds the 409, at
    // most for what the allowance has left, for the refresh of a pool still offering
    // the refused time, so the booker's reload right after it reads the refreshed row.
    return timeStage(progress.facts.profile, "failure-path", () => withinBookingCleanupBudget(() => answerAfterRefusalRefresh(err, async () => {
      // #4391: a program lead picked an extra time on a day whose extra times are all
      // gone. Nothing was reserved or invited (the claim comes first). Its own code and
      // sentence, never the taken time 409's (L11): that time is not taken, and the
      // booker reloads to the day's real times. Refunded, with a retry credit, exactly
      // as a taken time is, because the next pick is not a burst. Logged under its own
      // tag where it was refused; counting it per day is #4392's.
      if (err instanceof PlaceholderDayFullError) {
        await refundAll();
        await grantBookingRetryCredit(ip);
        // refusal: placeholder_day_full
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.placeholderDayFull, code: PLACEHOLDER_DAY_FULL_CODE },
          { status: 409 },
        );
      }
      // The lead already has an active call, so nothing was created (#1337). Refund
      // the rate-limit hit: being declined is not an attempt they should pay for,
      // and the Move they are about to make is a separate request.
      if (err instanceof ExistingCallError) {
        await refundAll();
        recordRoutedOutcome("deduped", code, "existing_call", { by: "bucket", code, host });
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
        recordRoutedOutcome("error", code, "existing_call_unavailable", { by: "bucket", code, host });
        // refusal: existing_call_unavailable
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      // #2638: the link carried no routable code, it names a lead, and the lead's
      // XBC could not be read from Salesforce. Nothing was created. Refused rather
      // than sent to the catch-all, because routing a lead whose score we could not
      // read to the Low pool is the misroute this read exists to prevent. Retriable,
      // and refunded like the other faults on our side.
      if (err instanceof LeadCodeUnavailableError) {
        await refundAll();
        log.error("booking", { msg: "lead routing code unreadable; refusing rather than routing to the catch-all" }, err.cause);
        recordRoutedOutcome("error", code, "lead_code_unavailable", { by: "bucket", code, host });
        // refusal: lead_code_unavailable
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      // Couldn't verify any candidate (likely a Google/DB outage), not a full
      // slot. Tell the lead it's temporary and let them retry (#319). Refund the
      // rate-limit hit: a server-side outage must not burn their booking budget.
      if (err instanceof VerifyUnavailableError) {
        // Couldn't verify any candidate (a Google/DB outage), not the lead's fault.
        await refundAll();
        recordRoutedOutcome("error", code, "verify_unavailable", { by: "bucket", code, host });
        // #3442: a lost race told to retry because too little of its budget was left
        // to walk down the ladder, counted in the race tally on a row outside the
        // failure share, beside rescued and refused.
        if (err instanceof LostRaceOutOfTimeError) {
          recordRoutedOutcome(RACE_RETRY_BUDGET_OUTCOME, code, null, { by: "bucket", code, host });
        }
        // refusal: verify_unavailable
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      // A genuinely-full slot: someone else took it a moment earlier. Not the lead's
      // fault, and a retry against another slot may well succeed, so hand the budget
      // back (#1089) before surfacing "no times" (409).
      if (err instanceof SlotUnavailableError) {
        await refundAll();
        // #3364: and the edge minute window, which cannot be refunded, is offset by one
        // retry credit, so picking the next time along is not refused as a burst. Before
        // the response, so a lead picking again at once already holds it.
        await grantBookingRetryCredit(ip);
        // The headline case (#1313 / #1315): a customer refused at confirm on a slot
        // WE ADVERTISED. One lost race is ordinary contention, which is why this
        // does not page on its own; fifty in two hours is the cal.com failure of
        // 2026-08-06, and it is indistinguishable from the one without a count.
        // #3797: a time that was really free when the lead's list was computed and was
        // taken since is a PROVEN lost race: counted on its own row outside the failure
        // share, in place of the error, so it never pages (Dan, 2026-10-16). Anything
        // not proven (no computed_at, an unreadable one, a row Slate had already proven
        // stale) is the error it always was.
        if (provenOfferRace(err)) recordRoutedOutcome(OFFER_RACE_OUTCOME, code, null, { by: "bucket", code, host });
        else recordRoutedOutcome("error", code, "slot_unavailable", { by: "bucket", code, host });
        // #2838: refused AFTER a lost overlap race, counted apart from a time already
        // taken at the free check, and apart again at the reassign bound. A second
        // row outside the failure share, so the share above reads exactly as before.
        if (err instanceof RaceLostRefusalError) {
          recordRoutedOutcome(raceOutcomeForRefusal(err), code, null, { by: "bucket", code, host });
        }
        // refusal: slot_unavailable
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      // #2310: the start is outside the lead's calling window (08:00 to 20:00 in
      // the zone the booker sent). The booker only offers times inside it, so this
      // is a page left open across a zone change, a stale embed, or a hand made
      // request. Its own code and sentence, never the slot-taken 409: the time is
      // not taken, and "that time was just taken" would send the lead to retry the
      // same refusal. Refunded, because another time books, the way a lost race is.
      // Counted: a wave means the client filter and the server rule disagree.
      if (err instanceof OutsideCallingWindowError) {
        await refundAll();
        recordRoutedOutcome("error", code, "outside_calling_window", { by: "bucket", code, host });
        // refusal: outside_calling_window
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.outsideCallingHours, code: "OUTSIDE_CALLING_WINDOW" },
          { status: 422 },
        );
      }
      // An empty/misconfigured pool ALSO surfaces as "no times" (409) to the consumer
      // (the API route #358 distinguishes them), but it is a config problem, not a
      // slot race: a retry won't help, so we deliberately do NOT refund here.
      if (err instanceof NoEligibleAgentsError) {
        recordRoutedOutcome("error", code, "no_eligible_agents", { by: "bucket", code, host });
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
        recordRoutedOutcome("error", code, "unknown_bucket", { by: "bucket", code, host });
        // refusal: unknown_bucket
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.unknownBucket, code: "UNKNOWN_BUCKET" },
          { status: 422 },
        );
      }
      // #3359: Google refused to invite the address the lead typed, so nothing was
      // booked and nothing was left reserved. Theirs to change, so it is said the way
      // our own check says it, against the email field, never as the 500 it was on
      // 2026-10-06. Refunded: our check should have caught it before any budget was
      // spent, and the corrected retry must not meet a rate limit.
      if (err instanceof AttendeeEmailRefusedError) {
        await refundAll();
        recordRoutedOutcome("error", code, "attendee_email_refused", { by: "bucket", code, host });
        // refusal: attendee_email_refused
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.checkContactDetails, fieldErrors: { [err.field]: err.message } },
          { status: 400 },
        );
      }
      recordRoutedOutcome("error", code, "internal", { by: "bucket", code, host });
      // refusal: internal
      return internalErrorResponse(err, "booking");
    })));
  }
}
