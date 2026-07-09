// Relative (not "@/") for the VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { toE164 } from "../phone.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  isUnderDailyCap,
  isWithinWorkingHours,
  type SlotRules,
  type WorkingRule,
  type UnbookableReason,
} from "../availability/compute.ts";
import {
  bookingWindow,
  busyBlockFor,
  bookingEventFrom,
  deterministicEventId,
  EventGone,
  eventDescription,
  idempotencyKeyFor,
  selectAgent,
  type AssignResult,
  type BusyBlockInsert,
  type BookingActor,
  type BookingEventInsert,
  type ValidatedReason,
  type VerifyResult,
} from "./core.ts";
import {
  findPersonMatch,
  decidePersonBooking,
  bookingBelongsToPerson,
  type PersonIdentity,
} from "./person-dedupe.ts";
import { encodeCursor, type ListQuery } from "./api-request.ts";
import { webhookDedupeKey } from "../webhooks/dedupe.ts";
import { runOutboxSteps, type OutboxHandlers } from "./outbox.ts";
import { DRAIN_ALERT_AFTER } from "./drain-backoff.ts";
import { buildRoutingTraceExtras } from "../routing/explain.ts";
import { resolveBucketPool } from "../availability/service.ts";
import { recordRoutingDecision } from "../routing/record.ts";
import { tierLadder, tierKeyOf } from "../routing/tiers.ts";
import { tierFallbackAlert } from "../routing/tier-alert.ts";
import { sendThrottledAlert } from "../notify/dispatch.ts";
import type { BookingEventPayload, BookingReasonMeta } from "@/lib/webhooks/types";
import { routingMetaFromTrace } from "@/lib/webhooks/types";
import type {
  Booking,
  BookingEventAction,
  BookingEventInitiator,
  BookingInsert,
  BookingStatus,
  BookingOutbox,
  BookingOutboxInsert,
  BookingReservation,
  BookingReservationInsert,
  Bucket,
  BusyBlock,
  EventType,
  OutboxStep,
  PendingEventDeletion,
  ReservationPayload,
  RoutingTrace,
  User,
  WebhookEvent,
} from "@/lib/db/types";

export type { PendingEventDeletion, BookingInsert };

/**
 * Booking orchestration (create / reschedule / cancel / complete), split out
 * from the IO so it's unit-testable. Every side effect — DB, Google Calendar,
 * webhooks, clock/random — is reached through the injected `BookingDeps`, so
 * `scripts/test-booking-orchestration.ts` drives the full flow with in-memory
 * fakes. `service.ts` binds `BookingDeps` to the real Supabase/Google/webhook
 * implementations. This module imports NO IO on purpose.
 */

export class SlotUnavailableError extends Error {
  constructor() {
    super("That time is no longer available. Please pick another slot.");
    this.name = "SlotUnavailableError";
  }
}

/**
 * Thrown when a reschedule loses a CONCURRENT race to a DIFFERENT target time —
 * another in-flight reschedule holds a fresh lease on this booking (#439). The
 * loser is told the booking moved under it instead of silently no-opping, so the
 * actor knows to refresh. Distinct from SlotUnavailableError; both map to 409.
 */
export class RescheduleConflictError extends Error {
  constructor() {
    super("This booking was just changed. Refresh and try again.");
    this.name = "RescheduleConflictError";
  }
}

/**
 * The durable per-booking reschedule pin (#439, migration 0053). Written to the
 * reschedule_locks row BEFORE the Google call, then read back verbatim on a
 * crash-resume so the retry reuses the SAME agent + branch + deterministic event
 * id (never recomputed — recomputing reopens the duplicate/oscillation windows).
 */
export interface ReschedulePin {
  reschedule_seq: number;
  branch: "in_place" | "reassign";
  pinned_user_id: string;
  pinned_agent_email: string;
  gcal_client_id: string;
  target_starts_at: string;
}

/**
 * Outcome of claiming the per-booking reschedule lease (#439). The lease is the
 * single arbiter of concurrency AND crash-resume: `won` = no holder (fresh
 * attempt); `resume`/`fresh-after-abandon` = a crashed holder's expired lease is
 * taken over (adopt the pin); `idempotent`/`noop` = a same-target no-op (the
 * booking already sits at the target or a same-target double-submit); `conflict`
 * = a different-target holder still holds a FRESH lease (throw, don't no-op).
 */
export type RescheduleClaim =
  | { outcome: "won" }
  | { outcome: "resume"; pin: ReschedulePin }
  | { outcome: "fresh-after-abandon"; pin: ReschedulePin }
  | { outcome: "noop" }
  | { outcome: "conflict" }
  | { outcome: "idempotent" };

/** A reschedule lease-pin past its lease (a crashed, never-retried holder), with
 *  the booking's CURRENT event id, for the abandoned-pin GC sweep (#439). */
export interface AbandonedReschedulePin {
  booking_id: string;
  pinned_agent_email: string;
  gcal_client_id: string | null;
  branch: "in_place" | "reassign" | null;
  booking_gcal_event_id: string | null;
}

/**
 * Thrown when a booking fails NOT because every candidate is genuinely busy, but
 * because we couldn't verify any of them (calendar/DB read errors — a likely
 * verify-on-book outage). Distinct from SlotUnavailableError so the caller can
 * alert and return a retryable response instead of a generic "no times" (#319).
 */
export class VerifyUnavailableError extends Error {
  constructor() {
    super("We hit a temporary issue confirming this time. Please try again in a moment.");
    this.name = "VerifyUnavailableError";
  }
}

/**
 * Thrown when a bucket has ZERO eligible agents (an empty/misconfigured pool —
 * e.g. an XBC code the attribute sync hasn't populated), as opposed to every
 * agent being genuinely busy (SlotUnavailableError). Distinct so a machine caller
 * can stop retrying and escalate, instead of treating a config error as a
 * transiently-full slot (#358).
 */
export class NoEligibleAgentsError extends Error {
  /** The bucket that resolved to no eligible agents, for the alert (#327). */
  readonly bucketCode: string | null;
  constructor(bucketCode: string | null = null) {
    super("No advisors are configured for this booking type.");
    this.name = "NoEligibleAgentsError";
    this.bucketCode = bucketCode;
  }
}

export class DailyCapExceededError extends Error {
  readonly agentEmail: string;
  readonly day: string;
  constructor(agentEmail: string, day: string) {
    super(`Agent ${agentEmail} is at their daily cap on ${day}`);
    this.name = "DailyCapExceededError";
    this.agentEmail = agentEmail;
    this.day = day;
  }
}

/** Thrown when the bucket code resolves to no bucket/event type (#358). */
export class UnknownBucketError extends Error {
  constructor() {
    super("Unknown booking bucket");
    this.name = "UnknownBucketError";
  }
}

/** Thrown when a lookup/cancel can't resolve an owned booking by id (#386). */
export class BookingNotFoundError extends Error {
  constructor() {
    super("Booking not found");
    this.name = "BookingNotFoundError";
  }
}

/** Thrown when a customer tries to cancel a booking that's already past its
 *  terminal state (#618): a completed meeting can't be flipped back to
 *  cancelled. Maps to a friendly 4xx, not a 500. */
export class BookingNotCancellableError extends Error {
  constructor() {
    super("This meeting has already taken place, so it can no longer be cancelled.");
    this.name = "BookingNotCancellableError";
  }
}

/** Thrown when a reassign target agent can't be resolved or isn't bookable
 *  (#621). A caller-input problem (bad/stale agent), so 404, never retryable.
 *  Message is preserved verbatim: the admin route's 404 mapping and an
 *  orchestration test still match on it. */
export class AgentNotAvailableError extends Error {
  constructor() {
    super("Agent not found or not bookable");
    this.name = "AgentNotAvailableError";
  }
}

/** Thrown when a booking is (or becomes, concurrently) terminal so it can no
 *  longer be reassigned/changed (#621). A genuine conflict → 409, distinct from
 *  a transient outage so a machine caller stops retrying rather than looping. */
export class BookingNotChangeableError extends Error {
  constructor() {
    super("This booking can no longer be changed");
    this.name = "BookingNotChangeableError";
  }
}

/** Delete a calendar event, and if the delete FAILS, enqueue it for the retry
 *  drain (#401) instead of silently dropping it. Never throws to the caller —
 *  the booking flow proceeds; the queue is the durable net. */
async function deleteEventBestEffort(
  deps: BookingDeps,
  email: string,
  eventId: string,
  bookingId: string | null,
): Promise<void> {
  try {
    await deps.deleteEvent(email, eventId);
  } catch {
    await deps.enqueueEventDeletion(email, eventId, bookingId).catch(() => {});
  }
}

export interface CreateBookingInput {
  bucketCode: string;
  startIso: string;
  timezone: string;
  salesforceId?: string | null;
  attendee: { name?: string; email?: string; phone?: string };
  prefill: Record<string, string>;
  /** Optional caller-supplied key; falls back to a derived bucket+slot+attendee key. */
  idempotencyKey?: string;
  /** External caller's stable per-person id (direct booking API, #357). */
  externalId?: string | null;
  /** Allow booking a synthetic test bucket (#396). Only the key-authed direct
   *  booking API sets this; the public /booking path leaves it falsy, so real
   *  leads can never book a test bucket. */
  allowTestBuckets?: boolean;
}

export interface BookingResult {
  booking: Booking;
  manageUrl: string;
  /**
   * Why the in-place agent was declined and the booking reassigned to another
   * agent (#543). `undefined` = kept in place, no in-place candidate, or a
   * crash-resume (the decline was logged on the original attempt). Observability
   * only; the service layer turns this into a log breadcrumb.
   */
  rescheduleDecline?: RescheduleDeclineReason;
}

/**
 * Why an in-place reschedule could not keep the current agent (#543): the slot
 * rules it failed (`UnbookableReason`) plus `calendar` for a failed live busy
 * read (the agent's calendar was unreadable, so we re-route to be safe).
 */
export type RescheduleDeclineReason = UnbookableReason | "calendar";

/**
 * Observability context attached to a thrown reschedule failure (#543) so the
 * service layer can log WHY the in-place agent was declined before the reroute
 * ultimately found nobody, without the pure layer doing IO. Read with
 * `rescheduleFailureContext`.
 */
export interface RescheduleFailureContext {
  bookingId?: string;
  inPlaceDeclineReason?: RescheduleDeclineReason;
}

function tagRescheduleFailure(err: unknown, ctx: RescheduleFailureContext): void {
  if (err instanceof Error) Object.assign(err, ctx);
}

/** Read the observability context off a reschedule failure (#543); empty if none. */
export function rescheduleFailureContext(err: unknown): RescheduleFailureContext {
  if (!(err instanceof Error)) return {};
  const e = err as Error & RescheduleFailureContext;
  return { bookingId: e.bookingId, inPlaceDeclineReason: e.inPlaceDeclineReason };
}

export interface CreateEventArgs {
  summary: string;
  description?: string;
  start: string;
  end: string;
  timezone: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

/**
 * insertBooking outcome. `conflict` means the active-slot unique index rejected
 * the row (23505) — another booking won the verify-on-book race for this
 * agent+slot; the caller turns it into SlotUnavailableError.
 */
export type InsertBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; conflict: boolean };

export type BookingUpdate = {
  starts_at?: string;
  ends_at?: string;
  assigned_user_id?: string | null;
  agent_name?: string | null;
  agent_email?: string | null;
  status?: Booking["status"];
  gcal_event_id?: string | null;
  allow_double_book?: boolean;
  routing_trace?: RoutingTrace | null;
  reschedule_seq?: number;
};

export interface BookingContext {
  booking: Booking;
  bucket: Bucket;
  eventType: EventType;
}

