import { afterEach, describe, expect, it, vi } from "vitest";

// #2388. `readBookingClasses` is asked about the WHOLE erasure trail: every booking
// id ever named in a `pii.erasure` audit row, read through `selectAllPages`. Its own
// docstring called that "a handful of rows" and justified a single `.in("id", ids)`
// by it, but the trail only grows, and PostgREST puts an `in` filter in the query
// string, so past roughly 266 uuids the read is REFUSED outright. The assumption
// expires on a date nobody is watching for.
//
// Two properties are pinned: no request is oversized, and a failure in ANY batch
// answers null for the whole set rather than the batches that happened to succeed. A
// short list here is indistinguishable from bookings that are genuinely absent, and
// `classifyErasedBookings` lands both on "real", so a partial answer would silently
// mark real bookings as unremarked rather than keeping the loud direction.
const db = vi.hoisted(() => {
  const state = {
    inCalls: [] as string[][],
    /** Batch index (zero based) that should answer an error, or null for none. */
    failAt: null as number | null,
  };
  const from = () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.in = (_col: string, ids: string[]) => {
      state.inCalls.push(ids);
      return chain;
    };
    chain.then = (onF: (v: unknown) => unknown) => {
      const index = state.inCalls.length - 1;
      const ids = state.inCalls[index] ?? [];
      const failed = state.failAt === index;
      return Promise.resolve({
        data: failed ? null : ids.map((id) => ({ id, bucket_id: "bucket-1" })),
        error: failed ? { message: "PostgREST refused the request" } : null,
      }).then(onF);
    };
    return chain;
  };
  return { state, from: vi.fn(from) };
});

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: db.from }) }));
vi.mock("@/lib/booking/test-flag", () => ({
  bookingTestFlags: vi.fn(async (_db: unknown, rows: { id: string }[]) =>
    new Map(rows.map((r) => [r.id, false])),
  ),
}));

import { readBookingClasses } from "./erasure-trail";
import { MAX_IN_FILTER_BYTES, idFilterBytes } from "@/lib/db/id-batch";

const manyIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

afterEach(() => {
  db.state.inCalls = [];
  db.state.failAt = null;
  vi.clearAllMocks();
});

describe("readBookingClasses splits the read across requests (#2388)", () => {
  it("never puts more ids in one filter than a URL can carry", async () => {
    const ids = manyIds(500);
    // Positive control: a trail this size really is over the ceiling, or the split
    // below is being asserted against what was only ever one request.
    expect(idFilterBytes(ids)).toBeGreaterThan(MAX_IN_FILTER_BYTES);

    const out = await readBookingClasses(ids);
    expect(db.state.inCalls.length).toBeGreaterThan(1);
    for (const batch of db.state.inCalls) {
      expect(idFilterBytes(batch)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    }
    // Every id is asked about exactly once, and every answer is kept.
    expect(db.state.inCalls.flat()).toEqual(ids);
    expect(out?.map((r) => r.id)).toEqual(ids);
  });

  it("does not split a trail small enough for one request", async () => {
    await readBookingClasses(["a", "b", "c"]);
    expect(db.state.inCalls).toEqual([["a", "b", "c"]]);
  });

  it("asks nothing for an empty trail", async () => {
    expect(await readBookingClasses([])).toEqual([]);
    expect(db.state.inCalls).toEqual([]);
  });

  // THE failure case. A refused batch partway through must not answer with the
  // batches that succeeded: the classifier reads a missing id as a real booking, so a
  // short list marks real bookings unremarked while looking like a complete answer.
  it("answers null when ONE batch fails, never the batches that succeeded", async () => {
    db.state.failAt = 1;
    const out = await readBookingClasses(manyIds(500));
    expect(out).toBeNull();
    // It really did get past the first batch, so this is a PARTIAL failure and not
    // simply the first request failing.
    expect(db.state.inCalls.length).toBeGreaterThan(1);
  });

  it("answers null when the FIRST batch fails too", async () => {
    db.state.failAt = 0;
    expect(await readBookingClasses(manyIds(500))).toBeNull();
  });
});
