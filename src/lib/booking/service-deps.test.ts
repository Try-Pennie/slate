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

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
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
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      delete: () => ({ eq: () => result() }),
    }),
  }),
}));

import { realDeps } from "./service";

beforeEach(() => {
  writeError = null;
  upserted.length = 0;
  updated.length = 0;
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

describe("insertBooking and a reroute hold (#3251)", () => {
  // The bookings trigger refuses a lead's call on an advisor an admin is holding
  // for a bucket correction, with the SAME SQLSTATE an overlap race raises (23P01),
  // so the booker reads it as a lost race and offers the next advisor rather than
  // failing the lead (audit 1). `pnpm verify:reroute-holds-sql` proves the trigger
  // raises exactly this in a real Postgres; this proves the live insert reads it as
  // the lost race, which is where the next advisor branch starts.
  const row = { assigned_user_id: "A", starts_at: "2031-03-04T15:00:00Z", ends_at: "2031-03-04T15:20:00Z" };

  it("reads the hold trigger's refusal as a lost race", async () => {
    writeError = {
      code: "23P01",
      message: "agent A is held for a bucket correction until 2031-03-04 15:05:00+00",
      details: "held_until=2031-03-04T15:05:00Z",
      hint: "A reroute hold is a lost race for this agent and window; route to another agent.",
    };
    const r = await realDeps().insertBooking(row as never);
    expect(r).toEqual({ ok: false, conflict: true });
  });

  it("control: a refusal that is not a clash is not read as one", async () => {
    writeError = { code: "42501", message: "permission denied for table bookings" };
    const r = await realDeps().insertBooking(row as never);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.conflict).toBe(false);
  });
});
