import { describe, it, expect, vi, beforeEach } from "vitest";

// #762: insertBusyBlock (one write-through block) and insertBusyBlocks (the whole
// reconcile-missing batch, up to RECONCILE_LIMIT rows) share ONE implementation, so
// the retry-then-alert posture can't drift between them.
//
// The booking already succeeded by the time this runs, so a cache write failure must
// not fail the request. But it must not stay silent either (#34): a missed insert
// leaves the embed offering a slot that is actually booked, so it retries once and
// then logs + raises a throttled Slack alert. These tests exist mostly for that
// FAILURE path, which is the one that keeps a lost block from disappearing quietly.

const state = vi.hoisted(() => ({
  errors: [] as (null | { message: string })[], // one entry per write attempt
  inserts: [] as unknown[],
  opts: [] as unknown[],
}));

const upsert = vi.hoisted(() =>
  vi.fn((rows: unknown, opts?: unknown) => {
    state.inserts.push(rows);
    state.opts.push(opts);
    const err = state.errors.shift() ?? null;
    return Promise.resolve({ error: err });
  }),
);
const alert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _message: string) => {}),
);

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: () => ({ upsert }) }),
}));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: alert }));

import { insertBusyBlocksWithRetry } from "./service";
import type { BusyBlockInsert } from "@/lib/booking/core";

function block(bookingId: string): BusyBlockInsert {
  return {
    user_id: "u1",
    starts_at: "2030-01-01T10:00:00.000Z",
    ends_at: "2030-01-01T10:30:00.000Z",
    source: "slate",
    booking_id: bookingId,
  } as BusyBlockInsert;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.errors = [];
  state.inserts = [];
  state.opts = [];
});

describe("insertBusyBlocksWithRetry", () => {
  it("writes a whole batch in ONE write, not one per row (#762)", async () => {
    await insertBusyBlocksWithRetry([block("A1"), block("A2"), block("A3")]);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(state.inserts[0]).toHaveLength(3);
    expect(alert).not.toHaveBeenCalled();
  });

  // #770: the sweep re-creates blocks for bookings that looked block-less a moment
  // ago. A booking's own move_busy_block can land in the gap between that read and
  // this write, so the row the sweep is about to add already exists. Under the new
  // UNIQUE (booking_id) index a plain insert would then 23505 and take the WHOLE
  // batch down with it, so the sweep must defer to the winner instead.
  it("defers to a racing booking rather than aborting the batch (#770)", async () => {
    await insertBusyBlocksWithRetry([block("A1"), block("A2")]);

    expect(state.opts[0]).toEqual({ onConflict: "booking_id", ignoreDuplicates: true });
  });

  it("issues no write at all for an empty batch", async () => {
    await insertBusyBlocksWithRetry([]);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("retries once and stays quiet when the retry succeeds", async () => {
    state.errors = [{ message: "connection reset" }]; // first attempt fails, second is clean

    await insertBusyBlocksWithRetry([block("A1")]);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(alert).not.toHaveBeenCalled(); // a transient blip must not page anyone
  });

  it("alerts loudly when both attempts fail, instead of losing the blocks silently", async () => {
    state.errors = [{ message: "db exploded" }, { message: "db exploded" }];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw: the booking already succeeded and a cache write cannot fail it.
    await expect(insertBusyBlocksWithRetry([block("A1"), block("A2")])).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(2); // the one retry, then give up
    expect(err).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledOnce();
    // The alert has to name the damage, or nobody can find the affected bookings.
    const message = String(alert.mock.calls[0][2]);
    expect(message).toContain("A1");
    expect(message).toContain("A2");
    expect(message).toContain("db exploded");
    err.mockRestore();
  });

  it("survives a failing alert (the alert path cannot break the caller)", async () => {
    state.errors = [{ message: "db exploded" }, { message: "db exploded" }];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    alert.mockRejectedValueOnce(new Error("slack down") as never);

    await expect(insertBusyBlocksWithRetry([block("A1")])).resolves.toBeUndefined();

    err.mockRestore();
  });
});
