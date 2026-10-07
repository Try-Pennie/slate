import { describe, it, expect, vi, beforeEach } from "vitest";

// #2482: the REAL dependency wiring, driven against a client that refuses.
//
// Every orchestration test injects fakes, which is correct for the orchestration
// and leaves this half, the one that actually talks to Postgres, covered by
// nothing. It is exactly where a write that discards its result lives: supabase-js
// resolves `{ error }` rather than throwing, so a refused statement used to run to
// completion and the caller carried on as though it had landed.
//
// What is pinned here is the pair of writes whose refusal LOSES something nothing
// else can reconstruct, plus a control for each proving the dep still works when
// the write succeeds (without which a dep hard wired to throw would pass, L159).

/** Set to make the next write refuse the way Postgres refuses. */
let writeError: { message: string; code?: string; details?: string; hint?: string } | null = null;

const upserted: unknown[] = [];
const updated: unknown[] = [];

function result() {
  return writeError ? { data: null, error: writeError } : { data: null, error: null };
}

/** Set to make the next `select(...).in(...)` read refuse the way PostgREST does. */
let readError: { message: string } | null = null;
/** What a `select(...).in(...)` read returns when it lands. */
let readRows: unknown[] = [];
const readTables: string[] = [];
/** What a `select(...).eq(...).single()` read answers (#3477). */
let singleResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
/** #3495: what the next `rpc(...)` answers, and every rpc asked. */
let rpcResult: { data: unknown; error: { message: string; code?: string } | null } = { data: null, error: null };
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
    from: (table: string) => ({
      upsert: (row: unknown) => {
        upserted.push(row);
        return result();
      },
      update: (patch: unknown) => ({
        eq: () => {
          updated.push(patch);
          return result();
        },
      }),
      insert: () => ({ select: () => ({ single: async () => result() }) }),
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), single: async () => singleResult }),
        in: async () => {
          readTables.push(table);
          return readError ? { data: null, error: readError } : { data: readRows, error: null };
        },
      }),
      delete: () => ({ eq: () => result() }),
    }),
  }),
}));

import { realDeps } from "./service";
import { CommitRefusedError, type CommitFreshInput } from "./orchestration";
import { isDeadlineExceeded } from "@/lib/fetch-within-deadline";

beforeEach(() => {
  writeError = null;
  upserted.length = 0;
  updated.length = 0;
  readError = null;
  readRows = [];
  readTables.length = 0;
  singleResult = { data: null, error: null };
});

describe("the reads that word a refused calendar (#1630)", () => {
  // A refused calendar is worded as a departure only when its owner's deactivation
  // was READ. These reads must refuse rather than answer empty: an empty owner list
  // happens to fall back to the page, but an empty bookings list would claim no call
  // moved, and either way the failure would vanish without a log line.
  it("refuses rather than answering that nobody owns the calendars", async () => {
    readError = { message: "canceling statement due to statement timeout" };
    await expect(realDeps().loadCalendarOwners(["left@trypennie.com"])).rejects.toThrow(/statement timeout/);
    expect(readTables).toEqual(["users"]);
  });

  it("refuses rather than answering that no call moved", async () => {
    readError = { message: "connection reset" };
    await expect(realDeps().loadBookingAssignees(["bk-1"])).rejects.toThrow(/connection reset/);
    expect(readTables).toEqual(["bookings"]);
  });

  it("CONTROL: reads that land return the rows", async () => {
    readRows = [{ id: "u-1", email: "left@trypennie.com", name: "Jane Doe", deactivated_at: "2026-10-05T14:43:27.000Z" }];
    await expect(realDeps().loadCalendarOwners(["left@trypennie.com"])).resolves.toEqual(readRows);
    readRows = [{ id: "bk-1", assigned_user_id: "u-2", status: "confirmed" }];
    await expect(realDeps().loadBookingAssignees(["bk-1"])).resolves.toEqual(readRows);
  });
});

