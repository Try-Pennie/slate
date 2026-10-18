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
 * WHAT IS MEASURED NOW. On the hourly tick the Worker asks `/api/cron/cron-budget` to query the
 * Worker logs (the Workers Observability telemetry API): every scheduled invocation of the
 * production Worker over the trailing day, grouped by `$workers.event.cron`, with the max and p99
 * of `$workers.cpuTimeMs` and two counts. Pages when any schedule's max passes half the ceiling.
 * One query an hour, on the hourly invocation, which is the only subrequest this spends.
 *
 * WHY THE LOGS AND NOT THE ANALYTICS. #3141 read the raw `workersInvocationsScheduled` GraphQL
 * dataset, which Cloudflare never documented. It stopped being filled for EVERY Worker on the
 * account at 2026-10-16T15:21:42Z while the crons kept firing, measured 2026-10-18, so the check
 * reported unmeasured for two days and the watchdog paged. The documented
 * `workersInvocationsAdaptive` mixes requests and crons with no dimension to separate them, so it
 * cannot answer this. The logs carry the cron and the CPU on every scheduled invocation.
 *
 * THE LOGS ARE SAMPLED at high volume: on 2026-10-18 the minute cron came back with a sample
 * interval of about 1.05, so roughly one tick in twenty was not kept. A breach is still a breach,
 * but a clean SAMPLED day may have missed its worst tick, so the reading carries `sampled` and the
 * all clear says so rather than claiming every tick (L11). The logs' query pipeline can also run
 * behind (about three hours on 2026-08-17, AGENTS.md), which only shortens the newest end of the
 * day: a heavy tick there is found by a later hourly read, still inside its day.
 *
 * WHAT IS NOT A READING (L98, L215). A refused token, an HTTP failure, a body that says it failed,
 * an empty day (a Worker with a minute cron cannot have one), a full set of groups (it may be
 * truncated) and a tick with no CPU figure are all unmeasured or held short of a clean day,
 * never zero. Unmeasured pages nothing and clears nothing, and the `verdict:cron-budget` stamp
 * is written only on a measured day, so a check that keeps failing to read goes stale and the
 * lane watchdog says so (#1394).
 *
 * NOT CONFIGURED. The read needs `CF_ANALYTICS_TOKEN`, an account token with Workers
 * Observability Read (the name predates the move to the logs, and renaming the secret would cost a
 * deploy step for nothing). It is OPTIONAL: unset, the check says so once a day on the info channel
 * (`cron_cpu_not_configured`), pages nothing, claims nothing, spends no subrequest, and the
 * watchdog does not call its verdict lane blind (`unconfiguredDetector` in verdict-freshness.ts).
 * An open `cron_budget_headroom` page stays open until a measured day clears it, which needs the
 * token: there is no all clear without a measurement.
 *
 * WHAT THIS STOPPED SEEING (#3693). Each lane is now sent over the Worker's binding to itself
 * and runs as its own placed FETCH invocation, so a scheduled invocation's `$workers.cpuTimeMs` holds the
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

/** The Worker secret holding the Cloudflare token. Read by its literal name in the route. */
export const CF_ANALYTICS_TOKEN_ENV = "CF_ANALYTICS_TOKEN";

/** wrangler.jsonc's `account_id` and `name`, held equal to the file by the suite. */
export const SLATE_ACCOUNT_ID = "3e7f907a9c19e51417873e2cce4fbc5c";
export const SLATE_SCRIPT_NAME = "slate";

/** The Workers Logs query endpoint for the production account. */
export const CF_TELEMETRY_URL = `https://api.cloudflare.com/client/v4/accounts/${SLATE_ACCOUNT_ID}/workers/observability/telemetry/query`;

/** Whether the Worker asks the app to run the check on this tick. Only the hourly one does. */
export function cronBudgetCallsApp(cron: string): boolean {
  return cron === CRON_BUDGET_VERDICT_CRON;
}

/** Whether a tick's WALL time is worth a log line. Strictly past the line; never a page. */
export function wallPastLine(wallMs: number): boolean {
  return wallMs > CRON_BUDGET_WARN_MS;
}

/** One schedule's day. Milliseconds, as the logs report them. */
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
      /** Ticks with no readable CPU or no cron: counted, never scored zero (L50). */
      unreadable: number;
      /** The logs kept only a sample of some schedule's ticks, so its worst may be missing. */
      sampled: boolean;
    }
  | { ok: false; why: string };

/**
 * More groups than wrangler.jsonc has triggers (eleven on 2026-10-18). A listing that comes back
 * with this many is read as possibly truncated rather than as a day.
 */
export const CRON_CPU_GROUP_LIMIT = 50;

const CRON_KEY = "$workers.event.cron";
const CPU_KEY = "$workers.cpuTimeMs";

/** The one query: a day of the production Worker's scheduled invocations, per cron schedule. */
export function cronCpuQueryBody(nowMs: number): unknown {
  return {
    queryId: "slate-cron-cpu",
    view: "calculations",
    timeframe: { from: nowMs - CRON_BUDGET_WINDOW_MS, to: nowMs },
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        { key: "$workers.scriptName", operation: "eq", type: "string", value: SLATE_SCRIPT_NAME },
        { key: "$workers.eventType", operation: "eq", type: "string", value: "scheduled" },
      ],
      calculations: [
        { operator: "max", key: CPU_KEY, keyType: "number", alias: "max_cpu" },
        { operator: "p99", key: CPU_KEY, keyType: "number", alias: "p99_cpu" },
        { operator: "count", key: CPU_KEY, keyType: "number", alias: "with_cpu" },
        { operator: "count", alias: "n" },
      ],
      groupBys: [{ type: "string", value: CRON_KEY }],
      limit: CRON_CPU_GROUP_LIMIT,
    },
  };
}

