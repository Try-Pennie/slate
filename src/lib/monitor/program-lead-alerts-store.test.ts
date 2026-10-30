// The program leads alerts' reads (#4392): each one bounded to what the check judges, and
// each one loud on a failure rather than a zero that would read as "no fallbacks" or "no
// registrations", which are the findings the checks exist to make in opposite directions.
import { describe, expect, it } from "vitest";
import { countProgramLeadsRegisteredSince, readProgramLeadFallbackDayCount } from "./program-lead-alerts-store";

type Filter = [string, ...unknown[]];

function fakeDb(result: { data?: unknown; count?: number | null; error: { message: string } | null }) {
  const queries: { table: string; select?: string; opts?: unknown; filters: Filter[] }[] = [];
  const db = {
    from: (table: string) => {
      const q: { table: string; select?: string; opts?: unknown; filters: Filter[] } = { table, filters: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      chain.select = (cols: string, opts?: unknown) => {
        q.select = cols;
        q.opts = opts;
        return chain;
      };
      for (const op of ["eq", "gte"]) {
        chain[op] = (...args: unknown[]) => {
          q.filters.push([op, ...args]);
          return chain;
        };
      }
      chain.maybeSingle = () => Promise.resolve(result);
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return chain;
    },
  };
  return { db: db as never, queries };
}

describe("readProgramLeadFallbackDayCount", () => {
  it("reads the day's times_fallback row by its primary key", async () => {
    const { db, queries } = fakeDb({ data: { occurrences: 7 }, error: null });
    expect(await readProgramLeadFallbackDayCount(db, "2026-10-29")).toBe(7);
    expect(queries[0]!.table).toBe("program_lead_outcomes");
    expect(queries[0]!.filters).toEqual([["eq", "day", "2026-10-29"], ["eq", "kind", "times_fallback"]]);
  });

  it("answers zero for a day with no row, which is a real answer: nothing was bumped", async () => {
    const { db } = fakeDb({ data: null, error: null });
    expect(await readProgramLeadFallbackDayCount(db, "2026-10-29")).toBe(0);
  });

  it("throws on a failed read, never answering zero", async () => {
    const { db } = fakeDb({ data: null, error: { message: "boom" } });
    await expect(readProgramLeadFallbackDayCount(db, "2026-10-29")).rejects.toThrow(/program lead fallbacks/);
  });
});

describe("countProgramLeadsRegisteredSince", () => {
  it("counts on the server, every registration moving last_registered_at", async () => {
    const { db, queries } = fakeDb({ count: 4, error: null });
    expect(await countProgramLeadsRegisteredSince(db, "2026-10-28T13:00:00.000Z")).toBe(4);
    expect(queries[0]!.table).toBe("program_leads");
    expect(queries[0]!.opts).toEqual({ count: "exact", head: true });
    expect(queries[0]!.filters).toEqual([["gte", "last_registered_at", "2026-10-28T13:00:00.000Z"]]);
  });

  it("throws on a failed count, never answering zero registrations", async () => {
    const { db } = fakeDb({ count: null, error: { message: "boom" } });
    await expect(countProgramLeadsRegisteredSince(db, "x")).rejects.toThrow();
  });
});
