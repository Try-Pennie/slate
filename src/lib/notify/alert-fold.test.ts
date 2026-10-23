import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3802, end to end through the REAL dispatcher, the REAL lane watchdog and the REAL
// CI health check: while `ci_runs_refused` is firing, the smoke canary lanes it
// explains stay quiet, the CI page names them, and once CI runs again each one gets
// its own bound to report before it may post. Supabase and Slack are faked; the clock
// is pinned and moved by hand (no real sleeps).

const posted = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/notify/slack", () => ({
  slackConfigured: () => true,
  postSlack: async (msg: { text: string }) => {
    posted.push(msg.text);
    return { ok: true };
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
vi.mock("@/lib/calcom/retirement", async (orig) => ({
  ...(await orig<typeof import("@/lib/calcom/retirement")>()),
  loadCalcomRetiredCached: async () => false,
}));
// Every lane stamped this instant unless a test has pinned its last stamp here.
const stamps = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/monitor/heartbeat", async (orig) => ({
  ...(await orig<typeof import("@/lib/monitor/heartbeat")>()),
  readAllHeartbeatMs: async () =>
    new Proxy({} as Record<string, number | null>, {
      get: (_t, lane) => (typeof lane === "string" && stamps.has(lane) ? (stamps.get(lane) as number) : Date.now()),
    }),
}));

import { alertStateRows, refusedAlertStateReads } from "@/lib/notify/alert-state-fake.test-support";
import { resolveAlert, sendThrottledAlert, firingKey, resetRepeatColumnsProbe } from "@/lib/notify/dispatch";
import { MONITOR_DEFAULTS } from "@/lib/monitor/settings";
import { REFUSAL_ALERT_KEY, runCiHealthCheck, type WorkflowRunSummary } from "@/lib/monitor/github-ci-health";
import { alertOnStaleLanes } from "@/lib/monitor/lane-watchdog";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 16, 4, 15);
const FIVE_MIN = 5 * MIN;
const CANARY_BOUND = 90 * MIN;

beforeEach(() => {
  alertStateRows.clear();
  refusedAlertStateReads.clear();
  stamps.clear();
  resetRepeatColumnsProbe();
  posted.length = 0;
  process.env.SLACK_ALERTS_CHANNEL = "C-alerts";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const run = (n: number, refused: boolean): WorkflowRunSummary => ({
  id: 1000 + n,
  name: "CI",
  headSha: `sha${n}`,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  branch: "feature",
  status: "completed",
  conclusion: refused ? "failure" : "success",
  createdAtMs: Date.now(),
  htmlUrl: `https://github.com/Try-Pennie/slate/actions/runs/${1000 + n}`,
});

let runNo = 0;
const ciTick = (refused: boolean) =>
  runCiHealthCheck({
    nowMs: Date.now(),
    servedCommit: "dev",
    token: "t",
    readRuns: async () => [run(runNo++, refused)],
    readJobs: async () => [{ name: "build", conclusion: "failure", stepCount: 0 }],
    // An unstamped build ("dev") judges no deploy, so the tip is never read (#3648).
    readMainTip: async () => null,
    readTipRuns: async () => null,
    cooldownMs: { deploy: MONITOR_DEFAULTS.cooldownMs.main_not_deployed, refusal: MONITOR_DEFAULTS.cooldownMs.ci_runs_refused },
    notify: sendThrottledAlert,
    resolve: resolveAlert,
  });

/** One monitor tick: the CI check, then the watchdog, as the monitor lane runs them. */
async function tick(refused: boolean | null) {
  if (refused !== null) await ciTick(refused);
  await alertOnStaleLanes();
}

/** Every post from T0 for `hours`, each tagged with its hour and text. */
async function drive(
  hours: number,
  everyMs: number,
  step: (hour: number) => Promise<unknown>,
): Promise<{ hour: number; text: string }[]> {
  const out: { hour: number; text: string }[] = [];
  for (let t = 0; t <= hours * HOUR; t += everyMs) {
    vi.setSystemTime(T0 + t);
    const before = posted.length;
    await step(t / HOUR);
    for (let i = before; i < posted.length; i++) out.push({ hour: t / HOUR, text: posted[i] });
  }
  return out;
}

const isCi = (t: string) => /GitHub refused to start|CI jobs are starting again/.test(t);
const isCanary = (t: string) => !isCi(t) && /smoke canary|latency/i.test(t);

describe("the CI refusal explains the canary lanes (#3802)", () => {
  it("a refusal, then every canary lane going stale: one CI post naming them, and no canary post", async () => {
    // The canary last ran just before GitHub stopped starting jobs, so each lane goes
    // stale DURING the stop: the dry tick at 1h, the full pass at 3h, the latency
    // reading at 5h30m.
    stamps.set("smoke-canary", T0 - 31 * MIN);
    stamps.set("smoke-canary-full", T0 - 5 * HOUR);
    stamps.set("verdict:availability-latency", T0 - 31 * MIN);
    const out = await drive(7, FIVE_MIN, () => tick(true));
    expect(out.map((p) => p.hour)).toEqual([0]);
    const [ci] = out;
    expect(isCi(ci.text)).toBe(true);
    // It names what has stopped with it, so the reader knows what is not being checked.
    expect(ci.text).toMatch(/smoke canary/i);
    expect(ci.text).toMatch(/full end to end booking pass/i);
    expect(ci.text).toMatch(/latency/i);
    // Their state was still evaluated and recorded, never skipped.
    for (const lane of ["smoke-canary", "smoke-canary-full", "verdict:availability-latency"]) {
      expect(alertStateRows.has(`alert_folded:cron_lane_stale:${lane}`)).toBe(true);
    }
  });

  it("CI recovering with the canary still stale: the canary posts one full bound after, and clears on its own", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    const out = await drive(6, FIVE_MIN, async (hour) => {
      // The canary stamps again at 5h, after it has posted on its own.
      if (hour >= 5) stamps.delete("smoke-canary");
      await tick(hour < 3);
    });
    const hours = out.map((p) => p.hour);
    expect(out.filter((p) => isCi(p.text)).map((p) => p.hour)).toEqual([0, 3]);
    const canary = out.filter((p) => isCanary(p.text));
    expect(canary).toHaveLength(2);
    // Not before one full bound from the recovery, and within a couple of ticks of it.
    expect(canary[0].hour).toBeGreaterThanOrEqual(3 + CANARY_BOUND / HOUR);
    expect(canary[0].hour).toBeLessThanOrEqual(3 + CANARY_BOUND / HOUR + 10 / 60);
    expect(canary[0].text).toMatch(/has not run|not reported|quiet|stopped/i);
    // It posted as its own problem, so it says its own all-clear.
    expect(canary[1].hour).toBe(5);
    expect(canary[1].text).toMatch(/running again/);
    expect(hours).toHaveLength(4);
  });

  it("an unreadable alert_state never suppresses: the canary lanes post", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    const out = await drive(2, FIVE_MIN, async (hour) => {
      // From the first hour nothing can say whether the CI page is firing.
      if (hour >= 0.5) refusedAlertStateReads.add(firingKey(REFUSAL_ALERT_KEY));
      await tick(true);
    });
    const canary = out.filter((p) => isCanary(p.text));
    expect(canary.length).toBeGreaterThanOrEqual(1);
    expect(canary[0].hour).toBe(1);
  });

  it("CONTROL: with no CI refusal the canary posts the moment it goes stale", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    const out = await drive(2, FIVE_MIN, () => tick(false));
    expect(out.filter((p) => isCanary(p.text)).map((p) => p.hour)).toEqual([1]);
  });
});

