/**
 * Cron WALL TIME headroom, watched every day (#3141). It does not measure CPU, and nothing in it
 * may claim CPU safety.
 *
 * Every cron expression's invocation is killed at `limits.cpu_ms` in wrangler.jsonc, and the
 * every minute one shares that budget across four lanes. Until now the headroom was read by hand
 * from Cloudflare's analytics (docs/cloudflare-platform-notes.md), so a lane growing toward the
 * ceiling was found by whoever next thought to look, or by the kill.
 *
 * WHAT THIS MEASURES IS WALL TIME, NOT CPU (L11). The Workers runtime gives a running invocation
 * no reading of its own CPU, and the analytics that do hold it need an account API token the
 * deployment does not carry. So the Worker times each invocation's lanes (`lane-timing.ts`,
 * #1245) and this judges the slowest tick of the day against a WALL TIME line, set at half the
 * CPU ceiling so a schedule that has grown that slow is looked at.
 *
 * What that can and cannot say, because the difference is the whole value of the check:
 *
 *  - It is NOT a bound on CPU in either direction. The Worker's clock advances only at I/O, so
 *    CPU spent computing between two I/O events can read as little or no time at all (a load run
 *    tick spent 119s of CPU while its clock barely moved, docs/cloudflare-platform-notes.md). A
 *    compute heavy tick can sit under this line while its CPU is near the kill. And a tick that
 *    mostly WAITS on PostgREST or Google reads high while its CPU is small.
 *  - So a quiet day here says nothing about CPU headroom, and a page says only that a schedule
 *    has become slow in wall time, which is worth knowing (a minute lane past a minute overlaps
 *    its own next tick) and worth checking against the real CPU.
 *
 * The real CPU is read by hand in workersInvocationsScheduled, and every message here says so.
 *
 * HOW IT REACHES THE MONITOR LANE. The Worker writes a `lane_heartbeats` row named for the cron
 * expression only on a tick past the line, and so pays nothing on a healthy tick. The monitor
 * lane reads those rows and judges the trailing day. Because a writer that has stopped writing
 * looks exactly like a day with nothing past the line, the hourly tick also stamps
 * `verdict:cron-budget`, and this check refuses to clear on a stale stamp, while the lane
 * watchdog pages on it in its own words (#1394).
 *
 * PURE: every branch is driven offline by scripts/test-cron-budget.ts. Type imports only.
 */
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/**
 * `limits.cpu_ms` in wrangler.jsonc. The Worker cannot read its own config at runtime, so the
 * number lives here and scripts/test-cron-budget.ts holds it equal to the file.
 */
export const CRON_CPU_LIMIT_MS = 120_000;

/**
 * The share of the ceiling past which a tick is worth a warning. Half, the same margin the load
 * run's cron bar fails at (`CRON_CPU_MARGIN_SHARE` is this constant): the measured worst tick
 * reached 37 percent in July, and a lane that doubles from there should be found while there is
 * still room to trim it on purpose.
 */
export const CRON_BUDGET_WARN_SHARE = 0.5;

/** The line itself, derived rather than restated. */
export const CRON_BUDGET_WARN_MS = CRON_CPU_LIMIT_MS * CRON_BUDGET_WARN_SHARE;

/** "The peak of the day": the trailing window the monitor lane judges. */
export const CRON_BUDGET_WINDOW_MS = 24 * 60 * 60_000;

/** alert_state key for the condition. */
export const CRON_BUDGET_ALERT_KEY = "cron_budget_headroom";

/**
 * Daily. Nothing anybody can do clears it inside the hour, and the window it judges is a day,
 * so an hourly repeat would restate one finding twenty four times (L36).
 */
export const CRON_BUDGET_COOLDOWN_MS = CRON_BUDGET_WINDOW_MS;

/** The `lane_heartbeats` row a past the line tick writes is this prefix plus the cron expression. */
export const CRON_BUDGET_BREACH_PREFIX = "cron-over-budget:";

/**
 * The cron expression whose tick stamps the verdict lane: hourly, so proving the writer alive
 * costs twenty four writes a day, and `scripts/test-cron-budget.ts` holds it to a trigger
 * wrangler.jsonc really fires.
 */
export const CRON_BUDGET_VERDICT_CRON = "0 * * * *";

/** The in process route the Worker hands a measurement to. */
export const CRON_BUDGET_ROUTE = "/api/cron/cron-budget";

/**
 * What one invocation's measurement must record, decided in the Worker before it spends an in
 * process request on it. Most ticks record nothing.
 */
export function cronBudgetWrites(cron: string, wallMs: number): { breach: boolean; verdict: boolean } {
  return {
    // Strictly past the line. A NaN is not past it, and cannot arise from performance.now().
    breach: wallMs > CRON_BUDGET_WARN_MS,
    verdict: cron === CRON_BUDGET_VERDICT_CRON,
  };
}

/** One cron expression with a tick past the line inside the window. */
export interface CronBudgetBreach {
  cron: string;
  atMs: number;
}

/**
 * `unreadable` names the schedules whose breach row exists and whose time cannot be read. Such a
 * row is never counted as a breach: it can never age out of the window, so it would page for
 * ever. Nor may it hold the all clear back, or an open alert would wait on a breach that may
 * never come (L665). So the readable rows decide, and every message names the undated row as not
 * judged. The next breach on that schedule rewrites the row with a real time.
 */
export type CronBudgetHealth =
  | { status: "unmeasured"; why: string; unreadable: string[] }
  | { status: "over"; breaches: CronBudgetBreach[]; unreadable: string[] }
  | { status: "within"; unreadable: string[] };

