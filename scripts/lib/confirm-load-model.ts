// The load model of the confirm path (#3489, step 0), calibrated against load run
// 37640583621.
//
// That run drove #3437's head (crowd rule "walks") on the SHARED confirm line, and the
// load test answers Google instantly (`src/lib/google/loadtest-stub.ts` has no delay),
// so every millisecond of it is the database, the line object and the isolate's CPU.
// Its three bursts are the shapes #3489 has to change:
//
//   1. refusal control, one advisor free on the whole ladder: 1 booked at 6.2s and 99
//      SLOT_TAKEN at about 9.8s, 3.5 seconds after the booking;
//   2. tier drop, 24 free (one on the top rung): 4 booked (3 a rung down) at 3.8, 7.5,
//      9.5 and 12.2s, the other 8 answered 503 when their 10 second wait ran out;
//   3. refusal control, 4 free (two on the top rung): 2 booked at 5.7 and 6.9s, the
//      other 98 answered 503, two rungs' worth of advisors still free.
//
// The model is the suite's simulation (`confirm-contention-sim.ts`: the real confirm
// path on a virtual clock) with three things made to cost what the run measured:
//
//   - THE DATABASE: `slots` statements in service at once, each holding its slot for
//     `statementMs`, so concurrent calls queue and slow each other; around them, each
//     call's network. What one call takes alone is its measured latency.
//   - THE LINE OBJECT: a round trip on every message, and a first answer that took
//     about a second on a fresh object.
//   - THE ARRIVALS: when each confirm's route started (its 12 second budget starts
//     there) and when it reached the line, replayed confirm by confirm.
//
// Every figure below is DERIVED from the run's burst tail (the artifact `burst-tail`,
// one `confirm answered` line per confirm with its stage profile and its calls) unless
// it says TUNED. The scratch reader that produced them is described with each.
//
// Not named test-*.ts: the runner globs that pattern as a suite, so this file is a
// library the suite imports (shared fakes never live in a suite).
import type { CallCost } from "./confirm-contention-sim.ts";
import { parseGoogleDelay } from "../../src/lib/google/loadtest-google-delay.ts";

/**
 * A dependency that never reaches the database: Google (whose time each profile sets on
 * the fake itself), Salesforce and Slack. Every dependency is in exactly one of this,
 * `ON_DATABASE`, or the suite's synchronous set, and the suite derives the check from
 * the deps themselves (`classifyDeps`), so a new one is classified before it is priced.
 */
export const OFF_DATABASE: ReadonlySet<string> = new Set([
  "createEvent",
  "deleteEvent",
  "updateEventTime",
  "updateEventDescription",
  "updateEventContact",
  "busyIntervalsForAgent",
  "readEventDescription",
  // #3924: the abandoned pin sweep's read of the invite it may put back.
  "readEventOnPrimary",
  "createOwnerAlertEvent",
  "deleteOwnerAlertEvent",
  "moveOwnerAlertEvent",
  // Salesforce.
  "readLeadXbc",
  "readSubmissionLead",
  "readCallingNumber",
  // Slack.
  "postHandoffNotice",
]);

/**
 * A dependency that reaches the database. Priced at its own measured latency where
 * `DatabaseModel.callMs` (or the candidate read's rule) has one, and at the mean
 * statement otherwise.
 */
