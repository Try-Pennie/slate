import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({ from: vi.fn() })) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./client", () => ({
  executeStatement: vi.fn(async () => ({ data: [["0"]] })),
  escapeSqlLiteral: (s: string) => s,
}));
vi.mock("@/lib/supabase/paginate", () => ({ selectAllPages: vi.fn(async () => []) }));

import { evaluateErasureAudit, auditSnowflakeErasures } from "./erasure-audit";
import { readSnowflakeConfig } from "./config";
import { selectAllPages } from "@/lib/supabase/paginate";
import { executeStatement } from "./client";

const cfg = {
  account: "a",
  user: "u",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "W",
  role: "R",
};

afterEach(() => vi.clearAllMocks());

describe("evaluateErasureAudit", () => {
  it("is ok when no erased booking holds residual PII in Snowflake", () => {
    const r = evaluateErasureAudit([
      { table: "bookings", residual: 0 },
      { table: "booking_events", residual: 0 },
      { table: "webhook_deliveries", residual: 0 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags a table that still holds PII for erased bookings", () => {
    const r = evaluateErasureAudit([{ table: "bookings", residual: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/bookings.*2/);
  });

  it("flags every table with residual PII", () => {
    const r = evaluateErasureAudit([
      { table: "bookings", residual: 1 },
      { table: "webhook_deliveries", residual: 3 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });
});

describe("auditSnowflakeErasures", () => {
  it("skips (and reports ok) when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await auditSnowflakeErasures();
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("does no Snowflake read when there are no erasure audit rows", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([]);
    const r = await auditSnowflakeErasures();
    expect(r.ok).toBe(true);
    expect(r.erasedBookings).toBe(0);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("flags residual PII when an erased booking still has contact data in Snowflake", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1", "bk2"] } }]);
    // bookings still holds one row with an email; the other tables are clean.
    vi.mocked(executeStatement).mockImplementation(
      async (_c, sql: string) => ({ data: [[sql.includes("FROM bookings") ? "1" : "0"]] }) as never,
    );
    const r = await auditSnowflakeErasures();
    expect(r.erasedBookings).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/bookings/);
  });
});
