import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ row: { id: "bk-oldest", updated_at: "2026-06-01T00:00:00Z" } as { id: string; updated_at: string } | null }));
const chain: Record<string, unknown> = {};
chain.select = () => chain;
chain.is = () => chain;
chain.eq = () => chain;
chain.order = () => chain;
chain.limit = () => chain;
chain.maybeSingle = () => Promise.resolve({ data: probe.row, error: null });
// #1144: the repair probe runs the REAL reexport path, which filters by id list and
// awaits the builder itself rather than a terminal method. Missing columns format to
// NULL, so the probe row is enough to build a genuine MERGE statement.
chain.in = () => chain;
chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
  resolve({ data: probe.row ? [probe.row] : [], error: null });
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: () => chain }) }));
vi.mock("./config", () => ({ readSnowflakeConfig: vi.fn() }));
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  executeStatement: vi.fn(),
}));
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
// `probe.row` is restored here too: a test that blanks it used to hand-restore it
// on its last line, which silently leaks into every following test the moment one
// is inserted between them or an assertion throws first.
const PROBE_ROW = { id: "bk-oldest", updated_at: "2026-06-01T00:00:00Z" };
afterEach(() => {
  vi.resetAllMocks();
  probe.row = { ...PROBE_ROW };
});

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
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] })
      .mockResolvedValueOnce({ data: [] });
    const r = await runSnowflakeHealthcheck();
    expect(r).toMatchObject({ ok: true, configured: true, role: "SLATE_ROLE", warehouse: "SLATE_WH" });
    expect(r.missingLoadStamp).toEqual([]);
    // Four live statements now: login, load-stamp probe, verification question, and
    // the #1144 repair MERGE.
    expect(executeStatement).toHaveBeenCalledTimes(4);
  });

  it("matches the load-stamp probe case-insensitively against upper-cased Snowflake names", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] });
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
      })
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] });
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
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.missingLoadStamp).toEqual(MIRROR_TABLES.map((t) => t.table));
  });

  // #1102: the live self-test. Every unit test of the archive-verification question
  // uses a stand-in for the warehouse, so this endpoint is the only thing that can
  // confirm the live warehouse parses the timestamp we hand it and reports the
  // booleans in the shape we read. Without it, a wrong assumption there would first
  // show up as a nightly retention failure.
  it("runs the real verification question against a known-archived row and reports success", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(true);
    expect(r.verifyProbe?.ok).toBe(true);
    // It really asked the verification question, about the oldest booking.
    const [, statement] = vi.mocked(executeStatement).mock.calls[2];
    expect(statement).toContain("TO_TIMESTAMP_TZ(s.wm)");
    expect(statement).toContain("bk-oldest");
  });

  // #1144: the repair MERGE is the statement the retention lanes lean on to make an
  // unconfirmed row verifiable. It runs for real here, against the row the verify
  // probe just CONFIRMED is archived, so the MERGE takes its MATCHED branch and
  // rewrites identical values. That ordering is the safety property: the statement
  // ends `WHEN NOT MATCHED THEN INSERT`, so probing it with a row the warehouse
  // lacks would plant a row the append-only export role could never remove.
  it("runs the real repair MERGE against the confirmed row and reports success", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] })
      .mockResolvedValueOnce({ data: [] });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(true);
    expect(r.repairProbe?.ok).toBe(true);
    // It really ran the MERGE, for that row, with both branches present.
    const [, statement] = vi.mocked(executeStatement).mock.calls[3];
    expect(statement).toContain("MERGE INTO bookings");
    expect(statement).toContain("bk-oldest");
    expect(statement).toContain("WHEN MATCHED THEN UPDATE SET");
  });

  it("is not-ok when the repair MERGE the retention lanes depend on is rejected", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "true", "true"]] })
      .mockRejectedValueOnce(new Error("SQL compilation error: invalid identifier 'CURRENT'"));
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.repairProbe?.ok).toBe(false);
    expect(r.repairProbe?.detail).toMatch(/compilation/);
    expect(r.error).toMatch(/repair/i);
  });

  // Never probe the repair path with a row the warehouse does not hold: that hits
  // the INSERT branch and plants an unremovable row in the compliance mirror.
  it("does NOT run the repair MERGE when the verify probe could not confirm the row", async () => {
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "false", "false"]] });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.repairProbe).toBeUndefined();
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(3);
  });

  it("does NOT run the repair MERGE when there is no booking to probe with", async () => {
    probe.row = null;
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped());
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(true);
    expect(r.repairProbe).toBeUndefined();
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(2);
  });

  it("is not-ok when the warehouse says it does not hold a row that is long past export", async () => {
    // Impossible for a healthy mirror, so it means the question or the mirror is
    // broken. Retention would refuse to destroy anything, so say so here.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockResolvedValueOnce({ data: [["bk-oldest", "false", "false"]] });
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.verifyProbe?.ok).toBe(false);
    expect(r.verifyProbe?.detail).toMatch(/absent/);
    expect(r.error).toMatch(/refuse to destroy anything/);
  });

  it("is not-ok when the warehouse rejects the verification question outright", async () => {
    // The real risk this catches: a wrong function name or timestamp handling.
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped())
      .mockRejectedValueOnce(new Error("SQL compilation error: invalid identifier 'TO_TIMESTAMP_TZ'"));
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(false);
    expect(r.verifyProbe?.detail).toMatch(/TO_TIMESTAMP_TZ/);
  });

  it("passes the probe when there are no bookings to check against", async () => {
    // An empty database is not a broken warehouse.
    probe.row = null;
    vi.mocked(readSnowflakeConfig).mockReturnValue(cfg);
    vi.mocked(executeStatement)
      .mockResolvedValueOnce({ data: [["SLATE_ROLE", "SLATE_WH"]] })
      .mockResolvedValueOnce(allStamped());
    const r = await runSnowflakeHealthcheck();
    expect(r.ok).toBe(true);
    expect(r.verifyProbe).toEqual({ ok: true, detail: "no bookings yet, nothing to probe" });
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
