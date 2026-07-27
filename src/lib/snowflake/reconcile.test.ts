import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({})) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { evaluateRecon, reconThreshold, reconcileSnowflakeMirror, type TableRecon } from "./reconcile";
import { readSnowflakeConfig } from "./config";

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

  it("flags Snowflake having MORE rows than Supabase", () => {
    const r = evaluateRecon([t("bookings", 100, 130)], null);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/MORE rows/);
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
});
