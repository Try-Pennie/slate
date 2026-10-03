import { describe, it, expect, vi, beforeEach } from "vitest";

// #3126: the expired reservation cleanup is the only retention a pending
// booking_reservations row has, and its payload is the whole attendee record. It
// used to discard both results, so a read that failed and a delete that was
// refused both returned as though the sweep had run, and the drain's catch that
// logs a failed cleanup could never fire. Now each failure throws, which is what
// reaches that log line.

const state = vi.hoisted(() => ({
  readError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  rows: [] as { id: string }[],
  deleted: [] as string[][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const read: Record<string, unknown> = {};
      read.eq = () => read;
      read.lt = () => read;
      read.limit = async () => ({ data: state.readError ? null : state.rows, error: state.readError });
      return {
        select: () => read,
        delete: () => ({
          in: async (_col: string, ids: string[]) => {
            if (!state.deleteError) state.deleted.push(ids);
            return { data: null, error: state.deleteError };
          },
        }),
      };
    },
  }),
}));

import { realDeps } from "./service";

beforeEach(() => {
  state.readError = null;
  state.deleteError = null;
  state.rows = [];
  state.deleted = [];
});

describe("deleteExpiredReservations (#3126)", () => {
  it("throws when the candidate read fails, rather than reading as nothing expired", async () => {
    state.readError = { message: "permission denied for table booking_reservations" };
    await expect(
      realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50),
    ).rejects.toThrow(/permission denied/);
  });

  it("throws when the delete is refused, rather than reading as cleaned", async () => {
    state.rows = [{ id: "r1" }, { id: "r2" }];
    state.deleteError = { message: "deadlock detected" };
    await expect(
      realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50),
    ).rejects.toThrow(/deadlock detected/);
  });

  it("CONTROL: a sweep that lands deletes exactly the expired rows it read", async () => {
    state.rows = [{ id: "r1" }, { id: "r2" }];
    await expect(
      realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50),
    ).resolves.toBeUndefined();
    expect(state.deleted).toEqual([["r1", "r2"]]);
  });

  it("CONTROL: nothing expired issues no delete", async () => {
    await realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50);
    expect(state.deleted).toEqual([]);
  });
});
