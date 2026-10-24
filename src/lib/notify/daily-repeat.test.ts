import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3801, end to end through the REAL dispatcher: an unchanged condition posts again
// 24 hours after its last post, a change posts at once, an urgent condition keeps an
// hourly repeat, and nothing about the all-clear moves. Every alert the issue
// measured repeating is driven here across 25 hours of ticks on a pinned clock (no
// real sleeps). Supabase and Slack are faked; `alert_state` is the shared in-memory
// store that keeps the repeat rule's columns and refuses what Postgres would.

const posted = vi.hoisted(() => [] as string[]);
const slackOk = vi.hoisted(() => ({ value: true }));

vi.mock("@/lib/notify/slack", () => ({
  slackConfigured: () => true,
  postSlack: async (msg: { text: string }) => {
    // #1825: every post opens with its severity lead. These cases are about what the
    // condition SAYS, so the lead is checked present and then set aside.
    const body = withoutSeverityLead(msg.text);
    if (body === null) throw new Error(`post without a severity lead: ${msg.text}`);
    posted.push(body);
    return slackOk.value ? { ok: true } : { ok: false, error: "slack down" };
  },
}));
vi.mock("@/lib/platform/runtime", () => ({
  isWorkersRuntime: () => true,
  workersRuntimeMarker: () => "Cloudflare-Workers",
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", async () =>
  (await import("@/lib/notify/alert-state-fake.test-support")).fakeSupabaseAdminModule(),
);
// The inactive agent check's own persistence streak lives in another table; it is
// not what #3801 is about, so it reads as sustained on every tick.
vi.mock("@/lib/notify/streak", () => ({
  recordConsecutiveStreak: async () => true,
  clearFailureStreak: async () => {},
}));
// The canary route authenticates the canary's own key.
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  bookingApiKeyFor: (caller: string, slot: string) => (caller === "canary" && slot === "primary" ? "canary-secret" : ""),
}));
// The lane watchdog's cal.com switch is read through a per isolate cache; off here.
vi.mock("@/lib/calcom/retirement", async (orig) => ({
  ...(await orig<typeof import("@/lib/calcom/retirement")>()),
  loadCalcomRetiredCached: async () => false,
}));
const heartbeats = vi.hoisted(() => ({ staleSince: 0, lane: "smoke-canary" }));
vi.mock("@/lib/monitor/heartbeat", async (orig) => ({
  ...(await orig<typeof import("@/lib/monitor/heartbeat")>()),
  // Every lane stamped this instant, except the one under test, which last stamped
  // at `staleSince`, so its "has not run for N minutes" grows on every tick.
  readAllHeartbeatMs: async () =>
    new Proxy({} as Record<string, number | null>, {
      get: (_t, lane) => (lane === heartbeats.lane ? heartbeats.staleSince : Date.now()),
    }),
}));

import {
  alertStateRows,
  alertStateSchema,
  refusedAlertStateReads,
} from "@/lib/notify/alert-state-fake.test-support";
import {
  resolveAlert,
  sendThrottledAlert,
  firingKey,
  repeatColumnsAbsent,
  resetRepeatColumnsProbe,
} from "@/lib/notify/dispatch";
import { MONITOR_DEFAULTS } from "@/lib/monitor/settings";
import {
  COVERAGE_NEEDS_HUMAN_KEY,
  runCoverageNeedsHumanCheck,
  type StrandedHolder,
} from "@/lib/monitor/coverage-needs-human";
import {
  runInactiveAgentBookingsCheck,
  type InactiveHolder,
} from "@/lib/monitor/inactive-agent-bookings";
import { REFUSAL_ALERT_KEY, runCiHealthCheck, type WorkflowRunSummary } from "@/lib/monitor/github-ci-health";
import {
  OFFERED_NOBODY_FREE_ALERT_KEY,
  formatOfferedNobodyFreeAlert,
  offeredNobodyFreeRepeat,
  type OfferedFinding,
} from "@/lib/monitor/offered-nobody-free";
import { alertOnStaleLanes } from "@/lib/monitor/lane-watchdog";
import { POST as smokeFailurePost } from "@/app/api/smoke/failure/route";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import { withoutSeverityLead } from "@/lib/notify/severity-lead";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 16, 4, 0);