export const ON_DATABASE: ReadonlySet<string> = new Set([
  "roundRobinCandidates",
  // The live check reads the advisor by email and their calendar row before it asks
  // Google (`service.ts` `verifyFree`, `calendar.ts` `freeBusyMany`), and the load test's
  // stub sits below those reads, so a load run pays them too. Google's own time is still
  // the profile's, set on the fake.
  "verifyFree",
  // #3489: the walk's ladder read (`ladder_candidate_inputs`, 0176), one request for
  // every rung's candidate inputs; a rung judged from it reads nothing of its own.
  "readLadderInputs",
  "findActiveBookingsForPerson",
  // #3739: an advisor link confirm with no Lead id on its link reads the lead's
  // earlier bookings once; a routed confirm never does.
  "earlierLeadBookings",
  "resolveBucketByCode",
  "findBookingByIdempotencyKey",
  // #3847: the reservation resume's read by key in any status (a drain path, and a
  // lead's re-submit that finds a reservation pending).
  "findLatestBookingByIdempotencyKey",
  "loadReservationByKey",
  "displayedTier",
  "resolveBucketPool",
  "getUser",
  "insertReservation",
  "loadEmails",
  "advisorTimezone",
  "agentActiveBookingStartsMs",
  "agentWorkingHours",
  "bumpPendingEventDeletion",
  "bumpReservationAttempt",
  "businessHours",
  "claimCancellation",
  "claimReschedule",
  "commitReschedule",
  "completeBookingsIfDue",
  "deleteBusyBlocksForBooking",
  "deleteExpiredReservations",
  "deleteGcalMirrorBlock",
  "deleteReassignIntent",
  "deleteReservation",
  "emitWebhook",
  "enqueueEventDeletion",
  "enqueueOutbox",
  "findActiveBookingsByStrongIds",
  "findActiveBookingsStartingAt",
  "getAgentByEmail",
  "getBookingEventId",
  "hasBookingEvent",
  // The fake's separate insert, which the one call save (#3495) is modelled over. It is
  // reached only on the UNWRAPPED deps from inside `commitFreshBooking`, so it is never
  // charged on its own; it stays classified because it is still a dependency the fakes
  // carry.
  "insertBooking",
  "commitFreshBooking",
  "readBookingByIdempotencyKey",
  "insertBookingEvent",
  "insertBusyBlocks",
  "insertOwnerAlert",
  "invalidateSlots",
  "leaseOutbox",
  "leaseReservation",
  "liveBookingHoldingEvent",
  "loadAbandonedReassignIntents",
  "loadAbandonedReschedulePins",
  // #3924: the abandoned pin sweep's claim on a row, its release, and its booking read.
  "takeOverAbandonedReschedulePin",
  "releaseAbandonedReschedulePin",
  "readBookingInviteState",
  "loadAgentDisplayName",
  "loadBookingAssignees",
  "loadBookingById",
  "loadBookingContext",
  "loadCalendarOwners",
  "loadDrainableReservations",
  "loadHandoffChannel",
  "ownerReassignNoticeOn",
  "loadLiveOwnerAlert",
  "loadPastBookingIdsToComplete",
  "loadPendingEventDeletions",
  "loadPendingEventDeletionsForCalendar",
  "markOutboxDelivered",
  "markOwnerAlertRemoved",
  "moveBusyBlock",
  "pendingWritePinsEvent",
  "queryBookings",
  "readReschedulePin",
  "reassignSwap",
  "recordOwnerAlertSkip",
  "recordRoutingDecision",
  "releaseOutboxLease",
  "releaseReschedule",
  "releaseRescheduleIfTarget",
  "releaseReservationLease",
  "removePendingEventDeletion",
  "repinReservationEvent",
  "saveOutboxSteps",
  "setOwnerAlertEventId",
  "updateBookingContact",
  "updateBookingPhone",
  "writeReassignIntent",
  "writeReschedulePin",
]);

/**
 * How `names` (every function dependency) fall across the classifications: the ones in
 * none, the ones in more than one, and the classified names that are not dependencies.
 */
export function classifyDeps(
  names: readonly string[],
  sets: Readonly<Record<string, ReadonlySet<string>>>,
): { unclassified: string[]; twice: string[]; stale: string[] } {
  const all = Object.values(sets);
  const unclassified = names.filter((n) => !all.some((set) => set.has(n)));
  const twice = names.filter((n) => all.filter((set) => set.has(n)).length > 1);
  const known = new Set(names);
  const stale = [...new Set(all.flatMap((set) => [...set]))].filter((n) => !known.has(n)).sort();
  return { unclassified, twice, stale };
}

export interface DatabaseModel {
  /**
   * Statements in service at once, and how long each holds its slot. Only their RATIO
   * is measured: the database drained one statement every ~35ms whenever a crowd queued
   * on it, three times over in this run (burst 3's 62 switch reads at once finished over
   * 2.3s; burst 1's 143 deferred writes after its answers over 5.1s; burst 3's 228 over
   * 7.6s), so `slots / statementMs` is 1 / 35ms. The split is TUNED: 2 slots of 70ms,
   * the only whole split under which one statement still fits inside the fastest single
   * statement call the run timed (the reservation lookup, 80 to 94ms). It is not
   * neutral: 1 slot of 35ms (recorded beside each calibration case in the suite) gives
   * bursts 1 and 3 alike but loses burst 2's fourth booking, which the run itself
   * landed at 12.16s, at the edge of that confirm's 12 second budget.
   */
  slots: number;
  statementMs: number;
  /**
   * What one statement takes end to end with nothing queued: the mean over a booking
   * leader's whole chain (3847ms over 45 calls in burst 1, 3733 over 44 and 4206 over 43
   * in burst 2: 85 to 98ms). A call measured at L runs round(L / this) statements.
   */
  meanStatementMs: number;
  /** Each call's latency alone, by dependency. Unlisted calls take `meanStatementMs`. */
  callMs: Readonly<Record<string, number>>;
  /**
   * How many requests a call makes, where that is KNOWN. The drain is a request (#3492:
   * Postgres spent 0.4% of wall time executing statements while each call took 90 to
   * 200ms), so a call that is one request holds it for one, however long it takes. An
   * unlisted call is charged its latency over `meanStatementMs`, which is right for a call
   * that is several requests one after another and wrong for one long request.
   */
  requests?: Readonly<Record<string, number>>;
  /**
   * The rounds a call makes its requests in, each round's at once (`CallCost.depth`), where
   * that is KNOWN. Unlisted, a call's requests are one after another.
   */
  depth?: Readonly<Record<string, number>>;
  /** The candidate read's requests and rounds, by how many the cache shows free (see `CODE_REQUESTS`). */
  candidateReadRequests: { noneFree: number; oneFree: number; manyFree: number };
  candidateReadDepth: { noneFree: number; oneFree: number; manyFree: number };
  /**
   * The candidate read (`roundRobinCandidates`) costs more the more of the rung the
   * cache says is free: with one free it also reads the reroute holds, with two or more
   * it also ranks them by booking share (`src/lib/availability/service.ts`).
   */
  candidateReadMs: { noneFree: number; oneFree: number; manyFree: number };
  /**
   * The run's own sync lane, as callers on the database each running one statement
   * after another, during a burst it overlapped (`BurstShape.syncLaneRunning`).
   */
  syncLaneCallers: number;
}

