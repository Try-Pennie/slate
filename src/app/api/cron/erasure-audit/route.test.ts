import { describe, it, expect, vi, beforeEach } from "vitest";

// #1103 Workstream C: the erasure-audit cron reads the pii.erasure audit trail and
// alerts loudly if Snowflake still holds contact PII for an erased booking (the
// operator's manual warehouse purge did not happen, or was missed). This covers
// the route glue: auth + lock guards, the alert on residual, no alert when clean,
// fail-loud, lock release.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
const audit = vi.hoisted(() => ({ auditSnowflakeErasures: vi.fn() }));
const notify = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  sendThrottledInfo: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));
const purge = vi.hoisted(() => ({ runErasurePurgeSqlProbe: vi.fn() }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/erasure-audit", () => audit);
vi.mock("@/lib/snowflake/purge", () => purge);
vi.mock("@/lib/notify/dispatch", () => notify);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

/**
 * The fields every audit outcome carries, so the fakes below only state what the
 * case under test is actually about (#1196 added four of them at once).
 *
 * Spread FIRST in each fake, so a case can still override any of them.
 */
const AUDIT_DEFAULTS = {
  ok: true,
  erasedBookings: 0,
  residuals: [],
  reasons: [],
  realBookingIds: [],
  testResiduals: [],
  testReasons: [],
  testBookingIds: [],
  classificationUnreadable: null,
};


const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS, ok: true, erasedBookings: 0, residuals: [], reasons: [] });
  purge.runErasurePurgeSqlProbe.mockResolvedValue({ ok: true, statements: [], reasons: [] });
});

/** Keys the run sent an alert on / cleared, so an assertion names the condition it
 *  means rather than counting calls (there are two independent conditions here). */
const alertedKeys = () => notify.sendThrottledAlert.mock.calls.map((c) => c[0]);
const clearedKeys = () => notify.resolveAlert.mock.calls.map((c) => c[0]);

