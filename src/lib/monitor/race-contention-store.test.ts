import { describe, it, expect, vi, beforeEach } from "vitest";

// The IO half of the race whisper (#2838): one read of today's booking outcome
// tally. What matters is the distinction the pure verdict cannot make for itself:
// a day with no races versus a tally that could not be READ. A failed RPC must
// reach the caller as a throw, never as a quiet day.

const rpc = vi.hoisted(() => vi.fn());

/** #2877: a bookings builder that records the chain and answers one page. */
interface Recorded {
  table: string;
  select: string;
  eq: [string, unknown][];
  gte: [string, unknown][];
  lt: [string, unknown][];
  gt: [string, unknown][];
  order: string[];
  range: [number, number][];
}
const bookingsRead = vi.hoisted(() => ({
  calls: [] as Recorded[],
  answer: { data: [] as unknown[] | null, error: null as { message: string } | null },
  /** Per call answers, taken first while any remain. */
  queue: [] as { data: unknown[] | null; error: { message: string } | null }[],
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const rec: Recorded = { table, select: "", eq: [], gte: [], lt: [], gt: [], order: [], range: [] };
    bookingsRead.calls.push(rec);
    const answer = bookingsRead.queue.shift() ?? bookingsRead.answer;
    const chain = {
      select: (s: string) => ((rec.select = s), chain),
      eq: (c: string, v: unknown) => (rec.eq.push([c, v]), chain),
      gte: (c: string, v: unknown) => (rec.gte.push([c, v]), chain),
      lt: (c: string, v: unknown) => (rec.lt.push([c, v]), chain),
      gt: (c: string, v: unknown) => (rec.gt.push([c, v]), chain),
      order: (c: string) => (rec.order.push(c), chain),
      range: (a: number, b: number) => (rec.range.push([a, b]), chain),
      then: (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res),
    };
    return chain;
  }),
);
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc, from })) }));
vi.mock("@/lib/supabase/admin", () => admin);

import { readRaceContentionWindow, readRaceRateBookings } from "./race-contention-store";
import { RACE_RATE_LOOKBACK_DAYS } from "./race-contention";

// 2026-09-28 16:00 UTC is noon Eastern on the 28th.
const NOW = Date.UTC(2026, 8, 28, 16, 0, 0);

beforeEach(() => {
  vi.clearAllMocks();
  bookingsRead.calls.length = 0;
  bookingsRead.answer = { data: [], error: null };
  bookingsRead.queue = [];
});

describe("readRaceContentionWindow", () => {
  it("reads today's Eastern day with the canary and off site testers left out", async () => {
    rpc.mockResolvedValue({
      data: { by_outcome: { created: 60, race_reassigned: 2, race_refused: 1, race_refused_bound: 1, error: 9 } },
      error: null,
    });
    const w = await readRaceContentionWindow(NOW);
    expect(rpc).toHaveBeenCalledWith("booking_api_outcome_mix", {
      p_since: "2026-09-28",
      p_include_test: false,
      p_include_offsite: false,
    });
    expect(w).toEqual({ day: "2026-09-28", created: 60, reassigned: 2, reassignedMoves: 0, refused: 1, refusedAtBound: 1, retriedForBudget: 0 });
  });

  it("#2867: reads rescued moves from their own row, the one the booking API records", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: { created: 10, race_reassigned_move: 4 } }, error: null });
    expect((await readRaceContentionWindow(NOW)).reassignedMoves).toBe(4);
  });

  it("#3442: reads lost races told to retry for budget from their own row, the one both routes record", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: { created: 10, race_retry_budget: 3 } }, error: null });
    expect((await readRaceContentionWindow(NOW)).retriedForBudget).toBe(3);
  });

  it("keys the day on Eastern time, not UTC", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {} }, error: null });
    // 02:00 UTC on the 29th is still the 28th in New York.
    await readRaceContentionWindow(Date.UTC(2026, 8, 29, 2, 0, 0));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_since: "2026-09-28" });
  });

  it("THROWS on a failed read, rather than reading as a day with no races", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function missing" } });
    await expect(readRaceContentionWindow(NOW)).rejects.toThrow(/function missing/);
  });

  it("THROWS on an answer with no outcome map, rather than reading as zero", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(readRaceContentionWindow(NOW)).rejects.toThrow(/could not be read/);
  });

  it("THROWS on a clock it cannot turn into a day, rather than asking for every day since ''", async () => {
    await expect(readRaceContentionWindow(Number.NaN)).rejects.toThrow(/could not name the Eastern day/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads an empty day as zeros, which the verdict then calls unmeasured", async () => {
    rpc.mockResolvedValue({ data: { by_outcome: {} }, error: null });
    expect(await readRaceContentionWindow(NOW)).toEqual({
      day: "2026-09-28",
      created: 0,
      reassigned: 0,
      reassignedMoves: 0,
      refused: 0,
      refusedAtBound: 0,
      retriedForBudget: 0,
    });
  });
});

