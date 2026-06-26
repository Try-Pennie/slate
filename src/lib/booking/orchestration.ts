// Relative (not "@/") for the VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { toE164 } from "../phone.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  bookingWindow,
  busyBlockFor,
  bookingEventFrom,
  deterministicEventId,
  eventDescription,
  idempotencyKeyFor,
  selectAgent,
  type AssignResult,
  type BusyBlockInsert,
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
  /** Single-agent free check — used by reschedule to keep the same agent. */
  isFree(email: string, startIso: string, endIso: string): Promise<boolean>;
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
  deleteBusyBlocksForBooking(bookingId: string): Promise<void>;
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
  /** Retention: delete up to `limit` pending reservations older than the cutoff
   *  (abandoned rows whose booking never completed). */
  deleteExpiredReservations(olderThanIso: string, limit: number): Promise<void>;
  updateBooking(bookingId: string, patch: BookingUpdate): Promise<void>;
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
  ): Promise<boolean>;
  /** The id of an existing history row for (booking, action, target), or null.
   *  Lets the idempotent outbox notify step reuse the same webhook dedupe key on
   *  a drain re-run instead of inserting a duplicate history row (#429 P3). */
  getBookingEventId(
    bookingId: string,
    action: BookingEventAction,
    toStartsIso: string | null,
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
    // Versioned by to_starts_at: a later reschedule to a different time gets a
    // fresh history row + dedupe key, so its webhook isn't swallowed.
    let eventId = await deps.getBookingEventId(booking.id, "rescheduled", toStartsIso);
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
    // Record the override audit row (action 'reassigned'). Not guarded for
    // idempotent resume because a reassign has no natural per-operation key in
    // booking_events; a duplicate on the rare within-step crash is acceptable
    // (audit only). The webhook below stays exactly-once via the row-id key.
    await deps.insertBookingEvent(
      bookingEventFrom({
        bookingId: booking.id,
        action: "reassigned",
        initiator: "system",
        reason,
        fromStartsIso: booking.starts_at,
        toStartsIso: booking.starts_at,
        fromAgentUserId: p.fromAgentUserId ?? null,
        toAgentUserId: booking.assigned_user_id,
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
      reasonMeta(reason, "system"),
      row.id,
    );
  },
};

function manageUrl(deps: BookingDeps, token: string): string {
  return `${deps.appBaseUrl()}/booking/manage/${token}`;
}

/** Max simultaneous booking.completed deliveries (Cloudflare subrequest cap). */
const COMPLETION_WEBHOOK_CONCURRENCY = 6;

export async function createBooking(
  input: CreateBookingInput,
  deps: BookingDeps,
): Promise<BookingResult> {
  const idempotencyKey =
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
  if (idempotencyKey) {
    const existing = await deps.findBookingByIdempotencyKey(idempotencyKey);
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

  // Anonymous bookings (no email/phone/salesforceId → no stable key) can't be
  // pinned, so they keep the legacy non-crash-safe create (accepted gap, #439).
  if (!idempotencyKey) {
    return legacyCreateBooking(deps, input, bucket, eventType);
  }

  // Resume an in-flight reservation: a re-submit after a crash mid-create reuses
  // the SAME pinned agent + event id instead of re-running assignAgent (which
  // could land on a different agent and duplicate the calendar event).
  const inFlight = await deps.loadReservationByKey(idempotencyKey);
  if (inFlight) return completeReservation(deps, inFlight);

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

  // Already completed (a resume after insert but before the reservation was
  // deleted): return the booking, clean up the reservation.
  if (key) {
    const already = await deps.findBookingByIdempotencyKey(key);
    if (already) {
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

  await deps.insertBusyBlock(
    busyBlockFor(reservation.pinned_user_id, bookingInsert.starts_at, bookingInsert.ends_at, booking.id),
  );
  await deps.invalidateSlots(bucketCode);

  // Re-resolve bucket + eventType for the webhook (works on the drain path too).
  const resolved = await deps.resolveBucketByCode(bucketCode);
  if (resolved) {
    await fire(deps, "booking.created", booking, resolved.bucket, resolved.eventType);
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

/** The pre-#429-P4 create: event-then-insert with best-effort rollback. Kept for
 *  anonymous bookings that have no idempotency key to pin a reservation by. */
async function legacyCreateBooking(
  deps: BookingDeps,
  input: CreateBookingInput,
  bucket: Bucket,
  eventType: EventType,
): Promise<BookingResult> {
  let legacyTier: TierAssignResult;
  try {
    legacyTier = await assignAgentWithTierFallback(deps, { bucket, eventType }, input.startIso, input.allowTestBuckets ?? false);
  } catch (err) {
    // Best-effort: record no-booking attempts. Awaited so the write is not dropped
    // by the CF runtime; try/catch ensures the original error still propagates.
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
  const bookedBucket = legacyTier.bucket;
  const bookedEventType = legacyTier.eventType;
  const startIso = legacyTier.startIso;
  const endIso = legacyTier.endIso;
  const { userId, email, candidates } = legacyTier;
  const agent = await deps.getUser(userId);
  let legacyTraceExtras: ReturnType<typeof buildRoutingTraceExtras> = {
    considered: candidates,
    excluded: [],
  };
  try {
    const legacyPool = await resolveBucketPool(bookedBucket);
    legacyTraceExtras = buildRoutingTraceExtras(legacyPool, candidates);
  } catch {
    // best-effort: a transient pool-resolve failure must not fail the booking
  }
  const phone = toE164(input.attendee.phone);
  const manageToken = deps.newManageToken();

  const gcalEventId = await deps.createEvent(email, {
    summary: `${bookedEventType.name}${
      input.attendee.name ? ` with ${input.attendee.name}` : ""
    }`,
    description: eventDescription(phone, manageUrl(deps, manageToken)),
    start: startIso,
    end: endIso,
    timezone: input.timezone,
    attendeeEmail: input.attendee.email,
    attendeeName: input.attendee.name,
  });
  const inserted = await deps.insertBooking({
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
    gcal_event_id: gcalEventId,
    manage_token: manageToken,
    idempotency_key: null,
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
      excluded: legacyTraceExtras.excluded,
      tier_fallback: legacyTier.rungsDropped > 0,
      requested_tier: tierKeyOf(input.bucketCode),
      booked_tier: tierKeyOf(bookedBucket.code),
      rungs_dropped: legacyTier.rungsDropped,
    },
  });

  if (!inserted.ok) {
    await deleteEventBestEffort(deps, email, gcalEventId, null);
    if (inserted.conflict) throw new SlotUnavailableError();
    throw new Error("Failed to persist booking");
  }
  const booking = inserted.booking;
  await deps.insertBusyBlock(busyBlockFor(userId, startIso, endIso, booking.id));
  await deps.invalidateSlots(bookedBucket.code);
  await fire(deps, "booking.created", booking, bookedBucket, bookedEventType);
  // Best-effort routing decision log (agent already loaded above). Awaited so the
  // write is not dropped by the CF runtime; recordRoutingDecision never throws.
  await recordRoutingDecision({
    orgId: booking.org_id,
    bookingId: booking.id,
    bucketCode: bookedBucket.code,
    bucketId: bookedBucket.id,
    criteria: bookedBucket.criteria,
    considered: candidates,
    excluded: legacyTraceExtras.excluded,
    chosenUserId: userId,
    chosenAttributes: agent.attributes,
    emptyPoolFallback:
      bookedBucket.fallback_user_id != null &&
      candidates.length > 0 &&
      candidates.every((id) => id === bookedBucket.fallback_user_id),
    tierFallback: legacyTier.rungsDropped > 0,
    rungsDropped: legacyTier.rungsDropped,
    requestedTier: tierKeyOf(input.bucketCode),
    bookedTier: tierKeyOf(bookedBucket.code),
    outcome: "booked",
  });
  // Best-effort tier-drop alert.
  const legacyTierAlert = tierFallbackAlert({
    requestedCode: input.bucketCode,
    effectiveCode: booking.routing_trace?.bucket_code ?? input.bucketCode,
    rungsDropped: Math.max(0, booking.routing_trace?.rungs_dropped ?? 0),
  });
  if (legacyTierAlert) {
    await sendThrottledAlert(legacyTierAlert.key, legacyTierAlert.cooldownMs, legacyTierAlert.text).catch(() => {});
  }
  return { booking, manageUrl: manageUrl(deps, manageToken) };
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
): Promise<{ processed: number; completed: number; failed: number }> {
  const rows = await deps.loadDrainableReservations(limit);
  let completed = 0;
  let failed = 0;
  for (const reservation of rows) {
    if (!(await deps.leaseReservation(reservation.id))) continue;
    try {
      await completeReservation(deps, reservation);
      completed++;
    } catch {
      // completeReservation deletes the row on a genuine SlotUnavailable; a
      // transient failure leaves it pending — release the lease so we retry.
      failed++;
      await deps.releaseReservationLease(reservation.id);
    }
  }
  return { processed: rows.length, completed, failed };
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
      return { outcome: "rescheduled", booking: res.booking, manageUrl: res.manageUrl };
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
    if (!(await deps.hasBookingEvent(booking.id, "rescheduled", startIso))) {
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
    return await applyReschedule(deps, token, ctx, startIso, endIso, reason, initiator, claim);
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
): Promise<BookingResult> {
  const { booking, bucket, eventType } = ctx;
  const currentEmail = booking.agent_email;
  // Capture the pre-move time + agent for the history row before we mutate.
  const fromStartsIso = booking.starts_at;
  const fromAgentUserId = booking.assigned_user_id;

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

    // Branch decision — the ONLY place isFree / assignAgent run, and only on a
    // FRESH attempt. A resume never reaches here, so a poisoned freeBusy can't
    // flip a same-agent move to a new agent (window b).
    if (currentEmail && booking.assigned_user_id && (await deps.isFree(currentEmail, startIso, endIso))) {
      pin = {
        reschedule_seq: seq,
        branch: "in_place",
        pinned_user_id: booking.assigned_user_id,
        pinned_agent_email: currentEmail,
        gcal_client_id: booking.gcal_event_id!, // in-place re-PATCHes the existing event
        target_starts_at: startIso,
      };
    } else {
      const next = await assignAgent(deps, bucket, eventType, startIso, endIso);
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
    await deps.updateEventTime(pin.pinned_agent_email, pin.gcal_client_id, startIso, endIso, booking.timezone);
    newGcalEventId = pin.gcal_client_id;
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
  await deps.updateBooking(booking.id, {
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled",
    gcal_event_id: newGcalEventId,
    reschedule_seq: pin.reschedule_seq,
  });
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
        created_at: "",
        updated_at: "",
      },
      OUTBOX_HANDLERS,
    );
  } finally {
    await deps.releaseOutboxLease(outboxId);
  }

  return { booking: updated, manageUrl: manageUrl(deps, token) };
}

/**
 * Reassign a booking to a specific owning agent (the contact-owner override,
 * #9). The caller (an upstream automation) has already decided this lead should
 * stick to this agent, so this is FORCED: the agent is booked at the same time
 * even if busy. It's the ONLY path that double-books — the booking is marked
 * `allow_double_book` so the active-slot unique index lets it stack. Throws
 * "Booking not found" / "Agent not found or not bookable" for the caller to map.
 */
export async function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  deps: BookingDeps,
): Promise<BookingResult> {
  const ctx = await deps.loadBookingById(bookingId);
  if (!ctx) throw new Error("Booking not found");
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

  const agent = await deps.getAgentByEmail(agentEmail);
  if (!agent || !agent.bookable || !agent.email) {
    throw new Error("Agent not found or not bookable");
  }
  if (agent.id === booking.assigned_user_id) {
    return { booking, manageUrl: manageUrl(deps, booking.manage_token) };
  }

  // Move the calendar event to the owning agent at the same time. No free check:
  // this path intentionally double-books, gated only by `allow_double_book`.
  if (booking.agent_email && booking.gcal_event_id) {
    await deleteEventBestEffort(deps, booking.agent_email, booking.gcal_event_id, booking.id);
  }
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

  // Record the override on the trace so the viewer can show who reassigned whom.
  const reassignment = {
    from: booking.assigned_user_id,
    to: agent.id,
    at: new Date().toISOString(),
  };
  const nextTrace: RoutingTrace = booking.routing_trace
    ? {
        ...booking.routing_trace,
        reassignments: [...(booking.routing_trace.reassignments ?? []), reassignment],
      }
    : {
        bucket_code: bucket.code,
        bucket_id: bucket.id,
        considered: [],
        chosen_user_id: booking.assigned_user_id ?? "",
        fallback_applied: false,
        reassignments: [reassignment],
      };

  await deps.updateBooking(booking.id, {
    assigned_user_id: agent.id,
    agent_name: agent.name,
    agent_email: agent.email,
    gcal_event_id: newEventId,
    status: "rescheduled",
    allow_double_book: true,
    routing_trace: nextTrace,
  });

  const updated = {
    ...booking,
    assigned_user_id: agent.id,
    agent_name: agent.name,
    agent_email: agent.email,
    gcal_event_id: newEventId,
    status: "rescheduled" as const,
    allow_double_book: true,
    routing_trace: nextTrace,
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
    initiator: "system" as const,
    fromStartsIso: booking.starts_at,
    fromAgentUserId: booking.assigned_user_id,
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
        created_at: "",
        updated_at: "",
      },
      OUTBOX_HANDLERS,
    );
  } finally {
    await deps.releaseOutboxLease(outboxId);
  }
  return { booking: updated, manageUrl: manageUrl(deps, booking.manage_token) };
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
          nowMs: Date.now(),
        }),
      );
    }
    return false;
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
