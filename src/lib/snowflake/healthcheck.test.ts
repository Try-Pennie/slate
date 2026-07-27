import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", () => ({ executeStatement: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { runSnowflakeHealthcheck } from "./healthcheck";
import { MIRROR_TABLES } from "./export-core";
import { readSnowflakeConfig } from "./config";
import { executeStatement } from "./client";
import { log } from "@/lib/log";

const cfg = {
  account: "vrkfjso-rwc54963",
  user: "SLATE_SERVICE",
  privateKeyPem: "k",
  database: "SLATE",
  schema: "PUBLIC",
  warehouse: "SLATE_WH",
  role: "SLATE_ROLE",
};

// resetAllMocks, not clearAllMocks: these tests queue per-call responses with
// mockResolvedValueOnce, and clearAllMocks leaves an unconsumed once-queue
// behind to be picked up by the next test.
afterEach(() => vi.resetAllMocks());

describe("runSnowflakeHealthcheck", () => {
  it("reports not-configured and does not call Snowflake when the key is unset", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(null);
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(false);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  /** Snowflake returns unquoted identifiers upper-cased. */
  const allStamped = () => ({ data: MIRROR_TABLES.map((t) => [t.table.toUpperCase()]) });

  it("returns ok with the role and warehouse the login resolves to", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped());
    const r = await runSnowflakeHealthcheck();
    expect(r).toMatchObject({ ok: true, configured: true, role: "SLATE_ROLE", warehouse: "SLATE_WH" });
    expect(r.missingLoadStamp).toEqual([]);
    expect(executeStatement).toHaveBeenCalledTimes(2);
  });

  it("matches the load-stamp probe case-insensitively against upper-cased Snowflake names", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped());
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(true);
    // The probe is scoped to the configured schema and the stamp column, bound
    // rather than interpolated.
    const [, statement, bindings] = vi.mocked(executeStatement).mock.calls[1];
    expect(statement).toMatch(/INFORMATION_SCHEMA\.COLUMNS/);
    expect(bindings).toEqual(["PUBLIC", "EXPORTED_AT"]);
  });

  it("is not-ok and names the tables when the live mirror is missing the exported_at stamp", async () => {
    // The MERGE writes exported_at on every branch, so a table without it fails
    // 100% of its exports: the check must say so, not report a healthy login.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce({
        data: MIRROR_TABLES.filter((t) => t.table !== "audit_log").map((t) => [t.table.toUpperCase()]),
      });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(true);
    expect(r.missingLoadStamp).toEqual(["audit_log"]);
    expect(r.error).toMatch(/exported_at/);
    expect(log.error).toHaveBeenCalled();
  });

  it("treats an empty load-stamp probe as a failure, never as healthy", async () => {
    // A read that comes back empty on error must not read as "all fine".
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce({ data: [] });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.missingLoadStamp).toEqual(MIRROR_TABLES.map((t) => t.table));
  });

  it("fails loud when the load-stamp probe itself errors", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockRejectedValueOnce(new Error("Object 'INFORMATION_SCHEMA.COLUMNS' does not exist"));
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/INFORMATION_SCHEMA/);
    expect(log.error).toHaveBeenCalled();
  });

  it("fails loud (returns not-ok + logs) instead of throwing when the login errors", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement).mockRejectedValue(new Error("JWT token is invalid"));
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(true);
    expect(r.error).toMatch(/JWT token is invalid/);
    expect(log.error).toHaveBeenCalled();
  });
});
