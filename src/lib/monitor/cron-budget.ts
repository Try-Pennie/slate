/**
 * Cron CPU headroom, watched every day instead of measured by hand (#3141).
 *
 * Every cron expression's invocation is killed at `limits.cpu_ms` in wrangler.jsonc, and the
 * every minute one shares that budget across four lanes. Until now the headroom was read by hand
 * from Cloudflare's analytics (docs/cloudflare-platform-notes.md), so a lane growing toward the
 * ceiling was found by whoever next thought to look, or by the kill.
 *
 * WHAT THIS MEASURES IS WALL TIME, NOT CPU, AND THE NAME SAYS SO (L11). The Workers runtime
 * gives a running invocation no reading of its own CPU, and the analytics that do hold it need
 * an account API token the deployment does not carry. So the Worker times each invocation's
 * lanes (`lane-timing.ts`, #1245) and judges the slowest against half the CPU ceiling. Two
 * properties make that an honest stand in rather than a guess:
 *
 *  - It reads HIGH, never low, over everything up to a lane's last I/O. The Worker's clock
 *    advances only at I/O, so CPU spent computing is counted at the next await, and every wait
 *    on PostgREST or Google is counted on top. A warning here can be wait rather than CPU; a
 *    tick under the line was under it in CPU too.
 *  - The one thing it cannot see is CPU spent AFTER a lane's last I/O. Every lane ends by
 *    answering its request, which is I/O, so that tail is the lane's response serialisation.
 *
 * So a page here means "check the CPU for these ticks", and the copy says where.
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
 * `unreadable` names the schedules whose breach row exists and whose time cannot be read. They
 * are neither a breach nor a clear: an undated row can never age out of the window, so counting
 * it as a breach would page for ever and never let the all clear fire (L665), and counting it as
 * old would clear on a row that may be minutes old. The next breach on that schedule rewrites
 * the row with a real time, which is what ends it.
 */
export type CronBudgetHealth =
  | { status: "unmeasured"; why: string; unreadable: string[] }
  | { status: "over"; breaches: CronBudgetBreach[]; unreadable: string[] }
  | { status: "within" };

/**
 * The verdict over every stamp in `lane_heartbeats`.
 *
 * `stamps` null is a read that failed. A stored stamp that cannot be parsed arrives as 0 (the
 * heartbeat reader's sentinel, #1169). A breach row carrying it is UNMEASURED: it pages only
 * beside a real breach, where the page names it, and on its own it keeps the all clear back
 * without paging (see `CronBudgetHealth`).
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
  if (unreadable.length > 0) {
    return {
      status: "unmeasured",
      why:
        `the breach row for ${unreadable.sort().join(", ")} carries a time that cannot be read, so ` +
        `this cannot tell whether it is inside the last day`,
      unreadable,
    };
  }
  const verdictMs = input.stamps[input.verdictLane];
  if (verdictMs === undefined || verdictMs === null) {
    return {
      status: "unmeasured",
      why: "the Worker has never recorded a cron timing, so a quiet day here proves nothing",
      unreadable: [],
    };
  }
  if (input.nowMs - verdictMs > input.verdictBoundMs) {
    return {
      status: "unmeasured",
      why: "the Worker's hourly timing stamp is stale, so it may have stopped recording past the line ticks",
      unreadable: [],
    };
  }
  return { status: "within" };
}

/** UTC, to the minute, with the date: the window is a day and spans two of them. */
function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** The page. Names each schedule and its latest tick, and where the CPU for it is read. */
export function formatCronBudgetAlert(health: Extract<CronBudgetHealth, { status: "over" }>): string {
  const one = health.breaches.length === 1;
  const lines = health.breaches.map((b) => `- \`${b.cron}\`, latest ${utcMinute(b.atMs)}`);
  const undated = health.unreadable.length
    ? `\nNot judged: the row for ${health.unreadable.map((c) => `\`${c}\``).join(", ")} in ` +
      `lane_heartbeats carries a time that cannot be read, so whether it falls in the last day is ` +
      `unknown. Its next tick past the line rewrites it.`
    : "";
  return (
    `${health.breaches.length} cron ${one ? "schedule" : "schedules"} had a tick take longer than ` +
    `${seconds(CRON_BUDGET_WARN_MS)} of wall time in the last day, half the ` +
    `${seconds(CRON_CPU_LIMIT_MS)} CPU ceiling Cloudflare kills an invocation at.\n` +
    lines.join("\n") +
    undated +
    `\nWall time runs at or above CPU, so read the real CPU for those ticks before trimming ` +
    `anything: cpuTimeUs in workersInvocationsScheduled. Which lane took the time is under ` +
    `tag=cron msg="lane timings".`
  );
}

/** The all clear, on a measured day. */
export function formatCronBudgetRecovery(): string {
  return (
    `No cron tick has run longer than ${seconds(CRON_BUDGET_WARN_MS)} in the last day, so every ` +
    `schedule is back under half its ${seconds(CRON_CPU_LIMIT_MS)} CPU ceiling.`
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
  await deps.resolve(CRON_BUDGET_ALERT_KEY, formatCronBudgetRecovery()).catch(() => {});
  deps.log?.("monitor cron-budget: within");
  return health;
}
