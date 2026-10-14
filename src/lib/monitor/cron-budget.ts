/**
 * Cron CPU headroom, measured hourly from Cloudflare's own numbers (#3141).
 *
 * Every cron expression's invocation is killed at `limits.cpu_ms` in wrangler.jsonc, and until
 * #3693 the every minute one shared that budget across four lanes (see below for what placing
 * them changed). Cloudflare kills on CPU, not wall time.
 *
 * THE FIRST VERSION JUDGED WALL TIME, AND THAT IS SWITCHED OFF. The Workers runtime gives a
 * running invocation no reading of its own CPU, so #3168 timed each tick and paged when its WALL
 * time passed half the CPU ceiling. It fired on 2026-10-03 for the five minute tick at about 84s,
 * nearly all of it waiting on PostgREST and Google, which says nothing about the kill: the clock
 * advances only at I/O, so wall time is no bound on CPU in either direction (a load run tick
 * spent 119s of CPU while its clock barely moved, docs/cloudflare-platform-notes.md). Dan's
 * decision the same day: measure the real CPU, and stop the wall time page until that works.
 * Wall time is now a log line the Worker writes for a slow tick (`wallPastLine`), and nothing
 * pages on it or stores it.
 *
 * WHAT IS MEASURED NOW. On the hourly tick the Worker asks `/api/cron/cron-budget` to read
 * Cloudflare's GraphQL Analytics API: the raw `workersInvocationsScheduled` dataset, one row per
 * scheduled invocation of the production Worker over the trailing day, each carrying its own
 * `cpuTimeUs` and the `cron` that fired it. The dataset and its fields were measured against the
 * live schema on 2026-09-13 (`scripts/loadtest/platform-reading.ts`, which reads the same
 * dataset); Cloudflare's docs describe only `workersInvocationsAdaptive`, which mixes requests
 * and crons with no dimension to separate them, so it cannot answer this. Per schedule this keeps
 * the max and the p99, and pages when any schedule's max passes half the ceiling. One GraphQL
 * call an hour, on the hourly invocation, which is the only subrequest this spends.
 *
 * WHAT IS NOT A READING (L98, L215). A refused token, an HTTP failure, a 200 carrying GraphQL
 * errors, an empty day (a Worker with a minute cron cannot have one), a full page (it may be
 * truncated) and a row with no readable CPU are all unmeasured or held short of a clean day,
 * never zero. Unmeasured pages nothing and clears nothing, and the `verdict:cron-budget` stamp
 * is written only on a measured day, so a check that keeps failing to read goes stale and the
 * lane watchdog says so (#1394).
 *
 * NOT CONFIGURED. The read needs `CF_ANALYTICS_TOKEN`, an account token with Account Analytics
 * Read and nothing else. It is OPTIONAL: unset, the check says so once a day on the info channel
 * (`cron_cpu_not_configured`), pages nothing, claims nothing, spends no subrequest, and the
 * watchdog does not call its verdict lane blind (`unconfiguredDetector` in verdict-freshness.ts).
 * An open `cron_budget_headroom` page stays open until a measured day clears it, which needs the
 * token: there is no all clear without a measurement.
 *
 * WHAT THIS STOPPED SEEING (#3693). Each lane is now sent over the Worker's binding to itself
 * and runs as its own placed FETCH invocation, so a scheduled invocation's `cpuTimeUs` holds the
 * dispatcher plus any lane that fell back to in process, and NOT the placed lanes' own CPU. A
 * quiet reading here therefore no longer says a lane is far from its ceiling; each placed lane
 * has its own `limits.cpu_ms` as a request does. Reading the placed lanes' CPU needs a per
 * request dataset that names the path, which this does not query.
 *
 * PURE: every branch is driven offline by scripts/test-cron-budget.ts. Its value imports are
 * relative, so the node suite reads it without the alias hook.
 */
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { graphqlAccountRows, graphqlEnvelopeRefusal } from "../cloudflare/graphql-envelope.ts";

/**
 * `limits.cpu_ms` in wrangler.jsonc. The Worker cannot read its own config at runtime, so the
 * number lives here and scripts/test-cron-budget.ts holds it equal to the file.
 */
export const CRON_CPU_LIMIT_MS = 120_000;

/**
 * The share of the ceiling past which a schedule is worth a page. Half, the same margin the load
 * run's cron bar fails at (`CRON_CPU_MARGIN_SHARE` is this constant): the measured worst tick
 * reached 37 percent in July, and a lane that doubles from there should be found while there is
 * still room to trim it on purpose.
 */
