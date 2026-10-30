/**
 * Every way a customer's booking request can end without a booking, and the
 * DECISION about whether that path needs a rate signal (#1318).
 *
 * Slate has several failure paths deliberately classified as ordinary, so they
 * alert nobody at any volume. That is right for one instance and wrong for fifty,
 * and a check with no notion of rate cannot tell the two apart (L77). On
 * 2026-08-06 cal.com refused more than fifty customers in about two hours; every
 * refusal was individually plausible, nothing anywhere said so, and Pennie found
 * out from an SMS complaint monitor sitting outside the booking system.
 *
 * #1313 fixed exactly one of these. This file is the same question asked as a
 * SWEEP rather than one incident at a time (L30), and it exists so the answer is
 * written down: the deliberate "no" is recorded here with its reasoning, so the
 * next person does not re-derive it, and so a new refusal path cannot be added
 * without someone deciding.
 *
 * ## The rule that shapes every decision below
 *
 * The booking-failure-rate window (#1313) judges FAILURES as a share of ATTEMPTS,
 * and `attempts` is every recorded outcome summed. So what is counted is not a
 * free choice: recording a bot's refusals would put bot volume in the denominator
 * and make a real outage look proportionally smaller, which is a worse outcome
 * than not counting it at all. Bot-shaped refusals are therefore deliberately
 * uncounted, and the reasoning is on each entry rather than assumed.
 *
 * ## Keeping it honest
 *
 * A hand-written registry only ever checks what somebody remembered to list, and
 * the entry that is missing is exactly the one that needed deciding (L96). So
 * `scripts/test-refusal-catalog.ts` reads the route files both ways: every
 * refusal site must name an entry here, and every entry here must be named by a
 * live site, so a removed path cannot leave a decision behind that looks like
 * coverage.
 */

/** How a refusal reaches the counters, if at all. */
export type RefusalCounting =
  /** Recorded as an `error` outcome under this code, so the booking-failure-rate
   *  window (#1313) already sees it and names it when it pages. */
  | { kind: "error"; code: string }
  /** Recorded as a non-error outcome: the caller made an attempt, and the result
   *  is not a fault, so it belongs in the denominator and not the numerator. */
  | { kind: "outcome"; outcome: string }
  /**
   * Recorded under an outcome name OUTSIDE `OUTCOME_ORDER` (#1442, #1709), so it
   * is measured without ever entering the denominator the failure SHARE is taken
   * against. The distinction from `outcome` above is the whole point: that one is
   * in the denominator, this one is deliberately not.
   *
   * Its pair is `uncounted-but-pages` below, and the two are checked against each
   * other: a path recorded this way must carry its own signal (a counter nothing
   * reads is a stored value with no reader, L46), and a signal claimed this way
   * must have a path that really records.
   */
  | { kind: "own-counter"; outcome: string }
  /** Deliberately not recorded anywhere. The entry's `why` must say what counting
   *  it would COST, not merely that it seemed unnecessary. */
  | { kind: "none" };

/** What was decided about a rate signal for this path. */
export type RefusalRateSignal =
  /** Counted, and the #1313 window pages on the share. No second mechanism. */
  | { kind: "covered" }
  /** Counted, and it ALSO pages on its own, independently of any share. */
  | { kind: "covered-and-pages"; alertKey: string }
  /**
   * Deliberately OUT of the failure share, and carrying its own signal instead
   * (#1442, #1709).
   *
   * A third answer, because the first two could not express the decision that was
   * actually made and forcing it into either would have been a lie the guard
   * correctly refused. "Covered" claims the share sees it, which would be false
   * and would stop anyone building the real signal; "none" claims nobody is
   * watching, which would be false the other way and would hide a live alert key
   * from the recovery-coverage guard.
   *
   * The path is recorded under an outcome name OUTSIDE `OUTCOME_ORDER`, so it
   * never enters the denominator the share is measured against, and it is judged
   * against its own total by `src/lib/monitor/api-refusal-signals.ts`.
   */
  | { kind: "uncounted-but-pages"; alertKey: string }
  /** Deliberately none. `why` carries the reasoning. */
  | { kind: "none" }
  /** Warranted, and not built here. Carries the issue that will, so a decision
   *  recorded as "later" cannot quietly become a decision recorded as "no" (L65). */
  | { kind: "deferred"; issue: number };

export interface RefusalPath {
  /** The id a `// refusal:` annotation at the call site names. */
  id: string;
  surface: "embed booker" | "booking API" | "manage page";
  /** What the customer or the caller gets, in a reader's terms. */
  outcome: string;
  counting: RefusalCounting;
  /**
   * Where a counted path's error code comes from, so the guard can check the claim
   * instead of exempting a whole surface (#1429).
   *
   * `"route"` means the entry point records the code as a literal, and the guard
   * requires it to really appear there. `"mapped"` means the code is produced by
   * `mapBookingError` from a thrown domain error, so it is not a literal in the
   * route. `"authorizer"` means it comes from `authRefusalCounting`, and the guard
   * checks that function's real output rather than scanning for a string, which is
   * a stronger tie than the literal scan. Absent counts as `"route"`: a new counted
   * path must be visible, not exempt by default.
   */
  codeFrom?: "route" | "mapped" | "authorizer";
  /**
   * The lead was told the time they picked had already gone (#3374). Usually another
   * lead booked it first, which is ordinary contention on a time we offered rather than
   * a fault, and the monthly error budget page counts these apart from everything else
   * so a reader can tell a sold out month from a broken one. Derived into
   * `SLOT_TAKEN_ERROR_CODES` (`src/lib/monitor/slo-targets.ts`), so a new path that
   * answers "the time has gone" joins that count by being marked here.
   */
  slotTaken?: true;
  rateSignal: RefusalRateSignal;
  /** The reasoning that produced the decision. Required, including for a "no". */
  why: string;
}

