import { describe, it, expect } from "vitest";
import { selectAllPages } from "./paginate";

// #828: PostgREST caps a single response at 1,000 rows. A read consumed as an
// aggregate with no pagination silently truncates, which under-reports (the #35 /
// #166 overbooking failure class). selectAllPages is the shared paginator that
// keeps a read from stopping at the first page.

/** A page() backed by a fixed array, recording every (from,to) it was asked for.
 *  Mirrors PostgREST: a full page is PAGE_SIZE rows, a partial page ends the walk. */
function pagedSource(rows: unknown[]) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  };
  return { page, calls };
}

describe("selectAllPages", () => {
  it("fetches every page when the first page is full (positive control: page 2 is really read)", async () => {
    // 1005 rows: page 0 fills (1000), page 1 returns the remaining 5.
    const rows = Array.from({ length: 1005 }, (_, i) => ({ i }));
    const { page, calls } = pagedSource(rows);

    const got = await selectAllPages<{ i: number }>("busy_blocks", page);

    expect(got).toHaveLength(1005);
    // The last row only exists on the second page; its presence proves no truncation.
    expect(got[1004]).toEqual({ i: 1004 });
    // Positive control: a second page WAS requested, starting at row 1000.
    expect(calls.map((c) => c[0])).toEqual([0, 1000]);
  });

  it("stops after a single short page without a wasteful extra request", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ i }));
    const { page, calls } = pagedSource(rows);

    const got = await selectAllPages<{ i: number }>("bookings", page);

    expect(got).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("throws with the read context instead of returning a short list on error", async () => {
    const page = () => Promise.resolve({ data: null, error: { message: "read timeout" } });
    await expect(selectAllPages("availability_rules", page)).rejects.toThrow(
      /availability_rules read failed: read timeout/,
    );
  });
});