/**
 * The database the run met, from the six booking leaders of bursts 1 and 2 (the four of
 * burst 3 ran under its own crowd's deferred writes, which the model produces itself).
 * Each is the median of that stage over the confirms that ran it, divided among the
 * dependencies the simulated path calls inside the stage:
 *
 *   person-decision 283..539, median 350: the bucket read (90) and the person read (260)
 *   idempotency-lookup 82..138, median 90          inflight-lookup 81..94, median 87
 *   displayed-tier 186..296, median 262            routing-trace 85..160, median 118
 *   load-advisor 77..163, median 87                reserve 86..125, median 93
 *   complete-reservation 754..969, median 916, over the ten database calls it made (90).
 *     Since #3495 seven of those calls are ONE (`commitFreshBooking`): the insert, the
 *     busy block, the bucket and advisor reads for the webhook and the routing record,
 *     the webhook, the routing record and the reservation's delete. The slot refresh and
 *     the stray mirror's delete are still their own calls. So the code the run ran is
 *     replayed by pricing the one call at the seven it replaced, 7 x 90 = 630: the price
 *     of the CODE THE RUN RAN, never a measurement of the one call (`STACK_DATABASE`
 *     below carries that). Pricing it from the stage instead (916 less the slot refresh)
 *     counted the two calls that stayed separate twice, and moved burst 3's second
 *     booking 1.3s later than the code the run ran, measured against #3437's own head.
 *   line-report 39 (the object's round trip alone) and 142 with the seat read (90)
 *
 * The candidate read, by how many the cache shows free, from what the walk took:
 *
 *   - none free: each rung's `rung_ms`, less the two round trips to the line the
 *     simulated walk makes on an empty rung (90) and a lower rung's bucket read (90):
 *     burst 1's walker 321, 612, 919, 476 and burst 2's top rung 442, 459, so 231, 432,
 *     739, 296, 352, 369: median 360.
 *   - many free (burst 2's rung 230, 23 free): from the HAND ON, which the tail times
 *     directly as the next leader's turn. Burst 2's leaders B and C reached the claim
 *     that handed the line on 848 and 935ms into rung 230 (the next turn, less their own
 *     person decision, lookups, displayed tier and rung 220), less the bucket read and the
 *     claim's round trip (90 + 45): 713 and 800, so 755. What the rung took AFTER the
 *     claim (C: 1104 - 935 = 169) is the advisor emails and what follows them, taken as
 *     the emails read (`loadEmails`, 169).
 *   - one free (the top rung's last advisor): the whole assignment, 662 (burst 2) and 903
 *     (burst 1), less the claim and the emails (45 + 169): 448 and 689, so 570.
 */
/**
 * The requests each call makes on the BOOKING API, counted from the code on 2026-10-08
 * (`realDeps` in `src/lib/booking/service.ts` and what it calls; one awaited supabase-js
 * call or `.rpc` is one HTTP request, and the client retries nothing):
 *
 *   - the candidate read (`roundRobinCandidates`, `availability/service.ts`): the members
 *     and their users together, then the schedules and a busy page together, then the
 *     daily cap count, with the business hours (two reads, not the cached reader) beside
 *     them: 7 requests in 3 rounds with nobody free. One free adds the live reroute holds
 *     (8 in 4); two or more add the booking share read that ranks them (9 in 5). A read
 *     narrowed to one handed advisor still reads the whole pool first and is priced as
 *     one free.
 *   - the live check (`verifyFree`): the advisor by email, then their calendar row, then
 *     Google: 2, one after the other.
 *   - the pool trace (`resolveBucketPool`): members and users at once, 2 in one round. The displayed
 *     tier: the bucket's slot row, 1 (0 on an edge cache hit, which the load test's
 *     workers.dev host is not shown to give). The advisor emails: 1.
 *   - the slot refresh (`invalidateSlots`) and the stray mirror's delete: NONE inline on
 *     the booking API, which hands both to `afterResponse`. They are deferred work
 *     (`DeferredModel`), not calls the confirm waits on.
 *
 * Everything else not listed here is one request, which latency over a statement already
 * gives it.
 */
