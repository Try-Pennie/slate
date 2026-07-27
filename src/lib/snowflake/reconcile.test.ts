import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({})) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./client", () => ({
  executeStatement: vi.fn(async () => ({ data: [["5"]] })),
  escapeSqlLiteral: (s: string) => s,
}));

import { evaluateRecon, reconThreshold, reconcileSnowflakeMirror, type TableRecon } from "./reconcile";
import { readSnowflakeConfig } from "./config";
import { supabaseAdmin } from "@/lib/supabase/admin";

const t = (table: string, supabase: number, snowflake: number): TableRecon => ({
  table,
  supabase,
  snowflake,
  drift: supabase - snowflake,
});

afterEach(() => vi.clearAllMocks());

describe("evaluateRecon", () => {
  it("is ok when every table is within the lag tolerance", () => {
    const r = evaluateRecon([t("bookings", 1000, 990), t("audit_log", 3, 3)], {
      table: "bookings",
      id: "b1",
      foundInSnowflake: true,
    });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags a table whose drift exceeds the threshold", () => {
    const r = evaluateRecon([t("bookings", 1000, 800)], null);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/bookings: Snowflake is behind by 200/);
  });

  it("does NOT flag Snowflake ahead (expected once retention prunes Supabase, #1102)", () => {
    const r = evaluateRecon([t("bookings", 100, 130)], null);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("fails when the positive control did not find its known row (a zero cannot be trusted)", () => {
    const r = evaluateRecon([t("bookings", 5, 5)], { table: "bookings", id: "oldest", foundInSnowflake: false });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/positive control failed/);
  });

  it("threshold is the larger of the flat floor and a small percentage", () => {
    expect(reconThreshold(100)).toBe(25); // floor wins on small tables
    expect(reconThreshold(10_000)).toBe(200); // 2% wins at scale
  });
});

describe("reconcileSnowflakeMirror", () => {
  it("skips (and reports ok) when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await reconcileSnowflakeMirror();
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.tables).toEqual([]);
  });

  it("counts Supabase with the SAME skip predicate the export uses (#1118, Flaw B)", async () => {
    // Reconcile must exclude redacted rows from the Supabase count. Otherwise a
    // row erased before its first export (present in Supabase, never in Snowflake)
    // reads as permanent "Snowflake is behind" drift, which freezes retention.
    vi.mocked(readSnowflakeConfig).mockReturnValue({
      account: "a",
      user: "u",
      privateKeyPem: "k",
      database: "SLATE",
      schema: "PUBLIC",
      warehouse: "W",
      role: "R",
    });

    const invocations: { table: string; methods: { m: string; args: unknown[] }[] }[] = [];
    const db = {
      from(table: string) {
        const methods: { m: string; args: unknown[] }[] = [];
        invocations.push({ table, methods });
        const b: Record<string, unknown> = {};
        for (const m of ["select", "order", "limit", "is", "eq"]) {
          b[m] = (...args: unknown[]) => {
            methods.push({ m, args });
            return b;
          };
        }
        b.maybeSingle = async () => ({ data: { id: "oldest" }, error: null });
        b.then = (resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) =>
          resolve({ count: 5, data: [], error: null });
        return b;
      },
    };
    vi.mocked(supabaseAdmin).mockReturnValue(db as never);

    await reconcileSnowflakeMirror();

    // The bookings COUNT read (select "*") excludes redacted rows.
    const bookingsCount = invocations.find((v) => v.table === "bookings" && v.methods[0]?.args[0] === "*");
    expect(bookingsCount?.methods.some((m) => m.m === "is" && m.args[0] === "pii_redacted_at" && m.args[1] === null)).toBe(
      true,
    );
    // The webhook COUNT read excludes blanked payloads.
    const whCount = invocations.find((v) => v.table === "webhook_deliveries");
    expect(whCount?.methods.some((m) => m.m === "eq" && m.args[0] === "payload_erased" && m.args[1] === false)).toBe(true);
    // An append-only table is counted whole (no skip filter).
    const auditCount = invocations.find((v) => v.table === "audit_log");
    expect(auditCount?.methods.some((m) => m.m === "is" || m.m === "eq")).toBe(false);
  });
});
