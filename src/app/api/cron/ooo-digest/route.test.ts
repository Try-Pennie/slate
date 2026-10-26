import { describe, it, expect, vi, beforeEach } from "vitest";

// Denial guard for the OOO manager-digest cron (#676): an unauthenticated caller
// must be rejected with 401 before the time gate is read or any DB row is
// queried. Plus (#194): the digest sends interactive Approve/Decline blocks, and
// one manager's Slack failure must not abort the rest of the run.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const from = vi.hoisted(() => vi.fn());
const slack = vi.hoisted(() => ({
  dmSlackUserByEmail: vi.fn(
    async (_email: string, _text: string, _blocks?: unknown[]): Promise<boolean> => true,
  ),
  // #1499: requests nobody can be nudged about are posted to the shared fallback
  // channel instead of DMed, so this route now has a second Slack surface.
  postSlack: vi.fn(
    async (
      _msg: { text: string; blocks?: unknown[] },
    ): Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }> => ({
      ok: true,
      channel: "C1",
      ts: "1",
    }),
  ),
}));
// #1001: a repeatedly-undelivered digest must escalate, not stay swallowed. The
// route folds each manager's delivery result into the shared consecutive-failure
// streak and fires a throttled alert once it trips.
const streak = vi.hoisted(() => ({
  recordConsecutiveStreak: vi.fn(
    async (_key: string, _windowSeconds: number, _alertAt: number): Promise<boolean> => false,
  ),
  clearFailureStreak: vi.fn(async (_key: string): Promise<void> => {}),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(
    async (_key: string, _cooldownMs: number, _text: string, _channel?: string): Promise<void> => {},
  ),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/notify/slack", () => slack);
vi.mock("@/lib/notify/streak", () => streak);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/env", () => ({ appUrl: () => "https://slate.test" }));
// Keep log noise out of the failure-path test (it logs the DM failure).
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

const noAuthReq = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];
const forcedReq = () =>
  ({
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams("force=1") },
  }) as unknown as Parameters<typeof GET>[0];

// A supabase query builder whose every chained method returns itself and which
// resolves (when awaited) to { data: rows }.
// Every chained method is RECORDED, not just swallowed. The #1499 fix is the
// absence of a filter (`manager_id is not null`) on the pending read, and a
// builder that silently accepts every call cannot tell a route that dropped the
// filter from one that never did, so the test would pass on the bug it exists to
// catch (L141).
const builderCalls: { table: string; method: string; args: unknown[] }[] = [];
function builderFor(rows: unknown[], table = "") {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "in"]) {
    b[m] = (...args: unknown[]) => {
      builderCalls.push({ table, method: m, args });
      return b;
    };
  }
  (b as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows });
  return b;
}

const pendingRows = [
  {
    id: "r1",
    user_id: "a1",
    manager_id: "m1",
    starts_at: "2026-07-10T13:00:00Z",
    ends_at: "2026-07-10T15:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    reason: "vacation",
  },
  {
    id: "r2",
    user_id: "a2",
    manager_id: "m1",
    starts_at: "2026-07-11T13:00:00Z",
    ends_at: "2026-07-11T15:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    reason: "appointment",
  },
  {
    id: "r3",
    user_id: "a3",
    manager_id: "m2",
    starts_at: "2026-07-12T13:00:00Z",
    ends_at: "2026-07-12T15:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    reason: "personal",
  },
];
// `role` is real, not decoration: a manager of record only routes a request when
// they can actually approve it (#1475), so a double that omits the column would
// quietly send every request down the unrouted path and agree with itself (L52).
const userRows = [
  { id: "m1", email: "m1@x.com", name: "Manager One", role: "manager" },
  { id: "m2", email: "m2@x.com", name: "Manager Two", role: "manager" },
  { id: "a1", email: "a1@x.com", name: "Agent One", role: "agent" },
  { id: "a2", email: "a2@x.com", name: "Agent Two", role: "agent" },
  { id: "a3", email: "a3@x.com", name: "Agent Three", role: "agent" },
];