export const CRON_BUDGET_WARN_SHARE = 0.5;

/** The line itself, derived rather than restated. CPU for the page, wall time for the log line. */
export const CRON_BUDGET_WARN_MS = CRON_CPU_LIMIT_MS * CRON_BUDGET_WARN_SHARE;

/** "The peak of the day": the trailing window each hourly read covers. */
export const CRON_BUDGET_WINDOW_MS = 24 * 60 * 60_000;

/**
 * alert_state key for the condition. The same key the wall time page used, deliberately: the
 * condition is still "a cron schedule is too close to its ceiling", and keeping the key is what
 * lets the first measured day clear the wall time page that was left open on 2026-10-03.
 */
export const CRON_BUDGET_ALERT_KEY = "cron_budget_headroom";

/**
 * Daily. Nothing anybody can do clears it inside the hour, and the window it judges is a day,
 * so an hourly repeat would restate one finding twenty four times (L36).
 */
export const CRON_BUDGET_COOLDOWN_MS = CRON_BUDGET_WINDOW_MS;

/** The info line an unset token sends, and how often. */
export const CRON_CPU_NOT_CONFIGURED_KEY = "cron_cpu_not_configured";
export const CRON_CPU_NOT_CONFIGURED_COOLDOWN_MS = CRON_BUDGET_WINDOW_MS;

/**
 * The cron expression whose tick runs the check: hourly, so a day's reading is at most an hour
 * old, and `scripts/test-cron-budget.ts` holds it to a trigger wrangler.jsonc really fires.
 */
export const CRON_BUDGET_VERDICT_CRON = "0 * * * *";

/** The in process route the Worker calls on that tick. */
export const CRON_BUDGET_ROUTE = "/api/cron/cron-budget";

/** The Worker secret holding the analytics token. Read by its literal name in the route. */
export const CF_ANALYTICS_TOKEN_ENV = "CF_ANALYTICS_TOKEN";

/** Cloudflare's GraphQL Analytics endpoint. */
export const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** wrangler.jsonc's `account_id` and `name`, held equal to the file by the suite. */
export const SLATE_ACCOUNT_ID = "3e7f907a9c19e51417873e2cce4fbc5c";
export const SLATE_SCRIPT_NAME = "slate";

/**
 * The page size asked for. A day of every trigger is about 2,000 rows, so a page that comes back
 * FULL is read as possibly truncated rather than as a day, because the worst tick may be past it.
 */
export const SCHEDULED_ROW_LIMIT = 10_000;

/** The raw dataset, one row per invocation. It has no `sum` or `quantiles`, so they are computed here. */
export const SCHEDULED_CPU_QUERY = `query($account:String!,$script:String!,$from:Time!,$to:Time!){
  viewer { accounts(filter:{accountTag:$account}) {
    workersInvocationsScheduled(limit:${SCHEDULED_ROW_LIMIT}, filter:{scriptName:$script, datetime_geq:$from, datetime_leq:$to}) {
      cpuTimeUs cron status
    } } }
}`;