/** Every side effect the orchestration needs. `service.ts` wires the real ones. */
export interface BookingDeps {
  // availability / routing
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /** `preview` = a dry run (#380): route read-only, skipping the #321 shadow-study
   *  log + the unfair-ordering alert so previews don't pollute real-assignment data. */
  roundRobinCandidates(
    bucket: Bucket,
    eventType: EventType,
    startMs: number,
    preview?: boolean,
  ): Promise<string[]>;
  // google calendar
  /**
   * The agent's working-hours schedule (#527): timezone + shift rules, read from
   * availability_schedules + availability_rules. Used by the in-place reschedule
   * branch to confirm the new time is on-shift before keeping the same agent —
   * `isFree` only proves the calendar is empty, not that the agent is working.
   * A schedule-less agent returns America/New_York + [] (matching the slot-compute
   * default), so the guard treats them as off-shift and re-routes.
   */
  agentWorkingHours(userId: string): Promise<{ timezone: string; rules: WorkingRule[] }>;
  /**
   * Live busy intervals for ONE agent across all their calendars (#536), epoch-ms,
   * over [fromIso, toIso). The in-place reschedule guard reads these so it can run
   * the SAME `isBookableSlotForAgent` predicate the booker does — buffers and all —
   * instead of a bare boolean free check. `null` means the calendar read failed
   * (an alert is raised by the impl); the guard treats that as not-bookable-in-place
   * and re-routes, exactly as the old `isFree` failure path did.
   */
  busyIntervalsForAgent(
    email: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ start: number; end: number }[] | null>;
  /**
   * Active (confirmed/rescheduled) booking start instants for ONE agent in
   * [fromIso, toIso), epoch-ms, EXCLUDING `excludeBookingId` (#536). The in-place
   * reschedule guard loads the agent's other bookings on the target local day to
   * enforce the daily cap — excluding the booking being moved so a same-day nudge
   * isn't counted against its own cap.
   */
  agentActiveBookingStartsMs(
    userId: string,
    fromIso: string,
    toIso: string,
    excludeBookingId: string,
  ): Promise<number[]>;
  /**
   * Batched verify-on-book free check: given a wave of candidate emails, return
   * the subset confirmed free for [startIso, endIso). The real impl reads the
   * whole wave's free/busy in bounded, batched Google calls instead of one
   * serial call per candidate (#167).
   */
  verifyFree(
    emails: string[],
    startIso: string,
    endIso: string,
  ): Promise<VerifyResult>;
  createEvent(email: string, args: CreateEventArgs, clientId?: string): Promise<string>;
  deleteEvent(email: string, eventId: string): Promise<void>;
  /** #401: record a Google event deletion that failed, for the retry drain. */
  enqueueEventDeletion(calendarEmail: string, gcalEventId: string, bookingId: string | null): Promise<void>;
  /** #401: load pending event deletions for the retry drain. */
  loadPendingEventDeletions(limit: number): Promise<PendingEventDeletion[]>;
  /** #401: remove a successfully-deleted pending event deletion row. */
  removePendingEventDeletion(id: string): Promise<void>;
  /** #401: bump the attempt count and record the error for a failed deletion. */
  bumpPendingEventDeletion(id: string, attempts: number, error: string): Promise<void>;
  updateEventTime(email: string, eventId: string, startIso: string, endIso: string, timezone: string): Promise<void>;
  // db
  getUser(userId: string): Promise<User>;
  /** Batched userId -> email resolver for a verify-on-book wave (skips emailless). */
  loadEmails(userIds: string[]): Promise<Map<string, string>>;
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  insertBooking(row: BookingInsert): Promise<InsertBookingResult>;
  insertBusyBlock(block: BusyBlockInsert): Promise<void>;
  /**
   * Atomically move a booking's slate busy_block to a new slot (#429 P3): delete
   * by booking_id + insert, in ONE statement, so a crash between can't leave the
   * slot momentarily free (re-opening the double-book window the reschedule path
   * closed). Used by reschedule/reassign in place of separate delete+insert.
   */
  moveBusyBlock(
    userId: string,
    startIso: string,
    endIso: string,
    bookingId: string,
  ): Promise<void>;
  /**
   * Atomic reassign swap (#449): under a row lock, set the booking to the new
   * agent + event + trace and RETURN the event being replaced (so the caller
   * deletes exactly that, never a stale one) — closing the concurrent-distinct-
   * reassign double-event race with last-write-wins. `updated` is false when the
   * booking is terminal (cancelled/completed), so the caller cleans up the event
   * it optimistically created.
   */
  reassignSwap(args: {
    bookingId: string;
    userId: string;
    agentName: string | null;
    agentEmail: string;
    gcalEventId: string;
    // The base trace, used ONLY to seed the row's trace when it has none yet.
    // When the row has a trace, the swap appends the reassignment record onto the
    // row's own current history server-side under the lock (#519), so this array
    // is NOT the authoritative source of the reassignments list.
    routingTrace: RoutingTrace;
  }): Promise<{
    prevGcalEventId: string | null;
    prevAgentEmail: string | null;
    updated: boolean;
  }>;
  deleteBusyBlocksForBooking(bookingId: string): Promise<void>;
  /**
   * Delete any source=gcal busy_block mirroring this Slate-created event (#586).
   * A push-sync that raced the booking's create (before it committed) could have
   * cached the event as a source=gcal block; once the booking owns the event id,
   * that mirror is a stray duplicate. Keyed by (user_id, gcal_event_id); the
   * booking's own source=slate block has a null gcal_event_id, so it is untouched.
   */
  deleteGcalMirrorBlock(userId: string, gcalEventId: string): Promise<void>;
  /**
   * Reconcile sweep (#428): candidate busy_blocks to check for a stuck slot.
   * The real impl returns only upcoming `slate`-sourced rows (a past block can't
   * block a bookable future slot, and `gcal` mirrors are never freed here), so
   * the scan stays bounded by concurrent future bookings.
   */
  loadReconcilableBusyBlocks(
    limit: number,
  ): Promise<Pick<BusyBlock, "id" | "user_id" | "booking_id" | "source">[]>;
  /** Status of each booking by id (absent from the map = the booking is gone). */
  loadBookingStatuses(bookingIds: string[]): Promise<Map<string, BookingStatus>>;
  /** Delete busy_blocks by id (the reconcile sweep's targeted cleanup). */
  deleteBusyBlocksByIds(ids: string[]): Promise<void>;
  /**
   * Reconcile-missing sweep (#431): active upcoming bookings whose busy_block
   * write-through may have been missed. Returns the agent + window + bucket
   * code needed to re-create the block and recompute the slot.
   */
  loadActiveUpcomingBookings(limit: number): Promise<ActiveUpcomingBooking[]>;
  /**
   * Which of `bookingIds` already have a slate busy_block. The reconcile-missing
   * sweep re-creates a block only for the ids NOT in this set.
   */
  loadBusyBlockBookingIds(bookingIds: string[]): Promise<Set<string>>;
  // --- Outbox (#429 P2): durable intent + idempotent drain ---
  /** Write a durable mutation-intent row; returns its id. */
  enqueueOutbox(row: BookingOutboxInsert): Promise<string>;
  /** Undelivered rows whose lease is free or expired, for the drain. */
  loadDrainableOutbox(limit: number): Promise<BookingOutbox[]>;
  /** Gated claim of one row (set lease_until only if free/expired); true if THIS
   *  call took the lease, so the drain and inline path never double-run a row. */
  leaseOutbox(id: string): Promise<boolean>;
  /** Persist the row's steps array after a transition (whole-array write; the
   *  row is leased during the run so there's no concurrent writer). */
  saveOutboxSteps(id: string, steps: OutboxStep[]): Promise<void>;
  /** Flip the row to delivered once all its steps are done. */
  markOutboxDelivered(id: string): Promise<void>;
  /** Clear the lease so the row is reclaimable (run in a finally). */
  releaseOutboxLease(id: string): Promise<void>;
  /** Record a failed drain pass (#445): bump attempts, store last_error, and set
   *  next_attempt_at to now + exponential backoff so the row isn't re-attempted
   *  until then. */
  bumpOutboxAttempt(id: string, attempts: number, lastError: string): Promise<void>;
  // --- Create reservations (#429 P4): intent-first crash-safe create ---
  /** Insert the reservation, OR — if another create with the same idempotency_key
   *  already won the UNIQUE race — return THAT existing reservation, so the loser
   *  adopts the winner's pinned agent + client id (never creating a 2nd event). */
  insertReservation(row: BookingReservationInsert): Promise<BookingReservation>;
  /** The reservation for an idempotency_key, or null (re-submit resume lookup). */
  loadReservationByKey(idempotencyKey: string): Promise<BookingReservation | null>;
  /** Delete a reservation (delete-on-deliver, once the booking is persisted). */
  deleteReservation(id: string): Promise<void>;
  /** Pending reservations whose lease is free/expired, for the drain. */
  loadDrainableReservations(limit: number): Promise<BookingReservation[]>;
  /** Gated lease claim; true if THIS call took it (drain vs inline guard). */
  leaseReservation(id: string): Promise<boolean>;
  releaseReservationLease(id: string): Promise<void>;
  /** Record a failed reservation-drain pass (#445): bump attempts, store
   *  last_error, set next_attempt_at to now + exponential backoff. */
  bumpReservationAttempt(id: string, attempts: number, lastError: string): Promise<void>;
  /** Retention: delete up to `limit` pending reservations older than the cutoff
   *  (abandoned rows whose booking never completed). */
  deleteExpiredReservations(olderThanIso: string, limit: number): Promise<void>;
  /**
   * Gated reschedule commit (#615). Applies the move ONLY while the booking is
   * still the one we started moving: status still active AND assignee + gcal
   * event id unchanged since we read them. Returns true iff THIS update
   * transitioned the row. A concurrent cancel (flips status) or reassign (swaps
   * assignee + event id) makes it touch 0 rows, so the reschedule can roll back
   * instead of resurrecting a cancelled booking or clobbering the reassign.
   * Same gated-update shape as `claimCancellation` / `completeBookingsIfDue`.
   */
  commitReschedule(
    bookingId: string,
    patch: BookingUpdate,
    guard: { assignedUserId: string | null; gcalEventId: string | null },
  ): Promise<boolean>;
  /**
   * Atomic cancel claim (#413): conditionally flips a booking active->cancelled in
   * one statement, returning true only if THIS call made the transition. A second
   * concurrent cancel that already lost the claim gets false, so the non-idempotent
   * direct API can 404 it and the side effects (gcal delete, history, webhook) fire
   * exactly once. Same gated-update pattern as `completeBookingsIfDue`.
   */
  claimCancellation(bookingId: string): Promise<boolean>;
  /**
   * Batch-flips finished bookings to `completed`, returning the ids THIS call
   * actually transitioned. The update is gated on each row still being in a
   * completable status, so an overlapping cron tick that already completed some
   * of them won't re-fire their booking.completed (#163). One statement for the
   * whole batch instead of a round-trip per booking (#164).
   */
  completeBookingsIfDue(bookingIds: string[]): Promise<string[]>;
  /**
   * Claim the per-booking reschedule lease (#439, migration 0053). One lease per
   * booking: the discriminated outcome tells the caller whether it won a fresh
   * attempt, is resuming a crashed holder's pin, must conflict, or no-ops. See
   * `RescheduleClaim`. Fails CLOSED (throws a retriable error) on an unexpected
   * DB error, so a claim we can't trust never re-opens the concurrent window.
   */
  claimReschedule(bookingId: string, targetStartIso: string): Promise<RescheduleClaim>;
  /** Persist the pin onto the booking's lease row BEFORE the Google call, so a
   *  crash-resume reuses the same agent + branch + deterministic event id. */
  writeReschedulePin(bookingId: string, pin: ReschedulePin): Promise<void>;
  /** Read the current lease pin for a booking, or null. */
  readReschedulePin(bookingId: string): Promise<ReschedulePin | null>;
  /** Release the per-booking lease (keyed on booking_id alone now). */
  releaseReschedule(bookingId: string): Promise<void>;
  /** Lease-pins past `lease_until + graceMs`, each with the booking's live
   *  gcal_event_id, for the abandoned-pin GC sweep (#439). */
  loadAbandonedReschedulePins(graceMs: number): Promise<AbandonedReschedulePin[]>;
  /** Append a reschedule/cancel/reassign history row (#326/#300). */
  /** Append a history row; returns the new row id (or null if the best-effort
   *  insert failed) so the caller can use it as the webhook dedupe key (#436). */
  insertBookingEvent(row: BookingEventInsert): Promise<string | null>;
  /**
   * Whether a history row already exists for this (booking, action, target).
   * Lets the no-op / re-cancel guards record a reason that a partially-failed
   * first attempt never persisted, without double-recording on a true duplicate
   * (#326). `toStartsIso` is null for cancel (one cancel per booking).
   */
  hasBookingEvent(
    bookingId: string,
    action: BookingEventAction,
    toStartsIso: string | null,
    rescheduleSeq?: number | null,
  ): Promise<boolean>;
  /** The id of an existing history row for (booking, action, target), or null.
   *  Lets the idempotent outbox notify step reuse the same webhook dedupe key on
   *  a drain re-run instead of inserting a duplicate history row (#429 P3).
   *  `rescheduleSeq` (#614) further scopes the match to one reschedule generation,
   *  so an oscillation back to a previously-used `toStartsIso` doesn't reuse the
   *  earlier reschedule's row (which would swallow its webhook). Omit for cancel/
   *  reassign, which don't collide on time. */
  getBookingEventId(
    bookingId: string,
    action: BookingEventAction,
    toStartsIso: string | null,
    rescheduleSeq?: number | null,
  ): Promise<string | null>;
  loadBookingContext(token: string): Promise<BookingContext | null>;
  loadBookingById(bookingId: string): Promise<BookingContext | null>;
  /**
   * Active bookings that may belong to this person, for the direct booking API's
   * "one active appointment per person" dedupe (#357). The real impl matches on
   * external_id / salesforce_id / attendee email / attendee phone across active
   * rows; `findPersonMatch` then grades each candidate's confidence.
   */
  findActiveBookingsForPerson(identity: PersonIdentity): Promise<Booking[]>;
  /** #392 list: filtered, ordered, offset-paginated booking page + the buckets
   *  referenced by that page (for bucketCode), resolved in one .in() query. */
  queryBookings(filter: ListFilter): Promise<{ rows: Booking[]; buckets: Bucket[] }>;
  getAgentByEmail(email: string): Promise<User | null>;
  loadPastBookingsToComplete(): Promise<BookingContext[]>;
  // webhooks + misc
  emitWebhook(
    orgId: string,
    event: WebhookEvent,
    payload: BookingEventPayload,
    dedupeKey: string | null,
  ): Promise<void>;
  newManageToken(): string;
  /** A fresh, unique synthetic idempotency key for a keyless (anonymous) booking
   *  (#666), so it still gets the reservation-backed crash-safe create every keyed
   *  booking has. Random per call: there's no stable identity to dedupe on, so it
   *  provides no cross-request collapse (matching the old anonymous behavior), only
   *  the durable net. Distinct, non-colliding shape (e.g. an "anon_"-prefixed token)
   *  so it can never equal a derived bucket|slot|contact key. */
  newIdempotencyKey(): string;
  appBaseUrl(): string;
  /** Best-effort clear of a bucket's cached availability after a booking changes it. */
  invalidateSlots(bucketCode: string): Promise<void>;
}

