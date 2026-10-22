import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the agents (roster) cron (#486/#487): a single failing pass must
// stay quiet (transient SF blips self-heal next hour); only CONSECUTIVE failures
// alert, and a clean pass clears the streak. The streak/alert decision logic is
// covered elsewhere (isConsecutiveFailure); this exercises only the route glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
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
const provision = vi.hoisted(() => ({
  ensureDefaultOrg: vi.fn(async () => ({ id: "org1" })),
}));
const schedule = vi.hoisted(() => ({ ensureDefaultSchedules: vi.fn(async () => 0) }));
const availability = vi.hoisted(() => ({
  alertOnEmptyBuckets: vi.fn(async () => ({ empty: [], aggregated: false })),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(
    async (_key: string, _cooldownMs: number, _text: string) => {},
  ),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
  // #3615: the quiet line when a demotion sweep moves calls.
  sendThrottledInfo: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
}));
const streak = vi.hoisted(() => ({
  recordFailureStreak: vi.fn(),
  clearFailureStreak: vi.fn(async () => {}),
  // #2114: the Twilio write failures streak. Defaults to false, so a single
  // failing run stays quiet and only a test that says otherwise pages.
  recordConsecutiveStreak: vi.fn(async () => false),
}));
// #2114: the verdict stamp. Mocked so the route glue can be asserted without a
// database, and so the assertion is about WHETHER it stamped rather than about
// whether a heartbeat write succeeded.
const verdict = vi.hoisted(() => ({
  recordDetectorVerdict: vi.fn(async () => {}),
}));
// #2097: the Twilio half. Mocked rather than left real, because the real one reads
// the deployment's credentials and would refuse in every test here, which is a
// perfectly correct refusal that would make the whole suite about Twilio.
const twilio = vi.hoisted(() => ({
  syncTwilioRedistribute: vi.fn(async () => ({
    workers: 142,
    addresses: 140,
    turnedOff: [] as string[],
    turnedBackOn: [] as string[],
    reactivationRefused: [] as string[],
    markedWithNoWorker: [] as string[],
    coverageSweeps: [] as { email: string; bookings: number }[],
    coverageSweepFailures: 0,
    tiersChanged: [] as string[],
    backendChanged: [] as string[],
    redistributeTagLanded: [] as string[],
    redistributeTagCleared: [] as string[],
    withoutWorker: [] as string[],
    attributeWriteFailures: 0,
    corruptAttributes: 0,
    noEmail: 0,
    unmappedTags: [] as string[],
    flipFailures: 0,
    // #3615: the reroute for demoted advisors, healthy by default.
    demotionSweeps: [] as { email: string; userId: string; jobId: string; bookings: number; change: unknown }[],
    demotionSweepFailures: 0,
    demotionWriteFailures: 0,
    demotionEvalFailures: 0,
    demotionSwitchUnreadable: false,
  })),
  defaultTwilioSyncDeps: vi.fn(async () => ({}) as never),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/salesforce/sync", () => sync);
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/schedule", () => schedule);
vi.mock("@/lib/availability/service", () => availability);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/streak", () => streak);
vi.mock("@/lib/twilio/sync", () => twilio);
vi.mock("@/lib/monitor/verdict-store", () => verdict);
// #2459: the departed session convergence calls Supabase Auth; never for real here.
vi.mock("@/lib/offboarding/session-convergence", () => ({
  convergeDepartedSessions: vi.fn(async () => ({
    departed: 0,
    alreadyRevoked: 0,
    revoked: 0,
    revokeFailed: 0,
    deferred: 0,
    unlisted: 0,
    restored: 0,
    restoreFailed: 0,
    foreignBans: 0,
    listingComplete: true,
  })),
}));
vi.mock("@/lib/offboarding/session-convergence-alert", () => ({
  reportSessionConvergence: vi.fn(async () => {}),
  SESSION_CONVERGENCE_ALERT_KEY: "departed_sessions_unconverged",
  SESSION_CONVERGENCE_STREAK_WINDOW_S: 10800,
  SESSION_CONVERGENCE_STREAK_ALERT_AT: 2,
}));

import { GET } from "./route";
import { noteAlertKey } from "@/lib/notify/alert-recording";
import { ROSTER_LEASE_STOP_REASONS } from "@/lib/salesforce/run-roster-sync";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

/** The healthy Twilio result, so a case can override one field and mean it. */
const twilioResult = async () =>
  (await twilio.syncTwilioRedistribute.getMockImplementation()!()) as Awaited<
    ReturnType<typeof twilio.syncTwilioRedistribute>
  >;

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncSalesforceAgents.mockResolvedValue({
    inserted: 0,
    updated: 0,
    deactivated: 0,
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
  streak.recordFailureStreak.mockResolvedValue(false);
});

describe("GET /api/cron/agents", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLease).not.toHaveBeenCalled();
    expect(sync.syncSalesforceAgents).not.toHaveBeenCalled();
  });

  it("clears the failure streak and does not alert on a clean pass", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    // Three streaks this lane owns, cleared by name rather than by count so a fourth
    // one added later cannot be waved through by the number happening to match:
    // the Salesforce sync's, the Twilio read's (#2774), and the Twilio writes' (#2114).
    expect(streak.clearFailureStreak.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual([
      "cron_agents_failures",
      "demotion_trigger_failures",
      "twilio_sync_failures",
      "twilio_write_failures",
    ]);
    expect(streak.recordFailureStreak).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #3177: a run that stopped holding its lock says WHY in its response, as a 200
  // rather than a failure: a newer run took the key, or the renewal was refused.
  // The two never share a reason (L11), so a database error is never reported as
  // another run having taken over.
  it.each(["taken", "refused"] as const)(
    "reports a run whose lock was %s part way, without counting it as a failure",
    async (why) => {
    locks.makeLockLease.mockImplementationOnce((key: string, claim: string) => ({
      key,
      token: () => claim,
      stillHeld: async () => false,
      stopReason: () => why,
    }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      leaseStop: why,
      hoursApplied: null,
      twilio: { ok: false, leaseStop: why, reason: ROSTER_LEASE_STOP_REASONS[why] },
    });
    expect(twilio.syncTwilioRedistribute).not.toHaveBeenCalled();
    expect(streak.recordFailureStreak).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    },
  );

  it("never gives the two stop reasons one sentence", () => {
    expect(ROSTER_LEASE_STOP_REASONS.taken).not.toBe(ROSTER_LEASE_STOP_REASONS.refused);
    expect(ROSTER_LEASE_STOP_REASONS.refused).not.toMatch(/took over/);
  });

  it("says a clean run kept its lock", async () => {
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ leaseStop: null, hoursApplied: 0 });
  });

  // #1151: a failing roster sync is a CONDITION, so a clean pass says it is over.
  it("announces recovery on a clean pass, so the earlier page can be closed", async () => {
    await GET(req());
    // Seven conditions this lane owns, so a clean pass closes all of them: Twilio
    // being unreadable (#2097), its writes not landing and a mark with no worker
    // (#2114), the Salesforce sync failing, the roster disagreeing with Salesforce
    // about a user id (#1587), a manager name answering to more than one user
    // (#1653), and a bookable agent the roster query no longer returns (#1833).
    // The Twilio ones are first because that step runs before the bucket
    // coverage check, which has to see the state the run's own flips leave.
    expect(dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "twilio_sync_failures",
      "twilio_write_failures",
      "twilio_marked_no_worker",
      "demotion_trigger_failures",
      "agent_sync_failures",
      "salesforce_user_id_conflicts",
      "salesforce_manager_ambiguous",
      "salesforce_roster_divergence",
    ]);
  });

  // The silent path (#1152): the sync FAILING is not evidence that it works, so a
  // run that could not read its health signal must announce nothing.
  it("sends NO all-clear when the sync itself failed", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF unreachable"));
    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  // #2097, the same silent path in the Twilio half. A read that FAILED is not
  // evidence that Twilio is readable, so the recovery for its own key must not be
  // sent, while the Salesforce half's recovery still is: they are two conditions and
  // one status field between them would have either clearing both (L53).
  it("sends NO Twilio all-clear when the Twilio read failed", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio refused the credentials (401)."));
    await GET(req());
    const cleared = dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]);
    expect(cleared).not.toContain("twilio_sync_failures");
    expect(cleared).toContain("agent_sync_failures");
  });

  it("pages on its own key when Twilio cannot be read on a second run in a row, and still reports the Salesforce half", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio refused the credentials (401)."));
    streak.recordConsecutiveStreak.mockResolvedValueOnce(true);
    const res = await GET(req());
    // 200, deliberately: the Salesforce writes committed. A 500 would record a
    // Salesforce failure streak for a Twilio fault and page about the wrong system.
    expect(res.status).toBe(200);
    expect(streak.recordFailureStreak).not.toHaveBeenCalled();
    const paged = dispatch.sendThrottledAlert.mock.calls.map((c: unknown[]) => c[0]);
    expect(paged).toEqual(["twilio_sync_failures"]);
    // And the response says which half failed, rather than looking like a run where
    // nobody happened to be tagged.
    expect(await res.json()).toMatchObject({ twilio: { ok: false } });
  });

  // #2774: one failed read is recorded, not paged. On 2026-09-25 a single 520 from
  // Twilio's edge paged a person while the hour before had read fine. The client
  // already retried it once; what survives that is still usually a blip, so the
  // page waits for the NEXT hourly run to fail too, like the Salesforce half.
  it("records a single failed Twilio read without paging, and still says so everywhere else", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio's worker listing returned 520"));
    const res = await GET(req());
    expect(streak.recordConsecutiveStreak).toHaveBeenCalledWith("twilio_sync_failures", expect.any(Number), 2);
    const paged = dispatch.sendThrottledAlert.mock.calls.map((c: unknown[]) => c[0]);
    expect(paged).not.toContain("twilio_sync_failures");
    // The miss is still RECORDED on this run: the verdict stamp says the half did
    // not conclude, and the response the banner reads says Twilio failed.
    expect(verdict.recordDetectorVerdict).toHaveBeenCalledWith("verdict:twilio-roster", false);
    expect(await res.json()).toMatchObject({ twilio: { ok: false } });
    // And a failed read is not a healthy one, so its streak is not cleared.
    expect(streak.clearFailureStreak.mock.calls.map((c: unknown[]) => c[0])).not.toContain("twilio_sync_failures");
  });

  it("pages when two consecutive runs fail to read Twilio", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio's worker listing returned 520"));
    streak.recordConsecutiveStreak.mockResolvedValueOnce(false);
    await GET(req());
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio's worker listing returned 503"));
    streak.recordConsecutiveStreak.mockResolvedValueOnce(true);
    await GET(req());
    const pages = dispatch.sendThrottledAlert.mock.calls.filter((c: unknown[]) => c[0] === "twilio_sync_failures");
    expect(pages).toHaveLength(1);
    expect(String(pages[0]![2])).toContain("503");
  });

  it("does not page on one failed run followed by a success, and the success clears the streak", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio's worker listing returned 520"));
    streak.recordConsecutiveStreak.mockResolvedValueOnce(false);
    await GET(req());
    await GET(req());
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    // Cleared on the measured success, so the next isolated miss starts from zero
    // rather than pairing with one from days ago.
    expect(streak.clearFailureStreak.mock.calls.map((c: unknown[]) => c[0])).toContain("twilio_sync_failures");
  });

  // #2114: the half AFTER the read. Until this, a flip that kept throwing, a
  // coverage move that could not be queued and a legal value that would not write
  // were counted, logged, put in the sync banner, and reported by nothing at all on
  // an unattended hourly run.
  it("stays quiet on the FIRST run whose Twilio writes failed, because the next hour retries them", async () => {
    twilio.syncTwilioRedistribute.mockResolvedValueOnce({
      ...(await twilioResult()),
      flipFailures: 1,
    });
    streak.recordConsecutiveStreak.mockResolvedValueOnce(false);
    await GET(req());
    const paged = dispatch.sendThrottledAlert.mock.calls.map((c: unknown[]) => c[0]);
    expect(paged).not.toContain("twilio_write_failures");
    // And it did not clear it either: this run measured a failure.
    expect(dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0])).not.toContain(
      "twilio_write_failures",
    );
  });

  it("pages once the retry fails too, naming which write it was", async () => {
    twilio.syncTwilioRedistribute.mockResolvedValueOnce({
      ...(await twilioResult()),
      flipFailures: 2,
      coverageSweepFailures: 1,
    });
    streak.recordConsecutiveStreak.mockResolvedValueOnce(true);
    await GET(req());
    const call = dispatch.sendThrottledAlert.mock.calls.find(
      (c: unknown[]) => c[0] === "twilio_write_failures",
    );
    expect(call).toBeTruthy();
    expect(String(call?.[2])).toContain("2 agents");
    expect(String(call?.[2])).toContain("coverage panel");
  });

  // The mark with no worker is NOT streaked: nothing retries it and nothing fixes
  // it on its own, so it is a standing state somebody has to end.
  it("pages on the first run that finds a mark Twilio holds no worker for", async () => {
    twilio.syncTwilioRedistribute.mockResolvedValueOnce({
      ...(await twilioResult()),
      markedWithNoWorker: ["a@trypennie.com", "b@trypennie.com"],
    });
    await GET(req());
    const call = dispatch.sendThrottledAlert.mock.calls.find(
      (c: unknown[]) => c[0] === "twilio_marked_no_worker",
    );
    expect(call).toBeTruthy();
    expect(String(call?.[2])).toContain("2 agents");
    expect(streak.recordConsecutiveStreak).not.toHaveBeenCalled();
  });

  // #1394: the stamp that says the Twilio half CONCLUDED, as opposed to ran. The
  // hourly roster job has no lane heartbeat of its own, so this is the only thing
  // that would notice it silently stopping.
  it("stamps the verdict on a run that read Twilio", async () => {
    await GET(req());
    expect(verdict.recordDetectorVerdict).toHaveBeenCalledWith("verdict:twilio-roster", true);
  });

  it("stamps NOTHING when the Twilio read failed, so a blind half never reads as concluding", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio refused the credentials (401)."));
    await GET(req());
    expect(verdict.recordDetectorVerdict).toHaveBeenCalledWith("verdict:twilio-roster", false);
  });

  // The silent path again (#1152), in this half: a Twilio read that FAILED never
  // reaches the write report at all, so neither of its keys is cleared off a run
  // that measured nothing.
  it("clears neither write condition when the Twilio read failed", async () => {
    twilio.syncTwilioRedistribute.mockRejectedValueOnce(new Error("Twilio refused the credentials (401)."));
    await GET(req());
    const cleared = dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]);
    expect(cleared).not.toContain("twilio_write_failures");
    expect(cleared).not.toContain("twilio_marked_no_worker");
    // #3615: nor the reroute's, which never ran on a run that could not read Twilio.
    expect(cleared).not.toContain("demotion_trigger_failures");
  });

  // #3615: the reroute for demoted advisors. Its failures were counted and logged and reported by
  // nothing, and an unreadable switch looked exactly like a switch left off.
  describe("the reroute for demoted advisors (#3615)", () => {
    it("stays quiet on the first failing run and does not clear either", async () => {
      twilio.syncTwilioRedistribute.mockResolvedValueOnce({ ...(await twilioResult()), demotionEvalFailures: 1 });
      streak.recordConsecutiveStreak.mockResolvedValueOnce(false);
      await GET(req());
      expect(streak.recordConsecutiveStreak).toHaveBeenCalledWith("demotion_trigger_failures", expect.any(Number), 2);
      expect(dispatch.sendThrottledAlert.mock.calls.map((c: unknown[]) => c[0])).not.toContain("demotion_trigger_failures");
      expect(dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0])).not.toContain("demotion_trigger_failures");
    });

    it("pages on the second, naming each fault, and an unreadable switch counts", async () => {
      twilio.syncTwilioRedistribute.mockResolvedValueOnce({
        ...(await twilioResult()),
        demotionSwitchUnreadable: true,
        demotionSweepFailures: 2,
      });
      // The only streak this run records: no Twilio write failed.
      streak.recordConsecutiveStreak.mockResolvedValueOnce(true);
      await GET(req());
      const call = dispatch.sendThrottledAlert.mock.calls.find((c: unknown[]) => c[0] === "demotion_trigger_failures");
      expect(call).toBeTruthy();
      expect(String(call?.[2])).toMatch(/switched on/);
      expect(String(call?.[2])).toContain("2 agents");
      // It is its own fault, so the Twilio write alert is not dragged in with it.
      expect(dispatch.sendThrottledAlert.mock.calls.map((c: unknown[]) => c[0])).not.toContain("twilio_write_failures");
    });

    // A run only QUEUES the moves, so it says nothing about them: on 2026-10-21 the line it used
    // to send here said "is moving 1 call" for a call nobody was free to take. The every minute
    // drain says how they settled once the sweep finishes (scripts/test-demotion-outcome-report.ts).
    it("says nothing about the moves when a demotion sweep queued calls", async () => {
      twilio.syncTwilioRedistribute.mockResolvedValueOnce({
        ...(await twilioResult()),
        demotionSweeps: [{ email: "jlee@trypennie.com", userId: "u1", jobId: "job9", bookings: 2, change: null }],
      });
      await GET(req());
      const keys = dispatch.sendThrottledInfo.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(keys.filter((k) => k.startsWith("demotion_reroute_moved"))).toEqual([]);
    });

    // Its own boundary: the Twilio half READ fine, so a failure while reporting the reroute must
    // not be recorded as Twilio being unreadable, which pages about the wrong system.
    it("keeps a failure while reporting the reroute out of the Twilio read's account", async () => {
      twilio.syncTwilioRedistribute.mockResolvedValueOnce({ ...(await twilioResult()), demotionEvalFailures: 1 });
      streak.recordConsecutiveStreak.mockRejectedValueOnce(new Error("alert_state unreachable"));
      const res = await GET(req());
      expect(await res.json()).toMatchObject({ twilio: { ok: true } });
      expect(streak.recordConsecutiveStreak).not.toHaveBeenCalledWith("twilio_sync_failures", expect.any(Number), 2);
      expect(verdict.recordDetectorVerdict).toHaveBeenCalledWith("verdict:twilio-roster", true);
    });
  });

  it("stays quiet on a single (self-healing) failure", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(
      new Error("SF token failed: 522 error code: 522"),
    );
    streak.recordFailureStreak.mockResolvedValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(streak.recordFailureStreak).toHaveBeenCalledTimes(1);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #1587: a roster row the sync deliberately left alone is invisible from every
  // other angle. The run succeeds, the roster looks synced, and the only trace is
  // a count nobody reads, so the conflict shapes page.
  describe("salesforce user id conflicts (#1587)", () => {
    const withConflicts = (over: Record<string, number>) =>
      sync.syncSalesforceAgents.mockResolvedValueOnce({
        inserted: 0,
        updated: 0,
        deactivated: 0,
        managersCreated: 0,
        managersLinked: 0,
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
        rosterUnconfirmedAmbiguous: 0,
        deactivationsRefusedAmbiguous: 0,
        rosterUnconfirmedBookable: [],
        ...over,
      });

    it("pages when a stored id disagrees with Salesforce, and does not also clear", async () => {
      withConflicts({ salesforceIdDisagreements: 1 });
      const res = await GET(req());
      expect(res.status).toBe(200);
      const sent = dispatch.sendThrottledAlert.mock.calls.filter(
        (c: unknown[]) => c[0] === "salesforce_user_id_conflicts",
      );
      expect(sent).toHaveLength(1);
      // The reader has to learn that nothing was rewritten, which is the whole
      // reason this is a page rather than a silent correction.
      expect(sent[0][2]).toContain("Nothing was changed");
      expect(
        dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]),
      ).not.toContain("salesforce_user_id_conflicts");
    });

    it("pages when two Salesforce users share one email", async () => {
      withConflicts({ salesforceIdAmbiguous: 2 });
      await GET(req());
      const sent = dispatch.sendThrottledAlert.mock.calls.filter(
        (c: unknown[]) => c[0] === "salesforce_user_id_conflicts",
      );
      expect(sent).toHaveLength(1);
      expect(sent[0][2]).toContain("shared by");
    });

    it("pages when an id is already held by another Slate row", async () => {
      withConflicts({ salesforceIdClaimed: 1 });
      await GET(req());
      expect(
        dispatch.sendThrottledAlert.mock.calls.filter(
          (c: unknown[]) => c[0] === "salesforce_user_id_conflicts",
        ),
      ).toHaveLength(1);
    });

    // The asymmetry this design rests on. A row with NO id is one every consumer
    // correctly refuses, which is safe. A row whose id may name the WRONG person
    // is not. Only the second pages; absence is reported in the counts and the log.
    it("does NOT page for rows it simply could not resolve", async () => {
      withConflicts({ salesforceIdsUnresolved: 14 });
      await GET(req());
      expect(
        dispatch.sendThrottledAlert.mock.calls.filter(
          (c: unknown[]) => c[0] === "salesforce_user_id_conflicts",
        ),
      ).toHaveLength(0);
      // And it still counts as healthy for this condition, so a previous page clears.
      expect(
        dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]),
      ).toContain("salesforce_user_id_conflicts");
    });

    // #2387: a deactivation the reap REFUSED because the address answers to
    // several Salesforce records. It rides this key rather than one of its own:
    // it is the same shared address as `salesforceIdAmbiguous`, and one edit in
    // Salesforce settles both.
    it("pages when a deactivation was refused on a shared address", async () => {
      withConflicts({ deactivationsRefusedAmbiguous: 1 });
      await GET(req());
      const sent = dispatch.sendThrottledAlert.mock.calls.filter(
        (c: unknown[]) => c[0] === "salesforce_user_id_conflicts",
      );
      expect(sent).toHaveLength(1);
      // Deactivating NOBODY in silence and deactivating the WRONG person read
      // alike from outside a run, so the message has to say which happened.
      expect(sent[0][2]).toContain("left in the roster rather than deactivated");
      expect(
        dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]),
      ).not.toContain("salesforce_user_id_conflicts");
    });

    // #1152: the all-clear hangs off a MEASURED healthy result, never off "we did
    // not alert this run". A sync that threw measured nothing.
    it("sends NO all-clear for the id condition when the sync itself failed", async () => {
      sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF unreachable"));
      await GET(req());
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    // A Slack outage must not turn a good roster sync into a 500: the roster is
    // already written by this point.
    it("still returns 200 when the conflict page cannot be delivered", async () => {
      withConflicts({ salesforceIdDisagreements: 1 });
      dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
      const res = await GET(req());
      expect(res.status).toBe(200);
    });
  });


  // #1653: a manager name that answers to more than one Salesforce user is a
  // CONDITION. It stays true until somebody edits Salesforce, it decides who
  // approves that rep's time off, and until it is settled the sync deliberately
  // writes nothing, which is invisible from every other angle.
  //
  // Its OWN key, not folded into salesforce_user_id_conflicts: that condition is
  // about the stored id column and its all-clear says the roster agrees about
  // user ids. Sharing one key would give two independent checks one status field,
  // so clearing either would clear both (L53).
  describe("manager name ambiguity (#1653)", () => {
    const withResult = (over: Record<string, number>) =>
      sync.syncSalesforceAgents.mockResolvedValueOnce({
        inserted: 0,
        updated: 0,
        deactivated: 0,
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
        ...over,
      });

    const sentFor = (key: string) =>
      dispatch.sendThrottledAlert.mock.calls.filter((c: unknown[]) => c[0] === key);
    const resolvedKeys = () =>
      dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]);

    it("pages when a manager name answers to more than one Salesforce user", async () => {
      withResult({ managersAmbiguous: 15, managerNamesAmbiguous: 1 });
      const res = await GET(req());
      expect(res.status).toBe(200);
      const sent = sentFor("salesforce_manager_ambiguous");
      expect(sent).toHaveLength(1);
      const text = sent[0][2] as string;
      // The reader has to learn that nothing was re-pointed, which is the whole
      // reason this is a page rather than a silent correction.
      expect(text).toContain("Nothing was changed");
      // BOTH numbers reach the copy. The shape this really takes is one duplicated
      // name over a whole team, and a message carrying only one of the two reads as
      // a much smaller or a much larger problem than it is. A count the route never
      // passed would render as "undefined", which no substring assertion on the
      // sentence around it would notice.
      expect(text).toContain("15 people");
      expect(text).toContain("1 manager name");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
      expect(resolvedKeys()).not.toContain("salesforce_manager_ambiguous");
    });

    // The asymmetry, mirroring #1587. A rep whose manager name matched NOBODY has
    // no link written and every consumer correctly sees no manager, which is safe.
    // A name that answers to two people is one where a link may name the wrong
    // human, and wrong is worse than missing.
    it("does NOT page for a manager name that simply matched nobody", async () => {
      withResult({ managersUnresolved: 12 });
      await GET(req());
      expect(sentFor("salesforce_manager_ambiguous")).toHaveLength(0);
      // And it still counts as healthy for this condition, so a previous page clears.
      expect(resolvedKeys()).toContain("salesforce_manager_ambiguous");
    });

    it("announces recovery on a run that measured no ambiguity", async () => {
      await GET(req());
      expect(resolvedKeys()).toContain("salesforce_manager_ambiguous");
    });

    // #1152: the all-clear hangs off a MEASURED healthy result, never off "we did
    // not alert this run". A sync that threw measured nothing at all.
    it("sends NO all-clear for the manager condition when the sync itself failed", async () => {
      sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF unreachable"));
      await GET(req());
      expect(resolvedKeys()).not.toContain("salesforce_manager_ambiguous");
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    // The two conditions are independent: an id conflict must not silence or clear
    // the manager page, and the reverse.
    it("pages the manager condition while the id condition is clearing", async () => {
      withResult({ managersAmbiguous: 1 });
      await GET(req());
      expect(sentFor("salesforce_manager_ambiguous")).toHaveLength(1);
      expect(sentFor("salesforce_user_id_conflicts")).toHaveLength(0);
      expect(resolvedKeys()).toContain("salesforce_user_id_conflicts");
      expect(resolvedKeys()).not.toContain("salesforce_manager_ambiguous");
    });

    // A Slack outage must not turn a good roster sync into a 500: the roster is
    // already written by this point.
    it("still returns 200 when the manager page cannot be delivered", async () => {
      withResult({ managersAmbiguous: 3 });
      dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
      const res = await GET(req());
      expect(res.status).toBe(200);
    });
  });

  // #1833: a roster row Salesforce no longer confirms. The roster query stops
  // returning somebody whose balance tiers were cleared, nothing writes their row
  // again, and the lane reports success every hour.
  describe("roster rows Salesforce no longer confirms (#1833)", () => {
    const withDivergence = (over: Record<string, number | string[]>) =>
      sync.syncSalesforceAgents.mockResolvedValueOnce({
        inserted: 0,
        updated: 0,
        deactivated: 0,
        managersCreated: 0,
        managersLinked: 0,
        managersPromoted: 0,
        salesforceIdsLinked: 0,
        salesforceIdDisagreements: 0,
        salesforceIdAmbiguous: 0,
        salesforceIdClaimed: 0,
        salesforceIdsUnresolved: 0,
        rosterRowsReconciled: 129,
        rosterUnconfirmedInactive: 0,
        rosterUnconfirmedUnmatched: 0,
        rosterUnconfirmedAbsent: 0,
        rosterUnconfirmedBookable: [],
        ...over,
      });

    const sentFor = (key: string) =>
      dispatch.sendThrottledAlert.mock.calls.filter((c: unknown[]) => c[0] === key);
    const resolvedKeys = () =>
      dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0]);

    it("pages when a BOOKABLE agent is no longer confirmed, and does not also clear", async () => {
      withDivergence({
        rosterUnconfirmedUnmatched: 1,
        rosterUnconfirmedBookable: ["onleave@trypennie.com"],
      });
      const res = await GET(req());
      expect(res.status).toBe(200);
      const sent = sentFor("salesforce_roster_divergence");
      expect(sent).toHaveLength(1);
      const text = sent[0][2] as string;
      // The reader has to learn that nothing was cleared, which is the whole
      // reason this is a page rather than a silent correction.
      expect(text).toContain("Nothing was changed");
      expect(text).toContain("1 agent is");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
      expect(resolvedKeys()).not.toContain("salesforce_roster_divergence");
    });

    // The deliberate quiet half (L36). Measured on 2026-09-13 all 39 unconfirmed
    // rows were non bookable, so paging on the count would have been an hourly
    // page nobody could act on from the day it shipped. The counts still travel,
    // and the sync's own log line carries them.
    it("does NOT page for unconfirmed rows that are not bookable", async () => {
      withDivergence({
        rosterUnconfirmedInactive: 4,
        rosterUnconfirmedUnmatched: 20,
        rosterUnconfirmedAbsent: 15,
      });
      await GET(req());
      expect(sentFor("salesforce_roster_divergence")).toHaveLength(0);
      // And it still counts as healthy for this condition, so a previous page clears.
      expect(resolvedKeys()).toContain("salesforce_roster_divergence");
    });

    // #1152: the all-clear hangs off a MEASURED healthy result, never off "we did
    // not alert this run". A sync that threw measured nothing at all.
    it("sends NO all-clear for this condition when the sync itself failed", async () => {
      sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF unreachable"));
      await GET(req());
      expect(resolvedKeys()).not.toContain("salesforce_roster_divergence");
      expect(dispatch.resolveAlert).not.toHaveBeenCalled();
    });

    // Independent of its neighbours: one status field between two checks would
    // have either of them clearing both (L53).
    it("pages this condition while the manager condition is clearing", async () => {
      withDivergence({ rosterUnconfirmedBookable: ["onleave@trypennie.com"] });
      await GET(req());
      expect(sentFor("salesforce_roster_divergence")).toHaveLength(1);
      expect(sentFor("salesforce_manager_ambiguous")).toHaveLength(0);
      expect(resolvedKeys()).toContain("salesforce_manager_ambiguous");
      expect(resolvedKeys()).not.toContain("salesforce_roster_divergence");
    });

    // A Slack outage must not turn a good roster sync into a 500: the roster is
    // already written by this point.
    it("still returns 200 when this page cannot be delivered", async () => {
      withDivergence({ rosterUnconfirmedBookable: ["a@x.com", "b@x.com"] });
      dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
      const res = await GET(req());
      expect(res.status).toBe(200);
    });
  });

  it("alerts once the failures are consecutive, calling the schedule hourly", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(
      new Error("SF token failed: 522 error code: 522"),
    );
    streak.recordFailureStreak.mockResolvedValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [, , text] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(text).toContain("hourly");
    expect(text).not.toContain("daily");
    expect(text).toContain("522");
  });

  // One failure, one message (Dan, 2026-10-03). The fakes note their key exactly
  // as the real ones do (pinned in src/lib/notify/alert-recording.test.ts): a
  // tracked quiet streak and a send that returned each speak for the lane, a streak
  // that could not be tracked speaks for nobody.
  describe("the dispatcher's generic page (#3133 follow-up)", () => {
    const failOnce = () =>
      sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF token failed: 522"));

    it("stands down on a first failure the lane deliberately keeps quiet", async () => {
      failOnce();
      streak.recordFailureStreak.mockImplementationOnce(async (key: string) => {
        noteAlertKey(key);
        return false;
      });
      const res = await GET(req());
      expect(res.status).toBe(500);
      expect(res.headers.get("x-slate-lane-alerted")).toBe("cron_agents_failures");
    });

    it("stands down when the lane's own page went out", async () => {
      failOnce();
      streak.recordFailureStreak.mockResolvedValueOnce(true);
      dispatch.sendThrottledAlert.mockImplementationOnce(async (key: string) => {
        noteAlertKey(key);
      });
      const res = await GET(req());
      expect(res.headers.get("x-slate-lane-alerted")).toBe("agent_sync_failures");
    });

    it("is left to speak when the lane's streak could not be tracked", async () => {
      failOnce();
      streak.recordFailureStreak.mockResolvedValueOnce(false); // not noted: untracked
      const res = await GET(req());
      expect(res.status).toBe(500);
      expect(res.headers.get("x-slate-lane-alerted")).toBeNull();
    });
  });
});