const CODE_REQUESTS = {
  verifyFree: 2,
  resolveBucketPool: 2,
  loadEmails: 1,
  displayedTier: 1,
  invalidateSlots: 0,
  deleteGcalMirrorBlock: 0,
} as const;

/** The rounds of the calls above that make more than one request at a time. */
const CODE_DEPTH = { verifyFree: 2, resolveBucketPool: 1 } as const;

const CANDIDATE_READ_REQUESTS = { noneFree: 7, oneFree: 8, manyFree: 9 } as const;
const CANDIDATE_READ_DEPTH = { noneFree: 3, oneFree: 4, manyFree: 5 } as const;

export const LOAD_RUN_DATABASE: DatabaseModel = {
  slots: 2,
  statementMs: 70,
  meanStatementMs: 90,
  callMs: {
    findActiveBookingsForPerson: 260,
    resolveBucketByCode: 90,
    findBookingByIdempotencyKey: 90,
    readBookingByIdempotencyKey: 90,
    commitFreshBooking: 630,
    loadReservationByKey: 87,
    displayedTier: 262,
    resolveBucketPool: 118,
    getUser: 87,
    insertReservation: 93,
    // The 169ms the run timed after a claim is the emails read AND what followed it, the
    // live check's two reads (Google answered at once): one statement each, 70 + 140,
    // which prices the pair 41ms above the run rather than below it.
    loadEmails: 70,
    verifyFree: 140,
    // Handed to `afterResponse` on the booking API (`CODE_REQUESTS`): no time inline.
    invalidateSlots: 0,
    deleteGcalMirrorBlock: 0,
  },
  // The run's person read was four requests at once (each strong id on two columns, the
  // email, the phone) and its save the seven calls #3495 folded into one.
  requests: { ...CODE_REQUESTS, findActiveBookingsForPerson: 4, commitFreshBooking: 7 },
  depth: { ...CODE_DEPTH, findActiveBookingsForPerson: 1 },
  candidateReadMs: { noneFree: 360, oneFree: 570, manyFree: 755 },
  candidateReadRequests: CANDIDATE_READ_REQUESTS,
  candidateReadDepth: CANDIDATE_READ_DEPTH,
  syncLaneCallers: 1,
};

/**
 * The database cost of the STACK (#3495's one call save, #3476's one request person
 * read), where `LOAD_RUN_DATABASE` prices the code run 37640583621 ran. Everything is
 * the calibrated model except the two calls that changed, and each is ONE request, so
 * each is charged one (`DatabaseModel.requests`), never its latency over a statement:
 *
 *   - `commitFreshBooking`: MEASURED, by the same rule as the calibration (a booking
 *     leader's stage under a burst, divided among the requests it makes). On #3514's runs
 *     37689851365 and 37716759688 three attempts timed `complete-reservation` at 491,
 *     371 and 204ms (the 742ms of two attempts, one lost to a race, split evenly). That
 *     stage holds two requests on the booking API (the idempotency read and the save; the
 *     slot refresh and the stray mirror's delete wait for the answer), so the median,
 *     371, is 186 a request. Pricing it instead as the stage less the slot refresh (527)
 *     and charging that as six requests made the save's cut read as almost nothing.
 *   - `findActiveBookingsForPerson`: ESTIMATED, not measured. One request where four
 *     ran at once (each strong id on two columns, the email, the phone), so it is
 *     priced as one statement call (90) until a run on the stack measures the
 *     person decision stage.
 *   - `readLadderInputs`: ESTIMATED, not measured. One request carrying every rung's
 *     candidate inputs (the org roster, schedules, two and a half hours of busy time,
 *     a week of counts, the share rows), so a heavier answer than one statement's:
 *     priced at 200ms until a run on the stack measures the `ladder-read` stage. A
 *     rung judged from it reads nothing. The what if grid on #3489 (2026-10-08) put
 *     the bursts' verdicts within the bar from 150 to 300ms for a one request read.
 *   - `verifyFree`: one request where it made two, the advisor read by email being gone
 *     (#3495: `selectAgent` hands it the ids the emails were read from).
 */
export const STACK_DATABASE: DatabaseModel = {
  ...LOAD_RUN_DATABASE,
  callMs: {
    ...LOAD_RUN_DATABASE.callMs,
    commitFreshBooking: 186,
    findActiveBookingsForPerson: 90,
    readLadderInputs: 200,
    // #3495: the advisors' ids ride with their emails, so the live check reads only their
    // calendar rows: one of its two statements.
    verifyFree: 70,
  },
  requests: { ...CODE_REQUESTS, commitFreshBooking: 1, findActiveBookingsForPerson: 1, readLadderInputs: 1, verifyFree: 1 },
  depth: { ...CODE_DEPTH, verifyFree: 1 },
};

