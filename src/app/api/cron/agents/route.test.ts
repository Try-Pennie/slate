import { describe, it, expect, vi, beforeEach } from "vitest";

// Wiring for the agents (roster) cron (#486/#487): a single failing pass must
// stay quiet (transient SF blips self-heal next hour); only CONSECUTIVE failures
// alert, and a clean pass clears the streak. The streak/alert decision logic is
// covered elsewhere (isConsecutiveFailure); this exercises only the route glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
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
}));
const streak = vi.hoisted(() => ({
  recordFailureStreak: vi.fn(),
  clearFailureStreak: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/salesforce/sync", () => sync);
vi.mock("@/lib/provision", () => provision);
vi.mock("@/lib/schedule", () => schedule);
vi.mock("@/lib/availability/service", () => availability);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/streak", () => streak);

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

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
  });
  streak.recordFailureStreak.mockResolvedValue(false);
});

describe("GET /api/cron/agents", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(sync.syncSalesforceAgents).not.toHaveBeenCalled();
  });

  it("clears the failure streak and does not alert on a clean pass", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(streak.clearFailureStreak).toHaveBeenCalledTimes(1);
    expect(streak.recordFailureStreak).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #1151: a failing roster sync is a CONDITION, so a clean pass says it is over.
  it("announces recovery on a clean pass, so the earlier page can be closed", async () => {
    await GET(req());
    // Three conditions this lane owns, so a clean pass closes all of them: the
    // sync failing, the roster disagreeing with Salesforce about a user id
    // (#1587), and a manager name answering to more than one user (#1653).
    expect(dispatch.resolveAlert.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "agent_sync_failures",
      "salesforce_user_id_conflicts",
      "salesforce_manager_ambiguous",
    ]);
  });

  // The silent path (#1152): the sync FAILING is not evidence that it works, so a
  // run that could not read its health signal must announce nothing.
  it("sends NO all-clear when the sync itself failed", async () => {
    sync.syncSalesforceAgents.mockRejectedValueOnce(new Error("SF unreachable"));
    await GET(req());
    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
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
});