// The same builder, refusing. `unwrap` throws on a real `error`, and this is what
// hands it one: a builder that only ever resolves `{ data }` can never reach the
// path these tests exist for (L1).
function refusingBuilderFor(table = "") {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "in"]) {
    b[m] = (...args: unknown[]) => {
      builderCalls.push({ table, method: m, args });
      return b;
    };
  }
  (b as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: null, error: { message: "57014 canceling statement due to statement timeout" } });
  return b;
}

/**
 * The `lane_heartbeats` half of the mock (#2543).
 *
 * This lane writes two stamps and reads none: `ooo-digest` as soon as the route is
 * reached (the cron is firing), and `ooo-digest-nudge` once the morning's nudging
 * really happened. Recorded rather than swallowed, because a stamp nothing can see
 * and a stamp that never happened look the same to a test (L98).
 */
const stamped: string[] = [];
function heartbeatBuilder() {
  return {
    upsert: async (row: { lane: string }) => {
      stamped.push(row.lane);
      return { error: null };
    },
  };
}

function wireDb() {
  from.mockImplementation((table: string) => {
    if (table === "lane_heartbeats") return heartbeatBuilder();
    return builderFor(table === "ooo_requests" ? pendingRows : userRows, table);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  builderCalls.length = 0;
  stamped.length = 0;
  // clearAllMocks wipes call history but keeps implementations, so re-establish
  // the defaults a prior test may have overridden.
  slack.dmSlackUserByEmail.mockImplementation(async () => true);
  slack.postSlack.mockImplementation(async () => ({ ok: true, channel: "C1", ts: "1" }));
  streak.recordConsecutiveStreak.mockResolvedValue(false);
  streak.clearFailureStreak.mockResolvedValue(undefined);
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
});

describe("GET /api/cron/ooo-digest", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(noAuthReq());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("DMs each manager an interactive digest with Approve/Decline action rows", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(2); // one DM per resolvable manager
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(2);

    // Every DM carries the interactive blocks (3rd arg) with at least one actions row.
    for (const call of slack.dmSlackUserByEmail.mock.calls) {
      const blocks = call[2] as { type?: string }[];
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.some((b) => b.type === "actions")).toBe(true);
    }
    // The busiest manager (m1, two requests) gets two action rows.
    const m1Call = slack.dmSlackUserByEmail.mock.calls.find((c) => c[0] === "m1@x.com")!;
    const m1Blocks = m1Call[2] as { type?: string }[];
    expect(m1Blocks.filter((b) => b.type === "actions")).toHaveLength(2);
  });

  it("keeps sending the other managers when one manager's DM throws (fail-loud, not fail-silent)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    // m1 (busiest, sent first) blows up; m2 must still get its digest.
    slack.dmSlackUserByEmail.mockImplementation(async (email: string) => {
      if (email === "m1@x.com") throw new Error("slack 500");
      return true;
    });

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(res.status).toBe(200); // one bad DM does not 500 the whole tick
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(2); // m2 still attempted
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1); // the failure is surfaced, not swallowed
  });

  it("clears each reachable manager's failure streak and never alerts on a clean run (#1001)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();

    await GET(forcedReq());

    // Both managers delivered, so both streaks are cleared and nothing escalates.
    const cleared = streak.clearFailureStreak.mock.calls.map((c) => c[0]);
    expect(cleared).toContain("ooo-digest-send-fail:m1");
    expect(cleared).toContain("ooo-digest-send-fail:m2");
    expect(streak.recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // #1151: "this manager is not receiving their digest" is a CONDITION, and one
  // successful DM is the only thing that ever observes it ending.
  it("announces recovery for each manager it actually reached", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();

    await GET(forcedReq());

    const cleared = dispatch.resolveAlert.mock.calls.map((c) => c[0]);
    expect(cleared).toContain("ooo-digest-unreachable:m1");
    expect(cleared).toContain("ooo-digest-unreachable:m2");
  });

  // The silent path (#1152): a manager we could NOT reach gets no all-clear. The
  // failed send is not evidence their DM works, and clearing here would close a
  // page about the exact manager still going unreached.
  it("sends NO all-clear for a manager whose DM failed", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    slack.dmSlackUserByEmail.mockImplementation(async (email: string) => email !== "m1@x.com");

    await GET(forcedReq());

    const cleared = dispatch.resolveAlert.mock.calls.map((c) => c[0]);
    expect(cleared).not.toContain("ooo-digest-unreachable:m1");
    expect(cleared).toContain("ooo-digest-unreachable:m2");
  });

  it("sends NO all-clear at all when every manager is unreachable", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    slack.dmSlackUserByEmail.mockResolvedValue(false);

    await GET(forcedReq());

    expect(dispatch.resolveAlert).not.toHaveBeenCalled();
  });

  it("records a send-failure streak but stays quiet on a lone failure (#1001)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    // m1 unreachable (a null/false send), m2 fine. The streak has not tripped yet.
    slack.dmSlackUserByEmail.mockImplementation(async (email: string) => email !== "m1@x.com");
    streak.recordConsecutiveStreak.mockResolvedValue(false);

    await GET(forcedReq());

    // m1's failure is tracked under its own key; m2's success clears its streak.
    const recorded = streak.recordConsecutiveStreak.mock.calls.map((c) => c[0]);
    expect(recorded).toContain("ooo-digest-send-fail:m1");
    expect(streak.clearFailureStreak.mock.calls.map((c) => c[0])).toContain(
      "ooo-digest-send-fail:m2",
    );
    // One bad day may be a transient Slack blip, so no alert fires.
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("fires a throttled, manager-named alert once the streak trips (#1001)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    slack.dmSlackUserByEmail.mockImplementation(async (email: string) => email !== "m1@x.com");
    streak.recordConsecutiveStreak.mockResolvedValue(true); // Nth consecutive failure

    await GET(forcedReq());

    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [alertKey, cooldownMs, text] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(alertKey).toBe("ooo-digest-unreachable:m1");
    expect(typeof cooldownMs).toBe("number");
    expect(cooldownMs).toBeGreaterThan(0);
    expect(text).toContain("Manager One"); // names the unreachable manager, not a raw error
  });

  it("keeps processing the rest of the run when the delivery alert itself throws (#1001)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    // m1 unreachable and its streak trips, but the alert dispatch blows up.
    slack.dmSlackUserByEmail.mockImplementation(async (email: string) => email !== "m1@x.com");
    streak.recordConsecutiveStreak.mockResolvedValue(true);
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(res.status).toBe(200); // a failed alert must not 500 the tick
    expect(body.failed).toBe(1);
    // m2 was still delivered and its streak cleared despite m1's alert throwing.
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(2);
    expect(streak.clearFailureStreak.mock.calls.map((c) => c[0])).toContain(
      "ooo-digest-send-fail:m2",
    );
  });

  // --- #1499: the requests nobody can be nudged about ---
  //
  // The route used to filter `manager_id is not null` out of the pending read, so
  // a request from one of the nine people with no manager of record was nudged
  // once on the day it was submitted and then never again. It reaches the shared
  // fallback channel now, which is where team leads and up already see them.
  it("posts the unrouted requests to the fallback channel and counts them", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      builderFor(
        table === "ooo_requests"
          ? [
              pendingRows[0], // routed: m1 is a manager
              { ...pendingRows[2], id: "r9", manager_id: null }, // no manager of record
            ]
          : userRows,
        table,
      ),
    );

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(body.unrouted).toBe(1);
    expect(body.unroutedPosted).toBe(true);
    expect(slack.postSlack).toHaveBeenCalledTimes(1);
    const posted = slack.postSlack.mock.calls[0][0];
    expect(posted.text).toContain("team lead or admin");
    expect(JSON.stringify(posted.blocks)).toContain("No manager of record");
    // The routed one is still DMed, so this is a second lane, not a redirect.
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(1);
    // And the read itself is unfiltered: re-adding `manager_id is not null` would
    // hide these rows from the query long before any of the above could notice.
    expect(
      builderCalls.filter(
        (c) => c.table === "ooo_requests" && c.args.some((a) => a === "manager_id"),
      ),
    ).toEqual([]);
  });

  it("reports the fallback post as NOT sent when Slack refuses it", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      builderFor(
        table === "ooo_requests"
          ? [{ ...pendingRows[2], id: "r9", manager_id: null }]
          : userRows,
        table,
      ),
    );
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });

    const res = await GET(forcedReq());
    const body = await res.json();

    // A run that could not deliver the unrouted nudge must not read as clean:
    // `sent: 0, failed: 0` alone is indistinguishable from having had nothing
    // unrouted to send.
    expect(res.status).toBe(200);
    expect(body.unrouted).toBe(1);
    expect(body.unroutedPosted).toBe(false);
  });

  it("does not post at all when every pending request has a manager who can act", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();

    const res = await GET(forcedReq());
    const body = await res.json();

    expect(body.unrouted).toBe(0);
    expect(slack.postSlack).not.toHaveBeenCalled();
  });

  // L13: a repeated failure to post the unrouted nudge must ESCALATE, not sit in
  // the logs. These are the requests with no assigned approver, so a silent
  // failure leaves the least watched part of the queue unwatched.
  it("escalates once the unrouted post has failed for consecutive runs", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      builderFor(
        table === "ooo_requests"
          ? [{ ...pendingRows[2], id: "r9", manager_id: null }]
          : userRows,
        table,
      ),
    );
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    streak.recordConsecutiveStreak.mockResolvedValue(true);

    await GET(forcedReq());

    const call = dispatch.sendThrottledAlert.mock.calls.find(
      (c) => c[0] === "ooo-digest-unrouted-unreachable",
    );
    expect(call).toBeTruthy();
    // Its own words, not the per manager copy, which names a Slack address problem.
    expect(call?.[2]).toContain("no assigned approver");
    expect(call?.[2]).not.toContain("Slate email address");
  });

  it("clears the unrouted alert only from a post that actually landed", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      builderFor(
        table === "ooo_requests"
          ? [{ ...pendingRows[2], id: "r9", manager_id: null }]
          : userRows,
        table,
      ),
    );

    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    await GET(forcedReq());
    expect(dispatch.resolveAlert.mock.calls.map((c) => c[0])).not.toContain(
      "ooo-digest-unrouted-unreachable",
    );

    vi.clearAllMocks();
    builderCalls.length = 0;
    cron.isAuthorizedCron.mockReturnValue(true);
    slack.dmSlackUserByEmail.mockImplementation(async () => true);
    slack.postSlack.mockImplementation(async () => ({ ok: true, channel: "C1", ts: "1" }));
    await GET(forcedReq());
    expect(dispatch.resolveAlert.mock.calls.map((c) => c[0])).toContain(
      "ooo-digest-unrouted-unreachable",
    );
  });

  it("keeps the run going when the unrouted tracking itself throws (L71)", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    wireDb();
    from.mockImplementation((table: string) =>
      builderFor(
        table === "ooo_requests"
          ? [pendingRows[0], { ...pendingRows[2], id: "r9", manager_id: null }]
          : userRows,
        table,
      ),
    );
    slack.postSlack.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    streak.recordConsecutiveStreak.mockRejectedValueOnce(new Error("streak store down"));

    const res = await GET(forcedReq());

    expect(res.status).toBe(200);
    // The routed manager was still DMed: a watchdog that dies must not take the
    // work it watches with it.
    expect(slack.dmSlackUserByEmail).toHaveBeenCalledTimes(1);
  });

  // --- #2383: a failed read is not an empty morning ---
  //
  // Both of these used to be `const { data } = await ...`, so a refused query
  // arrived as null, became an empty array, and the lane answered 200 with
  // `{ sent: 0, pending: 0 }`. Nobody was nudged, nothing was alerted, and the
  // run was indistinguishable from a morning with an empty queue. The lane is
  // wired to two UTC crons an hour apart with an hour gate, so there is no
  // second attempt either.
  it("refuses the tick when the pending queue cannot be read, instead of reporting an empty day", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      table === "ooo_requests" ? refusingBuilderFor(table) : builderFor(userRows, table),
    );

    await expect(GET(forcedReq())).rejects.toThrow(/ooo digest pending queue/);
    // And nothing was sent off the unreadable queue: no DM, no fallback post.
    expect(slack.dmSlackUserByEmail).not.toHaveBeenCalled();
    expect(slack.postSlack).not.toHaveBeenCalled();
  });

  it("refuses the tick when the people read fails, rather than posting the whole queue as unrouted", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    from.mockImplementation((table: string) =>
      table === "users" ? refusingBuilderFor(table) : builderFor(pendingRows, table),
    );

    // `role` is what makes a request routed, so an empty map turns every one of
    // them into "no manager of record" and posts the lot to the fallback channel
    // with nobody named.
    await expect(GET(forcedReq())).rejects.toThrow(/ooo digest people/);
    expect(slack.dmSlackUserByEmail).not.toHaveBeenCalled();
    expect(slack.postSlack).not.toHaveBeenCalled();
  });
});

