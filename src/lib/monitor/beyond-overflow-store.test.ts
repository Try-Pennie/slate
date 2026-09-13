import { describe, it, expect, vi, beforeEach } from "vitest";

// #2228. The two counts behind the daily Beyond overflow notice, and the three
// things they must get right for the number in Slack to mean what it says.
//
// 1. A Beyond lead taken by an Achieve agent is identified by the PAIR of codes:
//    requested on a Beyond code, booked on an Achieve one. Neither column alone
//    can say it.
// 2. The booked side is EVERY Achieve code, not only the same tier partner, so a
//    lead that dropped a debt tier as well as overflowing (522 to 432) is counted.
//    It carries the same Colorado consequence as 522 to 532, and leaving it out
//    would under-report the exposure the notice exists to name.
// 3. A failed count must never arrive as zero, which would read as a day on which
//    no Beyond lead had to leave the Beyond pool (#277, #1134, #1165).
//
// The fake HONOURS the filters rather than asserting a query shape, so a count
// that forgets one counts the wrong rows and fails, the same way the catch-all
// rate's store test works.

const from = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

const { readBeyondOverflowWindow } = await import("./beyond-overflow-store");
const { BEYOND_OVERFLOW_WINDOW_HOURS } = await import("./beyond-overflow");

type Row = {
  created_at: string;
  is_test: boolean;
  requested_code: string;
  bucket_code: string;
  outcome: string;
};

type Filter = { col: string; val: unknown; kind: "eq" | "in" | "gte" };

/** Records the filters each count applied and resolves from the rows they select. */
function fakeChain(rows: Row[], opts: { error?: string } = {}) {
  const filters: Filter[] = [];
  const chain = {
    select: (_cols: string, _o: { count: string; head: boolean }) => chain,
    eq: (col: string, val: unknown) => {
      filters.push({ col, val, kind: "eq" });
      return chain;
    },
    in: (col: string, val: unknown[]) => {
      filters.push({ col, val, kind: "in" });
      return chain;
    },
    gte: (col: string, val: unknown) => {
      filters.push({ col, val, kind: "gte" });
      return chain;
    },
    then: (res: (v: unknown) => unknown) => {
      if (opts.error) return Promise.resolve(res({ count: null, error: { message: opts.error } }));
      const kept = rows.filter((r) =>
        filters.every((f) => {
          const actual = {
            "buckets.is_test": r.is_test,
            outcome: r.outcome,
            requested_code: r.requested_code,
            bucket_code: r.bucket_code,
            created_at: r.created_at,
          }[f.col];
          if (f.kind === "in") return (f.val as unknown[]).includes(actual);
          if (f.kind === "gte") return String(actual) >= String(f.val);
          return actual === f.val;
        }),
      );
      return Promise.resolve(res({ count: kept.length, error: null }));
    },
  };
  return { chain, filters };
}

/** Each call to `.from()` gets its own chain, since the two counts are separate
 *  queries and each must carry every exclusion on its own. */
function install(rows: Row[], opts: { error?: string } = {}) {
  const made: { filters: Filter[] }[] = [];
  from.mockImplementation(() => {
    const f = fakeChain(rows, opts);
    made.push(f);
    return f.chain;
  });
  return made;
}

const NOW = Date.parse("2026-09-13T18:00:00.000Z");
const recent = "2026-09-13T12:00:00.000Z";
const row = (requested: string, booked: string, over: Partial<Row> = {}): Row => ({
  created_at: recent,
  is_test: false,
  requested_code: requested,
  bucket_code: booked,
  outcome: "booked",
  ...over,
});

beforeEach(() => from.mockReset());

describe("readBeyondOverflowWindow", () => {
  it("counts a Beyond lead taken by an Achieve agent in the same debt tier", async () => {
    install([row("522", "532")]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w).toEqual({
      overflowed: 1,
      beyondBooked: 1,
      windowHours: BEYOND_OVERFLOW_WINDOW_HOURS,
    });
  });

  it("counts the one that dropped a debt tier AND overflowed", async () => {
    // The case a same tier only list would silently miss. 522 to 432 reaches an
    // Achieve agent exactly as 522 to 532 does, so it carries the same Colorado
    // consequence and belongs in the same number.
    install([row("522", "432")]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w.overflowed).toBe(1);
    expect(w.beyondBooked).toBe(1);
  });

  it("counts a Beyond lead who got a Beyond agent in the total and NOT in the overflow", async () => {
    install([row("522", "522"), row("522", "422"), row("522", "532")]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w.beyondBooked).toBe(3);
    expect(w.overflowed).toBe(1);
  });

  it("ignores a lead who never asked for Beyond", async () => {
    // An Achieve lead dropping a tier (511 to 411) is the ordinary fallback and is
    // reported per booking by tier_fallback:*. Counting it here would inflate a
    // number whose whole sentence is about Beyond.
    install([row("511", "411"), row("510", "310"), row("", "100")]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w).toEqual({
      overflowed: 0,
      beyondBooked: 0,
      windowHours: BEYOND_OVERFLOW_WINDOW_HOURS,
    });
  });

  it("counts no canary bookings, on BOTH counts", async () => {
    // The smoke buckets book against themselves every half hour. Counted here they
    // would be most of the population before cutover, and would dilute the real
    // number after it.
    const made = install([
      row("522", "532", { is_test: true }),
      row("522", "522", { is_test: true }),
      row("522", "532"),
    ]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w.beyondBooked).toBe(1);
    expect(w.overflowed).toBe(1);
    expect(made).toHaveLength(2);
    for (const m of made) {
      expect(m.filters).toContainEqual({ col: "buckets.is_test", val: false, kind: "eq" });
    }
  });

  it("asks only about bookings, not about decisions that produced none", async () => {
    const made = install([row("522", "532", { outcome: "no_availability" })]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w.beyondBooked).toBe(0);
    for (const m of made) {
      expect(m.filters).toContainEqual({ col: "outcome", val: "booked", kind: "eq" });
    }
  });

  it("windows from the right instant", async () => {
    const made = install([row("522", "532", { created_at: "2026-09-12T06:00:00.000Z" })]);
    const w = await readBeyondOverflowWindow(NOW);
    expect(w.beyondBooked).toBe(0);
    const since = made[0].filters.find((f) => f.col === "created_at")?.val;
    expect(since).toBe(new Date(NOW - BEYOND_OVERFLOW_WINDOW_HOURS * 3600_000).toISOString());
  });

  it("throws rather than reporting a failed count as a day with no overflow", async () => {
    // The whole reason both counts go through unwrapCount. A failed count comes
    // back null, and `?? 0` would turn it into a perfectly healthy looking "no
    // Beyond lead had to leave the Beyond pool". The caller reports the tick as
    // unmeasured instead, and says nothing.
    install([row("522", "532")], { error: "permission denied for table routing_decisions" });
    await expect(readBeyondOverflowWindow(NOW)).rejects.toThrow(/permission denied/);
  });
});
