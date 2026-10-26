import { describe, it, expect } from "vitest";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import { loadAllWorkingHours } from "./working-hours-load";

// #828 (C3): the availability monitor reads the WHOLE availability_rules table
// (no filter) for its on-shift gate. At ~5-7 rules per schedule × ~200 agents
// that is ~1,000-1,400 rows, so a single-page read truncates and the monitor
// mis-judges who is on shift (false or missed dead-end alerts). The reads must
// page.

// A fixture row naming no primary key is given one by its position, in key order,
// and `.gt` honours it: a paged read cuts each later page as the rows after the last
// key seen (keyset paging, 2026-10-25).
const keyed = (rows: unknown[]) =>
  rows.map((r, i): Record<string, unknown> => ({ id: `row-${String(i).padStart(6, "0")}`, ...(r as Record<string, unknown>) }));

/** Emulates PostgREST paging per table: `.order` sorts, `.gt` filters on the key,
 *  `.range(from,to)` returns that window, and a read with no range is capped at the
 *  first 1,000 rows (the silent cap). */
function fakeDb(tables: Record<string, unknown[]>): ReturnType<typeof supabaseAdmin> {
  const builder = (tableRows: unknown[]) => {
    let range: [number, number] | null = null;
    let rows = keyed(tableRows);
    const b: Record<string, unknown> = {
      select: () => b,
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
  return { from: (t: string) => builder(tables[t] ?? []) } as unknown as ReturnType<
    typeof supabaseAdmin
  >;
}

describe("loadAllWorkingHours (#828)", () => {
  it("returns every availability rule past the 1,000-row cap", async () => {
    const rules = Array.from({ length: 1001 }, (_, i) => ({
      schedule_id: `s${i}`,
      weekday: 1,
      start_minute: 540,
      end_minute: 1020,
    }));
    const { rules: got } = await loadAllWorkingHours(
      fakeDb({ availability_schedules: [{ id: "s0", user_id: "u0", timezone: "America/New_York" }], availability_rules: rules }),
    );
    expect(got).toHaveLength(1001);
  });

  it("throws instead of silently returning a short list when a read errors", async () => {
    const failing = {
      from: () => {
        const b: Record<string, unknown> = {
          select: () => b,
          order: () => b,
          range: () => b,
          then: (resolve: (v: { data: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ data: null, error: { message: "read timeout" } }).then(resolve),
        };
        return b;
      },
    } as unknown as ReturnType<typeof supabaseAdmin>;
    await expect(loadAllWorkingHours(failing)).rejects.toThrow(/read timeout/);
  });
});
