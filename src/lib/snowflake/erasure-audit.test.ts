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

  // #1205: `last_response` holds up to 1000 chars of the subscriber's response
  // body, which commonly quotes the request and so carries attendee name, email
  // and phone. Supabase blanks it on erasure, but blanking sets `payload_erased`,
  // which FREEZES the row from re-export, so the Supabase null never reaches the
  // warehouse. This audit is the only unattended thing that can catch it.
  it("flags a webhook delivery whose last_response still holds the response body", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1"] } }]);
    // The payload was purged correctly, so the OLD check finds nothing. Only a
    // query that looks at last_response can see this residual, which is exactly
    // how the gap read as "clean" while contact data sat in the warehouse.
    vi.mocked(executeStatement).mockImplementation(
      async (_c, sql: string) =>
        ({ data: [[/last_response/i.test(sql) ? "1" : "0"]] }) as never,
    );

    const r = await auditSnowflakeErasures();

    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/webhook_deliveries/);
  });

  it("asks Snowflake about last_response at all", async () => {
    // Pins the query shape rather than only the verdict: without this, the test
    // above could pass on a query that merely happens to mention the column in a
    // comment, and a refactor that dropped the condition would stay green.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([{ details: { booking_ids: ["bk1"] } }]);
    vi.mocked(executeStatement).mockResolvedValue({ data: [["0"]] } as never);

    await auditSnowflakeErasures();

    const asked = vi.mocked(executeStatement).mock.calls.map((c) => String(c[1]));
    const webhookQuery = asked.find((s) => /FROM webhook_deliveries/i.test(s));
    expect(webhookQuery).toBeDefined();
    expect(webhookQuery).toMatch(/last_response\s+IS\s+NOT\s+NULL/i);
  });
});
