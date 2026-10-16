import { describe, it, expect, vi, beforeEach } from "vitest";

// #3126: the expired reservation cleanup is the only retention a pending
// booking_reservations row has, and its payload is the whole attendee record. It
// used to discard both results, so a read that failed and a delete that was
// refused both returned as though the sweep had run, and the drain's catch that
// logs a failed cleanup could never fire. Now each failure throws, which is what
// reaches that log line.
//
// #3847: and it never deletes a reservation whose booking COMMITTED (an active
// booking holds its idempotency key) while booking.created is still owed. That
// reservation is the only record that Regal was never told, so it is kept and
// reported as owed. The decision is pinned in scripts/test-reservation-retention.ts;
// this file pins the wiring to the real tables.

interface Call {
  table: string;
  op: "select" | "delete";
  chain: [string, unknown[]][];
}

const state = vi.hoisted(() => ({
  reservationReadError: null as { message: string } | null,
  bookingReadError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  reservations: [] as { id: string; idempotency_key: string }[],
  /** Idempotency keys an ACTIVE booking holds. */
  activeKeys: [] as string[],
  calls: [] as Call[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const builder = (op: "select" | "delete") => {
        const call: Call = { table, op, chain: [] };
        state.calls.push(call);
        const settle = () => {
          if (op === "delete") {
            if (state.deleteError) return { data: null, count: null, error: state.deleteError };
            const ids = (call.chain.find(([m, a]) => m === "in" && a[0] === "id")?.[1][1] ?? []) as string[];
            return { data: null, count: ids.length, error: null };
          }
          if (table === "bookings") {
            if (state.bookingReadError) return { data: null, error: state.bookingReadError };
            const keys = (call.chain.find(([m, a]) => m === "in" && a[0] === "idempotency_key")?.[1][1] ?? []) as string[];
            return { data: keys.filter((k) => state.activeKeys.includes(k)).map((k) => ({ idempotency_key: k })), error: null };
          }
          if (state.reservationReadError) return { data: null, error: state.reservationReadError };
          const range = call.chain.find(([m]) => m === "range")?.[1] as [number, number] | undefined;
          const rows = range ? state.reservations.slice(range[0], range[1] + 1) : state.reservations;
          return { data: rows, error: null };
        };
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "lt", "in", "or", "order", "range", "limit"]) {
          chain[m] = (...args: unknown[]) => {
            call.chain.push([m, args]);
            return chain;
          };
        }
        chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(settle()).then(resolve, reject);
        return chain;
      };
      return {
        select: (...args: unknown[]) => {
          const b = builder("select") as Record<string, (...a: unknown[]) => unknown>;
          return b.select(...args);
        },
        delete: (...args: unknown[]) => {
          const b = builder("delete") as { chain?: unknown };
          state.calls[state.calls.length - 1].chain.push(["delete", args]);
          return b;
        },
      };
    },
  }),
}));

import { realDeps } from "./service";

const deletes = () => state.calls.filter((c) => c.op === "delete");
const deletedIds = () =>
  deletes().map((c) => c.chain.find(([m, a]) => m === "in" && a[0] === "id")?.[1][1] as string[]);

beforeEach(() => {
  state.reservationReadError = null;
  state.bookingReadError = null;
  state.deleteError = null;
  state.reservations = [];
  state.activeKeys = [];
  state.calls = [];
});

describe("deleteExpiredReservations (#3126, #3847)", () => {
  it("keeps a reservation whose booking committed and reports it owed, deleting only the stale one", async () => {
    state.reservations = [
      { id: "owed1", idempotency_key: "k-owed1" },
      { id: "stale1", idempotency_key: "k-stale1" },
    ];
    state.activeKeys = ["k-owed1"];
    const sweep = await realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50);
    expect(deletedIds()).toEqual([["stale1"]]);
    expect(sweep).toEqual({ deleted: 1, owed: ["owed1"] });
  });

  it("asks the bookings table about ACTIVE bookings on the reservations' keys, the drain's own test of committed", async () => {
    state.reservations = [{ id: "r1", idempotency_key: "k1" }];
    await realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50);
    const read = state.calls.find((c) => c.table === "bookings");
    expect(read?.chain).toContainEqual(["in", ["idempotency_key", ["k1"]]]);
    expect(read?.chain).toContainEqual(["in", ["status", ["confirmed", "rescheduled"]]]);
  });

  it("deletes only reservations no drain holds a lease on", async () => {
    state.reservations = [{ id: "r1", idempotency_key: "k1" }];
    await realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50);
    const orArgs = deletes()[0].chain.find(([m]) => m === "or")?.[1][0] as string;
    expect(orArgs).toMatch(/^lease_until\.is\.null,lease_until\.lt\./);
  });

  it("deletes NOTHING when the booking check fails, and throws its error", async () => {
    state.reservations = [{ id: "owed1", idempotency_key: "k-owed1" }];
    state.bookingReadError = { message: "statement timeout" };
    await expect(
      realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50),
    ).rejects.toThrow(/statement timeout/);
    expect(deletes()).toEqual([]);
  });

  it("throws when the candidate read fails, rather than reading as nothing expired", async () => {
    state.reservationReadError = { message: "permission denied for table booking_reservations" };
    await expect(
      realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50),
    ).rejects.toThrow(/permission denied/);
  });

  it("throws when the delete is refused, rather than reading as cleaned", async () => {
    state.reservations = [
      { id: "r1", idempotency_key: "k1" },
      { id: "r2", idempotency_key: "k2" },
    ];
    state.deleteError = { message: "deadlock detected" };
    await expect(
      realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50),
    ).rejects.toThrow(/deadlock detected/);
  });

  it("CONTROL: a sweep with no committed booking deletes exactly the expired rows it read", async () => {
    state.reservations = [
      { id: "r1", idempotency_key: "k1" },
      { id: "r2", idempotency_key: "k2" },
    ];
    const sweep = await realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50);
    expect(deletedIds()).toEqual([["r1", "r2"]]);
    expect(sweep).toEqual({ deleted: 2, owed: [] });
  });

  it("CONTROL: nothing expired issues no delete", async () => {
    const sweep = await realDeps().deleteExpiredReservations("2026-10-01T00:00:00Z", 50);
    expect(deletes()).toEqual([]);
    expect(sweep).toEqual({ deleted: 0, owed: [] });
  });
});
