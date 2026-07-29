import { describe, it, expect, vi, beforeEach } from "vitest";

// #1144: the warehouse self-check used to run ONLY when an admin opened
// /api/admin/snowflake-check. That is how #1143 shipped: a SQL compilation error in
// a live warehouse statement that every one of 1,100+ unit tests passed over,
// because they all answer with a stand-in rather than parsing the statement. It was
// caught because a human happened to click the page.
//
// So the 6-hourly reconcile lane now runs it, alerts when it is not ok, and stamps
// its OWN heartbeat only on a healthy probe. Both directions of #1123: the alert
// covers "the probe failed", and the heartbeat covers "the probe has not SUCCEEDED
// in 8h", which still fires when the alerting path itself is what is broken.

const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const reconcile = vi.hoisted(() => ({
  reconcileSnowflakeMirror: vi.fn(async () => ({ skipped: false, ok: true, reasons: [] as string[] })),
}));
const healthcheck = vi.hoisted(() => ({
  runSnowflakeHealthcheck: vi.fn(async () => ({ ok: true, configured: true })),
}));
// Parameters are declared so `.mock.calls[n][i]` stays typed: a zero-arg vi.fn
// infers an empty tuple, and every call-argument assertion below then fails tsc.
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => false),
}));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async (_lane: string) => {}) }));
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/reconcile", () => reconcile);
vi.mock("@/lib/snowflake/healthcheck", () => healthcheck);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/log", () => ({ log }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];
const stamped = () => heartbeat.recordHeartbeat.mock.calls.map((c) => c[0]);
const alertKeys = () => dispatch.sendThrottledAlert.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  cron.isAuthorizedCron.mockReturnValue(true);
  reconcile.reconcileSnowflakeMirror.mockResolvedValue({ skipped: false, ok: true, reasons: [] });
  healthcheck.runSnowflakeHealthcheck.mockResolvedValue({ ok: true, configured: true });
});

