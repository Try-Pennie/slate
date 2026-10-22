import { describe, it, expect, vi, beforeEach } from "vitest";

// The database side of the booking pace readings (#4102). Each read must refuse rather than answer
// empty or malformed: no snapshot makes every day a first reading, and a snapshot read short would
// compare against a smaller team than the one counted.
const db = vi.hoisted(() => ({
  latest: { data: null as unknown, error: null as { message: string } | null },
  rows: { data: [] as unknown, error: null as { message: string } | null },
  rpc: { data: true as unknown, error: null as { message: string } | null },
  filters: [] as [string, unknown][],
  rpcArgs: null as unknown,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "limit"]) {
        q[m] = (col: string, v: unknown) => {
          if (m !== "select") db.filters.push([`${m}:${col}`, v]);
          return q;
        };
      }
      q.maybeSingle = async () => db.latest;
      q.then = (resolve: (r: unknown) => unknown) => resolve(db.rows);
      return q;
    },
    rpc: async (_name: string, args: unknown) => {
      db.rpcArgs = args;
      return db.rpc;
    },
  }),
}));

import { FILL_HISTORY_PER_DAY, parseFillSnapshot, readFillHistory, readFillLast, readFillPattern, writeFill } from "./capacity-fill-store";

beforeEach(() => {
  db.latest = { data: null, error: null };
  db.rows = { data: [], error: null };
  db.rpc = { data: true, error: null };
  db.filters = [];
  db.rpcArgs = null;
});

describe("readFillLast", () => {
  it("reads the org's latest snapshot and the page days' snapshots, scoped to the org", async () => {
    db.latest = { data: { read_at: "2026-10-20T16:00:00+00:00" }, error: null };
    db.rows = { data: [{ day: "2026-10-20", read_at: "2026-10-20T16:00:00+00:00", snapshot: { u1: { open: 3, capacity: 16, fp: "x" } } }], error: null };
    const r = await readFillLast("org-1", ["2026-10-20", "2026-10-21"]);
    expect(r.latestReadAtMs).toBe(Date.parse("2026-10-20T16:00:00Z"));
    expect(r.byDay.get("2026-10-20")).toEqual({ readAtMs: Date.parse("2026-10-20T16:00:00Z"), snapshot: { u1: { open: 3, capacity: 16, fp: "x" } } });
    expect(db.filters.filter(([f]) => f === "eq:org_id")).toEqual([["eq:org_id", "org-1"], ["eq:org_id", "org-1"]]);
  });

  it("answers no snapshot before the first run", async () => {
    const r = await readFillLast("org-1", ["2026-10-20"]);
    expect(r.latestReadAtMs).toBeNull();
    expect(r.byDay.size).toBe(0);
  });

  it("throws when the latest snapshot cannot be read, rather than calling it the first run", async () => {
    db.latest = { data: null, error: { message: "refused" } };
    await expect(readFillLast("org-1", ["2026-10-20"])).rejects.toThrow();
  });

  it("throws when the day snapshots cannot be read", async () => {
    db.rows = { data: null, error: { message: "refused" } };
    await expect(readFillLast("org-1", ["2026-10-20"])).rejects.toThrow();
  });

  it("throws on an unreadable instant or snapshot rather than comparing against it", async () => {
    db.rows = { data: [{ day: "2026-10-20", read_at: "not a time", snapshot: {} }], error: null };
    await expect(readFillLast("org-1", ["2026-10-20"])).rejects.toThrow(/unreadable read_at/);
    expect(() => parseFillSnapshot({ u1: { open: "3", capacity: 16, fp: "x" } }, "2026-10-20")).toThrow(/u1/);
    expect(() => parseFillSnapshot([], "2026-10-20")).toThrow();
  });
});

describe("writeFill", () => {
  const w = { readAtMs: Date.parse("2026-10-20T16:00:00Z"), prevReadAtMs: Date.parse("2026-10-20T15:30:00Z"), rows: [], last: [] };

  it("sends the half hour and the snapshot it read from, and returns whether it wrote", async () => {
    expect(await writeFill("org-1", w)).toBe(true);
    expect(db.rpcArgs).toEqual({ p_org: "org-1", p_read_at: "2026-10-20T16:00:00.000Z", p_prev_read_at: "2026-10-20T15:30:00.000Z", p_rows: [], p_last: [] });
    db.rpc = { data: false, error: null };
    expect(await writeFill("org-1", { ...w, prevReadAtMs: null })).toBe(false);
    expect((db.rpcArgs as { p_prev_read_at: unknown }).p_prev_read_at).toBeNull();
  });

  it("throws on a refused write or a missing answer", async () => {
    db.rpc = { data: null, error: { message: "refused" } };
    await expect(writeFill("org-1", w)).rejects.toThrow();
    db.rpc = { data: null, error: null };
    await expect(writeFill("org-1", w)).rejects.toThrow(/no answer/);
  });
});

