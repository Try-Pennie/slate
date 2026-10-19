import { describe, it, expect, vi, beforeEach } from "vitest";

// #1643: the one line refusals in the booking service that nothing drove.
//
// Each refusal below was found by putting it out of action and running every
// vitest file that loads the real `service.ts`: none went red. An untested one
// line refusal reads as a safeguard in review and costs nothing to delete, and the
// first thing to notice it gone is the state it was written to prevent (L1).
//
// Each test asserts the SPECIFIC refusal (its class, or the words naming what was
// refused and for which record), never merely that something threw: a deleted
// guard often still throws, only later and as a TypeError about an undefined row,
// which a bare `rejects.toThrow()` would accept (L140). Each also carries a control
// where the same call lands, so a dep hard wired to throw cannot pass (L159).
//
// The client is a small thenable chain: every builder method returns the chain,
// and awaiting it answers with what the test queued for that table (or rpc), so
// the code under test runs its own real chain of calls.

type Answer = { data?: unknown; error?: unknown; count?: number | null };

const db = vi.hoisted(() => ({
  queued: new Map<string, Answer[]>(),
  ops: [] as string[],
}));

function answerFor(key: string): Answer {
  const q = db.queued.get(key);
  if (q && q.length > 1) return q.shift()!;
  if (q && q.length === 1) return q[0];
  return { data: null, error: null };
}

/** Queue answers for a table (`bookings`) or an rpc (`rpc:name`), in call order; the last repeats. */
function answer(key: string, ...answers: Answer[]): void {
  db.queued.set(key, answers);
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string) => {
      db.ops.push(`rpc:${fn}`);
      const a = answerFor(`rpc:${fn}`);
      return { data: a.data ?? null, error: a.error ?? null };
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const a = answerFor(table);
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve({ data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }).then(resolve, reject);
            }
            return (..._args: unknown[]) => {
              db.ops.push(`${table}.${String(prop)}`);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  }),
}));

// The read failure refusals page through the dispatcher; nothing here may reach Slack.
const sendThrottledAlert = vi.hoisted(() => vi.fn(async () => {}));
const resolveRecovered = vi.hoisted(() => vi.fn(async (_entries: { key: string; text: string }[]) => {}));
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert,
  resolveRecovered,
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/notify/streak", () => ({
  recordConsecutiveStreak: vi.fn(async () => false),
  clearFailureStreak: vi.fn(async () => {}),
}));

import {
  realDeps,
  calendarIdsForEmail,
  calendarsForEmails,
  findActiveBookingsStartingAt,
  adminCancelBooking,
  adminRescheduleBooking,
  drainBookingOutbox,
} from "./service";
import { AgentHeldError } from "./reroute";

beforeEach(() => {
  db.queued.clear();
  db.ops.length = 0;
  sendThrottledAlert.mockClear();
  resolveRecovered.mockClear();
});

const refused = (message: string, extra: Record<string, unknown> = {}) => ({ data: null, error: { message, ...extra } });

describe("a calendar lookup that could not be read says so, rather than answering no calendars", () => {
  it("calendarIdsForEmail: a failed user read is readFailed, never an agent with no calendars", async () => {
    answer("users", refused("connection reset"));
    await expect(calendarIdsForEmail("agent@trypennie.com")).resolves.toEqual({ readFailed: true, ids: [] });
  });

  it("CONTROL: a user who genuinely is not there is not a failed read", async () => {
    answer("users", { data: null, error: null });
    await expect(calendarIdsForEmail("nobody@trypennie.com")).resolves.toEqual({ readFailed: false, ids: [] });
  });

  it("calendarsForEmails: a failed calendar read marks every agent unreadable, never falls back to their primary", async () => {
    const ids = new Map([["a@trypennie.com", "u-a"], ["b@trypennie.com", "u-b"]]);
    answer("agent_calendars", refused("statement timeout"));
    const res = await calendarsForEmails(["a@trypennie.com", "b@trypennie.com"], ids);
    expect([...res.readFailed].sort()).toEqual(["a@trypennie.com", "b@trypennie.com"]);
    expect(res.byEmail.size).toBe(0);
  });

  it("CONTROL: a calendar read that lands reads nobody as failed", async () => {
    const ids = new Map([["a@trypennie.com", "u-a"]]);
    answer("agent_calendars", { data: [{ user_id: "u-a", calendar_id: "cal-a" }], error: null });
    const res = await calendarsForEmails(["a@trypennie.com"], ids);
    expect(res.readFailed.size).toBe(0);
    expect(res.byEmail.get("a@trypennie.com")).toEqual(["cal-a"]);
  });
});