/** The shared line object as the run reached it. */
export interface LineObjectModel {
  /**
   * One message's round trip once the object is up: a leader's report alone took 39ms
   * (burst 2, `line-report`), and its seat read plus the report 142 (burst 1). 45.
   */
  roundTripMs: number;
}

export const LOAD_RUN_LINE: LineObjectModel = { roundTripMs: 45 };

/** What each request does on the database AFTER it answered (route deferred work). */
export interface DeferredModel {
  /** Every answer: the booking API's outcome tally (`booking-api-tally`). */
  tally: CallCost;
  /** A 503: the failure page (`booking-failure-page`). */
  failurePage: CallCost;
  /** The first answer on each isolate: the caller's last seen stamp (`api-caller-seen`). */
  callerSeen: CallCost;
  /** A booking: the slot cache refresh after the confirm (`post-confirm-recompute`). */
  recompute: CallCost;
  /** A booking: the webhook's first send, its delivery claim and its outcome (the load
   *  test skips only the outside POST, `loadtestDeliveryResult`). */
  webhookSend: CallCost;
  /** A booking: the stray calendar mirror's delete, handed to `afterResponse`. */
  mirrorDelete: CallCost;
  /** The shared line switch read a confirm makes on a cold switch cache, at its route's
   *  start and not waited on past its deadline (`shared-line-switch`). */
  switchRead: CallCost;
}

/**
 * From the deferred work the tail recorded, uncontended (burst 2, where only 12 confirms
 * answered): tally p50 315ms, failure page 260, caller seen 174, the switch read p50 402
 * (the followers whose only Supabase call it was). Each is ONE statement: that is what the
 * drain rates above require (a crowd's deferred writes drained at the one statement rate).
 * The slot cache refresh took 676 to 1606ms (p50 1291) after each burst 2 booking. On a
 * create it is a SPLICE (`booked-splice.ts`): three reads at once, then four in turn
 * (schedules, the cap count, busy time, the slot rows), then one write per code whose
 * offered times changed, which is none while another advisor is still free at the time
 * and every one of the advisor's codes when they were the last: 7 requests in 5 rounds,
 * plus those writes, which this leaves out. Taken as 14 (its latency over a statement) until the
 * code was counted on 2026-10-08. The webhook's first send is its claim and its outcome
 * (2), the mirror's delete one; neither was in the tail, so each is a statement apiece.
 */
export const LOAD_RUN_DEFERRED: DeferredModel = {
  tally: { latencyMs: 315, queries: 1 },
  failurePage: { latencyMs: 260, queries: 1 },
  callerSeen: { latencyMs: 174, queries: 1 },
  recompute: { latencyMs: 1291, queries: 7, depth: 5 },
  webhookSend: { latencyMs: 180, queries: 2, depth: 2 },
  mirrorDelete: { latencyMs: 90, queries: 1 },
  switchRead: { latencyMs: 402, queries: 1 },
};

export interface LoadProfile {
  name: "load run" | "production" | "stack load run" | "stack production";
  database: DatabaseModel;
  line: LineObjectModel;
  deferred: DeferredModel;
  /** Google's live check (`verifyFree`) and calendar write (`createEvent`). */
  googleCheckMs: number;
  googleWriteMs: number;
}

/** The load run: Google answers at once (the load test's stub). */
export const LOAD_RUN_PROFILE: LoadProfile = {
  name: "load run",
  database: LOAD_RUN_DATABASE,
  line: LOAD_RUN_LINE,
  deferred: LOAD_RUN_DEFERRED,
  googleCheckMs: 0,
  googleWriteMs: 0,
};

/**
 * Production's Google time per call, as the load test's `google_delay` value (#3490):
 * the p50 and p95 of the live check (`read`) and the calendar write (`write`) over the
 * `confirm answered` lines of 2026-10-19 03:00 to 2026-10-22 14:00 UTC (2,782 confirms,
 * weighted where Cloudflare sampled), read by `scripts/loadtest/google-timings.ts`. The
 * hours Cloudflare kept in full read 216/471 and 578/882 on their own, so the sampled
 * hours did not skew it. Re-measure it by the runbook ("The Google delay"); the runbook
 * records the same string (`scripts/test-loadtest-google-delay.ts`).
 */
export const MEASURED_PRODUCTION_GOOGLE_DELAY = "read=215/468,write=582/862";

function measuredGoogleP95(kind: "read" | "write"): number {
  const value = parseGoogleDelay(MEASURED_PRODUCTION_GOOGLE_DELAY)[kind];
  if (!value) throw new Error(`MEASURED_PRODUCTION_GOOGLE_DELAY carries no usable ${kind} (${MEASURED_PRODUCTION_GOOGLE_DELAY})`);
  return value.p95Ms;
}

