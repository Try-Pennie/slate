import { describe, it, expect, vi, beforeEach } from "vitest";

// #3177: the roster sync is FENCED on its lock, phase by phase.
//
// The lock is a lease in `sync_locks`: once its 10 minute TTL passes, the next run
// may take the key while this one is still working. Before this the run was only
// budget bounded, so a run that overran could carry on writing after a newer run
// had started, and re-apply a stale bookable flag over the newer run's work.
//
// The lock store below is a small STATEFUL fake with a hand driven clock, and the
// lease is the REAL `makeLockLease` over it, so these cases interleave two genuine
// runs against one key, in both directions:
//
//  - the older run overruns, a newer run takes the key, and the older one stops at
//    its next phase without touching Twilio or the default hours, and without
//    releasing the newer run's claim;
//  - a run that is still making progress renews its claim as it goes, so a newer
//    run arriving after the ORIGINAL claim would have expired is refused.
const TTL = 10 * 60 * 1000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

const lockStore = vi.hoisted(() => {
  const clock = { now: 0 };
  const claims = new Map<string, number>();
  const iso = (ms: number) => new Date(ms).toISOString();
  // When set, every renewal is refused as a database error would be.
  const store = { refuseRenewals: false };
  return {
    clock,
    claims,
    store,
    acquireLock: async (key: string, ttlMs: number): Promise<string | null> => {
      const held = claims.get(key);
      if (held !== undefined && held >= clock.now - ttlMs) return null;
      claims.set(key, clock.now);
      return iso(clock.now);
    },
    renew: async (
      key: string,
      token: string,
    ): Promise<{ ok: true; token: string } | { ok: false; why: "taken" | "refused" }> => {
      if (store.refuseRenewals) return { ok: false, why: "refused" };
      const held = claims.get(key);
      if (held === undefined || iso(held) !== token) return { ok: false, why: "taken" };
      claims.set(key, clock.now);
      return { ok: true, token: iso(clock.now) };
    },
    releaseLock: async (key: string, token: string): Promise<void> => {
      const held = claims.get(key);
      if (held !== undefined && iso(held) === token) claims.delete(key);
    },
  };
});

vi.mock("@/lib/locks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/locks")>("@/lib/locks");
  // The real lease, over the fake store and the fake clock.
  const makeLockLease = (key: string, claim: string, ttlMs: number) =>
    actual.makeLockLease(key, claim, ttlMs, {
      now: () => lockStore.clock.now,
      renew: lockStore.renew,
    });
  return {
    acquireLease: async (key: string, ttlMs: number) => {
      const claim = await lockStore.acquireLock(key, ttlMs);
      return claim === null ? null : makeLockLease(key, claim, ttlMs);
    },
    releaseLock: vi.fn(lockStore.releaseLock),
  };
});

const sync = vi.hoisted(() => ({
  syncSalesforceAgents: vi.fn(),
  AGENTS_SYNC_STREAK_KEY: "cron_agents_failures",
}));
const twilio = vi.hoisted(() => ({
  syncTwilioRedistribute: vi.fn(),
  defaultTwilioSyncDeps: vi.fn(async () => ({}) as never),
}));
const schedule = vi.hoisted(() => ({ ensureDefaultSchedules: vi.fn(async () => 2) }));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => false),
}));
const streak = vi.hoisted(() => ({
  clearFailureStreak: vi.fn(async () => {}),
  recordConsecutiveStreak: vi.fn(async () => false),
}));
const verdict = vi.hoisted(() => ({ recordDetectorVerdict: vi.fn(async () => {}) }));
const sessions = vi.hoisted(() => ({
  convergeDepartedSessions: vi.fn(),
  reportSessionConvergence: vi.fn(async () => {}),
}));

vi.mock("@/lib/salesforce/sync", () => sync);
vi.mock("@/lib/twilio/sync", () => twilio);
vi.mock("@/lib/schedule", () => schedule);
vi.mock("@/lib/provision", () => ({ ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })) }));
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/streak", () => streak);
vi.mock("@/lib/monitor/verdict-store", () => verdict);
vi.mock("@/lib/monitor/settings", () => ({ loadMonitorCooldowns: vi.fn(async () => ({})) }));
vi.mock("@/lib/offboarding/session-convergence", () => sessions);
vi.mock("@/lib/offboarding/session-convergence-alert", () => ({
  reportSessionConvergence: sessions.reportSessionConvergence,
  SESSION_CONVERGENCE_ALERT_KEY: "departed_sessions_unconverged",
  SESSION_CONVERGENCE_STREAK_WINDOW_S: 10800,
  SESSION_CONVERGENCE_STREAK_ALERT_AT: 2,
}));

