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
  SlotUnavailableError,
  VerifyUnavailableError,
  type BookingDeps,
  type BookingContext,
  type CreateBookingInput,
  type ApiBookingInput,
} from "../src/lib/booking/orchestration.ts";
import type { Booking, Bucket, EventType, User } from "../src/lib/db/types.ts";

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
  existing?: BookingContext | null;
  bookingById?: BookingContext | null; // loadBookingById (reassign)
  agentByEmail?: User | null; // getAgentByEmail (reassign)
  pastDue?: BookingContext[];
  rescheduleLocked?: boolean; // a concurrent reschedule already holds the lock
  alreadyCompleted?: Set<string>; // ids an overlapping tick already transitioned
  unverifiedEmails?: Set<string>; // emails verify-on-book couldn't check (outage)
  personBookings?: Booking[]; // findActiveBookingsForPerson result (#357)
}

function makeDeps(opts: FakeOpts) {
  const calls = {
    isFree: [] as string[],
    verifyFree: [] as string[][],
    createEvent: [] as { email: string }[],
    deleteEvent: [] as { id: string }[],
    updateEventTime: [] as { id: string }[],
    insertBusyBlock: [] as { user_id: string; starts_at: string; ends_at: string; source: string }[],
    deleteBusyBlocks: [] as string[],
    updateBooking: [] as { id: string; patch: Record<string, unknown> }[],
    completeBookingsIfDue: [] as string[][],
    webhooks: [] as { event: string; reason: unknown }[],
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
    }[],
    claimReschedule: 0,
    releaseReschedule: 0,
    invalidateSlots: [] as string[],
  };
  let seq = 0;
  let insertAttempted = false;
  const free = opts.freeEmails ?? new Set(["a@x.com", "b@x.com"]);
  const deps: BookingDeps = {
    resolveBucketByCode: async () => ({ bucket, eventType }),
    roundRobinCandidates: async () => opts.candidates ?? ["a"],
    isFree: async (email) => {
      calls.isFree.push(email);
      return free.has(email);
    },
    // Batched verify-on-book: one call per round-robin wave; returns the free
    // subset plus any emails that couldn't be checked. Mirrors the real dep.
    verifyFree: async (emails) => {
      calls.verifyFree.push(emails);
      const unverified = opts.unverifiedEmails ?? new Set<string>();
      return {
        free: new Set(emails.filter((e) => free.has(e))),
        unverified: new Set(emails.filter((e) => unverified.has(e))),
      };
    },
    createEvent: async (email) => {
      calls.createEvent.push({ email });
      return `gcal-${++seq}`;
    },
    deleteEvent: async (_email, id) => {
      calls.deleteEvent.push({ id });
    },
    updateEventTime: async (_email, id) => {
      calls.updateEventTime.push({ id });
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
    deleteBusyBlocksForBooking: async (id) => {
      calls.deleteBusyBlocks.push(id);
    },
    updateBooking: async (id, patch) => {
      calls.updateBooking.push({ id, patch: patch as Record<string, unknown> });
    },
    completeBookingsIfDue: async (ids) => {
      calls.completeBookingsIfDue.push(ids);
      // Return only the ids this tick flips; an id in `alreadyCompleted` models
      // a row an overlapping tick already transitioned, so it's excluded.
      return ids.filter((id) => !(opts.alreadyCompleted?.has(id) ?? false));
    },
    claimReschedule: async () => {
      calls.claimReschedule++;
      return !opts.rescheduleLocked;
    },
    releaseReschedule: async () => {
      calls.releaseReschedule++;
    },
    insertBookingEvent: async (row) => {
      calls.bookingEvents.push(row);
    },
    hasBookingEvent: async (bookingId, action, toStartsIso) =>
      calls.bookingEvents.some(
        (e) =>
          e.booking_id === bookingId &&
          e.action === action &&
          e.to_starts_at === toStartsIso,
      ),
    loadBookingContext: async () => opts.existing ?? null,
    loadBookingById: async () => opts.bookingById ?? null,
    findActiveBookingsForPerson: async () => opts.personBookings ?? [],
    getAgentByEmail: async () => opts.agentByEmail ?? null,
    loadPastBookingsToComplete: async () => opts.pastDue ?? [],
    emitWebhook: async (_orgId, event, payload) => {
      calls.webhooks.push({ event, reason: payload.reason });
    },
    newManageToken: () => "tok-fixed",
    appBaseUrl: () => "https://slate.test",
    invalidateSlots: async (bucketCode) => {
      calls.invalidateSlots.push(bucketCode);
    },
  };
  return { deps, calls };
}

// Validated reasons for the changed reschedule/cancel/reassign signatures.
const RR = { code: "schedule_conflict", detail: null }; // reschedule
const CR = { code: "no_longer_interested", detail: null }; // cancel
const SYS = { code: "owner_reassignment", detail: null }; // reassign (system)