describe("enqueueEventDeletion (#2482)", () => {
  // This row IS the record that a Google event still has to be deleted, and
  // nothing else holds that fact. A refusal that carried on left the event on an
  // advisor's calendar for ever, blocking a slot for a booking that is gone.
  it("refuses rather than losing the record that an event must be deleted", async () => {
    writeError = { message: "permission denied for table pending_event_deletions" };
    await expect(
      realDeps().enqueueEventDeletion("agent@trypennie.com", "evt-1", "bk-1"),
    ).rejects.toThrow(/permission denied/);
  });

  it("names the booking, so a failure in a sweep says which one", async () => {
    writeError = { message: "deadlock detected" };
    await expect(
      realDeps().enqueueEventDeletion("agent@trypennie.com", "evt-1", "bk-99"),
    ).rejects.toThrow(/bk-99/);
  });

  it("CONTROL: a write that lands returns, and really wrote the row", async () => {
    await expect(
      realDeps().enqueueEventDeletion("agent@trypennie.com", "evt-2", "bk-2"),
    ).resolves.toBeUndefined();
    expect(upserted).toHaveLength(1);
  });
});

describe("writeReschedulePin (#2482)", () => {
  // The pin is what makes a reschedule deterministic across a crash: the retry
  // re-reads it and lands on the same agent and the same event id. With no pin the
  // retry is free to pick somebody else, which is the one thing it exists to stop.
  const pin = {
    pinned_user_id: "u1",
    pinned_agent_email: "a@trypennie.com",
    gcal_client_id: "c1",
    branch: "in_place" as const,
    reschedule_seq: 1,
    target_starts_at: "2026-09-18T14:00:00.000Z",
  };

  it("refuses rather than leaving a reschedule free to pick another agent", async () => {
    writeError = { message: "could not serialize access" };
    await expect(realDeps().writeReschedulePin("bk-3", pin)).rejects.toThrow(
      /could not serialize/,
    );
  });

  it("names the booking", async () => {
    writeError = { message: "deadlock detected" };
    await expect(realDeps().writeReschedulePin("bk-77", pin)).rejects.toThrow(/bk-77/);
  });

  it("CONTROL: a write that lands returns, and really wrote the pin", async () => {
    await expect(realDeps().writeReschedulePin("bk-4", pin)).resolves.toBeUndefined();
    expect(updated).toHaveLength(1);
  });
});

