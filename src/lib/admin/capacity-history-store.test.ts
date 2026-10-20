import { describe, it, expect, vi, beforeEach } from "vitest";

// The database side of Team capacity history (#3940). Each read must refuse rather than answer
// empty: no saved calls would pack a day from nothing and save calls twice, and an empty past day
// would draw a team with nobody in it.
const db = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as { message: string } | null },
  rpc: { data: null as unknown, error: null as { message: string } | null },
  calls: [] as { table: string; filters: [string, unknown][] }[],
}));
const paged = vi.hoisted(() => ({ rows: [] as unknown[], fail: null as Error | null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const call = { table, filters: [] as [string, unknown][] };
      db.calls.push(call);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) q[m] = (col: string, v: unknown) => (m === "select" ? q : (call.filters.push([`${m}:${col}`, v]), q));
      q.maybeSingle = async () => db.result;
      return q;
    },
    rpc: async () => db.rpc,
  }),
}));
vi.mock("@/lib/supabase/paginate", () => ({
  selectAllPages: async (_c: string, _k: unknown, build: () => unknown) => {
    build();
    if (paged.fail) throw paged.fail;
    return paged.rows;
  },
}));

import { loadCapacityHistoryDay, readHistoryCursor, readSavedCalls, readSavedDays, writeHistory } from "./capacity-history-store";

beforeEach(() => {
  db.result = { data: null, error: null };
  db.rpc = { data: 1, error: null };
  db.calls = [];
  paged.rows = [];
  paged.fail = null;
});

const row = (name: string | null, email: string, open: string[]) => ({
  user_id: email,
  day: "2026-10-20",
  timezone: "America/New_York",
  capacity: 16,
  open_times: open,
  is_out: false,
  no_shift: false,
  unsynced: false,
  shift_start: "2026-10-20T13:00:00+00:00",
  shift_end: "2026-10-20T21:00:00+00:00",
  time_off: [],
  users: { name, email },
});

describe("capacity history store", () => {
  it("reads no cursor as a first run, and a stored one as its instant", async () => {
    expect(await readHistoryCursor("org")).toBeNull();
    db.result = { data: { recorded_through: "2026-10-20T16:00:00+00:00" }, error: null };
    expect(await readHistoryCursor("org")).toBe(Date.parse("2026-10-20T16:00:00Z"));
  });

  it("refuses an unreadable cursor rather than starting over", async () => {
    db.result = { data: null, error: { message: "refused" } };
    await expect(readHistoryCursor("org")).rejects.toThrow();
    db.result = { data: { recorded_through: "soon" }, error: null };
    await expect(readHistoryCursor("org")).rejects.toThrow(/unreadable/);
  });

  it("reads the saved calls of the org's advisors on the days asked, keyed by advisor and day", async () => {
    paged.rows = [{ user_id: "u1", day: "2026-10-20", open_times: ["2026-10-20T13:00:00+00:00"] }];
    const saved = await readSavedCalls("org", ["2026-10-20"]);
    expect([...saved]).toEqual([["u1|2026-10-20", ["2026-10-20T13:00:00+00:00"]]]);
    expect(db.calls[0].filters).toEqual([["eq:users.org_id", "org"], ["in:day", ["2026-10-20"]]]);
  });

  it("refuses rather than answering no saved calls when the read fails", async () => {
    paged.fail = new Error("read refused");
    await expect(readSavedCalls("org", ["2026-10-20"])).rejects.toThrow("read refused");
  });

  it("returns the rows written, and refuses a write that failed or said nothing", async () => {
    db.rpc = { data: 3, error: null };
    expect(await writeHistory("org", [], 0)).toBe(3);
    db.rpc = { data: null, error: { message: "denied" } };
    await expect(writeHistory("org", [], 0)).rejects.toThrow();
    db.rpc = { data: null, error: null };
    await expect(writeHistory("org", [], 0)).rejects.toThrow(/no row count/);
  });

  it("lists the saved days, and refuses rather than offering none when the read fails", async () => {
    db.rpc = { data: ["2026-10-20", "2026-10-21"], error: null };
    expect(await readSavedDays("org", "2026-01-01")).toEqual(["2026-10-20", "2026-10-21"]);
    db.rpc = { data: null, error: { message: "denied" } };
    await expect(readSavedDays("org", "2026-01-01")).rejects.toThrow();
    db.rpc = { data: null, error: null };
    await expect(readSavedDays("org", "2026-01-01")).rejects.toThrow(/no list/);
  });

  it("reads a past day back by name, scoped to the org", async () => {
    paged.rows = [row("Blake", "b@x.test", []), row("Avery", "a@x.test", ["2026-10-20T13:00:00+00:00"])];
    const advisors = await loadCapacityHistoryDay("org", "2026-10-20");
    expect(advisors.map((a) => a.name)).toEqual(["Avery", "Blake"]);
    expect(advisors[0].days[0].openTimes).toEqual(["2026-10-20T13:00:00.000Z"]);
    expect(db.calls[0].filters).toEqual([["eq:users.org_id", "org"], ["eq:day", "2026-10-20"]]);
  });
});
