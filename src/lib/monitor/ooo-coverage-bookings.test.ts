import { describe, it, expect, vi, beforeEach } from "vitest";

// #2369: the OOO coverage check's booking read, which had never once executed.
//
// It filtered `bookings` on an `is_test` column that table does not have (migration
// 0051 put the flag on `users` and `buckets`), so PostgREST answered 42703 and
// `selectAllPages` threw on every tick. Nothing could have caught it: the read sat
// inline in a 2,000 line handler, the column list is a string no type reaches, and
// there was no seam to test it through. Lifting it out is what makes these possible.
//
// The query is driven through a fake that RECORDS what was asked for, so the two
// things that were wrong and the two that must stay right are each asserted rather
// than read off the source.
const paginate = vi.hoisted(() => ({ selectAllPages: vi.fn() }));
vi.mock("@/lib/supabase/paginate", () => paginate);

import { loadOooCoverageBookings, loadSnapshottedBookingIds } from "@/lib/monitor/ooo-coverage-bookings";
import { MAX_IN_FILTER_BYTES, idFilterBytes } from "@/lib/db/id-batch";

interface Recorded {
  table: string;
  select: string;
  eq: [string, unknown][];
  in: [string, unknown][];
  gte: [string, unknown][];
  range: [number, number][];
}

/** A builder that records the chain and answers rows. */
function fakeDb(rows: unknown[] = []) {
  const calls: Recorded[] = [];
  const from = (table: string) => {
    const rec: Recorded = { table, select: "", eq: [], in: [], gte: [], range: [] };
    calls.push(rec);
    const chain = {
      select: (s: string) => ((rec.select = s), chain),
      eq: (c: string, v: unknown) => (rec.eq.push([c, v]), chain),
      in: (c: string, v: unknown) => (rec.in.push([c, v]), chain),
      gte: (c: string, v: unknown) => (rec.gte.push([c, v]), chain),
      order: () => chain,
      range: (a: number, b: number) => (rec.range.push([a, b]), chain),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return chain;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from } as any, calls };
}

const NOW = "2026-09-16T12:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  // Run the page callback once, the way the real paginator does for a first page.
  paginate.selectAllPages.mockImplementation(
    async (_label: string, key: string, build: () => { order: (k: string) => { range: (f: number, t: number) => unknown } }) => {
    const res = (await build().order(key).range(0, 999)) as { data: unknown[] | null };
    return res.data ?? [];
  },
  );
});

describe("the query it builds", () => {
  it("names no column the bookings table does not have", async () => {
    const { db, calls } = fakeDb();
    await loadOooCoverageBookings(db, ["u1"], NOW);
    const read = calls.find((c) => c.table === "bookings")!;
    // The exact defect: a bare is_test predicate on a table that has no such column.
    expect(read.eq.map(([c]) => c)).not.toContain("is_test");
    expect(read.select.split(",").map((s) => s.trim())).not.toContain("is_test");
  });

  it("excludes the smoke canary through the BUCKET, which is what marks it", async () => {
    const { db, calls } = fakeDb();
    await loadOooCoverageBookings(db, ["u1"], NOW);
    const read = calls.find((c) => c.table === "bookings")!;
    // An INNER join, so a booking is dropped by the database rather than counted and
    // filtered afterwards, which would miscount every paged read.
    expect(read.select).toContain("buckets!inner(is_test)");
    expect(read.eq).toContainEqual(["buckets.is_test", false]);
  });

  it("keeps the two filters the check's correctness rests on", async () => {
    const { db, calls } = fakeDb();
    await loadOooCoverageBookings(db, ["u1", "u2"], NOW);
    const read = calls.find((c) => c.table === "bookings")!;
    expect(read.in).toContainEqual(["assigned_user_id", ["u1", "u2"]]);
    expect(read.in.map(([c]) => c)).toContain("status");
    // `ends_at`, never `starts_at`: the straddler begins before the absence and runs
    // into it, and flooring on the start is the exact miss this check exists to catch.
    expect(read.gte).toContainEqual(["ends_at", NOW]);
    expect(read.gte.map(([c]) => c)).not.toContain("starts_at");
  });

  it("reads every page rather than one", async () => {
    const { db, calls } = fakeDb();
    await loadOooCoverageBookings(db, ["u1"], NOW);
    expect(paginate.selectAllPages).toHaveBeenCalledTimes(1);
    expect(calls[0].range.length).toBe(1);
  });
});