import { runRosterSync, AGENTS_LOCK_KEY, ROSTER_LEASE_STOP_REASONS } from "./run-roster-sync";
import type { RosterSyncOutcome } from "./run-roster-sync";

const cleanSync = () => ({
  inserted: 0,
  updated: 0,
  deactivated: 0,
  deactivationsRefusedAmbiguous: 0,
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
  rosterUnconfirmedBookable: [],
});

const cleanTwilio = () => ({
  flipFailures: 0,
  coverageSweepFailures: 0,
  attributeWriteFailures: 0,
  markedWithNoWorker: [],
});

/** A promise and the function that settles it, so a test decides when a phase ends. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let every queued continuation run, so a started run reaches its first await. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  lockStore.claims.clear();
  lockStore.store.refuseRenewals = false;
  lockStore.clock.now = T0;
  sync.syncSalesforceAgents.mockResolvedValue(cleanSync());
  twilio.syncTwilioRedistribute.mockResolvedValue(cleanTwilio());
  sessions.convergeDepartedSessions.mockResolvedValue({ departed: 0 });
});

describe("runRosterSync lease fencing (#3177)", () => {
  it("stops an overrunning run at its next phase once a newer run holds the key", async () => {
    const newerSync = deferred<ReturnType<typeof cleanSync>>();
    let newer: Promise<RosterSyncOutcome> | null = null;
    sync.syncSalesforceAgents
      // The older run's Salesforce half overruns its lease, and the next hourly
      // run takes the key while it is still inside it.
      .mockImplementationOnce(async () => {
        lockStore.clock.now = T0 + TTL + 1;
        newer = runRosterSync();
        await settle();
        return cleanSync();
      })
      // The newer run is mid flight until the test lets it finish.
      .mockImplementationOnce(() => newerSync.promise);

    const older = await runRosterSync();
    expect(newer).not.toBeNull();
    if (older.skipped) throw new Error("the older run started");

    // It said why it stopped, in a reason no other failure produces.
    expect(older.leaseStop).toBe("taken");
    expect(older.twilio).toEqual({ ok: false, leaseStop: "taken", reason: ROSTER_LEASE_STOP_REASONS.taken });
    expect(older.sessions).toEqual({ ok: false, leaseStop: "taken", reason: ROSTER_LEASE_STOP_REASONS.taken });
    expect(older.hoursApplied).toBeNull();
    // And it wrote nothing after the point it lost the key.
    expect(twilio.syncTwilioRedistribute).not.toHaveBeenCalled();
    expect(schedule.ensureDefaultSchedules).not.toHaveBeenCalled();
    expect(sessions.convergeDepartedSessions).not.toHaveBeenCalled();
    // A lost lease is not a Twilio failure: no streak, no page, no verdict.
    expect(streak.recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    expect(verdict.recordDetectorVerdict).not.toHaveBeenCalled();
    // Releasing on the way out left the newer run's claim standing.
    expect(lockStore.claims.get(AGENTS_LOCK_KEY)).toBe(T0 + TTL + 1);

    // The newer run then does the whole job, and frees the key when it is done.
    newerSync.resolve(cleanSync());
    const finished = await newer!;
    if (finished.skipped) throw new Error("the newer run started");
    expect(finished.leaseStop).toBeNull();
    expect(finished.twilio.ok).toBe(true);
    expect(finished.hoursApplied).toBe(2);
    expect(twilio.syncTwilioRedistribute).toHaveBeenCalledTimes(1);
    expect(schedule.ensureDefaultSchedules).toHaveBeenCalledTimes(1);
    expect(lockStore.claims.has(AGENTS_LOCK_KEY)).toBe(false);
  });

  it("renews a run that is making progress, so a newer run cannot take the key from it", async () => {
    let newer: RosterSyncOutcome | null = null;
    sync.syncSalesforceAgents.mockImplementationOnce(async () => {
      // Half the lease spent, which is past the point a renewal is due.
      lockStore.clock.now = T0 + TTL / 2;
      return cleanSync();
    });
    twilio.syncTwilioRedistribute.mockImplementationOnce(async () => {
      // Past the ORIGINAL claim's expiry, though not the renewed one's. The next
      // hourly run arrives here.
      lockStore.clock.now = T0 + TTL + TTL / 10;
      newer = await runRosterSync();
      return cleanTwilio();
    });

    const older = await runRosterSync();
    expect(newer).toEqual({ skipped: "overlapping-run" });
    if (older.skipped) throw new Error("the older run started");
    expect(older.leaseStop).toBeNull();
    expect(older.twilio.ok).toBe(true);
    expect(older.hoursApplied).toBe(2);
    expect(sync.syncSalesforceAgents).toHaveBeenCalledTimes(1);
    // It released with the token it renewed to, not the one it started with, or
    // the key would stay held until the TTL ran out.
    expect(lockStore.claims.has(AGENTS_LOCK_KEY)).toBe(false);
  });

  // The Twilio half's own bookkeeping (its streak, its page or all clear, its
  // verdict stamp) is a write too. A run that lost the key DURING the Twilio read
  // must leave all of it to the newer run, which is reading Twilio itself.
  it.each([
    ["read Twilio", () => Promise.resolve(cleanTwilio())],
    ["failed to read Twilio", () => Promise.reject(new Error("Twilio refused the credentials (401)."))],
  ] as const)("writes none of the Twilio bookkeeping when it lost the key while it %s", async (_label, outcome) => {
    twilio.syncTwilioRedistribute.mockImplementationOnce(async () => {
      // Past the TTL, the next hourly run takes the key mid read.
      lockStore.clock.now = T0 + TTL + 1;
      lockStore.claims.set(AGENTS_LOCK_KEY, lockStore.clock.now);
      return outcome();
    });
    // The newer run is still at work, and fails the next attempt to take the key.
    streak.recordConsecutiveStreak.mockResolvedValue(true);

    const out = await runRosterSync();
    if (out.skipped) throw new Error("the run started");
    expect(out.leaseStop).toBe("taken");
    expect(out.hoursApplied).toBeNull();
    const twilioKeys = (calls: unknown[][]) => calls.map((c) => c[0]).filter((k) => String(k).startsWith("twilio"));
    expect(twilioKeys(streak.clearFailureStreak.mock.calls)).toEqual([]);
    expect(twilioKeys(streak.recordConsecutiveStreak.mock.calls)).toEqual([]);
    expect(twilioKeys(dispatch.sendThrottledAlert.mock.calls)).toEqual([]);
    expect(twilioKeys(dispatch.resolveAlert.mock.calls)).toEqual([]);
    expect(verdict.recordDetectorVerdict).not.toHaveBeenCalled();
    expect(schedule.ensureDefaultSchedules).not.toHaveBeenCalled();
    // And it left the newer run's claim standing.
    expect(lockStore.claims.get(AGENTS_LOCK_KEY)).toBe(T0 + TTL + 1);
  });

  it("stops just as safely when the renewal is refused, and never calls that a takeover (L11)", async () => {
    sync.syncSalesforceAgents.mockImplementationOnce(async () => {
      // A renewal is due, and the database refuses it. No other run exists.
      lockStore.clock.now = T0 + TTL / 2;
      lockStore.store.refuseRenewals = true;
      return cleanSync();
    });

    const out = await runRosterSync();
    if (out.skipped) throw new Error("the run started");
    expect(out.leaseStop).toBe("refused");
    expect(out.twilio).toEqual({ ok: false, leaseStop: "refused", reason: ROSTER_LEASE_STOP_REASONS.refused });
    expect(out.twilio.ok ? "" : out.twilio.reason).not.toMatch(/took over/);
    expect(out.hoursApplied).toBeNull();
    // It could not show the key was its own, so it wrote nothing further.
    expect(twilio.syncTwilioRedistribute).not.toHaveBeenCalled();
    expect(schedule.ensureDefaultSchedules).not.toHaveBeenCalled();
    expect(streak.recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(verdict.recordDetectorVerdict).not.toHaveBeenCalled();
  });
});