/** Alert once a queued deletion has failed this many times. */
export const PENDING_DELETION_ALERT_AFTER = 5;

/** Stop retrying a deletion after this many attempts (it stays in the table,
 *  diagnosable via last_error, and already alerted at PENDING_DELETION_ALERT_AFTER). */
export const PENDING_DELETION_GIVE_UP_AT = 50;

/**
 * Drain a batch of the deletion retry queue (#401): re-attempt each delete;
 * remove on success (404/410 already-gone counts as success); on failure bump
 * the attempt count and report rows that crossed the alert threshold. Pure —
 * the caller (sync lane) sends the throttled alert for `stuck`.
 */
export async function processPendingEventDeletions(
  deps: BookingDeps,
  limit: number,
): Promise<{ deleted: number; failed: number; stuck: PendingEventDeletion[] }> {
  const rows = await deps.loadPendingEventDeletions(limit);
  let deleted = 0;
  let failed = 0;
  const stuck: PendingEventDeletion[] = [];
  for (const row of rows) {
    try {
      await deps.deleteEvent(row.calendar_email, row.gcal_event_id);
      await deps.removePendingEventDeletion(row.id);
      deleted++;
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.bumpPendingEventDeletion(row.id, attempts, err instanceof Error ? err.message : String(err));
      failed++;
      if (attempts >= PENDING_DELETION_ALERT_AFTER) stuck.push(row);
    }
  }
  return { deleted, failed, stuck };
}

/** Booking statuses that keep a slot legitimately busy (must NOT be freed).
 *  `rescheduled` moves in place and is still active; `completed` happened. */
const ACTIVE_BUSY_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  "confirmed",
  "rescheduled",
  "completed",
]);

/**
 * Reconcile sweep (#428): a cancel runs its steps sequentially (atomic claim,
 * gcal delete, busy_block delete, ...), so a crash or a swallowed delete BEFORE
 * the busy_block step leaves the slot silently stuck as busy. This frees the
 * stuck rows so the slot self-heals. Pure — the caller (sync lane) does the
 * bounded recompute for `userIds` and the throttled alert for `freed`.
 *
 * SAFETY: only frees `slate`-sourced rows whose booking is cancelled or gone. A
 * `gcal` mirror is NEVER freed (it tracks a real external-calendar event;
 * freeing it would reopen a slot the agent is genuinely busy on, risking a
 * double-book), and an active booking's row is kept.
 */
export async function reconcileCancelledBusyBlocks(
  deps: BookingDeps,
  limit: number,
): Promise<{ freed: number; userIds: string[] }> {
  const rows = await deps.loadReconcilableBusyBlocks(limit);
  const bookingIds = [
    ...new Set(
      rows
        .filter((r) => r.source === "slate" && r.booking_id !== null)
        .map((r) => r.booking_id as string),
    ),
  ];
  const statuses = bookingIds.length
    ? await deps.loadBookingStatuses(bookingIds)
    : new Map<string, BookingStatus>();

  const stuck = rows.filter((r) => {
    if (r.source !== "slate") return false; // never free a gcal mirror
    if (r.booking_id === null) return true; // orphan: no booking owns this slot
    const status = statuses.get(r.booking_id);
    // Missing booking (not in the map) or an explicitly cancelled one is stuck;
    // anything still active stays busy.
    return status === undefined || !ACTIVE_BUSY_STATUSES.has(status);
  });

  if (stuck.length === 0) return { freed: 0, userIds: [] };
  await deps.deleteBusyBlocksByIds(stuck.map((r) => r.id));
  return { freed: stuck.length, userIds: [...new Set(stuck.map((r) => r.user_id))] };
}

/** An active upcoming booking, with everything the reconcile-missing sweep
 *  needs to re-create its busy_block (#431). */
export interface ActiveUpcomingBooking {
  id: string;
  /** The assigned agent (guaranteed non-null by the loader). */
  user_id: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Reconcile-missing sweep (#431): the dangerous counterpart to #428. A missed
 * busy_block write-through INSERT leaves an active booking's slot showing FREE
 * in the embed, so it can be DOUBLE-BOOKED on the Slate side until the next full
 * sync mirrors the Google event. This re-creates the missing slate block for any
 * active upcoming booking that lacks one, then the caller recomputes the buckets.
 *
 * Safety bias: this ONLY ever INSERTS, never deletes. The failure we prevent
 * (missing block -> free slot -> double-book) is far worse than the only
 * downside of over-acting (a duplicate block just keeps the slot busy), so it is
 * safe to run aggressively. A genuinely-missing block is inserted once; the next
 * tick sees the block and skips it, so blocks don't accumulate in steady state.
 *
 * Returns the affected agents (not buckets): a missing block makes the agent
 * look free in EVERY bucket they serve, so the caller recomputes all of each
 * agent's buckets, exactly as the #428 sweep does for freed agents.
 */
export async function reconcileMissingBusyBlocks(
  deps: BookingDeps,
  limit: number,
): Promise<{ recreated: number; bookingIds: string[]; userIds: string[] }> {
  const empty = { recreated: 0, bookingIds: [], userIds: [] };
  const bookings = await deps.loadActiveUpcomingBookings(limit);
  if (bookings.length === 0) return empty;

  const haveBlock = await deps.loadBusyBlockBookingIds(bookings.map((b) => b.id));
  const missing = bookings.filter((b) => !haveBlock.has(b.id));
  if (missing.length === 0) return empty;

  for (const b of missing) {
    await deps.insertBusyBlock(busyBlockFor(b.user_id, b.starts_at, b.ends_at, b.id));
  }
  return {
    recreated: missing.length,
    bookingIds: missing.map((b) => b.id),
    userIds: [...new Set(missing.map((b) => b.user_id))],
  };
}

/**
 * Verify-on-book wave size: how many round-robin candidates to confirm per
 * batched free/busy round-trip. The real verifier reads the whole wave's
 * free/busy in one (or, for multi-calendar agents, a few parallel) Google
 * call(s) and returns the free subset; `selectAgent` returns the first free
 * candidate in round-robin order, only advancing to the next wave if the whole
 * wave is busy. Sized to Google's 20-calendar freeBusy cap so a wave of
 * single-calendar agents is one round-trip (#167).
 */
const VERIFY_WAVE_SIZE = 20;

/**
 * Verify-on-book: confirm round-robin candidates against live Google free/busy
 * in WAVES (one batched check per wave) rather than one serial call each, so a
 * large candidate pool can't chain many slow Google calls onto the lead's
 * confirm tap. First confirmed-free agent in round-robin order wins. Selection
 * core is `selectAgent` (pure/tested); this wires it to DB + Google.
 */
async function assignAgent(
  deps: BookingDeps,
  bucket: Bucket,
  eventType: EventType,
  startIso: string,
  endIso: string,
  preview = false,
): Promise<AssignResult & { candidates: string[] }> {
  const candidates = await deps.roundRobinCandidates(
    bucket,
    eventType,
    Date.parse(startIso),
    preview,
  );

  const { assignment, anyUnverified } = await selectAgent(
    candidates,
    (userIds) => deps.loadEmails(userIds),
    (emails) => deps.verifyFree(emails, startIso, endIso),
    VERIFY_WAVE_SIZE,
  );
  if (!assignment) {
    // Zero candidates means the bucket pool is empty/misconfigured — a different
    // failure (and a different caller action) than a full slot (#358).
    if (candidates.length === 0) throw new NoEligibleAgentsError(bucket.code);
    // No agent was free. If at least one candidate couldn't be VERIFIED (read
    // error / outage), this isn't a genuinely-full slot — surface it distinctly
    // so the caller alerts + lets the lead retry, rather than showing "no times".
    if (anyUnverified) throw new VerifyUnavailableError();
    throw new SlotUnavailableError();
  }
  return { ...assignment, candidates };
}

interface TierAssignResult {
  bucket: Bucket;
  eventType: EventType;
  startIso: string;
  endIso: string;
  userId: string;
  email: string;
  candidates: string[];
  rungsDropped: number;
}

/**
 * Assign for the requested bucket; if that bucket has no agent free for the
 * slot, cascade down the debt-tier ladder and assign in the first lower bucket
 * that can serve it. The server is the authority here — the client never says
 * which tier to use. Cascades only on SlotUnavailable / NoEligibleAgents (the
 * tier is genuinely exhausted), never on VerifyUnavailable (a transient outage),
 * which is rethrown so an outage can't masquerade as a tier-drop.
 */
async function assignAgentWithTierFallback(
  deps: BookingDeps,
  requested: { bucket: Bucket; eventType: EventType },
  startInstantIso: string,
  allowTestBuckets: boolean,
): Promise<TierAssignResult> {
  const ladder = tierLadder(requested.bucket.code);
  let lastErr: unknown = null;
  for (let i = 0; i < ladder.length; i++) {
    const resolved = i === 0 ? requested : await deps.resolveBucketByCode(ladder[i]);
    if (!resolved) continue; // a lower tier with no bucket row: skip
    if (resolved.bucket.is_test && !allowTestBuckets) continue;
    const { startIso, endIso } = bookingWindow(startInstantIso, resolved.eventType.duration_min);
    try {
      const { userId, email, candidates } = await assignAgent(
        deps, resolved.bucket, resolved.eventType, startIso, endIso,
      );
      return {
        bucket: resolved.bucket, eventType: resolved.eventType,
        startIso, endIso, userId, email, candidates, rungsDropped: i,
      };
    } catch (err) {
      if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) {
        lastErr = err; // this tier can't serve the slot; drop a rung
        continue;
      }
      throw err; // VerifyUnavailableError and anything unexpected: do not mask
    }
  }
  throw lastErr ?? new SlotUnavailableError();
}

function webhookPayload(
  deps: BookingDeps,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
  reason: BookingReasonMeta | null,
): BookingEventPayload {
  return {
    booking_id: booking.id,
    salesforce_id: booking.salesforce_id,
    bucket_code: bucket.code,
    event_type: eventType.name,
    event_type_slug: eventType.regal_type,
    event_description: eventType.description,
    status: booking.status,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    timezone: booking.timezone,
    // Read from the booking's agent snapshot, so it works even if the agent
    // was later removed from Slate.
    agent: {
      id: booking.assigned_user_id ?? "",
      name: booking.agent_name,
      email: booking.agent_email ?? "",
    },
    attendee: {
      name: booking.attendee_name,
      email: booking.attendee_email,
      phone: booking.attendee_phone,
    },
    prefill: booking.prefill,
    manage_url: `${deps.appBaseUrl()}/booking/manage/${booking.manage_token}`,
    reason,
    routing: routingMetaFromTrace(booking.routing_trace),
  };
}

/**
 * Emit a booking webhook. `reason` carries the why+who for rescheduled/cancelled
 * and is null for created/completed — passed only at those call sites so the
 * shared builder never pollutes create/complete with empty reason fields.
 */
async function fire(
  deps: BookingDeps,
  event: WebhookEvent,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
  reason: BookingReasonMeta | null = null,
  bookingEventId: string | null = null,
): Promise<void> {
  await deps.emitWebhook(
    booking.org_id,
    event,
    webhookPayload(deps, booking, bucket, eventType, reason),
    webhookDedupeKey(event, { bookingId: booking.id, bookingEventId }),
  );
}

/** The reason meta carried on a rescheduled/cancelled webhook. */
function reasonMeta(
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
): BookingReasonMeta {
  return { code: reason.code, detail: reason.detail, initiator };
}

// --- Outbox step handlers (#429 P3) -----------------------------------------
// Each handler is idempotent and derives everything from the booking id + the
// outbox row's payload, so the inline run and a drain re-run after a crash reach
// the same end state. The registry is shared by the producers (run inline) and
// the /api/cron/outbox drain.

const CANCEL_STEPS = {
  GCAL_DELETE: "cancel:gcal_delete",
  BUSYBLOCK_DELETE: "cancel:busyblock_delete",
  RECOMPUTE: "cancel:recompute",
  NOTIFY: "cancel:notify",
} as const;

/** The ordered steps a cancel must deliver. */
export function cancelOutboxSteps(): OutboxStep[] {
  return [
    { name: CANCEL_STEPS.GCAL_DELETE, state: "pending" },
    { name: CANCEL_STEPS.BUSYBLOCK_DELETE, state: "pending" },
    { name: CANCEL_STEPS.RECOMPUTE, state: "pending" },
    { name: CANCEL_STEPS.NOTIFY, state: "pending" },
  ];
}

const RESCHEDULE_STEPS = {
  BUSYBLOCK_MOVE: "reschedule:busyblock_move",
  RECOMPUTE: "reschedule:recompute",
  NOTIFY: "reschedule:notify",
} as const;

/** The ordered POST-commit steps a reschedule must deliver. The agent decision
 *  + gcal create/update stay inline (the create-idempotency is P4, #439); the
 *  outbox covers the slot move, recompute, and the rescheduled webhook. */
export function rescheduleOutboxSteps(): OutboxStep[] {
  return [
    { name: RESCHEDULE_STEPS.BUSYBLOCK_MOVE, state: "pending" },
    { name: RESCHEDULE_STEPS.RECOMPUTE, state: "pending" },
    { name: RESCHEDULE_STEPS.NOTIFY, state: "pending" },
  ];
}

const REASSIGN_STEPS = {
  BUSYBLOCK_MOVE: "reassign:busyblock_move",
  RECOMPUTE: "reassign:recompute",
  NOTIFY: "reassign:notify",
} as const;

/** Post-commit steps for a contact-owner reassign (#9). Like reschedule, the
 *  gcal delete-old + create-new stays inline (create-idempotency is P4); the
 *  outbox covers the slot move, recompute, and the booking.rescheduled webhook. */
export function reassignOutboxSteps(): OutboxStep[] {
  return [
    { name: REASSIGN_STEPS.BUSYBLOCK_MOVE, state: "pending" },
    { name: REASSIGN_STEPS.RECOMPUTE, state: "pending" },
    { name: REASSIGN_STEPS.NOTIFY, state: "pending" },
  ];
}

export const OUTBOX_HANDLERS: OutboxHandlers = {
  [CANCEL_STEPS.GCAL_DELETE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return; // booking gone -> nothing to delete
    const { booking } = ctx;
    if (booking.agent_email && booking.gcal_event_id) {
      await deleteEventBestEffort(deps, booking.agent_email, booking.gcal_event_id, booking.id);
    }
  },
  [CANCEL_STEPS.BUSYBLOCK_DELETE]: async (deps, row) => {
    if (!row.booking_id) return;
    await deps.deleteBusyBlocksForBooking(row.booking_id);
  },
  [CANCEL_STEPS.RECOMPUTE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (ctx) await deps.invalidateSlots(ctx.bucket.code);
  },
  [CANCEL_STEPS.NOTIFY]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking, bucket, eventType } = ctx;
    const p = row.payload;
    const reason: ValidatedReason = {
      code: p.reasonCode ?? "",
      detail: p.reasonDetail ?? null,
    };
    const initiator: BookingEventInitiator = p.initiator ?? "system";
    // Record history idempotently: reuse the existing row's id on a drain re-run
    // (so the webhook dedupe key is stable) instead of inserting a duplicate.
    let eventId = await deps.getBookingEventId(booking.id, "cancelled", null);
    if (!eventId) {
      eventId = await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "cancelled",
          initiator,
          reason,
          fromStartsIso: p.fromStartsIso ?? booking.starts_at,
          toStartsIso: null,
          fromAgentUserId: p.fromAgentUserId ?? booking.assigned_user_id,
          toAgentUserId: null,
          actorUserId: p.actorUserId,
          actingAsUserId: p.actingAsUserId,
          nowMs: Date.now(),
        }),
      );
    }
    await fire(
      deps,
      "booking.cancelled",
      booking,
      bucket,
      eventType,
      reasonMeta(reason, initiator),
      eventId,
    );
  },

  // Reschedule post-commit steps. Handlers re-read the booking, which already
  // holds the NEW time/agent (updateBooking ran before the row was enqueued), so
  // the move/recompute target the new slot and the webhook carries the new time.
  [RESCHEDULE_STEPS.BUSYBLOCK_MOVE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx || !ctx.booking.assigned_user_id) return;
    await deps.moveBusyBlock(
      ctx.booking.assigned_user_id,
      ctx.booking.starts_at,
      ctx.booking.ends_at,
      ctx.booking.id,
    );
  },
  [RESCHEDULE_STEPS.RECOMPUTE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (ctx) await deps.invalidateSlots(ctx.bucket.code);
  },
  [RESCHEDULE_STEPS.NOTIFY]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking, bucket, eventType } = ctx;
    const p = row.payload;
    const reason: ValidatedReason = {
      code: p.reasonCode ?? "",
      detail: p.reasonDetail ?? null,
    };
    const initiator: BookingEventInitiator = p.initiator ?? "system";
    const toStartsIso = booking.starts_at; // the new time (already committed)
    // Versioned by (to_starts_at, reschedule_seq): an oscillation back to a
    // previously-used time still gets a fresh history row + dedupe key, so its
    // webhook isn't swallowed by the earlier reschedule's row (#614). The seq is
    // stable across a drain re-run of THIS move, so the resume still dedupes.
    const seq = booking.reschedule_seq;
    let eventId = await deps.getBookingEventId(booking.id, "rescheduled", toStartsIso, seq);
    if (!eventId) {
      eventId = await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "rescheduled",
          initiator,
          reason,
          fromStartsIso: p.fromStartsIso ?? booking.starts_at,
          toStartsIso,
          fromAgentUserId: p.fromAgentUserId ?? null,
          toAgentUserId: booking.assigned_user_id,
          actorUserId: p.actorUserId,
          actingAsUserId: p.actingAsUserId,
          rescheduleSeq: seq,
          nowMs: Date.now(),
        }),
      );
    }
    await fire(
      deps,
      "booking.rescheduled",
      booking,
      bucket,
      eventType,
      reasonMeta(reason, initiator),
      eventId,
    );
  },

  // Reassign post-commit steps. Move/recompute mirror reschedule (re-read the
  // booking, now at the new agent). Notify differs: the history action is
  // 'reassigned' (so it doesn't inflate reschedule-rate) but the webhook stays
  // booking.rescheduled (Regal contract), and the time is UNCHANGED — so there's
  // no time to version the dedupe key by; we key the webhook on the outbox row
  // id (stable per reassign, so a resume re-fire is deduped — exactly-once).
  [REASSIGN_STEPS.BUSYBLOCK_MOVE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx || !ctx.booking.assigned_user_id) return;
    await deps.moveBusyBlock(
      ctx.booking.assigned_user_id,
      ctx.booking.starts_at,
      ctx.booking.ends_at,
      ctx.booking.id,
    );
  },
  [REASSIGN_STEPS.RECOMPUTE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (ctx) await deps.invalidateSlots(ctx.bucket.code);
  },
  [REASSIGN_STEPS.NOTIFY]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking, bucket, eventType } = ctx;
    const p = row.payload;
    const reason: ValidatedReason = {
      code: p.reasonCode ?? "",
      detail: p.reasonDetail ?? null,
    };
    // A manager-driven reassign carries initiator 'admin' (#546); the machine
    // contact-owner path leaves it unset -> 'system'. The history row AND the
    // webhook meta must agree, so both read the payload's initiator.
    const initiator: BookingEventInitiator = p.initiator ?? "system";
    // Record the override audit row (action 'reassigned'). Not guarded for
    // idempotent resume because a reassign has no natural per-operation key in
    // booking_events; a duplicate on the rare within-step crash is acceptable
    // (audit only). The webhook below stays exactly-once via the row-id key.
    await deps.insertBookingEvent(
      bookingEventFrom({
        bookingId: booking.id,
        action: "reassigned",
        initiator,
        reason,
        fromStartsIso: booking.starts_at,
        toStartsIso: booking.starts_at,
        fromAgentUserId: p.fromAgentUserId ?? null,
        toAgentUserId: booking.assigned_user_id,
        actorUserId: p.actorUserId,
        actingAsUserId: p.actingAsUserId,
        nowMs: Date.now(),
      }),
    );
    // Dedupe key = the outbox row id: stable across inline run + drain resume,
    // so the booking.rescheduled webhook fires exactly once.
    await fire(
      deps,
      "booking.rescheduled",
      booking,
      bucket,
      eventType,
      reasonMeta(reason, initiator),
      row.id,
    );
  },
};

