import { describe, it, expect, vi, beforeEach } from "vitest";

// The outbox drain's read (`loadDrainableOutbox`), against a fake PostgREST
// builder that answers the read with either rows or an error.
//
// #3846: a failed read used to log and return [], which is exactly what an empty
// outbox returns. A read failing on every tick therefore drained nothing and paged
// nothing, and booking side effects (calendar invites, webhooks) waited silently
// behind a lane answering 200. It throws now, the same way its sibling
// `loadDrainableReservations` does since #3844, and the outbox lane counts the
// throw toward `outbox_drain_failing`.

const state = vi.hoisted(() => ({
  rows: [] as { id: string }[],
  readError: null as { message: string } | null,
  table: null as string | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      state.table = table;
      const read: Record<string, unknown> = {};
      read.select = () => read;
      read.eq = () => read;
      read.lt = () => read;
      read.or = () => read;
      read.order = () => read;
      read.limit = async (n: number) =>
        state.readError
          ? { data: null, error: state.readError }
          : { data: state.rows.slice(0, n), error: null };
      return read;
    },
  }),
}));

import { realDeps } from "./service";

beforeEach(() => {
  state.rows = [];
  state.readError = null;
  state.table = null;
});

describe("loadDrainableOutbox fails loud (#3846)", () => {
  it("throws on a failed read rather than reading as an empty outbox", async () => {
    state.rows = [{ id: "pending-row" }];
    state.readError = { message: "canceling statement due to statement timeout" };
    await expect(realDeps().loadDrainableOutbox(15)).rejects.toThrow(/statement timeout/);
  });

  it("CONTROL: a healthy read hands over its rows, and reads the outbox table", async () => {
    state.rows = [{ id: "a" }, { id: "b" }];
    const got = await realDeps().loadDrainableOutbox(15);
    expect(got.map((r) => r.id)).toEqual(["a", "b"]);
    expect(state.table).toBe("booking_outbox");
  });

  it("CONTROL: a healthy empty outbox is still an empty list, not a throw", async () => {
    expect(await realDeps().loadDrainableOutbox(15)).toEqual([]);
  });
});
