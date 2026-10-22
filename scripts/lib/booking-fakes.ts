// Shared in-memory fakes + fixtures for the booking orchestration suites (#605).
//
// Extracted verbatim from the old 3,229-line scripts/test-booking-orchestration.ts
// so the create / reschedule / cancel / reassign / api suites share ONE fake of
// BookingDeps instead of drifting copies. Not named test-*.ts on purpose: the
// runner (scripts/run-tests.ts) only globs scripts/test-*.ts, so this file is a
// library, never a suite.
import {
  type BookingDeps,
  type BookingContext,
  type ReschedulePin,
  type AbandonedReschedulePin,
  type AbandonedReassignIntent,
  type CreateBookingInput,
  type PendingEventDeletion,
  type CreateEventArgs,
} from "../../src/lib/booking/orchestration.ts";
import type { WorkingRule, BusinessHoursRules } from "../../src/lib/availability/compute.ts";
import type { RecordRoutingDecisionInput } from "../../src/lib/routing/record.ts";
import type {
  Booking,
  Bucket,
  EventType,
  User,
  BookingReservation,
  OwnerAlertEvent,
  RoutingTrace,
  Attributes,
  Criteria,
} from "../../src/lib/db/types.ts";
import { deterministicEventId, EventGone, eventDescription } from "../../src/lib/booking/core.ts";
import type { PersonIdentity, PersonWorld } from "../../src/lib/booking/person-dedupe.ts";
import { GoogleHttpError } from "../../src/lib/google/http-error.ts";
import type { OwnerAlertEventBody } from "../../src/lib/booking/owner-alert.ts";
import type { BookingEventPayload } from "../../src/lib/webhooks/types.ts";
import { makeConfirmQueue, isolateLine } from "../../src/lib/booking/confirm-queue.ts";
import { makeCommitCostLog } from "../../src/lib/booking/commit-cost.ts";
import { commitFreshModel, type CommitFreshParts } from "./commit-fresh-model.ts";
import { assert as harnessAssert, finish as harnessFinish } from "./harness.ts";

/**
 * The shared harness's own `assert` and `finish` (`./harness.ts`), so a booking suite
 * keeps every rule the harness carries, its guard against a suite that stops before
 * `finish()` (#3520) included. This was a second copy of the counter and summary, which
 * is how the guard would have reached one copy and not the other.
 */
export function createAsserter() {
  return { assert: harnessAssert, finish: () => harnessFinish() };
}
// `is_test: false` as the column really is (NOT NULL, default false, #396): the
// person gate reads the world off it (#2660), so a fixture missing the field would
// ask in a world that is neither.
export const bucket = { id: "bkt1", org_id: "org1", code: "411", is_test: false, criteria: {} } as unknown as Bucket;
export const eventType = {
  id: "et1",
  name: "Senior Loan Advisor Call",
  regal_type: "call",
  description: "desc",
  duration_min: 30,
  buffer_before_min: 0,
  buffer_after_min: 0,
  min_notice_min: 0,
  daily_cap: null,
} as unknown as EventType;
export const users: Record<string, User> = {
  a: { id: "a", name: "Agent A", email: "a@x.com" } as unknown as User,
  b: { id: "b", name: "Agent B", email: "b@x.com" } as unknown as User,
  c: { id: "c", name: "Agent C", email: "c@x.com" } as unknown as User,
  d: { id: "d", name: "Agent D", email: "d@x.com" } as unknown as User,
  e: { id: "e", name: "Agent E", email: "e@x.com" } as unknown as User,
};

export const input: CreateBookingInput = {
  bucketCode: "411",
  startIso: "2026-06-08T13:00:00.000Z",
  timezone: "America/New_York",
  salesforceId: "sf1",
  attendee: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
  prefill: { xbc: "411" },
};

export function makeBooking(over: Partial<Booking>): Booking {
  return {
    id: "bk1",
    org_id: "org1",
    bucket_id: "bkt1",
    event_type_id: "et1",
    assigned_user_id: "a",
    agent_name: "Agent A",
    agent_email: "a@x.com",
    starts_at: "2026-06-08T13:00:00.000Z",
    ends_at: "2026-06-08T13:30:00.000Z",
    timezone: "America/New_York",
    status: "confirmed",
    gcal_event_id: "gcal-old",
    reschedule_seq: 0,
    manage_token: "tok1",
    salesforce_id: "sf1",
    attendee_name: "Kris",
    attendee_first_name: null,
    attendee_email: "k@x.com",
    attendee_phone: "+12035615295",
    prefill: {},
    ...over,
  } as unknown as Booking;
}

