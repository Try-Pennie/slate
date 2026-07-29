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
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/snowflake/erasure-audit", () => audit);
vi.mock("@/lib/notify/dispatch", () => notify);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  audit.auditSnowflakeErasures.mockResolvedValue({ ok: true, erasedBookings: 0, residuals: [], reasons: [] });
});

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
    audit.auditSnowflakeErasures.mockResolvedValue({
      ok: false,
      erasedBookings: 2,
      residuals: [{ table: "bookings", residual: 1 }],
      reasons: ["bookings: 1 erased booking row(s) still hold contact PII in Snowflake"],
    });
    const res = await GET(req());
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
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
    audit.auditSnowflakeErasures.mockResolvedValue({
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
    expect(notify.resolveAlert).toHaveBeenCalledTimes(1);
    expect(notify.resolveAlert.mock.calls[0][0]).toBe("snowflake_erasure_residual");
  });

  // The silent paths (#1152). A skipped run measured nothing and a thrown run
  // knows nothing, so neither may claim the compliance request is now honored.
  it("sends NO all-clear when the mirror is unconfigured (nothing was measured)", async () => {
    audit.auditSnowflakeErasures.mockResolvedValueOnce({ skipped: true, reasons: [] });
    await GET(req());
    expect(notify.resolveAlert).not.toHaveBeenCalled();
  });

  it("sends NO all-clear when the audit throws", async () => {
    audit.auditSnowflakeErasures.mockRejectedValueOnce(new Error("snowflake unreachable"));
    await GET(req());
    expect(notify.resolveAlert).not.toHaveBeenCalled();
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
      audit.auditSnowflakeErasures.mockResolvedValue({
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
      audit.auditSnowflakeErasures.mockResolvedValue({
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
