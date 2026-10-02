import { describe, it, expect } from "vitest";
import { loadTierDropReport } from "./tier-drops-load";

// The tier drop panel's reads (2026-10-02). Pinned here because the population
// is the whole point: the drops and the totals they are shown against must be the
// same bookings (L629), and a failed read must throw rather than draw "no drops".

type Filter = [string, string, unknown];
const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);

function fakeDb(opts: { rows?: unknown[]; count?: number; rowsError?: string; countError?: string } = {}) {
  const reads: { head: boolean; select: string; filters: Filter[] }[] = [];
  const db = {
    from(table: string) {
      const read = { head: false, select: "", filters: [] as Filter[] };
      if (table !== "bookings") throw new Error(`unexpected table ${table}`);
      reads.push(read);
      const q: Record<string, unknown> = {
        select: (cols: string, o?: { head?: boolean }) => {
          read.select = cols;
          read.head = !!o?.head;
          return q;
        },
        eq: (c: string, v: unknown) => (read.filters.push(["eq", c, v]), q),
        gte: (c: string, v: unknown) => (read.filters.push(["gte", c, v]), q),
        order: () => q,
        range: () => q,
        then: (res: (v: unknown) => unknown) =>
          read.head
            ? res({ count: opts.count ?? 0, error: opts.countError ? { message: opts.countError } : null })
            : res({ data: opts.rows ?? [], error: opts.rowsError ? { message: opts.rowsError } : null }),
      };
      return q;
    },
  };
  return { db: db as never, reads };
}

const drop = (id: string, ageDays: number, displayed: string | null = "high") => ({
  id,
  created_at: new Date(NOW - ageDays * 86_400_000).toISOString(),
  routing_trace: { tier_fallback: true, requested_tier: "high", booked_tier: "medium", displayed_tier: displayed, bucket_code: "211" },
});

describe("loadTierDropReport", () => {
  it("counts the drops and the routed bookings beside them", async () => {
    const { db } = fakeDb({ rows: [drop("a", 1), drop("b", 10, "medium")], count: 40 });
    const r = await loadTierDropReport(db, "org-1", NOW);
    expect(r.counts.week.total).toBe(1);
    expect(r.counts.month).toEqual({ "lost-at-confirm": 1, "nothing-on-show": 1, "not-recorded": 0, total: 2 });
    expect(r.booked).toEqual({ week: 40, month: 40 });
  });

  it("reads the drops and the totals from the same population", async () => {
    const { db, reads } = fakeDb();
    await loadTierDropReport(db, "org-1", NOW);
    expect(reads).toHaveLength(3);
    const shared: Filter[] = [
      ["eq", "org_id", "org-1"],
      ["eq", "buckets.is_test", false],
      ["eq", "kind", "routed"],
    ];
    for (const r of reads) {
      for (const f of shared) expect(r.filters).toContainEqual(f);
      expect(r.select).toContain("buckets!inner(is_test)");
    }
    const rowsRead = reads.find((r) => !r.head)!;
    expect(rowsRead.filters).toContainEqual(["eq", "routing_trace->>tier_fallback", "true"]);
    expect(rowsRead.select).toContain("routing_trace");
    const since = reads.filter((r) => r.head).map((r) => r.filters.find((f) => f[0] === "gte")?.[2]).sort();
    expect(since).toEqual(
      [new Date(NOW - 30 * 86_400_000).toISOString(), new Date(NOW - 7 * 86_400_000).toISOString()].sort(),
    );
  });

  it("throws when the drops cannot be read, rather than drawing none", async () => {
    const { db } = fakeDb({ rowsError: "column does not exist" });
    await expect(loadTierDropReport(db, "org-1", NOW)).rejects.toThrow(/admin tier drops/);
  });

  it("throws when a total cannot be counted, rather than drawing zero bookings", async () => {
    const { db } = fakeDb({ countError: "timeout" });
    await expect(loadTierDropReport(db, "org-1", NOW)).rejects.toThrow(/count failed/);
  });
});