export interface FakeOpts {
  candidates?: string[];
  /** #1300: the bucket's POOL size, when it differs from the free list. Setting
   *  candidates: [] with memberCount > 0 is "people exist, nobody is free now",
   *  which must never page as a misconfigured bucket. */
  memberCount?: number;
  freeEmails?: Set<string>;
  /** Override the bucket's event type, e.g. to give it a buffer between calls. */
  eventType?: EventType;
  /** #1295: override the org's opening hours (defaults to open all week). */
  businessHours?: BusinessHoursRules;
  /** #1295: model an unreadable stored week, which must THROW rather than serve. */
  businessHoursReadFails?: boolean;
  // #884: when set, the deps carry a send scheduler (as a user-facing request
  // does), so fire() records the emission as deferred. Cron drains leave it unset.
  deferSend?: (work: () => Promise<void>) => void;
  insertBookingFails?: boolean;
  insertBookingConflict?: boolean;
  /** #2281: the overlap guard refuses the insert only for these assigned agents,
   *  so a test can model one advisor losing the race while another is free. */
  insertBookingConflictFor?: Set<string>;
  /** #2281: per rung candidate lists. When set, resolveBucketByCode answers a
   *  bucket carrying the code asked for, and roundRobinCandidates reads the list
   *  for that code (empty when absent), so a test can tell rungs apart. */
  candidatesByCode?: Record<string, string[]>;
  /** #3338: a rung's own bucket id and event type, by code, so a booking made on
   *  a lower rung can be told apart from one on the requested rung by the bucket,
   *  the event type and the call's length it carries. Needs `candidatesByCode`. */
  rungBuckets?: Record<string, { id: string; eventType?: EventType }>;
  existingByKey?: Booking | null; // idempotency hit on the pre-check
  /** #3847: the drain's any status lookup by key throws. */
  latestByKeyFails?: boolean;
  conflictWinner?: Booking | null; // booking found by key AFTER an insert conflict
  reservation?: BookingReservation | null; // loadReservationByKey (re-submit resume)
  reservationWinner?: BookingReservation; // insertReservation returns this (race adopt)
  drainableReservations?: BookingReservation[]; // the create-reservation drain
  existing?: BookingContext | null;
  bookingById?: BookingContext | null; // loadBookingById (reassign)
  agentByEmail?: User | null; // getAgentByEmail (reassign)
  pastDue?: BookingContext[];
  // Successive completion-sweep batches for the drain loop (#871): each call to
  // loadPastBookingIdsToComplete returns the next batch (empty once exhausted),
  // modelling the DB query returning fewer rows as batches flip to completed.
  pastDueBatches?: BookingContext[][];
  // A reschedule lease already held for the booking (#439): models a concurrent
  // holder. `target` = the instant it's reaching for (same as the request ->
  // idempotent no-op; different -> conflict); `expired` = a crashed holder.
  heldLease?: { target: string; expired?: boolean; pin?: ReschedulePin };
  abandonedPins?: AbandonedReschedulePin[]; // for the GC sweep (#476)
  abandonedReassignIntents?: AbandonedReassignIntent[]; // reassign-intent sweep (#518)
  alreadyCompleted?: Set<string>; // ids an overlapping tick already transitioned
  unverifiedEmails?: Set<string>; // emails verify-on-book couldn't check (outage)
  personBookings?: Booking[]; // findActiveBookingsForPerson result (#357)
  /** #2638: what Salesforce holds as each lead's XBC__c. A key absent from the
   *  table is a lead Salesforce did not return. */
  leadXbc?: Record<string, string | null>;
  /** #2638: the Salesforce read fails, which must refuse rather than route. */
  leadXbcThrows?: boolean;
  /** #3246: each submission id's Lead id (null: a submission naming no lead). */
  submissionLead?: Record<string, string | null>;
  /** #1334: the calling number Salesforce holds for any lead (default none). */
  callingNumber?: string | null;
  /** #1334: the calling number read fails. */
  callingNumberThrows?: boolean;
  /** #1334: the calling number read never answers; the deadline then fires at once. */
  callingNumberHangs?: boolean;
  /** #1334: what the booking's invite says now (null: the event is gone). */
  inviteDescription?: string | null;
  /** #1334: the invite cannot be read. */
  inviteReadThrows?: boolean;
  /**
   * findActiveBookingsForPerson throws, which is what a failed bookings read now
   * does (#1641). The booker path fails CLOSED on it: the second booking is
   * refused rather than created, because the only backstop the old fail-open
   * relied on reads the same table through the same query.
   */
  personBookingsThrows?: boolean;
  /** loadAgentDisplayName result, keyed by user id (#1337 / #1338). Absent id
   *  resolves to null, which is how an unresolvable advisor must present. */
  agentNames?: Record<string, string>;
  /** loadAgentDisplayName throws (must degrade to no name, never a placeholder). */
  agentNameThrows?: boolean;
  unknownBucket?: boolean; // resolveBucketByCode returns null (#358)
  testBucket?: boolean; // resolveBucketByCode returns an is_test bucket (#396)
  listResult?: { rows: Booking[]; buckets: Bucket[] }; // queryBookings result (#392)
  deleteEventThrows?: boolean;
  deleteGcalMirrorThrows?: boolean; // deleteGcalMirrorBlock rejects (best-effort heal, #586)
  pending?: PendingEventDeletion[]; // loadPendingEventDeletions result (#401)
  reassignSwapTerminal?: boolean; // reassign_booking_swap returns updated=false (#449)
  reassignSwapThrows?: boolean; // reassign_booking_swap rejects (rpc/network error) (#449)
  /** #3249: the bucket aware swap refuses a reroute with this word. */
  reassignSwapRefused?: string;
  // Per-agent calendar busy intervals the single-agent free check sees (#523):
  // models a reschedule overlapping the booking's OWN still-present event.
  busyByEmail?: Map<string, { start: string; end: string }[]>;
  // Per-agent working hours the in-place reschedule guard reads (#527). Keyed by
  // userId; absent agents fall back to the default Mon-Fri 09:00-17:00 NY shift.
  workingHoursByUser?: Map<string, { timezone: string; rules: WorkingRule[] }>;
  // Per-agent other-bookings the daily-cap guard counts (#536). Keyed by userId;
  // ISO start instants of the agent's OTHER confirmed bookings on the target day.
  agentDayBookings?: Map<string, string[]>;
  // Emails whose live calendar read fails (#536): busyIntervalsForAgent returns
  // null, so the in-place guard re-routes (matches the old isFree failure path).
  busyReadFailEmails?: Set<string>;
  // #615: fired ONCE from inside the Google call (updateEventTime / createEvent),
  // i.e. the race window between reading the booking and committing, to mutate the
  // in-memory row as a concurrent cancel or reassign would. The gated commit then
  // sees the changed row and must roll back instead of winning.
  concurrentBeforeCommit?: (booking: Booking) => void;
  // #617: the in-place PATCH hits a deleted event, updateEventTime raises
  // EventGone so the reschedule recreates the event instead of committing a
  // phantom move.
  updateEventTimeGone?: boolean;
  /** #1341: the invite body PATCH fails, so the row is correct and the advisor's
   *  copy is stale. A different outcome from the row write failing. */
  updateEventDescriptionThrows?: boolean;
  /** #1341: the phone write itself fails, which must never read as saved. */
  updateBookingPhoneThrows?: boolean;
  /** #1512: enqueueing a webhook's deliveries fails, as `emitWebhook` throws on a refused enqueue. */
  emitWebhookThrows?: boolean;
  // #480: a concurrent different-target holder re-pins the lease at the exact
  // instant Guard-1 runs its commit-then-crash cleanup delete. Fired at the
  // ENTRY of the cleanup-delete method, modelling the documented read->delete
  // micro-race: an unconditional delete clobbers this fresh lease; the atomic
  // target-conditional delete leaves it untouched.
  repinAtCleanup?: { toTarget: string; pin: ReschedulePin };
  // --- #2371 owner alert ---------------------------------------------------
  /** Rows already in owner_alert_events when the run starts. */
  ownerAlerts?: OwnerAlertEvent[];
  /**
   * How the calendar write fails. `gone` and `not-provisioned` are the two
   * DEFINITIVE kinds (`isDefinitiveFailure`), modelled as the real Google statuses
   * and reasons so the classifier under test does the classifying, not the fake.
   */
  ownerAlertCreateFails?: OwnerAlertFailure | null;
  /** The same, for the delete on a removal path. */
  ownerAlertDeleteFails?: OwnerAlertFailure | null;
  /** The move raises EventGone: the advisor deleted the alert themselves. */
  ownerAlertMoveGone?: boolean;
  /**
   * Events Google ALREADY holds, keyed by the deterministic client id's SEED
   * (`owner-alert:<outbox row id>:<user id>`, the string deterministicEventId
   * hashes). That is how a resume meets a 409 and adopts the existing event: the
   * fake cannot know the hash, and hard coding one would pin the hash rather than
   * the behaviour.
   */
  existingCalendarEvents?: Record<string, string>;
  // --- #2372 owner reassign notice ------------------------------------------
  /**
   * `monitor_alert_config.handoff_channel`. Defaults to a channel being SET,
   * because that is the live state and the interesting cases are the two ways it
   * is not: `null` is nobody having set one, `handoffChannelThrows` is the read
   * failing, and the step treats those differently.
   */
  handoffChannel?: string | null;
  /** The channel setting read fails, which is not the same as it being unset. */
  handoffChannelThrows?: boolean;
  /** The owner reassign notice switch (migration 0188). Defaults to ON, so the
   *  suites about what a posted notice says keep posting one. */
  ownerNoticeOn?: boolean;
  /** The switch read fails, which is neither on nor off. */
  ownerNoticeOnThrows?: boolean;
  /** Slack's own `error` on the post, or null for a post that lands. */
  handoffNoticePostFails?: string | null;
  /** Each advisor's own zone, keyed by user id. Absent means Slate holds none. */
  advisorTimezones?: Record<string, string>;
  /** The schedule read fails, so the step must retry rather than say less. */
  advisorTimezoneThrows?: boolean;
  /** #2838: the race bound hit dispatcher throws synchronously when handed a page. */
  raceBoundPageThrows?: boolean;
  /** #3272: every advisor in the bucket's pool, free or not (default: the candidates). */
  poolAgents?: string[];
  /**
   * #3272: the pool's criteria and each advisor's attributes, so a suite can drive
   * criteria matching and the requested tier. Absent, every advisor named is a manual
   * member and only availability decides considered against excluded.
   */
  poolCriteria?: { criteria: Record<string, unknown>; attributes: Record<string, Record<string, unknown>> };
}

/** The three ways a calendar write fails, as the fakes model them. */
export type OwnerAlertFailure = "gone" | "not-provisioned" | "transient";

/** A Google error of the shape the real classifier reads (status plus reason). */
function googleFailure(kind: OwnerAlertFailure): Error {
  if (kind === "not-provisioned") {
    return new GoogleHttpError("events.insert failed: 403", 403, "notACalendarUser");
  }
  if (kind === "gone") return new GoogleHttpError("events.insert failed: 404", 404, "notFound");
  return new GoogleHttpError("events.insert failed: 503", 503, "backendError");
}

// Default fake working hours: Mon-Fri 09:00-17:00 America/New_York. Covers every
// existing in-place reschedule target so the #527 guard is a no-op for them; the
// #527 tests override it per-agent to model an off-shift / on-shift new time.
export const DEFAULT_WORKING_HOURS: { timezone: string; rules: WorkingRule[] } = {
  timezone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
};

