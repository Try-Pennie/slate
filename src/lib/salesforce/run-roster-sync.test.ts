import { describe, it, expect, vi, beforeEach } from "vitest";

// #2071: the whole hourly roster job as one locked call, shared by the cron route
// and the admin "Sync from Salesforce" button. The route's own suite drives the
// alert and streak decisions through this; what is pinned HERE is the part only
// the sharing added: the lock is taken and released whatever happens, an
// overlapping run is reported rather than run twice, and a manual run does the
// same follow up work the hour does (default hours, the empty bucket check).
const locks = vi.hoisted(() => {
  const l = {
    acquireLock: vi.fn(async (): Promise<string | null> => "lease"),
    releaseLock: vi.fn(async () => {}),
    // #3177: a lease that stays held. Losing it is driven in run-roster-sync-lease.test.ts.
    makeLockLease: vi.fn((key: string, claim: string) => ({
      key,
      token: () => claim,
      stillHeld: async () => true,
      stopReason: (): "taken" | "refused" | null => null,
    })),
  };
  // #3177: the run takes its lock as a lease. Built from the two above, so a case
  // can refuse the claim or hand back a lease that is lost.
  const acquireLease = vi.fn(async (key: string) => {
    const claim = await l.acquireLock();
    return claim === null ? null : l.makeLockLease(key, claim);
  });
  return { ...l, acquireLease };
});
const sync = vi.hoisted(() => ({
  syncSalesforceAgents: vi.fn(),
  AGENTS_SYNC_STREAK_KEY: "cron_agents_failures",
}));
const provision = vi.hoisted(() => ({ ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })) }));
const schedule = vi.hoisted(() => ({ ensureDefaultSchedules: vi.fn(async () => 2) }));
const availability = vi.hoisted(() => ({
  alertOnEmptyBuckets: vi.fn(async () => ({ empty: ["411"], aggregated: false })),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => false),
}));
const streak = vi.hoisted(() => ({
  clearFailureStreak: vi.fn(async () => {}),
  // #2774: the Twilio read streak. False, so one failed read stays quiet.
  recordConsecutiveStreak: vi.fn(async () => false),
}));

// #2459: the departed session convergence that follows the reap.
const sessions = vi.hoisted(() => ({
  convergeDepartedSessions: vi.fn(),
  reportSessionConvergence: vi.fn(async () => {}),
}));

vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/offboarding/session-convergence", () => sessions);
vi.mock("@/lib/offboarding/session-convergence-alert", () => ({
  reportSessionConvergence: sessions.reportSessionConvergence,
  SESSION_CONVERGENCE_ALERT_KEY: "departed_sessions_unconverged",
  SESSION_CONVERGENCE_STREAK_WINDOW_S: 10800,
  SESSION_CONVERGENCE_STREAK_ALERT_AT: 2,
}));
vi.mock("@/lib/salesforce/sync", () => sync);
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/schedule", () => schedule);
vi.mock("@/lib/availability/service", () => availability);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/streak", () => streak);

import { runRosterSync, AGENTS_LOCK_KEY } from "./run-roster-sync";

const cleanSync = () => ({
  inserted: 0,
  updated: 0,
  deactivated: 0,
  createdUntiered: 0,
  bookableFlipped: [],
  bookablePending: [],
  managersCreated: 0,
  managersLinked: 0,
  managersUnlinked: 0,
  managersUnresolved: 0,
  managersAmbiguous: 0,
  managerNamesAmbiguous: 0,
  managersPromoted: 0,
  salesforceIdsLinked: 0,
  salesforceIdDisagreements: 0,
  salesforceIdAmbiguous: 0,
  salesforceIdClaimed: 0,
  salesforceIdsUnresolved: 0,
  rosterRowsReconciled: 0,
  rosterUnconfirmedInactive: 0,
  rosterUnconfirmedUnmatched: 0,
  rosterUnconfirmedAbsent: 0,
  rosterUnconfirmedBookable: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  locks.acquireLock.mockResolvedValue("lease");
  sync.syncSalesforceAgents.mockResolvedValue(cleanSync());
  sessions.convergeDepartedSessions.mockResolvedValue(convergedClean);
});