describe("GET /api/cron/erasure-audit", () => {
  it("401s and touches nothing when unauthorized", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
  });

  it("skips when the lock is not acquired", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(await res.json()).toEqual({ skipped: "overlapping-run" });
    expect(audit.auditSnowflakeErasures).not.toHaveBeenCalled();
  });

  it("alerts loudly when Snowflake still holds PII for an erased booking", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS,
      ok: false,
      erasedBookings: 2,
      residuals: [{ table: "bookings", residual: 1 }],
      reasons: ["bookings: 1 erased booking row(s) still hold contact PII in Snowflake"],
    });
    const res = await GET(req());
    expect(alertedKeys()).toEqual(["snowflake_erasure_residual"]);
    const [key, , text] = notify.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("snowflake_erasure_residual");
    expect(String(text)).toMatch(/bookings/);
    expect(res.status).toBe(200);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_erasure_audit", "lease");
  });

  it("does NOT alert when the audit is clean", async () => {
    const res = await GET(req());
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("does NOT alert when the mirror is unconfigured (skipped)", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS,
      skipped: true,
      ok: true,
      erasedBookings: 0,
      residuals: [],
      reasons: [],
    });
    await GET(req());
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #1151: an incomplete erasure is a CONDITION that ends when the operator runs
  // the purge, and this audit is the only thing that ever observes it ending.
  it("announces recovery once the audit measures the erasure as complete", async () => {
    await GET(req());
    expect(clearedKeys()).toContain("snowflake_erasure_residual");
  });

  // The silent paths (#1152). A skipped run measured nothing and a thrown run
  // knows nothing, so neither may claim the compliance request is now honored.
  it("sends NO all-clear when the mirror is unconfigured (nothing was measured)", async () => {
    audit.auditSnowflakeErasures.mockResolvedValueOnce({ ...AUDIT_DEFAULTS, skipped: true, reasons: [] });
    await GET(req());
    expect(clearedKeys()).not.toContain("snowflake_erasure_residual");
  });

  it("sends NO all-clear when the audit throws", async () => {
    audit.auditSnowflakeErasures.mockRejectedValueOnce(new Error("snowflake unreachable"));
    await GET(req());
    expect(notify.resolveAlert).not.toHaveBeenCalled();
  });

  // #1128: the same lane also PROVES the purge SQL still runs, on a separate key.
  // The two conditions are independent: the warehouse still holding data is a
  // different fact from the statements meant to clear it having stopped compiling,
  // and letting either clear the other's page is how a check silently stops being
  // able to report (L53).
  describe("purge SQL probe", () => {
    const broken = {
      ok: false,
      statements: [{ label: "webhook_deliveries", ok: false, rows: null }],
      reasons: ["webhook_deliveries: the statement no longer runs (400 invalid identifier 'PAYLOAD_ERASED')"],
    };

    it("alerts on its own key when a statement no longer runs", async () => {
      purge.runErasurePurgeSqlProbe.mockResolvedValue(broken);
      const res = await GET(req());
      expect(alertedKeys()).toEqual(["snowflake_purge_sql_broken"]);
      const text = String(notify.sendThrottledAlert.mock.calls[0][2]);
      expect(text).toMatch(/webhook_deliveries/);
      expect(res.status).toBe(200);
    });

    it("clears its own key once every statement compiles again", async () => {
      await GET(req());
      expect(clearedKeys()).toContain("snowflake_purge_sql_broken");
    });

    it("sends NO all-clear when the mirror is unconfigured (nothing was probed)", async () => {
      purge.runErasurePurgeSqlProbe.mockResolvedValue({ skipped: true, ok: true, statements: [], reasons: [] });
      await GET(req());
      expect(clearedKeys()).not.toContain("snowflake_purge_sql_broken");
      expect(alertedKeys()).not.toContain("snowflake_purge_sql_broken");
    });

    it("a clean residual audit does NOT clear a broken-SQL page", async () => {
      purge.runErasurePurgeSqlProbe.mockResolvedValue(broken);
      await GET(req());
      expect(clearedKeys()).toContain("snowflake_erasure_residual");
      expect(clearedKeys()).not.toContain("snowflake_purge_sql_broken");
    });

    it("a passing probe does NOT clear a residual page", async () => {
      audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS,
        ok: false,
        erasedBookings: 1,
        residuals: [{ table: "webhook_deliveries", residual: 3 }],
        reasons: ["webhook_deliveries: 3 erased booking row(s) still hold contact PII in Snowflake"],
      });
      await GET(req());
      expect(clearedKeys()).toContain("snowflake_purge_sql_broken");
      expect(clearedKeys()).not.toContain("snowflake_erasure_residual");
      expect(alertedKeys()).toContain("snowflake_erasure_residual");
    });

    it("reports the probe result in the response so a run can be read back", async () => {
      const res = await GET(req());
      expect((await res.json()).purgeSql).toMatchObject({ ok: true });
    });

    it("500s when the probe itself throws (fail loud)", async () => {
      purge.runErasurePurgeSqlProbe.mockRejectedValue(new Error("snowflake unreachable"));
      const res = await GET(req());
      expect(res.status).toBe(500);
      expect(locks.releaseLock).toHaveBeenCalledWith("cron_erasure_audit", "lease");
    });
  });

  it("500s and releases the lock when the audit throws (fail loud)", async () => {
    audit.auditSnowflakeErasures.mockRejectedValue(new Error("snowflake down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(locks.releaseLock).toHaveBeenCalledWith("cron_erasure_audit", "lease");
  });

  // #1123: this lane is a safety net, and a safety net that fails every run in
  // silence is worse than none. It stamps its OWN heartbeat so the lane-watchdog
  // pages when the stamp goes stale. It used to be documented as relying on the
  // co-scheduled snowflake-reconcile lane's heartbeat, which (a) was itself watched
  // by no bound, and (b) could not have worked anyway: reconcile succeeding keeps
  // its own stamp fresh while this lane fails.
  describe("heartbeat", () => {
    it("stamps its own lane on a clean pass", async () => {
      await GET(req());
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("erasure-audit");
    });

    it("stamps even when the mirror is unconfigured (the lane still ran)", async () => {
      audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS,
        skipped: true,
        ok: true,
        erasedBookings: 0,
        residuals: [],
        reasons: [],
      });
      await GET(req());
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("erasure-audit");
    });

    it("stamps after alerting on a residual (the lane did its job)", async () => {
      audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS,
        ok: false,
        erasedBookings: 1,
        residuals: [{ table: "bookings", residual: 1 }],
        reasons: ["bookings: 1 erased booking row(s) still hold contact PII in Snowflake"],
      });
      await GET(req());
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("erasure-audit");
    });

    // THE failure path this whole change exists for: a lane erroring every run must
    // NOT stamp, or the dead-man's switch stays green while the audit never runs.
    it("does NOT stamp when the audit throws, so the watchdog can see it", async () => {
      audit.auditSnowflakeErasures.mockRejectedValue(new Error("snowflake down"));
      const res = await GET(req());
      expect(res.status).toBe(500);
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
    });

    it("does NOT stamp when the lock is held by another run", async () => {
      locks.acquireLock.mockResolvedValueOnce(null);
      await GET(req());
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
    });

    it("still returns 200 when the heartbeat stamp itself fails", async () => {
      heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
      const res = await GET(req());
      expect(res.status).toBe(200);
    });
  });
});

