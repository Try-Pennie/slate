import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", () => ({
  executeStatement: vi.fn(),
  escapeSqlLiteral: (s: string) => s.replace(/'/g, "''"),
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: vi.fn(() => ({ from: vi.fn() })) }));
vi.mock("@/lib/supabase/paginate", () => ({ selectAllPages: vi.fn(async () => []) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));

import { probeErasurePurgeSql, purgeSnowflakeErasure } from "./purge";
import { PROBE_SENTINEL_ID } from "./purge-sql";
import { readSnowflakeConfig } from "./config";
import { executeStatement } from "./client";
import { selectAllPages } from "@/lib/supabase/paginate";
import { recordAudit } from "@/lib/audit";

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

/** A Snowflake DML answer: one row, one cell, the rows-affected count. */
const updated = (n: number) => ({ data: [[String(n)]] });
/** The verify statement's answer: one row of four residual counts. */
const residuals = (...counts: number[]) => ({ data: [counts.map(String)] });

const sqlOf = (call: unknown[]) => String(call[1]);

describe("probeErasurePurgeSql", () => {
  it("passes when every statement compiles and touches no rows", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(0),
    );

    const r = await probeErasurePurgeSql(cfg);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.statements).toHaveLength(5);
  });

  it("probes the REAL runbook SQL, bound to an id that cannot match a row", async () => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(0),
    );

    await probeErasurePurgeSql(cfg);
    const sent = vi.mocked(executeStatement).mock.calls.map(sqlOf);
    expect(sent).toHaveLength(5);
    for (const sql of sent) expect(sql).toContain(PROBE_SENTINEL_ID);
    // The #1205 / #1201 shape specifically: this is the statement that was wrong,
    // so a stub that merely resembles it would defeat the whole probe.
    expect(sent.some((s) => s.includes("object_construct('booking_id', payload:booking_id)"))).toBe(true);
    expect(sent.some((s) => s.includes("last_response = null"))).toBe(true);
  });

  it("fails loud when a statement no longer compiles (the #1197 shape)", async () => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      if (sql.includes("webhook_deliveries") && !sql.startsWith("select")) {
        throw new Error(
          "Snowflake 400: {\"code\":\"000904\",\"message\":\"SQL compilation error: invalid identifier 'PAYLOAD_ERASED'\"}",
        );
      }
      return sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(0);
    });

    const r = await probeErasurePurgeSql(cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/webhook_deliveries/);
    // The reason must name WHICH identifier, which is the whole diagnosis. It
    // reaches Slack through shortFailureReason's Snowflake branch, so this also
    // pins that a raw JSON body never gets there.
    expect(r.reasons.join(" ")).toContain("invalid identifier 'PAYLOAD_ERASED'");
    expect(r.reasons.join(" ")).not.toContain("{");
  });

  it("keeps checking the other statements after one fails, so one page lists them all", async () => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      if (!sql.startsWith("select")) throw new Error("Snowflake 400: nope");
      return residuals(0, 0, 0, 0);
    });

    const r = await probeErasurePurgeSql(cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(4);
    expect(vi.mocked(executeStatement).mock.calls).toHaveLength(5);
  });

  it("fails when the sentinel somehow matched rows", async () => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(1),
    );

    const r = await probeErasurePurgeSql(cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/changed 1 row/);
  });

  it("fails rather than passes when the row count cannot be read", async () => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : { data: [["not-a-number"]] },
    );

    const r = await probeErasurePurgeSql(cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/could not read/i);
  });

  it("fails when the verify statement returns no readable row", async () => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? { data: [] } : updated(0),
    );

    const r = await probeErasurePurgeSql(cfg);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/verify/i);
  });
});

describe("purgeSnowflakeErasure", () => {
  const auditRows = (ids: string[]) => [{ org_id: "org-1", details: { booking_ids: ids } }];

  it("skips (and writes no audit row) when the mirror is not configured", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await purgeSnowflakeErasure();
    expect(r.skipped).toBe(true);
    expect(executeStatement).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("purges every booking id recorded in the erasure audit trail", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1", "b2"]));
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(2),
    );

    const r = await purgeSnowflakeErasure();
    expect(r.skipped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.bookingIds).toEqual(["b1", "b2"]);
    expect(r.rowsByTable).toEqual({
      bookings: 2,
      booking_events: 2,
      webhook_deliveries: 2,
      booking_outbox: 2,
    });
    for (const sql of vi.mocked(executeStatement).mock.calls.map(sqlOf)) {
      expect(sql).toContain("'b1','b2'");
    }
  });

  it("refuses a booking id that no erasure has been recorded for", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1"]));

    await expect(purgeSnowflakeErasure(["b1", "not-erased"])).rejects.toThrow(/not-erased|not been erased/);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("purges only the requested subset when it is all within the audit trail", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1", "b2"]));
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(1),
    );

    const r = await purgeSnowflakeErasure(["b2"]);
    expect(r.bookingIds).toEqual(["b2"]);
    for (const sql of vi.mocked(executeStatement).mock.calls.map(sqlOf)) {
      expect(sql).toContain("'b2'");
      expect(sql).not.toContain("'b1'");
    }
  });

  it("does nothing, and claims nothing, when no erasure has ever been recorded", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue([]);

    const r = await purgeSnowflakeErasure();
    expect(r.ok).toBe(true);
    expect(r.bookingIds).toEqual([]);
    expect(executeStatement).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("propagates an audit-trail read failure instead of purging nothing and reporting success", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockRejectedValue(new Error("erasure-audit ids read failed: boom"));

    await expect(purgeSnowflakeErasure()).rejects.toThrow(/read failed/);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it("reports NOT ok when the warehouse still holds residual PII afterwards", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1"]));
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 3, 0) : updated(0),
    );

    const r = await purgeSnowflakeErasure();
    expect(r.ok).toBe(false);
    expect(r.residualAfter).toEqual({
      bookings: 0,
      booking_events: 0,
      webhook_deliveries: 3,
      booking_outbox: 0,
    });
    expect(r.reasons.join(" ")).toMatch(/webhook_deliveries/);
  });

  it("treats an unreadable verify result as a failure, never as all-clear", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1"]));
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? { data: [] } : updated(1),
    );

    const r = await purgeSnowflakeErasure();
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/could not read|verify/i);
  });

  it("records what it changed in the audit trail", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1"]));
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) =>
      sql.startsWith("select") ? residuals(0, 0, 0, 0) : updated(3),
    );

    await purgeSnowflakeErasure(undefined, "actor-1");
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(recordAudit).mock.calls[0][0];
    expect(entry.action).toBe("pii.warehouse_purge");
    expect(entry.orgId).toBe("org-1");
    expect(entry.actorId).toBe("actor-1");
    expect(entry.details?.booking_ids).toEqual(["b1"]);
    expect(entry.details?.rows_by_table).toEqual({
      bookings: 3,
      booking_events: 3,
      webhook_deliveries: 3,
      booking_outbox: 3,
    });
  });

  it("lets a failing purge statement throw rather than reporting a clean run", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(selectAllPages).mockResolvedValue(auditRows(["b1"]));
    vi.mocked(executeStatement).mockRejectedValue(new Error("Snowflake 400: invalid identifier"));

    await expect(purgeSnowflakeErasure()).rejects.toThrow(/invalid identifier/);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