describe("findActiveBookingsStartingAt refuses a list that may be incomplete (#3257)", () => {
  const row = (i: number) => ({ id: `bk-${i}`, starts_at: "2026-10-20T14:00:00.000Z", status: "confirmed" });

  it("throws when the read reached its row bound, naming the bound", async () => {
    answer("bookings", { data: Array.from({ length: 500 }, (_, i) => row(i)), error: null });
    await expect(findActiveBookingsStartingAt("2026-10-20T14:00:00.000Z")).rejects.toThrow(
      /500 rows reached the 500 row bound, so the list may be incomplete/,
    );
  });

  it("CONTROL: a list under the bound is answered whole", async () => {
    answer("bookings", { data: Array.from({ length: 499 }, (_, i) => row(i)), error: null });
    await expect(findActiveBookingsStartingAt("2026-10-20T14:00:00.000Z")).resolves.toHaveLength(499);
  });
});

describe("the lead's own details are never reported saved off a refused write (#1341, #2164)", () => {
  it("updateBookingPhone throws, naming the phone update", async () => {
    answer("bookings", refused("permission denied for table bookings"));
    await expect(realDeps().updateBookingPhone("bk-1", "+15555550100")).rejects.toThrow(
      /booking phone update failed: permission denied/,
    );
  });

  it("CONTROL: a phone write that lands resolves", async () => {
    answer("bookings", { data: null, error: null });
    await expect(realDeps().updateBookingPhone("bk-1", "+15555550100")).resolves.toBeUndefined();
  });

  it("updateBookingContact throws, naming the contact update", async () => {
    answer("bookings", refused("permission denied for table bookings"));
    await expect(realDeps().updateBookingContact("bk-1", { attendee_name: "Jo" })).rejects.toThrow(
      /booking contact update failed: permission denied/,
    );
  });

  it("CONTROL: a write that lands resolves", async () => {
    answer("bookings", { data: null, error: null });
    await expect(realDeps().updateBookingContact("bk-1", { attendee_name: "Jo" })).resolves.toBeUndefined();
  });
});

describe("the reassign swap refuses rather than reading a failure as a move (#449, #3249)", () => {
  const base = {
    bookingId: "bk-1",
    userId: "u-2",
    agentName: "Sam",
    agentEmail: "sam@trypennie.com",
    gcalEventId: "evt-1",
    gcalClientId: "evt-1",
    routingTrace: null as never,
  };
  const reroute = {
    holdId: "hold-1",
    bucketId: "b-2",
    requestedBucketId: "b-2",
    requestedTier: "T2",
    bookedTier: "T2",
    rungsDropped: 0,
    fromBucketId: "b-1",
  };
  const held = { message: "agent is held", code: "23P01", details: "held_until=2026-10-20T19:04:00Z" };

  for (const [label, args] of [
    ["the plain swap", base],
    ["the reroute swap", { ...base, reroute }],
  ] as const) {
    it(`${label}: an advisor held for a bucket correction is its own refusal, carrying when it ends`, async () => {
      answer("rpc:reassign_booking_swap", { data: null, error: held });
      const err = await realDeps().reassignSwap(args).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentHeldError);
      expect((err as AgentHeldError).heldUntilIso).toBe("2026-10-20T19:04:00Z");
    });

    it(`${label}: any other refusal throws, naming the swap and the booking`, async () => {
      answer("rpc:reassign_booking_swap", refused("deadlock detected", { code: "40P01" }));
      await expect(realDeps().reassignSwap(args)).rejects.toThrow(
        /reassign_booking_swap (\(reroute\) )?failed for booking bk-1: deadlock detected/,
      );
    });
  }

  it("the reroute swap refuses an answer with no row, rather than reading it as nothing moved", async () => {
    answer("rpc:reassign_booking_swap", { data: [], error: null });
    await expect(realDeps().reassignSwap({ ...base, reroute })).rejects.toThrow(
      /reassign_booking_swap \(reroute\) returned no row for booking bk-1/,
    );
  });

  it("CONTROL: both swaps read the row they are answered with", async () => {
    answer("rpc:reassign_booking_swap", {
      data: [{ prev_gcal_event_id: "evt-0", prev_agent_email: "old@trypennie.com", updated: true, refused: null }],
      error: null,
    });
    await expect(realDeps().reassignSwap(base)).resolves.toEqual({
      prevGcalEventId: "evt-0",
      prevAgentEmail: "old@trypennie.com",
      updated: true,
    });
    await expect(realDeps().reassignSwap({ ...base, reroute })).resolves.toEqual({
      prevGcalEventId: "evt-0",
      prevAgentEmail: "old@trypennie.com",
      updated: true,
      refused: null,
    });
  });
});