beforeEach(() => {
  alertStateRows.clear();
  refusedAlertStateReads.clear();
  alertStateSchema.withoutRepeatColumns = false;
  resetRepeatColumnsProbe();
  posted.length = 0;
  slackOk.value = true;
  process.env.SLACK_ALERTS_CHANNEL = "C-alerts";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Run `tick` every `everyMs` from T0 for `hours`, returning the hour (from T0) of
 * every post that went out. `tick` gets the hour so a test can change the condition.
 */
async function drive(hours: number, everyMs: number, tick: (hour: number) => Promise<unknown>): Promise<number[]> {
  const at: number[] = [];
  for (let t = 0; t <= hours * HOUR; t += everyMs) {
    vi.setSystemTime(T0 + t);
    const before = posted.length;
    await tick(t / HOUR);
    for (let i = before; i < posted.length; i++) at.push(t / HOUR);
  }
  return at;
}

const FIVE_MIN = 5 * MIN;

// --- coverage_needs_human ------------------------------------------------------
const stranded = (id: string): StrandedHolder => ({
  userId: id,
  name: `Advisor ${id}`,
  email: `${id}@example.com`,
  unplaceable: 1,
  failed: 0,
});
const coverageTick = (holders: () => StrandedHolder[]) => () =>
  runCoverageNeedsHumanCheck({
    loadStranded: async () => ({
      holders: holders(),
      waiting: 0,
      // Every counted call became countable before the first post, so the page news
      // (#3303) never fires and the repeat rule alone decides.
      newestCountableMs: T0 - HOUR,
      asOfMs: Date.now(),
    }),
    cooldownMs: MONITOR_DEFAULTS.cooldownMs.coverage_needs_human,
  });

describe("coverage_needs_human (#3801)", () => {
  it("an unchanged condition posts twice in 25 hours: the opening post and the 24 hour reminder", async () => {
    const at = await drive(25, FIVE_MIN, coverageTick(() => [stranded("fonseca")]));
    expect(at).toEqual([0, 24]);
    expect(posted[1]).toMatch(/^Reminder: still true after 24 hours, with nothing new since the last message\.\n/);
    expect(posted[1]).toContain(posted[0]);
  });

  it("a new advisor at hour 3 posts at once, and the reminder is 24 hours after THAT post", async () => {
    // Driven to hour 28: the reminder is 24 hours after the LAST post (Dan, 2026-10-16),
    // which after the hour 3 change post is hour 27, not hour 24.
    const atWithNew = await drive(28, FIVE_MIN, async (hour) =>
      coverageTick(() => (hour >= 3 ? [stranded("fonseca"), stranded("shearer")] : [stranded("fonseca")]))(),
    );
    expect(atWithNew).toEqual([0, 3, 27]);
    // The change post reads as a new problem, not as a reminder.
    expect(posted[1]).not.toMatch(/^Reminder/);
    expect(posted[1]).toContain("shearer@example.com");
  });

  it("an advisor leaving is not a change, and the all clear still ends it", async () => {
    const at = await drive(6, FIVE_MIN, async (hour) =>
      coverageTick(() => (hour < 2 ? [stranded("fonseca"), stranded("shearer")] : hour < 4 ? [stranded("fonseca")] : []))(),
    );
    // Opening post, then the all-clear when the last one goes: nothing for the leaver.
    expect(at).toEqual([0, 4]);
    expect(posted[1]).toMatch(/no customer|No action/i);
  });
});

// --- inactive_agent_bookings ---------------------------------------------------
const holding = (id: string, bookings: number): InactiveHolder => ({
  userId: id,
  name: `Agent ${id}`,
  email: `${id}@example.com`,
  reason: "deactivated",
  bookingCount: bookings,
});
const inactiveTick = (holders: () => InactiveHolder[]) => () =>
  runInactiveAgentBookingsCheck({
    loadHolders: async () => holders(),
    cooldownMs: MONITOR_DEFAULTS.cooldownMs.inactive_agent_bookings,
  });

describe("inactive_agent_bookings (#3801)", () => {
  it("an unchanged condition posts twice in 25 hours", async () => {
    expect(await drive(25, FIVE_MIN, inactiveTick(() => [holding("lambert", 5)]))).toEqual([0, 24]);
  });

  it("a new agent at hour 3 posts a third time at hour 3", async () => {
    const at = await drive(28, FIVE_MIN, async (hour) =>
      inactiveTick(() => (hour >= 3 ? [holding("lambert", 5), holding("ortiz", 1)] : [holding("lambert", 5)]))(),
    );
    expect(at).toEqual([0, 3, 24 + 3]);
  });

  it("the count drifting inside its band is no change; doubling it is", async () => {
    // 5 then 6 then 7 appointments: one band (4 to 7). Then 9: the next band.
    const count = (hour: number) => (hour < 2 ? 5 : hour < 4 ? 6 : hour < 6 ? 7 : 9);
    const at = await drive(8, FIVE_MIN, async (hour) => inactiveTick(() => [holding("lambert", count(hour))])());
    expect(at).toEqual([0, 6]);
  });
});

// --- ci_runs_refused -----------------------------------------------------------
const refusedRun = (n: number): WorkflowRunSummary => ({
  id: 1000 + n,
  name: n % 2 === 0 ? "CI" : "Main push guard",
  headSha: `sha${n}`,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  branch: "feature",
  status: "completed",
  conclusion: "failure",
  createdAtMs: Date.now(),
  htmlUrl: `https://github.com/Try-Pennie/slate/actions/runs/${1000 + n}`,
});
const ciTick = (runNumber: () => number) => () =>
  runCiHealthCheck({
    nowMs: Date.now(),
    servedCommit: "dev",
    token: "t",
    readRuns: async () => [refusedRun(runNumber())],
    readJobs: async () => [{ name: "build", conclusion: "failure", stepCount: 0 }],
    // An unstamped build ("dev") judges no deploy, so the tip is never read (#3648).
    readMainTip: async () => null,
    readTipRuns: async () => null,
    cooldownMs: { deploy: MONITOR_DEFAULTS.cooldownMs.main_not_deployed, refusal: MONITOR_DEFAULTS.cooldownMs.ci_runs_refused },
    notify: sendThrottledAlert,
    resolve: resolveAlert,
  });

describe("ci_runs_refused (#3801)", () => {
  it("a new run link on every tick is not a change: two posts in 25 hours", async () => {
    let n = 0;
    const at = await drive(25, FIVE_MIN, ciTick(() => n++));
    expect(at).toEqual([0, 24]);
    // The two posts link different runs, which is exactly what must not count.
    expect(posted[0]).not.toEqual(posted[1].replace(/^Reminder[^\n]*\n/, ""));
    expect(alertStateRows.has(REFUSAL_ALERT_KEY)).toBe(true);
  });
});

// --- the smoke canary lane going stale ----------------------------------------
describe("smoke canary lane stale (#3801)", () => {
  it("a growing 'has not run for N minutes' never posts on its own: two posts in 25 hours", async () => {
    heartbeats.lane = "smoke-canary";
    heartbeats.staleSince = T0 - 2 * HOUR;
    const canaryPosts = () => posted.filter((t) => /smoke canary/i.test(t) && /not|stopped|quiet/i.test(t));
    const at: number[] = [];
    for (let t = 0; t <= 25 * HOUR; t += FIVE_MIN) {
      vi.setSystemTime(T0 + t);
      const before = canaryPosts().length;
      await alertOnStaleLanes();
      if (canaryPosts().length > before) at.push(t / HOUR);
    }
    expect(at).toEqual([0, 24]);
    // The duration in the copy did grow between the two posts.
    const [first, second] = canaryPosts();
    expect(first).not.toEqual(second.replace(/^Reminder[^\n]*\n/, ""));
  });

  it("the full pass going stale too is a separate subject on its own key, and posts at once", async () => {
    heartbeats.lane = "smoke-canary-full";
    heartbeats.staleSince = T0 - 48 * HOUR;
    await alertOnStaleLanes();
    expect(posted.some((t) => /full end to end pass/i.test(t))).toBe(true);
  });
});

// --- offered_nobody_free -------------------------------------------------------
const finding = (code: string, startMs: number): OfferedFinding => ({
  code,
  startMs,
  firstSeenMs: T0 - 30 * MIN,
  members: 3,
  rowComputedAt: new Date(T0 - 10 * MIN).toISOString(),
  writtenBy: "recompute",
});
const offeredTick = (codes: () => string[]) => async () => {
  // The offered times walk forward with the clock, as the booking window does.
  const findings = codes().map((c) => finding(c, Date.now() + 2 * HOUR));
  await sendThrottledAlert(
    OFFERED_NOBODY_FREE_ALERT_KEY,
    MONITOR_DEFAULTS.cooldownMs.offered_nobody_free,
    formatOfferedNobodyFreeAlert(findings, Date.now()),
    offeredNobodyFreeRepeat(findings),
  );
};

describe("offered_nobody_free (#3801)", () => {
  it("the same buckets with walking times post twice in 25 hours", async () => {
    expect(await drive(25, FIVE_MIN, offeredTick(() => ["LOW1"]))).toEqual([0, 24]);
  });

  it("a new bucket at hour 3 posts at once, and its reminder follows 24 hours later", async () => {
    expect(await drive(28, FIVE_MIN, async (h) => offeredTick(() => (h >= 3 ? ["LOW1", "MID2"] : ["LOW1"]))())).toEqual([
      0, 3, 27,
    ]);
  });
});

// --- the canary workflow's failure, handed to the Worker -----------------------
const report = (body: unknown) =>
  smokeFailurePost(
    new Request("http://localhost/api/smoke/failure", {
      method: "POST",
      headers: { authorization: "Bearer canary-secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
const slowRead = (ms: number) => ({
  outcome: "failed",
  mode: "dry",
  text: `Booking canary failed: the booking smoke health check did not pass against production. 1 check failed:\n- availability read took ${ms}ms, over the 2000ms budget\nhttps://github.com/Try-Pennie/slate/actions/runs/${ms}`,
  checks: [`availability read took ${ms}ms, over the 2000ms budget`],
});

describe("smoke canary workflow failure (#3801)", () => {
  it("a failing run every 30 minutes with the same slow read posts twice in 25 hours", async () => {
    let ms = 4000;
    const outcomes: string[] = [];
    const at = await drive(25, 30 * MIN, async () => {
      const res = await report(slowRead(ms++));
      outcomes.push(((await res.json()) as { outcome: string }).outcome);
    });
    expect(at).toEqual([0, 24]);
    // Every other run was HELD, which is what tells the workflow not to post itself.
    expect(outcomes.filter((o) => o === "held").length).toBe(outcomes.length - 2);
  });

  it("a newly failing check at hour 3 posts at once, and its reminder follows 24 hours later", async () => {
    const at = await drive(28, 30 * MIN, async (hour) => {
      const body = slowRead(4100);
      if (hour >= 3) body.checks.push("book in bucket SMOKE created (got no_eligible_agents)");
      await report(body);
    });
    expect(at).toEqual([0, 3, 27]);
  });

  it("a clean run clears it with an all-clear, and the next failure posts at once", async () => {
    await report(slowRead(4000));
    vi.setSystemTime(T0 + 30 * MIN);
    const cleared = (await (await report({ outcome: "passed", mode: "dry" })).json()) as { cleared: string[] };
    expect(cleared.cleared).toEqual(["smoke_canary_failed:dry"]);
    vi.setSystemTime(T0 + 60 * MIN);
    await report(slowRead(4000));
    expect(posted).toHaveLength(3);
    expect(posted[1]).toMatch(/passing again/);
    expect(posted[2]).not.toMatch(/^Reminder/);
  });

  it("refuses a body outside the shape, and posts nothing", async () => {
    const res = await report({ outcome: "failed", mode: "weekly", text: "x" });
    expect(res.status).toBe(400);
    expect(posted).toEqual([]);
  });

  // "cannot mention a whole channel" moved with the rule it tested (#3528): a mention in
  // ANY message is made inert where every message is sent, src/lib/notify/slack.ts,
  // which this file replaces with a fake. src/lib/notify/slack-send-escape.test.ts
  // drives that send point with `<!channel>`, and scripts/test-slack-send-points.ts
  // holds every sender to it, the canary's route included.
});

// --- the rule's edges ----------------------------------------------------------
describe("the repeat rule's edges (#3801)", () => {
  const KEY = "sync_failures"; // a condition nobody can tune, with a 30 minute coded cooldown

  it("an unreadable last-post state POSTS rather than going silent", async () => {
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    vi.setSystemTime(T0 + 10 * MIN);
    refusedAlertStateReads.add(KEY);
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    expect(posted).toHaveLength(2);
  });

  it("CONTROL: the same second send with a readable row is held", async () => {
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    vi.setSystemTime(T0 + 10 * MIN);
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    expect(posted).toHaveLength(1);
  });

  it("a coded cooldown shorter than a day is lifted to a day for a condition", async () => {
    expect(await drive(25, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, "a@x is failing"))).toEqual([0, 24]);
  });

  it("a message whose only difference is a number is not a change, with no subjects supplied", async () => {
    let n = 1;
    expect(
      await drive(6, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, `a@x: ${n++} consecutive failures, last ok ${n} minutes ago`)),
    ).toEqual([0]);
  });

  it("with no subjects supplied, a message naming somebody new is a change", async () => {
    const at = await drive(6, FIVE_MIN, (h) =>
      sendThrottledAlert(KEY, 30 * MIN, h >= 2 ? "a@x is failing\nb@x is failing" : "a@x is failing"),
    );
    expect(at).toEqual([0, 2]);
  });

  it("an URGENT condition keeps an hourly repeat", async () => {
    const at = await drive(5, FIVE_MIN, () =>
      sendThrottledAlert("booking_failure_rate", MONITOR_DEFAULTS.cooldownMs.booking_failure_rate, "bookings failing"),
    );
    expect(at).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a stored cooldown on a tunable condition still decides its interval", async () => {
    // What the monitor route passes when monitor_settings.cooldown_min = 120.
    const at = await drive(6, FIVE_MIN, () => sendThrottledAlert(COVERAGE_NEEDS_HUMAN_KEY, 2 * HOUR, "one call stranded"));
    expect(at).toEqual([0, 2, 4, 6]);
  });

  it("an INCIDENT keeps its own throttle, unchanged", async () => {
    const at = await drive(1, FIVE_MIN, () => sendThrottledAlert("verify_on_book_outage", 15 * MIN, "refused"));
    expect(at).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("resolving and reopening inside a day posts the reopen at once, as a new problem", async () => {
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    vi.setSystemTime(T0 + HOUR);
    expect(await resolveAlert(KEY, "sync recovered")).toBe(true);
    vi.setSystemTime(T0 + 2 * HOUR);
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    expect(posted).toEqual(["a@x is failing", "sync recovered", "a@x is failing"]);
  });

  it("the all-clear still fires off a measured recovery, after any number of reminders", async () => {
    await drive(49, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, "a@x is failing"));
    expect(posted).toHaveLength(3);
    expect(posted[2]).toMatch(/^Reminder: still true after 2 days/);
    expect(await resolveAlert(KEY, "sync recovered")).toBe(true);
    expect(alertStateRows.has(firingKey(KEY))).toBe(false);
  });

  it("two isolates seeing the same new subject at once post it once", async () => {
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    vi.setSystemTime(T0 + 10 * MIN);
    await Promise.all([
      sendThrottledAlert(KEY, 30 * MIN, "a@x is failing\nb@x is failing"),
      sendThrottledAlert(KEY, 30 * MIN, "a@x is failing\nb@x is failing"),
    ]);
    expect(posted).toHaveLength(2);
  });

  it("a failed post is retried within minutes, and the retry is not labelled a reminder", async () => {
    slackOk.value = false;
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    slackOk.value = true;
    vi.setSystemTime(T0 + 3 * MIN);
    await sendThrottledAlert(KEY, 30 * MIN, "a@x is failing");
    expect(posted).toEqual(["a@x is failing", "a@x is failing"]);
  });

  it("a condition open before 0184 posts once on the deploy, then follows the rule", async () => {
    // A row the old dispatcher wrote: a stamp and nothing else.
    const iso = new Date(T0 - 20 * MIN).toISOString();
    alertStateRows.set(KEY, { last_sent_at: iso });
    alertStateRows.set(firingKey(KEY), { last_sent_at: iso });
    expect(await drive(25, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, "a@x is failing"))).toEqual([0, 24]);
  });

  it("a condition open before 0184 counts its age from its first known post, so the reminder's age grows", async () => {
    // The row holds no opening moment, so the earliest fact known is the old post.
    // Recording that once means the second day's reminder reads two days, rather than
    // every reminder measuring from the post before it and saying a day for ever.
    const iso = new Date(T0 - 20 * MIN).toISOString();
    alertStateRows.set(KEY, { last_sent_at: iso });
    alertStateRows.set(firingKey(KEY), { last_sent_at: iso });
    expect(await drive(49, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, "a@x is failing"))).toEqual([0, 24, 48]);
    expect(posted[2]).toMatch(/^Reminder: still true after 2 days,/);
  });

  it("code ahead of migration 0184 runs the old cooldown rule rather than posting every tick", async () => {
    alertStateSchema.withoutRepeatColumns = true;
    const at = await drive(2, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, "a@x is failing"));
    // The coded half hour, exactly as before #3801: not every tick, and not muted.
    expect(at).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(repeatColumnsAbsent()).toBe(true);
  });

  it("CONTROL: with the columns present the same sends are held for the day", async () => {
    expect(await drive(2, FIVE_MIN, () => sendThrottledAlert(KEY, 30 * MIN, "a@x is failing"))).toEqual([0]);
    expect(repeatColumnsAbsent()).toBe(false);
  });

  it("the reminder interval is a day", () => {
    expect(CONDITION_REPEAT_MS).toBe(24 * HOUR);
  });
});