function manageUrl(deps: Pick<BookingDeps, "appBaseUrl">, token: string): string {
  return `${deps.appBaseUrl()}/booking/manage/${token}`;
}

export interface DuplicateWarning {
  /** Start of the lead's OTHER active booking (ISO instant). */
  startsAt: string;
  /** Manage link for that booking, so they can view or cancel it. */
  manageUrl: string;
}

/**
 * After a booking succeeds, find the lead's OTHER active booking so the
 * confirmation screen can warn them (#626). Guards the case a timed-out confirm
 * that silently succeeded then got rebooked at a new time. Reuses the same
 * identity grading (findPersonMatch) and candidate lookup as the dedupe path;
 * this wrapper only drops the just-created row and maps the match to a link.
 */
export async function findDuplicateWarning(
  input: {
    excludeBookingId: string;
    salesforceId: string | null;
    attendee: { email?: string; phone?: string };
  },
  deps: Pick<BookingDeps, "findActiveBookingsForPerson" | "appBaseUrl">,
): Promise<DuplicateWarning | null> {
  const identity: PersonIdentity = {
    externalId: null,
    salesforceId: input.salesforceId,
    email: input.attendee.email ?? null,
    phone: input.attendee.phone ?? null,
  };
  const candidates = (
    await deps.findActiveBookingsForPerson(identity)
  ).filter((b) => b.id !== input.excludeBookingId);
  const match = findPersonMatch(identity, candidates);
  if (!match) return null;
  return {
    startsAt: match.booking.starts_at,
    manageUrl: manageUrl(deps, match.booking.manage_token),
  };
}

/** Max simultaneous booking.completed deliveries (Cloudflare subrequest cap). */
const COMPLETION_WEBHOOK_CONCURRENCY = 6;

/** Max reservations completed at once when draining a backlog (AUD-062). Rows are
 *  leased independently so concurrency never double-runs one; the cap keeps the
 *  per-row create/webhook calls under the same subrequest ceiling. */
const RESERVATION_DRAIN_CONCURRENCY = 6;