interface Aggregate {
  groups?: { key?: unknown; value?: unknown }[];
  value?: unknown;
  sampleInterval?: unknown;
}

const finiteAtLeastZero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The API's own words for a refusal, quoted rather than summarised. */
function apiErrors(body: unknown): string {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return "";
  const messages = errors
    .map((e) => (e as { message?: unknown })?.message)
    .filter((m): m is string => typeof m === "string" && m.trim() !== "");
  return messages.length > 0 ? `: ${messages.join("; ")}` : "";
}

/** Read one answer. Every way it is not a reading carries its own sentence. */
export function readScheduledCpu(httpStatus: number, body: unknown): CronCpuReading {
  const ok = httpStatus >= 200 && httpStatus < 300 && (body as { success?: unknown } | null)?.success === true;
  if (!ok) {
    const permission =
      httpStatus === 401 || httpStatus === 403
        ? ", and the token may lack the Workers Observability Read permission the logs need"
        : "";
    if (body === null || typeof body !== "object") {
      return { ok: false, why: `the Workers Logs API answered HTTP ${httpStatus} with a body that is not JSON${permission}` };
    }
    return { ok: false, why: `the Workers Logs API refused the query with HTTP ${httpStatus}${apiErrors(body)}${permission}` };
  }
  const calculations = (body as { result?: { calculations?: unknown } }).result?.calculations;
  if (!Array.isArray(calculations)) {
    return { ok: false, why: "the Workers Logs API answered with something that is not a calculation listing" };
  }
  const byAlias = new Map<string, Aggregate[]>();
  for (const c of calculations as { alias?: unknown; aggregates?: unknown }[]) {
    if (typeof c?.alias === "string" && Array.isArray(c.aggregates)) byAlias.set(c.alias, c.aggregates as Aggregate[]);
  }
  const missing = ["max_cpu", "p99_cpu", "with_cpu", "n"].filter((a) => !byAlias.has(a));
  if (missing.length > 0) {
    return { ok: false, why: `the Workers Logs API left out ${missing.join(", ")}, so the day cannot be read` };
  }
  const cronOf = (a: Aggregate): string | null => {
    const v = a.groups?.find((g) => g?.key === CRON_KEY)?.value;
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const valueByCron = (alias: string) => {
    const out = new Map<string, unknown>();
    for (const a of byAlias.get(alias) ?? []) {
      const cron = cronOf(a);
      if (cron !== null) out.set(cron, a.value);
    }
    return out;
  };
  const counts = byAlias.get("n") ?? [];
  if (counts.length === 0) {
    return {
      ok: false,
      why: "the Worker logs held no scheduled invocations for the day, which a Worker with a minute cron cannot have, so the read is blind",
    };
  }
  if (counts.length >= CRON_CPU_GROUP_LIMIT) {
    return { ok: false, why: `the Workers Logs API returned ${counts.length} cron groups, the most asked for, so the day may be truncated` };
  }
  const maxes = valueByCron("max_cpu");
  const p99s = valueByCron("p99_cpu");
  const withCpu = valueByCron("with_cpu");
  const crons: CronCpu[] = [];
  let invocations = 0;
  let unreadable = 0;
  let sampled = false;
  for (const a of counts) {
    const n = finiteAtLeastZero(a.value) ? Math.round(a.value) : 0;
    invocations += n;
    if (typeof a.sampleInterval === "number" && a.sampleInterval > 1) sampled = true;
    const cron = cronOf(a);
    const max = cron === null ? undefined : maxes.get(cron);
    const p99 = cron === null ? undefined : p99s.get(cron);
    // No cron, or a worst that is not a number: every tick of the group is unread (L50).
    if (cron === null || !finiteAtLeastZero(max) || !finiteAtLeastZero(p99)) {
      unreadable += n;
      continue;
    }
    const read = withCpu.get(cron);
    if (finiteAtLeastZero(read) && read < n) unreadable += n - Math.round(read);
    // Already MILLISECONDS: the logs' field is cpuTimeMs.
    crons.push({ cron, invocations: n, maxCpuMs: max, p99CpuMs: p99 });
  }
  crons.sort((a, b) => b.maxCpuMs - a.maxCpuMs || a.cron.localeCompare(b.cron));
  return { ok: true, crons, invocations, unreadable, sampled };
}

export type CronCpuHealth =
  | { status: "not-configured" }
  | { status: "unmeasured"; why: string }
  | { status: "over"; over: CronCpu[]; crons: CronCpu[]; invocations: number; unreadable: number; sampled: boolean }
  | { status: "within"; crons: CronCpu[]; invocations: number; sampled: boolean };

/**
 * The verdict over one reading. A breach is a positive measurement and pages even beside rows
 * that could not be read; a clean day needs every row read, because the unread one may be the
 * heavy tick.
 */
export function judgeCronCpu(reading: CronCpuReading): Exclude<CronCpuHealth, { status: "not-configured" }> {
  if (!reading.ok) return { status: "unmeasured", why: reading.why };
  const over = reading.crons.filter((c) => c.maxCpuMs > CRON_BUDGET_WARN_MS);
  if (over.length > 0) {
    return {
      status: "over",
      over,
      crons: reading.crons,
      invocations: reading.invocations,
      unreadable: reading.unreadable,
      sampled: reading.sampled,
    };
  }
  if (reading.unreadable > 0) {
    return {
      status: "unmeasured",
      why: `${reading.unreadable} of ${reading.invocations} scheduled invocations carried no readable CPU, so the day cannot be called under the line`,
    };
  }
  return { status: "within", crons: reading.crons, invocations: reading.invocations, sampled: reading.sampled };
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

const SOURCE = `Read from the Worker logs' CPU time for each scheduled invocation.`;

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
    (health.sampled ? ` The logs sampled the busiest schedules, so a tick not kept could have been heavier.` : "") +
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
      CF_TELEMETRY_URL,
      `Bearer ${token}`,
      JSON.stringify(cronCpuQueryBody(deps.nowMs)),
    );
    reading = readScheduledCpu(answer.status, answer.body);
  } catch (err) {
    reading = { ok: false, why: `the Workers Logs API call threw: ${err instanceof Error ? err.message : String(err)}` };
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
  deps.log?.(
    `cron cpu: within${health.sampled ? " (sampled)" : ""} ${health.crons.map((c) => `${c.cron}=${Math.round(c.maxCpuMs)}ms`).join("|")}`,
  );
  return health;
}
