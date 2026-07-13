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
  errors: [] as (null | { message: string })[], // one entry per insert attempt
  inserts: [] as unknown[],
}));

const insert = vi.hoisted(() =>
  vi.fn((rows: unknown) => {
    state.inserts.push(rows);
    const err = state.errors.shift() ?? null;
    return Promise.resolve({ error: err });
  }),
);
const alert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _message: string) => {}),
);

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: () => ({ insert }) }),
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
});

describe("insertBusyBlocksWithRetry", () => {
  it("writes a whole batch in ONE insert, not one per row (#762)", async () => {
    await insertBusyBlocksWithRetry([block("A1"), block("A2"), block("A3")]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(state.inserts[0]).toHaveLength(3);
    expect(alert).not.toHaveBeenCalled();
  });

  it("issues no write at all for an empty batch", async () => {
    await insertBusyBlocksWithRetry([]);

    expect(insert).not.toHaveBeenCalled();
  });

  it("retries once and stays quiet when the retry succeeds", async () => {
    state.errors = [{ message: "connection reset" }]; // first attempt fails, second is clean

    await insertBusyBlocksWithRetry([block("A1")]);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(alert).not.toHaveBeenCalled(); // a transient blip must not page anyone
  });

  it("alerts loudly when both attempts fail, instead of losing the blocks silently", async () => {
    state.errors = [{ message: "db exploded" }, { message: "db exploded" }];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw: the booking already succeeded and a cache write cannot fail it.
    await expect(insertBusyBlocksWithRetry([block("A1"), block("A2")])).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(2); // the one retry, then give up
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