export async function createBooking(
  input: CreateBookingInput,
  deps: BookingDeps,
): Promise<BookingResult> {
  // A STABLE key (caller-supplied, or derived from the lead's contact identity)
  // is what lets a re-submit collapse onto the same booking. Anonymous bookings
  // have none (idempotencyKeyFor returns null).
  const stableKey =
    input.idempotencyKey ??
    idempotencyKeyFor({
      bucketCode: input.bucketCode,
      startIso: input.startIso,
      email: input.attendee.email,
      phone: input.attendee.phone,
      salesforceId: input.salesforceId,
    });

  // Fast path: a double-click / retry of the same submit returns the existing
  // active booking instead of creating a second one (+ a second gcal event).
  // Only a stable key can match a prior booking; a synthetic key (below) is fresh
  // per request, so there's nothing to look up.
  if (stableKey) {
    const existing = await deps.findBookingByIdempotencyKey(stableKey);
    if (existing) {
      return { booking: existing, manageUrl: manageUrl(deps, existing.manage_token) };
    }
  }

  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new UnknownBucketError();
  const { bucket, eventType } = resolved;

  // A synthetic test bucket (#396) is unbookable on the public path: only the
  // key-authed direct booking API sets allowTestBuckets. To a real lead it must
  // look like the bucket doesn't exist (same error as an unknown code — no hint
  // that a hidden bucket is there).
  if (bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();

  // Every booking gets the reservation-backed crash-safe create (#666). A keyless
  // (anonymous) booking has no stable key to pin a re-submit by, so it gets a
  // fresh synthesized one: no cross-request dedupe (there's nothing to dedupe on,
  // same as the old anonymous behavior), but the reservation + drain still
  // guarantee booking.created is delivered exactly once even across a crash.
  const idempotencyKey = stableKey ?? deps.newIdempotencyKey();

  // Resume an in-flight reservation: a re-submit after a crash mid-create reuses
  // the SAME pinned agent + event id instead of re-running assignAgent (which
  // could land on a different agent and duplicate the calendar event). Only a
  // stable key can name a prior in-flight reservation.
  if (stableKey) {
    const inFlight = await deps.loadReservationByKey(stableKey);
    if (inFlight) return completeReservation(deps, inFlight);
  }

  // Fresh create: cascade down the tier ladder if the requested bucket has no
  // agent free for the slot. A crash before the reservation strands nothing.
  let tier: TierAssignResult;
  try {
    tier = await assignAgentWithTierFallback(deps, { bucket, eventType }, input.startIso, input.allowTestBuckets ?? false);
  } catch (err) {
    // Best-effort: record no-booking attempts so "why did this lead get no slots"
    // is answerable. Awaited so the write is not dropped by the CF runtime; the
    // outer try/catch ensures the original error still propagates unchanged.
    if (
      err instanceof NoEligibleAgentsError ||
      err instanceof VerifyUnavailableError ||
      err instanceof SlotUnavailableError
    ) {
      const outcome =
        err instanceof NoEligibleAgentsError ? "no_eligible_agents" : "no_availability";
      try {
        const pool = await resolveBucketPool(bucket);
        await recordRoutingDecision({
          orgId: bucket.org_id,
          bookingId: null,
          bucketCode: bucket.code,
          bucketId: bucket.id,
          criteria: pool.criteria,
          ...buildRoutingTraceExtras(pool, []),
          chosenUserId: null,
          chosenAttributes: null,
          emptyPoolFallback: false,
          tierFallback: false,
          rungsDropped: 0,
          requestedTier: pool.criteria.debt_team ? String(pool.criteria.debt_team) : null,
          bookedTier: null,
          outcome,
        });
      } catch {
        // best-effort: never change the thrown booking error
      }
    }
    throw err;
  }
  const bookedBucket = tier.bucket;
  const bookedEventType = tier.eventType;
  const startIso = tier.startIso;
  const endIso = tier.endIso;
  const { userId, email, candidates } = tier;
  const agent = await deps.getUser(userId);
  let traceExtras: ReturnType<typeof buildRoutingTraceExtras> = {
    considered: candidates,
    excluded: [],
  };
  try {
    const pool = await resolveBucketPool(bookedBucket);
    traceExtras = buildRoutingTraceExtras(pool, candidates);
  } catch {
    // best-effort: a transient pool-resolve failure must not fail the booking
  }
  const phone = toE164(input.attendee.phone);
  const manageToken = deps.newManageToken();
  const gcalClientId = await deterministicEventId(idempotencyKey, userId);

  const bookingInsert: BookingInsert = {
    org_id: bookedBucket.org_id,
    bucket_id: bookedBucket.id,
    event_type_id: bookedEventType.id,
    assigned_user_id: userId,
    agent_name: agent.name,
    agent_email: agent.email,
    starts_at: startIso,
    ends_at: endIso,
    original_starts_at: startIso,
    original_ends_at: endIso,
    timezone: input.timezone,
    status: "confirmed",
    salesforce_id: input.salesforceId ?? null,
    attendee_name: input.attendee.name ?? null,
    attendee_email: input.attendee.email ?? null,
    attendee_phone: phone,
    prefill: input.prefill,
    gcal_event_id: gcalClientId, // the pinned client id IS the stored event id
    manage_token: manageToken,
    idempotency_key: idempotencyKey,
    external_id: input.externalId ?? null,
    routing_trace: {
      bucket_code: bookedBucket.code,
      bucket_id: bookedBucket.id,
      considered: candidates,
      chosen_user_id: userId,
      fallback_applied:
        bookedBucket.fallback_user_id != null &&
        candidates.length > 0 &&
        candidates.every((id) => id === bookedBucket.fallback_user_id),
      excluded: traceExtras.excluded,
      tier_fallback: tier.rungsDropped > 0,
      requested_tier: tierKeyOf(input.bucketCode),
      booked_tier: tierKeyOf(bookedBucket.code),
      rungs_dropped: tier.rungsDropped,
    },
  };
  const event: ReservationPayload["event"] = {
    summary: `${bookedEventType.name}${
      input.attendee.name ? ` with ${input.attendee.name}` : ""
    }`,
    description: eventDescription(phone, manageUrl(deps, manageToken)),
    start: startIso,
    end: endIso,
    timezone: input.timezone,
    attendeeEmail: input.attendee.email,
    attendeeName: input.attendee.name,
  };

  // The UNIQUE(idempotency_key) on the reservation is the concurrency arbiter:
  // a same-key racer that already won is returned here, so we adopt ITS pin.
  const reservation = await deps.insertReservation({
    idempotency_key: idempotencyKey,
    pinned_user_id: userId,
    pinned_agent_email: email,
    gcal_client_id: gcalClientId,
    payload: { booking: bookingInsert, event, bucketCode: input.bucketCode },
  });

  return completeReservation(deps, reservation);
}

/**
 * The post-insert side effects a create MUST deliver, factored out so the fresh
 * create and a crash-resume run the SAME sequence (#613). Every step is
 * idempotent — moveBusyBlock replaces any prior block for the booking, and
 * booking.created dedupes on the booking id (`webhookDedupeKey`) so a re-run
 * emits nothing new — so running it inline once, or again from the reservation
 * drain after a crash, reaches the same end state without a duplicate block or a
 * double webhook. Returns the resolved bucket/eventType (or null) so the fresh
 * path can attach its best-effort routing log without a second resolve.
 */
async function deliverCreatedSideEffects(
  deps: BookingDeps,
  booking: Booking,
  bookedCode: string,
): Promise<{ bucket: Bucket; eventType: EventType } | null> {
  if (booking.assigned_user_id) {
    await deps.moveBusyBlock(
      booking.assigned_user_id,
      booking.starts_at,
      booking.ends_at,
      booking.id,
    );
  }
  await deps.invalidateSlots(bookedCode);

  // Re-resolve bucket + eventType for the webhook (works on the drain path too).
  const resolved = await deps.resolveBucketByCode(bookedCode);
  if (resolved) {
    await fire(deps, "booking.created", booking, resolved.bucket, resolved.eventType);
  }
  return resolved;
}

/**
 * Complete a booking from its reservation (#429 P4). Shared by the fresh create,
 * the re-submit resume, and the drain — so a crash anywhere resumes to the same
 * end state. Idempotent: createEvent reuses the event (deterministic id → 409),
 * a booking already inserted short-circuits, and insertBooking keeps the
 * active-slot 23505 handling. Deletes the reservation on success.
 */
async function completeReservation(
  deps: BookingDeps,
  reservation: BookingReservation,
): Promise<BookingResult> {
  const { booking: bookingInsert, event, bucketCode } = reservation.payload;
  const key = bookingInsert.idempotency_key;

  // A resume after the booking was inserted but before the reservation was
  // deleted. A crash here could have landed BEFORE booking.created fired (1336
  // -> 1374), which used to be dropped permanently: short-circuiting to just
  // delete the reservation skipped every post-insert side effect (#613). Instead,
  // re-run the idempotent side effects (busyblock/recompute/notify) so the
  // previously-lost booking.created is delivered exactly once, THEN clean up.
  if (key) {
    const already = await deps.findBookingByIdempotencyKey(key);
    if (already) {
      const bookedCode = already.routing_trace?.bucket_code ?? bucketCode;
      await deliverCreatedSideEffects(deps, already, bookedCode);
      await deps.deleteReservation(reservation.id);
      return { booking: already, manageUrl: manageUrl(deps, already.manage_token) };
    }
  }

  // Create OR reuse the calendar event with the pinned client id.
  const gcalEventId = await deps.createEvent(
    reservation.pinned_agent_email,
    {
      summary: event.summary,
      description: event.description,
      start: event.start,
      end: event.end,
      timezone: event.timezone,
      attendeeEmail: event.attendeeEmail ?? undefined,
      attendeeName: event.attendeeName ?? undefined,
    },
    reservation.gcal_client_id,
  );

  const inserted = await deps.insertBooking({ ...bookingInsert, gcal_event_id: gcalEventId });
  if (!inserted.ok) {
    if (inserted.conflict) {
      // A concurrent duplicate won the idempotency race, or the slot was taken.
      if (key) {
        const winner = await deps.findBookingByIdempotencyKey(key);
        if (winner) {
          await deps.deleteReservation(reservation.id);
          return { booking: winner, manageUrl: manageUrl(deps, winner.manage_token) };
        }
      }
      // Genuinely unavailable: roll back the event + reservation.
      await deleteEventBestEffort(deps, reservation.pinned_agent_email, gcalEventId, null);
      await deps.deleteReservation(reservation.id);
      throw new SlotUnavailableError();
    }
    // Generic (likely transient) failure: roll back the event (a resume
    // re-creates it via the same deterministic id), but LEAVE the reservation
    // pending so the drain retries the insert.
    await deleteEventBestEffort(deps, reservation.pinned_agent_email, gcalEventId, null);
    throw new Error("Failed to persist booking");
  }
  const booking = inserted.booking;

  // #586: the booking now owns this event id, so any source=gcal block for it is a
  // stray mirror a push-sync cached while racing the create (before the booking
  // committed). Delete it, else it would outlive a later cancel (which removes
  // blocks by booking_id, not the null-booking_id mirror) and over-block the freed
  // slot until a full resync. Idempotent (no-op when no mirror exists). Best-effort:
  // the booking has already committed, so a transient cleanup failure must NOT fail
  // it. The sync's slate-id delete and the full-resync purge are the backstops.
  if (booking.assigned_user_id && gcalEventId) {
    try {
      await deps.deleteGcalMirrorBlock(booking.assigned_user_id, gcalEventId);
    } catch {
      // best-effort
    }
  }

  // On a tier-drop the routing_trace records the booked (lower) bucket; on a
  // non-fallback booking it equals bucketCode. Use the persisted value so that
  // invalidateSlots, the webhook, and the routing-decision log all attribute
  // side-effects to the bucket whose availability actually changed.
  const bookedCode = booking.routing_trace?.bucket_code ?? bucketCode;

  // Deliver the busyblock/recompute/notify side effects idempotently — the SAME
  // path a crash-resume takes, so booking.created can't be dropped (#613).
  const resolved = await deliverCreatedSideEffects(deps, booking, bookedCode);
  if (resolved) {
    // Best-effort routing decision log. Awaited so the write is not dropped by the
    // CF runtime; try/catch keeps any transient failure out of the booking response.
    try {
      const chosenAgent = booking.assigned_user_id
        ? await deps.getUser(booking.assigned_user_id)
        : null;
      const rt = booking.routing_trace;
      await recordRoutingDecision({
        orgId: booking.org_id,
        bookingId: booking.id,
        bucketCode: resolved.bucket.code,
        bucketId: resolved.bucket.id,
        criteria: resolved.bucket.criteria,
        considered: rt?.considered ?? [],
        excluded: rt?.excluded ?? [],
        chosenUserId: booking.assigned_user_id,
        chosenAttributes: chosenAgent?.attributes ?? null,
        emptyPoolFallback: rt?.fallback_applied ?? false,
        tierFallback: rt?.tier_fallback ?? false,
        rungsDropped: rt?.rungs_dropped ?? 0,
        requestedTier: rt?.requested_tier ?? null,
        bookedTier: rt?.booked_tier ?? null,
        outcome: "booked",
      });
    } catch {
      // best-effort
    }
    // Best-effort tier-drop alert. Throttled via alert_state; a single-rung drop
    // emits a quiet notice, a two-plus-rung drop escalates.
    const tierAlert = tierFallbackAlert({
      requestedCode: bucketCode,
      effectiveCode: booking.routing_trace?.bucket_code ?? bucketCode,
      rungsDropped: Math.max(0, booking.routing_trace?.rungs_dropped ?? 0),
    });
    if (tierAlert) {
      await sendThrottledAlert(tierAlert.key, tierAlert.cooldownMs, tierAlert.text).catch(() => {});
    }
  }

  await deps.deleteReservation(reservation.id);
  return { booking, manageUrl: manageUrl(deps, booking.manage_token) };
}

/**
 * Drain pending create reservations (#429 P4 / Phase C): a booking whose create
 * crashed after the reservation was written resumes here. Each row is leased
 * (so the drain and an inline re-submit can't both run it), then completed
 * idempotently — completeReservation reuses the pinned event + deletes the row
 * on success. A failure releases the lease so the next tick retries.
 */
export async function processBookingReservations(
  deps: BookingDeps,
  limit: number,
): Promise<{
  processed: number;
  completed: number;
  failed: number;
  stuck: BookingReservation[];
}> {
  const rows = await deps.loadDrainableReservations(limit);
  let completed = 0;
  let failed = 0;
  const stuck: BookingReservation[] = [];
  // Complete reservations concurrently but bounded (AUD-062): each is leased
  // first, so two drains never double-run a row; a large backlog clears in far
  // fewer ticks than a serial await-per-row loop.
  await mapWithConcurrency(rows, RESERVATION_DRAIN_CONCURRENCY, async (reservation) => {
    if (!(await deps.leaseReservation(reservation.id))) return;
    try {
      await completeReservation(deps, reservation);
      completed++;
    } catch (err) {
      failed++;
      // A genuine SlotUnavailable is TERMINAL: completeReservation already deleted
      // the row (the slot was taken), so don't bump/alert - that would schedule a
      // backoff on a row that no longer exists and could fire a "not completing"
      // alert pointing on-call at a deleted row. Only a TRANSIENT failure leaves
      // the row pending: bump attempts + last_error with backoff (#445) so we
      // don't re-hit it every tick; past the alert threshold it's reported stuck.
      if (!(err instanceof SlotUnavailableError)) {
        const attempts = reservation.attempts + 1;
        const lastError = err instanceof Error ? err.message : String(err);
        await deps.bumpReservationAttempt(reservation.id, attempts, lastError);
        if (attempts >= DRAIN_ALERT_AFTER) {
          stuck.push({ ...reservation, attempts, last_error: lastError });
        }
      }
    } finally {
      // Always release, even if the bump above rejected - mirror the outbox
      // drain so a transient bump error can't leak the lease or abort the batch.
      await deps.releaseReservationLease(reservation.id);
    }
  });
  return { processed: rows.length, completed, failed, stuck };
}

/**
 * GC sweep for abandoned reschedule lease-pins (#439, milestone #7). A crash +
 * never-retried reassign leaves a stray Google event — cosmetic, since
 * availability is busy_blocks-cache-first and never reads live Google, and the
 * expired lease already unblocks the booking. For each lease past its
 * `lease_until + grace` whose REASSIGN pin was never adopted (its
 * `gcal_client_id` isn't the booking's live event), enqueue the orphaned event
 * for durable deletion, then delete the lock row. Cleanup ONLY — it never
 * completes or reassigns a booking, so it does not violate the "no completion
 * drain" decision. Runs on the existing /api/cron/outbox lane.
 */
export async function processAbandonedReschedulePins(
  deps: BookingDeps,
  graceMs: number,
): Promise<{ swept: number; enqueued: number }> {
  const rows = await deps.loadAbandonedReschedulePins(graceMs);
  let enqueued = 0;
  for (const row of rows) {
    if (
      row.branch === "reassign" &&
      row.gcal_client_id &&
      row.gcal_client_id !== row.booking_gcal_event_id
    ) {
      await deps.enqueueEventDeletion(row.pinned_agent_email, row.gcal_client_id, row.booking_id);
      enqueued += 1;
    }
    await deps.releaseReschedule(row.booking_id);
  }
  return { swept: rows.length, enqueued };
}

/** Input for the direct booking API path: a normal booking plus the external
 *  caller's required per-person id and the confirm-reschedule flag (#357). */
export interface ApiBookingInput extends CreateBookingInput {
  externalId: string;
  confirmReschedule: boolean;
}

/** Read-only preview of what an API booking WOULD do (dry run, #380). */
export interface ApiBookingPreview {
  dryRun: true;
  outcome: ApiBookingOutcome;
  /** For a would-be create: the agent round-robin + verify-on-book would assign. */
  wouldAssign: { id: string; name: string | null; email: string | null } | null;
  /** For dedupe/reschedule/confirm: the existing booking the person matched. */
  existingBookingId: string | null;
}

export type ApiBookingOutcome =
  | "created"
  | "deduped"
  | "rescheduled"
  | "confirm_required";

export interface ApiBookingResult {
  outcome: ApiBookingOutcome;
  booking: Booking;
  manageUrl: string;
  /** #543: present on a "rescheduled" outcome when the in-place agent was
   *  declined and the booking reassigned. Observability only. */
  rescheduleDecline?: RescheduleDeclineReason;
}

// Machine-to-machine rebooking reason; recorded on the reschedule history row.
const API_REBOOK_REASON: ValidatedReason = { code: "api_rebooking", detail: null };

/**
 * Direct booking API entry (#357): enforce "one active appointment per person".
 * Look the lead up across active bookings, grade the match, then create / dedupe
 * / auto-reschedule / ask-to-confirm. Auto-reschedule reuses the full reschedule
 * path (verify-on-book, history, booking.rescheduled webhook); it moves the
 * EXISTING booking's time and keeps its bucket (a cross-bucket rebook is the
 * documented v1 edge — the original bucket wins).
 */
/** Shared person-dedupe decision used by both the real book and the dry run. */
async function resolvePersonDecision(
  input: ApiBookingInput,
  deps: BookingDeps,
) {
  const identity: PersonIdentity = {
    externalId: input.externalId,
    salesforceId: input.salesforceId ?? null,
    email: input.attendee.email ?? null,
    phone: input.attendee.phone ?? null,
  };
  const candidates = await deps.findActiveBookingsForPerson(identity);
  const match = findPersonMatch(identity, candidates);
  return decidePersonBooking({
    startIso: input.startIso,
    match,
    confirmReschedule: input.confirmReschedule,
  });
}

/**
 * Dry run (#380): run the full decision — person match, and for a would-be
 * create the real round-robin + verify-on-book — and report what WOULD happen,
 * writing nothing (no calendar event, no booking, no webhook). Routing failures
 * (e.g. NoEligibleAgentsError) still surface, so the caller can validate a bucket.
 */
export async function previewBooking(
  input: ApiBookingInput,
  deps: BookingDeps,
): Promise<ApiBookingPreview> {
  const decision = await resolvePersonDecision(input, deps);
  if (decision.action === "create") {
    const resolved = await deps.resolveBucketByCode(input.bucketCode);
    if (!resolved) throw new UnknownBucketError();
    const { startIso, endIso } = bookingWindow(
      input.startIso,
      resolved.eventType.duration_min,
    );
    // preview=true: route read-only, no shadow-study log / unfair-ordering alert.
    const { userId } = await assignAgent(deps, resolved.bucket, resolved.eventType, startIso, endIso, true);
    const agent = await deps.getUser(userId);
    return {
      dryRun: true,
      outcome: "created",
      wouldAssign: { id: agent.id, name: agent.name, email: agent.email },
      existingBookingId: null,
    };
  }
  const outcome: ApiBookingOutcome =
    decision.action === "dedupe" ? "deduped" : decision.action === "reschedule" ? "rescheduled" : "confirm_required";
  return { dryRun: true, outcome, wouldAssign: null, existingBookingId: decision.booking.id };
}

export async function bookViaApi(
  input: ApiBookingInput,
  deps: BookingDeps,
): Promise<ApiBookingResult> {
  const decision = await resolvePersonDecision(input, deps);

  switch (decision.action) {
    case "create": {
      const res = await createBooking(input, deps);
      return { outcome: "created", booking: res.booking, manageUrl: res.manageUrl };
    }
    case "dedupe":
      return {
        outcome: "deduped",
        booking: decision.booking,
        manageUrl: manageUrl(deps, decision.booking.manage_token),
      };
    case "reschedule": {
      // #364: if the rebook targets a DIFFERENT bucket than the existing
      // appointment, move the lead to the new bucket rather than just shifting
      // the time within the original one (so they route to the team matching
      // their new request).
      const resolved = await deps.resolveBucketByCode(input.bucketCode);
      if (!resolved) throw new UnknownBucketError();
      if (resolved.bucket.id !== decision.booking.bucket_id) {
        // Create in the new bucket FIRST so a failure (e.g. no eligible agents
        // there) leaves the existing appointment intact, THEN cancel the old.
        const created = await createBooking(input, deps);
        await cancelBooking(decision.booking.manage_token, API_REBOOK_REASON, "system", deps);
        return { outcome: "rescheduled", booking: created.booking, manageUrl: created.manageUrl };
      }
      const res = await rescheduleBooking(
        decision.booking.manage_token,
        input.startIso,
        API_REBOOK_REASON,
        "system",
        deps,
      );
      return {
        outcome: "rescheduled",
        booking: res.booking,
        manageUrl: res.manageUrl,
        rescheduleDecline: res.rescheduleDecline,
      };
    }
    case "confirm_required":
      return {
        outcome: "confirm_required",
        booking: decision.booking,
        manageUrl: manageUrl(deps, decision.booking.manage_token),
      };
  }
}

/** Active statuses a person can still cancel (#386). */
const CANCELLABLE_STATUSES: readonly BookingStatus[] = ["confirmed", "rescheduled"];

/** Resolved list filter handed to the DB dep (codes already resolved to ids). */
export interface ListFilter {
  status: BookingStatus | null;
  afterStart: string | null;
  beforeEnd: string | null;
  updatedSince: string | null;
  bucketId: string | null;
  assignedUserId: string | null;
  limit: number;
  offset: number;
  orderBy: "starts_at" | "updated_at";
}

/** Outward-facing view of a booking for the lookup/cancel API (#386). */
export interface ApiBookingView {
  id: string;
  externalId: string | null;
  salesforceId: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  agent: { name: string | null; email: string | null };
  manageUrl: string;
}

/** A list row: the lookup view plus its bucket code (#392). */
export interface ApiBookingListItem extends ApiBookingView {
  bucketCode: string | null;
}

function toApiBookingView(b: Booking, deps: BookingDeps): ApiBookingView {
  return {
    id: b.id,
    externalId: b.external_id,
    salesforceId: b.salesforce_id,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    status: b.status,
    agent: { name: b.agent_name, email: b.agent_email },
    manageUrl: manageUrl(deps, b.manage_token),
  };
}

/**
 * #392 cross-person list. Resolves the bucket/agent filters to ids (an unknown
 * code/email yields an empty page with no DB scan), queries one offset page, and
 * tags each row with its bucket code from the joined buckets. nextCursor is set
 * only when the page came back full.
 */
export async function listBookings(
  query: ListQuery,
  deps: BookingDeps,
): Promise<{ items: ApiBookingListItem[]; nextCursor: string | null }> {
  let bucketId: string | null = null;
  if (query.bucketCode) {
    const resolved = await deps.resolveBucketByCode(query.bucketCode);
    if (!resolved) return { items: [], nextCursor: null };
    bucketId = resolved.bucket.id;
  }
  let assignedUserId: string | null = null;
  if (query.agentEmail) {
    const agent = await deps.getAgentByEmail(query.agentEmail);
    if (!agent) return { items: [], nextCursor: null };
    assignedUserId = agent.id;
  }

  const { rows, buckets } = await deps.queryBookings({
    status: query.status,
    afterStart: query.afterStart,
    beforeEnd: query.beforeEnd,
    updatedSince: query.updatedSince,
    bucketId,
    assignedUserId,
    limit: query.limit,
    offset: query.offset,
    orderBy: query.updatedSince ? "updated_at" : "starts_at",
  });

  const codeById = new Map(buckets.map((b) => [b.id, b.code]));
  const items: ApiBookingListItem[] = rows.map((b) => ({
    ...toApiBookingView(b, deps),
    bucketCode: codeById.get(b.bucket_id) ?? null,
  }));
  const nextCursor = rows.length === query.limit ? encodeCursor(query.offset + query.limit) : null;
  return { items, nextCursor };
}

/** List a person's ACTIVE bookings for the lookup API (#386). Strong-id only:
 *  the identity passed in carries no email/phone, so every match is strong. */
export async function lookupPersonBookings(
  identity: PersonIdentity,
  deps: BookingDeps,
): Promise<ApiBookingView[]> {
  const bookings = await deps.findActiveBookingsForPerson(identity);
  return bookings.map((b) => toApiBookingView(b, deps));
}

/** Read ONE booking by id for the lookup API (#386), at any status (so the bot
 *  can poll a cancelled/completed one). Throws BookingNotFoundError if missing,
 *  not owned by the caller, or (when `status` is set) not in that status. */
export async function getPersonBookingById(
  input: {
    bookingId: string;
    identity: Pick<PersonIdentity, "externalId" | "salesforceId">;
    status: BookingStatus | null;
  },
  deps: BookingDeps,
): Promise<ApiBookingView> {
  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx || !bookingBelongsToPerson(ctx.booking, input.identity)) {
    throw new BookingNotFoundError();
  }
  if (input.status && ctx.booking.status !== input.status) {
    throw new BookingNotFoundError();
  }
  return toApiBookingView(ctx.booking, deps);
}