export const REFUSAL_CATALOG: RefusalPath[] = [
  // --- the embed booker, which is where real leads are --------------------
  {
    id: "rate_limit_ip_minute",
    surface: "embed booker",
    // #3364: and not reached at all by a lead's retry after a taken time while the address
    // holds a retry credit (at most three a minute).
    outcome: "429, asked to wait a minute and try again",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The edge burst window sheds a flood before Postgres is touched, so a trip is one host " +
      "sending faster than a person can, not a customer being turned away. Counting it would put " +
      "bot volume in the denominator the failure share is measured against, which would make a " +
      "real outage look proportionally smaller during a flood: the counting would actively hurt. " +
      "Every trip is logged with its scope and IP at a queryable tag. What WOULD change this " +
      "decision is many DISTINCT IPs tripping it, which is a cardinality this counter cannot " +
      "express and would need its own measurement.",
  },
  {
    id: "rate_limit_ip_hour",
    surface: "embed booker",
    outcome: "429, asked to try again in a few minutes",
    counting: { kind: "own-counter", outcome: "refused_embed_ip_hour" },
    rateSignal: { kind: "uncounted-but-pages", alertKey: "booking_embed_ip_cap" },
    why:
      "The sustained per-IP cap. Kept out of the failure SHARE for the same reason as the burst " +
      "window above: a trip is abuse shaping, and counting it would dilute the share a real " +
      "outage has to move. But a SUSTAINED trip across many addresses means either a bot spread " +
      "across them or the cap being wrong for real traffic, and one benign trip and a systemic " +
      "one arrive on the identical path (L77). #1727 counts trips under refused_embed_ip_hour, " +
      "outside OUTCOME_ORDER, and pages as booking_embed_ip_cap on how many DISTINCT addresses " +
      "the cap is refusing at once, read from the limiter's own rows, because one host flooding " +
      "produces the same trip volume as many and is exactly what the cap is for. What it cannot " +
      "see is many real leads behind one shared address, which reads as one.",
  },
  {
    id: "rate_limit_contact_hour",
    surface: "embed booker",
    outcome: "429, asked to try again in a few minutes",
    counting: { kind: "own-counter", outcome: "refused_embed_contact_hour" },
    rateSignal: { kind: "uncounted-but-pages", alertKey: "booking_embed_contact_cap" },
    why:
      "Keyed on the attendee identity precisely so a distributed bot spreading across many IPs " +
      "is bounded by the fake identity it reuses (#1033). One trip is therefore more likely to be " +
      "that bot than a real lead, who would have to try five times in an hour with one email to " +
      "reach it, and counting it into the share has the same dilution cost as the two above. A " +
      "VOLUME of trips cannot tell that bot from many leads either: one reused identity trips on " +
      "every request after its fifth. So #1727 decided on a DISTINCT count: trips are counted " +
      "under refused_embed_contact_hour, outside OUTCOME_ORDER, and the page " +
      "(booking_embed_contact_cap) is on how many emails and phones the cap is locking out at " +
      "once, read from the limiter's own rows, with a floor above the two keys one attendee can " +
      "hold.",
  },
  {
    id: "booking_paused",
    surface: "embed booker",
    outcome: "503, told we are not taking bookings online and to call instead",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "Somebody turned the kill switch on a moment ago and is watching the thing that made " +
      "them do it (#2297). Recording it as an error would page them about their own action, " +
      "which is how an alert stops being read (L36). Recording it as an attempt would be worse " +
      "in a subtler way: it would put a window in which EVERY public booking is refused by " +
      "design into the denominator the real failure share is measured against, so the share " +
      "would read healthy for as long as the pause lasted. The count that is actually worth " +
      "having, how many leads met a paused booker, is a total over a window somebody already " +
      "knows the bounds of rather than a rate, and the `tag=booking-paused` log line answers " +
      "it. What would change this decision is the switch being left on for days rather than " +
      "minutes, which is a different feature with a different signal.",
  },
  {
    id: "booking_pause_unreadable",
    surface: "embed booker",
    outcome: "503, told something went wrong on our side and to try again in a moment",
    counting: { kind: "error", code: "booking_pause_unreadable" },
    rateSignal: { kind: "covered" },
    why:
      "The kill switch's flag could not be READ, so the gate refuses rather than booking on " +
      "(#2297). Nobody chose this and it turns every lead away at once, which is exactly the " +
      "shape the failure-rate window exists to page on, and it names the code so the reader is " +
      "not left guessing which refusal is running. It is a separate entry from the pause above " +
      "rather than sharing one, because a shared id would let a deliberate pause explain away a " +
      "half-applied migration (L11). The most likely cause is code deployed ahead of its " +
      "schema, which the migration-lag monitor also pages on, from the other side.",
  },
  {
    id: "honeypot",
    surface: "embed booker",
    outcome: "400, the same generic refusal a malformed request gets",
    counting: { kind: "own-counter", outcome: "refused_embed_honeypot" },
    rateSignal: { kind: "uncounted-but-pages", alertKey: "booking_embed_honeypot" },
    why:
      "A real user cannot fill a field they never see and cannot tab to, so by construction " +
      "every trip is a script. Volume here measures how much bot traffic arrives, which is not " +
      "customers being refused, and feeding it into the failure share would let a scraper mask " +
      "an outage. So it stays out of the share, and #1727 counts it under " +
      "refused_embed_honeypot, outside OUTCOME_ORDER, because a SUSTAINED volume is worth " +
      "knowing on its own: it is either a campaign working through the booker or the field " +
      "having become visible or autofillable to real leads, who would then be refused with a " +
      "generic error. Here volume IS the measurement, so it pages as booking_embed_honeypot on " +
      "a floor derived from measured traffic, spread across several separate intervals so one " +
      "burst stays quiet.",
  },
  {
    id: "invalid_request",
    surface: "embed booker",
    outcome: "400, told the request was invalid",
    counting: { kind: "error", code: "invalid_request" },
    rateSignal: { kind: "covered" },
    why:
      "One malformed request is a stray caller. A WAVE means the embed or an integration is " +
      "sending a shape Slate rejects, so every lead arriving through it is being turned away and " +
      "nothing said so. Counted as an error, which is what it is, so the existing window pages " +
      "on the share and names the code rather than a second mechanism being built.",
  },
  {
    id: "body_too_large",
    surface: "embed booker",
    outcome: "413, told the request was too large",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The booker sends a confirm of well under two kilobytes, so a body past the 16 KB cap " +
      "(#3135) is never a lead using the product: it is somebody making the Worker buffer a " +
      "payload. Counting it would put that volume in the failure share's denominator and let it " +
      "dilute a real outage, the reason the honeypot is not counted either.",
  },
  {
    id: "invalid_contact",
    surface: "embed booker",
    outcome: "400, with the field errors so the lead can fix them",
    counting: { kind: "error", code: "invalid_contact" },
    rateSignal: { kind: "covered" },
    why:
      "One is a typo, and the lead fixes it in the field. A wave is the contact RULES and the " +
      "incoming data disagreeing, which turns every lead from that source away at once. This is " +
      "not hypothetical: #1425 made a phone number carrying an extension a refusal, so any " +
      "upstream source still sending one is now refused every time, and without this count the " +
      "only symptom is a quieter funnel.",
  },
  {
    id: "existing_call",
    surface: "embed booker",
    outcome: "409 carrying the call they already have",
    counting: { kind: "outcome", outcome: "deduped" },
    rateSignal: { kind: "none" },
    why:
      "A designed outcome, not a refusal: this lead is handed the appointment they already hold " +
      "and can move it. Counted as an attempt so it stays in the denominator, and deliberately " +
      "not as a failure, because a busy day of returning leads must not read as an outage.",
  },
  {
    id: "lead_code_unavailable",
    surface: "embed booker",
    outcome: "503, told it is temporary and to retry",
    counting: { kind: "error", code: "lead_code_unavailable" },
    rateSignal: { kind: "covered" },
    why:
      "The link carried no routable code and named a lead, and the lead's XBC could not be " +
      "read from Salesforce (#2638). It refuses rather than routing to the catch-all, because " +
      "sending a lead whose score could not be read to the Low pool is the misroute that read " +
      "exists to prevent. Counted as an error so the failure-rate window names it: one is a " +
      "blip a retry clears, a run of them is Salesforce unreachable on the booking path, and " +
      "that surfaces through the share rather than as its own page.",
  },
  {
    id: "existing_call_unavailable",
    surface: "embed booker",
    outcome: "503, told it is temporary and to retry",
    counting: { kind: "error", code: "existing_call_unavailable" },
    rateSignal: { kind: "covered" },
    why:
      "The one-call-per-person check could not be MADE: the bookings read behind it failed, so " +
      "nothing is known about what this lead already holds (#1641). It refuses rather than " +
      "booking, because the empty candidate list a failed read used to produce is the specific " +
      "claim that this person has no call, and acting on it creates the duplicate. Counted as " +
      "an error so the failure-rate window names it: one is a blip a retry clears, and a run of " +
      "them is the bookings table being unreadable on the hot path, which is an outage. It does " +
      "NOT page on its own, because the read it depends on is the same one every other booking " +
      "step uses, so a sustained failure here surfaces through the share alongside the rest " +
      "rather than as its own separate page.",
  },
  {
    id: "verify_unavailable",
    surface: "embed booker",
    outcome: "503, told it is temporary and to retry",
    counting: { kind: "error", code: "verify_unavailable" },
    rateSignal: { kind: "covered-and-pages", alertKey: "verify_on_book_outage" },
    why:
      "Never ordinary at any volume: it means no candidate could be verified against Google or " +
      "the database, so it pages on the first one (#319) as well as counting toward the share.",
  },
  {
    id: "slot_unavailable",
    surface: "embed booker",
    outcome: "409, told the time has gone",
    counting: { kind: "error", code: "slot_unavailable" },
    slotTaken: true,
    rateSignal: { kind: "covered" },
    why:
      "The headline case #1313 was built for. One lost race is ordinary contention on a slot we " +
      "advertised; fifty in two hours is the 2026-08-06 cal.com failure, and the two are " +
      "indistinguishable without a count.",
  },
  {
    id: "placeholder_day_full",
    surface: "embed booker",
    outcome: "409, told the extra times for that day just filled up, and shown the day's real times",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "A program lead (#4391) picked one of the placeholder advisor's extra times on a day whose " +
      "placeholder day limit was reached between the page loading and the confirm. It is the limit " +
      "working, not a fault, so it stays out of the failure share: counting it there would page on a " +
      "busy day doing exactly what the admin's setting asks, and it pages nowhere else for the same " +
      "reason. Whether the limit is turning too many program leads away is a question about a DAY, not " +
      "a rate over two hours, so each refusal is counted in program_lead_outcomes (kind limit_refused) " +
      "on the Eastern day it happened, and /admin/program-leads shows that count beside the day's " +
      "bookings for the admin who sets the limit (#4392). It is also logged under its own tag, " +
      "program-lead-day-full, with the call's day.",
  },
  {
    id: "attendee_email_refused",
    surface: "embed booker",
    outcome: "400, with the email field told to enter a valid address",
    counting: { kind: "error", code: "attendee_email_refused" },
    rateSignal: { kind: "covered" },
    why:
      "Google refused to invite the address the lead typed (#3359), after our own check passed " +
      "it. One is a lead's typo our rule did not yet know about. A wave means our rule and " +
      "Google's have drifted apart and every lead typing that shape is being turned away, which " +
      "the share sees and names under its own code rather than burying it under internal, " +
      "where it used to arrive as a 500 and a page.",
  },
  {
    id: "outside_calling_window",
    surface: "embed booker",
    outcome: "422 OUTSIDE_CALLING_WINDOW, told we only call between 8:00am and 8:00pm their time",
    counting: { kind: "error", code: "outside_calling_window" },
    rateSignal: { kind: "covered" },
    why:
      "The start is outside the lead's calling window in the zone the booker sent (#2310), which " +
      "Regal's quiet hours journey would cancel. The booker offers only times inside it, so one is " +
      "a stale page or a hand made request; a wave means the client filter and the server rule " +
      "disagree and leads are being refused at the last step, which is what the share is for.",
  },
  {
    id: "no_eligible_agents",
    surface: "embed booker",
    outcome: "409, told there are no times",
    counting: { kind: "error", code: "no_eligible_agents" },
    rateSignal: { kind: "covered-and-pages", alertKey: "no_eligible_agents:*" },
    why:
      "A configuration dead end rather than a busy calendar, so it pages per bucket on the first " +
      "one (#327). Counted too, so a fleet-wide version shows up as a share and not only as " +
      "sixty separate per-bucket pages.",
  },
  {
    id: "unknown_bucket",
    surface: "embed booker",
    outcome: "422 UNKNOWN_BUCKET, told the booking link is not valid",
    counting: { kind: "error", code: "unknown_bucket" },
    rateSignal: { kind: "covered" },
    why:
      "The code names no bucket, or names a hidden test bucket the public may not book " +
      "(#2667). It used to fall through to the internal error path, so a lead read a server " +
      "fault sentence for their own bad link and internal_error:booking paged on a request " +
      "anybody can send as often as they like (L498). Counted as an error by bucket, the way " +
      "invalid_request is: one is a stray link, a WAVE is an embed or a landing page sending " +
      "a code Slate does not serve, and every lead arriving through it is turned away. Bot " +
      "noise posting made up codes is accepted in that denominator on purpose, because it is " +
      "bounded by the same caps as every other attempt and the wave from a real embed is the " +
      "case worth seeing. The hidden test bucket case (#396) is NOT told apart from an " +
      "unknown code in the response, only in the log, since the response must never say a " +
      "hidden bucket exists (#601).",
  },
  {
    id: "test_pass_refused",
    surface: "embed booker",
    outcome: "403 TEST_PASS_EXPIRED, TEST_PASS_REFUSED or TEST_PASS_OFF, told to reload or to tell Pennie",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "Reached only on the public test bucket (#2666), whose reader is a TESTER on an approved " +
      "website, never a lead: a lead's code can never be the test code. Counting it would put " +
      "test traffic into the denominator the lead failure share is measured against, which is " +
      "the harm the whole catalog exists to avoid. Each refusal is logged under tag=embed-test " +
      "with its reason class, and the one state that turns testing off for everybody (no " +
      "secret on the deployment) is caught by the canary's keyless read, which pages when the " +
      "public bucket answers TEST_PASS_OFF.",
  },
  {
    id: "internal",
    surface: "embed booker",
    outcome: "500, a generic failure",
    counting: { kind: "error", code: "internal" },
    rateSignal: { kind: "covered" },
    why: "An unexpected fault is never ordinary; the share is the signal that it is happening at all.",
  },
  {
    id: "agent_link_unavailable",
    surface: "embed booker",
    outcome: "404 AGENT_LINK_UNAVAILABLE, told this advisor is not taking bookings through this link",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "An agent's own booking link (#2073) that books nobody: a token that never existed, one " +
      "an admin replaced, an advisor who has left or is not bookable. Deliberately uncounted, " +
      "like every other part of a named link confirm, because the tally is what the routed " +
      "failure share and the per bucket error mix are judged from and a named link does not " +
      "route; counting it would also let a token prober move a lead facing rate. The cause is " +
      "logged under tag=agent-link, never the token, and the one sentence for every cause is " +
      "what keeps the answer from saying whether a token was ever real.",
  },
  {
    id: "agent_link_unreadable",
    surface: "embed booker",
    outcome: "500, a generic failure, when the link's token could not be read",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The read behind an agent's own booking link (#2073) failed, which is a fault rather " +
      "than a refusal: answering it with the not taking bookings sentence would tell a lead " +
      "with a good link that their advisor is unavailable. It goes through " +
      "internalErrorResponse, whose per route alert is the signal, and is kept out of the " +
      "routed tally for the same reason as the refusal above.",
  },

  // --- the direct booking API (#253/#250), where a bot books for a lead ----
  {
    id: "api_unknown_bucket",
    surface: "booking API",
    outcome: "422 UNKNOWN_BUCKET, telling the caller to stop retrying",
    counting: { kind: "error", code: "UNKNOWN_BUCKET" },
    codeFrom: "mapped",
    rateSignal: { kind: "covered" },
    why:
      "A caller sending a code that does not resolve is refusing every lead it routes there, and " +
      "the contract already tells it to escalate rather than retry, so volume means an " +
      "integration is stuck rather than misbehaving once.",
  },
  {
    id: "api_no_eligible_agents",
    surface: "booking API",
    outcome: "409 NO_ELIGIBLE_AGENTS",
    counting: { kind: "error", code: "NO_ELIGIBLE_AGENTS" },
    codeFrom: "mapped",
    rateSignal: { kind: "covered-and-pages", alertKey: "no_eligible_agents:*" },
    why: "The same dead end as the booker's, reached through the API, and it pages the same way.",
  },
  {
    id: "api_slot_taken",
    surface: "booking API",
    outcome: "409 SLOT_TAKEN, telling the caller to pick another time",
    counting: { kind: "error", code: "SLOT_TAKEN" },
    codeFrom: "mapped",
    slotTaken: true,
    rateSignal: { kind: "covered" },
    why: "The API-side twin of slot_unavailable, and it needs the same rate signal for the same reason.",
  },
  {
    id: "api_verify_unavailable",
    surface: "booking API",
    outcome: "503 VERIFY_UNAVAILABLE, marked transient",
    counting: { kind: "error", code: "VERIFY_UNAVAILABLE" },
    codeFrom: "mapped",
    rateSignal: { kind: "covered-and-pages", alertKey: "verify_on_book_outage" },
    why: "The API-side twin of verify_unavailable, and it pages on the first one for the same reason.",
  },
  {
    id: "api_outside_calling_window",
    surface: "booking API",
    outcome: "422 OUTSIDE_CALLING_WINDOW, telling the caller to pick another time",
    counting: { kind: "error", code: "OUTSIDE_CALLING_WINDOW" },
    codeFrom: "mapped",
    rateSignal: { kind: "covered" },
    why:
      "The API-side twin of outside_calling_window (#2310), judged in the zone the caller sent. A " +
      "caller that keeps sending such times is refusing every lead it books, which is a share worth " +
      "seeing rather than one stray call.",
  },
  {
    id: "api_attendee_email_refused",
    surface: "booking API",
    outcome: "400 ATTENDEE_EMAIL_REFUSED, with the email field error, telling the caller to ask for another address",
    counting: { kind: "error", code: "ATTENDEE_EMAIL_REFUSED" },
    codeFrom: "mapped",
    rateSignal: { kind: "covered" },
    why:
      "The API-side twin of attendee_email_refused (#3359). Its own code rather than VALIDATION, " +
      "because the body parsed and passed our rules and Google refused it at the calendar: a wave " +
      "of VALIDATION means the caller's shape changed, a wave of this means our rule and Google's " +
      "disagree, and those send different people to fix different things (L11).",
  },
  {
    id: "api_internal",
    surface: "booking API",
    outcome: "500 INTERNAL",
    counting: { kind: "error", code: "INTERNAL" },
    codeFrom: "mapped",
    rateSignal: { kind: "covered" },
    why: "An unexpected fault reached through the API, judged on the same share as the booker's.",
  },
  {
    id: "api_validation",
    surface: "booking API",
    outcome: "400 VALIDATION, with the field errors",
    counting: { kind: "error", code: "VALIDATION" },
    rateSignal: { kind: "covered" },
    why:
      "The API-side twin of invalid_request and invalid_contact. One rejected body is a stray " +
      "call; a wave means the bot is sending a shape Slate no longer takes, and every lead it " +
      "is holding is refused until somebody notices.",
  },
  {
    id: "api_query_invalid",
    surface: "booking API",
    outcome: "400 VALIDATION on a lookup, list or cancel query",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "Nobody is refused a booking here: the caller is ASKING about bookings, or cancelling one " +
      "it named badly, and it gets the 400 in its own response and can act on it. Counting these " +
      "would put read traffic in the denominator of a booking failure share, which is the same " +
      "dilution the rate limits are kept out for.",
  },
  {
    id: "api_list_unavailable",
    surface: "booking API",
    outcome: "503 LIST_UNAVAILABLE, told it is temporary and to retry",
    counting: { kind: "own-counter", outcome: "refused_list_read" },
    rateSignal: { kind: "uncounted-but-pages", alertKey: "booking_api_list_read" },
    why:
      "The bookings page could not be READ (#1675). It refuses rather than answering, because " +
      "the empty page a failed read used to produce is the answer 'that is everything': the " +
      "caller advances its pagination watermark past bookings nobody read and never asks for " +
      "them again, so the loss is permanent and silent on both sides. It stays out of the " +
      "failure SHARE, for the same reason api_query_invalid does: this is read traffic, and " +
      "putting it in that denominator is the dilution the rate limits are kept out for. The " +
      "write path's existing_call_unavailable catches a sustained one once there IS write " +
      "traffic, but there is none until the automated booker goes live, so #1709 added a signal " +
      "that does not depend on it: refusals are counted under refused_list_read, outside " +
      "OUTCOME_ORDER, and a run of them spread across several separate intervals pages as " +
      "booking_api_list_read, a condition. One alone stays quiet, because a single unreadable " +
      "page is a blip the caller's own retry clears."
  },
  // #1429 split what used to be one `api_auth_refused` entry. The authorizer now
  // reports WHICH refusal it made, so the two opposite things behind that branch
  // get opposite treatment instead of one badly-chosen answer for both.
  {
    id: "api_key_rejected",
    surface: "booking API",
    outcome: "401, the credential is missing, malformed, or no longer one of ours",
    counting: { kind: "error", code: "API_KEY_REJECTED" },
    codeFrom: "authorizer",
    rateSignal: { kind: "covered-and-pages", alertKey: "booking_api_credential" },
    why:
      "A rotated or wrong key means the bot cannot book AT ALL, so every lead it handles is " +
      "refused for as long as the key is wrong. That is a config outage wearing a 401. It is " +
      "counted into the failure share, and #1450 added a SECOND signal independent of the share, " +
      "because that window deliberately ignores quiet periods (minAttempts 20 an hour) and a " +
      "completely locked out integration below that floor would stay silent while every lead it " +
      "handles is refused. The second signal judges PERSISTENCE rather than volume: this " +
      "endpoint is public, so one 401 is as likely to be a scanner with a junk bearer, and " +
      "paging on that would teach everyone to ignore the key (L36). Rejections spread across " +
      "several separate intervals are a lockout. Its own code, distinct from " +
      "API_NOT_CONFIGURED, because the repair differs: this one is a key to fix at the caller.",
  },
  {
    id: "api_not_configured",
    surface: "booking API",
    outcome: "503, no booking API key is configured at all",
    counting: { kind: "error", code: "API_NOT_CONFIGURED" },
    codeFrom: "authorizer",
    rateSignal: { kind: "covered-and-pages", alertKey: "booking_api_credential" },
    why:
      "The endpoint is effectively switched off, so every call is refused. Counted for the same " +
      "reason as a rejected key, under a DIFFERENT code because the instruction to the reader is " +
      "not the same: a secret nobody set is a deploy or environment gap, not a caller holding a " +
      "stale key. Sharing one code would let the page name a repair that cannot work. It shares " +
      "the booking_api_credential key with the rejected key but is its own CAUSE within it " +
      "(#1450), and it pages on the FIRST one rather than on persistence: only our own deploy " +
      "can produce it, there is no scanner that can make Slate forget its own key, and when both " +
      "are present this one wins because it explains every call failing.",
  },
  {
    id: "api_rate_limited",
    surface: "booking API",
    outcome: "429, the per-key ceiling or the per-IP backstop",
    counting: { kind: "own-counter", outcome: "refused_ceiling_key / refused_ceiling_ip" },
    rateSignal: { kind: "uncounted-but-pages", alertKey: "booking_api_ceiling" },
    why:
      "Not counted into the failure SHARE, and that part is settled: a trip is normally one " +
      "caller going faster than its budget, which is what the ceiling is FOR, and counting it " +
      "would put that caller's volume in the denominator the share is measured against, diluting " +
      "what a real outage has to move. But the same trip means something else entirely when it " +
      "is SUSTAINED on the write path: it means the ceiling is wrong for the bot's real volume, " +
      "so leads are being turned away by our own limit. One benign trip and a systemic one " +
      "arrive on the identical path (L77). #1442 built the second measurement: write-path trips " +
      "are counted under refused_ceiling_key and refused_ceiling_ip, which sit OUTSIDE " +
      "OUTCOME_ORDER and so can never enter the share's denominator, and are judged as a share " +
      "of everything the caller sent. The two ceilings are kept apart because their repairs are " +
      "different numbers. It pages as booking_api_ceiling, a condition, naming which ceiling and " +
      "its current limit, because a reader cannot act on 'rate limited'.",
  },
  {
    id: "api_confirm_required",
    surface: "booking API",
    outcome: "409 with the existing call, asking the bot to confirm a move",
    counting: { kind: "outcome", outcome: "confirm_required" },
    rateSignal: { kind: "none" },
    why:
      "Nobody is refused here: the caller is being ASKED, and retries with confirmReschedule. " +
      "Counted as an attempt so it stays in the denominator, never as a failure.",
  },

  // --- the manage page, where a lead moves the call they already have ------
  {
    id: "reschedule_invalid_reason",
    surface: "manage page",
    outcome: "400, told the reason is not one of the offered ones",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The reason arrives from a fixed list the same page rendered, so a value outside it is a " +
      "hand-made request rather than a lead using the product. A wave would mean the list and " +
      "the validator disagree, which is a shape the copy-parity tests already hold, so a counter " +
      "here would duplicate a guard that fails earlier and louder.",
  },
  {
    id: "reschedule_invalid_request",
    surface: "manage page",
    outcome: "400, told the request was invalid",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The manage page sends one fixed shape, so a body Slate rejects is a hand-made request " +
      "rather than a lead using the product. If the page itself ever sent the wrong shape, EVERY " +
      "reschedule would fail, which the reschedule failures below would report as a share within " +
      "minutes, so a second count here would say nothing new.",
  },
  {
    id: "reschedule_body_too_large",
    surface: "manage page",
    outcome: "413, told the request was too large",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The manage page sends a few hundred bytes, so a body past the 16 KB cap (#3135) is a " +
      "hand-made request meant to make the Worker buffer it, never a lead moving a call. The " +
      "reschedule failures below would report the page itself breaking, so nothing is lost.",
  },
  {
    id: "reschedule_slot_taken",
    surface: "manage page",
    outcome: "409, told the time has gone",
    counting: { kind: "error", code: "reschedule_slot_taken" },
    slotTaken: true,
    rateSignal: { kind: "covered" },
    why:
      "A lead moving their call and being told the time went is the same shape as being refused " +
      "at confirm, and it was counted nowhere at all. Recorded alongside the reschedule SUCCESSES " +
      "from this route, so the share stays a share: adding only the failures would inflate it.",
  },
  {
    id: "reschedule_placeholder_day_full",
    surface: "manage page",
    outcome: "409, told the extra times for that day just filled up; the call stays where it was",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The move twin of placeholder_day_full (#4391): a program lead moving their call onto an " +
      "extra time on a day whose placeholder day limit is reached. The limit doing its job, so it " +
      "stays out of the failure share and pages nowhere for the same reason. Counted the same way, in " +
      "program_lead_outcomes (kind limit_refused) on the Eastern day it happened, shown on " +
      "/admin/program-leads (#4392), and logged under program-lead-day-full.",
  },
  {
    id: "reschedule_conflict",
    surface: "manage page",
    outcome: "409, told to refresh because the booking moved underneath them",
    counting: { kind: "error", code: "reschedule_conflict" },
    rateSignal: { kind: "covered" },
    why:
      "One is a genuine race with an admin or a second tab. Volume means something is moving " +
      "bookings underneath their owners, which no other check would see.",
  },
  {
    id: "reschedule_no_eligible_agents",
    surface: "manage page",
    outcome: "409, told there is nobody free at that time",
    counting: { kind: "error", code: "reschedule_no_eligible_agents" },
    rateSignal: { kind: "covered" },
    why:
      "The target time has no free agent (#484). At volume it is the same staffing dead end the " +
      "booker pages for, reached by a lead who already has an appointment.",
  },
  {
    id: "reschedule_terminal",
    surface: "manage page",
    outcome: "409, told the booking can no longer be changed",
    counting: { kind: "error", code: "reschedule_terminal" },
    rateSignal: { kind: "covered" },
    why:
      "The booking is (or became) cancelled or completed, so the call it moved is over (#3569). " +
      "Before this it threw a plain Error that fell through to the generic 500 and paged the " +
      "on-call for a lead clicking a stale reschedule link. One is a stale link; a wave is the " +
      "shape of a page sending old links to settled bookings, which no other check would see, so " +
      "it is counted in the share like the other 409s rather than paging on its own.",
  },
  {
    id: "reschedule_not_found",
    surface: "manage page",
    outcome: "404, told the booking was not found",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The manage token resolves to no booking (#3569). The same reasoning as the 429 in " +
      "`reschedule_rate_limited`: the " +
      "token is unguessable (nanoid(24), about 143 bits), so a miss is a hand-made request rather " +
      "than a customer being turned away, and counting it would put that volume in the denominator " +
      "the failure share is measured against and make a real outage look proportionally smaller. " +
      "Before this it threw a plain Error that paged the on-call. A genuinely missing booking for a " +
      "real lead is rare and shows up as a 404 in the request log, not as a booking failure.",
  },
  {
    id: "reschedule_outside_calling_window",
    surface: "manage page",
    outcome: "422, told we only call between 8:00am and 8:00pm their time and to pick another time",
    counting: { kind: "error", code: "reschedule_outside_calling_window" },
    rateSignal: { kind: "covered" },
    why:
      "The new time starts outside the lead's calling window (#2310). The page offers only times " +
      "inside it, so one is a page left open across a zone change; a wave means the page's filter " +
      "and the server's rule disagree and every lead moving a call is being refused.",
  },
  {
    id: "reschedule_contact_refused",
    surface: "embed booker",
    outcome: "400, told which of the details they typed cannot be used, with the call left where it is",
    counting: { kind: "error", code: "reschedule_contact_refused" },
    rateSignal: { kind: "covered" },
    why:
      "A lead moving the call they already have is carrying the details they typed on this visit " +
      "onto it (#2164), and one of them is not a value we can use. The move is refused rather than " +
      "made without them, because writing them is the point of having been given them and moving " +
      "the call while dropping them is what that issue was opened to end. It is a typo in a field, " +
      "so it belongs with the other shape refusals rather than in a rate that pages.",
  },
  {
    id: "reschedule_attendee_email_refused",
    surface: "manage page",
    outcome: "422, told the invite could not go to the email we hold, with the call left where it is",
    counting: { kind: "error", code: "reschedule_attendee_email_refused" },
    rateSignal: { kind: "covered" },
    why:
      "The move-side twin of attendee_email_refused (#3373): Google refused to invite the address " +
      "the booking already holds, on the invite the move writes. It used to arrive as " +
      "reschedule_internal and a page about a fault of ours. One is a lead whose stored address " +
      "predates the tightened rule; a wave means our rule and Google's have drifted apart, which the " +
      "share names under its own code rather than burying it under internal.",
  },
  {
    id: "reschedule_verify_unavailable",
    surface: "manage page",
    outcome: "503, told it is temporary and to retry",
    counting: { kind: "error", code: "reschedule_verify_unavailable" },
    rateSignal: { kind: "covered-and-pages", alertKey: "verify_on_book_outage" },
    why: "The same outage as on the booker, reached from the manage page, and it pages the same way.",
  },
  {
    id: "reschedule_lock_unavailable",
    surface: "manage page",
    outcome: "503, safe to retry",
    counting: { kind: "error", code: "reschedule_lock_unavailable" },
    rateSignal: { kind: "covered-and-pages", alertKey: "reschedule_lock_outage" },
    why:
      "The lock claim fails CLOSED on a transient database error (#479), so a lead is turned away " +
      "to stay safe. It pages on its own, and the share catches a sustained one.",
  },
  {
    id: "reschedule_rate_limited",
    surface: "manage page",
    outcome: "429, asked to try again in a moment",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The same reasoning as the booker's burst window (#1046 added this one). Twenty requests a " +
      "minute is far above moving one appointment, and reaching a booking at all needs its " +
      "unguessable manage token, so a trip is one host hammering tokens rather than a customer " +
      "being turned away. Counting it would put that volume in the denominator the failure share " +
      "is measured against and make a real outage look proportionally smaller during a flood. " +
      "Every trip is logged under the limiter's own tag with the scope and address. What would " +
      "change this decision is many DISTINCT addresses tripping it, a cardinality this counter " +
      "cannot express.",
  },
  {
    id: "reschedule_internal",
    surface: "manage page",
    outcome: "500, a generic failure",
    counting: { kind: "error", code: "reschedule_internal" },
    rateSignal: { kind: "covered" },
    why: "An unexpected fault while moving a call, judged on the same share as the others.",
  },
  {
    id: "reschedule_write_failed",
    surface: "manage page",
    outcome: "503, told nothing changed and to try again in a moment",
    counting: { kind: "error", code: "reschedule_write_failed" },
    rateSignal: { kind: "covered" },
    why:
      "The gated commit did not RUN (#2373), so the call is exactly where it was. It used to " +
      "arrive as reschedule_conflict, because a refused statement and a concurrent change both " +
      "made the update touch zero rows, so a lead was told to refresh and pick again by a write " +
      "that never happened. One is a blip a retry clears; a run of them is the bookings table " +
      "unreachable on the move path, which is an outage and is exactly the shape the share " +
      "exists to page on. It also pages on its own through the internal-error chokepoint, and " +
      "is counted here so a sustained one is visible as a share rather than as one page per " +
      "fifteen minutes.",
  },

  // --- the manage page's cancel, and the booker's panel, which share one route ---
  // #2373 brought this surface into the catalog. It recorded nothing at all before,
  // so a cancel that turned a lead away was invisible to every counter Slate has.
  {
    id: "cancel_rate_limited",
    surface: "manage page",
    outcome: "429, asked to try again in a moment",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The same reasoning as reschedule_rate_limited beside it. Twenty requests a minute is far " +
      "above cancelling one appointment, and reaching a booking at all needs its unguessable " +
      "manage token, so a trip is one host hammering tokens rather than a customer being turned " +
      "away. Counting it would put that volume in the denominator the failure share is measured " +
      "against and make a real outage look proportionally smaller during a flood.",
  },
  {
    id: "cancel_invalid_request",
    surface: "manage page",
    outcome: "400, told the request was invalid",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "Both surfaces that reach this route send one fixed shape, so a body Slate rejects is a " +
      "hand-made request rather than a lead using the product. If either page ever sent the " +
      "wrong shape, EVERY cancel would fail, which cancel_internal below would report as a " +
      "share within minutes, so a second count here would say nothing new.",
  },
  {
    id: "cancel_body_too_large",
    surface: "manage page",
    outcome: "413, told the request was too large",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "Both surfaces that reach this route send a few hundred bytes, so a body past the 16 KB " +
      "cap (#3135) is a hand-made request meant to make the Worker buffer it, never a lead " +
      "cancelling. cancel_internal below would report the pages themselves breaking.",
  },
  {
    id: "cancel_invalid_reason",
    surface: "manage page",
    outcome: "400, told the reason is not one of the offered ones",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The reason arrives from a fixed list the same page rendered, so a value outside it is a " +
      "hand-made request. A wave would mean the list and the validator disagree, a shape the " +
      "copy-parity tests already hold, so a counter here would duplicate a guard that fails " +
      "earlier and louder.",
  },
  {
    id: "cancel_not_cancellable",
    surface: "manage page",
    outcome: "409, told the call has already taken place",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The meeting happened (#618), so there is nothing to cancel and a completed booking must " +
      "never regress. Nobody is being turned away from anything they could still have, and the " +
      "volume measures how many leads open an old manage link after their call, which is a fact " +
      "about people rather than about Slate. Counting it would put that in the denominator the " +
      "failure share is measured against for no reading anybody would act on.",
  },
  {
    id: "cancel_lost_race",
    surface: "manage page",
    outcome: "200, told it is cancelled, because it is: somebody else got there first",
    counting: { kind: "error", code: "cancel_lost_race" },
    rateSignal: { kind: "covered" },
    why:
      "The lead is told the truth and nothing is refused, so this is here for the RATE rather " +
      "than for the reader (#2373, L77). One is a second tab or an admin cancelling the same " +
      "booking, which is the claim working exactly as designed. A run of them is something " +
      "terminating bookings underneath their owners, and no other check in Slate would see it: " +
      "the same reasoning as reschedule_conflict, which is its twin on the move path. An " +
      "expected error nobody counts is filed as normal at every volume, which is how the " +
      "2026-08-06 cal.com failure went unseen for two hours.",
  },
  {
    id: "cancel_write_failed",
    surface: "manage page",
    outcome: "503, told nothing changed and to try again in a moment",
    counting: { kind: "error", code: "cancel_write_failed" },
    rateSignal: { kind: "covered" },
    why:
      "The gated claim did not RUN (#2373), so the booking, the Google invite and the advisor's " +
      "slot all stand. This is the defect the issue was opened about: it was indistinguishable " +
      "from the lost race above, and the route answered ok, so the lead read that their call was " +
      "cancelled when it was not. It is deliberately NOT the same entry as that one, because a " +
      "shared id would let an ordinary race explain away an unreachable table (L11). Counted so " +
      "a sustained one shows as a share, and it also pages on its own through the " +
      "internal-error chokepoint, because one instance already told a customer something false.",
  },
  {
    id: "cancel_internal",
    surface: "manage page",
    outcome: "500, a generic failure",
    counting: { kind: "error", code: "cancel_internal" },
    rateSignal: { kind: "covered" },
    why:
      "An unexpected fault while cancelling a call, judged on the same share as its reschedule " +
      "twin. Counted alongside the successes this route now records, so the share stays a share.",
  },
];

/** Lookup by the id a call site names. */
export function refusalPath(id: string): RefusalPath | undefined {
  return REFUSAL_CATALOG.find((r) => r.id === id);
}
