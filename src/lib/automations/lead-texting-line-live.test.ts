import { describe, it, expect } from "vitest";

// #3718: the lead_texting_lines table as a TextingLineStore. The decisions are pinned by
// scripts/test-lead-texting-line.ts on an in memory store; this pins the WIRING those
// decisions rest on, which a dropped option would break without any decision test
// noticing: a claim must never overwrite a saved line (ON CONFLICT DO NOTHING), a swap
// must land only over the line it replaces, both hand back what is SAVED, and a refused
// statement throws rather than reading as "no line".

import { liveTextingLineStore } from "./lead-texting-line-live";

type Filter = [string, unknown];

/** A stand in for the table that applies the filters and options it is given. */
function fakeTable(initial: Record<string, string> = {}, refuse?: "select" | "upsert" | "update") {
  const rows = new Map(Object.entries(initial));
  const refused = { data: null, error: { message: "permission denied" } };
  const match = (filters: Filter[], key: string) =>
    filters.every(([col, v]) => (col === "lead_key" ? key === v : col === "line" ? rows.get(key) === v : false));
  const db = {
    from: (table: string) => {
      expect(table).toBe("lead_texting_lines");
      return {
        select: () => {
          const filters: Filter[] = [];
          const q = {
            eq: (col: string, v: unknown) => (filters.push([col, v]), q),
            maybeSingle: async () => {
              if (refuse === "select") return refused;
              const key = [...rows.keys()].find((k) => match(filters, k));
              return { data: key ? { line: rows.get(key) } : null, error: null };
            },
          };
          return q;
        },
        upsert: async (row: { lead_key: string; line: string }, opts: { onConflict?: string; ignoreDuplicates?: boolean }) => {
          if (refuse === "upsert") return refused;
          expect(opts.onConflict).toBe("lead_key");
          if (!rows.has(row.lead_key) || !opts.ignoreDuplicates) rows.set(row.lead_key, row.line);
          return { data: null, error: null };
        },
        update: (patch: { line: string; replaced_at?: string }) => {
          const filters: Filter[] = [];
          const q = {
            eq: (col: string, v: unknown) => (filters.push([col, v]), q),
            then: (resolve: (r: unknown) => void) => {
              if (refuse === "update") return resolve(refused);
              for (const k of [...rows.keys()]) if (match(filters, k)) rows.set(k, patch.line);
              resolve({ data: null, error: null });
            },
          };
          return q;
        },
      };
    },
  };
  return { db: (() => db) as never, rows };
}

const KEY = "00QUl00000JtyVG";

describe("liveTextingLineStore", () => {
  it("reads a lead's saved line, and null for a lead with none", async () => {
    const { db } = fakeTable({ [KEY]: "+12125550101" });
    const store = liveTextingLineStore(db);
    expect(await store.read(KEY)).toBe("+12125550101");
    expect(await store.read("00QUl00000OTHER")).toBeNull();
  });

  it("a claim saves a lead's first line", async () => {
    const { db, rows } = fakeTable();
    expect(await liveTextingLineStore(db).claim(KEY, "+12125550101")).toBe("+12125550101");
    expect(rows.get(KEY)).toBe("+12125550101");
  });

  it("a claim never overwrites a saved line, and hands back the saved one", async () => {
    const { db, rows } = fakeTable({ [KEY]: "+12125550101" });
    expect(await liveTextingLineStore(db).claim(KEY, "+13135550102")).toBe("+12125550101");
    expect(rows.get(KEY)).toBe("+12125550101");
  });

  it("a swap replaces the line it names", async () => {
    const { db, rows } = fakeTable({ [KEY]: "+12125550101" });
    expect(await liveTextingLineStore(db).swap(KEY, "+12125550101", "+13135550102")).toBe("+13135550102");
    expect(rows.get(KEY)).toBe("+13135550102");
  });

  it("a swap over a line already replaced changes nothing, and hands back the replacement", async () => {
    const { db, rows } = fakeTable({ [KEY]: "+13135550102" });
    expect(await liveTextingLineStore(db).swap(KEY, "+12125550101", "+14145550103")).toBe("+13135550102");
    expect(rows.get(KEY)).toBe("+13135550102");
  });

  it("a client that cannot be made fails the call, not the construction", async () => {
    const store = liveTextingLineStore(() => {
      throw new Error("SUPABASE_SECRET_KEY is unset");
    });
    await expect(store.read(KEY)).rejects.toThrow(/unset/);
  });

  it.each(["select", "upsert", "update"] as const)("a refused %s throws rather than reading as no line", async (which) => {
    const { db } = fakeTable({ [KEY]: "+12125550101" }, which);
    const store = liveTextingLineStore(db);
    const run = which === "select" ? store.read(KEY) : which === "upsert" ? store.claim(KEY, "+1") : store.swap(KEY, "+12125550101", "+1");
    await expect(run).rejects.toThrow(/lead texting line/);
  });
});