/**
 * Production: the same database and line, and Google at its measured p95
 * (`MEASURED_PRODUCTION_GOOGLE_DELAY`). The model gives every call one fixed time, and
 * a slower Google is the side that crowds the line, so the p95 rather than the median.
 * Until #3490 this was a 3 second check and a 5 second write, the assumed split of the
 * 7.4 to 8.0s a whole confirm took on 2026-10-04 (#3221); confirms now take about 1.6s
 * at the median. The suite's slow Google scenarios keep 3s and 5s as a slow case.
 * Whether production's database answers a burst as the micro load test branch did is
 * not known (both are micro, max_connections 60), so this is the load run's database
 * with production's Google, and no more.
 */
export const PRODUCTION_PROFILE: LoadProfile = {
  ...LOAD_RUN_PROFILE,
  name: "production",
  googleCheckMs: measuredGoogleP95("read"),
  googleWriteMs: measuredGoogleP95("write"),
};

/** The load run's profile with the stack's database cost (`STACK_DATABASE`). */
export const STACK_LOAD_RUN_PROFILE: LoadProfile = {
  ...LOAD_RUN_PROFILE,
  name: "stack load run",
  database: STACK_DATABASE,
};

/** Production's Google with the stack's database cost. */
export const STACK_PRODUCTION_PROFILE: LoadProfile = {
  ...PRODUCTION_PROFILE,
  name: "stack production",
  database: STACK_DATABASE,
};

/**
 * The cost of one call under `db`. `freeOnRung` answers, for a candidate read, how many
 * of that rung's advisors the cache shows free at the instant (the harness knows its
 * own bookings). Null is a call that never reaches the database.
 */
export function databaseCosts(
  db: DatabaseModel,
  freeOnRung: (bucketCode: string, startMs: number) => number,
): (name: string, args: unknown[]) => CallCost | null {
  const statementsFor = (latencyMs: number) => Math.max(1, Math.round(latencyMs / db.meanStatementMs));
  return (name, args) => {
    if (OFF_DATABASE.has(name)) return null;
    // A call in neither list would be priced on a guess; refuse it by name instead.
    if (!ON_DATABASE.has(name)) throw new Error(`the load model has not classified ${name}: add it to ON_DATABASE or OFF_DATABASE`);
    if (name === "roundRobinCandidates") {
      // #3489: judged from the walk's ladder read, so nothing of its own is read.
      if ((args[6] as { inputs?: unknown } | undefined)?.inputs !== undefined) return { latencyMs: 0, queries: 0 };
      const bucket = args[0] as { code: string };
      // #3489: a read narrowed to the one advisor the line handed (`narrowTo`) reads one
      // member, priced as the run measured a rung with one advisor free.
      const narrowed = (args[6] as { narrowTo?: string } | undefined)?.narrowTo !== undefined;
      const free = narrowed ? 1 : freeOnRung(bucket.code, args[2] as number);
      const kind = free === 0 ? "noneFree" : free === 1 ? "oneFree" : "manyFree";
      return { latencyMs: db.candidateReadMs[kind], queries: db.candidateReadRequests[kind], depth: db.candidateReadDepth[kind] };
    }
    const latencyMs = db.callMs[name] ?? db.meanStatementMs;
    const depth = db.depth?.[name];
    return { latencyMs, queries: db.requests?.[name] ?? statementsFor(latencyMs), ...(depth !== undefined ? { depth } : {}) };
  };
}

/** One confirm's arrival, measured: `[route start, line start, read the switch (1/0)]`,
 *  in ms from the burst's moment. */
export type Arrival = readonly [handlerMs: number, lineStartMs: number, readsSwitch: 0 | 1];

/** A rung of a burst's ladder: who the cache shows free, and how many are busy. */
export interface BurstRung {
  free: readonly string[];
  busy: readonly string[];
}

/** One burst of load run 37640583621, as the model replays it and as the run answered it. */
export interface BurstShape {
  label: string;
  /** The code every confirm asks for. The run split its crowd over two sibling codes
   *  (500/501, 220/221) that the pool grouping keyed onto ONE ladder line (every confirm
   *  "from the snapshot"); one code on one line is that line. */
  code: string;
  /** The ladder's rungs, top first, with who is free and who is busy on each. */
  rungs: Readonly<Record<string, BurstRung>>;
  arrivals: readonly Arrival[];
  /**
   * Isolates the crowd landed on: the most confirms carrying one invocation index (an
   * isolate's confirms carry distinct indexes, so this is a lower bound). Only the per
   * isolate line, the commit cost log and the first answer's deferred stamp read it.
   */
  isolates: number;
  /** Whether the run's sync lane was running through the burst, from the tail's cron
   *  lines (`lane timings`, `sync_ms`). */
  syncLaneRunning: boolean;
  /**
   * When the line object first answered, from the first message: the first leader's turn
   * less the earliest line start (2977 - 1543, 1303 - 157, 676 - 227). A fresh object
   * (burst 2's ladder had never been used) or the first burst of the run is slow.
   */
  firstAnswerMs: number;
  /** What the run answered, from the deployment's own answer stamps (ms from the
   *  burst's moment) and each booking's `rungs_dropped`. */
  measured: {
    booked: readonly { atMs: number; rungsDropped: number }[];
    others: { outcome: "SLOT_TAKEN" | "503"; count: number; firstMs: number; p50Ms: number; maxMs: number };
  };
}