const convergedClean = {
  departed: 3,
  alreadyRevoked: 2,
  revoked: 1,
  revokeFailed: 0,
  restored: 0,
  restoreFailed: 0,
  foreignBans: 0,
  deferred: 0,
  unlisted: 0,
  listingComplete: true,
};

describe("runRosterSync (#2071)", () => {
  it("does the whole hour's work: roster, default hours, empty bucket check, streak clear", async () => {
    const out = await runRosterSync();
    expect(out.skipped).toBeUndefined();
    if (out.skipped) return;
    expect(sync.syncSalesforceAgents).toHaveBeenCalledTimes(1);
    expect(schedule.ensureDefaultSchedules).toHaveBeenCalledWith("org1");
    expect(streak.clearFailureStreak).toHaveBeenCalledWith("cron_agents_failures");
    expect(out.hoursApplied).toBe(2);
  });

  it("reports an overlapping run instead of starting a second one, and touches nothing", async () => {
    locks.acquireLock.mockResolvedValueOnce(null);
    const out = await runRosterSync();
    expect(out).toEqual({ skipped: "overlapping-run" });
    expect(sync.syncSalesforceAgents).not.toHaveBeenCalled();
    expect(schedule.ensureDefaultSchedules).not.toHaveBeenCalled();
    // Nothing was acquired, so nothing is released: releasing a lease this run
    // does not hold would free the other run's lock from under it.
    expect(locks.releaseLock).not.toHaveBeenCalled();
  });

  it("releases the lock when the sync throws, and lets the caller decide what a failure means", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF down"));
    await expect(runRosterSync()).rejects.toThrow("SF down");
    expect(locks.releaseLock).toHaveBeenCalledWith(AGENTS_LOCK_KEY, "lease");
    // A failed sync measured nothing, so it may clear nothing (#1134, #1152).
    expect(streak.clearFailureStreak).not.toHaveBeenCalled();
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    expect(schedule.ensureDefaultSchedules).not.toHaveBeenCalled();
  });

  it("converges departed people's sessions after the reap, and reports it (#2459)", async () => {
    const out = await runRosterSync();
    if (out.skipped) throw new Error("expected a run");
    expect(sessions.convergeDepartedSessions).toHaveBeenCalledTimes(1);
    // After the sync, because the sync's reap is what departs this hour's leavers.
    expect(sync.syncSalesforceAgents.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.convergeDepartedSessions.mock.invocationCallOrder[0],
    );
    expect(out.sessions).toEqual({ ok: true, result: convergedClean });
    // The outcome is REPORTED, so a failure that persists pages rather than only
    // being logged (fail loud), and a healthy run is what clears it.
    expect(sessions.reportSessionConvergence).toHaveBeenCalledWith(
      { ok: true, result: convergedClean },
      expect.objectContaining({ recordStreak: expect.any(Function), resolve: expect.any(Function) }),
    );
  });

  it("contains a convergence that could not read, and says why (#2459)", async () => {
    // The roster writes have committed by now, so a throw here must not make the
    // run read as a failed Salesforce sync. It is reported, never an empty default.
    sessions.convergeDepartedSessions.mockRejectedValueOnce(new Error("could not list auth users: 503"));
    const out = await runRosterSync();
    if (out.skipped) throw new Error("expected a run");
    expect(out.sessions).toEqual({ ok: false, reason: "could not list auth users: 503" });
    expect(sessions.reportSessionConvergence).toHaveBeenCalledWith(
      { ok: false, reason: "could not list auth users: 503" },
      expect.anything(),
    );
    expect(schedule.ensureDefaultSchedules).toHaveBeenCalled();
    expect(locks.releaseLock).toHaveBeenCalledWith(AGENTS_LOCK_KEY, "lease");
  });

  it("does not converge sessions when the sync itself failed (#2459)", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF down"));
    await expect(runRosterSync()).rejects.toThrow("SF down");
    expect(sessions.convergeDepartedSessions).not.toHaveBeenCalled();
  });

  it("releases the lock after a clean run too", async () => {
    await runRosterSync();
    expect(locks.releaseLock).toHaveBeenCalledWith(AGENTS_LOCK_KEY, "lease");
  });
});
