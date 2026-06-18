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
  SlotUnavailableError,
  type BookingDeps,
  type BookingContext,
  type CreateBookingInput,
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
}

function makeDeps(opts: FakeOpts) {
  const calls = {
    isFree: [] as string[],
    createEvent: [] as { email: string }[],
    deleteEvent: [] as { id: string }[],
    updateEventTime: [] as { id: string }[],
    insertBusyBlock: [] as { user_id: string; starts_at: string; ends_at: string; source: string }[],
    deleteBusyBlocks: [] as string[],
    updateBooking: [] as { id: string; patch: Record<string, unknown> }[],
    webhooks: [] as { event: string }[],
    claimReschedule: 0,
    releaseReschedule: 0,
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
    claimReschedule: async () => {
      calls.claimReschedule++;
      return !opts.rescheduleLocked;
    },
    releaseReschedule: async () => {
      calls.releaseReschedule++;
    },
    loadBookingContext: async () => opts.existing ?? null,
    loadBookingById: async () => opts.bookingById ?? null,
    getAgentByEmail: async () => opts.agentByEmail ?? null,
    loadPastBookingsToComplete: async () => opts.pastDue ?? [],
    emitWebhook: async (_orgId, event) => {
      calls.webhooks.push({ event });
    },
    newManageToken: () => "tok-fixed",
    appBaseUrl: () => "https://slate.test",
  };
  return { deps, calls };
}

async function run() {
  // --- createBooking: happy path ---
  {
    const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
    const res = await createBooking(input, deps);
    assert(res.booking.id === "bk-new", "create returns the persisted booking");
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
    assert(calls.isFree.length === 2, "create: checked A then B (one free-check each)");
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
    assert(calls.createEvent.length === 0, "create: no calendar event when no agent is free");
  }

  // --- reschedule: same agent free -> in-place move, no reassign, RR untouched ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", deps);
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
  }

  // --- reschedule idempotency: no-op when already at the requested instant ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // starts 13:00Z
    const { deps, calls } = makeDeps({ existing: ctx, freeEmails: new Set(["a@x.com"]) });
    const res = await rescheduleBooking("tok1", "2026-06-08T13:00:00.000Z", deps);
    assert(res.booking.starts_at === "2026-06-08T13:00:00.000Z", "reschedule no-op: returns the unchanged booking");
    assert(
      calls.claimReschedule === 0 && calls.updateEventTime.length === 0 && calls.createEvent.length === 0,
      "reschedule no-op: skips the lock and all calendar work when already at target",
    );
    assert(
      calls.updateBooking.length === 0 && calls.webhooks.length === 0,
      "reschedule no-op: no DB write or webhook for a same-instant reschedule",
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
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", deps);
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
    const res = await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", deps);
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
      await rescheduleBooking("tok1", "2026-06-09T14:00:00.000Z", deps);
    } catch {
      threw = true;
    }
    assert(threw, "reschedule: rejects a cancelled booking");

    const { deps: deps2 } = makeDeps({ existing: null });
    let threw2 = false;
    try {
      await rescheduleBooking("nope", "2026-06-09T14:00:00.000Z", deps2);
    } catch {
      threw2 = true;
    }
    assert(threw2, "reschedule: throws when booking not found");
  }

  // --- cancel: happy + idempotent ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", deps);
    assert(calls.deleteEvent.length === 1, "cancel: deletes the calendar event");
    assert(calls.deleteBusyBlocks.length === 1, "cancel: removes the busy block");
    assert(
      calls.updateBooking.length === 1 && calls.updateBooking[0].patch.status === "cancelled",
      "cancel: marks the booking cancelled",
    );
    assert(calls.webhooks[0].event === "booking.cancelled", "cancel: fires booking.cancelled");

    const ctx2 = { booking: makeBooking({ status: "cancelled" }), bucket, eventType };
    const { deps: d2, calls: c2 } = makeDeps({ existing: ctx2 });
    await cancelBooking("tok1", d2);
    assert(
      c2.deleteEvent.length === 0 && c2.updateBooking.length === 0 && c2.webhooks.length === 0,
      "cancel: no-op when already cancelled",
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
      calls.updateBooking.length === 2 && calls.updateBooking.every((u) => u.patch.status === "completed"),
      "complete: marks each due booking completed",
    );
    assert(
      calls.webhooks.length === 2 && calls.webhooks.every((w) => w.event === "booking.completed"),
      "complete: fires booking.completed for each",
    );

    const { deps: dEmpty } = makeDeps({ pastDue: [] });
    assert((await completePastBookings(dEmpty)) === 0, "complete: zero when nothing is due");
  }

  // --- reassign: force a booking onto an owning agent (double-book allowed) ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType }; // assigned to "a"@a@x.com
    const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    const res = await reassignBooking("bk1", "b@x.com", deps);
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
  }

  // --- reassign: unknown / offboarded agent is rejected ---
  {
    const { deps } = makeDeps({ bookingById: { booking: makeBooking({}), bucket, eventType }, agentByEmail: null });
    let threw = false;
    try {
      await reassignBooking("bk1", "ghost@x.com", deps);
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
      await reassignBooking("nope", "b@x.com", deps);
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
    await reassignBooking("bk1", "b@x.com", deps);
    assert(
      calls.createEvent.length === 0 && calls.updateBooking.length === 0 && calls.webhooks.length === 0,
      "reassign: no-op when already the owning agent",
    );
  }
}

await run();

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