describe("readRaceRateBookings (#2877)", () => {
  it("reads real routed bookings over the lookback before the injected clock", async () => {
    bookingsRead.answer = {
      data: [
        { id: "b2", created_at: "2026-09-28T15:20:00.000Z", buckets: [{ code: "412", is_test: false }] },
        { id: "b1", created_at: "2026-09-28T15:10:00.000Z", buckets: { code: "111", is_test: false } },
      ],
      error: null,
    };
    // Mid hour, so a window that is not clipped to whole hours would show.
    const rows = await readRaceRateBookings(NOW + 30 * 60_000);
    expect(rows).toEqual([
      { createdMs: Date.UTC(2026, 8, 28, 15, 10), bucketCode: "111" },
      { createdMs: Date.UTC(2026, 8, 28, 15, 20), bucketCode: "412" },
    ]);
    const q = bookingsRead.calls[0];
    expect(q.table).toBe("bookings");
    expect(q.select).toContain("buckets!inner(code, is_test)");
    // The smoke canary and the public test bucket are test buckets; an agent's own
    // link is not routed traffic.
    expect(q.eq).toEqual(expect.arrayContaining([["buckets.is_test", false], ["kind", "routed"]]));
    // Both ends on a whole hour: the partial first hour and the hour under way are out.
    expect(q.gte).toEqual([["created_at", new Date(NOW - RACE_RATE_LOOKBACK_DAYS * 86_400_000).toISOString()]]);
    expect(q.lt).toEqual([["created_at", new Date(NOW).toISOString()]]);
    // Ordered by the key alone, so each page is the rows after the last key seen
    // and a booking made mid read cannot repeat or skip one (2026-10-25); the rows
    // come back oldest first all the same, sorted after the read.
    expect(q.order).toEqual(["id"]);
    expect(q.range[0]).toEqual([0, 999]);
  });

  it("pages past the 1,000 row cap rather than measuring a truncated fortnight", async () => {
    const booking = (id: string) => ({ id, created_at: "2026-09-28T15:10:00.000Z", buckets: { code: "111", is_test: false } });
    const page = Array.from({ length: 1000 }, (_, i) => booking(`a${String(i).padStart(4, "0")}`));
    bookingsRead.queue = [
      { data: page, error: null },
      { data: Array.from({ length: 5 }, (_, i) => booking(`b${i}`)), error: null },
    ];
    const rows = await readRaceRateBookings(NOW);
    expect(rows).toHaveLength(1005);
    expect(bookingsRead.calls.map((c) => c.range[0])).toEqual([[0, 999], [0, 999]]);
    // The second page asks for the rows after the first page's last key.
    expect(bookingsRead.calls.map((c) => c.gt)).toEqual([[], [["id", "a0999"]]]);
  });

  it("THROWS on a failed read, rather than measuring no traffic and falling back in silence", async () => {
    bookingsRead.answer = { data: null, error: { message: "permission denied" } };
    await expect(readRaceRateBookings(NOW)).rejects.toThrow(/permission denied/);
  });

  it("THROWS on a stamp it cannot read, rather than dropping the booking from the rate", async () => {
    bookingsRead.answer = { data: [{ id: "b1", created_at: "not a time", buckets: { code: "111", is_test: false } }], error: null };
    await expect(readRaceRateBookings(NOW)).rejects.toThrow(/created_at/);
  });

  it("THROWS on a clock it cannot read, rather than asking for a window nobody chose", async () => {
    await expect(readRaceRateBookings(Number.NaN)).rejects.toThrow(/clock/);
    expect(from).not.toHaveBeenCalled();
  });
});