/**
 * Default fake ORG hours (#1295, gate 1): open every day, all day. Deliberately
 * PERMISSIVE so every pre-existing test keeps asserting whatever it was written to
 * assert, rather than silently starting to fail on the org's clock. The gate's own
 * behaviour is pinned in `scripts/test-business-hours-gate.ts`, and the tests that
 * care override this via `opts.businessHours`.
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    start_minute: 0,
    end_minute: 1440,
  })),
  // #1363: no date exceptions. Stated rather than omitted, because the field is
  // required precisely so a fixture cannot silently skip the date gate.
  exceptions: [],
};

export function makeDeps(opts: FakeOpts) {
  // Cursor into opts.pastDueBatches for the completion drain loop (#871).
  let pastBatchIdx = 0;
  const calls = {
    loadPastBookingIdsToComplete: 0,
    busyIntervalsForAgent: [] as string[],
    agentActiveBookingStartsMs: [] as { userId: string; excludeBookingId: string }[],
    agentWorkingHours: [] as string[],
    businessHours: 0,
    verifyFree: [] as string[][],
    /** #3338: the window each live check asked about, beside `verifyFree`. */
    verifyFreeWindows: [] as { fromIso: string; toIso: string }[],
    /** #3495: the advisor ids each wave was handed beside its emails (email to id), if any. */
    verifyFreeIds: [] as (Record<string, string> | null)[],
    /** `args` is what the invite was written WITH (#3376: its title and location). */
    createEvent: [] as { email: string; clientId?: string; args: CreateEventArgs }[],
    /**
     * Every booking row the run tried to WRITE (#1641). `createEvent` is the
     * proxy a lead would notice, but a booking row is the thing "a second
     * booking was created" actually means, and the two are written in separate
     * steps, so a test that asserts only the invite cannot tell a suppressed
     * write from a suppressed invite.
     */
    insertBooking: [] as Record<string, unknown>[],
    /** #2638: every lead id Salesforce was asked about, and every code resolved. */
    readLeadXbc: [] as string[],
    /** #3246: every submission id Salesforce was asked about. */
    readSubmissionLead: [] as string[],
    /** #1334: every lead the calling number was read for. */
    readCallingNumber: [] as (string | null)[],
    /** #1334: deadline timers started and cleared around that read. */
    deadlineTimers: { set: 0, cleared: 0 },
    resolveBucketByCode: [] as string[],
    deleteEvent: [] as { id: string }[],
    enqueueEventDeletion: [] as { email: string; eventId: string; bookingId: string | null }[],
    /** The times each PATCH asked for, so a test can tell a move from a put back (#3924). */
    updateEventTime: [] as { id: string; start?: string; end?: string }[],
    /** #3924: every invite the abandoned pin sweep read, and every pin it took over or freed. */
    readEventOnPrimary: [] as string[],
    takeOverAbandonedPin: [] as string[],
    releaseAbandonedPin: [] as string[],
    updateEventDescription: [] as { email: string; id: string; description: string }[],
    updateBookingPhone: [] as { bookingId: string; phone: string }[],
    updateEventContact: [] as {
      email: string;
      id: string;
      patch: { summary?: string; description?: string; location?: string; attendeeEmail?: string; attendeeName?: string };
    }[],
    updateBookingContact: [] as {
      bookingId: string;
      patch: { attendee_name?: string; attendee_email?: string; attendee_phone?: string };
    }[],
    insertBusyBlock: [] as { user_id: string; starts_at: string; ends_at: string; source: string }[],
    /** #762: how many batched WRITES the sweep issued, not how many rows it wrote. */
    insertBusyBlocks: 0,
    moveBusyBlock: [] as { userId: string; startIso: string; endIso: string; bookingId: string }[],
    deleteBusyBlocks: [] as string[],
    deleteGcalMirror: [] as { userId: string; gcalEventId: string }[],
    commitReschedule: [] as {
      id: string;
      patch: Record<string, unknown>;
      guard: { assignedUserId: string | null; gcalEventId: string | null };
      /** #3265: the outbox work the commit was handed, written in the same transaction. */
      outbox?: { steps: unknown; payload: unknown };
    }[],
    /** #3265: the reschedule outbox work a commit recorded, by booking and ordinal. */
    rescheduleOutbox: [] as { bookingId: string; seq: unknown }[],
    /** #3265: outbox rows written by a SEPARATE enqueue, after the fact. */
    enqueuedOutbox: [] as { booking_id: string | null; action: string }[],
    claimCancellation: [] as string[],
    completeBookingsIfDue: [] as string[][],
    reservations: [] as { idempotency_key: string; pinned_user_id: string; gcal_client_id: string }[],
    deletedReservations: [] as string[],
    latestByKeyLookups: [] as string[],
    reservationBumps: [] as { id: string; attempts: number; lastError: string }[],
    reassignSwaps: [] as {
      bookingId: string;
      userId: string;
      gcalEventId: string;
      gcalClientId: string;
      prevGcal: string | null;
      /** #3249: the reroute a bucket aware swap carried, if any. */
      reroute?: unknown;
    }[],
    webhooks: [] as {
      event: string;
      reason: unknown;
      dedupeKey: string | null;
      bucket_code: string | undefined;
      suppressed: boolean;
      // #884: whether fire() handed this emission a send scheduler (deps.deferSend).
      // true on user-facing paths (confirm/cancel/reschedule), false on cron drains.
      deferred: boolean;
      /** Who the payload is about (#2164). */
      attendee: BookingEventPayload["attendee"];
      /**
       * The advisor a reassign moved the booking AWAY from (#2368). Recorded
       * because it can only come off the outbox row: the booking the notify step
       * reads already holds the new advisor, so a test that only looked at the
       * event name could not tell a payload naming the right person from one
       * naming nobody.
       */
      previousAgentEmail: string | null | undefined;
      /** #2073: whether the booking was routed or booked through a named link. */
      bookingKind: string | undefined;
      /** #2073: the routing summary the payload carries; null when nothing was routed. */
      routing: unknown;
      /** #1512: the number a phone correction replaced. */
      previousPhone: string | null | undefined;
    }[],
    bookingEvents: [] as {
      booking_id: string;
      action: string;
      initiator: string;
      reason_code: string;
      reason_detail: string | null;
      from_starts_at: string | null;
      to_starts_at: string | null;
      to_agent_user_id: string | null;
      lead_time_minutes: number | null;
      reschedule_seq: number | null;
    }[],
    // #538: each loadBookingContext call's opts, so a test can assert the
    // reschedule path folds the working-hours read in (withWorkingHours) rather
    // than issuing a separate agentWorkingHours round-trip.
    loadBookingContext: [] as ({ withWorkingHours?: boolean } | undefined)[],
    claimReschedule: 0,
    releaseReschedule: 0,
    releaseRescheduleIfTarget: 0,
    invalidateSlots: [] as string[],
    // #3324: the booked advisor and window a create hands the splice, one per call,
    // plus the window a reschedule or reassign left (#3334). Undefined for a refresh
    // that carries none (a cancel).
    invalidateSlotsBooked: [] as (Parameters<BookingDeps["invalidateSlots"]>[1])[],
    // #504: every routing decision the orchestration recorded, so a suite can
    // assert the outcome + payload directly instead of via a log line.
    recordRoutingDecision: [] as RecordRoutingDecisionInput[],
    roundRobinPreview: [] as (boolean | undefined)[],
    /** #2073: the one agent each candidate read was narrowed to, undefined for a pool. */
    roundRobinOnly: [] as (string | undefined)[],
    /** Every idempotency key the create path looked up. */
    idempotencyLookups: [] as string[],
    queryBookings: [] as unknown[],
    // #2657: which fetch a path used, and what it asked for. The lookup API asks
    // by strong id against either column; the dedupe path asks by identity, column
    // to column, and a suite can prove neither reached for the other's fetch.
    findActiveBookingsForPerson: [] as PersonIdentity[],
    /** The WORLD each person lookup was asked in (#2660), beside the identity. */
    personWorlds: [] as PersonWorld[],
    findActiveBookingsByStrongIds: [] as string[][],
    removePendingEventDeletion: [] as string[],
    bumpPendingEventDeletion: [] as { id: string; attempts: number }[],
    reassignIntents: [] as { bookingId: string; gcalClientId: string; pinnedAgentEmail: string }[],
    // #759: what the swap stamped onto the intent row INSIDE its own transaction. The
    // real RPC does this in the same statement block as the booking update, so there is
    // no window between the two; the fake records it from inside reassignSwap for the
    // same reason.
    reassignIntentStamps: [] as {
      bookingId: string;
      gcalClientId: string;
      prevAgentEmail: string | null;
      prevGcalEventId: string | null;
      swappedAt: string;
    }[],
    reassignIntentDeletes: [] as { bookingId: string; gcalClientId: string }[],
    // #2371: the in-memory owner_alert_events table, exposed so a suite can read the
    // rows the run left behind rather than inferring them from the calls.
    ownerAlertRows: [] as OwnerAlertEvent[],
    ownerAlertCreates: [] as {
      actorEmail: string;
      calendarId: string;
      clientId: string;
      body: OwnerAlertEventBody;
      eventId: string;
    }[],
    // #2372: every Slack post the owner notice step made, with the channel, so a
    // suite can assert WHERE it landed and not only that something was sent.
    handoffNoticePosts: [] as { channel: string; text: string }[],
    advisorTimezoneReads: [] as string[],
    /** #2838: bound hit pages the confirm path handed to its dispatcher. A fake,
     *  so no suite that drives a refusal at the bound can reach alert_state or Slack. */
    raceBoundHitPages: [] as { key: string; cooldownMs: number; text: string }[],
    ownerAlertDeletes: [] as { actorEmail: string; calendarId: string; eventId: string }[],
    ownerAlertMoves: [] as {
      calendarId: string;
      eventId: string;
      start: string;
      end: string;
      timezone: string;
    }[],
  };
  // #2371 owner_alert_events, as a table the fake mutates in place: the partial
  // unique index is modelled by refusing a second LIVE row for one booking, so a
  // step that tried to write one fails here exactly as Postgres would.
  const ownerAlerts: OwnerAlertEvent[] = (opts.ownerAlerts ?? []).map((r) => ({ ...r }));
  calls.ownerAlertRows = ownerAlerts;
  let ownerAlertSeq = 0;
  let ownerAlertCreateFails: OwnerAlertFailure | null = opts.ownerAlertCreateFails ?? null;
  /** Flip the calendar's behaviour mid-run, so one deps object can model a transient
   *  failure and the drain pass that follows it. */
  const setOwnerAlertCreateFails = (kind: OwnerAlertFailure | null): void => {
    ownerAlertCreateFails = kind;
  };
  // #2372: the same trick for Slack, so one deps object models a refused post and
  // the drain pass that lands it.
  let handoffNoticePostFails: string | null = opts.handoffNoticePostFails ?? null;
  const setHandoffNoticePostFails = (error: string | null): void => {
    handoffNoticePostFails = error;
  };
  // Google's own idempotency: the same deterministic client id resolves to the event
  // it already holds (the 409-as-success reuse), never a second one.
  const ownerAlertEventsByClientId = new Map<string, string>();
  const ownerAlertRow = (id: string): OwnerAlertEvent => {
    const found = ownerAlerts.find((r) => r.id === id);
    if (!found) throw new Error(`owner alert row ${id} does not exist`);
    return found;
  };
  /** Which pre-existing Google event, if any, this hashed client id collides with. */
  const seededEventFor = async (clientId: string): Promise<string | null> => {
    for (const [seed, eventId] of Object.entries(opts.existingCalendarEvents ?? {})) {
      const sep = seed.lastIndexOf(":");
      const hashed = await deterministicEventId(seed.slice(0, sep), seed.slice(sep + 1));
      if (hashed === clientId) return eventId;
    }
    return null;
  };
  let seq = 0;
  let insertAttempted = false;
  // Mirror Google's deterministic-client-id behavior: a repeat insert with the
  // same client id returns the SAME event (409-as-success reuse), not a second.
  const gcalByClientId = new Map<string, string>();
  // In-memory reschedule_locks table for the per-booking lease state machine.
  const RESCHEDULE_TTL = 2 * 60 * 1000;
  // `token` is set only on a row the abandoned pin sweep took over (#3924).
  const locks = new Map<string, { target: string; leaseUntilMs: number; pin: ReschedulePin | null; token?: string }>();
  let sweepClaims = 0;
  // #3924: where Google holds each invite a PATCH has moved. An invite no PATCH has
  // touched is where its booking says, which is what a fresh booking's invite holds.
  const googleEvents = new Map<string, { start: string; end: string }>();
  const bookingNamed = (bookingId: string): Booking | undefined =>
    [opts.existing, opts.bookingById].find((c) => c?.booking?.id === bookingId)?.booking;
  if (opts.heldLease && opts.existing) {
    locks.set(opts.existing.booking.id, {
      target: opts.heldLease.target,
      leaseUntilMs: opts.heldLease.expired ? Date.now() - 1000 : Date.now() + RESCHEDULE_TTL,
      pin: opts.heldLease.pin ?? null,
    });
  }
  // #480: models a concurrent different-target holder re-pinning the lease right
  // as Guard-1's cleanup delete fires (the read->delete micro-race window). Fired
  // ONCE, from the entry of the cleanup-delete method.
  let repinFired = false;
  const fireRepinAtCleanup = (bookingId: string): void => {
    if (repinFired || !opts.repinAtCleanup) return;
    repinFired = true;
    const l = locks.get(bookingId);
    if (l) {
      l.target = opts.repinAtCleanup.toTarget;
      l.pin = opts.repinAtCleanup.pin;
      l.leaseUntilMs = Date.now() + RESCHEDULE_TTL;
    }
  };
  const free = opts.freeEmails ?? new Set(["a@x.com", "b@x.com"]);
  // #615: fire the injected concurrent op ONCE, from inside the Google call that
  // precedes the commit, so the gated commit sees a row a cancel/reassign changed.
  let concurrentFired = false;
  const fireConcurrent = (): void => {
    if (concurrentFired || !opts.concurrentBeforeCommit) return;
    concurrentFired = true;
    const b = opts.existing?.booking;
    if (b) opts.concurrentBeforeCommit(b);
  };
  // #3495: the fake keeps the separate insert, which suites make race, fail or wait,
  // and builds the one save call from it (`commitFreshModel`). Read off `this`, the
  // deps object the call was made on, so a suite that overrides a step, on these
  // deps or on a copy spread from them, is the step the save runs.
  const deps: BookingDeps & CommitFreshParts = {
    commitFreshBooking(this: CommitFreshParts, req) {
      return commitFreshModel(this, req);
    },
    deferSend: opts.deferSend,
    readLeadXbc: async (leadId) => {
      calls.readLeadXbc.push(leadId);
      if (opts.leadXbcThrows) throw new Error("SF query failed: 503 unavailable");
      const table = opts.leadXbc ?? {};
      return Object.prototype.hasOwnProperty.call(table, leadId) ? table[leadId] : undefined;
    },
    readSubmissionLead: async (submissionId) => {
      calls.readSubmissionLead.push(submissionId);
      const table = opts.submissionLead ?? {};
      return Object.prototype.hasOwnProperty.call(table, submissionId) ? table[submissionId] : undefined;
    },
    readCallingNumber: async (leadId) => {
      calls.readCallingNumber.push(leadId);
      if (opts.callingNumberThrows) throw new Error("SF query failed: 503 unavailable");
      if (opts.callingNumberHangs) return new Promise<string | null>(() => {});
      return opts.callingNumber ?? null;
    },
    readEventDescription: async () => {
      if (opts.inviteReadThrows) throw new Error("events.get: 503");
      if (opts.inviteDescription !== undefined) return opts.inviteDescription;
      // By default the invite says what the booking path wrote for the booking.
      const b = opts.existing?.booking;
      return eventDescription(b?.attendee_phone ?? null, `https://slate.test/booking/manage/${b?.manage_token ?? ""}`, {
        isTest: opts.existing?.bucket.is_test ?? false,
      });
    },
    // The deadline expires at once only for a read that hangs, so no other suite
    // races a real answer against it; every timer's clear is counted.
    deadlineTimer: (_ms, fire) => {
      calls.deadlineTimers.set += 1;
      if (opts.callingNumberHangs) queueMicrotask(fire);
      return () => {
        calls.deadlineTimers.cleared += 1;
      };
    },
    resolveBucketByCode: async (code) =>
      (calls.resolveBucketByCode.push(code), opts.unknownBucket)
        ? null
        : {
            bucket: {
              ...(opts.testBucket ? ({ ...bucket, is_test: true } as Bucket) : bucket),
              ...(opts.candidatesByCode ? { code } : {}),
              ...(opts.rungBuckets?.[code] ? { id: opts.rungBuckets[code].id } : {}),
            } as Bucket,
            eventType: opts.rungBuckets?.[code]?.eventType ?? opts.eventType ?? eventType,
          },
    roundRobinCandidates: async (b, _e, _ms, preview, onlyUserId) => {
      calls.roundRobinPreview.push(preview);
      calls.roundRobinOnly.push(onlyUserId);
      // #2073: a named link narrows the read to one agent, so the fake narrows the
      // free list the same way. The pool size is then that agent alone.
      if (onlyUserId !== undefined) {
        const narrowed = (opts.candidates ?? ["a"]).filter((id) => id === onlyUserId);
        return { candidates: narrowed, memberCount: opts.memberCount ?? 1 };
      }
      const candidates = opts.candidatesByCode
        ? (opts.candidatesByCode[b.code] ?? [])
        : (opts.candidates ?? ["a"]);
      // #1300: the pool SIZE, which is what tells an empty bucket (pages) apart
      // from a bucket whose people are simply off shift (must not page). Defaults
      // to the candidate count, and `memberCount` overrides it so a test can say
      // "people exist, none of them is free".
      return { candidates, memberCount: opts.memberCount ?? candidates.length };
    },
    businessHours: async () => {
      calls.businessHours++;
      if (opts.businessHoursReadFails) {
        throw new Error("business hours are unusable: connection reset");
      }
      return opts.businessHours ?? DEFAULT_BUSINESS_HOURS;
    },
    agentWorkingHours: async (userId) => {
      calls.agentWorkingHours.push(userId);
      return opts.workingHoursByUser?.get(userId) ?? DEFAULT_WORKING_HOURS;
    },
    busyIntervalsForAgent: async (email, fromIso, toIso) => {
      calls.busyIntervalsForAgent.push(email);
      if (opts.busyReadFailEmails?.has(email)) return null;
      // Mirror the old isFree fake's hard gate: an email NOT in the free set models
      // a fully-busy calendar across the window. Finer-grained conflicts (own event,
      // buffer cases) come from busyByEmail for emails that ARE free.
      if (!free.has(email)) return [{ start: Date.parse(fromIso), end: Date.parse(toIso) }];
      return (opts.busyByEmail?.get(email) ?? []).map((b) => ({
        start: Date.parse(b.start),
        end: Date.parse(b.end),
      }));
    },
    agentActiveBookingStartsMs: async (userId, _fromIso, _toIso, excludeBookingId) => {
      calls.agentActiveBookingStartsMs.push({ userId, excludeBookingId });
      return (opts.agentDayBookings?.get(userId) ?? []).map((iso) => Date.parse(iso));
    },
    // Batched verify-on-book: one call per round-robin wave; returns the free
    // subset plus any emails that couldn't be checked. Mirrors the real dep.
    verifyFree: async (emails, startIso, endIso, ids) => {
      calls.verifyFree.push(emails);
      calls.verifyFreeWindows.push({ fromIso: startIso, toIso: endIso });
      calls.verifyFreeIds.push(ids ? Object.fromEntries(ids) : null);
      const unverified = opts.unverifiedEmails ?? new Set<string>();
      const s = Date.parse(startIso);
      const e = Date.parse(endIso);
      const busyAt = (email: string) =>
        (opts.busyByEmail?.get(email) ?? []).some(
          (b) => Date.parse(b.start) < e && Date.parse(b.end) > s,
        );
      return {
        free: new Set(emails.filter((em) => free.has(em) && !busyAt(em))),
        unverified: new Set(emails.filter((em) => unverified.has(em))),
      };
    },
    createEvent: async (email, args, clientId) => {
      calls.createEvent.push({ email, clientId, args });
      fireConcurrent(); // #615: a concurrent cancel/reassign lands mid-create
      if (clientId) {
        const reused = gcalByClientId.get(clientId);
        if (reused) return reused;
        const id = `gcal-${++seq}`;
        gcalByClientId.set(clientId, id);
        return id;
      }
      return `gcal-${++seq}`;
    },
    deleteEvent: async (_email, id) => {
      if (opts.deleteEventThrows) throw new Error("google 503");
      calls.deleteEvent.push({ id });
    },
    // --- #2371 owner alert ------------------------------------------------
    createOwnerAlertEvent: async (actorEmail, calendarId, body, clientId) => {
      if (ownerAlertCreateFails) throw googleFailure(ownerAlertCreateFails);
      const eventId =
        ownerAlertEventsByClientId.get(clientId) ??
        (await seededEventFor(clientId)) ??
        `alert-${++ownerAlertSeq}`;
      ownerAlertEventsByClientId.set(clientId, eventId);
      calls.ownerAlertCreates.push({ actorEmail, calendarId, clientId, body, eventId });
      return eventId;
    },
    deleteOwnerAlertEvent: async (actorEmail, calendarId, eventId) => {
      if (opts.ownerAlertDeleteFails) throw googleFailure(opts.ownerAlertDeleteFails);
      calls.ownerAlertDeletes.push({ actorEmail, calendarId, eventId });
    },
    moveOwnerAlertEvent: async (_actorEmail, calendarId, eventId, start, end, timezone) => {
      if (opts.ownerAlertMoveGone) throw new EventGone("events.patch");
      calls.ownerAlertMoves.push({ calendarId, eventId, start, end, timezone });
    },
    loadLiveOwnerAlert: async (bookingId) =>
      ownerAlerts.find((r) => r.booking_id === bookingId && r.removed_at === null) ?? null,
    insertOwnerAlert: async (row) => {
      if (ownerAlerts.some((r) => r.booking_id === row.booking_id && r.removed_at === null)) {
        // What owner_alert_events_one_live_per_booking does in Postgres.
        throw new Error("duplicate key value violates unique constraint");
      }
      const inserted: OwnerAlertEvent = {
        id: `oae-${ownerAlerts.length + 1}`,
        booking_id: row.booking_id,
        user_id: row.user_id,
        calendar_id: row.calendar_id,
        gcal_event_id: null,
        created_at: "2026-06-01T00:00:00.000Z",
        removed_at: null,
        skip_reason: null,
      };
      ownerAlerts.push(inserted);
      return inserted;
    },
    setOwnerAlertEventId: async (id, gcalEventId) => {
      ownerAlertRow(id).gcal_event_id = gcalEventId;
    },
    recordOwnerAlertSkip: async (id, reason) => {
      ownerAlertRow(id).skip_reason = reason;
    },
    // --- #2372 owner reassign notice --------------------------------------
    loadHandoffChannel: async () => {
      if (opts.handoffChannelThrows) throw new Error("handoff channel read failed");
      return opts.handoffChannel === undefined ? "C-SALES" : opts.handoffChannel;
    },
    ownerReassignNoticeOn: async () => {
      if (opts.ownerNoticeOnThrows) throw new Error("owner notice switch read failed");
      return opts.ownerNoticeOn ?? true;
    },
    postHandoffNotice: async (channel, text) => {
      calls.handoffNoticePosts.push({ channel, text });
      // Modelled as postSlack does it: a refusal is an answer, never a throw.
      return handoffNoticePostFails
        ? { ok: false, error: handoffNoticePostFails }
        : { ok: true };
    },
    pageRaceBoundHit: (page) => {
      calls.raceBoundHitPages.push(page);
      if (opts.raceBoundPageThrows) throw new Error("dispatcher refused the page");
    },
    // #3221: a line of this fake's own, so no two suites (or two makeDeps in one
    // suite) ever wait on each other's confirms.
    confirmQueue: isolateLine(makeConfirmQueue()),
    // #3338: a fresh record per suite's deps, so no two share a measurement.
    commitCosts: makeCommitCostLog(),
    advisorTimezone: async (userId) => {
      calls.advisorTimezoneReads.push(userId);
      if (opts.advisorTimezoneThrows) throw new Error("advisor schedule read failed");
      return opts.advisorTimezones?.[userId] ?? null;
    },
    markOwnerAlertRemoved: async (id, skipReason) => {
      const r = ownerAlertRow(id);
      if (r.removed_at !== null) return; // the `is("removed_at", null)` guard
      r.removed_at = "2026-06-02T00:00:00.000Z";
      if (skipReason) r.skip_reason = skipReason;
    },
    enqueueEventDeletion: async (email, eventId, bookingId) => {
      calls.enqueueEventDeletion.push({ email, eventId, bookingId });
    },
    updateEventTime: async (_email, id, start, end) => {
      calls.updateEventTime.push({ id, start, end });
      if (opts.updateEventTimeGone) throw new EventGone("events.patch"); // #617
      googleEvents.set(id, { start, end });
      fireConcurrent(); // #615: a concurrent cancel/reassign lands mid-PATCH
    },
    // #1341: the invite body carries the number the advisor dials, so a phone
    // correction rewrites it. Recorded rather than swallowed, so a test can assert
    // the invite really was refreshed and not merely that the row changed.
    updateEventDescription: async (email, id, description) => {
      calls.updateEventDescription.push({ email, id, description });
      if (opts.updateEventDescriptionThrows) throw new Error("google 503");
    },
    updateEventContact: async (email, id, patch) => {
      calls.updateEventContact.push({ email, id, patch });
      // The same seam the description-only patch uses, since they are one Google
      // call: a test that turns the invite rewrite off must turn off both or the
      // failure path it means to drive is only half reached.
      if (opts.updateEventDescriptionThrows) throw new Error("google 503");
      if (patch.description !== undefined) {
        calls.updateEventDescription.push({ email, id, description: patch.description });
      }
    },
    updateBookingContact: async (bookingId, patch) => {
      if (opts.updateBookingPhoneThrows) throw new Error("db write failed");
      calls.updateBookingContact.push({ bookingId, patch });
      // Recorded on the phone list too when the number moved, so a test written
      // about a phone correction reads the same either way.
      if (patch.attendee_phone !== undefined) {
        calls.updateBookingPhone.push({ bookingId, phone: patch.attendee_phone });
      }
    },
    updateBookingPhone: async (bookingId, phone) => {
      if (opts.updateBookingPhoneThrows) throw new Error("db write failed");
      calls.updateBookingPhone.push({ bookingId, phone });
      const existing = opts.existing;
      // Mirror production: the stored row really changes, so a later read in the
      // same test sees the corrected number rather than the one it started with.
      if (existing && existing.booking.id === bookingId) {
        existing.booking = { ...existing.booking, attendee_phone: phone };
      }
    },
    getUser: async (id) => users[id],
    loadEmails: async (ids) => {
      const m = new Map<string, string>();
      for (const id of ids) {
        const email = users[id]?.email;
        if (email) m.set(id, email);
      }
      return m;
    },
    // Before any insert: idempotency pre-check (existingByKey). After an insert
    // conflict: the key-winner lookup (conflictWinner). Lets one fake model the
    // "nobody yet → race → winner found" sequence.
    //
    // ACTIVE bookings only, as the real read is (`activeBookingByIdempotencyKey`):
    // a cancelled or completed booking on the key is not a replay (#3847).
    findBookingByIdempotencyKey: async (key) => {
      calls.idempotencyLookups.push(key);
      const found = (insertAttempted ? opts.conflictWinner : opts.existingByKey) ?? null;
      return found && (found.status === "confirmed" || found.status === "rescheduled") ? found : null;
    },
    // #3847: the drain's resume asks for the newest booking on the key in ANY status,
    // so a booking cancelled or completed since it committed settles the reservation
    // rather than being made again. Throws when `latestByKeyFails` is set.
    findLatestBookingByIdempotencyKey: async (key) => {
      calls.latestByKeyLookups.push(key);
      if (opts.latestByKeyFails) throw new Error("latest booking by idempotency key read failed: statement timeout");
      return (insertAttempted ? opts.conflictWinner : opts.existingByKey) ?? null;
    },
    // The read back's throwing read: the same answer here, through the probe, so a
    // suite that makes the probe fail or answer differently drives both (#3495).
    readBookingByIdempotencyKey(key) {
      return this.findBookingByIdempotencyKey(key);
    },
    insertBooking: async (row) => {
      insertAttempted = true;
      calls.insertBooking.push(row as unknown as Record<string, unknown>);
      if (opts.insertBookingConflict) return { ok: false, conflict: true };
      if (opts.insertBookingConflictFor?.has(String(row.assigned_user_id))) {
        return { ok: false, conflict: true };
      }
      if (opts.insertBookingFails) return { ok: false, conflict: false, error: new Error("insert failed") };
      return { ok: true, booking: { ...row, id: "bk-new" } as unknown as Booking };
    },
    insertBusyBlocks: async (blocks) => {
      calls.insertBusyBlocks++;
      for (const b of blocks) calls.insertBusyBlock.push(b);
    },
    moveBusyBlock: async (userId, startIso, endIso, bookingId) => {
      calls.moveBusyBlock.push({ userId, startIso, endIso, bookingId });
    },
    reassignSwap: async ({
      bookingId,
      userId,
      agentName,
      agentEmail,
      gcalEventId,
      gcalClientId,
      routingTrace,
      reroute,
    }) => {
      if (opts.reassignSwapThrows) throw new Error("rpc down");
      if (reroute && opts.reassignSwapRefused) {
        return { prevGcalEventId: null, prevAgentEmail: null, updated: false, refused: opts.reassignSwapRefused as never };
      }
      const ctx = [opts.bookingById, opts.existing].find((c) => c?.booking?.id === bookingId);
      const prev = ctx?.booking;
      // Model a concurrent cancellation between load and swap, or a terminal row.
      if (!prev || opts.reassignSwapTerminal || prev.status === "cancelled" || prev.status === "completed") {
        return { prevGcalEventId: null, prevAgentEmail: null, updated: false };
      }
      const prevGcal = prev.gcal_event_id ?? null;
      const prevEmail = prev.agent_email ?? null;
      calls.reassignSwaps.push({ bookingId, userId, gcalEventId, gcalClientId, prevGcal, ...(reroute ? { reroute } : {}) });
      // #759: the RPC stamps the intent in the SAME transaction as the booking update,
      // so the fake records it here rather than in a separate dep the caller invokes
      // afterwards. A crash cannot land between the two.
      calls.reassignIntentStamps.push({
        bookingId,
        gcalClientId,
        prevAgentEmail: prevEmail,
        prevGcalEventId: prevGcal,
        swappedAt: new Date().toISOString(),
      });
      // Faithful stand-in for the fixed RPC (#519): seed from the ROW's current
      // trace (falling back to the caller base only when the row has none), derive
      // the record from the row (from = current agent under the lock, to = target),
      // and append server-side so concurrent reassigns accumulate full history.
      const base = (prev.routing_trace ?? routingTrace) as RoutingTrace;
      const record = { from: prev.assigned_user_id ?? null, to: userId, at: new Date().toISOString() };
      const newRoutingTrace: RoutingTrace = {
        ...base,
        reassignments: [...(base.reassignments ?? []), record],
      };
      // Persist so the outbox handlers re-reading after the swap see the new agent.
      Object.assign(prev, {
        assigned_user_id: userId,
        agent_name: agentName,
        agent_email: agentEmail,
        gcal_event_id: gcalEventId,
        // No status write, as in the real RPC (#2617).
        allow_double_book: true,
        routing_trace: newRoutingTrace,
      });
      return { prevGcalEventId: prevGcal, prevAgentEmail: prevEmail, updated: true };
    },
    deleteBusyBlocksForBooking: async (id) => {
      calls.deleteBusyBlocks.push(id);
    },
    deleteGcalMirrorBlock: async (userId, gcalEventId) => {
      calls.deleteGcalMirror.push({ userId, gcalEventId });
      if (opts.deleteGcalMirrorThrows) throw new Error("busy_blocks delete 503");
    },
    // Gated reschedule commit (#615). Gates against the LIVE pre-commit row
    // (loadBookingContext's `existing`): a concurrent cancel (status) or reassign
    // (assignee + event id) that changed it since we read makes this touch 0 rows.
    // On success mirrors production by persisting the patch so a later
    // loadBookingById (outbox re-read) sees the committed booking.
    commitReschedule: async (id, patch, guard, outbox) => {
      calls.commitReschedule.push({ id, patch: patch as Record<string, unknown>, guard, outbox });
      const live =
        opts.existing?.booking?.id === id
          ? opts.existing.booking
          : [opts.bookingById].find((c) => c?.booking?.id === id)?.booking;
      if (!live) return null;
      const active = live.status === "confirmed" || live.status === "rescheduled";
      const assigneeOk = (live.assigned_user_id ?? null) === guard.assignedUserId;
      const gcalOk = (live.gcal_event_id ?? null) === guard.gcalEventId;
      if (!(active && assigneeOk && gcalOk)) return null;
      for (const c of [opts.bookingById, opts.existing]) {
        if (c?.booking && c.booking.id === id) Object.assign(c.booking, patch);
      }
      // #3265: the outbox work is written in the same transaction as the move.
      calls.rescheduleOutbox.push({ bookingId: id, seq: (patch as Record<string, unknown>).reschedule_seq });
      return `ob-commit-${calls.rescheduleOutbox.length}`;
    },
    // Atomic cancel claim (#413): the FIRST call for an id wins (flips
    // active->cancelled), every later call loses, models the conditional UPDATE.
    // Also models the status guard (#618): the UPDATE gates on the row still
    // being confirmed/rescheduled, so a completed/cancelled row touches 0 rows.
    claimCancellation: (() => {
      const claimed = new Set<string>();
      return async (id: string) => {
        calls.claimCancellation.push(id);
        const live = [opts.existing, opts.bookingById].find((c) => c?.booking?.id === id)?.booking;
        const active = live ? live.status === "confirmed" || live.status === "rescheduled" : true;
        if (!active) return false;
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      };
    })(),
    completeBookingsIfDue: async (ids) => {
      calls.completeBookingsIfDue.push(ids);
      // Return only the ids this tick flips; an id in `alreadyCompleted` models
      // a row an overlapping tick already transitioned, so it's excluded.
      return ids.filter((id) => !(opts.alreadyCompleted?.has(id) ?? false));
    },
    // Per-booking reschedule lease state machine (#439), mirroring service.ts so
    // the crash tests exercise the real resume/conflict/abandon logic.
    claimReschedule: async (bookingId, target) => {
      calls.claimReschedule++;
      const now = Date.now();
      const existing = locks.get(bookingId);
      if (!existing) {
        locks.set(bookingId, { target, leaseUntilMs: now + RESCHEDULE_TTL, pin: null });
        return { outcome: "won" };
      }
      const bkStarts =
        opts.existing?.booking.id === bookingId ? opts.existing.booking.starts_at : undefined;
      if (bkStarts && Date.parse(bkStarts) === Date.parse(target)) return { outcome: "idempotent" };
      const expired = existing.leaseUntilMs <= now;
      const sameTarget = Date.parse(existing.target) === Date.parse(target);
      if (!expired) return sameTarget ? { outcome: "idempotent" } : { outcome: "conflict" };
      existing.leaseUntilMs = now + RESCHEDULE_TTL; // take over the crashed lease
      if (!existing.pin) return { outcome: "won" };
      return sameTarget
        ? { outcome: "resume", pin: existing.pin }
        : { outcome: "fresh-after-abandon", pin: existing.pin };
    },
    writeReschedulePin: async (bookingId, pin) => {
      const l = locks.get(bookingId);
      if (l) {
        l.pin = pin;
        l.target = pin.target_starts_at;
      } else {
        locks.set(bookingId, { target: pin.target_starts_at, leaseUntilMs: Date.now() + RESCHEDULE_TTL, pin });
      }
    },
    readReschedulePin: async (bookingId) => locks.get(bookingId)?.pin ?? null,
    releaseReschedule: async (bookingId) => {
      calls.releaseReschedule++;
      fireRepinAtCleanup(bookingId);
      locks.delete(bookingId);
    },
    releaseRescheduleIfTarget: async (bookingId, target) => {
      calls.releaseRescheduleIfTarget++;
      fireRepinAtCleanup(bookingId);
      const l = locks.get(bookingId);
      if (l && Date.parse(l.target) === Date.parse(target)) locks.delete(bookingId);
    },
    // Rows handed in by a suite, or (#3924) the fake table's own pinned rows past
    // their lease plus the grace, joined to the booking as the real loader joins it.
    loadAbandonedReschedulePins: async (graceMs) => {
      if (opts.abandonedPins) return opts.abandonedPins;
      const cutoff = Date.now() - graceMs;
      const rows: AbandonedReschedulePin[] = [];
      for (const [bookingId, l] of locks) {
        if (!l.pin || l.leaseUntilMs >= cutoff) continue;
        const b = bookingNamed(bookingId);
        rows.push({
          booking_id: bookingId,
          pinned_agent_email: l.pin.pinned_agent_email,
          gcal_client_id: l.pin.gcal_client_id,
          branch: l.pin.branch,
          booking_gcal_event_id: b?.gcal_event_id ?? null,
          target_starts_at: l.target,
          booking_starts_at: b?.starts_at ?? null,
        });
      }
      return rows;
    },
    // #3924: the compare and swap the real seam makes. A row a suite handed in
    // (`abandonedPins`) has no row in the fake table, so it is taken as it stands.
    takeOverAbandonedReschedulePin: async (pin, graceMs) => {
      calls.takeOverAbandonedPin.push(pin.booking_id);
      const l = locks.get(pin.booking_id);
      const token = `sweep-${++sweepClaims}`;
      if (!l) return opts.abandonedPins ? token : null;
      if (l.pin?.gcal_client_id !== pin.gcal_client_id || l.leaseUntilMs >= Date.now() - graceMs) return null;
      l.leaseUntilMs = Date.now() + RESCHEDULE_TTL;
      if (pin.booking_starts_at) l.target = pin.booking_starts_at;
      l.token = token;
      return token;
    },
    releaseAbandonedReschedulePin: async (bookingId, token) => {
      calls.releaseAbandonedPin.push(bookingId);
      if (locks.get(bookingId)?.token === token) locks.delete(bookingId);
    },
    readBookingInviteState: async (bookingId) => {
      const b = bookingNamed(bookingId);
      return b
        ? {
            status: b.status,
            starts_at: b.starts_at,
            ends_at: b.ends_at,
            gcal_event_id: b.gcal_event_id,
            agent_email: b.agent_email,
            timezone: b.timezone,
          }
        : null;
    },
    readEventOnPrimary: async (_email, id) => {
      calls.readEventOnPrimary.push(id);
      const held =
        googleEvents.get(id) ??
        [opts.existing, opts.bookingById]
          .map((c) => c?.booking)
          .filter((b): b is Booking => b?.gcal_event_id === id)
          .map((b) => ({ start: b.starts_at, end: b.ends_at }))[0];
      return held
        ? { id, status: "confirmed", start: { dateTime: held.start }, end: { dateTime: held.end }, updated: `${id}@${held.start}` }
        : null;
    },
    // #518 reassign-intent state. writeReassignIntent is an idempotent UPSERT on
    // (booking_id, gcal_client_id): a same-target retry (identical deterministic
    // id) must NOT create a second row or throw, so #449's idempotent retry holds.
    writeReassignIntent: async ({ bookingId, gcalClientId, pinnedAgentEmail }) => {
      const existing = calls.reassignIntents.find(
        (r) => r.bookingId === bookingId && r.gcalClientId === gcalClientId,
      );
      if (!existing) calls.reassignIntents.push({ bookingId, gcalClientId, pinnedAgentEmail });
    },
    deleteReassignIntent: async (bookingId, gcalClientId) => {
      calls.reassignIntentDeletes.push({ bookingId, gcalClientId });
    },
    loadAbandonedReassignIntents: async () => opts.abandonedReassignIntents ?? [],
    insertBookingEvent: async (row) => {
      calls.bookingEvents.push(row);
      return `evt-${calls.bookingEvents.length}`;
    },
    hasBookingEvent: async (bookingId, action, toStartsIso, rescheduleSeq) =>
      calls.bookingEvents.some(
        (e) =>
          e.booking_id === bookingId &&
          e.action === action &&
          e.to_starts_at === toStartsIso &&
          (rescheduleSeq == null || e.reschedule_seq === rescheduleSeq),
      ),
    loadBookingContext: async (_token: string, ctxOpts?: { withWorkingHours?: boolean }) => {
      calls.loadBookingContext.push(ctxOpts);
      const existing = opts.existing;
      if (!existing) return null;
      // #538: when the reschedule path opts in, the WH read is folded into the
      // context load (mirrors realDeps), so the in-place guard consults
      // ctx.agentWorkingHours instead of a separate agentWorkingHours call.
      if (ctxOpts?.withWorkingHours && existing.booking.assigned_user_id) {
        const wh =
          opts.workingHoursByUser?.get(existing.booking.assigned_user_id) ?? DEFAULT_WORKING_HOURS;
        return { ...existing, agentWorkingHours: wh };
      }
      return existing;
    },
    // The outbox cancel handlers re-load by id; fall back to the same context
    // loadBookingContext returns so the inline run has the booking to act on.
    loadBookingById: async () => opts.bookingById ?? opts.existing ?? null,
    getBookingEventId: async (bookingId, action, toStartsIso, rescheduleSeq) => {
      const e = calls.bookingEvents.findIndex(
        (ev) =>
          ev.booking_id === bookingId &&
          ev.action === action &&
          ev.to_starts_at === toStartsIso &&
          (rescheduleSeq == null || ev.reschedule_seq === rescheduleSeq),
      );
      return e === -1 ? null : `evt-${e + 1}`;
    },
    enqueueOutbox: async (row) => {
      calls.enqueuedOutbox.push({ booking_id: row.booking_id ?? null, action: row.action });
      return "ob-test";
    },
    // #1048: the lease is a token, and the writes it guards report whether they
    // landed. "written" is the healthy answer; the stand-down paths are driven in
    // scripts/test-booking-outbox.ts.
    leaseOutbox: async () => "lease-tok",
    releaseOutboxLease: async () => {},
    saveOutboxSteps: async () => "written" as const,
    markOutboxDelivered: async () => "written" as const,
    insertReservation: async (row) => {
      calls.reservations.push({
        idempotency_key: row.idempotency_key,
        pinned_user_id: row.pinned_user_id,
        gcal_client_id: row.gcal_client_id,
      });
      // No winner -> this call's reservation is authoritative (override via
      // opts.reservationWinner to model a same-key race adopting the winner).
      return (
        opts.reservationWinner ?? {
          id: "resv-1",
          idempotency_key: row.idempotency_key,
          pinned_user_id: row.pinned_user_id,
          pinned_agent_email: row.pinned_agent_email,
          gcal_client_id: row.gcal_client_id,
          payload: row.payload,
          status: "pending" as const,
          lease_until: null,
          attempts: 0,
          last_error: null,
          created_at: "",
          updated_at: "",
        }
      );
    },
    loadReservationByKey: async () => opts.reservation ?? null,
    deleteReservation: async (id) => {
      calls.deletedReservations.push(id);
      return "deleted" as const;
    },
    repinReservationEvent: async () => {},
    loadDrainableReservations: async () => opts.drainableReservations ?? [],
    leaseReservation: async () => "lease-1",
    releaseReservationLease: async () => {},
    bumpReservationAttempt: async (id: string, attempts: number, lastError: string) => {
      calls.reservationBumps.push({ id, attempts, lastError });
    },
    deleteExpiredReservations: async () => ({ deleted: 0, owed: [] }),
    findActiveBookingsForPerson: async (identity, world) => {
      calls.findActiveBookingsForPerson.push(identity);
      calls.personWorlds.push(world);
      if (opts.personBookingsThrows) throw new Error("bookings read down");
      return opts.personBookings ?? [];
    },
    // #3257: who already holds an instant, from the same fixture bookings.
    findActiveBookingsStartingAt: async (startIso: string) =>
      (opts.personBookings ?? []).filter((b) => Date.parse(b.starts_at) === Date.parse(startIso)),
    // Hands back the same candidate pile UNFILTERED, so a suite proves the lookup
    // judges what it was given rather than trusting the fetch (#2657).
    findActiveBookingsByStrongIds: async (ids) => {
      calls.findActiveBookingsByStrongIds.push([...ids]);
      if (opts.personBookingsThrows) throw new Error("bookings read down");
      // Each row carries its world (#2660): the fixture's bucket is the test
      // bucket exactly when `testBucket` is set.
      return (opts.personBookings ?? []).map((b) => ({ ...b, isTest: opts.testBucket === true }));
    },
    loadAgentDisplayName: async (userId: string | null) => {
      if (opts.agentNameThrows) throw new Error("users read down");
      return (userId && opts.agentNames?.[userId]) || null;
    },
    queryBookings: async (filter) => {
      calls.queryBookings.push(filter);
      return opts.listResult ?? { rows: [], buckets: [] };
    },
    getAgentByEmail: async () => opts.agentByEmail ?? null,
    loadPastBookingIdsToComplete: async () => {
      // Drain loop (#871): hand back one batch per call when batches are given,
      // else the single static list. `calls.loadPastBookingIdsToComplete` counts
      // invocations so a test can prove the loop stopped (didn't re-fetch).
      calls.loadPastBookingIdsToComplete += 1;
      if (opts.pastDueBatches) {
        return (opts.pastDueBatches[pastBatchIdx++] ?? []).map((c) => c.booking.id);
      }
      return (opts.pastDue ?? []).map((c) => c.booking.id);
    },
    emitWebhook: async (_orgId, event, payload, dedupeKey, suppressed = false, deferSend) => {
      if (opts.emitWebhookThrows) throw new Error("webhook enqueue failed: fake refusal");
      calls.webhooks.push({
        event,
        reason: payload.reason,
        dedupeKey,
        bucket_code: payload.bucket_code,
        suppressed,
        deferred: typeof deferSend === "function",
        // #2164: who the payload is ABOUT, not only which event it is. A move that
        // carries a lead's corrected details is only carried downstream if the
        // payload holds them, and a fake that dropped the attendee could not tell
        // a payload built before the correction from one built after it.
        attendee: payload.attendee,
        previousAgentEmail: payload.previous_agent_email,
        bookingKind: (payload as { booking_kind?: string }).booking_kind,
        routing: (payload as { routing?: unknown }).routing,
        previousPhone: payload.previous_attendee_phone,
      });
    },
    newManageToken: () => "tok-fixed",
    // #3495: the id the save is made with, which the fake's insert has always answered.
    newBookingId: () => "bk-new",
    newIdempotencyKey: () => "anon-fixed", // synthetic key for keyless bookings (#666)
    appBaseUrl: () => "https://slate.test",
    invalidateSlots: async (bucketCode, booked) => {
      calls.invalidateSlots.push(bucketCode);
      calls.invalidateSlotsBooked.push(booked);
    },
    recordRoutingDecision: async (input) => {
      calls.recordRoutingDecision.push(input);
    },
    // #3272: the bucket's raw pool for the routing decision's considered and
    // excluded lists. Every advisor the bucket holds, free or not: `poolAgents`
    // when a suite names them, else the candidates.
    resolveBucketPool: async () => {
      const ids = opts.poolAgents ?? opts.candidates ?? ["a"];
      const pc = opts.poolCriteria;
      if (pc) {
        return {
          orgAgents: ids.map((id) => ({ id, attributes: (pc.attributes[id] ?? {}) as Attributes })),
          manualMemberIds: new Set<string>(),
          criteria: pc.criteria as Criteria,
        };
      }
      return {
        orgAgents: ids.map((id) => ({ id, attributes: {} })),
        // Every advisor named is a manual member, so each is eligible and only
        // availability decides considered against excluded, which is what is pinned.
        manualMemberIds: new Set(ids),
        criteria: {},
      };
    },
    // #827: no divergence measure in the fake by default; a test that exercises
    // it can override deps.displayedTier after building the deps.
    displayedTier: async () => null,
    loadPendingEventDeletions: async (_limit) => opts.pending ?? [],
    // #1630: the rest of a refused calendar's queue, from the same fixture rows.
    loadPendingEventDeletionsForCalendar: async (email, limit) =>
      (opts.pending ?? []).filter((r) => r.calendar_email === email).slice(0, limit),
    // #1630: nobody owns a refused calendar, and no booking moved, unless a suite
    // says so; an unknown owner keeps today's page.
    loadCalendarOwners: async () => [],
    loadBookingAssignees: async () => [],
    // #3215: nobody holds a queued event unless a suite says so.
    liveBookingHoldingEvent: async () => null,
    pendingWritePinsEvent: async () => false,
    removePendingEventDeletion: async (id) => { calls.removePendingEventDeletion.push(id); },
    bumpPendingEventDeletion: async (id, attempts) => { calls.bumpPendingEventDeletion.push({ id, attempts }); },
  };
  // Test helper: expire a booking's reschedule lease so the next claim treats the
  // holder as crashed (resume / fresh-after-abandon), per #471's crash scenarios.
  const expireLease = (bookingId: string): void => {
    const l = locks.get(bookingId);
    if (l) l.leaseUntilMs = Date.now() - 1000;
  };
  // Test helper: peek at a booking's in-memory reschedule lease (or undefined if
  // released), so a test can assert whether a cleanup delete clobbered it (#480).
  const getLease = (
    bookingId: string,
  ): { target: string; leaseUntilMs: number; pin: ReschedulePin | null; token?: string } | undefined =>
    locks.get(bookingId);
  return { deps, calls, expireLease, getLease, googleEvents, setOwnerAlertCreateFails, setHandoffNoticePostFails };
}

// Validated reasons for the changed reschedule/cancel/reassign signatures.
export const RR = { code: "schedule_conflict", detail: null }; // reschedule
// Fixed "now" for reschedule tests: well before the 2026-06-08+ fixture dates, so
// the #536 min-notice guard treats those (future-relative-to-now) slots as valid.
export const NOW = Date.parse("2026-06-01T00:00:00.000Z");
export const CR = { code: "no_longer_interested", detail: null }; // cancel
export const SYS = { code: "owner_reassignment", detail: null }; // reassign (system)