describe("the reconcile sweeps abort a tick rather than act on an empty read", () => {
  // Each empty answer is an instruction: no statuses frees every slot, no in flight
  // cancels re-reports every one as stuck, no blocks re-inserts a block for all.
  it("loadBookingStatuses throws rather than answering that no booking exists", async () => {
    answer("bookings", refused("connection reset"));
    await expect(realDeps().loadBookingStatuses(["bk-1"])).rejects.toThrow(
      /reconcile: loadBookingStatuses failed: connection reset/,
    );
  });

  it("loadInflightCancelBookingIds throws rather than answering that no cancel is in flight", async () => {
    answer("booking_outbox", refused("connection reset"));
    await expect(realDeps().loadInflightCancelBookingIds(["bk-1"])).rejects.toThrow(
      /reconcile: loadInflightCancelBookingIds failed: connection reset/,
    );
  });

  it("loadBusyBlockBookingIds throws rather than answering that no booking holds a block", async () => {
    answer("busy_blocks", refused("connection reset"));
    await expect(realDeps().loadBusyBlockBookingIds(["bk-1"])).rejects.toThrow(
      /reconcile-missing: loadBusyBlockBookingIds failed: connection reset/,
    );
  });

  it("CONTROL: reads that land answer what they read", async () => {
    answer("bookings", { data: [{ id: "bk-1", status: "confirmed" }], error: null });
    await expect(realDeps().loadBookingStatuses(["bk-1"])).resolves.toEqual(new Map([["bk-1", "confirmed"]]));
    answer("booking_outbox", { data: [{ booking_id: "bk-1" }], error: null });
    await expect(realDeps().loadInflightCancelBookingIds(["bk-1"])).resolves.toEqual(new Set(["bk-1"]));
    answer("busy_blocks", { data: [{ booking_id: "bk-1" }], error: null });
    await expect(realDeps().loadBusyBlockBookingIds(["bk-1"])).resolves.toEqual(new Set(["bk-1"]));
  });
});