/**
 * The verdict over every stamp in `lane_heartbeats`.
 *
 * `stamps` null is a read that failed. A stored stamp that cannot be parsed arrives as 0 (the
 * heartbeat reader's sentinel, #1169). A breach row carrying it is left out of the judgement
 * and named in it (see `CronBudgetHealth`).
 */
export function cronBudgetHealth(input: {
  stamps: Record<string, number | null> | null;
  nowMs: number;
  /** How old the hourly verdict stamp may be before the writer is presumed not to be writing. */
  verdictBoundMs: number;
  verdictLane: string;
}): CronBudgetHealth {
  if (input.stamps === null) {
    return { status: "unmeasured", why: "lane_heartbeats could not be read this tick", unreadable: [] };
  }
  const breaches: CronBudgetBreach[] = [];
  const unreadable: string[] = [];
  for (const [lane, ms] of Object.entries(input.stamps)) {
    if (!lane.startsWith(CRON_BUDGET_BREACH_PREFIX)) continue;
    const cron = lane.slice(CRON_BUDGET_BREACH_PREFIX.length);
    if (ms === 0) unreadable.push(cron);
    else if (ms !== null && input.nowMs - ms <= CRON_BUDGET_WINDOW_MS) breaches.push({ cron, atMs: ms });
  }
  // A breach is a positive measurement, so it is reported even while the verdict stamp is stale.
  if (breaches.length > 0) {
    breaches.sort((a, b) => a.cron.localeCompare(b.cron));
    return { status: "over", breaches, unreadable: unreadable.sort() };
  }
  unreadable.sort();
  const verdictMs = input.stamps[input.verdictLane];
  if (verdictMs === undefined || verdictMs === null) {
    return {
      status: "unmeasured",
      why: "the Worker has never recorded a cron timing, so a quiet day here proves nothing",
      unreadable,
    };
  }
  if (input.nowMs - verdictMs > input.verdictBoundMs) {
    return {
      status: "unmeasured",
      why: "the Worker's hourly timing stamp is stale, so it may have stopped recording past the line ticks",
      unreadable,
    };
  }
  return { status: "within", unreadable };
}

/** UTC, to the minute, with the date: the window is a day and spans two of them. */
function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** The undated rows, named as not judged, or nothing. */
function undatedNote(unreadable: string[]): string {
  if (unreadable.length === 0) return "";
  return (
    `\nNot judged: the row for ${unreadable.map((c) => `\`${c}\``).join(", ")} in lane_heartbeats ` +
    `carries a time that cannot be read, so whether it falls in the last day is unknown. Its next ` +
    `tick past the line rewrites it.`
  );
}

/** What every message says, so none of them can be read as a statement about CPU. */
const NOT_CPU =
  `This is wall time, which the Worker can measure, and it does not measure CPU: CPU spent between ` +
  `I/O waits can read as no time at all. The real CPU is cpuTimeUs in workersInvocationsScheduled.`;

/** The page. Names each schedule and its latest tick, and where the CPU for it is read. */
export function formatCronBudgetAlert(health: Extract<CronBudgetHealth, { status: "over" }>): string {
  const one = health.breaches.length === 1;
  const lines = health.breaches.map((b) => `- \`${b.cron}\`, latest ${utcMinute(b.atMs)}`);
  return (
    `${health.breaches.length} cron ${one ? "schedule" : "schedules"} had a tick take longer than ` +
    `${seconds(CRON_BUDGET_WARN_MS)} of wall time in the last day. The line is half the ` +
    `${seconds(CRON_CPU_LIMIT_MS)} CPU ceiling Cloudflare kills an invocation at.\n` +
    lines.join("\n") +
    undatedNote(health.unreadable) +
    `\n${NOT_CPU} Which lane took the time is under tag=cron msg="lane timings".`
  );
}

/** The all clear, on a measured day. It clears the wall time page and claims nothing about CPU. */
export function formatCronBudgetRecovery(health: Extract<CronBudgetHealth, { status: "within" }>): string {
  return (
    `No cron tick has taken longer than ${seconds(CRON_BUDGET_WARN_MS)} of wall time in the last day.` +
    undatedNote(health.unreadable) +
    `\n${NOT_CPU}`
  );
}

/**
 * The monitor lane's step. A throwing read is caught here so the check returns a typed verdict,
 * and an unmeasured tick returns before it can notify or resolve anything (#1134, #1152).
 */
export async function runCronBudgetCheck(deps: {
  nowMs: number;
  read: () => Promise<Record<string, number | null>>;
  verdictBoundMs: number;
  verdictLane: string;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  log?: (msg: string) => void;
}): Promise<CronBudgetHealth> {
  let stamps: Record<string, number | null> | null;
  try {
    stamps = await deps.read();
  } catch {
    stamps = null;
  }
  const health = cronBudgetHealth({
    stamps,
    nowMs: deps.nowMs,
    verdictBoundMs: deps.verdictBoundMs,
    verdictLane: deps.verdictLane,
  });
  if (health.status === "unmeasured") {
    deps.log?.(`monitor cron-budget: unmeasured, ${health.why}`);
    return health;
  }
  if (health.status === "over") {
    await deps
      .notify(CRON_BUDGET_ALERT_KEY, CRON_BUDGET_COOLDOWN_MS, formatCronBudgetAlert(health))
      .catch(() => {});
    deps.log?.(`monitor cron-budget: OVER crons=${health.breaches.map((b) => b.cron).join("|")}`);
    return health;
  }
  await deps.resolve(CRON_BUDGET_ALERT_KEY, formatCronBudgetRecovery(health)).catch(() => {});
  deps.log?.(`monitor cron-budget: within undated=${health.unreadable.join("|") || "none"}`);
  return health;
}
