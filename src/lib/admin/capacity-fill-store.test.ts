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
      for (const m of ["select", "eq", "in", "order", "limit"]) {
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

import { parseFillSnapshot, readFillLast, writeFill } from "./capacity-fill-store";

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
