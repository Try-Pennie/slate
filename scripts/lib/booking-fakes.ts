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
} from "../../src/lib/booking/orchestration.ts";
import type { WorkingRule } from "../../src/lib/availability/compute.ts";
import type {
  Booking,
  Bucket,
  EventType,
  User,
  BookingReservation,
  RoutingTrace,
} from "../../src/lib/db/types.ts";
import { EventGone } from "../../src/lib/booking/core.ts";

/**
 * Per-file assertion counter. Each suite is its own process (the runner spawns
 * one per file and reads the exit code), so each owns its failure count and
 * calls finish() to report and exit.
 */
export function createAsserter() {
  let failures = 0;
  const assert = (cond: boolean, msg: string) => {
    if (!cond) {
      console.error("FAIL:", msg);
      failures++;
    } else console.log("ok:", msg);
  };
  const finish = () => {
    console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  };
  return { assert, finish };
}
export const bucket = { id: "bkt1", org_id: "org1", code: "411" } as unknown as Bucket;
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
    attendee_email: "k@x.com",
    attendee_phone: "+12035615295",
    prefill: {},
    ...over,
  } as unknown as Booking;
}

export interface FakeOpts {
  candidates?: string[];
  freeEmails?: Set<string>;
  insertBookingFails?: boolean;
  insertBookingConflict?: boolean;
  existingByKey?: Booking | null; // idempotency hit on the pre-check
  conflictWinner?: Booking | null; // booking found by key AFTER an insert conflict
  reservation?: BookingReservation | null; // loadReservationByKey (re-submit resume)
  reservationWinner?: BookingReservation; // insertReservation returns this (race adopt)
  drainableReservations?: BookingReservation[]; // the create-reservation drain
  existing?: BookingContext | null;
  bookingById?: BookingContext | null; // loadBookingById (reassign)
  agentByEmail?: User | null; // getAgentByEmail (reassign)
  pastDue?: BookingContext[];
  // Successive completion-sweep batches for the drain loop (#871): each call to
  // loadPastBookingsToComplete returns the next batch (empty once exhausted),
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
  unknownBucket?: boolean; // resolveBucketByCode returns null (#358)
  testBucket?: boolean; // resolveBucketByCode returns an is_test bucket (#396)
  listResult?: { rows: Booking[]; buckets: Bucket[] }; // queryBookings result (#392)
  deleteEventThrows?: boolean;
  deleteGcalMirrorThrows?: boolean; // deleteGcalMirrorBlock rejects (best-effort heal, #586)
  pending?: PendingEventDeletion[]; // loadPendingEventDeletions result (#401)
  reassignSwapTerminal?: boolean; // reassign_booking_swap returns updated=false (#449)
  reassignSwapThrows?: boolean; // reassign_booking_swap rejects (rpc/network error) (#449)
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
}

// Default fake working hours: Mon-Fri 09:00-17:00 America/New_York. Covers every
// existing in-place reschedule target so the #527 guard is a no-op for them; the
// #527 tests override it per-agent to model an off-shift / on-shift new time.
export const DEFAULT_WORKING_HOURS: { timezone: string; rules: WorkingRule[] } = {
  timezone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
};