/** RFC 3339 to the second, which the API's `Time` scalar takes. */
function rfc3339(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function cronCpuQueryVariables(nowMs: number): { account: string; script: string; from: string; to: string } {
  return {
    account: SLATE_ACCOUNT_ID,
    script: SLATE_SCRIPT_NAME,
    from: rfc3339(nowMs - CRON_BUDGET_WINDOW_MS),
    to: rfc3339(nowMs),
  };
}

/** Whether the Worker asks the app to run the check on this tick. Only the hourly one does. */
export function cronBudgetCallsApp(cron: string): boolean {
  return cron === CRON_BUDGET_VERDICT_CRON;
}

/** Whether a tick's WALL time is worth a log line. Strictly past the line; never a page. */
export function wallPastLine(wallMs: number): boolean {
  return wallMs > CRON_BUDGET_WARN_MS;
}

/** One schedule's day. Milliseconds, converted once from the API's microseconds. */
export interface CronCpu {
  cron: string;
  invocations: number;
  maxCpuMs: number;
  p99CpuMs: number;
}

export type CronCpuReading =
  | {
      ok: true;
      /** Worst max first. */
      crons: CronCpu[];
      invocations: number;
      /** Rows with no readable CPU or no cron: counted, never scored zero (L50). */
      unreadable: number;
    }
  | { ok: false; why: string };

/** Nearest rank, over values sorted ascending. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Read one answer. Every way it is not a reading carries its own sentence. */
export function readScheduledCpu(httpStatus: number, body: unknown): CronCpuReading {
  const refused = graphqlEnvelopeRefusal(httpStatus, body, "scheduled invocations");
  if (refused) return { ok: false, why: refused };
  const rows = graphqlAccountRows(body, "workersInvocationsScheduled");
  if (rows === null) {
    return { ok: false, why: "the analytics API answered with something that is not a scheduled invocation listing" };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      why: "the analytics API returned no scheduled invocations for the day, which a Worker with a minute cron cannot have, so the read is blind",
    };
  }
  if (rows.length >= SCHEDULED_ROW_LIMIT) {
    return { ok: false, why: `the analytics API returned a full page of ${rows.length} rows, so the day may be truncated` };
  }
  const byCron = new Map<string, number[]>();
  let unreadable = 0;
  for (const r of rows as { cpuTimeUs?: unknown; cron?: unknown }[]) {
    const us = r?.cpuTimeUs;
    const cron = r?.cron;
    if (typeof cron !== "string" || cron.trim() === "" || typeof us !== "number" || !Number.isFinite(us) || us < 0) {
      unreadable += 1;
      continue;
    }
    const list = byCron.get(cron) ?? [];
    // MICROSECONDS to milliseconds. A reading a thousand times too small passes every bar.
    list.push(us / 1000);
    byCron.set(cron, list);
  }
  const crons: CronCpu[] = [...byCron.entries()].map(([cron, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { cron, invocations: sorted.length, maxCpuMs: sorted[sorted.length - 1], p99CpuMs: percentile(sorted, 99) };
  });
  crons.sort((a, b) => b.maxCpuMs - a.maxCpuMs || a.cron.localeCompare(b.cron));
  return { ok: true, crons, invocations: rows.length, unreadable };
}

export type CronCpuHealth =
  | { status: "not-configured" }
  | { status: "unmeasured"; why: string }
  | { status: "over"; over: CronCpu[]; crons: CronCpu[]; invocations: number; unreadable: number }
  | { status: "within"; crons: CronCpu[]; invocations: number };

/**
 * The verdict over one reading. A breach is a positive measurement and pages even beside rows
 * that could not be read; a clean day needs every row read, because the unread one may be the
 * heavy tick.
 */
export function judgeCronCpu(reading: CronCpuReading): Exclude<CronCpuHealth, { status: "not-configured" }> {
  if (!reading.ok) return { status: "unmeasured", why: reading.why };
  const over = reading.crons.filter((c) => c.maxCpuMs > CRON_BUDGET_WARN_MS);
  if (over.length > 0) {
    return { status: "over", over, crons: reading.crons, invocations: reading.invocations, unreadable: reading.unreadable };
  }
  if (reading.unreadable > 0) {
    return {
      status: "unmeasured",
      why: `${reading.unreadable} of ${reading.invocations} scheduled invocations carried no readable CPU, so the day cannot be called under the line`,
    };
  }
  return { status: "within", crons: reading.crons, invocations: reading.invocations };
}

/** Did this check measure a day? The `verdict:cron-budget` stamp hangs off this alone. */
export function cronCpuReachedVerdict(health: CronCpuHealth): boolean {
  return health.status === "over" || health.status === "within";
}

function secs(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

function cronLine(c: CronCpu): string {
  return `- \`${c.cron}\`, max ${secs(c.maxCpuMs)}, p99 ${secs(c.p99CpuMs)} over ${c.invocations.toLocaleString("en-US")} ${c.invocations === 1 ? "tick" : "ticks"}`;
}

const SOURCE = `Read from Cloudflare's \`cpuTimeUs\` for each scheduled invocation (workersInvocationsScheduled).`;

/** The page. Names each schedule past the line with its max and p99. */
export function formatCronCpuAlert(health: Extract<CronCpuHealth, { status: "over" }>): string {
  const one = health.over.length === 1;
  const unread =
    health.unreadable > 0
      ? `\n${health.unreadable} ${health.unreadable === 1 ? "invocation" : "invocations"} in the day had no readable CPU and ${health.unreadable === 1 ? "is" : "are"} not counted.`
      : "";
  return (
    `${health.over.length} cron ${one ? "schedule" : "schedules"} used more than ${secs(CRON_BUDGET_WARN_MS)} of CPU ` +
    `in one tick in the last day. That is half the ${secs(CRON_CPU_LIMIT_MS)} ceiling Cloudflare kills an invocation at.\n` +
    health.over.map(cronLine).join("\n") +
    unread +
    `\n${SOURCE} Which lane took the time is under tag=cron msg="lane timings".`
  );
}

/** The all clear, on a measured day. Says what was measured, over how many ticks. */
export function formatCronCpuRecovery(health: Extract<CronCpuHealth, { status: "within" }>): string {
  const worst = health.crons[0];
  return (
    `No cron schedule used more than ${secs(CRON_BUDGET_WARN_MS)} of CPU in one tick in the last day, ` +
    `across ${health.invocations.toLocaleString("en-US")} scheduled invocations.` +
    (worst ? ` The worst was \`${worst.cron}\` at ${secs(worst.maxCpuMs)}.` : "") +
    // #3693: a placed lane runs as its own request, so its CPU is not in this figure, and an
    // all clear may claim only what was read (L11).
    ` This counts the scheduled invocations only: a lane that ran placed is its own request and its CPU is not included.` +
    `\n${SOURCE}`
  );
}

/** The daily info line while the token is unset. It claims nothing about headroom. */
export function formatCronCpuNotConfigured(): string {
  return (
    `Cron CPU headroom is not measured: the Worker has no ${CF_ANALYTICS_TOKEN_ENV} secret, so nothing reads ` +
    `Cloudflare's CPU figures for the scheduled invocations. Nothing will page about cron CPU until it is set, ` +
    `and an open cron_budget_headroom page stays open until a measured day clears it. ` +
    `DEPLOY.md says how to create the token.`
  );
}

/** What the check needs. `post` is the one network call; it is handed the bearer header whole. */
export interface CronCpuDeps {
  /** The secret's value as read; undefined or blank is not configured. */
  token: string | undefined;
  nowMs: number;
  /** POST a JSON body. Answers the status and the parsed body (null when it was not JSON). */
  post: (url: string, authorization: string, body: string) => Promise<{ status: number; body: unknown }>;
  notify: ThrottledNotify;
  info: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  log?: (msg: string) => void;
}

/** Remove the token from any text before it is logged, in case an answer echoes it. */
function scrub(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("[token]") : text;
}

/**
 * The hourly check. A throwing call is caught so it returns a typed verdict, and an unmeasured or
 * unset day returns before it can page or clear anything (#1134, #1152).
 */
export async function runCronCpuCheck(deps: CronCpuDeps): Promise<CronCpuHealth> {
  const token = (deps.token ?? "").trim();
  if (token === "") {
    await deps
      .info(CRON_CPU_NOT_CONFIGURED_KEY, CRON_CPU_NOT_CONFIGURED_COOLDOWN_MS, formatCronCpuNotConfigured())
      .catch(logAlertSendFailure(CRON_CPU_NOT_CONFIGURED_KEY));
    deps.log?.(`cron cpu: not configured, ${CF_ANALYTICS_TOKEN_ENV} is unset`);
    return { status: "not-configured" };
  }
  let reading: CronCpuReading;
  try {
    const answer = await deps.post(
      CF_GRAPHQL_URL,
      `Bearer ${token}`,
      JSON.stringify({ query: SCHEDULED_CPU_QUERY, variables: cronCpuQueryVariables(deps.nowMs) }),
    );
    reading = readScheduledCpu(answer.status, answer.body);
  } catch (err) {
    reading = { ok: false, why: `the analytics API call threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const health = judgeCronCpu(reading);
  if (health.status === "unmeasured") {
    deps.log?.(scrub(`cron cpu: unmeasured, ${health.why}`, token));
    return health;
  }
  if (health.status === "over") {
    await deps
      .notify(CRON_BUDGET_ALERT_KEY, CRON_BUDGET_COOLDOWN_MS, formatCronCpuAlert(health))
      .catch(logAlertSendFailure(CRON_BUDGET_ALERT_KEY));
    deps.log?.(`cron cpu: OVER ${health.over.map((c) => `${c.cron}=${Math.round(c.maxCpuMs)}ms`).join("|")}`);
    return health;
  }
  await deps
    .resolve(CRON_BUDGET_ALERT_KEY, formatCronCpuRecovery(health))
    .catch(logResolveFailure(CRON_BUDGET_ALERT_KEY));
  deps.log?.(`cron cpu: within ${health.crons.map((c) => `${c.cron}=${Math.round(c.maxCpuMs)}ms`).join("|")}`);
  return health;
}
