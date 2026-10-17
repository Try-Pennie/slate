import { describe, it, expect, vi, beforeEach } from "vitest";

// #3859: the rollback of a lost or stale reservation deletes the row and then
// reserves again under the SAME idempotency key (the lost race retry, and since
// #3837 a resumed reservation whose advisor was taken). The reservation's insert
// adopts whatever row already holds that key, so the delete is the only thing
// standing between the next reservation and the stale one, pinned to the advisor
// who was just taken. It used to discard its own answer under a `// write-ok:`.
//
// This pins the LIVE delete's answer. The mock is a small evaluator over the rows it
// holds rather than a stub returning fixed rows, so "no row had that id" is the
// table's real state and not a fixture's say so. The orchestration side (what the
// confirm does with each answer) is driven in scripts/test-booking-reservations.ts
// and scripts/test-booking-race-next-advisor.ts.

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  refusal: null as { message: string } | null,
  selected: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "booking_reservations") throw new Error(`unexpected table ${table}`);
      let deleting = false;
      let matched = [...state.rows];
      const b: Record<string, unknown> = {
        delete: () => ((deleting = true), b),
        eq: (col: string, v: unknown) => ((matched = matched.filter((r) => r[col] === v)), b),
        select: (cols: string) => (state.selected.push(cols), b),
        then: (resolve: (v: unknown) => unknown) => {
          if (state.refusal) return Promise.resolve({ data: null, error: state.refusal }).then(resolve);
          if (deleting) state.rows = state.rows.filter((r) => !matched.includes(r));
          return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }).then(resolve);
        },
      };
      return b;
    },
  }),
}));

import { realDeps } from "./service";

beforeEach(() => {
  state.rows = [];
  state.refusal = null;
  state.selected = [];
});

describe("deleting a reservation (#3859)", () => {
  it("throws when the database refuses the delete, and the row stays", async () => {
    state.rows = [{ id: "resv-1", idempotency_key: "k", pinned_user_id: "a" }];
    state.refusal = { message: "permission denied for table booking_reservations" };
    await expect(realDeps().deleteReservation("resv-1")).rejects.toThrow(/resv-1.*permission denied/);
    expect(state.rows.map((r) => r.id)).toEqual(["resv-1"]);
  });

  it("answers deleted when it removed the row", async () => {
    state.rows = [
      { id: "resv-1", idempotency_key: "k", pinned_user_id: "a" },
      { id: "resv-2", idempotency_key: "other", pinned_user_id: "b" },
    ];
    await expect(realDeps().deleteReservation("resv-1")).resolves.toBe("deleted");
    expect(state.rows.map((r) => r.id)).toEqual(["resv-2"]);
    // The answer is read from the rows the statement returned, not assumed.
    expect(state.selected).toEqual(["id"]);
  });

  // A concurrent confirm of the same lead, or the drain after a lapsed lease, removed
  // it first. That is the state the next reservation needs, so it is not an error;
  // it is answered apart so the rollback can say so.
  it("answers gone, without throwing, when no row has that id", async () => {
    state.rows = [{ id: "resv-2", idempotency_key: "other", pinned_user_id: "b" }];
    await expect(realDeps().deleteReservation("resv-1")).resolves.toBe("gone");
    expect(state.rows.map((r) => r.id)).toEqual(["resv-2"]);
  });
});
