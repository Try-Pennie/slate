import { describe, it, expect } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import { loadOrgOooHistory } from "./history-load";

// #828 (C4): the admin OOO insights aggregate over the org's FULL request
// history (all time), which grows monotonically and crosses PostgREST's
// 1,000-row cap within a year. A single-page read would silently under-report
// every insight, so the loader must page.

// A fixture row naming no primary key is given one by its position, in key order,
// and `.gt` honours it: a paged read cuts each later page as the rows after the last
// key seen (keyset paging, 2026-10-25).
const keyed = (rows: unknown[]) =>
  rows.map((r, i): Record<string, unknown> => ({ id: `row-${String(i).padStart(6, "0")}`, ...(r as Record<string, unknown>) }));

/** Emulates PostgREST paging: `.order` sorts, `.gt` filters on the key, and
 *  `.range(from,to)` returns that window; a read with no range is capped at the
 *  first 1,000 rows (the silent truncation this fixes). */
function fakeDb(tableRows: unknown[]): ReturnType<typeof supabaseAdmin> {
  const builder = () => {
    let range: [number, number] | null = null;
    let rows = keyed(tableRows);
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      gt: (col: string, v: string) => ((rows = rows.filter((r) => String(r[col]) > v)), b),
      order: (col: string) => ((rows = [...rows].sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1))), b),
      range: (from: number, to: number) => {
        range = [from, to];
        return b;
      },
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => {
        const data = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, 1000);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { from: () => builder() } as unknown as ReturnType<typeof supabaseAdmin>;
}

describe("loadOrgOooHistory (#828)", () => {
  it("returns every request past the 1,000-row cap so insights are not under-counted", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}`, org_id: "org1" }));
    const got = await loadOrgOooHistory(fakeDb(rows), "org1");
    expect(got).toHaveLength(1001);
  });

  it("throws instead of silently returning a short list when the read errors", async () => {
    const failing = {
      from: () => {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => b,
          range: () => b,
          then: (resolve: (v: { data: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ data: null, error: { message: "read timeout" } }).then(resolve),
        };
        return b;
      },
    } as unknown as ReturnType<typeof supabaseAdmin>;
    await expect(loadOrgOooHistory(failing, "org1")).rejects.toThrow(/read timeout/);
  });
});