export function makeDeps(opts: FakeOpts) {
  // Cursor into opts.pastDueBatches for the completion drain loop (#871).
  let pastBatchIdx = 0;
  const calls = {
    loadPastBookingsToComplete: 0,
    busyIntervalsForAgent: [] as string[],
    agentActiveBookingStartsMs: [] as { userId: string; excludeBookingId: string }[],
    agentWorkingHours: [] as string[],
    verifyFree: [] as string[][],
    createEvent: [] as { email: string; clientId?: string }[],
    deleteEvent: [] as { id: string }[],
    enqueueEventDeletion: [] as { email: string; eventId: string; bookingId: string | null }[],
    updateEventTime: [] as { id: string }[],
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
    }[],
    claimCancellation: [] as string[],
    completeBookingsIfDue: [] as string[][],
    reservations: [] as { idempotency_key: string; pinned_user_id: string; gcal_client_id: string }[],
    deletedReservations: [] as string[],
    reservationBumps: [] as { id: string; attempts: number; lastError: string }[],
    reassignSwaps: [] as {
      bookingId: string;
      userId: string;
      gcalEventId: string;
      gcalClientId: string;
      prevGcal: string | null;
    }[],
    webhooks: [] as {
      event: string;
      reason: unknown;
      dedupeKey: string | null;
      bucket_code: string | undefined;
      suppressed: boolean;
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
    claimReschedule: 0,
    releaseReschedule: 0,
    invalidateSlots: [] as string[],
    roundRobinPreview: [] as (boolean | undefined)[],
    queryBookings: [] as unknown[],
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
  };
  let seq = 0;
  let insertAttempted = false;
  // Mirror Google's deterministic-client-id behavior: a repeat insert with the
  // same client id returns the SAME event (409-as-success reuse), not a second.
  const gcalByClientId = new Map<string, string>();
  // In-memory reschedule_locks table for the per-booking lease state machine.
  const RESCHEDULE_TTL = 2 * 60 * 1000;
  const locks = new Map<string, { target: string; leaseUntilMs: number; pin: ReschedulePin | null }>();
  if (opts.heldLease && opts.existing) {
    locks.set(opts.existing.booking.id, {
      target: opts.heldLease.target,
      leaseUntilMs: opts.heldLease.expired ? Date.now() - 1000 : Date.now() + RESCHEDULE_TTL,
      pin: opts.heldLease.pin ?? null,
    });
  }
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
  const deps: BookingDeps = {
    resolveBucketByCode: async () =>
      opts.unknownBucket
        ? null
        : {
            bucket: opts.testBucket ? ({ ...bucket, is_test: true } as Bucket) : bucket,
            eventType,
          },
    roundRobinCandidates: async (_b, _e, _ms, preview) => {
      calls.roundRobinPreview.push(preview);
      return opts.candidates ?? ["a"];
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
    verifyFree: async (emails, startIso, endIso) => {
      calls.verifyFree.push(emails);
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
    createEvent: async (email, _args, clientId) => {
      calls.createEvent.push({ email, clientId });
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
    enqueueEventDeletion: async (email, eventId, bookingId) => {
      calls.enqueueEventDeletion.push({ email, eventId, bookingId });
    },
    updateEventTime: async (_email, id) => {
      calls.updateEventTime.push({ id });
      if (opts.updateEventTimeGone) throw new EventGone("events.patch"); // #617
      fireConcurrent(); // #615: a concurrent cancel/reassign lands mid-PATCH
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
    findBookingByIdempotencyKey: async () =>
      (insertAttempted ? opts.conflictWinner : opts.existingByKey) ?? null,
    insertBooking: async (row) => {
      insertAttempted = true;
      if (opts.insertBookingConflict) return { ok: false, conflict: true };
      if (opts.insertBookingFails) return { ok: false, conflict: false };
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
    }) => {
      if (opts.reassignSwapThrows) throw new Error("rpc down");
      const ctx = [opts.bookingById, opts.existing].find((c) => c?.booking?.id === bookingId);
      const prev = ctx?.booking;
      // Model a concurrent cancellation between load and swap, or a terminal row.
      if (!prev || opts.reassignSwapTerminal || prev.status === "cancelled" || prev.status === "completed") {
        return { prevGcalEventId: null, prevAgentEmail: null, updated: false };
      }
      const prevGcal = prev.gcal_event_id ?? null;
      const prevEmail = prev.agent_email ?? null;
      calls.reassignSwaps.push({ bookingId, userId, gcalEventId, gcalClientId, prevGcal });
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
        status: "rescheduled",
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
    commitReschedule: async (id, patch, guard) => {
      calls.commitReschedule.push({ id, patch: patch as Record<string, unknown>, guard });
      const live =
        opts.existing?.booking?.id === id
          ? opts.existing.booking
          : [opts.bookingById].find((c) => c?.booking?.id === id)?.booking;
      if (!live) return false;
      const active = live.status === "confirmed" || live.status === "rescheduled";
      const assigneeOk = (live.assigned_user_id ?? null) === guard.assignedUserId;
      const gcalOk = (live.gcal_event_id ?? null) === guard.gcalEventId;
      if (!(active && assigneeOk && gcalOk)) return false;
      for (const c of [opts.bookingById, opts.existing]) {
        if (c?.booking && c.booking.id === id) Object.assign(c.booking, patch);
      }
      return true;
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
      locks.delete(bookingId);
    },
    loadAbandonedReschedulePins: async () => opts.abandonedPins ?? [],
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
    loadBookingContext: async () => opts.existing ?? null,
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
    enqueueOutbox: async () => "ob-test",
    leaseOutbox: async () => true,
    releaseOutboxLease: async () => {},
    saveOutboxSteps: async () => {},
    markOutboxDelivered: async () => {},
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
    },
    loadDrainableReservations: async () => opts.drainableReservations ?? [],
    leaseReservation: async () => true,
    releaseReservationLease: async () => {},
    bumpReservationAttempt: async (id: string, attempts: number, lastError: string) => {
      calls.reservationBumps.push({ id, attempts, lastError });
    },
    deleteExpiredReservations: async () => {},
    findActiveBookingsForPerson: async () => opts.personBookings ?? [],
    queryBookings: async (filter) => {
      calls.queryBookings.push(filter);
      return opts.listResult ?? { rows: [], buckets: [] };
    },
    getAgentByEmail: async () => opts.agentByEmail ?? null,
    loadPastBookingsToComplete: async () => {
      // Drain loop (#871): hand back one batch per call when batches are given,
      // else the single static list. `calls.loadPastBookingsToComplete` counts
      // invocations so a test can prove the loop stopped (didn't re-fetch).
      calls.loadPastBookingsToComplete += 1;
      if (opts.pastDueBatches) {
        return opts.pastDueBatches[pastBatchIdx++] ?? [];
      }
      return opts.pastDue ?? [];
    },
    emitWebhook: async (_orgId, event, payload, dedupeKey, suppressed = false) => {
      calls.webhooks.push({
        event,
        reason: payload.reason,
        dedupeKey,
        bucket_code: payload.bucket_code,
        suppressed,
      });
    },
    newManageToken: () => "tok-fixed",
    newIdempotencyKey: () => "anon-fixed", // synthetic key for keyless bookings (#666)
    appBaseUrl: () => "https://slate.test",
    invalidateSlots: async (bucketCode) => {
      calls.invalidateSlots.push(bucketCode);
    },
    loadPendingEventDeletions: async (_limit) => opts.pending ?? [],
    removePendingEventDeletion: async (id) => { calls.removePendingEventDeletion.push(id); },
    bumpPendingEventDeletion: async (id, attempts) => { calls.bumpPendingEventDeletion.push({ id, attempts }); },
  };
  // Test helper: expire a booking's reschedule lease so the next claim treats the
  // holder as crashed (resume / fresh-after-abandon), per #471's crash scenarios.
  const expireLease = (bookingId: string): void => {
    const l = locks.get(bookingId);
    if (l) l.leaseUntilMs = Date.now() - 1000;
  };
  return { deps, calls, expireLease };
}

// Validated reasons for the changed reschedule/cancel/reassign signatures.
export const RR = { code: "schedule_conflict", detail: null }; // reschedule
// Fixed "now" for reschedule tests: well before the 2026-06-08+ fixture dates, so
// the #536 min-notice guard treats those (future-relative-to-now) slots as valid.
export const NOW = Date.parse("2026-06-01T00:00:00.000Z");
export const CR = { code: "no_longer_interested", detail: null }; // cancel
export const SYS = { code: "owner_reassignment", detail: null }; // reassign (system)