/** The sixteen advisors on the 500 ladder (`stage_counts` 500:6, 400:14, 300:16, 200:14). */
const R = Array.from({ length: 16 }, (_, i) => `r${i}`);
/** Burst 2's advisors: one free on 220, 23 on 230 (`ladderFree` 24), and busy ones. */
const S = Array.from({ length: 44 }, (_, i) => `s${i}`);
/** Every advisor any burst names, for the harness's user fixture. */
export const LOAD_MODEL_ADVISORS: readonly string[] = [...R, ...S];

export const ladder500 = (free: readonly string[]): Record<string, BurstRung> => {
  const rung = (members: string[]): BurstRung => ({ free: members.filter((id) => free.includes(id)), busy: members.filter((id) => !free.includes(id)) });
  return {
    "500": rung(R.slice(0, 6)),
    "400": rung(R.slice(2)),
    "300": rung(R),
    "200": rung(R.slice(2)),
  };
};

/**
 * The three bursts. Arrivals are every confirm's own `[route start, line start]` from its
 * answer line (`response_ms` back from the answer stamp, plus `wait_auth_ms`), sorted by
 * route start; the switch flag is 1 when its calls carried a Supabase call outside any
 * chain (the switch read) or carried no call list at all (a fast leader, unknown, so the
 * side that adds load). Burst 1's tail matched 99 of its 100 confirms; the hundredth is a
 * copy of the median follower's row.
 */