async function run() {
  // --- createBooking: happy path ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-new", "create returns the persisted booking");
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
    assert(
      calls.insertBusyBlock.length === 1 &&
        calls.insertBusyBlock[0].user_id === "a" &&
        calls.insertBusyBlock[0].source === "slate",
      "create: write-through busy block for the booked agent",
    );
    assert(
      calls.insertBusyBlock[0].starts_at === "2026-06-08T13:00:00.000Z" &&
        calls.insertBusyBlock[0].ends_at === "2026-06-08T13:30:00.000Z",
      "create: busy block spans the booked slot (30m)",
    );
    assert(calls.webhooks.length === 1 && calls.webhooks[0].event === "booking.created", "create: fires booking.created");
    assert(calls.deleteEvent.length === 0, "create: no rollback on success");
    assert(
      calls.invalidateSlots.length === 1 && calls.invalidateSlots[0] === "411",
      "create: invalidates cached slots for the booked bucket exactly once",
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
    assert(calls.insertBusyBlock.length === 0, "create-fail: no busy block written");
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
    assert(calls.insertBusyBlock.length === 0 && calls.webhooks.length === 0, "create-conflict: no busy block / webhook");
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
      calls.insertBusyBlock.length === 0 && calls.webhooks.length === 0,
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
    assert(
      calls.createEvent.length === 1 && calls.deleteEvent.length === 1,
      "idempotency race: the loser's calendar event was rolled back",
    );
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
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps);
    assert(
      calls.updateEventTime.length === 1 && calls.updateEventTime[0].id === "gcal-old",
      "reschedule(same agent): moves the existing event in place",
    );
    assert(calls.createEvent.length === 0 && calls.deleteEvent.length === 0, "reschedule(same agent): no new/old event churn");
    assert(calls.deleteBusyBlocks.length === 1 && calls.insertBusyBlock.length === 1, "reschedule: busy block moved");
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

  // --- reschedule no-op / retry: records the reason ONCE, no move/webhook (#326 C1) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // starts 13:00Z
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", RR, "customer", deps);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule no-op: returns the unchanged booking");
    assert(
      calls.claimReschedule === 0 && calls.updateEventTime.length === 0 && calls.createEvent.length === 0,
      "reschedule no-op: skips the lock and all calendar work when already at target",
    );
    assert(
      calls.updateBooking.length === 0 && calls.webhooks.length === 0,
      "reschedule no-op: no DB write or webhook for a same-instant reschedule",
    );
    // The mandatory reason must NOT be silently dropped on the no-op path: it's
    // recorded once. A retry (same target) must not double-record it.
    assert(
      calls.bookingEvents.length === 1 && calls.bookingEvents[0].reason_code === "schedule_conflict",
      "reschedule no-op: records the reason once (never silently dropped)",
    );
    await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", RR, "customer", deps);
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
      rescheduleLocked: true, // another in-flight reschedule holds the lock
    });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule dup: returns the booking without moving it");
    assert(calls.claimReschedule === 1, "reschedule dup: attempted the claim");
    assert(
      calls.updateEventTime.length === 0 && calls.createEvent.length === 0 && calls.deleteEvent.length === 0,
      "reschedule dup: no calendar churn for the lock loser",
    );
    assert(
      calls.updateBooking.length === 0 && calls.webhooks.length === 0 && calls.releaseReschedule === 0,
      "reschedule dup: no DB write, no duplicate webhook, and doesn't release a lock it never held",
    );
  }

  // --- reschedule: same agent busy -> reassign to B ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, candidates: ["b"], freeEmails: new Set(["b@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps);
    assert(res.booking.assigned_user_id === "b" && res.booking.agent_email === "b@x.com", "reschedule(reassign): moves to free agent B");
    assert(calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-old", "reschedule(reassign): old event deleted");
    assert(calls.createEvent.length === 1, "reschedule(reassign): new event created for B");
    assert(calls.updateEventTime.length === 0, "reschedule(reassign): no in-place move");
  }

  // --- reschedule: terminal states / not found ---
  {
    const ctx = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps } = makeDeps({ existing: ctx });
    let threw = false;
    try {
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", RR, "customer", deps);
    } catch {
      threw = true;
    }
    assert(threw, "reschedule: rejects a cancelled booking");

    const { deps: deps2 } = makeDeps({ existing: null });
    let threw2 = false;
    try {
      await rescheduleBooking("nope", "2026-06-09T14:00:00.000Z", RR, "customer", deps2);
    } catch {
      threw2 = true;
    }
    assert(threw2, "reschedule: throws when booking not found");
  }

  // --- cancel: happy + idempotent ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps);
    assert(calls.deleteEvent.length === 1, "cancel: deletes the calendar event");
    assert(calls.deleteBusyBlocks.length === 1, "cancel: removes the busy block");
    assert(
      calls.updateBooking.length === 1 && calls.updateBooking[0].patch.status === "cancelled",
      "cancel: marks the booking cancelled",
    );
    assert(calls.webhooks[0].event === "booking.cancelled", "cancel: fires booking.cancelled");
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
      c2.deleteEvent.length === 0 && c2.updateBooking.length === 0 && c2.webhooks.length === 0,
      "cancel: no-op when already cancelled (no re-delete / re-webhook)",
    );
    // But the mandatory reason is still captured once for the already-cancelled
    // re-submit (covers a first attempt that flipped status but lost the reason).
    assert(
      c2.bookingEvents.length === 1 && c2.bookingEvents[0].action === "cancelled",
      "cancel re-submit: records the reason once for an already-cancelled booking",
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
    assert(calls.deleteEvent.length === 1 && calls.deleteEvent[0].id === "gcal-old", "reassign: old agent's event removed");
    assert(calls.createEvent.length === 1, "reassign: event created on the owning agent");
    const patch = calls.updateBooking.find((u) => u.id === "bk1")?.patch;
    assert(
      !!patch && patch.allow_double_book === true && patch.assigned_user_id === "b",
      "reassign: marks allow_double_book and the new agent",
    );
    assert(
      patch?.routing_trace?.reassignments?.[0]?.from === "a" &&
        patch?.routing_trace?.reassignments?.[0]?.to === "b",
      "reassign: records the override in routing_trace",
    );
    assert(calls.deleteBusyBlocks.length === 1 && calls.insertBusyBlock.length === 1, "reassign: busy block moved to the owner");
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
      calls.createEvent.length === 0 && calls.updateBooking.length === 0 && calls.webhooks.length === 0,
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
      calls.createEvent.length === 0 && calls.updateBooking.length === 0,
      "bookViaApi confirm_required: makes NO changes (no silent move of the wrong person)",
    );
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
}

await run();

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