/**
 * Which CHANNEL each class of residual reaches (#1196).
 *
 * The audit's own tests prove the partition. These prove the lane acts on it,
 * which is a separate failure: a correct split routed to one channel would page
 * for synthetic data exactly as before, and every test of the split would pass.
 */
describe("GET /api/cron/erasure-audit test/real routing", () => {
  it("whispers on its own key for a test residual and pages nobody", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({
      ...AUDIT_DEFAULTS,
      ok: true,
      erasedBookings: 1,
      testResiduals: [{ table: "booking_outbox", residual: 1 }],
      testReasons: ["booking_outbox: 1 erased booking row(s) still hold contact PII in Snowflake"],
      testBookingIds: ["bk-smoke"],
    });

    await GET(new Request("http://x/api/cron/erasure-audit") as never);

    expect(notify.sendThrottledInfo.mock.calls.map((c) => c[0])).toEqual([
      "snowflake_erasure_residual_test",
    ]);
    expect(notify.sendThrottledAlert.mock.calls.map((c) => c[0])).not.toContain(
      "snowflake_erasure_residual",
    );
  });

  it("names the test bookings in the whisper", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({
      ...AUDIT_DEFAULTS,
      erasedBookings: 1,
      testReasons: ["booking_outbox: 1 erased booking row(s) still hold contact PII in Snowflake"],
      testBookingIds: ["bk-smoke"],
    });

    await GET(new Request("http://x/api/cron/erasure-audit") as never);

    const text = notify.sendThrottledInfo.mock.calls[0]?.[2] ?? "";
    expect(text).toContain("bk-smoke");
    expect(text).toContain("/admin/erasure");
  });

  it("pages AND whispers when both classes have a residual", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({
      ...AUDIT_DEFAULTS,
      ok: false,
      erasedBookings: 2,
      reasons: ["bookings: 1 erased booking row(s) still hold contact PII in Snowflake"],
      realBookingIds: ["bk-real"],
      testReasons: ["booking_outbox: 1 erased booking row(s) still hold contact PII in Snowflake"],
      testBookingIds: ["bk-smoke"],
    });

    await GET(new Request("http://x/api/cron/erasure-audit") as never);

    expect(notify.sendThrottledAlert.mock.calls.map((c) => c[0])).toContain(
      "snowflake_erasure_residual",
    );
    expect(notify.sendThrottledInfo.mock.calls.map((c) => c[0])).toContain(
      "snowflake_erasure_residual_test",
    );
  });

  it("says the class was a fallback when it could not be read", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({
      ...AUDIT_DEFAULTS,
      ok: false,
      erasedBookings: 1,
      reasons: ["bookings: 1 erased booking row(s) still hold contact PII in Snowflake"],
      realBookingIds: ["bk-1"],
      classificationUnreadable: "the bookings read failed, so no id could be classified",
    });

    await GET(new Request("http://x/api/cron/erasure-audit") as never);

    const text = notify.sendThrottledAlert.mock.calls.find(
      (c) => c[0] === "snowflake_erasure_residual",
    )?.[2] ?? "";
    expect(text).toMatch(/could not be read/);
    expect(text).toMatch(/treated as real/);
  });

  // A skipped run measured nothing, so it must not whisper either. The same rule
  // the real page already follows (#1134/#1152): a signal must hang off a measured
  // result, never off "this run did not object".
  it("whispers nothing on a skipped run", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({
      ...AUDIT_DEFAULTS,
      skipped: true,
      testReasons: ["booking_outbox: 1 erased booking row(s) still hold contact PII in Snowflake"],
      testBookingIds: ["bk-smoke"],
    });

    await GET(new Request("http://x/api/cron/erasure-audit") as never);

    expect(notify.sendThrottledInfo).not.toHaveBeenCalled();
  });

  // The info key must never resolve: it is classified `info` in the catalog, and an
  // all-clear there would declare the end of an incident that never existed.
  it("never resolves the test key", async () => {
    audit.auditSnowflakeErasures.mockResolvedValue({ ...AUDIT_DEFAULTS, erasedBookings: 1 });

    await GET(new Request("http://x/api/cron/erasure-audit") as never);

    expect(notify.resolveAlert.mock.calls.map((c) => c[0])).not.toContain(
      "snowflake_erasure_residual_test",
    );
  });
});