describe("a fresh booking's one call save (#3495)", () => {
  // What the save writes is proved in a real Postgres (scripts/verify-commit-fresh-booking-sql.ts),
  // including that the reroute hold trigger's 23P01 (#3251) and both slot guards are
  // answered as a conflict with nothing written. What is pinned here is how the live
  // dependency reads the call's answer and its refusals.
  const booking = {
    id: "10000000-0000-4000-8000-000000000001",
    org_id: "o1",
    status: "confirmed",
    starts_at: "2031-03-04T15:00:00+00:00",
    ends_at: "2031-03-04T15:20:00+00:00",
    manage_token: "tok",
    assigned_user_id: "A",
  };
  const req = {
    booking: { ...booking, starts_at: "2031-03-04T15:00:00.000Z" },
    reservationId: "r1",
    webhook: { payload: { booking_id: booking.id }, dedupeKey: booking.id, suppressed: false },
    routing: null,
  } as unknown as CommitFreshInput;
  const endpoint = {
    id: "ep1", org_id: "o1", url: "https://receiver.example/hook", secret: null, events: ["booking.created"],
    format: "generic", auth_header: null, active: true, created_at: "2031-03-01T00:00:00+00:00",
  };

  beforeEach(() => {
    rpcCalls.length = 0;
  });

  it("reads a conflict as the lost race the next advisor branch starts from, a reroute hold's included (#3251)", async () => {
    rpcResult = { data: { status: "conflict", winner: null }, error: null };
    const r = await realDeps().commitFreshBooking(req);
    expect(r).toEqual({ kind: "conflict", winner: null });
    expect(rpcCalls[0]?.fn).toBe("commit_fresh_booking");
  });

  it("decides the webhook's suppression for every format, in the call itself", async () => {
    rpcResult = { data: { status: "conflict", winner: null }, error: null };
    await realDeps().commitFreshBooking(req);
    const hook = rpcCalls[0]?.args.p_webhook as { event: string; dedupe_key: string; suppression: Record<string, unknown> };
    expect(hook.event).toBe("booking.created");
    expect(hook.dedupe_key).toBe(booking.id);
    expect(Object.keys(hook.suppression).sort()).toEqual(["generic", "regal"]);
  });

  it("throws CommitRefusedError for a refusal Postgres answered, which wrote nothing", async () => {
    rpcResult = { data: null, error: { code: "42501", message: "permission denied for function commit_fresh_booking" } };
    await expect(realDeps().commitFreshBooking(req)).rejects.toBeInstanceOf(CommitRefusedError);
  });

  it("control: a deadline is NOT a refusal, so the confirm reads the booking back, and the deadline still reaches the route", async () => {
    rpcResult = {
      data: null,
      error: { code: "ABORT_ERR", message: "DeadlineExceededError: writing the booking did not answer within 900ms" },
    };
    const err = await realDeps().commitFreshBooking(req).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CommitRefusedError);
    expect(isDeadlineExceeded(err)).toBe(true);
  });

  it("returns the committed booking and hands each delivery's first send to the scheduler", async () => {
    rpcResult = {
      data: {
        status: "committed",
        booking,
        enqueue: { subscribers: 1, deliveries: [{ id: "d1", suppressed: false, payload: { booking_id: booking.id }, endpoint }] },
        failed: {},
        reservation_deleted: true,
      },
      error: null,
    };
    const scheduled: (() => Promise<void>)[] = [];
    const r = await realDeps((work) => {
      scheduled.push(work);
    }).commitFreshBooking(req);
    expect(r.kind).toBe("committed");
    expect(r.kind === "committed" && r.booking.id).toBe(booking.id);
    expect(r.kind === "committed" && r.reservationDeleted).toBe(true);
    expect(scheduled).toHaveLength(1);
  });

  it("refuses an answer it cannot read, rather than reading it as a conflict or a commit", async () => {
    rpcResult = { data: { status: "maybe" }, error: null };
    await expect(realDeps().commitFreshBooking(req)).rejects.toThrow(/status/);
  });
});

// #3477: the advisor read the confirm makes before it writes the booking. It used to
// read `data` alone under an error-ok reason written for the drain, so a read that
// failed (on load run 37587811697, one that hit its deadline with the confirm's budget
// nearly spent) resolved null against a `Promise<User>` type, and the confirm then
// threw a TypeError on `agent.name` and answered 500 INTERNAL. It must refuse instead,
// so the confirm answers the retryable dependency error it really met.
describe("getUser refuses a failed read rather than answering null (#3477)", () => {
  it("rejects when the read fails", async () => {
    singleResult = { data: null, error: { message: "supabase did not answer within 65ms" } };
    await expect(realDeps().getUser("u1")).rejects.toThrow(/65ms/);
  });

  it("throws a read cut short by the budget as the deadline it is, so the confirm answers 503", async () => {
    singleResult = { data: null, error: { message: "TypeError: DeadlineExceededError: supabase did not answer within 65ms, when the booking confirm ran out of its 12000ms" } };
    const err = await realDeps().getUser("u1").then(() => null, (e: unknown) => e);
    expect(isDeadlineExceeded(err)).toBe(true);
  });

  it("control: answers the advisor when the read lands", async () => {
    singleResult = { data: { id: "u1", name: "Ada" }, error: null };
    await expect(realDeps().getUser("u1")).resolves.toMatchObject({ id: "u1", name: "Ada" });
  });
});