/** Cancel ONE booking by id for the cancel API (#386). Requires the booking to
 *  exist, be owned by the caller (strong id), and be active; else
 *  BookingNotFoundError. Reuses the standard cancel path (gcal delete, busy-block
 *  clear, history row, booking.cancelled webhook), stamped initiator=customer. */
export async function cancelDirectBooking(
  input: {
    bookingId: string;
    identity: Pick<PersonIdentity, "externalId" | "salesforceId">;
    reason: ValidatedReason;
  },
  deps: BookingDeps,
): Promise<ApiBookingView> {
  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx || !bookingBelongsToPerson(ctx.booking, input.identity)) {
    throw new BookingNotFoundError();
  }
  if (!CANCELLABLE_STATUSES.includes(ctx.booking.status)) {
    throw new BookingNotFoundError();
  }
  // Re-checks status under a fresh read; false means another cancel already
  // won the race (the row was cancelled between our pre-check and here), so
  // this call is the loser and must 404 rather than report a second success.
  const transitioned = await cancelBooking(ctx.booking.manage_token, input.reason, "customer", deps);
  if (!transitioned) throw new BookingNotFoundError();
  return toApiBookingView({ ...ctx.booking, status: "cancelled" }, deps);
}

export async function rescheduleBooking(
  token: string,
  newStartIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  deps: BookingDeps,
  nowMs: number = Date.now(),
  actor?: BookingActor,
): Promise<BookingResult> {
  const ctx = await deps.loadBookingContext(token);
  if (!ctx) throw new Error("Booking not found");
  const { booking, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

  const { startIso, endIso } = bookingWindow(
    newStartIso,
    eventType.duration_min,
  );

  // Idempotency guard 1 — sequential duplicate / no-op reschedule: if the
  // booking already sits at the requested instant (e.g. a double-click whose
  // first call already landed), there's nothing to move. Still ensure the
  // reason event is recorded — a first attempt that moved the booking but died
  // before recording it would otherwise lose the (mandatory) reason (#326).
  // Non-holder early return (never claimed -> never releases).
  if (Date.parse(booking.starts_at) === Date.parse(startIso)) {
    if (!(await deps.hasBookingEvent(booking.id, "rescheduled", startIso, booking.reschedule_seq))) {
      await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "rescheduled",
          initiator,
          reason,
          fromStartsIso: booking.starts_at,
          toStartsIso: startIso,
          fromAgentUserId: booking.assigned_user_id,
          toAgentUserId: booking.assigned_user_id,
          actorUserId: actor?.userId,
          actingAsUserId: actor?.actingAsUserId,
          rescheduleSeq: booking.reschedule_seq,
          nowMs: Date.now(),
        }),
      );
    }
    // Conditionally clean up a lock row a commit-then-crash may have left for
    // THIS now-committed target. Only when the pin's target matches ours: a
    // concurrent different-target holder will have re-pinned to its own target,
    // so this never clobbers an active different-target lease.
    const lingering = await deps.readReschedulePin(booking.id);
    if (lingering && Date.parse(lingering.target_starts_at) === Date.parse(startIso)) {
      await deps.releaseReschedule(booking.id);
    }
    return { booking, manageUrl: manageUrl(deps, token) };
  }

  // Idempotency guard 2 — claim the per-booking lease (#439). The discriminated
  // outcome drives everything: a non-holder (idempotent/noop/conflict) returns or
  // throws WITHOUT touching the finally; only a holder (won/resume/
  // fresh-after-abandon) enters the try/finally, so the release rule holds.
  const claim = await deps.claimReschedule(booking.id, startIso);
  if (claim.outcome === "idempotent" || claim.outcome === "noop") {
    return { booking, manageUrl: manageUrl(deps, token) };
  }
  if (claim.outcome === "conflict") {
    throw new RescheduleConflictError();
  }

  try {
    return await applyReschedule(deps, token, ctx, startIso, endIso, reason, initiator, claim, nowMs, actor);
  } finally {
    await deps.releaseReschedule(booking.id);
  }
}