describe("the fold's edges (#3802)", () => {
  it("a lane already stale before the CI stop posts as usual, reminder included", async () => {
    stamps.set("smoke-canary", T0 - 2 * HOUR);
    const out = await drive(25, FIVE_MIN, async (hour) => tick(hour >= 1 ? true : null));
    expect(out.filter((p) => isCanary(p.text)).map((p) => p.hour)).toEqual([0, 24]);
    // The CI page keeps its own daily reminder too.
    expect(out.filter((p) => isCi(p.text)).map((p) => p.hour)).toEqual([1, 25]);
  });

  it("CI clearing and refusing again inside a bound keeps the lane folded, and its bound runs from the last clear", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    const refusedAt = (h: number) => h < 3 || (h >= 3.5 && h < 5);
    const out = await drive(8, FIVE_MIN, (hour) => tick(refusedAt(hour)));
    expect(out.filter((p) => isCi(p.text)).map((p) => p.hour)).toEqual([0, 3, 3.5, 5]);
    const canary = out.filter((p) => isCanary(p.text));
    expect(canary).toHaveLength(1);
    expect(canary[0].hour).toBeGreaterThanOrEqual(5 + CANARY_BOUND / HOUR);
  });

  it("a folded lane that comes back inside its bound sends no all-clear: the CI all-clear speaks for it", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    const out = await drive(8, FIVE_MIN, async (hour) => {
      if (hour >= 3.5) stamps.delete("smoke-canary");
      await tick(hour < 3);
    });
    expect(out.map((p) => p.hour)).toEqual([0, 3]);
    expect(out.every((p) => isCi(p.text))).toBe(true);
  });

  it("a folded lane that came back and then goes quiet again posts the moment it is stale: the old hold record holds nothing", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    const backAt = T0 + 3 * HOUR + 10 * MIN;
    const out = await drive(6, FIVE_MIN, async (hour) => {
      // It stamps once, ten minutes after CI recovers, and never again.
      if (T0 + hour * HOUR >= backAt) stamps.set("smoke-canary", backAt);
      await tick(hour < 3);
    });
    const canary = out.filter((p) => isCanary(p.text));
    expect(canary).toHaveLength(1);
    // Stale is strictly past the bound, so the first tick after it.
    expect(canary[0].hour * HOUR).toBe(backAt - T0 + CANARY_BOUND + FIVE_MIN);
    expect(alertStateRows.has("alert_folded:cron_lane_stale:smoke-canary")).toBe(false);
  });

  it("a CI page nobody has heard from in over a day stops explaining anything", async () => {
    // The marker survives, but no reminder has refreshed it, so whatever left it there
    // is no longer measuring a refusal.
    alertStateRows.set(firingKey(REFUSAL_ALERT_KEY), { last_sent_at: new Date(T0 - 26 * HOUR).toISOString() });
    stamps.set("smoke-canary", T0 - 2 * HOUR);
    await alertOnStaleLanes();
    expect(posted.filter(isCanary)).toHaveLength(1);
  });

  it("two isolates at once: none posts while folded, exactly one posts once the bound has run", async () => {
    stamps.set("smoke-canary", T0 - 31 * MIN);
    for (let t = 0; t <= 3 * HOUR; t += FIVE_MIN) {
      vi.setSystemTime(T0 + t);
      await ciTick(t < 2 * HOUR);
      await Promise.all([alertOnStaleLanes(), alertOnStaleLanes()]);
    }
    expect(posted.filter(isCanary)).toHaveLength(0);
    vi.setSystemTime(T0 + 2 * HOUR + CANARY_BOUND + 10 * MIN);
    await Promise.all([alertOnStaleLanes(), alertOnStaleLanes()]);
    expect(posted.filter(isCanary)).toHaveLength(1);
  });
});