// #2543: this lane got one attempt a weekday morning, cron has no retries, and it
// was in no bounds map, so a lane that stopped firing was watched by nothing. Two
// stamps, because "the cron reached the route" and "every manager was nudged" are
// different facts with different remedies (L11).
describe("GET /api/cron/ooo-digest: the two lane stamps (#2543)", () => {
  beforeEach(() => cron.isAuthorizedCron.mockReturnValue(true));

  it("stamps the attempt even on the tick the time gate no-ops", async () => {
    wireDb();
    await GET({
      headers: new Headers(),
      nextUrl: { searchParams: new URLSearchParams() },
    } as unknown as Parameters<typeof GET>[0]);
    expect(stamped).toContain("ooo-digest");
  });

  it("stamps the nudge once the morning's nudging really happened", async () => {
    wireDb();
    await GET(forcedReq());
    expect(stamped).toContain("ooo-digest-nudge");
  });

  it("still stamps the nudge on a morning with an empty queue, which is an answer", async () => {
    from.mockImplementation((table: string) =>
      table === "lane_heartbeats" ? heartbeatBuilder() : builderFor([], table),
    );
    const res = await GET(forcedReq());
    expect((await res.json()).pending).toBe(0);
    expect(stamped).toContain("ooo-digest-nudge");
  });

  it("stamps the nudge when one manager's DM failed, because the schedule is fine", async () => {
    // A broken Slack address has its own streak and its own page inside the route.
    // Withholding the stamp for it would report the SCHEDULE as stopped while it is
    // running perfectly and one address is wrong.
    wireDb();
    slack.dmSlackUserByEmail.mockImplementation(async () => false);
    await GET(forcedReq());
    expect(stamped).toContain("ooo-digest-nudge");
  });

  // THE FAILURE PATH: an unreadable queue stamps the attempt and NOT the nudge, so
  // a lane that fires and throws every morning goes stale and pages, rather than
  // looking exactly like a lane nobody had anything for.
  it("stamps the attempt and not the nudge when the queue cannot be read", async () => {
    from.mockImplementation((table: string) => {
      if (table === "lane_heartbeats") return heartbeatBuilder();
      return table === "ooo_requests" ? refusingBuilderFor(table) : builderFor(userRows, table);
    });
    await expect(GET(forcedReq())).rejects.toThrow(/ooo digest pending queue/);
    expect(stamped).toContain("ooo-digest");
    expect(stamped).not.toContain("ooo-digest-nudge");
  });
});
