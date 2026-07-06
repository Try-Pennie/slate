// Orchestration tests for the booking flow, driven through in-memory fakes of
// BookingDeps (no DB/Google). Covers verify-on-book, calendar rollback on
// persist failure, RR-pointer advancement, reschedule branches, cancel
// idempotency, completion, and webhook emission.
// Run: node --experimental-strip-types scripts/test-booking-orchestration.ts
import {
  createBooking,
  rescheduleBooking,
  cancelBooking,
  completePastBookings,
  reassignBooking,
  bookViaApi,
  previewBooking,
  lookupPersonBookings,
  getPersonBookingById,
  cancelDirectBooking,
  listBookings,
  processPendingEventDeletions,
  OUTBOX_HANDLERS,
  processBookingReservations,
  processAbandonedReschedulePins,
  cancelOutboxSteps,
  rescheduleOutboxSteps,
  reassignOutboxSteps,
  PENDING_DELETION_ALERT_AFTER,
  BookingNotFoundError,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  type BookingDeps,
  type BookingContext,
  type ReschedulePin,
  type AbandonedReschedulePin,
  type CreateBookingInput,
  type ApiBookingInput,
  type ApiBookingListItem,
  type PendingEventDeletion,
} from "../src/lib/booking/orchestration.ts";
import { runOutboxSteps } from "../src/lib/booking/outbox.ts";
import type { WorkingRule } from "../src/lib/availability/compute.ts";
import type {
  Booking,
  Bucket,
  EventType,
  User,
  BookingOutbox,
  BookingReservation,
} from "../src/lib/db/types.ts";
import { EventGone } from "../src/lib/booking/core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const bucket = { id: "bkt1", org_id: "org1", code: "411" } as unknown as Bucket;
const eventType = {
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
const users: Record<string, User> = {
  a: { id: "a", name: "Agent A", email: "a@x.com" } as unknown as User,
  b: { id: "b", name: "Agent B", email: "b@x.com" } as unknown as User,
};

const input: CreateBookingInput = {
  bucketCode: "411",
  startIso: "2026-06-08T13:00:00.000Z",
  timezone: "America/New_York",
  salesforceId: "sf1",
  attendee: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
  prefill: { xbc: "411" },
};

function makeBooking(over: Partial<Booking>): Booking {
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

interface FakeOpts {
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
  // A reschedule lease already held for the booking (#439): models a concurrent
  // holder. `target` = the instant it's reaching for (same as the request ->
  // idempotent no-op; different -> conflict); `expired` = a crashed holder.
  heldLease?: { target: string; expired?: boolean; pin?: ReschedulePin };
  abandonedPins?: AbandonedReschedulePin[]; // for the GC sweep (#476)
  alreadyCompleted?: Set<string>; // ids an overlapping tick already transitioned
  unverifiedEmails?: Set<string>; // emails verify-on-book couldn't check (outage)
  personBookings?: Booking[]; // findActiveBookingsForPerson result (#357)
  unknownBucket?: boolean; // resolveBucketByCode returns null (#358)
  testBucket?: boolean; // resolveBucketByCode returns an is_test bucket (#396)
  listResult?: { rows: Booking[]; buckets: Bucket[] }; // queryBookings result (#392)
  deleteEventThrows?: boolean;
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
  // #617: the in-place PATCH hits a deleted event — updateEventTime raises
  // EventGone so the reschedule recreates the event instead of committing a
  // phantom move.
  updateEventTimeGone?: boolean;
}

// Default fake working hours: Mon-Fri 09:00-17:00 America/New_York. Covers every
// existing in-place reschedule target so the #527 guard is a no-op for them; the
// #527 tests override it per-agent to model an off-shift / on-shift new time.
const DEFAULT_WORKING_HOURS: { timezone: string; rules: WorkingRule[] } = {
  timezone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
};

function makeDeps(opts: FakeOpts) {
  const calls = {
    busyIntervalsForAgent: [] as string[],
    agentActiveBookingStartsMs: [] as { userId: string; excludeBookingId: string }[],
    agentWorkingHours: [] as string[],
    verifyFree: [] as string[][],
    createEvent: [] as { email: string; clientId?: string }[],
    deleteEvent: [] as { id: string }[],
    enqueueEventDeletion: [] as { email: string; eventId: string; bookingId: string | null }[],
    updateEventTime: [] as { id: string }[],
    insertBusyBlock: [] as { user_id: string; starts_at: string; ends_at: string; source: string }[],
    moveBusyBlock: [] as { userId: string; startIso: string; endIso: string; bookingId: string }[],
    deleteBusyBlocks: [] as string[],
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
    reassignSwaps: [] as { bookingId: string; userId: string; gcalEventId: string; prevGcal: string | null }[],
    webhooks: [] as { event: string; reason: unknown; dedupeKey: string | null; bucket_code: string | undefined }[],
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
    insertBusyBlock: async (block) => {
      calls.insertBusyBlock.push(block);
    },
    moveBusyBlock: async (userId, startIso, endIso, bookingId) => {
      calls.moveBusyBlock.push({ userId, startIso, endIso, bookingId });
    },
    reassignSwap: async ({ bookingId, userId, agentName, agentEmail, gcalEventId, routingTrace }) => {
      if (opts.reassignSwapThrows) throw new Error("rpc down");
      const ctx = [opts.bookingById, opts.existing].find((c) => c?.booking?.id === bookingId);
      const prev = ctx?.booking;
      // Model a concurrent cancellation between load and swap, or a terminal row.
      if (!prev || opts.reassignSwapTerminal || prev.status === "cancelled" || prev.status === "completed") {
        return { prevGcalEventId: null, prevAgentEmail: null, updated: false };
      }
      const prevGcal = prev.gcal_event_id ?? null;
      const prevEmail = prev.agent_email ?? null;
      calls.reassignSwaps.push({ bookingId, userId, gcalEventId, prevGcal });
      // Persist so the outbox handlers re-reading after the swap see the new agent.
      Object.assign(prev, {
        assigned_user_id: userId,
        agent_name: agentName,
        agent_email: agentEmail,
        gcal_event_id: gcalEventId,
        status: "rescheduled",
        allow_double_book: true,
        routing_trace: routingTrace,
      });
      return { prevGcalEventId: prevGcal, prevAgentEmail: prevEmail, updated: true };
    },
    deleteBusyBlocksForBooking: async (id) => {
      calls.deleteBusyBlocks.push(id);
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
    // active->cancelled), every later call loses — models the conditional UPDATE.
    claimCancellation: (() => {
      const claimed = new Set<string>();
      return async (id: string) => {
        calls.claimCancellation.push(id);
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
    loadPastBookingsToComplete: async () => opts.pastDue ?? [],
    emitWebhook: async (_orgId, event, payload, dedupeKey) => {
      calls.webhooks.push({ event, reason: payload.reason, dedupeKey, bucket_code: payload.bucket_code });
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
const RR = { code: "schedule_conflict", detail: null }; // reschedule
// Fixed "now" for reschedule tests: well before the 2026-06-08+ fixture dates, so
// the #536 min-notice guard treats those (future-relative-to-now) slots as valid.
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const CR = { code: "no_longer_interested", detail: null }; // cancel
const SYS = { code: "owner_reassignment", detail: null }; // reassign (system)

async function run() {
  // --- createBooking: happy path ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-new", "create returns the persisted booking");
    assert(
      calls.roundRobinPreview.at(-1) !== true,
      "real create routes in NON-preview mode (the shadow study sees only real assignments)",
    );
    assert(
      res.booking.original_starts_at === "2026-06-08T13:00:00.000Z" &&
        res.booking.original_ends_at === "2026-06-08T13:30:00.000Z",
      "create: preserves the original scheduled time on the booking (#300)",
    );
    assert(
      res.manageUrl === "https://slate.test/booking/manage/tok-fixed",
      "manage URL uses base + manage token",
    );
    assert(calls.createEvent.length === 1, "create: one calendar event");
    // #429 P4: reservation-first — pins the agent + a deterministic client id
    // BEFORE the event, then deletes the reservation once the booking persists.
    assert(
      calls.reservations.length === 1 &&
        calls.reservations[0].pinned_user_id === "a" &&
        calls.reservations[0].gcal_client_id.startsWith("slate"),
      "create: writes a reservation pinning the agent + deterministic client id",
    );
    assert(
      calls.deletedReservations.length === 1,
      "create: deletes the reservation on success (delete-on-deliver)",
    );
    // Write-through via moveBusyBlock (delete-by-booking + insert, #429 P3) so the
    // create and a crash-resume are idempotent — a resume can't leave a duplicate
    // block (#613). moveBusyBlock inserts a 'slate' block for the booking.
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].userId === "a" &&
        calls.moveBusyBlock[0].bookingId === "bk-new",
      "create: write-through busy block for the booked agent",
    );
    assert(
      calls.moveBusyBlock[0].startIso === "2026-06-08T13:00:00.000Z" &&
        calls.moveBusyBlock[0].endIso === "2026-06-08T13:30:00.000Z",
      "create: busy block spans the booked slot (30m)",
    );
    assert(calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created", "create: fires booking.created");
    assert(calls.webhooks[0].dedupeKey === res.booking.id, "create: webhook dedupe key is the booking id (#436)");
    assert(calls.deleteEvent.length === 0, "create: no rollback on success");
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "create: invalidates cached slots for the booked bucket exactly once",
    );
  }

  // --- createBooking: a keyless (anonymous) booking is crash-safe too (#666) ---
  // No email/phone/salesforceId and no caller key -> no STABLE idempotency key.
  // Such a booking used to fall through to the legacy path, which fired
  // booking.created inline with no reservation and no outbox: a crash after the
  // insert but before the webhook dropped it permanently, with nothing to
  // redeliver. It must now get the SAME reservation-backed durable net every
  // keyed booking has (a synthesized key), so the drain can resume it.
  {
    const keyless: CreateBookingInput = {
      bucketCode: "411",
      startIso: "2026-06-08T13:00:00.000Z",
      timezone: "America/New_York",
      attendee: { name: "Anon Lead" }, // no email/phone -> idempotencyKeyFor is null
      prefill: {},
    };
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(keyless, deps);
    assert(res.booking.id === "bk-new", "keyless create: returns the persisted booking");
    assert(
      calls.reservations.length === 1,
      "keyless create: writes a reservation (the durable crash-safety net #666)",
    );
    const rk = calls.reservations[0]?.idempotency_key ?? "";
    assert(
      rk.length > 0 && !rk.includes("|"),
      "keyless create: reservation uses a synthesized key, not a derived (email/phone) key",
    );
    assert(
      calls.reservations[0]?.gcal_client_id.startsWith("slate"),
      "keyless create: pins a deterministic Google client id (retry-safe)",
    );
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "keyless create: fires booking.created",
    );
    assert(
      calls.deletedReservations.length === 1,
      "keyless create: deletes the reservation on success (delete-on-deliver)",
    );
  }

  // --- keyless create: crash AFTER insert, BEFORE the webhook is recoverable (#666) ---
  // The failure path: a keyless booking's reservation persisted and the booking
  // inserted, then the process died before booking.created fired. The drain must
  // resume it from the reservation and deliver the previously-lost webhook
  // exactly once -- the exact drop #666 closes for anonymous bookings.
  {
    const already = makeBooking({
      id: "bk-anon",
      salesforce_id: null,
      attendee_email: null,
      attendee_phone: null,
      idempotency_key: "anon_synth_666",
      routing_trace: {
        bucket_code: "411",
        bucket_id: "bkt1",
        considered: ["a"],
        chosen_user_id: "a",
        fallback_applied: false,
      },
    });
    const reservation: BookingReservation = {
      id: "resv-anon",
      idempotency_key: "anon_synth_666",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: null,
          attendee_name: "Anon Lead",
          attendee_email: null,
          attendee_phone: null,
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-anon",
          idempotency_key: "anon_synth_666",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Anon Lead",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    const { deps, calls } = makeDeps({
      drainableReservations: [reservation],
      existingByKey: already, // the booking the crashed attempt already inserted
    });
    const res = await processBookingReservations(deps, 15);
    assert(
      res.processed === 1 && res.completed === 1,
      "#666 drain: resumes the crashed keyless reservation",
    );
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.created" &&
        calls.webhooks[0].dedupeKey === "bk-anon",
      "#666 drain: redelivers the previously-lost booking.created exactly once",
    );
    assert(
      calls.deletedReservations.length === 1 && calls.deletedReservations[0] === "resv-anon",
      "#666 drain: deletes the reservation only after delivering the webhook",
    );
  }

  // --- createBooking: a test bucket is unbookable on the public path (#396) ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      testBucket: true,
    });
    let err: unknown;
    try {
      await createBooking(input, deps); // no allowTestBuckets -> public lead
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof UnknownBucketError,
      "create: public path rejects a test bucket as Unknown (real leads can't book it)",
    );
    assert(
      calls.createEvent.length === 0 && calls.webhooks.length === 0,
      "create: test-bucket rejection happens before any calendar event / webhook",
    );
  }

  // --- createBooking: the authed smoke key CAN book a test bucket (#396) ---
  {
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      testBucket: true,
    });
    const res = await createBooking({ ...input, allowTestBuckets: true }, deps);
    assert(
      res.booking.id === "bk-new",
      "create: allowTestBuckets lets the key-authed smoke test book a test bucket",
    );
  }

  // --- createBooking: rollback on persist failure ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingFails: true,
    });
    let threw = false;
    try {
      await createBooking(input, deps);
    } catch {
      threw = true;
    }
    assert(threw, "create: throws when persist fails");
    assert(calls.createEvent.length === 1, "create-fail: calendar event was created");
    assert(
      calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "create-fail: rolls back the created calendar event",
    );
    assert(calls.moveBusyBlock.length === 0, "create-fail: no busy block written");
    assert(calls.webhooks.length === 0, "create-fail: no webhook fired");
    assert(calls.invalidateSlots.length === 0, "create-fail: no invalidation when booking throws before write-through");
  }

  // --- createBooking: unique-slot conflict (verify-on-book race loser) ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflict: true,
    });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "create-conflict: unique-slot conflict throws SlotUnavailableError");
    assert(
      calls.createEvent.length === 1 && calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-1",
      "create-conflict: rolls back the calendar event",
    );
    assert(calls.moveBusyBlock.length === 0 && calls.webhooks.length === 0, "create-conflict: no busy block / webhook");
  }

  // --- idempotency: double-submit returns the existing booking (fast path) ---
  {
    const existing = makeBooking({ id: "bk-existing", manage_token: "tok-existing" });
    const { deps, calls } = makeDeps({ existingByKey: existing });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-existing", "idempotency: returns the existing booking on replay");
    assert(
      res.manageUrl === "https://slate.test/booking/manage/tok-existing",
      "idempotency: manage URL points at the existing booking",
    );
    assert(calls.createEvent.length === 0, "idempotency: no calendar event created on replay");
    assert(
      calls.moveBusyBlock.length === 0 && calls.webhooks.length === 0,
      "idempotency: no insert / busy block / webhook on replay",
    );
  }

  // --- idempotency: concurrent duplicate loses the insert race, gets the winner ---
  {
    const winner = makeBooking({ id: "bk-winner", manage_token: "tok-winner" });
    const { deps, calls } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(["a@x.com"]),
      insertBookingConflict: true,
      conflictWinner: winner, // not visible at pre-check, found after the conflict
    });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-winner", "idempotency race: returns the winning booking, not an error");
    assert(
      res.manageUrl === "https://slate.test/booking/manage/tok-winner",
      "idempotency race: manage URL points at the winner",
    );
    // #429 P4: the loser adopts the winner's reservation (same pinned agent +
    // deterministic client id), so its createEvent REUSES the winner's event
    // (Google 409) rather than making a separate one. The event id is therefore
    // shared with the winner — it must NOT be rolled back (that would delete the
    // winner's event). The loser just returns the winner and cleans up its row.
    assert(
      calls.deleteEvent.length === 0,
      "idempotency race: loser reuses the winner's event, nothing rolled back",
    );
    assert(
      calls.deletedReservations.length === 1,
      "idempotency race: loser cleans up the reservation",
    );
  }

  // --- create reservation drain resume after a crash (#429 P4 Phase C) ---
  {
    const reservation: BookingReservation = {
      id: "resv-crash",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: "sf1",
          attendee_name: "Kris",
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-resv",
          idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Kris",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: "k@x.com",
          attendeeName: "Kris",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    const { deps, calls } = makeDeps({ drainableReservations: [reservation] });
    const res = await processBookingReservations(deps, 15);
    assert(res.processed === 1 && res.completed === 1, "drain: completes the crashed reservation");
    assert(calls.createEvent.length === 1, "drain: re-creates (reuses) the pinned calendar event");
    assert(calls.moveBusyBlock.length === 1, "drain: writes the write-through busy block");
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created",
      "drain: fires booking.created exactly once",
    );
    assert(
      calls.deletedReservations.length === 1 && calls.deletedReservations[0] === "resv-crash",
      "drain: deletes the reservation on success",
    );
  }

  // --- create reservation drain: crash AFTER insert, BEFORE the webhook (#613) --
  // The booking was persisted but the reservation wasn't deleted and
  // booking.created never fired. On resume completeReservation finds the booking
  // already inserted; it must still deliver the post-insert side effects
  // (busyblock/recompute/notify) exactly once instead of short-circuiting and
  // dropping the webhook permanently. The reservation is the durable net, so the
  // drain that resumes it is what fires the previously-lost booking.created.
  {
    const already = makeBooking({
      id: "bk-613",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      routing_trace: {
        bucket_code: "411",
        bucket_id: "bkt1",
        considered: ["a"],
        chosen_user_id: "a",
        fallback_applied: false,
      },
    });
    const reservation: BookingReservation = {
      id: "resv-613",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: "sf1",
          attendee_name: "Kris",
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-resv",
          idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Kris",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: "k@x.com",
          attendeeName: "Kris",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    // existingByKey models the booking that the crashed attempt already inserted:
    // findBookingByIdempotencyKey returns it, so completeReservation takes the
    // "already inserted" short-circuit branch.
    const { deps, calls } = makeDeps({
      drainableReservations: [reservation],
      existingByKey: already,
    });
    const res = await processBookingReservations(deps, 15);
    assert(
      res.processed === 1 && res.completed === 1,
      "#613 drain: completes the already-inserted reservation",
    );
    assert(
      calls.createEvent.length === 0,
      "#613 drain: booking already inserted, no second calendar event",
    );
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.created" &&
        calls.webhooks[0].dedupeKey === "bk-613",
      "#613 drain: fires the previously-lost booking.created exactly once (dedupe key = booking id)",
    );
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].bookingId === "bk-613" &&
        calls.moveBusyBlock[0].userId === "a",
      "#613 drain: idempotent write-through busy block for the booking",
    );
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "#613 drain: recomputes the booked bucket",
    );
    assert(
      calls.deletedReservations.length === 1 && calls.deletedReservations[0] === "resv-613",
      "#613 drain: deletes the reservation only after delivering side effects",
    );
  }

  // --- reservation drain: a transient failure bumps + backs off + alerts (#445) -
  {
    const reservation: BookingReservation = {
      id: "resv-stuck",
      idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
      pinned_user_id: "a",
      pinned_agent_email: "a@x.com",
      gcal_client_id: "slatedeadbeef",
      payload: {
        booking: {
          org_id: "org1",
          bucket_id: "bkt1",
          event_type_id: "et1",
          assigned_user_id: "a",
          agent_name: "Agent A",
          agent_email: "a@x.com",
          starts_at: "2026-06-08T13:00:00.000Z",
          ends_at: "2026-06-08T13:30:00.000Z",
          original_starts_at: "2026-06-08T13:00:00.000Z",
          original_ends_at: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          status: "confirmed",
          salesforce_id: "sf1",
          attendee_name: "Kris",
          attendee_email: "k@x.com",
          attendee_phone: "+12035615295",
          prefill: {},
          gcal_event_id: "slatedeadbeef",
          manage_token: "tok-resv",
          idempotency_key: "411|2026-06-08T13:00:00.000Z|k@x.com||sf1",
          external_id: null,
          routing_trace: {
            bucket_code: "411",
            bucket_id: "bkt1",
            considered: ["a"],
            chosen_user_id: "a",
            fallback_applied: false,
          },
        },
        event: {
          summary: "Senior Loan Advisor Call with Kris",
          description: "desc",
          start: "2026-06-08T13:00:00.000Z",
          end: "2026-06-08T13:30:00.000Z",
          timezone: "America/New_York",
          attendeeEmail: "k@x.com",
          attendeeName: "Kris",
        },
        bucketCode: "411",
      },
      status: "pending",
      lease_until: null,
      attempts: 4, // a 5th failure this pass -> crosses the alert threshold
      last_error: "earlier failure",
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    };
    // insertBookingFails makes completeReservation throw (a transient DB failure).
    const { deps, calls } = makeDeps({
      drainableReservations: [reservation],
      insertBookingFails: true,
    });
    const res = await processBookingReservations(deps, 15);
    assert(res.processed === 1 && res.completed === 0 && res.failed === 1, "drain: a transient failure is counted, not completed");
    assert(calls.deletedReservations.length === 0, "drain: a transient failure does NOT delete the reservation (it retries later)");
    assert(calls.reservationBumps.length === 1, "drain: the failed reservation is bumped (attempts + backoff scheduled)");
    assert(calls.reservationBumps[0]?.attempts === 5, "drain: bump increments the prior attempt count (4 -> 5)");
    assert(res.stuck.length === 1 && res.stuck[0]?.id === "resv-stuck", "drain: a reservation past the alert threshold is reported stuck");

    // Terminal SlotUnavailable (slot genuinely taken): completeReservation deletes
    // the row and throws. The drain must NOT bump or alert (no phantom row) (#445).
    const terminal: BookingReservation = { ...reservation, id: "resv-terminal", attempts: 4 };
    const { deps: tDeps, calls: tCalls } = makeDeps({
      drainableReservations: [terminal],
      insertBookingConflict: true,
    });
    const tRes = await processBookingReservations(tDeps, 15);
    assert(tRes.failed === 1, "drain: a terminal slot-taken reservation is counted failed");
    assert(tCalls.deletedReservations.includes("resv-terminal"), "drain: terminal SlotUnavailable deletes the reservation");
    assert(tCalls.reservationBumps.length === 0, "drain: a terminal slot-taken reservation is NOT bumped (no backoff on a deleted row)");
    assert(tRes.stuck.length === 0, "drain: a terminal slot-taken reservation does NOT fire a stuck alert");
  }

  // --- createBooking: verify-on-book walks past busy A to free B ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set(["b@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.assigned_user_id === "b", "create: skips busy A, books free B");
    assert(
      calls.verifyFree.length === 1 &&
        JSON.stringify(calls.verifyFree[0]) === JSON.stringify(["a@x.com", "b@x.com"]),
      "create: verifies A and B together in one batched wave",
    );
  }

  // --- createBooking: no free candidate ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a", "b"], freeEmails: new Set() });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof SlotUnavailableError, "create: SlotUnavailableError when none free");
    assert(
      !(err instanceof VerifyUnavailableError),
      "create: a genuinely-full slot is NOT an outage",
    );
    assert(calls.createEvent.length === 0, "create: no calendar event when no agent is free");
  }

  // --- createBooking: EMPTY pool (misconfigured bucket) vs full slot (#358) ---
  {
    const { deps, calls } = makeDeps({ candidates: [], freeEmails: new Set() });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof NoEligibleAgentsError,
      "create: NoEligibleAgentsError when the bucket has zero eligible agents",
    );
    assert(
      err instanceof NoEligibleAgentsError && err.bucketCode === "411",
      "create: NoEligibleAgentsError carries the bucket code (for the #327 alert)",
    );
    assert(
      !(err instanceof SlotUnavailableError),
      "create: an empty pool is DISTINCT from a genuinely-full slot",
    );
    assert(calls.createEvent.length === 0, "create-empty-pool: no calendar event");
  }

  // --- createBooking: unknown bucket code (#358) ---
  {
    const { deps } = makeDeps({ unknownBucket: true });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof UnknownBucketError,
      "create: UnknownBucketError when the bucket code resolves to nothing",
    );
  }

  // --- createBooking: verify-on-book outage (couldn't check) vs full slot ---
  {
    const { deps, calls } = makeDeps({
      candidates: ["a", "b"],
      freeEmails: new Set(),
      unverifiedEmails: new Set(["a@x.com"]), // a couldn't be checked (outage)
    });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof VerifyUnavailableError,
      "create: an unverifiable candidate throws VerifyUnavailableError, not SlotUnavailableError",
    );
    assert(calls.createEvent.length === 0, "create-outage: no calendar event written");
  }

  // --- reschedule: same agent free -> in-place move, no reassign, RR untouched ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    // The outbox handlers re-load by id AFTER the commit, so loadBookingById
    // must return the committed (new-time) booking, mirroring production.
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      freeEmails: new Set(["a@x.com"]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(same agent): moves the existing event in place",
    );
    assert(calls.createEvent.length === 0 && calls.deleteEvent.length === 0, "reschedule(same agent): no new/old event churn");
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].bookingId === res.booking.id &&
        calls.moveBusyBlock[0].startIso === "2026-06-09T14:00:00.000Z" &&
        calls.deleteBusyBlocks.length === 0 &&
        calls.insertBusyBlock.length === 0,
      "reschedule: busy block moved atomically (#429 P3)",
    );
    assert(res.booking.status === "rescheduled" && res.booking.starts_at === "2026-06-09T14:00:00.000Z", "reschedule: status + new start applied");
    assert(calls.webhooks[0].event === "booking.rescheduled", "reschedule: fires booking.rescheduled");
    assert(
      calls.claimReschedule === 1 && calls.releaseReschedule === 1,
      "reschedule: claims then releases the idempotency lock",
    );
    // #326: records the reason as a history event + carries it on the webhook.
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].action === "rescheduled" &&
        calls.bookingEvents[0].initiator === "customer" &&
        calls.bookingEvents[0].reason_code === "schedule_conflict",
      "reschedule: records one 'rescheduled' history event with the reason + initiator",
    );
    assert(
      calls.bookingEvents[0].from_starts_at === "2026-06-08T13:00:00.000Z" &&
        calls.bookingEvents[0].to_starts_at === "2026-06-09T14:00:00.000Z" &&
        calls.bookingEvents[0].to_agent_user_id === "a",
      "reschedule: history event carries from/to time and the (kept) agent",
    );
    assert(
      JSON.stringify(calls.webhooks[0].reason) ===
        JSON.stringify({ code: "schedule_conflict", detail: null, initiator: "customer" }),
      "reschedule: webhook payload carries the reason + initiator",
    );
  }

  // --- #614: an oscillating reschedule that returns to a previously-used start
  // time must still emit its own rescheduled webhook + history row. The dedupe
  // key is versioned by the booking's reschedule_seq, so a move back to a used
  // to_starts_at can't reuse the earlier reschedule's row (which would swallow
  // the webhook). We drive the NOTIFY step directly across three moves whose
  // targets oscillate (T2 -> T1 -> T2), then re-run the last (drain resume). ---
  {
    const notify = OUTBOX_HANDLERS[rescheduleOutboxSteps()[2].name];
    const T2 = "2026-06-09T14:00:00.000Z";
    const T1 = "2026-06-10T15:00:00.000Z";
    // One mutable context: loadBookingById returns it, and we advance the
    // booking's time + reschedule_seq between moves like the real commit does.
    const ctx = { booking: makeBooking({ status: "rescheduled" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    const row = {
      id: "ob-osc",
      booking_id: "bk1",
      action: "reschedule" as const,
      status: "pending" as const,
      steps: rescheduleOutboxSteps(),
      payload: {
        reasonCode: "schedule_conflict",
        reasonDetail: null,
        initiator: "customer" as const,
        fromStartsIso: "2026-06-08T13:00:00.000Z",
        fromAgentUserId: "a",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      created_at: "",
      updated_at: "",
    } as BookingOutbox;

    const move = async (toIso: string, seq: number) => {
      ctx.booking.starts_at = toIso;
      ctx.booking.reschedule_seq = seq;
      await notify(deps, row);
    };
    await move(T2, 1);
    await move(T1, 2);
    await move(T2, 3); // back to a USED start: pre-#614 this reused move 1's row

    assert(
      calls.webhooks.length === 3 && calls.webhooks.every((w) => w.event === "booking.rescheduled"),
      "oscillating reschedule: every move emits its own booking.rescheduled webhook (#614)",
    );
    assert(
      calls.bookingEvents.length === 3,
      "oscillating reschedule: every move records its own history row (#614)",
    );
    assert(
      new Set(calls.webhooks.map((w) => w.dedupeKey)).size === 3,
      "oscillating reschedule: each move's webhook carries a distinct dedupe key (#614)",
    );
    assert(
      calls.bookingEvents[2].to_starts_at === T2 && calls.bookingEvents[2].reschedule_seq === 3,
      "oscillating reschedule: the return-to-T2 row is versioned by seq 3, not folded into seq 1",
    );

    // Drain re-run of the last move (same booking state) must dedupe: no new
    // history row, and the re-fired webhook reuses move 3's key so emit's unique
    // (endpoint, event, dedupe_key) index suppresses the duplicate POST.
    const move3Key = calls.webhooks[2].dedupeKey;
    await move(T2, 3);
    assert(
      calls.bookingEvents.length === 3,
      "oscillating reschedule: a drain re-run inserts no duplicate history row (#614)",
    );
    assert(
      calls.webhooks[3]?.dedupeKey === move3Key,
      "oscillating reschedule: a drain re-run reuses the same dedupe key (emit dedupes to one) (#614)",
    );
  }

  // --- reschedule in-place when the calendar event was DELETED (#617): the
  // PATCH 410s -> updateEventTime raises EventGone -> the branch recreates the
  // event (with a deterministic id) instead of committing a phantom move. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      freeEmails: new Set(["a@x.com"]),
      updateEventTimeGone: true, // the existing event is gone on Google
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(deleted event): still attempts the in-place PATCH first",
    );
    assert(
      calls.createEvent.length === 1 && calls.createEvent[0].email === "a@x.com",
      "reschedule(deleted event): recreates the event on EventGone",
    );
    assert(
      calls.deleteEvent.length === 0,
      "reschedule(deleted event): no delete — the old event is already gone",
    );
    assert(
      typeof calls.createEvent[0].clientId === "string" && calls.createEvent[0].clientId.length > 0,
      "reschedule(deleted event): recreate uses a deterministic client id (idempotent on resume)",
    );
    assert(
      res.booking.gcal_event_id !== "gcal-old" && (res.booking.gcal_event_id ?? "").length > 0,
      "reschedule(deleted event): commits the NEW recreated event id, not the phantom one",
    );
    assert(
      res.booking.assigned_user_id === "a" && res.booking.status === "rescheduled",
      "reschedule(deleted event): stays on the same agent and commits the move",
    );
    assert(calls.webhooks[0].event === "booking.rescheduled", "reschedule(deleted event): still fires booking.rescheduled");
  }

  // --- reschedule by LESS than the event length: stays in-place on the SAME
  // agent even in a multi-agent bucket (#523). The booking's own still-present
  // event overlaps the new slot; the self-free check must exclude it, else the
  // current agent looks busy and the booking silently re-routes to another. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T13:15:00.000Z",
        ends_at: "2026-06-08T13:45:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"], // a multi-agent bucket: re-route would pick a DIFFERENT agent
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // a@x.com is busy ONLY with its own current event (13:00–13:30).
      busyByEmail: new Map([["a@x.com", [{ start: "2026-06-08T13:00:00.000Z", end: "2026-06-08T13:30:00.000Z" }]]]),
    });
    // +15min: new slot 13:15–13:45 overlaps the original 13:00–13:30 event.
    const res = await rescheduleBooking("tok1", "2026-06-08T13:15:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(sub-event-length): stays on the SAME agent, no silent re-route",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(sub-event-length): moves the existing event in place",
    );
    assert(
      calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule(sub-event-length): no reassign create/delete churn",
    );
  }

  // --- reschedule PAST the assigned agent's shift end -> re-routes to a working
  // agent even though the agent's CALENDAR is free (#527). `isFree` alone would
  // keep the off-shift agent in place; the working-hours guard falls through to
  // assignAgent so a working agent in the bucket can cover. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        assigned_user_id: "b",
        agent_name: "Agent B",
        agent_email: "b@x.com",
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      // Availability-aware round-robin drops off-shift agent A; only B is offered.
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]), // A's CALENDAR is free...
      // ...but A's Monday shift ends 13:30 NY (17:30 UTC), so 14:00 NY is off-shift.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
    });
    // 2026-06-08T18:00Z = 14:00 NY Monday — past A's 13:30 shift end.
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com",
      "reschedule(off-shift): re-routes to a working agent instead of staying in-place (#527)",
    );
    assert(
      calls.agentWorkingHours.includes("a"),
      "reschedule(off-shift): consults the assigned agent's working hours",
    );
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 1 && calls.deleteEvent.length === 1,
      "reschedule(off-shift): reassign churn (delete old + create new), no in-place move",
    );
  }

  // --- reschedule WITHIN the assigned agent's shift -> stays in-place even in a
  // multi-agent bucket (#527 companion: the working-hours guard permits the move
  // when the new time is on-shift and the calendar is free). ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A works a late shift (09:00-20:00 NY) that includes 14:00 NY.
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 20 * 60 }] }],
      ]),
    });
    // 2026-06-08T18:00Z = 14:00 NY Monday — inside A's 09:00-20:00 shift.
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(on-shift): stays on the same agent in-place (#527)",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule(on-shift): moves in place, no reassign churn",
    );
  }

  // --- #(reassign-cap) reschedule keeping the SAME agent is NOT blocked by the daily
  // cap, even onto a day already full of the agent's OTHER meetings (a reschedule moves
  // an existing meeting, it's not a net-new booking). ---
  {
    const capEvent = { ...eventType, daily_cap: 1 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: capEvent };
    const rescheduled = {
      booking: {
        ...ctx.booking,
        starts_at: "2026-06-08T18:00:00.000Z",
        ends_at: "2026-06-08T18:30:00.000Z",
        status: "rescheduled" as const,
      },
      bucket,
      eventType: capEvent,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A already has another booking that day; cap is 1 -> would be "over cap".
      agentDayBookings: new Map([["a", ["2026-06-08T13:00:00.000Z"]]]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" && res.booking.agent_email === "a@x.com",
      "reschedule(over cap, same agent): stays on the SAME agent (cap not enforced on reschedule)",
    );
    assert(
      calls.updateEventTime.length === 1 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule(over cap, same agent): moves in place, no reassign churn",
    );
  }

  // --- #536: reschedule into the agent's BUFFER window -> re-routes. The slot
  // itself is calendar-free, but a busy block sits inside the required buffer-after
  // gap, so the booker would never offer it; the in-place guard must decline. ---
  {
    const bufEvent = { ...eventType, buffer_after_min: 30 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: bufEvent };
    const rescheduled = {
      booking: { ...ctx.booking, assigned_user_id: "b", agent_name: "Agent B", agent_email: "b@x.com",
        starts_at: "2026-06-08T18:00:00.000Z", ends_at: "2026-06-08T18:30:00.000Z", status: "rescheduled" as const },
      bucket, eventType: bufEvent,
    };
    const { deps, calls } = makeDeps({
      existing: ctx,
      bookingById: rescheduled,
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      // A is free AT the slot (18:00-18:30) but busy 18:30-18:45, inside the 30-min
      // buffer-after window [18:30, 19:00). B has no conflicts.
      busyByEmail: new Map([["a@x.com", [{ start: "2026-06-08T18:30:00.000Z", end: "2026-06-08T18:45:00.000Z" }]]]),
    });
    const res = await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com",
      "reschedule(buffer violation): re-routes off the agent whose buffer is violated (#536)",
    );
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 1,
      "reschedule(buffer violation): reassign churn, no in-place move (#536)",
    );
  }

  // --- #536: reschedule to a time inside the minimum-notice window -> rejected. The
  // agent is on-shift and free, but the new time is too soon; no agent qualifies, so
  // the in-place guard declines and the schedule-aware reassign finds nobody. ---
  {
    const noticeEvent = { ...eventType, min_notice_min: 120 } as unknown as EventType;
    const ctx = { booking: makeBooking({}), bucket, eventType: noticeEvent };
    const { deps, calls } = makeDeps({
      existing: ctx,
      candidates: [], // too-soon: the schedule-aware reassign finds no eligible agent
      freeEmails: new Set(["a@x.com", "b@x.com"]),
    });
    const slot = "2026-06-08T18:00:00.000Z";
    const tooSoonNow = Date.parse(slot) - 30 * 60_000; // 30 min before the slot, notice is 120
    let err: unknown;
    try {
      await rescheduleBooking("tok1", slot, RR, "customer", deps, tooSoonNow);
    } catch (e) {
      err = e;
    }
    assert(
      err != null && (err as Error).name === "NoEligibleAgentsError",
      "reschedule(too soon): in-place guard declines and reassign finds nobody (#536)",
    );
    assert(
      calls.updateEventTime.length === 0,
      "reschedule(too soon): never moves the agent in place (#536)",
    );
  }

  // --- reschedule no-op / retry: records the reason ONCE, no move/webhook (#326 C1) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // starts 13:00Z
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule no-op: returns the unchanged booking");
    assert(
      calls.claimReschedule === 0 && calls.updateEventTime.length === 0 && calls.createEvent.length === 0,
      "reschedule no-op: skips the lock and all calendar work when already at target",
    );
    assert(
      calls.commitReschedule.length === 0 && calls.webhooks.length === 0,
      "reschedule no-op: no DB write or webhook for a same-instant reschedule",
    );
    // The mandatory reason must NOT be silently dropped on the no-op path: it's
    // recorded once. A retry (same target) must not double-record it.
    assert(
      calls.bookingEvents.length === 1 && calls.bookingEvents[0].reason_code === "schedule_conflict",
      "reschedule no-op: records the reason once (never silently dropped)",
    );
    await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.bookingEvents.length === 1,
      "reschedule retry: does not double-record the reason (idempotent)",
    );
  }

  // --- reschedule idempotency: concurrent duplicate loses the lock, no-ops ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // starts 13:00Z
    const { deps, calls } = makeDeps({
      existing: ctx,
      freeEmails: new Set(["a@x.com"]),
      // Another in-flight reschedule holds a FRESH lease for the SAME target -> a
      // same-target double-submit is an idempotent no-op (not a conflict).
      heldLease: { target: "2026-06-09T14:00:00.000Z" },
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule dup: returns the booking without moving it");
    assert(calls.claimReschedule === 1, "reschedule dup: attempted the claim");
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule dup: no calendar churn for the lock loser",
    );
    assert(
      calls.commitReschedule.length === 0 && calls.webhooks.length === 0 && calls.releaseReschedule === 0,
      "reschedule dup: no DB write, no duplicate webhook, and doesn't release a lock it never held",
    );
  }

  // --- reschedule: same agent busy -> reassign to B ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com", "reschedule(reassign): moves to free agent B");
    assert(calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-old", "reschedule(reassign): old event deleted");
    assert(calls.createEvent.length === 1, "reschedule(reassign): new event created for B");
    assert(calls.updateEventTime.length === 0, "reschedule(reassign): no in-place move");
  }

  // ===================================================================
  // Phase 0 (#471): crash-injection RED tests for crash-safe reschedule.
  // These assert the END-STATE invariants the lease-pin design must give
  // (windows a/b/c + oscillation + the headline abandoned-pin gap). They
  // fail against today's applyReschedule and go green as Phases 1-3 land.
  // ===================================================================

  // Make a deps method throw on its first invocation, then delegate — a crash
  // injected mid-sequence. The retry runs on the SAME deps so the simulated
  // Google state (the clientId->event reuse map) persists across the crash.
  const crashOnce = (deps: BookingDeps, method: keyof BookingDeps): void => {
    let fired = false;
    const original = (deps[method] as (...args: unknown[]) => Promise<unknown>).bind(deps);
    (deps as Record<string, unknown>)[method as string] = async (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        throw new Error(`injected crash: ${String(method)}`);
      }
      return original(...args);
    };
  };

  // Model a PROCESS crash at the commit: commitReschedule throws once, AND the
  // crashed attempt's `finally`-release is suppressed (a dead process never runs
  // its finally), so the lease is left behind for the retry to resume — exactly
  // the crashed-holder state the design recovers from. The retry's own release
  // still works.
  const crashAtCommit = (deps: BookingDeps): void => {
    crashOnce(deps, "commitReschedule");
    let suppressed = false;
    const release = deps.releaseReschedule.bind(deps);
    deps.releaseReschedule = async (bookingId: string) => {
      if (!suppressed) {
        suppressed = true;
        return;
      }
      return release(bookingId);
    };
  };

  // --- window (a): crash in the reassign branch after createEvent, before commit ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    crashAtCommit(deps); // crash at the commit, after the pin write + createEvent
    let crashed = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      crashed = true;
    }
    assert(crashed, "window(a): reassign-branch reschedule crashes after createEvent, before commit");
    // The crashed holder's lease must EXPIRE before a retry resumes (a fresh-lease
    // same-target retry is a deliberate no-op); then the retry adopts the pin.
    expireLease("bk1");
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    const clientIds = new Set(calls.createEvent.map((c) => c.clientId));
    assert(
      calls.createEvent.length >= 2 &&
        calls.createEvent.every((c) => typeof c.clientId === "string" && c.clientId.startsWith("slate")) &&
        clientIds.size === 1,
      "window(a): crash + retry reuse ONE deterministic event id (no duplicate Google event)",
    );
  }

  // --- window (b): crash in the same-agent in-place branch, before commit ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const free = new Set(["a@x.com", "b@x.com"]); // a free at first -> in-place branch
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["a", "b"], freeEmails: free });
    crashAtCommit(deps); // crash at the commit, after the in-place pin write + updateEventTime
    let crashed = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      crashed = true;
    }
    assert(crashed, "window(b): same-agent in-place reschedule crashes after updateEventTime, before commit");
    // Poison freeBusy AND expire the lease: on a resume the pin's branch=in_place
    // must short-circuit isFree entirely, so the poisoned read can't bump the agent.
    free.delete("a@x.com");
    expireLease("bk1");
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      res.booking.assigned_user_id === "a" &&
        res.booking.starts_at === "2026-06-09T14:00:00.000Z" &&
        calls.createEvent.length === 0,
      "window(b): resume stays on the SAME agent, completes the move, creates no new event",
    );
  }

  // --- #615: a cancel that lands DURING an in-place reschedule (after the PATCH,
  // before the commit) must NOT resurrect the booking. The gated commit touches 0
  // rows, the booking stays cancelled, and the reschedule surfaces a conflict. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      candidates: ["a", "b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]), // a on-shift + free -> in-place branch
      // The cancel lands mid-PATCH: flip the row to cancelled (as claimCancellation would).
      concurrentBeforeCommit: (b) => {
        b.status = "cancelled";
      },
    });
    let conflicted = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch (err) {
      conflicted = err instanceof RescheduleConflictError;
    }
    assert(conflicted, "#615 cancel-during-reschedule: throws RescheduleConflictError (no silent resurrect)");
    assert(
      ctx.booking.status === "cancelled",
      "#615 cancel-during-reschedule: the booking STAYS cancelled (gated commit touched 0 rows)",
    );
    assert(
      calls.createEvent.length === 0,
      "#615 cancel-during-reschedule: in-place branch created no event, so there is no orphan",
    );
  }

  // --- #615: a reassign that lands DURING a reassign-branch reschedule (after the
  // new event is created, before the commit) must NOT be clobbered. The gated
  // commit touches 0 rows, the reschedule rolls back the event it created and
  // conflicts, and the reassign's agent + event remain the live ones. ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({
      existing: ctx,
      // a is off-shift at the new time, so the reschedule re-routes to b (reassign branch).
      candidates: ["b"],
      freeEmails: new Set(["a@x.com", "b@x.com"]),
      workingHoursByUser: new Map([
        ["a", { timezone: "America/New_York", rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 810 }] }],
      ]),
      // A concurrent reassign to agent C swaps assignee + event id (0058 swap shape).
      concurrentBeforeCommit: (b) => {
        b.assigned_user_id = "c";
        b.agent_email = "c@x.com";
        b.gcal_event_id = "ev-reassign";
        b.status = "rescheduled";
      },
    });
    let conflicted = false;
    // 2026-06-08T18:00Z = 14:00 NY Monday — past a's 13:30 shift end -> reassign branch.
    try {
      await rescheduleBooking("tok1", "2026-06-08T18:00:00.000Z", RR, "customer", deps, NOW);
    } catch (err) {
      conflicted = err instanceof RescheduleConflictError;
    }
    assert(conflicted, "#615 reassign-during-reschedule: throws RescheduleConflictError (does not clobber)");
    assert(
      ctx.booking.assigned_user_id === "c" && ctx.booking.gcal_event_id === "ev-reassign",
      "#615 reassign-during-reschedule: the reassign's agent + event stay live (not overwritten)",
    );
    assert(
      // delete-first of the old event (1) + rollback of the event this reschedule
      // created (1) = 2; the reassign's live event id is never deleted.
      calls.deleteEvent.length === 2 && !calls.deleteEvent.some((d) => d.id === "ev-reassign"),
      "#615 reassign-during-reschedule: rolls back its own created event, leaves the reassign's intact",
    );
  }

  // --- window (c): concurrent different-target reschedule must CONFLICT, not no-op ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    // Another in-flight reschedule holds a FRESH lease for a DIFFERENT target.
    const { deps, calls } = makeDeps({
      existing: ctx,
      freeEmails: new Set(["a@x.com"]),
      heldLease: { target: "2026-06-09T09:00:00.000Z" },
    });
    let err: unknown;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(
      err != null && (err as Error).name === "RescheduleConflictError",
      "window(c): a concurrent different-target reschedule throws RescheduleConflictError (not a silent no-op)",
    );
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 0,
      "window(c): the conflict loser makes no Google move",
    );
  }

  // --- oscillation guard: reassign-branch create must use a deterministic seq-keyed id ---
  // (A->T1->T2->T1 must not reuse a tombstoned id; the full seq-increment assertion
  //  lands in Phase 2/3 unit tests once reschedule_seq exists. Here we pin the core:
  //  the reassign create carries a deterministic 'slate' client id at all.)
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    assert(
      calls.createEvent.length === 1 &&
        typeof calls.createEvent[0].clientId === "string" &&
        calls.createEvent[0].clientId!.startsWith("slate"),
      "oscillation guard: reassign-branch reschedule uses a deterministic 'slate' client id",
    );
  }

  // --- sequential reschedule after release: a later different-target move is VALID, not a false conflict ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW); // committed + released
    let err: unknown;
    try {
      await rescheduleBooking("tok1", "2026-06-10T15:00:00.000Z", RR, "customer", deps, NOW);
    } catch (e) {
      err = e;
    }
    assert(err == null, "sequential after release: a later different-target reschedule is valid, NOT a false conflict");
  }

  // --- headline gap: different-target reschedule after an ABANDONED same-booking crash ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls, expireLease } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    crashAtCommit(deps); // abandon the A->T1 reassign at the commit
    let crashed = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      crashed = true;
    }
    assert(crashed, "headline-gap: A->T1 reschedule crashes after createEvent (abandoned pin)");
    // The abandoned holder's lease expires; a DIFFERENT-target retry adopts its seq.
    expireLease("bk1");
    const res = await rescheduleBooking("tok1", "2026-06-10T15:00:00.000Z", RR, "customer", deps, NOW);
    assert(res.booking.starts_at === "2026-06-10T15:00:00.000Z", "headline-gap: booking lands on T2, not the abandoned T1");
    assert(
      calls.enqueueEventDeletion.length >= 1,
      "headline-gap: the orphaned T1 calendar event is enqueued into pending_event_deletions",
    );
  }

  // --- abandoned-pin GC sweep (#439, #476): cleanup only ---
  {
    const { deps, calls } = makeDeps({
      abandonedPins: [
        // never-adopted reassign pin -> enqueue its orphaned event, free the lock
        { booking_id: "bk1", pinned_agent_email: "b@x.com", gcal_client_id: "slateorphan", branch: "reassign", booking_gcal_event_id: "gcal-old" },
        // in-place pin -> no orphan event, just free the lock
        { booking_id: "bk2", pinned_agent_email: "a@x.com", gcal_client_id: "gcal-old", branch: "in_place", booking_gcal_event_id: "gcal-old" },
        // reassign pin that WAS adopted (client id == the live event) -> no enqueue
        { booking_id: "bk3", pinned_agent_email: "c@x.com", gcal_client_id: "gcal-live", branch: "reassign", booking_gcal_event_id: "gcal-live" },
      ],
    });
    const res = await processAbandonedReschedulePins(deps, 0);
    assert(res.swept === 3 && res.enqueued === 1, "sweep: enqueues only the never-adopted reassign orphan");
    assert(
      calls.enqueueEventDeletion.length === 1 && calls.enqueueEventDeletion[0].eventId === "slateorphan",
      "sweep: enqueues the orphaned reassign event for durable deletion",
    );
    assert(calls.releaseReschedule === 3, "sweep: frees every swept lock row");
  }

  // --- reschedule: terminal states / not found ---
  {
    const ctx = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx });
    let threw = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps, NOW);
    } catch {
      threw = true;
    }
    assert(threw, "reschedule: rejects a cancelled booking");

    const { deps: deps2 } = makeDeps({ existing: null });
    let threw2 = false;
    try {
      await rescheduleBooking("nope", "2026-06-09T14:00:00.000Z", RR, "customer", deps2, NOW);
    } catch {
      threw2 = true;
    }
    assert(threw2, "reschedule: throws when booking not found");
  }

  // --- cancel: happy + idempotent ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(calls.deleteEvent.length === 1, "cancel: deletes the calendar event");
    assert(calls.deleteBusyBlocks.length === 1, "cancel: removes the busy block");
    assert(
      calls.claimCancellation.length === 1 && calls.claimCancellation[0] === ctx.booking.id,
      "cancel: marks the booking cancelled (via the atomic claim)",
    );
    assert(calls.webhooks[0].event === "booking.cancelled", "cancel: fires booking.cancelled");
    assert(
      calls.webhooks[0].dedupeKey === "evt-1" && calls.bookingEvents.length === 1,
      "cancel: webhook dedupe key is the booking_events row id (#436)",
    );
    // #326: records a 'cancelled' history event (no to-time) + reason on webhook.
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].action === "cancelled" &&
        calls.bookingEvents[0].initiator === "customer" &&
        calls.bookingEvents[0].reason_code === "no_longer_interested" &&
        calls.bookingEvents[0].to_starts_at === null,
      "cancel: records one 'cancelled' history event with the reason and no to-time",
    );
    assert(
      JSON.stringify(calls.webhooks[0].reason) ===
        JSON.stringify({ code: "no_longer_interested", detail: null, initiator: "customer" }),
      "cancel: webhook payload carries the reason + initiator",
    );

    const ctx2 = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps: d2, calls: c2 } = makeDeps({ existing: ctx2 });
    await cancelBooking("tok1", CR, "customer", d2);
    assert(
      c2.deleteEvent.length === 0 && c2.commitReschedule.length === 0 && c2.webhooks.length === 0,
      "cancel: no-op when already cancelled (no re-delete / re-webhook)",
    );
    // But the mandatory reason is still captured once for the already-cancelled
    // re-submit (covers a first attempt that flipped status but lost the reason).
    assert(
      c2.bookingEvents.length === 1 && c2.bookingEvents[0].action === "cancelled",
      "cancel re-submit: records the reason once for an already-cancelled booking",
    );
  }

  // --- outbox cancel resume after a crash (#429 P3) ---
  {
    const ctx = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    // Simulate a crash that finished gcal_delete + busyblock_delete inline, then
    // died before recompute/notify. The drain re-runs the row with those done.
    const steps = cancelOutboxSteps();
    steps[0].state = "done"; // cancel:gcal_delete
    steps[1].state = "done"; // cancel:busyblock_delete
    const row: BookingOutbox = {
      id: "ob-resume",
      booking_id: ctx.booking.id,
      action: "cancel",
      status: "pending",
      steps,
      payload: {
        reasonCode: "no_longer_interested",
        reasonDetail: null,
        initiator: "customer",
        fromStartsIso: ctx.booking.starts_at,
        fromAgentUserId: ctx.booking.assigned_user_id,
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "resume: the row reaches delivered");
    assert(calls.deleteEvent.length === 0, "resume: does NOT re-delete the already-done gcal event");
    assert(calls.deleteBusyBlocks.length === 0, "resume: does NOT re-delete the already-done busy block");
    assert(calls.invalidateSlots.length === 1, "resume: runs the pending recompute step");
    assert(
      calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.cancelled",
      "resume: fires the pending webhook exactly once",
    );
  }

  // --- outbox reschedule resume after a crash (#429 P3) ---
  {
    const rescheduled = {
      booking: makeBooking({
        starts_at: "2026-06-09T14:00:00.000Z",
        ends_at: "2026-06-09T14:30:00.000Z",
        status: "rescheduled",
      }),
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({ existing: rescheduled, bookingById: rescheduled });
    // Crash finished busyblock_move, died before recompute/notify; drain resumes.
    const steps = rescheduleOutboxSteps();
    steps[0].state = "done"; // reschedule:busyblock_move
    const row: BookingOutbox = {
      id: "ob-resched-resume",
      booking_id: rescheduled.booking.id,
      action: "reschedule",
      status: "pending",
      steps,
      payload: {
        reasonCode: "schedule_conflict",
        reasonDetail: null,
        initiator: "customer",
        fromStartsIso: "2026-06-08T13:00:00.000Z",
        fromAgentUserId: "a",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "resched resume: row reaches delivered");
    assert(calls.moveBusyBlock.length === 0, "resched resume: does NOT re-move the already-done busy block");
    assert(calls.invalidateSlots.length === 1, "resched resume: runs the pending recompute");
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.rescheduled",
      "resched resume: fires the rescheduled webhook exactly once",
    );
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].to_starts_at === "2026-06-09T14:00:00.000Z",
      "resched resume: history records the NEW time as to_starts_at",
    );
  }

  // --- outbox reassign resume after a crash (#429 P3) ---
  {
    const reassigned = {
      booking: makeBooking({ assigned_user_id: "b", status: "rescheduled" }),
      bucket,
      eventType,
    };
    const { deps, calls } = makeDeps({ existing: reassigned, bookingById: reassigned });
    const steps = reassignOutboxSteps();
    steps[0].state = "done"; // reassign:busyblock_move
    const row: BookingOutbox = {
      id: "ob-reassign-resume",
      booking_id: reassigned.booking.id,
      action: "reassign",
      status: "pending",
      steps,
      payload: {
        reasonCode: "contact_owner",
        reasonDetail: null,
        initiator: "system",
        fromStartsIso: reassigned.booking.starts_at,
        fromAgentUserId: "a",
      },
      lease_until: null,
      attempts: 0,
      last_error: null,
      created_at: "",
      updated_at: "",
    };
    const res = await runOutboxSteps(deps, row, OUTBOX_HANDLERS);
    assert(res.delivered === true, "reassign resume: row reaches delivered");
    assert(calls.moveBusyBlock.length === 0, "reassign resume: does NOT re-move the already-done busy block");
    assert(calls.invalidateSlots.length === 1, "reassign resume: runs the pending recompute");
    assert(
      calls.webhooks.length === 1 &&
        calls.webhooks[0].event === "booking.rescheduled" &&
        calls.webhooks[0].dedupeKey === "ob-reassign-resume",
      "reassign resume: fires booking.rescheduled once, keyed on the outbox row id",
    );
    assert(
      calls.bookingEvents.length === 1 && calls.bookingEvents[0].action === "reassigned",
      "reassign resume: records a 'reassigned' history row",
    );
  }

  // --- completePastBookings ---
  {
    const due = [
      { booking: makeBooking({ id: "p1", status: "confirmed" }), bucket, eventType },
      { booking: makeBooking({ id: "p2", status: "rescheduled" }), bucket, eventType },
    ];
    const { deps, calls } = makeDeps({ pastDue: due });
    const n = await completePastBookings(deps);
    assert(n === 2, "complete: returns the count of completed bookings");
    assert(
      calls.completeBookingsIfDue.length === 1 &&
        calls.completeBookingsIfDue[0].length === 2 &&
        calls.completeBookingsIfDue[0].includes("p1") &&
        calls.completeBookingsIfDue[0].includes("p2"),
      "complete: transitions all due bookings in a single batched call (#164)",
    );
    assert(
      calls.webhooks.length === 2 && calls.webhooks.every((w) => w.event === "booking.completed"),
      "complete: fires booking.completed for each",
    );

    const { deps: dEmpty } = makeDeps({ pastDue: [] });
    assert((await completePastBookings(dEmpty)) === 0, "complete: zero when nothing is due");

    // #163: an overlapping cron tick already flipped p1 to completed, so the
    // conditional transition no-ops there and booking.completed must NOT re-fire.
    const { deps: dRace, calls: cRace } = makeDeps({
      pastDue: due,
      alreadyCompleted: new Set(["p1"]),
    });
    const raced = await completePastBookings(dRace);
    assert(raced === 1, "complete: counts only rows this tick actually transitioned");
    assert(
      cRace.webhooks.length === 1 && cRace.webhooks[0].event === "booking.completed",
      "complete: no duplicate booking.completed for an already-completed row",
    );
  }

  // --- reassign: force a booking onto an owning agent (double-book allowed) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // assigned to "a"@a@x.com
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com",
      "reassign: booking moved to the owning agent",
    );
    // #449: the new event is created FIRST, then the atomic swap returns the
    // event it REPLACED ("gcal-old"), which is what gets deleted - not a stale
    // up-front read. The new event differs from the previous, so it's deleted.
    assert(calls.createEvent.length === 1, "reassign: event created on the owning agent");
    assert(
      calls.reassignSwaps.length === 1 && calls.reassignSwaps[0].userId === "b",
      "reassign: goes through the atomic reassign_booking_swap (not a plain update)",
    );
    assert(calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-old", "reassign: the REPLACED old event is removed (the swap's previous, not a stale read)");
    assert(
      res.booking.allow_double_book === true && res.booking.assigned_user_id === "b",
      "reassign: marks allow_double_book and the new agent",
    );
    assert(
      res.booking.routing_trace?.reassignments?.[0]?.from === "a" &&
        res.booking.routing_trace?.reassignments?.[0]?.to === "b",
      "reassign: records the override in routing_trace",
    );
    assert(
      calls.moveBusyBlock.length === 1 &&
        calls.moveBusyBlock[0].userId === "b" &&
        calls.deleteBusyBlocks.length === 0 &&
        calls.insertBusyBlock.length === 0,
      "reassign: busy block moved atomically to the owner (#429 P3)",
    );
    assert(calls.webhooks.some((w) => w.event === "booking.rescheduled"), "reassign: fires booking.rescheduled");
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "reassign: invalidates cached slots for the bucket exactly once",
    );
    // #326: recorded as 'reassigned' (NOT 'rescheduled') so it doesn't inflate
    // the reschedule rate, initiator 'system', same time, agent change to B.
    assert(
      calls.bookingEvents.length === 1 &&
        calls.bookingEvents[0].action === "reassigned" &&
        calls.bookingEvents[0].initiator === "system" &&
        calls.bookingEvents[0].to_agent_user_id === "b" &&
        calls.bookingEvents[0].to_starts_at === calls.bookingEvents[0].from_starts_at,
      "reassign: records a 'reassigned' (not 'rescheduled') system event, same time, new agent",
    );
  }

  // --- #(reassign-cap): reassign onto an at-cap agent ---
  {
    const capEvent = { ...eventType, daily_cap: 1 } as unknown as EventType;
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    // B already has one booking on the booking's day (2026-06-08); cap is 1 -> over cap.
    const atCap = () =>
      makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType: capEvent },
        agentByEmail: owner,
        agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]),
      });

    // Default (overrideCap omitted) -> blocked.
    {
      const { deps, calls } = atCap();
      let err: unknown;
      try {
        await reassignBooking("bk1", "b@x.com", SYS, deps);
      } catch (e) {
        err = e;
      }
      assert(
        err != null && (err as Error).name === "DailyCapExceededError",
        "reassign(at cap, no override): throws DailyCapExceededError",
      );
      assert(
        calls.createEvent.length === 0 && calls.reassignSwaps.length === 0,
        "reassign(at cap, no override): no event created, no swap (nothing mutated)",
      );
    }

    // overrideCap=true -> forces through, reports overCap.
    {
      const { deps, calls } = atCap();
      const res = await reassignBooking("bk1", "b@x.com", SYS, deps, { overrideCap: true });
      assert(
        res.booking.assigned_user_id === "b" && res.overCap === true,
        "reassign(at cap, override): forces through and reports overCap=true",
      );
      assert(calls.createEvent.length === 1, "reassign(at cap, override): event created");
      assert(
        calls.agentActiveBookingStartsMs[0]?.excludeBookingId === "bk1",
        "reassign(cap check): excludes the booking being moved from the day count",
      );
    }
  }

  // --- #(reassign-cap): reassign onto an UNDER-cap agent succeeds, overCap=false ---
  {
    const capEvent = { ...eventType, daily_cap: 3 } as unknown as EventType;
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType: capEvent },
      agentByEmail: owner,
      agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]), // 1 < 3
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      res.booking.assigned_user_id === "b" && res.overCap === false,
      "reassign(under cap): succeeds, overCap=false",
    );
  }

  // --- #(reassign-cap): uncapped event never blocks, overCap=false ---
  {
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType }, // daily_cap: null
      agentByEmail: owner,
      agentDayBookings: new Map([["b", ["2026-06-08T15:00:00.000Z"]]]),
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(res.overCap === false, "reassign(uncapped): never over cap");
  }

  // --- #546: manager reassign records initiator 'admin' (not 'system') + the actor ---
  {
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({
      bookingById: { booking: makeBooking({}), bucket, eventType },
      agentByEmail: owner,
    });
    const res = await reassignBooking("bk1", "b@x.com", SYS, deps, {
      initiator: "admin",
      actor: { userId: "mgr1", actingAsUserId: null },
    });
    assert(res.booking.assigned_user_id === "b", "reassign(admin): booking moved");
    assert(
      calls.bookingEvents[0].initiator === "admin",
      "reassign(admin): history records initiator 'admin', not 'system'",
    );
    assert(
      calls.bookingEvents[0].actor_user_id === "mgr1",
      "reassign(admin): history records the acting manager (#549)",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "reassign(admin): still fires booking.rescheduled (Regal contract)",
    );
  }

  // --- #546: manager may reassign to an agent OUTSIDE the bookable pool only
  //     when allowNonBookable is set (coverage/escalation); else rejected. ---
  {
    const offPool = { id: "z", name: "Lead Z", email: "z@x.com", bookable: false } as unknown as User;
    {
      const { deps } = makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType },
        agentByEmail: offPool,
      });
      let err: unknown;
      try {
        await reassignBooking("bk1", "z@x.com", SYS, deps);
      } catch (e) {
        err = e;
      }
      assert(
        err != null && /not bookable/i.test((err as Error).message),
        "reassign(non-bookable, default): rejected",
      );
    }
    {
      const { deps, calls } = makeDeps({
        bookingById: { booking: makeBooking({}), bucket, eventType },
        agentByEmail: offPool,
      });
      const res = await reassignBooking("bk1", "z@x.com", SYS, deps, {
        allowNonBookable: true,
        initiator: "admin",
      });
      assert(
        res.booking.assigned_user_id === "z" && calls.createEvent.length === 1,
        "reassign(non-bookable, allowNonBookable): succeeds for coverage/escalation",
      );
    }
  }

  // --- reassign: new event uses a deterministic, target-keyed client id (#439 P4) ---
  // The reassign target is caller-supplied (deterministic), so a crash between the
  // create and the booking commit must reuse the SAME Google event on retry rather
  // than spawn a second. That requires a deterministic client id keyed on the
  // TARGET agent (so cross-agent moves don't collide) and on the booking.
  {
    const owner = (id: string, email: string) =>
      ({ id, name: `Owner ${id}`, email, bookable: true } as unknown as User);

    const dB = makeDeps({ bookingById: { booking: makeBooking({ id: "bk1" }), bucket, eventType }, agentByEmail: owner("b", "b@x.com") });
    await reassignBooking("bk1", "b@x.com", SYS, dB.deps);
    const clientB = dB.calls.createEvent[0]?.clientId;

    const dC = makeDeps({ bookingById: { booking: makeBooking({ id: "bk1" }), bucket, eventType }, agentByEmail: owner("c", "c@x.com") });
    await reassignBooking("bk1", "c@x.com", SYS, dC.deps);
    const clientC = dC.calls.createEvent[0]?.clientId;

    const d2 = makeDeps({ bookingById: { booking: makeBooking({ id: "bk2" }), bucket, eventType }, agentByEmail: owner("b", "b@x.com") });
    await reassignBooking("bk2", "b@x.com", SYS, d2.deps);
    const client2 = d2.calls.createEvent[0]?.clientId;

    assert(!!clientB && clientB.startsWith("slate"), "reassign: new event uses a deterministic 'slate' client id");
    assert(clientB !== clientC, "reassign: client id is keyed on the TARGET agent (B != C)");
    assert(clientB !== client2, "reassign: client id is keyed on the booking (bk1 != bk2)");

    // Determinism: the same booking + same target recomputes the SAME id, so a
    // crash-retry of this exact reassign reuses the event (Google 409) not a dup.
    const dB2 = makeDeps({ bookingById: { booking: makeBooking({ id: "bk1" }), bucket, eventType }, agentByEmail: owner("b", "b@x.com") });
    await reassignBooking("bk1", "b@x.com", SYS, dB2.deps);
    assert(
      dB2.calls.createEvent[0]?.clientId === clientB,
      "reassign: same booking+target yields the SAME client id (idempotent retry)",
    );
  }

  // --- reassign: same-target re-submit reuses the event, must NOT delete it (#449) ---
  // When the event created for the target equals the event the swap replaced
  // (a deterministic-id 409 reuse on a same-target re-submit), deleting it would
  // remove the LIVE event, so the guard must skip the delete.
  {
    // Booking currently on "a"; its current event id is "gcal-x". Make createEvent
    // return that same id, so the swap's previous == the new event.
    const ctx = { booking: makeBooking({ gcal_event_id: "gcal-x", agent_email: "a@x.com", assigned_user_id: "a" }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    deps.createEvent = async () => "gcal-x";
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.reassignSwaps.length === 1 && calls.deleteEvent.length === 0,
      "reassign: when the swap's previous event equals the new event, the live event is NOT deleted",
    );
  }

  // --- reassign: a swap that did not take (terminal) cleans up the created event (#449) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner, reassignSwapTerminal: true });
    let threw = false;
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign: a booking that went terminal during the swap surfaces an error");
    assert(calls.createEvent.length === 1, "reassign: the event was optimistically created");
    assert(
      calls.deleteEvent.length === 1,
      "reassign: the optimistically-created event is cleaned up (not orphaned) when the swap doesn't take",
    );
  }

  // --- reassign: a swap RPC error also cleans up the created event + rethrows (#449) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner, reassignSwapThrows: true });
    let msg = "";
    try {
      await reassignBooking("bk1", "b@x.com", SYS, deps);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg === "rpc down", "reassign: a swap RPC error surfaces the original error (not a masked message)");
    assert(
      calls.createEvent.length === 1 && calls.deleteEvent.length === 1,
      "reassign: a swap RPC error still cleans up the optimistically-created event (no orphan)",
    );
  }

  // --- reassign: unknown / offboarded agent is rejected ---
  {
    const { deps } = makeDeps({ bookingById: { booking: makeBooking({}), bucket, eventType }, agentByEmail: null });
    let threw = false;
    try {
      await reassignBooking("bk1", "ghost@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign: rejects an unknown/offboarded agent");
  }

  // --- reassign: booking not found ---
  {
    const { deps } = makeDeps({ bookingById: null });
    let threw = false;
    try {
      await reassignBooking("nope", "b@x.com", SYS, deps);
    } catch {
      threw = true;
    }
    assert(threw, "reassign: throws when the booking is not found");
  }

  // --- reassign: already the owning agent is a no-op ---
  {
    const ctx = { booking: makeBooking({ assigned_user_id: "b", agent_email: "b@x.com" }), bucket, eventType };
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", SYS, deps);
    assert(
      calls.createEvent.length === 0 && calls.commitReschedule.length === 0 && calls.webhooks.length === 0,
      "reassign: no-op when already the owning agent",
    );
  }

  // --- bookViaApi: no existing appointment -> create (#357) ---
  {
    const apiInput: ApiBookingInput = { ...input, externalId: "ext-new", confirmReschedule: false };
    const { deps, calls } = makeDeps({ personBookings: [] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "created", "bookViaApi: no match -> created");
    assert(calls.createEvent.length === 1, "bookViaApi create: a calendar event was created");
  }

  // --- bookViaApi: same person, SAME slot -> dedupe (no new booking) ---
  {
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", manage_token: "tokX" });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at,
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "deduped", "bookViaApi: external_id + same slot -> deduped");
    assert(res.booking.id === "bk-existing", "bookViaApi dedupe: returns the existing booking");
    assert(calls.createEvent.length === 0, "bookViaApi dedupe: creates no new calendar event");
  }

  // --- bookViaApi: same person (strong id), DIFFERENT time -> auto-reschedule ---
  {
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", starts_at: "2026-06-08T13:00:00.000Z" });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", "bookViaApi: strong match + new time -> rescheduled");
    assert(
      res.booking.starts_at === "2026-06-09T14:00:00.000Z",
      "bookViaApi reschedule: moved to the requested time",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.rescheduled"),
      "bookViaApi reschedule: emits booking.rescheduled",
    );
  }

  // --- bookViaApi: CROSS-BUCKET rebook -> move to the new bucket (#364) ---
  {
    // Existing appointment in a DIFFERENT bucket than the incoming request
    // (resolveBucketByCode resolves to bkt1; the existing booking is in bkt-OLD).
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: "ext-1",
      bucket_id: "bkt-OLD",
      starts_at: "2026-06-08T13:00:00.000Z",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", "bookViaApi cross-bucket -> rescheduled outcome");
    assert(
      res.booking.id === "bk-new",
      "bookViaApi cross-bucket: returns the NEW booking created in the new bucket",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.created"),
      "bookViaApi cross-bucket: a new booking is created in the target bucket",
    );
    assert(
      calls.webhooks.some((w) => w.event === "booking.cancelled"),
      "bookViaApi cross-bucket: the old appointment is cancelled",
    );
  }

  // --- bookViaApi: WEAK match (email only), different time -> confirm_required ---
  {
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: null,
      salesforce_id: "sf-other",
      attendee_email: "k@x.com",
      attendee_phone: "+19999999999",
      starts_at: "2026-06-08T13:00:00.000Z",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-new",
      salesforceId: "sf-different",
      attendee: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "confirm_required", "bookViaApi: weak match + new time -> confirm_required");
    assert(
      calls.createEvent.length === 0 && calls.commitReschedule.length === 0,
      "bookViaApi confirm_required: makes NO changes (no silent move of the wrong person)",
    );
  }

  // --- previewBooking (#380 dry run): preview WITHOUT any side effects ---
  {
    // No existing booking -> would create; returns the would-be agent, writes nothing.
    const dry: ApiBookingInput = { ...input, externalId: "ext-dry", confirmReschedule: false };
    const { deps, calls } = makeDeps({ personBookings: [] });
    const preview = await previewBooking(dry, deps);
    assert(preview.dryRun === true && preview.outcome === "created", "previewBooking: no match -> would create");
    assert(preview.wouldAssign?.email === "a@x.com", "previewBooking: returns the agent who WOULD be assigned");
    assert(
      calls.createEvent.length === 0 && calls.webhooks.length === 0,
      "previewBooking: creates NO calendar event and fires NO webhook",
    );
    assert(
      calls.roundRobinPreview.at(-1) === true,
      "previewBooking: routes in PREVIEW mode (so it skips the #321 shadow-study log + unfair-ordering alert)",
    );
  }
  {
    // Existing same-slot match -> would dedupe; no routing, no writes.
    const existingB = makeBooking({ id: "bk-existing", external_id: "ext-1", manage_token: "tokX" });
    const dry: ApiBookingInput = {
      ...input,
      startIso: existingB.starts_at,
      externalId: "ext-1",
      confirmReschedule: false,
    };
    const { deps, calls } = makeDeps({ personBookings: [existingB] });
    const preview = await previewBooking(dry, deps);
    assert(preview.outcome === "deduped", "previewBooking: same slot -> would dedupe");
    assert(preview.existingBookingId === "bk-existing", "previewBooking dedupe: names the existing booking");
    assert(calls.createEvent.length === 0, "previewBooking dedupe: no side effects");
  }
  {
    // Empty pool -> the dry run still surfaces the routing failure.
    const dry: ApiBookingInput = { ...input, externalId: "ext-dry2", confirmReschedule: false };
    const { deps } = makeDeps({ personBookings: [], candidates: [] });
    let err: unknown;
    try {
      await previewBooking(dry, deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof NoEligibleAgentsError, "previewBooking: surfaces NoEligibleAgentsError for a dead bucket");
  }

  // --- bookViaApi: WEAK match but bot confirmed -> reschedule ---
  {
    const existingB = makeBooking({
      id: "bk-existing",
      external_id: null,
      salesforce_id: "sf-other",
      attendee_email: "k@x.com",
      attendee_phone: "+19999999999",
      starts_at: "2026-06-08T13:00:00.000Z",
    });
    const apiInput: ApiBookingInput = {
      ...input,
      startIso: "2026-06-09T14:00:00.000Z",
      externalId: "ext-new",
      salesforceId: "sf-different",
      attendee: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
      confirmReschedule: true,
    };
    const { deps } = makeDeps({
      personBookings: [existingB],
      existing: { booking: existingB, bucket, eventType },
    });
    const res = await bookViaApi(apiInput, deps);
    assert(res.outcome === "rescheduled", "bookViaApi: weak match + confirmReschedule -> rescheduled");
  }

  // --- lookupPersonBookings (#386): maps active rows to API views ---
  {
    const bk = makeBooking({ id: "bkL", external_id: "ext-1", salesforce_id: "sf-9" });
    const { deps } = makeDeps({ personBookings: [bk] });
    const views = await lookupPersonBookings(
      { externalId: "ext-1", salesforceId: null, email: null, phone: null },
      deps,
    );
    assert(views.length === 1 && views[0].id === "bkL", "lookup returns one view");
    assert(views[0].manageUrl === "https://slate.test/booking/manage/tok1", "lookup view has manageUrl");
    assert(views[0].externalId === "ext-1" && views[0].status === "confirmed", "lookup view fields mapped");
  }

  // --- getPersonBookingById (#386) ---
  {
    const bk = makeBooking({ id: "bkG", external_id: "ext-1", status: "cancelled" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    const view = await getPersonBookingById(
      { bookingId: "bkG", identity: { externalId: "ext-1", salesforceId: null }, status: null },
      deps,
    );
    assert(view.id === "bkG" && view.status === "cancelled", "get-by-id returns any status when no filter");

    let threw = false;
    try {
      await getPersonBookingById(
        { bookingId: "bkG", identity: { externalId: "ext-1", salesforceId: null }, status: "confirmed" },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "get-by-id status filter mismatch → BookingNotFoundError");

    let threwOwner = false;
    try {
      await getPersonBookingById(
        { bookingId: "bkG", identity: { externalId: "stranger", salesforceId: null }, status: null },
        deps,
      );
    } catch (e) { threwOwner = e instanceof BookingNotFoundError; }
    assert(threwOwner, "get-by-id wrong owner → BookingNotFoundError");
  }
  {
    const { deps } = makeDeps({ bookingById: null });
    let threw = false;
    try {
      await getPersonBookingById(
        { bookingId: "nope", identity: { externalId: "ext-1", salesforceId: null }, status: null },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "get-by-id missing booking → BookingNotFoundError");
  }

  // --- #401: cancel enqueues the event deletion when Google delete fails ---
  {
    const bk = makeBooking({ id: "bkX", status: "confirmed", gcal_event_id: "gE", agent_email: "a@x.com" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, deleteEventThrows: true });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(calls.enqueueEventDeletion.length === 1, "cancel enqueues a deletion when deleteEvent fails");
    assert(calls.enqueueEventDeletion[0].eventId === "gE" && calls.enqueueEventDeletion[0].bookingId === "bkX",
      "enqueue carries the event id + booking id");
  }
  {
    // success path: no enqueue
    const bk = makeBooking({ id: "bkY", status: "confirmed", gcal_event_id: "gE2", agent_email: "a@x.com" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps, NOW);
    assert(calls.enqueueEventDeletion.length === 0, "cancel does NOT enqueue when deleteEvent succeeds");
  }

  // --- cancelDirectBooking (#386) ---
  {
    const bk = makeBooking({ id: "bkC", external_id: "ext-1", status: "confirmed", gcal_event_id: "g1" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, existing: ctx });
    const view = await cancelDirectBooking(
      { bookingId: "bkC", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
      deps,
    );
    assert(view.status === "cancelled", "cancel returns the cancelled view");
    // #402: assert the calendar side effect, not just the API verdict — a cancel
    // that returns {cancelled} but skips the gcal delete is exactly the #401
    // orphan bug. The booking's event id is "g1".
    assert(calls.deleteEvent.some((d) => d.id === "g1"), "cancel actually deletes the agent's calendar event");
    assert(calls.webhooks.some((w) => w.event === "booking.cancelled"), "cancel fires booking.cancelled");
    assert(calls.bookingEvents.some((e) => e.action === "cancelled" && e.initiator === "customer"),
      "cancel records a customer-initiated history row");
  }
  {
    const bk = makeBooking({ id: "bkD", external_id: "ext-1", status: "completed" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    let threw = false;
    try {
      await cancelDirectBooking(
        { bookingId: "bkD", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "cancel of a non-active booking → BookingNotFoundError");
  }
  {
    // Concurrent double-cancel (#398): both callers pass the active pre-check,
    // but the loser re-reads an already-cancelled row inside cancelBooking. It
    // must surface 404, not a second 200 { cancelled }.
    const active = makeBooking({ id: "bkE", external_id: "ext-1", status: "confirmed", gcal_event_id: "g1" });
    const cancelled = makeBooking({ id: "bkE", external_id: "ext-1", status: "cancelled", gcal_event_id: "g1" });
    const { deps, calls } = makeDeps({
      bookingById: { booking: active, bucket, eventType },   // pre-check sees active
      existing: { booking: cancelled, bucket, eventType },   // cancelBooking re-load sees cancelled
    });
    let threw = false;
    try {
      await cancelDirectBooking(
        { bookingId: "bkE", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "concurrent double-cancel: losing racer → BookingNotFoundError (not 200)");
    assert(calls.webhooks.length === 0, "losing racer fires no second booking.cancelled webhook");
  }

  {
    // Atomic double-cancel (#413): BOTH callers load an active context (neither
    // saw the other's write), so the read-then-write guard can't separate them.
    // The atomic claim must: exactly one wins (true), the other loses (false),
    // and the side effects (webhook, history) fire exactly once.
    const active = makeBooking({ id: "bkRace", status: "confirmed", gcal_event_id: "g1" });
    const ctx = { booking: active, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    const first = await cancelBooking("tokRace", CR, "customer", deps, NOW);
    const second = await cancelBooking("tokRace", CR, "customer", deps, NOW);
    assert(first === true, "atomic cancel: first caller wins the claim (true)");
    assert(second === false, "atomic cancel: second caller loses the claim (false), not a second success");
    assert(calls.webhooks.filter((w) => w.event === "booking.cancelled").length === 1,
      "atomic cancel: booking.cancelled fires exactly once");
    assert(calls.bookingEvents.filter((e) => e.action === "cancelled").length === 1,
      "atomic cancel: exactly one cancelled history row");
  }

  // --- listBookings (#392) ---
  {
    const b1 = makeBooking({ id: "L1", bucket_id: "bkt1", starts_at: "2026-06-08T13:00:00.000Z" });
    const b2 = makeBooking({ id: "L2", bucket_id: "bkt1", starts_at: "2026-06-08T14:00:00.000Z" });
    const { deps, calls } = makeDeps({ listResult: { rows: [b1, b2], buckets: [bucket] } });
    const res = await listBookings(
      { status: "confirmed", afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 2, offset: 0 },
      deps,
    );
    assert(res.items.length === 2 && res.items[0].id === "L1", "list returns the rows as views");
    assert(res.items[0].bucketCode === "411", "list item carries bucketCode from the buckets join");
    assert(res.nextCursor !== null, "full page (rows == limit) sets a nextCursor");
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "starts_at",
      "default order is starts_at");
  }
  {
    const b1 = makeBooking({ id: "L3", bucket_id: "bkt1" });
    const { deps } = makeDeps({ listResult: { rows: [b1], buckets: [bucket] } });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.nextCursor === null, "partial page (rows < limit) -> nextCursor null");
  }
  {
    // updatedSince switches the order key
    const { deps, calls } = makeDeps({ listResult: { rows: [], buckets: [] } });
    await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: "2026-06-01T00:00:00Z",
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "updated_at",
      "updatedSince selects updated_at order");
  }
  {
    // unknown bucket -> empty, no queryBookings scan
    const { deps, calls } = makeDeps({ unknownBucket: true });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: "999", agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.items.length === 0 && res.nextCursor === null, "unknown bucket -> empty page");
    assert(calls.queryBookings.length === 0, "unknown bucket -> no DB scan");
  }
  // --- routing_trace explainability stamping: excluded + tier fields on a criteria bucket ---
  // Asserts the core wiring added in feat/routing-explainability: a successful booking
  // stamps all explainability fields on the persisted booking's routing_trace.
  // Note: recordRoutingDecision is NOT injectable through BookingDeps — it calls
  // supabaseAdmin() directly and is wrapped in best-effort try/catch. Its invocation
  // is therefore observed only indirectly through the routing_trace fields it reads.
  {
    const criteriasBucket = {
      ...bucket,
      criteria: { debt_team: "T1" },
    } as unknown as Bucket;
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    // Override resolveBucketByCode to return a bucket with debt_team criteria.
    // Plan 2: requested_tier is now derived from tierKeyOf(input.bucketCode), not criteria.
    deps.resolveBucketByCode = async () => ({ bucket: criteriasBucket, eventType });
    const res = await createBooking(input, deps);

    const rt = res.booking.routing_trace;
    assert(
      rt != null && Array.isArray(rt.excluded),
      "routing_trace: excluded is present and is an array on a successful booking",
    );
    assert(
      rt?.requested_tier === "very_high",
      "routing_trace: requested_tier reflects the tier key for bucketCode '411' (very_high)",
    );
    assert(
      rt?.tier_fallback === false,
      "routing_trace: tier_fallback is false on a normal direct booking",
    );
    assert(
      rt?.rungs_dropped === 0,
      "routing_trace: rungs_dropped is 0 on a normal direct booking",
    );
    assert(
      rt?.chosen_user_id === "a",
      "routing_trace: chosen_user_id matches the assigned agent",
    );
    // The booking must still complete successfully and fire the creation webhook.
    assert(
      res.booking.id === "bk-new" && calls.webhooks.some((w) => w.event === "booking.created"),
      "routing_trace: booking succeeds and booking.created fires (recordRoutingDecision is best-effort, does not block)",
    );
  }

  // --- routing_trace explainability: no-criteria bucket still gets requested_tier from tierKeyOf ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    // Plan 2: requested_tier comes from tierKeyOf(bucketCode), not criteria.
    // bucketCode "411" -> "very_high" regardless of whether the bucket has criteria.
    const res = await createBooking(input, deps);
    const rt = res.booking.routing_trace;
    assert(
      rt != null && "requested_tier" in (rt as object) && rt?.requested_tier === "very_high",
      "routing_trace: requested_tier is tier key (very_high) for '411' even with no criteria",
    );
    assert(
      rt?.tier_fallback === false && rt?.rungs_dropped === 0,
      "routing_trace: tier_fallback and rungs_dropped are set to defaults when no criteria",
    );
  }

  // --- tier-drop cascade (Plan 2 Task 5): requested bucket empty -> cascade to lower tier ---
  {
    // "411" is the requested bucket (very_high tier). Make it appear empty so the cascade
    // drops one rung to "311" (high tier), which has a free agent.
    const bucket311 = { ...bucket, id: "bkt311", code: "311" } as unknown as Bucket;
    const { deps, calls } = makeDeps({ freeEmails: new Set(["a@x.com"]) });
    let rrCallCount = 0;
    // First roundRobinCandidates call is for "411" (no candidates), second for "311" (agent a).
    deps.roundRobinCandidates = async () => {
      rrCallCount++;
      return rrCallCount === 1 ? [] : ["a"];
    };
    deps.resolveBucketByCode = async (code: string) => {
      if (code === "411") return { bucket, eventType };
      if (code === "311") return { bucket: bucket311, eventType };
      return null;
    };
    const res = await createBooking(input, deps);
    const rt = res.booking.routing_trace;
    assert(rt?.tier_fallback === true, "tier-drop: tier_fallback is true on a cascade booking");
    assert(rt?.rungs_dropped === 1, "tier-drop: rungs_dropped is 1 for a single-rung drop");
    assert(rt?.requested_tier === "very_high", "tier-drop: requested_tier reflects the original bucket code (411 -> very_high)");
    assert(rt?.booked_tier === "high", "tier-drop: booked_tier reflects the lower bucket code (311 -> high)");
    assert(
      (res.booking as unknown as Record<string, unknown>).bucket_id === "bkt311",
      "tier-drop: booking is placed in the lower (booked) bucket, not the requested one",
    );
    // Regression: booking.created webhook must attribute to the BOOKED bucket (311),
    // not the requested one (411). A mismatch here means completeReservation resolved
    // the wrong bucket for fire().
    const tierDropWebhook = calls.webhooks.find((w) => w.event === "booking.created");
    assert(
      tierDropWebhook?.bucket_code === "311",
      `tier-drop: booking.created webhook bucket_code is the booked bucket ("311"), got "${tierDropWebhook?.bucket_code}"`,
    );
  }

  // --- tier-drop: VerifyUnavailableError is NOT a cascade trigger (outage guard) ---
  {
    const { deps } = makeDeps({
      candidates: ["a"],
      freeEmails: new Set(),
      unverifiedEmails: new Set(["a@x.com"]),
    });
    let err: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof VerifyUnavailableError,
      "tier-drop: VerifyUnavailableError propagates without cascading (outage not masked as tier-drop)",
    );
  }

  // --- #401 drain ---
  {
    const rows: PendingEventDeletion[] = [
      { id: "p1", calendar_email: "a@x.com", gcal_event_id: "e1", booking_id: null, attempts: 0, last_error: null, created_at: "2026-06-23T00:00:00.000Z", updated_at: "2026-06-23T00:00:00.000Z" },
      { id: "p2", calendar_email: "b@x.com", gcal_event_id: "e2", booking_id: null, attempts: 0, last_error: null, created_at: "2026-06-23T00:00:00.000Z", updated_at: "2026-06-23T00:00:00.000Z" },
    ];
    const { deps, calls } = makeDeps({ pending: rows }); // deleteEvent succeeds
    const res = await processPendingEventDeletions(deps, 50);
    assert(res.deleted === 2 && res.failed === 0, "drain deletes all and removes them");
    assert(calls.removePendingEventDeletion.length === 2, "successful deletes remove the rows");
  }
  {
    const rows: PendingEventDeletion[] = [{ id: "p3", calendar_email: "a@x.com", gcal_event_id: "e3", booking_id: null, attempts: PENDING_DELETION_ALERT_AFTER - 1, last_error: "x", created_at: "2026-06-23T00:00:00.000Z", updated_at: "2026-06-23T00:00:00.000Z" }];
    const { deps, calls } = makeDeps({ pending: rows, deleteEventThrows: true });
    const res = await processPendingEventDeletions(deps, 50);
    assert(res.failed === 1 && res.deleted === 0, "a failing delete is counted, not removed");
    assert(calls.bumpPendingEventDeletion[0].attempts === PENDING_DELETION_ALERT_AFTER, "bump records attempts+1");
    assert(res.stuck.length === 1, "a row crossing the alert threshold is reported as stuck");
    assert(calls.removePendingEventDeletion.length === 0, "a failing delete is NOT removed");
  }
}

await run();

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
