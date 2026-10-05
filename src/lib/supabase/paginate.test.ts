import { describe, it, expect } from "vitest";
import { selectAllPages, PAGE_SIZE, type PageableQuery } from "./paginate";

// #828: PostgREST caps a single response at 1,000 rows. A read consumed as an
// aggregate with no pagination silently truncates, which under-reports (the #35 /
// #166 overbooking failure class). selectAllPages is the shared paginator that
// keeps a read from stopping at the first page.
//
// #3273: it pages with OFFSET, which partitions a result only under a total order.
// The table below has NO natural order: like Postgres, it returns a query that
// names no order in whatever order it likes, different on every call. Production
// read 2,392 busy rows of which 1,826 were distinct that way.

type Row = { id: string; grp: number };

/** A table with no natural order. An unordered query comes back shuffled afresh
 *  on every call; ordered columns are honoured, in the order they were named. */
function unorderedTable(rows: Row[]) {
  const ranges: [number, number][] = [];
  const orders: string[][] = [];
  let seed = 7;
  const shuffle = (xs: Row[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const build = (): PageableQuery => {
    const by: string[] = [];
    const q: PageableQuery = {
      order: (column) => {
        by.push(column);
        return q;
      },
      range: (from, to) => {
        ranges.push([from, to]);
        orders.push([...by]);
        let out = shuffle(rows);
        if (by.length > 0) {
          out = out.sort((a, b) => {
            for (const c of by) {
              const x = String(a[c as keyof Row]);
              const y = String(b[c as keyof Row]);
              if (x !== y) return x < y ? -1 : 1;
            }
            return 0;
          });
        }
        return Promise.resolve({ data: out.slice(from, to + 1), error: null });
      },
    };
    return q;
  };
  return { build, ranges, orders };
}

const rowsOf = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, "0")}`, grp: i % 3 }));

describe("selectAllPages", () => {
  it("reads a table with no natural order across page boundaries with no row twice and none missing", async () => {
    const rows = rowsOf(2 * PAGE_SIZE + 392);
    const t = unorderedTable(rows);

    const got = await selectAllPages<Row>("busy_blocks", "id", t.build);

    expect(got).toHaveLength(rows.length);
    expect(new Set(got.map((r) => r.id)).size).toBe(rows.length);
    // Positive control: three pages were really cut, so a boundary was crossed.
    expect(t.ranges.map((r) => r[0])).toEqual([0, 1000, 2000]);
  });

  it("appends the key AFTER the query's own order, so a non unique order still pages cleanly", async () => {
    const rows = rowsOf(PAGE_SIZE + 500);
    const t = unorderedTable(rows);
    const build = () => t.build().order("grp");

    const got = await selectAllPages<Row>("bookings", "id", build);

    expect(new Set(got.map((r) => r.id)).size).toBe(rows.length);
    expect(t.orders[0]).toEqual(["grp", "id"]);
    // The caller's order still decides the sequence.
    expect(got.map((r) => r.grp)).toEqual([...got.map((r) => r.grp)].sort());
  });

  it("orders by every column of a composite key", async () => {
    const t = unorderedTable(rowsOf(3));
    await selectAllPages<Row>("frame_origin_daily", ["grp", "id"], t.build);
    expect(t.orders).toEqual([["grp", "id"]]);
  });

  it("refuses an empty key rather than paging unordered", async () => {
    const t = unorderedTable(rowsOf(3));
    await expect(selectAllPages<Row>("x", [], t.build)).rejects.toThrow(/unique key/);
    await expect(selectAllPages<Row>("x", " ", t.build)).rejects.toThrow(/unique key/);
    expect(t.ranges).toEqual([]);
  });

  it("stops after a single short page without a wasteful extra request", async () => {
    const t = unorderedTable(rowsOf(3));
    const got = await selectAllPages<Row>("bookings", "id", t.build);
    expect(got).toHaveLength(3);
    expect(t.ranges).toHaveLength(1);
  });

  it("throws with the read context instead of returning a short list on error", async () => {
    const failing = (): PageableQuery => {
      const q: PageableQuery = {
        order: () => q,
        range: () => Promise.resolve({ data: null, error: { message: "read timeout" } }),
      };
      return q;
    };
    await expect(selectAllPages("availability_rules", "id", failing)).rejects.toThrow(
      /availability_rules read failed: read timeout/,
    );
  });
});