export const RUN_37640583621: readonly BurstShape[] = [
  {
    label: "burst 1, refusal control (one free on the ladder)",
    code: "500",
    rungs: ladder500(["r0"]),
    isolates: 41,
    // The sync lane started 20.6s before this burst and ran 62.7s.
    syncLaneRunning: true,
    firstAnswerMs: 1_434,
    arrivals: [
      [60, 1978, 1], [78, 1973, 1], [99, 2718, 1], [120, 2720, 0], [134, 2437, 0], [467, 1934, 1], [504, 1932, 1], [508, 2398, 1],
      [513, 2060, 1], [536, 1913, 1], [568, 1914, 1], [575, 2055, 1], [588, 1917, 1], [606, 1913, 1], [636, 2387, 1], [643, 1906, 1],
      [647, 1912, 1], [651, 2677, 1], [658, 2671, 1], [680, 2671, 1], [680, 2673, 1], [681, 2000, 1], [683, 2658, 1], [686, 1851, 1],
      [691, 2374, 1], [692, 2101, 0], [696, 2379, 1], [697, 2092, 0], [705, 1960, 1], [719, 2372, 1], [724, 1861, 1], [729, 2365, 1],
      [734, 2370, 1], [740, 1989, 1], [767, 1906, 1], [775, 2635, 1], [776, 2106, 0], [780, 2095, 0], [784, 2111, 0], [788, 2632, 1],
      [823, 2666, 1], [849, 1890, 1], [853, 1953, 1], [861, 2324, 1], [886, 1990, 0], [891, 2720, 0], [896, 2716, 0], [919, 1991, 0],
      [924, 2436, 0], [924, 2436, 0], [928, 2007, 0], [929, 2440, 0], [934, 2009, 0], [936, 2438, 0], [968, 2107, 0], [1004, 2727, 0],
      [1011, 2711, 0], [1016, 1989, 0], [1038, 2721, 0], [1043, 2717, 0], [1047, 1783, 1], [1047, 2442, 0], [1051, 2005, 0], [1056, 2719, 0],
      [1059, 1993, 0], [1061, 2440, 0], [1062, 2437, 0], [1083, 2105, 0], [1089, 2724, 0], [1093, 1543, 1], [1096, 1800, 1], [1096, 2727, 0],
      [1101, 1993, 0], [1102, 2240, 1], [1102, 2731, 0], [1108, 2729, 0], [1112, 1612, 1], [1112, 2723, 0], [1114, 2437, 0], [1180, 1835, 1],
      [1211, 2103, 1], [1255, 2436, 0], [1262, 2446, 0], [1266, 2448, 0], [1268, 2716, 0], [1275, 1992, 0], [1277, 2440, 0], [1279, 2005, 0],
      [1318, 2122, 0], [1562, 2440, 0], [1571, 1987, 0], [1577, 2715, 0], [1581, 2448, 0], [1590, 2719, 0], [1645, 2112, 0], [1654, 2123, 0],
      [1660, 2089, 0], [1797, 2120, 0], [1810, 2087, 0], [1818, 2116, 1],
    ],
    measured: {
      booked: [{ atMs: 6_241, rungsDropped: 0 }],
      others: { outcome: "SLOT_TAKEN", count: 99, firstMs: 9_676, p50Ms: 9_809, maxMs: 9_870 },
    },
  },
  {
    label: "burst 2, tier drop (one free on the top rung, 23 below)",
    code: "220",
    rungs: {
      "220": { free: ["s0"], busy: S.slice(24, 33) },
      "230": { free: S.slice(1, 24), busy: S.slice(33, 43) },
      "210": { free: [], busy: S.slice(24, 34) },
      "120": { free: [], busy: S.slice(34, 44) },
      "130": { free: [], busy: S.slice(28, 38) },
      "110": { free: [], busy: S.slice(30, 40) },
    },
    isolates: 3,
    // The lanes that ticked 20.5s before this burst had finished (sync 1.3s, recompute
    // 14.4s, the five minute lanes 11.1s) before it began.
    syncLaneRunning: false,
    firstAnswerMs: 1_146,
    arrivals: [
      [38, 157, 1], [40, 161, 1], [41, 166, 1], [75, 205, 1], [83, 204, 1], [99, 230, 1], [100, 245, 1], [109, 237, 1],
      [111, 250, 1], [122, 248, 1], [126, 237, 1], [720, 889, 1],
    ],
    measured: {
      booked: [
        { atMs: 3_847, rungsDropped: 0 },
        { atMs: 7_518, rungsDropped: 1 },
        { atMs: 9_533, rungsDropped: 1 },
        { atMs: 12_161, rungsDropped: 1 },
      ],
      others: { outcome: "503", count: 8, firstMs: 10_084, p50Ms: 10_514, maxMs: 11_123 },
    },
  },
  {
    label: "burst 3, refusal control (two free on the top rung, two below)",
    code: "500",
    rungs: ladder500(["r0", "r1", "r6", "r7"]),
    isolates: 30,
    // The sync lane started 20.7s before this burst and ran 75.7s.
    syncLaneRunning: true,
    firstAnswerMs: 449,
    arrivals: [
      [40, 228, 1], [52, 234, 1], [53, 229, 1], [55, 244, 1], [58, 238, 1], [59, 252, 1], [60, 241, 1], [61, 239, 1],
      [62, 232, 1], [62, 238, 1], [64, 227, 0], [64, 231, 1], [66, 248, 1], [67, 232, 1], [67, 234, 1], [67, 251, 1],
      [69, 240, 1], [69, 253, 1], [70, 246, 1], [72, 237, 0], [72, 239, 1], [72, 246, 1], [73, 240, 1], [74, 234, 1],
      [75, 244, 1], [76, 227, 0], [76, 244, 1], [77, 249, 0], [79, 241, 0], [80, 250, 0], [82, 243, 1], [82, 259, 0],
      [83, 243, 1], [83, 245, 0], [84, 236, 1], [85, 250, 0], [85, 277, 1], [87, 258, 1], [89, 256, 1], [90, 249, 0],
      [90, 252, 1], [92, 261, 1], [95, 262, 0], [96, 245, 0], [96, 259, 0], [97, 249, 1], [97, 262, 0], [99, 255, 0],
      [101, 259, 0], [103, 252, 1], [108, 278, 0], [108, 280, 1], [111, 276, 1], [112, 280, 0], [113, 285, 1], [114, 259, 0],
      [115, 271, 0], [117, 274, 1], [123, 257, 0], [127, 283, 0], [134, 286, 0], [143, 293, 0], [154, 283, 0], [479, 635, 1],
      [510, 678, 1], [516, 678, 1], [543, 648, 1], [578, 776, 1], [654, 829, 1], [656, 849, 1], [658, 840, 1], [669, 832, 1],
      [675, 896, 1], [676, 824, 1], [677, 851, 1], [693, 859, 1], [695, 825, 0], [697, 867, 1], [698, 843, 1], [709, 870, 1],
      [713, 1059, 1], [748, 1010, 1], [760, 925, 1], [776, 945, 1], [780, 1037, 1], [783, 952, 1], [809, 1093, 1], [816, 991, 1],
      [934, 1159, 1], [999, 1222, 1], [1013, 1197, 1], [1019, 1235, 1], [1065, 1202, 0], [1070, 1669, 0], [1075, 1206, 0], [1076, 1239, 0],
      [1165, 1597, 1], [1179, 1335, 0], [1185, 1316, 0], [1268, 1443, 1],
    ],
    measured: {
      booked: [
        { atMs: 5_730, rungsDropped: 0 },
        { atMs: 6_867, rungsDropped: 0 },
      ],
      others: { outcome: "503", count: 98, firstMs: 10_066, p50Ms: 10_550, maxMs: 13_870 },
    },
  },
];