describe("GET /api/cron/snowflake-reconcile", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    cron.isAuthorizedCron.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(healthcheck.runSnowflakeHealthcheck).not.toHaveBeenCalled();
  });

  it("runs the warehouse self-check and stamps its heartbeat when healthy", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(healthcheck.runSnowflakeHealthcheck).toHaveBeenCalledTimes(1);
    expect(stamped()).toContain("snowflake-check");
    expect(alertKeys()).not.toContain("snowflake_healthcheck");
  });

  it("alerts and does NOT stamp the heartbeat when the self-check fails", async () => {
    healthcheck.runSnowflakeHealthcheck.mockResolvedValue({
      ok: false,
      configured: true,
      error: "invalid identifier 'CURRENT'",
    } as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(alertKeys()).toContain("snowflake_healthcheck");
    // Withholding the stamp is the point: a probe that keeps failing goes stale and
    // pages even if the alert above never got through.
    expect(stamped()).not.toContain("snowflake-check");
    const text = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "snowflake_healthcheck")?.[2];
    expect(text).toContain("invalid identifier");
    expect(text).toMatch(/retention/i);
  });

  // #1135: Snowflake answers a bad statement with a multi-line SQL compilation
  // error. Pasted straight in, that is the 2026-07-28 page all over again, on the
  // one lane whose whole job is telling us the warehouse cannot be trusted.
  it("keeps a multi-line SQL error readable in the page", async () => {
    healthcheck.runSnowflakeHealthcheck.mockResolvedValue({
      ok: false,
      configured: true,
      error:
        "SQL compilation error:\nsyntax error line 3 at position 8\ninvalid identifier 'CURRENT'\n" +
        "  at Statement.execute (snowflake-sdk/lib/connection.js:412:19)",
    } as never);

    await GET(req());

    const text = dispatch.sendThrottledAlert.mock.calls.find(
      (c) => c[0] === "snowflake_healthcheck",
    )?.[2] as string;
    // The whole page is one line: the reader sees a sentence, not a stack.
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("SQL compilation error");
    // And it still says what the failure MEANS, which is the half a raw dump loses.
    expect(text).toMatch(/retention/i);
  });

  it("stays silent and does not stamp when the mirror is not configured", async () => {
    healthcheck.runSnowflakeHealthcheck.mockResolvedValue({
      ok: false,
      configured: false,
      error: "SNOWFLAKE_PRIVATE_KEY not set",
    } as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(alertKeys()).not.toContain("snowflake_healthcheck");
    // Never stamping means the lane never goes stale in this bounds map, so an
    // environment with no mirror cannot page about one.
    expect(stamped()).not.toContain("snowflake-check");
  });

  // Keyed lookups, not positional: this lane clears TWO conditions (the self-check
  // and mirror drift), and asserting on call [0] would silently start testing
  // whichever happened to run first.
  const recoveryFor = (key: string) =>
    (dispatch.resolveAlert.mock.calls as [string, string][]).find(([k]) => k === key);

  it("says so when the self-check recovers", async () => {
    await GET(req());
    const call = recoveryFor("snowflake_healthcheck");
    expect(call).toBeTruthy();
    expect(call![1]).toMatch(/recover|cleared|working again/i);
  });

  it("does not offer a self-check recovery notice while the self-check is still failing", async () => {
    healthcheck.runSnowflakeHealthcheck.mockResolvedValue({ ok: false, configured: true, error: "x" } as never);
    await GET(req());
    expect(recoveryFor("snowflake_healthcheck")).toBeUndefined();
  });

  // #1151: drift is its own condition with its own all-clear, and the two must not
  // stand in for each other.
  it("says so when the mirror drift clears", async () => {
    await GET(req());
    const call = recoveryFor("snowflake_reconcile_drift");
    expect(call).toBeTruthy();
    expect(call![1]).toMatch(/matches the live database again/i);
  });

  it("sends NO drift all-clear while the mirror is still out of sync", async () => {
    reconcile.reconcileSnowflakeMirror.mockResolvedValue({
      ok: false,
      skipped: false,
      reasons: ["bookings: 10 vs 4"],
    } as never);
    await GET(req());
    expect(recoveryFor("snowflake_reconcile_drift")).toBeUndefined();
  });

  // The silent path (#1152): a SKIPPED run measured nothing, so it must not claim
  // the mirror agrees with the source.
  it("sends NO drift all-clear when the mirror is unconfigured (nothing measured)", async () => {
    reconcile.reconcileSnowflakeMirror.mockResolvedValue({ ok: true, skipped: true, reasons: [] } as never);
    await GET(req());
    expect(recoveryFor("snowflake_reconcile_drift")).toBeUndefined();
  });

  // Failure path: the self-check is monitoring, so it must not take the lane down
  // and cost us the reconciliation that ran before it.
  it("still returns 200 and keeps the reconcile result when the self-check throws", async () => {
    healthcheck.runSnowflakeHealthcheck.mockRejectedValue(new Error("network down") as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(log.error).toHaveBeenCalled();
    expect(stamped()).toContain("snowflake-reconcile");
    // #1152: a self-check that threw knows nothing about the warehouse, so it must
    // not tell anyone the earlier warning is cleared and retention is unblocked.
    // Scoped to ITS key: the drift check ran and measured the mirror in sync, and
    // that verdict is its own (L43, two checks never share one status).
    expect(recoveryFor("snowflake_healthcheck")).toBeUndefined();
  });

  // The strongest silent path (#1152): the reconciliation itself threw, so NEITHER
  // condition was measured this run and the lane must announce nothing at all.
  it("sends NO all-clear of any kind when the reconciliation itself throws", async () => {
    reconcile.reconcileSnowflakeMirror.mockRejectedValue(new Error("warehouse unreachable") as never);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("still alerts on mirror drift, and stamps the lane heartbeat", async () => {
    reconcile.reconcileSnowflakeMirror.mockResolvedValue({
      skipped: false,
      ok: false,
      reasons: ["bookings: supabase 10, snowflake 4"],
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(alertKeys()).toContain("snowflake_reconcile_drift");
    expect(stamped()).toContain("snowflake-reconcile");
  });

  it("skips without touching the warehouse when another run holds the lock", async () => {
    locks.acquireLock.mockResolvedValue(null as never);
    const res = await GET(req());
    expect(await res.json()).toEqual({ skipped: "overlapping-run" });
    expect(healthcheck.runSnowflakeHealthcheck).not.toHaveBeenCalled();
  });
});