async function applyReschedule(
  deps: BookingDeps,
  token: string,
  ctx: BookingContext,
  startIso: string,
  endIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  claim: Extract<RescheduleClaim, { outcome: "won" | "resume" | "fresh-after-abandon" }>,
  nowMs: number,
  actor?: BookingActor,
): Promise<BookingResult> {
  const { booking, bucket, eventType } = ctx;
  const currentEmail = booking.agent_email;
  // Capture the pre-move time + agent for the history row before we mutate.
  const fromStartsIso = booking.starts_at;
  const fromAgentUserId = booking.assigned_user_id;
  // The assignee + event id we read, used to GATE the commit (#615): if a
  // concurrent cancel or reassign changed either (or the status) before we
  // commit, the gated UPDATE touches 0 rows and we roll back rather than win.
  const fromGcalEventId = booking.gcal_event_id;
  // Why the current agent could NOT be kept in place (#543), surfaced to the
  // service layer (on success via BookingResult, on failure via the thrown
  // error) for an observability breadcrumb. null = kept in place / no in-place
  // candidate / a resume (the original attempt already reported it).
  let inPlaceDeclineReason: RescheduleDeclineReason | null = null;

  // Resolve the pin. RESUME reads it verbatim — NEVER recompute the agent/branch/
  // event id (recomputing reopens window a + the oscillation ghost). A fresh
  // attempt (won) or fresh-after-abandon computes a new pin and writes it BEFORE
  // any Google call (the load-bearing crash-safety invariant).
  let pin: ReschedulePin;
  if (claim.outcome === "resume") {
    pin = claim.pin;
  } else {
    // fresh-after-abandon keys the new seq off the ABANDONED pin's seq (+1), not
    // booking.reschedule_seq, so the new id can't collide with the abandoned one.
    const baseSeq =
      claim.outcome === "fresh-after-abandon" ? claim.pin.reschedule_seq : booking.reschedule_seq;
    const seq = baseSeq + 1;

    // fresh-after-abandon: the stale pin's event (for a DIFFERENT target) is
    // orphaned — enqueue it for durable deletion if it isn't the live event.
    if (claim.outcome === "fresh-after-abandon") {
      const stale = claim.pin;
      if (stale.gcal_client_id && stale.gcal_client_id !== booking.gcal_event_id) {
        await deps.enqueueEventDeletion(stale.pinned_agent_email, stale.gcal_client_id, booking.id);
      }
    }

    // Branch decision — the ONLY place the in-place guard / assignAgent run, and
    // only on a FRESH attempt. A resume never reaches here, so a poisoned freeBusy
    // can't flip a same-agent move to a new agent (window b).
    //
    // The in-place branch keeps the current agent only if the new time passes the
    // FULL set of slot rules the booker's `memberOpenStarts` enforces — the SAME
    // `isBookableSlotForAgent` predicate, so the two paths can't drift (#536):
    // working hours (#527), minimum notice, daily cap, AND buffer-before/after.
    // Without all four, a reschedule (especially a direct-API one not picked from
    // offered slots) could park an agent on a slot the booker would never offer.
    // The reads are scoped to the assigned agent + new slot:
    //  - working-hours schedule (rules-only) as a cheap gate before any live call;
    //  - live busy across the BUFFERED window, excluding the booking's OWN still-
    //    present event (#523) so a sub-event-length move isn't a self-conflict; a
    //    read failure (null) re-routes, exactly as the old `isFree` path did;
    //  - the agent's OTHER bookings on the target LOCAL day for the daily cap,
    //    excluding the booking being moved (so a same-day nudge isn't self-counted).
    // A schedule-less agent has no shift windows -> off-shift -> re-route.
    const ownEvent = { start: Date.parse(booking.starts_at), end: Date.parse(booking.ends_at) };
    const slotRules: SlotRules = {
      durationMin: eventType.duration_min,
      bufferBeforeMin: eventType.buffer_before_min,
      bufferAfterMin: eventType.buffer_after_min,
      minNoticeMin: eventType.min_notice_min,
      dailyCap: eventType.daily_cap,
    };
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    let keepInPlace = false;
    // Reason vocabulary here: working_hours | calendar (live busy read failed) |
    // min_notice | buffer. daily_cap can't fire on a keep-same-agent move
    // (enforceDailyCap is off). null while there was no in-place candidate.
    if (currentEmail && booking.assigned_user_id && booking.gcal_event_id) {
      const wh = await deps.agentWorkingHours(booking.assigned_user_id);
      // Cheap rules-only on-shift gate first, so an off-shift reschedule re-routes
      // without a needless live Google read (the common #527 case).
      if (!isWithinWorkingHours(wh.rules, wh.timezone, startMs, endMs)) {
        inPlaceDeclineReason = "working_hours";
      } else {
        const busy = await deps.busyIntervalsForAgent(
          currentEmail,
          new Date(startMs - slotRules.bufferBeforeMin * 60_000).toISOString(),
          new Date(endMs + slotRules.bufferAfterMin * 60_000).toISOString(),
        );
        if (busy === null) {
          // Live calendar read failed -> re-route, exactly as the old isFree path did.
          inPlaceDeclineReason = "calendar";
        } else {
          // A reschedule that keeps the same agent is NOT a net-new booking, so the
          // daily cap does not apply here (it would otherwise reroute a simple move
          // onto a day already full of the agent's OTHER meetings). Still enforce
          // working-hours (gated above), min-notice, and buffer.
          inPlaceDeclineReason = bookableSlotReason(
            { timezone: wh.timezone, rules: wh.rules, busy, bookingStartsMs: [] },
            slotRules,
            startMs,
            nowMs,
            { ignoreBusy: ownEvent, enforceDailyCap: false },
          );
          keepInPlace = inPlaceDeclineReason === null;
        }
      }
    }
    if (keepInPlace) {
      // keepInPlace is only true when all three were present (the guard block above).
      pin = {
        reschedule_seq: seq,
        branch: "in_place",
        pinned_user_id: booking.assigned_user_id!,
        pinned_agent_email: currentEmail!,
        gcal_client_id: booking.gcal_event_id!, // in-place re-PATCHes the existing event
        target_starts_at: startIso,
      };
    } else {
      let next;
      try {
        next = await assignAgent(deps, bucket, eventType, startIso, endIso);
      } catch (err) {
        // The reschedule ultimately failed: the in-place agent was declined and
        // the reroute found nobody. Tag the error with the in-place decline reason
        // (#543) so the service layer can log the two together — the pure layer
        // does no IO itself. Then rethrow the typed error unchanged.
        tagRescheduleFailure(err, { bookingId: booking.id, inPlaceDeclineReason: inPlaceDeclineReason ?? undefined });
        throw err;
      }
      pin = {
        reschedule_seq: seq,
        branch: "reassign",
        pinned_user_id: next.userId,
        pinned_agent_email: next.email,
        gcal_client_id: await deterministicEventId(`reschedule:${booking.id}:${seq}`, next.userId),
        target_starts_at: startIso,
      };
    }
    await deps.writeReschedulePin(booking.id, pin);
  }

  // Execute the pinned branch.
  let newGcalEventId = booking.gcal_event_id;
  if (pin.branch === "in_place") {
    // Idempotent PATCH — a resume simply re-PATCHes the same event to the same
    // time. No createEvent / 409-reuse here; the pin stores the existing event id.
    try {
      await deps.updateEventTime(pin.pinned_agent_email, pin.gcal_client_id, startIso, endIso, booking.timezone);
      newGcalEventId = pin.gcal_client_id;
    } catch (err) {
      // #617: the PATCH target was deleted on Google. Rather than commit a
      // phantom move, recreate the event on the SAME agent at the new time. The
      // deterministic id keeps a crash-resume idempotent (a repeat insert 409s
      // and reuses the same event), and the customer gets a fresh invite.
      if (!(err instanceof EventGone)) throw err;
      newGcalEventId = await deps.createEvent(
        pin.pinned_agent_email,
        {
          summary: `${eventType.name}${booking.attendee_name ? ` with ${booking.attendee_name}` : ""}`,
          description: eventDescription(booking.attendee_phone, manageUrl(deps, token)),
          start: startIso,
          end: endIso,
          timezone: booking.timezone,
          attendeeEmail: booking.attendee_email ?? undefined,
          attendeeName: booking.attendee_name ?? undefined,
        },
        await deterministicEventId(`reschedule-recreate:${booking.id}:${pin.reschedule_seq}`, pin.pinned_user_id),
      );
    }
  } else {
    // reassign: delete-first the old event, then create the new with the pinned
    // deterministic id (a resume's repeat insert 409s and GET-and-reuses it ->
    // no duplicate, window a). On a generic failure, delete the new event and let
    // the pinned id 409-re-create it on resume (mirrors completeReservation ~996).
    if (currentEmail && booking.gcal_event_id && booking.gcal_event_id !== pin.gcal_client_id) {
      await deleteEventBestEffort(deps, currentEmail, booking.gcal_event_id, booking.id);
    }
    try {
      newGcalEventId = await deps.createEvent(
        pin.pinned_agent_email,
        {
          summary: `${eventType.name}${booking.attendee_name ? ` with ${booking.attendee_name}` : ""}`,
          description: eventDescription(booking.attendee_phone, manageUrl(deps, token)),
          start: startIso,
          end: endIso,
          timezone: booking.timezone,
          attendeeEmail: booking.attendee_email ?? undefined,
          attendeeName: booking.attendee_name ?? undefined,
        },
        pin.gcal_client_id,
      );
    } catch (err) {
      await deleteEventBestEffort(deps, pin.pinned_agent_email, pin.gcal_client_id, booking.id);
      throw err;
    }
  }

  const agentName =
    pin.branch === "in_place" ? booking.agent_name : (await deps.getUser(pin.pinned_user_id)).name;
  const agentEmail = pin.pinned_agent_email;
  const assigned = pin.pinned_user_id;

  // Single atomic commit at the new time/agent, advancing the ordinal ONLY on
  // success (so a crash-retry recomputes the same seq -> same deterministic id).
  // GATED on the booking still being the one we started moving (#615): a
  // concurrent cancel (status flip) or reassign (assignee + event id swap) makes
  // this touch 0 rows, so we don't resurrect a cancelled booking or clobber the
  // reassign.
  const committed = await deps.commitReschedule(
    booking.id,
    {
      starts_at: startIso,
      ends_at: endIso,
      assigned_user_id: assigned,
      agent_name: agentName,
      agent_email: agentEmail,
      status: "rescheduled",
      gcal_event_id: newGcalEventId,
      reschedule_seq: pin.reschedule_seq,
    },
    { assignedUserId: fromAgentUserId, gcalEventId: fromGcalEventId },
  );
  if (!committed) {
    // 0 rows: the booking is no longer the one we started moving. Two cases:
    //  - a crash-resume whose prior attempt already committed THIS exact pin
    //    (the row now carries our seq + event id) — idempotent, fall through;
    //  - a genuine conflict: a concurrent cancel/reassign/completion changed it.
    // Distinguish by re-reading, so only a real conflict rolls back + throws.
    const fresh = await deps.loadBookingById(booking.id);
    const alreadyCommitted =
      fresh != null &&
      fresh.booking.reschedule_seq === pin.reschedule_seq &&
      fresh.booking.gcal_event_id === newGcalEventId &&
      (fresh.booking.status === "rescheduled" || fresh.booking.status === "confirmed");
    if (!alreadyCommitted) {
      // Roll back the event THIS reschedule created (reassign branch only; the
      // in_place branch re-PATCHed a pre-existing event that the winner owns, so
      // deleting it here could remove a live event — leave it to the winner).
      if (pin.branch === "reassign") {
        await deleteEventBestEffort(deps, pin.pinned_agent_email, pin.gcal_client_id, booking.id);
      }
      throw new RescheduleConflictError();
    }
  }
  booking.gcal_event_id = newGcalEventId;

  const updated = {
    ...booking,
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled" as const,
  };

  // The booking is committed (updateBooking above) at the NEW time/agent. Deliver
  // the post-commit side effects (slot move, recompute, rescheduled webhook)
  // through the idempotent outbox executor (#429 P3), so a crash here resumes via
  // the drain instead of dropping the webhook or stranding the old slot. Leased
  // around the inline run so a drain tick can't double-run it.
  const steps = rescheduleOutboxSteps();
  const payload = {
    reasonCode: reason.code,
    reasonDetail: reason.detail,
    initiator,
    fromStartsIso,
    fromAgentUserId,
    actorUserId: actor?.userId,
    actingAsUserId: actor?.actingAsUserId,
  };
  const outboxId = await deps.enqueueOutbox({
    booking_id: booking.id,
    action: "reschedule",
    steps,
    payload,
  });
  await deps.leaseOutbox(outboxId);
  try {
    await runOutboxSteps(
      deps,
      {
        id: outboxId,
        booking_id: booking.id,
        action: "reschedule",
        status: "pending",
        steps,
        payload,
        lease_until: null,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        created_at: "",
        updated_at: "",
      },
      OUTBOX_HANDLERS,
    );
  } finally {
    await deps.releaseOutboxLease(outboxId);
  }

  return {
    booking: updated,
    manageUrl: manageUrl(deps, token),
    rescheduleDecline: inPlaceDeclineReason ?? undefined,
  };
}

