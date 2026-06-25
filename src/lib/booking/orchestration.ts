// Relative (not "@/") for the VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { toE164 } from "../phone.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  bookingWindow,
  busyBlockFor,
  bookingEventFrom,
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
import type { BookingEventPayload, BookingReasonMeta } from "@/lib/webhooks/types";
import type {
  Booking,
  BookingEventAction,
  BookingEventInitiator,
  BookingStatus,
  BookingOutbox,
  BookingOutboxInsert,
  Bucket,
  BusyBlock,
  EventType,
  OutboxStep,
  PendingEventDeletion,
  RoutingTrace,
  User,
  WebhookEvent,
} from "@/lib/db/types";

export type { PendingEventDeletion };

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

export type BookingInsert = {
  org_id: string;
  bucket_id: string;
  event_type_id: string;
  assigned_user_id: string;
  agent_name: string | null;
  agent_email: string | null;
  starts_at: string;
  ends_at: string;
  /** Immutable original scheduled time (#300); set = starts/ends at creation. */
  original_starts_at: string;
  original_ends_at: string;
  timezone: string;
  status: "confirmed";
  salesforce_id: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  prefill: Record<string, string>;
  gcal_event_id: string;
  manage_token: string;
  idempotency_key: string | null;
  external_id: string | null;
  routing_trace: RoutingTrace;
};

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
  createEvent(email: string, args: CreateEventArgs): Promise<string>;
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
   * Reschedule idempotency lock. Claims (bookingId, target instant); returns
   * false when a concurrent reschedule to the same target already holds it, so
   * the loser of a double-submit no-ops. Stale locks (from a torn-down Worker)
   * are reclaimable. Released via `releaseReschedule` when the operation ends.
   */
  claimReschedule(bookingId: string, targetStartIso: string): Promise<boolean>;
  releaseReschedule(bookingId: string, targetStartIso: string): Promise<void>;
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

  const { startIso, endIso } = bookingWindow(
    input.startIso,
    eventType.duration_min,
  );

  const { userId, email, candidates } = await assignAgent(
    deps,
    bucket,
    eventType,
    startIso,
    endIso,
  );

  // Snapshot the agent's identity so booking history survives agent deletion.
  const agent = await deps.getUser(userId);
  // Normalize once so the stored row and every webhook carry E.164.
  const phone = toE164(input.attendee.phone);

  // Minted before the event so the invite can carry the manage link.
  const manageToken = deps.newManageToken();

  const gcalEventId = await deps.createEvent(email, {
    summary: `${eventType.name}${
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
    org_id: bucket.org_id,
    bucket_id: bucket.id,
    event_type_id: eventType.id,
    assigned_user_id: userId,
    agent_name: agent.name,
    agent_email: agent.email,
    starts_at: startIso,
    ends_at: endIso,
    // Preserve the original scheduled time immutably; reschedule never moves it.
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
    idempotency_key: idempotencyKey,
    external_id: input.externalId ?? null,
    routing_trace: {
      bucket_code: input.bucketCode,
      bucket_id: bucket.id,
      considered: candidates,
      chosen_user_id: userId,
      // True when the only agent(s) considered were the bucket's fallback.
      fallback_applied:
        bucket.fallback_user_id != null &&
        candidates.length > 0 &&
        candidates.every((id) => id === bucket.fallback_user_id),
    },
  });

  if (!inserted.ok) {
    // Roll back the calendar event so we don't orphan a hold.
    await deleteEventBestEffort(deps, email, gcalEventId, null);
    if (inserted.conflict) {
      // Either a concurrent duplicate of THIS submit won the idempotency race
      // (return their booking), or a different attendee took the slot first
      // (genuinely unavailable). Disambiguate by the idempotency key.
      if (idempotencyKey) {
        const winner = await deps.findBookingByIdempotencyKey(idempotencyKey);
        if (winner) {
          return { booking: winner, manageUrl: manageUrl(deps, winner.manage_token) };
        }
      }
      throw new SlotUnavailableError();
    }
    throw new Error("Failed to persist booking");
  }
  const booking = inserted.booking;

  // Write-through: the cache reflects this booking immediately.
  await deps.insertBusyBlock(busyBlockFor(userId, startIso, endIso, booking.id));
  await deps.invalidateSlots(bucket.code);

  await fire(deps, "booking.created", booking, bucket, eventType);

  return { booking, manageUrl: manageUrl(deps, manageToken) };
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
    return { booking, manageUrl: manageUrl(deps, token) };
  }

  // Idempotency guard 2 — concurrent duplicate: claim a short-lived lock on
  // (booking, target). The loser of a simultaneous double-submit returns
  // without redoing the Google move or re-emitting booking.rescheduled; the
  // lock WINNER records the reason event in applyReschedule.
  if (!(await deps.claimReschedule(booking.id, startIso))) {
    return { booking, manageUrl: manageUrl(deps, token) };
  }

  try {
    return await applyReschedule(deps, token, ctx, startIso, endIso, reason, initiator);
  } finally {
    await deps.releaseReschedule(booking.id, startIso);
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
): Promise<BookingResult> {
  const { booking, bucket, eventType } = ctx;
  const currentEmail = booking.agent_email;
  // Capture the pre-move time + agent for the history row before we mutate.
  const fromStartsIso = booking.starts_at;
  const fromAgentUserId = booking.assigned_user_id;

  // Prefer keeping the same agent if they're free at the new time.
  let assigned: string | null = booking.assigned_user_id;
  let agentName = booking.agent_name;
  let agentEmail = booking.agent_email;
  if (currentEmail && (await deps.isFree(currentEmail, startIso, endIso))) {
    await deps.updateEventTime(
      currentEmail,
      booking.gcal_event_id!,
      startIso,
      endIso,
      booking.timezone,
    );
  } else {
    // Reassign via round-robin; create a fresh event, drop the old one.
    const next = await assignAgent(deps, bucket, eventType, startIso, endIso);
    assigned = next.userId;
    const newAgent = await deps.getUser(next.userId);
    agentName = newAgent.name;
    agentEmail = newAgent.email;
    if (currentEmail && booking.gcal_event_id) {
      await deleteEventBestEffort(deps, currentEmail, booking.gcal_event_id, booking.id);
    }
    const newEventId = await deps.createEvent(next.email, {
      summary: `${eventType.name}${
        booking.attendee_name ? ` with ${booking.attendee_name}` : ""
      }`,
      description: eventDescription(
        booking.attendee_phone,
        manageUrl(deps, token),
      ),
      start: startIso,
      end: endIso,
      timezone: booking.timezone,
      attendeeEmail: booking.attendee_email ?? undefined,
      attendeeName: booking.attendee_name ?? undefined,
    });
    await deps.updateBooking(booking.id, { gcal_event_id: newEventId });
    booking.gcal_event_id = newEventId;
  }

  if (!assigned) throw new SlotUnavailableError();

  await deps.updateBooking(booking.id, {
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled",
  });

  // Move the write-through busy block atomically (#429 P3): one statement, so a
  // crash between delete and insert can't leave the slot momentarily free.
  await deps.moveBusyBlock(assigned, startIso, endIso, booking.id);
  await deps.invalidateSlots(bucket.code);

  // Append the immutable history row (#326/#300) before the webhook fires, so
  // the reason is durable even if delivery fails.
  const bookingEventId = await deps.insertBookingEvent(
    bookingEventFrom({
      bookingId: booking.id,
      action: "rescheduled",
      initiator,
      reason,
      fromStartsIso,
      toStartsIso: startIso,
      fromAgentUserId,
      toAgentUserId: assigned,
      nowMs: Date.now(),
    }),
  );

  const updated = {
    ...booking,
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled" as const,
  };
  await fire(deps, "booking.rescheduled", updated, bucket, eventType, reasonMeta(reason, initiator), bookingEventId);

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
  const newEventId = await deps.createEvent(agent.email, {
    summary: `${eventType.name}${
      booking.attendee_name ? ` with ${booking.attendee_name}` : ""
    }`,
    start: booking.starts_at,
    end: booking.ends_at,
    timezone: booking.timezone,
    attendeeEmail: booking.attendee_email ?? undefined,
    attendeeName: booking.attendee_name ?? undefined,
  });

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

  // Atomic move (#429 P3): delete-by-booking + insert in one statement.
  await deps.moveBusyBlock(agent.id, booking.starts_at, booking.ends_at, booking.id);
  await deps.invalidateSlots(bucket.code);

  // History row: action 'reassigned' (NOT 'rescheduled') so reschedule-rate
  // reporting reads booking_events.action and isn't inflated by reassignments,
  // even though this still emits booking.rescheduled to preserve the Regal
  // contract. Same time, agent change only. Initiator is the system automation.
  const bookingEventId = await deps.insertBookingEvent(
    bookingEventFrom({
      bookingId: booking.id,
      action: "reassigned",
      initiator: "system",
      reason,
      fromStartsIso: booking.starts_at,
      toStartsIso: booking.starts_at,
      fromAgentUserId: booking.assigned_user_id,
      toAgentUserId: agent.id,
      nowMs: Date.now(),
    }),
  );

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
  await fire(
    deps,
    "booking.rescheduled",
    updated,
    bucket,
    eventType,
    reasonMeta(reason, "system"),
    bookingEventId,
  );
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
