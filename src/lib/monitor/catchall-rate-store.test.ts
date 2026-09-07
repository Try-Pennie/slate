import { describe, it, expect, vi, beforeEach } from "vitest";

// #1908. The catch-all rate's two counts, and the one thing they must never do:
// count Slate booking against itself.
//
// Measured against production on 2026-09-07, ALL 40 booked routing decisions in
// the last 24 hours came from the two smoke buckets (SMOKE: 35, SMOKE2: 5). With
// them counted the check reported a measured "healthy" rate off entirely
// synthetic traffic, which is the false all-clear this whole family of checks
// exists not to give (L98). With them excluded the same window reports
// `unmeasured`, which is the truth: no customer has booked.
//
// After cutover it matters differently: the canary keeps adding roughly 40
// bookings a day to the denominator forever, and at a 5 percent threshold that
// dilution is enough to hide a real regression.
//
// `routing_decisions` has no is_test column, so test-ness is a property of the
// BUCKET and is reached through an inner join, exactly as the low-volume alarm's
// input does it (#1258). The fake honours the embedded filter rather than
// asserting a query shape, so a count that forgets the filter counts the canary
// rows and fails.

const from = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

const { readCatchallWindow, CATCHALL_WINDOW_HOURS } = await import("./catchall-rate-store");

type Row = { created_at: string; is_test: boolean; catchall: boolean };

/** Records the filters each count applied and resolves from the rows they select. */
function fakeChain(rows: Row[], opts: { error?: string } = {}) {
  const filters: { col: string; val: unknown }[] = [];
  const chain = {
    select: (_cols: string, _o: { count: string; head: boolean }) => chain,
    eq: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    gte: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    then: (res: (v: unknown) => unknown) => {
      if (opts.error) return Promise.resolve(res({ count: null, error: { message: opts.error } }));
      const testFilter = filters.find((f) => f.col === "buckets.is_test");
      const catchallFilter = filters.find((f) => f.col === "catchall_applied");
      const since = filters.find((f) => f.col === "created_at")?.val as string | undefined;
      const kept = rows.filter(
        (r) =>
          (since === undefined || r.created_at >= since) &&
          (testFilter === undefined || r.is_test === testFilter.val) &&
          (catchallFilter === undefined || r.catchall === catchallFilter.val),
      );
      return Promise.resolve(res({ count: kept.length, error: null }));
    },
  };
  return { chain, filters };
}

/** Each call to `.from()` gets its own chain, since the two counts are separate
 *  queries and each must carry the exclusion on its own. */
function install(rows: Row[], opts: { error?: string } = {}) {
  const made: { filters: { col: string; val: unknown }[] }[] = [];
  from.mockImplementation(() => {
    const f = fakeChain(rows, opts);
    made.push(f);
    return f.chain;
  });
  return made;
}

const NOW = Date.parse("2026-09-07T18:00:00.000Z");
const recent = "2026-09-07T12:00:00.000Z";
const canary = (catchall = false): Row => ({ created_at: recent, is_test: true, catchall });
const customer = (catchall = false): Row => ({ created_at: recent, is_test: false, catchall });

beforeEach(() => from.mockReset());

describe("readCatchallWindow", () => {
  it("counts no canary bookings, which today is all of them", async () => {
    install([canary(), canary(), canary(), canary()]);
    const w = await readCatchallWindow(NOW);
    // The real production shape on the day this shipped. Reporting 0 of 4 here
    // would be a measured healthy rate over traffic Slate generated itself.
    expect(w).toEqual({ catchall: 0, total: 0, windowHours: CATCHALL_WINDOW_HOURS });
  });

  it("counts customer bookings and the rescued ones among them", async () => {
    install([customer(), customer(), customer(true), canary(true), canary()]);
    const w = await readCatchallWindow(NOW);
    expect(w.total).toBe(3);
    expect(w.catchall).toBe(1);
  });

  it("puts the exclusion on BOTH counts, not just the denominator", async () => {
    // A rescued canary booking counted in the numerator while excluded from the
    // denominator would report a rate above 100 percent, which the verdict then
    // refuses as unreadable: a real finding lost to our own query.
    const made = install([customer(), canary(true), canary(true)]);
    const w = await readCatchallWindow(NOW);
    expect(w.catchall).toBe(0);
    expect(made).toHaveLength(2);
    for (const m of made) {
      expect(m.filters).toContainEqual({ col: "buckets.is_test", val: false });
    }
  });

  it("asks only about bookings, not about decisions that produced none", async () => {
    const made = install([customer()]);
    await readCatchallWindow(NOW);
    for (const m of made) {
      expect(m.filters).toContainEqual({ col: "outcome", val: "booked" });
    }
  });

  it("windows from the right instant", async () => {
    const made = install([customer()]);
    await readCatchallWindow(NOW);
    const since = made[0].filters.find((f) => f.col === "created_at")?.val;
    expect(since).toBe(new Date(NOW - CATCHALL_WINDOW_HOURS * 3600_000).toISOString());
  });

  it("throws rather than reporting a failed count as zero", async () => {
    // The whole reason the counts go through unwrapCount. A failed count comes
    // back null, and `?? 0` would turn it into a perfectly healthy looking "no
    // rescued bookings" (#277, #1134, #1165). The caller reports the tick as
    // unmeasured instead.
    install([customer()], { error: "permission denied for table routing_decisions" });
    await expect(readCatchallWindow(NOW)).rejects.toThrow(/permission denied/);
  });
});