/**
 * Reassign a booking to a specific owning agent (the contact-owner override,
 * #9). The caller (an upstream automation) has already decided this lead should
 * stick to this agent, so this is FORCED: the agent is booked at the same time
 * even if busy. It's the ONLY path that double-books — the booking is marked
 * `allow_double_book` so the active-slot unique index lets it stack. Throws
 * "Booking not found" / "Agent not found or not bookable" for the caller to map.
 */
export interface ReassignOptions {
  /** Push through even when the target agent is at their daily cap (the machine
   *  contact-owner path passes true; the manager UI passes it on the 2nd step). */
  overrideCap?: boolean;
  /** Staff user accountable for a manager-driven reassign (#549). */
  actor?: BookingActor;
  /** Who drove it: 'system' (machine, default) or 'admin' (manager UI, #546). */
  initiator?: BookingEventInitiator;
  /** Allow a target OUTSIDE the bookable pool — manager coverage/escalation
   *  (#546). Default false keeps the machine path bookable-only. */
  allowNonBookable?: boolean;
}

export async function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  deps: BookingDeps,
  opts: ReassignOptions = {},
): Promise<BookingResult & { overCap: boolean }> {
  const { overrideCap = false, actor, initiator = "system", allowNonBookable = false } = opts;
  const ctx = await deps.loadBookingById(bookingId);
  if (!ctx) throw new BookingNotFoundError();
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new BookingNotChangeableError();
  }

  const agent = await deps.getAgentByEmail(agentEmail);
  if (!agent || !agent.email || (!agent.bookable && !allowNonBookable)) {
    throw new AgentNotAvailableError();
  }
  if (agent.id === booking.assigned_user_id) {
    return { booking, manageUrl: manageUrl(deps, booking.manage_token), overCap: false };
  }

  // Daily-cap awareness (#reassign-cap): the cap counts meetings per agent per day.
  // Moving a booking onto a DIFFERENT agent is net-new load for that agent, so the
  // cap applies. We compute it ALWAYS so we can report it; we only BLOCK when the
  // caller hasn't opted to override (the machine contact-owner path passes true).
  let overCap = false;
  if (eventType.daily_cap !== null) {
    const wh = await deps.agentWorkingHours(agent.id);
    const day = DateTime.fromISO(booking.starts_at, { zone: wh.timezone }).startOf("day");
    const dayStartsMs = await deps.agentActiveBookingStartsMs(
      agent.id,
      day.toISO()!,
      day.plus({ days: 1 }).toISO()!,
      booking.id,
    );
    overCap = !isUnderDailyCap(
      dayStartsMs,
      wh.timezone,
      Date.parse(booking.starts_at),
      eventType.daily_cap,
    );
    if (overCap && !overrideCap) {
      throw new DailyCapExceededError(agent.email, day.toISODate()!);
    }
  }

  // Create the event on the TARGET agent FIRST, then swap atomically (#449). We
  // do NOT delete the old event up front from a stale read - that's exactly what
  // orphaned the loser's event in a concurrent distinct-reassign. Instead the
  // swap RETURNS the event it replaced, and we delete that below.
  //
  // P4 (#439): a deterministic client id keyed on the booking, the TARGET agent
  // (deterministicEventId mixes agent.id into the hash, so a cross-agent move
  // can't collide on the target calendar), and the reassignment ordinal (so a
  // later A->B->A move doesn't reuse a tombstoned id). The reassign target is
  // caller-supplied, so a crash-retry recomputes the same id and createEvent
  // reuses the event (Google 409) instead of spawning a duplicate.
  const reassignOrdinal = booking.routing_trace?.reassignments?.length ?? 0;
  const gcalClientId = await deterministicEventId(
    `reassign:${booking.id}:${reassignOrdinal}`,
    agent.id,
  );
  const newEventId = await deps.createEvent(
    agent.email,
    {
      summary: `${eventType.name}${
        booking.attendee_name ? ` with ${booking.attendee_name}` : ""
      }`,
      start: booking.starts_at,
      end: booking.ends_at,
      timezone: booking.timezone,
      attendeeEmail: booking.attendee_email ?? undefined,
      attendeeName: booking.attendee_name ?? undefined,
    },
    gcalClientId,
  );

  // The reassignment audit record is appended server-side in reassign_booking_swap
  // under the row lock (#519): building the final array here off a snapshot read
  // before the swap would let two concurrent reassigns overwrite each other's
  // history entry. We pass only a BASE trace to seed the row if it has none; the
  // swap derives the record (from = the genuinely-current agent under the lock,
  // to = this target, at = now) and appends it onto the row's own current history.
  const baseTrace: RoutingTrace = booking.routing_trace ?? {
    bucket_code: bucket.code,
    bucket_id: bucket.id,
    considered: [],
    chosen_user_id: booking.assigned_user_id ?? "",
    fallback_applied: false,
    reassignments: [],
  };
  // Captured BEFORE the swap for the returned object's local trace view: the
  // agent we're moving away from, as this caller saw it.
  const fromUserId = booking.assigned_user_id;

  let swap: {
    prevGcalEventId: string | null;
    prevAgentEmail: string | null;
    updated: boolean;
  };
  try {
    swap = await deps.reassignSwap({
      bookingId: booking.id,
      userId: agent.id,
      agentName: agent.name,
      agentEmail: agent.email,
      gcalEventId: newEventId,
      routingTrace: baseTrace,
    });
  } catch (err) {
    // The swap (durable anchor) failed: clean up the event we optimistically
    // created so it isn't orphaned, then surface the failure.
    await deleteEventBestEffort(deps, agent.email, newEventId, booking.id);
    throw err;
  }

  if (!swap.updated) {
    // The booking went terminal (cancelled/completed) concurrently. Clean up the
    // event we optimistically created so it isn't orphaned, then surface it.
    await deleteEventBestEffort(deps, agent.email, newEventId, booking.id);
    throw new BookingNotChangeableError();
  }

  // Delete the event the swap REPLACED - the genuinely-current one at swap time,
  // not the stale read - so no calendar event is ever left dangling. Skip when a
  // same-target re-submit reused the same event id (deterministic id => Google
  // 409 reuse): deleting it would remove the live event.
  if (
    swap.prevAgentEmail &&
    swap.prevGcalEventId &&
    swap.prevGcalEventId !== newEventId
  ) {
    await deleteEventBestEffort(deps, swap.prevAgentEmail, swap.prevGcalEventId, booking.id);
  }

  const updated = {
    ...booking,
    assigned_user_id: agent.id,
    agent_name: agent.name,
    agent_email: agent.email,
    gcal_event_id: newEventId,
    status: "rescheduled" as const,
    allow_double_book: true,
    // Best-effort local view of the trace for the returned object (the swap owns
    // the authoritative append server-side, #519; this value is not surfaced to
    // any response, so a concurrent racer's extra entry not shown here is fine).
    routing_trace: {
      ...baseTrace,
      reassignments: [
        ...(baseTrace.reassignments ?? []),
        { from: fromUserId, to: agent.id, at: new Date().toISOString() },
      ],
    },
  };

  // Deliver the post-commit side effects (slot move, recompute, the
  // booking.rescheduled webhook + 'reassigned' history) through the idempotent
  // outbox executor (#429 P3), so a crash here resumes via the drain. The gcal
  // delete-old + create-new above stay inline (create-idempotency is P4). Leased
  // around the inline run so a drain tick can't double-run it. The payload's
  // fromAgentUserId captures the PRE-reassign agent for the history row.
  const steps = reassignOutboxSteps();
  const payload = {
    reasonCode: reason.code,
    reasonDetail: reason.detail,
    initiator,
    fromStartsIso: booking.starts_at,
    fromAgentUserId: booking.assigned_user_id,
    actorUserId: actor?.userId,
    actingAsUserId: actor?.actingAsUserId,
  };
  const outboxId = await deps.enqueueOutbox({
    booking_id: booking.id,
    action: "reassign",
    steps,
    payload,
  });
  await deps.leaseOutbox(outboxId);
  try {
    await runOutboxSteps(
      deps,
      {
        id: outboxId,
        booking_id: booking.id,
        action: "reassign",
        status: "pending",
        steps,
        payload,
        lease_until: null,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        created_at: "",
        updated_at: "",
      },
      OUTBOX_HANDLERS,
    );
  } finally {
    await deps.releaseOutboxLease(outboxId);
  }
  return { booking: updated, manageUrl: manageUrl(deps, booking.manage_token), overCap };
}

/** Cancel a booking by token. Returns true if THIS call transitioned the row
 *  to cancelled, false if it no-op'd an already-cancelled row (idempotent
 *  re-submit, or the losing side of a concurrent double-cancel). Callers that
 *  treat cancel as non-idempotent (the direct API, #398) map false to 404. */
export async function cancelBooking(
  token: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  deps: BookingDeps,
  actor?: BookingActor,
): Promise<boolean> {
  const ctx = await deps.loadBookingContext(token);
  if (!ctx) throw new Error("Booking not found");
  const { booking } = ctx;
  if (booking.status === "cancelled") {
    // Already cancelled (re-submit). Ensure the reason was recorded — a first
    // attempt that flipped the status but died before recording it would lose
    // the mandatory reason (#326). One cancel per booking, so dedupe on action.
    if (!(await deps.hasBookingEvent(booking.id, "cancelled", null))) {
      await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "cancelled",
          initiator,
          reason,
          fromStartsIso: booking.starts_at,
          toStartsIso: null,
          fromAgentUserId: booking.assigned_user_id,
          toAgentUserId: null,
          actorUserId: actor?.userId,
          actingAsUserId: actor?.actingAsUserId,
          nowMs: Date.now(),
        }),
      );
    }
    return false;
  }

  // A completed meeting can't be flipped back to cancelled (#618). That would
  // corrupt show-rate analytics and fire a contradictory booking.cancelled to
  // Regal. For a customer clicking the manage link, reject with a friendly 4xx.
  // Admin/rebook/system callers skip the throw and rely on the status-gated
  // claim below to no-op instead of erroring mid-flow.
  if (initiator === "customer" && !CANCELLABLE_STATUSES.includes(booking.status)) {
    throw new BookingNotCancellableError();
  }

  // Atomically claim the transition BEFORE any side effect (#413). Two cancels
  // racing both read `active` above; the conditional flip lets exactly one win,
  // so the side effects below run once and the loser returns false (404 for the
  // non-idempotent direct API). A failed gcal delete still enqueues (#401), so
  // flipping status first never strands an event.
  if (!(await deps.claimCancellation(booking.id))) return false;

  // Record the cancel's intent durably, then deliver every side effect through
  // the idempotent outbox executor (#429 P3). The row is enqueued right after the
  // claim, so a crash mid-cancel resumes via the /api/cron/outbox drain instead
  // of stranding the gcal event or dropping the webhook. The inline run keeps the
  // happy path's latency; each step is idempotent so inline + drain never double-act.
  const steps = cancelOutboxSteps();
  const payload = {
    reasonCode: reason.code,
    reasonDetail: reason.detail,
    initiator,
    fromStartsIso: booking.starts_at,
    fromAgentUserId: booking.assigned_user_id,
    actorUserId: actor?.userId,
    actingAsUserId: actor?.actingAsUserId,
  };
  const outboxId = await deps.enqueueOutbox({
    booking_id: booking.id,
    action: "cancel",
    steps,
    payload,
  });
  // Lease the row before the inline run so a drain tick firing in the gap can't
  // run the same steps concurrently (which could double-insert history and so
  // double-fire the webhook). Released in finally; a crash leaves the lease to
  // expire so the drain reclaims it.
  await deps.leaseOutbox(outboxId);
  try {
    await runOutboxSteps(
      deps,
      {
        id: outboxId,
        booking_id: booking.id,
        action: "cancel",
        status: "pending",
        steps,
        payload,
        lease_until: null,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        created_at: "",
        updated_at: "",
      },
      OUTBOX_HANDLERS,
    );
  } finally {
    await deps.releaseOutboxLease(outboxId);
  }
  return true;
}

/** Cron sweep: mark finished bookings complete and emit booking.completed. */
export async function completePastBookings(deps: BookingDeps): Promise<number> {
  const due = await deps.loadPastBookingsToComplete();
  if (due.length === 0) return 0;

  // One batched UPDATE for the whole sweep instead of a round-trip per booking
  // (#164). The returned ids are the rows THIS call actually flipped, so an
  // overlapping cron tick that already completed some of them won't re-fire
  // their booking.completed — the receiver can't dedupe a second delivery (#163).
  const transitioned = new Set(
    await deps.completeBookingsIfDue(due.map((d) => d.booking.id)),
  );
  const toFire = due.filter((d) => transitioned.has(d.booking.id));

  // Fan booking.completed out with bounded concurrency rather than a serial
  // await per booking — faster under a backlog, but capped so we don't blow
  // the Worker's simultaneous-connection ceiling.
  await mapWithConcurrency(
    toFire,
    COMPLETION_WEBHOOK_CONCURRENCY,
    ({ booking, bucket, eventType }) =>
      fire(
        deps,
        "booking.completed",
        { ...booking, status: "completed" },
        bucket,
        eventType,
      ),
  );
  return toFire.length;
}

export async function getBookingByToken(
  token: string,
  deps: BookingDeps,
): Promise<BookingContext | null> {
  try {
    return await deps.loadBookingContext(token);
  } catch {
    return null;
  }
}