describe("what it answers", () => {
  it("returns the rows the read gave it", async () => {
    const row = {
      id: "bk-1",
      assigned_user_id: "u1",
      starts_at: NOW,
      ends_at: "2026-09-16T12:30:00.000Z",
    };
    const { db } = fakeDb([row]);
    expect(await loadOooCoverageBookings(db, ["u1"], NOW)).toEqual([row]);
  });

  it("asks nothing when no agent is away, rather than reading the whole table", async () => {
    const { db, calls } = fakeDb();
    expect(await loadOooCoverageBookings(db, [], NOW)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(paginate.selectAllPages).not.toHaveBeenCalled();
  });

  it("THROWS on a failed read rather than under-reporting the gap", async () => {
    const { db } = fakeDb();
    paginate.selectAllPages.mockRejectedValueOnce(new Error("read failed [monitor ooo coverage bookings]"));
    await expect(loadOooCoverageBookings(db, ["u1"], NOW)).rejects.toThrow(/read failed/);
  });
});

// #2388. The sibling read: which of those bookings already carry a coverage sweep
// row. It lived inline in the monitor handler and put EVERY booking id into one
// `.in("booking_id", ...)` filter, over a list read with `selectAllPages` precisely
// because it is expected to exceed a page. PostgREST puts that filter in the query
// string, so past roughly 266 uuids the request is REFUSED, the OOO coverage check
// throws on every tick, and it goes quiet for the agents it exists to protect.
// Measured on 2026-08-31: 24 agents with approved time off holding fifteen upcoming
// calls each is 360 ids, past the refusal point.
describe("loadSnapshottedBookingIds", () => {
  const manyIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

  it("never puts more ids in one filter than a URL can carry", async () => {
    const ids = manyIds(400);
    // Positive control: this many ids really is over the ceiling, or the split is
    // being asserted against what was only ever going to be a single request.
    expect(idFilterBytes(ids)).toBeGreaterThan(MAX_IN_FILTER_BYTES);

    const { db, calls } = fakeDb();
    await loadSnapshottedBookingIds(db, ids);
    const sent = calls
      .flatMap((c) => c.in)
      .filter(([col]) => col === "booking_id")
      .map(([, v]) => v as string[]);
    expect(sent.length).toBeGreaterThan(1);
    for (const batch of sent) expect(idFilterBytes(batch)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    // Every id is asked about exactly once: a dropped batch would report a booking as
    // unswept and page about a sweep that is working.
    expect(sent.flat()).toEqual(ids);
  });

  it("unions the rows from every request", async () => {
    const { db } = fakeDb([{ booking_id: "bk-1" }]);
    const out = await loadSnapshottedBookingIds(db, manyIds(400));
    // The fake answers the same row to every request, so a union holds one entry
    // while a plain concatenation would hold several.
    expect([...out]).toEqual(["bk-1"]);
  });

  it("asks nothing when there are no bookings", async () => {
    const { db, calls } = fakeDb();
    expect([...(await loadSnapshottedBookingIds(db, []))]).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // The failure case: a refused or failed request must never come back as "none of
  // these bookings has a sweep row", which reads as a real gap and pages about it.
  it("THROWS on a failed request rather than under-reporting the sweep rows", async () => {
    const { db } = fakeDb();
    paginate.selectAllPages.mockRejectedValueOnce(new Error("read failed [monitor ooo coverage snapshotted]"));
    await expect(loadSnapshottedBookingIds(db, manyIds(400))).rejects.toThrow(/read failed/);
  });
});
