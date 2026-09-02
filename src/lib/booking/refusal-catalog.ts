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
  rateSignal: RefusalRateSignal;
  /** The reasoning that produced the decision. Required, including for a "no". */
  why: string;
}

export const REFUSAL_CATALOG: RefusalPath[] = [
  // --- the embed booker, which is where real leads are --------------------
  {
    id: "rate_limit_ip_minute",
    surface: "embed booker",
    outcome: "429, asked to try again in a few minutes",
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
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "The sustained per-IP cap, and the same reasoning as the burst window above: a trip is " +
      "abuse shaping, and counting it would dilute the share a real outage has to move.",
  },
  {
    id: "rate_limit_contact_hour",
    surface: "embed booker",
    outcome: "429, asked to try again in a few minutes",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "Keyed on the attendee identity precisely so a distributed bot spreading across many IPs " +
      "is bounded by the fake identity it reuses (#1033). A trip is therefore more likely to be " +
      "that bot than a real lead, who would have to try five times in an hour with one email to " +
      "reach it. Same dilution cost as the two above.",
  },
  {
    id: "honeypot",
    surface: "embed booker",
    outcome: "400, the same generic refusal a malformed request gets",
    counting: { kind: "none" },
    rateSignal: { kind: "none" },
    why:
      "A real user cannot fill a field they never see and cannot tab to, so by construction " +
      "every trip is a script. Volume here measures how much bot traffic arrives, which is not " +
      "customers being refused, and feeding it into the failure share would let a scraper mask " +
      "an outage.",
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
    rateSignal: { kind: "covered" },
    why:
      "The headline case #1313 was built for. One lost race is ordinary contention on a slot we " +
      "advertised; fifty in two hours is the 2026-08-06 cal.com failure, and the two are " +
      "indistinguishable without a count.",
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
    id: "internal",
    surface: "embed booker",
    outcome: "500, a generic failure",
    counting: { kind: "error", code: "internal" },
    rateSignal: { kind: "covered" },
    why: "An unexpected fault is never ordinary; the share is the signal that it is happening at all.",
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
    id: "reschedule_slot_taken",
    surface: "manage page",
    outcome: "409, told the time has gone",
    counting: { kind: "error", code: "reschedule_slot_taken" },
    rateSignal: { kind: "covered" },
    why:
      "A lead moving their call and being told the time went is the same shape as being refused " +
      "at confirm, and it was counted nowhere at all. Recorded alongside the reschedule SUCCESSES " +
      "from this route, so the share stays a share: adding only the failures would inflate it.",
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
];

/** Lookup by the id a call site names. */
export function refusalPath(id: string): RefusalPath | undefined {
  return REFUSAL_CATALOG.find((r) => r.id === id);
}