describe("the durable records of a booking's pending work refuse rather than vanish", () => {
  it("enqueueOutbox refuses an insert that answered no row, rather than returning no id", async () => {
    answer("booking_outbox", { data: null, error: null });
    await expect(
      realDeps().enqueueOutbox({ booking_id: "bk-1", action: "cancel", steps: [], payload: {} } as never),
    ).rejects.toThrow(/enqueueOutbox: insert returned no row/);
  });

  it("CONTROL: an insert that lands returns the row's id", async () => {
    answer("booking_outbox", { data: { id: "ob-1" }, error: null });
    await expect(
      realDeps().enqueueOutbox({ booking_id: "bk-1", action: "cancel", steps: [], payload: {} } as never),
    ).resolves.toBe("ob-1");
  });

  it("insertReservation refuses when neither the insert nor the race winner's read answered", async () => {
    answer("booking_reservations", refused("permission denied for table booking_reservations"));
    await expect(realDeps().insertReservation({ idempotency_key: "k-1" } as never)).rejects.toThrow(
      /insertReservation failed: permission denied/,
    );
  });

  it("CONTROL: a lost insert race adopts the winner's row", async () => {
    answer(
      "booking_reservations",
      refused("duplicate key value violates unique constraint", { code: "23505" }),
      { data: { id: "resv-w", idempotency_key: "k-1" }, error: null },
    );
    await expect(realDeps().insertReservation({ idempotency_key: "k-1" } as never)).resolves.toMatchObject({
      id: "resv-w",
    });
  });

  it("repinReservationEvent throws on a refused repoint, naming the reservation", async () => {
    answer("booking_reservations", refused("deadlock detected"));
    await expect(realDeps().repinReservationEvent("resv-1", "c-old", "c-new")).rejects.toThrow(
      /reservation resv-1 could not be repinned: deadlock detected/,
    );
  });

  it("repinReservationEvent throws when the row no longer names the event it was asked to move", async () => {
    answer("booking_reservations", { data: [], error: null });
    await expect(realDeps().repinReservationEvent("resv-1", "c-old", "c-new")).rejects.toThrow(
      /reservation resv-1 no longer names c-old, so it was not repinned/,
    );
  });

  it("CONTROL: a repoint that lands resolves", async () => {
    answer("booking_reservations", { data: [{ id: "resv-1" }], error: null });
    await expect(realDeps().repinReservationEvent("resv-1", "c-old", "c-new")).resolves.toBeUndefined();
  });

  it("writeReassignIntent throws rather than losing the record a reassign is in flight (#518)", async () => {
    answer("reassign_intents", refused("permission denied for table reassign_intents"));
    await expect(
      realDeps().writeReassignIntent({ bookingId: "bk-1", pinnedAgentEmail: "sam@trypennie.com", gcalClientId: "c-1" }),
    ).rejects.toThrow(/reassign_intents upsert failed: permission denied/);
  });

  it("CONTROL: an intent that lands resolves", async () => {
    answer("reassign_intents", { data: null, error: null });
    await expect(
      realDeps().writeReassignIntent({ bookingId: "bk-1", pinnedAgentEmail: "sam@trypennie.com", gcalClientId: "c-1" }),
    ).resolves.toBeUndefined();
  });
});

describe("an admin action on a booking id that resolves to no booking stops there (#326)", () => {
  // The manage token is what the admin action reuses the lead's flow through. With
  // none, nothing past the lookup may run: the message alone cannot show that,
  // because the lead's flow refuses an unknown token with the same words, so the
  // test also pins that the token read was the ONLY call made.
  const reason = { code: "other", detail: null };
  const actor = { userId: "admin-1", actingAsUserId: null };
  const tokenReadOnly = ["bookings.select", "bookings.eq", "bookings.maybeSingle"];

  it("adminCancelBooking refuses, having read nothing but the token", async () => {
    answer("bookings", { data: null, error: null });
    await expect(adminCancelBooking("bk-gone", reason, actor)).rejects.toThrow(/^Booking not found$/);
    expect(db.ops).toEqual(tokenReadOnly);
  });

  it("adminRescheduleBooking refuses, having read nothing but the token", async () => {
    answer("bookings", { data: null, error: null });
    await expect(
      adminRescheduleBooking("bk-gone", "2026-10-20T14:00:00.000Z", reason, actor),
    ).rejects.toThrow(/^Booking not found$/);
    expect(db.ops).toEqual(tokenReadOnly);
  });
});

describe("the outbox drain clears its stuck page only off a count it could read (#3359)", () => {
  // `countStoredStuckRows` logs and THROWS on an unreadable count. Answered as 0
  // instead, the drain would post "caught up" about a table nobody managed to read
  // (#1152, L98).
  const stuckCleared = () =>
    resolveRecovered.mock.calls.some(([entries]) => entries.some((e) => e.key === "outbox_drain_stuck"));

  it("an unreadable stored count clears nothing", async () => {
    answer("booking_outbox", { data: [], error: null }, { data: null, error: { message: "statement timeout" } });
    await drainBookingOutbox();
    expect(db.ops).toContain("booking_outbox.select");
    expect(stuckCleared()).toBe(false);
  });

  it("CONTROL: a stored count of zero clears the stuck page", async () => {
    answer("booking_outbox", { data: [], error: null }, { data: null, error: null, count: 0 });
    await drainBookingOutbox();
    expect(stuckCleared()).toBe(true);
  });
});