describe("readFillHistory (#4103)", () => {
  it("reads the page days' readings since the instant, scoped to the org, grouped by day", async () => {
    db.rows = {
      data: [
        { day: "2026-10-20", read_at: "2026-10-20T15:30:00+00:00", prev_read_at: "2026-10-20T15:00:00+00:00", taken: 3 },
        { day: "2026-10-20", read_at: "2026-10-20T16:00:00+00:00", prev_read_at: "2026-10-20T15:30:00+00:00", taken: null },
        { day: "2026-10-21", read_at: "2026-10-20T16:00:00+00:00", prev_read_at: null, taken: "1.5" },
      ],
      error: null,
    };
    const r = await readFillHistory("org-1", ["2026-10-20", "2026-10-21"], Date.parse("2026-10-20T13:00:00Z"));
    expect(r.get("2026-10-20")).toEqual([
      { read_at: "2026-10-20T15:30:00.000Z", prev_read_at: "2026-10-20T15:00:00.000Z", taken: 3 },
      { read_at: "2026-10-20T16:00:00.000Z", prev_read_at: "2026-10-20T15:30:00.000Z", taken: null },
    ]);
    expect(r.get("2026-10-21")).toEqual([{ read_at: "2026-10-20T16:00:00.000Z", prev_read_at: null, taken: 1.5 }]);
    expect(db.filters).toContainEqual(["eq:org_id", "org-1"]);
    expect(db.filters).toContainEqual(["gte:read_at", "2026-10-20T13:00:00.000Z"]);
    expect(db.filters).toContainEqual(["limit:" + 2 * FILL_HISTORY_PER_DAY, undefined]);
  });

  it("throws on a failed read, never answering no readings", async () => {
    db.rows = { data: null, error: { message: "boom" } };
    await expect(readFillHistory("org-1", ["2026-10-20"], 0)).rejects.toThrow();
  });

  it("throws when the read filled its limit, since some readings may be missing", async () => {
    db.rows = {
      data: Array.from({ length: FILL_HISTORY_PER_DAY }, (_, i) => ({ day: "2026-10-20", read_at: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(), prev_read_at: null, taken: 1 })),
      error: null,
    };
    await expect(readFillHistory("org-1", ["2026-10-20"], 0)).rejects.toThrow(/limit/);
  });

  it("throws on an unreadable taken or instant rather than dropping the reading", async () => {
    db.rows = { data: [{ day: "2026-10-20", read_at: "2026-10-20T16:00:00Z", prev_read_at: null, taken: "lots" }], error: null };
    await expect(readFillHistory("org-1", ["2026-10-20"], 0)).rejects.toThrow(/taken/);
    db.rows = { data: [{ day: "2026-10-20", read_at: "soon", prev_read_at: null, taken: 1 }], error: null };
    await expect(readFillHistory("org-1", ["2026-10-20"], 0)).rejects.toThrow(/read_at/);
  });
});

describe("readFillPattern (#4103)", () => {
  it("asks for the org's cells since the instant and reads them", async () => {
    db.rpc = {
      data: [
        { day_position: 1, slot_of_day: 20, weekday: null, avg_taken: 4.5, samples: 12 },
        { day_position: 1, slot_of_day: 20, weekday: 3, avg_taken: "5", samples: 6 },
      ],
      error: null,
    };
    const cells = await readFillPattern("org-1", Date.parse("2026-09-08T16:00:00Z"));
    expect(db.rpcArgs).toEqual({ p_org: "org-1", p_since: "2026-09-08T16:00:00.000Z" });
    expect(cells).toEqual([
      { dayPosition: 1, slotOfDay: 20, weekday: null, avgTaken: 4.5, samples: 12 },
      { dayPosition: 1, slotOfDay: 20, weekday: 3, avgTaken: 5, samples: 6 },
    ]);
  });

  it("answers no cells before any history", async () => {
    db.rpc = { data: [], error: null };
    expect(await readFillPattern("org-1", 0)).toEqual([]);
  });

  it("throws on a failed read, a missing answer or a malformed cell, never answering no pattern", async () => {
    db.rpc = { data: null, error: { message: "boom" } };
    await expect(readFillPattern("org-1", 0)).rejects.toThrow();
    db.rpc = { data: null, error: null };
    await expect(readFillPattern("org-1", 0)).rejects.toThrow(/no answer/);
    db.rpc = { data: [{ day_position: 1, slot_of_day: 99, weekday: null, avg_taken: 1, samples: 1 }], error: null };
    await expect(readFillPattern("org-1", 0)).rejects.toThrow(/cell/);
  });
});
