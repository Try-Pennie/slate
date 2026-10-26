import { describe, it, expect } from "vitest";
import { selectAllPages, PAGE_SIZE, type PageableQuery } from "./paginate";

// #828: PostgREST caps a single response at 1,000 rows. A read consumed as an
// aggregate with no pagination silently truncates, which under-reports (the #35 /
// #166 overbooking failure class). selectAllPages is the shared paginator that
// keeps a read from stopping at the first page.
//
// #3273: a page cut needs a total order. The table below has NO natural order:
// like Postgres, it returns a query that names no order in whatever order it
// likes, different on every call. Production read 2,392 busy rows of which 1,826
// were distinct that way, under OFFSET paging.
//
// 2026-10-25: pages are cut by KEYSET (each page asks for the rows after the last
// key seen), so a row inserted or removed between page requests can no longer
// repeat or skip a row; scripts/test-paged-read-live-table.ts drives that case.

type Row = { id: string; grp: number };

/** A table with no natural order. An unordered query comes back shuffled afresh
 *  on every call; ordered columns are honoured, in the order they were named. */
function unorderedTable(rows: Row[]) {
  const ranges: [number, number][] = [];
  const orders: string[][] = [];
  const afters: (string | number | null)[] = [];
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
    let after: { column: string; value: string | number } | null = null;
    const q: PageableQuery = {
      order: (column) => {
        by.push(column);
        return q;
      },
      gt: (column, value) => {
        after = { column, value };
        return q;
      },
      or: () => {
        throw new Error("this fake models single column keys only");
      },
      range: (from, to) => {
        ranges.push([from, to]);
        orders.push([...by]);
        const a: { column: string; value: string | number } | null = after;
        afters.push(a ? a.value : null);
        let out = shuffle(rows).filter((r) => !a || String(r[a.column as keyof Row]) > String(a.value));
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
  return { build, ranges, orders, afters };
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
    // Positive control: three pages were really cut, each after the last key seen.
    expect(t.afters).toEqual([null, rows[PAGE_SIZE - 1]!.id, rows[2 * PAGE_SIZE - 1]!.id]);
    expect(t.ranges).toEqual([
      [0, PAGE_SIZE - 1],
      [0, PAGE_SIZE - 1],
      [0, PAGE_SIZE - 1],
    ]);
    // The result is in key order, which is the only order the read asks for.
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("refuses a row that does not carry its key, rather than cutting the next page from nothing", async () => {
    const t = unorderedTable(rowsOf(3));
    await expect(selectAllPages<Row>("busy_blocks", "missing_col", t.build)).rejects.toThrow(/missing_col/);
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
        gt: () => q,
        or: () => q,
        range: () => Promise.resolve({ data: null, error: { message: "read timeout" } }),
      };
      return q;
    };
    await expect(selectAllPages("availability_rules", "id", failing)).rejects.toThrow(
      /availability_rules read failed: read timeout/,
    );
  });
});
