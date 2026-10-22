import { describe, it, expect, vi, beforeEach } from "vitest";

// The booking pace read behind Team capacity's cards (#4104). What only this layer can get wrong is
// a failed read arriving as no readings, which the page would draw as "Pace shows after 3 hours of
// readings" on every card for as long as the read kept failing; and an unbounded read of a table
// that grows a row per day per half hour, forever.
const db = vi.hoisted(() => ({
  data: [] as unknown[] | null,
  error: null as { message: string } | null,
  throws: null as Error | null,
  calls: [] as [string, unknown[]][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    if (db.throws) throw db.throws;
    return {
      from: (table: string) => {
        db.calls.push(["from", [table]]);
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) {
          q[m] = (...args: unknown[]) => {
            db.calls.push([m, args]);
            return q;
          };
        }
        q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: db.data, error: db.error }).then(ok, bad);
        return q;
      },
    };
  },
}));

import { readPaceRows, PACE_READ_LIMIT } from "./team-capacity-pace-load";
import { PACE_COLUMNS } from "./team-capacity-pace";

const row = { day: "2026-10-20", read_at: "2026-10-19T19:30:00+00:00", pace_state: "pace", pace_per_hour: 6 };

beforeEach(() => {
  db.data = [];
  db.error = null;
  db.throws = null;
  db.calls = [];
});

describe("readPaceRows", () => {
  it("reads the org's newest readings, newest first, bounded by a limit", async () => {
    db.data = [row];
    expect(await readPaceRows("org-1")).toEqual({ ok: true, rows: [row] });
    expect(db.calls).toEqual([
      ["from", ["capacity_fill_readings"]],
      ["select", [PACE_COLUMNS]],
      ["eq", ["org_id", "org-1"]],
      ["order", ["read_at", { ascending: false }]],
      ["limit", [PACE_READ_LIMIT]],
    ]);
    // One run writes one row per page day (at most eight, a seven day window led by today), so
    // the limit always holds the newest run whole.
    expect(PACE_READ_LIMIT).toBeGreaterThanOrEqual(16);
  });

  it("says the read failed when the query errors, never no readings", async () => {
    db.error = { message: "column capacity_fill_readings.pace_back_at does not exist" };
    const r = await readPaceRows("org-1");
    expect(r.ok).toBe(false);
  });

  it("says the read failed when the client cannot even be made", async () => {
    db.throws = new Error("no secret key");
    expect((await readPaceRows("org-1")).ok).toBe(false);
  });

  it("refuses an answer that is not a list, rather than reading it as none", async () => {
    db.data = null;
    expect((await readPaceRows("org-1")).ok).toBe(false);
  });

  it("reads an empty table as no readings yet: launch", async () => {
    db.data = [];
    expect(await readPaceRows("org-1")).toEqual({ ok: true, rows: [] });
  });
});
