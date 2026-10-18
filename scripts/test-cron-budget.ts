// #3141: cron CPU headroom, watched daily instead of read by hand.
//
// The first version judged WALL time, because the Worker cannot read its own CPU, and it paged
// on 2026-10-03 for a five minute tick that spent about 84s mostly waiting on I/O. Cloudflare
// kills an invocation on CPU, not wall time, so that page was weak evidence, and Dan's decision
// the same day was to measure the real CPU and switch the wall time page off. What this pins:
//
//   - the ceiling, the account and the script are the ones wrangler.jsonc really sets, and the
//     cron that runs the check really fires;
//   - the load run's bar and this check share one ceiling and one margin (L41);
//   - the reading: per cron schedule, the max and the p99 of the Worker logs' `cpuTimeMs`; a
//     refused, empty, truncated or partly unreadable answer is unmeasured, never zero (L98), and a
//     sampled day says it was sampled;
//   - the verdict: over pages, a measured day under the line is the all clear, and an unset
//     token, a failed read or an unmeasured answer page nothing and clear nothing (#1134);
//   - an unset token says so once a day on the info channel, and never claims health;
//   - the token never reaches a log line or a message;
//   - wall time is a log line now, never a page, never a write;
//   - the Worker, the route and the monitor lane are really wired to it (L3).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cron-budget.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  CF_ANALYTICS_TOKEN_ENV,
  CF_TELEMETRY_URL,
  CRON_CPU_GROUP_LIMIT,
  CRON_BUDGET_ALERT_KEY,
  CRON_BUDGET_COOLDOWN_MS,
  CRON_BUDGET_ROUTE,
  CRON_BUDGET_VERDICT_CRON,
  CRON_BUDGET_WARN_MS,
  CRON_BUDGET_WARN_SHARE,
  CRON_BUDGET_WINDOW_MS,
  CRON_CPU_LIMIT_MS,
  CRON_CPU_NOT_CONFIGURED_COOLDOWN_MS,
  CRON_CPU_NOT_CONFIGURED_KEY,
  SLATE_ACCOUNT_ID,
  SLATE_SCRIPT_NAME,
  cronBudgetCallsApp,
  cronCpuQueryBody,
  cronCpuReachedVerdict,
  formatCronCpuAlert,
  formatCronCpuNotConfigured,
  formatCronCpuRecovery,
  judgeCronCpu,
  readScheduledCpu,
  runCronCpuCheck,
  wallPastLine,
  type CronCpuHealth,
} from "../src/lib/monitor/cron-budget.ts";
import { DETECTOR_REQUIRED_SETTING, unconfiguredDetector } from "../src/lib/monitor/verdict-freshness.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { alertEntry } from "../src/lib/notify/alert-catalog.ts";
import { alertFamily } from "../src/lib/notify/alert-runbook.ts";
import { recordCronBudget, TICK_ID_HEADER, type LaneRunDeps } from "../worker/lane-run.ts";
import { WRANGLER_CRON_CPU_MS } from "./loadtest/platform-reading.ts";
import { CRON_CPU_MARGIN_SHARE } from "./loadtest/judge-booking-run.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const VERDICT = "verdict:cron-budget";
const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 3, 15, 0);
const TOKEN = "cf-test-token-0123456789abcdef";

// --- the numbers are the deployment's ------------------------------------------
{
  const wrangler = read("wrangler.jsonc");
  const limit = /"limits"\s*:\s*\{\s*"cpu_ms"\s*:\s*(\d+)/.exec(wrangler);
  assert(limit !== null, "wrangler.jsonc still declares limits.cpu_ms where this reads it");
  eq(CRON_CPU_LIMIT_MS, Number(limit?.[1]), "CRON_CPU_LIMIT_MS is wrangler.jsonc's limits.cpu_ms");
  eq(CRON_BUDGET_WARN_MS, CRON_CPU_LIMIT_MS * CRON_BUDGET_WARN_SHARE, "the line is derived from the ceiling");
  eq(CRON_BUDGET_WARN_SHARE, 0.5, "the line is half the ceiling, as #3141 asked");
  const account = /"account_id"\s*:\s*"([0-9a-f]{32})"/.exec(wrangler);
  eq(SLATE_ACCOUNT_ID, account?.[1], "the account queried is wrangler.jsonc's account_id");
  const name = /^\s*"name"\s*:\s*"([^"]+)"/m.exec(wrangler);
  eq(SLATE_SCRIPT_NAME, name?.[1], "the script queried is the production Worker's name");
  assert(
    wrangler.includes(`"${CRON_BUDGET_VERDICT_CRON}"`) && CRON_BUDGET_VERDICT_CRON in CRON_ROUTES,
    "the cron that runs the CPU check is a trigger wrangler.jsonc really fires",
  );
  eq(WRANGLER_CRON_CPU_MS, CRON_CPU_LIMIT_MS, "the load run judges against the same ceiling");
  eq(CRON_CPU_MARGIN_SHARE, CRON_BUDGET_WARN_SHARE, "and fails at the same margin this warns at");
  eq(
    CF_TELEMETRY_URL,
    `https://api.cloudflare.com/client/v4/accounts/${SLATE_ACCOUNT_ID}/workers/observability/telemetry/query`,
    "the Workers Logs query endpoint, on the production account",
  );
  eq(CF_ANALYTICS_TOKEN_ENV, "CF_ANALYTICS_TOKEN", "the secret's name");
  eq(DETECTOR_REQUIRED_SETTING[VERDICT], CF_ANALYTICS_TOKEN_ENV, "the watchdog knows the verdict lane needs the same secret");
}

// --- the query asks the Worker logs for each schedule's CPU ------------------------
{
  // #3141 read the raw `workersInvocationsScheduled` analytics dataset. Cloudflare stopped
  // filling it for every Worker on the account at 2026-10-16T15:21:42Z while the crons kept
  // firing, so the check went blind. The Worker logs record `$workers.cpuTimeMs` and
  // `$workers.event.cron` on every scheduled invocation, measured against production 2026-10-18.
  const body = cronCpuQueryBody(NOW) as {
    view: string;
    timeframe: { from: number; to: number };
    parameters: {
      datasets: string[];
      filters: { key: string; operation: string; value: unknown }[];
      calculations: { operator: string; key?: string; alias: string }[];
      groupBys: { value: string }[];
      limit: number;
    };
  };
  eq(body.view, "calculations", "an aggregate, not a list of events");
  eq(body.timeframe, { from: NOW - CRON_BUDGET_WINDOW_MS, to: NOW }, "over the trailing day, in epoch milliseconds");
  eq(body.parameters.datasets, ["cloudflare-workers"], "the Workers dataset");
  const filter = (key: string) => body.parameters.filters.find((f) => f.key === key);
  eq(filter("$workers.scriptName")?.value, SLATE_SCRIPT_NAME, "filtered on the production script");
  eq(filter("$workers.eventType")?.value, "scheduled", "and on scheduled invocations only, never requests");
  eq(body.parameters.groupBys.map((g) => g.value), ["$workers.event.cron"], "one group per cron schedule");
  const calc = (alias: string) => body.parameters.calculations.find((c) => c.alias === alias);
  eq([calc("max_cpu")?.operator, calc("max_cpu")?.key], ["max", "$workers.cpuTimeMs"], "the worst tick");
  eq([calc("p99_cpu")?.operator, calc("p99_cpu")?.key], ["p99", "$workers.cpuTimeMs"], "the p99");
  eq([calc("with_cpu")?.operator, calc("with_cpu")?.key], ["count", "$workers.cpuTimeMs"], "how many carried a CPU figure");
  eq([calc("n")?.operator, calc("n")?.key], ["count", undefined], "and how many there were");
  eq(body.parameters.limit, CRON_CPU_GROUP_LIMIT, "asking for more groups than wrangler.jsonc has triggers");
}

// --- reading the answer ------------------------------------------------------------
interface Group {
  cron: string;
  n: number;
  max: unknown;
  p99?: unknown;
  withCpu?: number;
  sampleInterval?: number;
}
const aggregate = (alias: string, groups: Group[], value: (g: Group) => unknown) => ({
  alias,
  aggregates: groups.map((g) => ({
    groupKey: g.cron,
    groups: [{ key: "$workers.event.cron", value: g.cron }],
    value: value(g),
    count: g.n,
    sampleInterval: g.sampleInterval ?? 1,
  })),
});
const envelope = (groups: Group[]) => ({
  success: true,
  errors: [],
  result: {
    calculations: [
      aggregate("max_cpu", groups, (g) => g.max),
      aggregate("p99_cpu", groups, (g) => g.p99 ?? g.max),
      aggregate("with_cpu", groups, (g) => g.withCpu ?? g.n),
      aggregate("n", groups, (g) => g.n),
    ],
  },
});
const group = (cron: string, maxMs: unknown, over: Partial<Group> = {}): Group => ({ cron, n: 10, max: maxMs, ...over });
{
  const r = readScheduledCpu(
    200,
    envelope([group("* * * * *", 10_000, { n: 1440, p99: 9_900 }), group("*/5 * * * *", 70_000, { n: 288, p99: 1_500 })]),
  );
  assert(r.ok, "a well formed answer reads");
  if (r.ok) {
    eq(r.invocations, 1728, "every invocation counted");
    eq(r.crons.map((c) => c.cron), ["*/5 * * * *", "* * * * *"], "worst first");
    const minute = r.crons.find((c) => c.cron === "* * * * *");
    eq(minute?.maxCpuMs, 10_000, "the logs report MILLISECONDS, taken as they are");
    eq(minute?.p99CpuMs, 9_900, "the p99 as the logs computed it");
    eq(minute?.invocations, 1440, "per cron counts");
    eq(r.crons[0].maxCpuMs, 70_000, "the five minute schedule's worst");
    eq(r.sampled, false, "a day kept whole is not called sampled");
  }
  const sampled = readScheduledCpu(200, envelope([group("* * * * *", 10_000, { sampleInterval: 1.05 })]));
  assert(sampled.ok && sampled.sampled, "a day the logs sampled says so, because its worst tick may not be in it");

  const refusals: [string, ReturnType<typeof readScheduledCpu>][] = [
    ["an HTTP refusal", readScheduledCpu(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] })],
    ["a 200 that says it failed", readScheduledCpu(200, { success: false, errors: [{ code: 1, message: "bad query" }] })],
    ["a body that is not a listing", readScheduledCpu(200, { success: true, result: {} })],
    ["a listing missing a calculation", readScheduledCpu(200, { success: true, result: { calculations: [aggregate("n", [group("* * * * *", 1)], (g) => g.n)] } })],
    ["an empty day, which cannot be true of a Worker with a minute cron", readScheduledCpu(200, envelope([]))],
    [
      "a full set of groups, which may be truncated",
      readScheduledCpu(200, envelope(Array.from({ length: CRON_CPU_GROUP_LIMIT }, (_, i) => group(`${i} * * * *`, 1)))),
    ],
    ["a body that is not JSON", readScheduledCpu(200, null)],
  ];
  for (const [why, got] of refusals) {
    assert(!got.ok, `${why} is not a reading`);
    if (!got.ok) assert(got.why.length > 0, `${why} says why`);
  }
  const quoted = readScheduledCpu(400, { success: false, errors: [{ code: 7003, message: "unknown key $workers.cpuTimeMs" }] });
  assert(!quoted.ok && quoted.why.includes("unknown key $workers.cpuTimeMs"), "the API's own refusal is quoted, not summarised");
  const forbidden = readScheduledCpu(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  assert(!forbidden.ok && /Workers Observability/.test(forbidden.why), "a refused token names the permission the logs need");
  // A tick with no readable CPU could be the heavy one, so a day carrying one is never clean.
  const partial = readScheduledCpu(200, envelope([group("* * * * *", 1_000, { n: 10, withCpu: 8 })]));
  assert(partial.ok, "a partly unreadable day still reads");
  if (partial.ok) {
    eq(partial.unreadable, 2, "a tick with no CPU figure is counted, never scored zero");
    eq(judgeCronCpu(partial).status, "unmeasured", "and holds the all clear back");
  }
  const noNumber = readScheduledCpu(200, envelope([group("* * * * *", "x", { n: 5 }), group("*/5 * * * *", 1_000, { n: 3 })]));
  assert(noNumber.ok && noNumber.unreadable === 5, "a schedule whose worst is not a number counts all its ticks unreadable");
  // A schedule whose count of ticks carrying CPU is missing or not a number cannot vouch for any
  // of its ticks, so they are all unread rather than all read.
  const noCount = readScheduledCpu(200, envelope([group("* * * * *", 1_000, { n: 6, withCpu: "x" as unknown as number })]));
  assert(noCount.ok && noCount.unreadable === 6, "a malformed CPU count leaves every tick of its schedule unread");
  if (noCount.ok) eq(judgeCronCpu(noCount).status, "unmeasured", "so the day is not called clean");
  const partialOver = readScheduledCpu(200, envelope([group("* * * * *", 90_000, { n: 10, withCpu: 9 })]));
  assert(partialOver.ok && judgeCronCpu(partialOver).status === "over", "but a measured breach beside it still pages");
}

// --- the verdict ---------------------------------------------------------------------
{
  const at = (ms: number) => readScheduledCpu(200, envelope([group("* * * * *", ms), group("*/5 * * * *", 1)]));
  eq(judgeCronCpu(at(CRON_BUDGET_WARN_MS)).status, "within", "exactly at the line is not past it");
  eq(judgeCronCpu(at(CRON_BUDGET_WARN_MS + 1)).status, "over", "one millisecond past it is");
  const over = judgeCronCpu(at(84_000));
  if (over.status === "over") eq(over.over.map((c) => c.cron), ["* * * * *"], "only the schedule past the line is named over");
  eq(judgeCronCpu({ ok: false, why: "refused" }).status, "unmeasured", "a refusal is unmeasured");
  eq(cronCpuReachedVerdict({ status: "within", crons: [], invocations: 1, sampled: false }), true, "a clean day is a verdict");
  eq(cronCpuReachedVerdict({ status: "over", over: [], crons: [], invocations: 1, unreadable: 0, sampled: false }), true, "so is a breach");
  eq(cronCpuReachedVerdict({ status: "unmeasured", why: "x" }), false, "unmeasured is not");
  eq(cronCpuReachedVerdict({ status: "not-configured" }), false, "nor is an unset token");
}

// --- the copy ------------------------------------------------------------------------
{
  const crons = [
    { cron: "*/5 * * * *", invocations: 288, maxCpuMs: 84_200, p99CpuMs: 61_000 },
    { cron: "* * * * *", invocations: 1440, maxCpuMs: 44_700, p99CpuMs: 30_100 },
  ];
  const one = formatCronCpuAlert({ status: "over", over: [crons[0]], crons, invocations: 1728, unreadable: 0, sampled: false });
  assert(one.startsWith("1 cron schedule used more than"), "singular grammar");
  assert(one.includes("60s of CPU") && one.includes("120s"), "it names the line and the ceiling, derived");
  assert(one.includes("`*/5 * * * *`") && one.includes("84.2s") && one.includes("61s"), "it names the schedule, its max and its p99");
  assert(!one.includes("* * * * *`, max"), "a schedule under the line is not listed as over");
  const two = formatCronCpuAlert({ status: "over", over: crons, crons, invocations: 1728, unreadable: 1, sampled: false });
  assert(two.startsWith("2 cron schedules used"), "plural grammar");
  assert(/1 invocation .*no readable CPU/.test(two), "an unreadable row is named, not hidden");
  const clear = formatCronCpuRecovery({ status: "within", crons, invocations: 1728, sampled: false });
  assert(clear.includes("84.2s") && clear.includes("`*/5 * * * *`") && clear.includes("1,728"), "the all clear says what it measured and over how many ticks");
  assert(/Worker logs/.test(clear), "and where the number came from");
  assert(!/sampled/.test(clear), "a whole day does not say it was sampled");
  const sampledClear = formatCronCpuRecovery({ status: "within", crons, invocations: 1728, sampled: true });
  assert(/sampled/.test(sampledClear), "a sampled day says so, since its worst tick may not be among those kept");
  // #3693: a placed lane is its own request, so the scheduled reading cannot vouch for it.
  assert(/placed/.test(clear) && /not included/.test(clear), "and that a placed lane's CPU is not in it");
  const notConfigured = formatCronCpuNotConfigured();
  assert(notConfigured.includes(CF_ANALYTICS_TOKEN_ENV), "the unset state names the secret");
  assert(/not measured/i.test(notConfigured) && !/healthy|within|under the line/i.test(notConfigured), "and claims nothing about health");
  for (const text of [one, two, clear, sampledClear, notConfigured]) {
    assert(!/[\u2014\u2013]/.test(text), "no dashes in the copy");
    assert(!/^Slate\b/.test(text), "no message opens with the app's own name");
  }
}

// --- the step: who pages, who clears, who whispers -----------------------------------
interface Ran {
  health: CronCpuHealth;
  notified: [string, number][];
  resolved: string[];
  info: [string, number, string][];
  posts: { url: string; auth: string; body: string }[];
  logs: string[];
}
async function run(token: string | undefined, answer: () => Promise<{ status: number; body: unknown }>): Promise<Ran> {
  const out: Omit<Ran, "health"> = { notified: [], resolved: [], info: [], posts: [], logs: [] };
  const health = await runCronCpuCheck({
    token,
    nowMs: NOW,
    post: async (url, auth, body) => {
      out.posts.push({ url, auth, body });
      return answer();
    },
    notify: async (key, cooldown) => {
      out.notified.push([key, cooldown]);
    },
    info: async (key, cooldown, text) => {
      out.info.push([key, cooldown, text]);
    },
    resolve: async (key) => {
      out.resolved.push(key);
      return true;
    },
    log: (msg) => out.logs.push(msg),
  });
  return { health, ...out };
}
const day = (worstMs: number) => async () => ({
  status: 200,
  body: envelope([group("* * * * *", worstMs), group("*/5 * * * *", 2_000)]),
});
{
  const over = await run(TOKEN, day(90_000));
  eq(over.health.status, "over", "a day past the line is over");
  eq(over.notified, [[CRON_BUDGET_ALERT_KEY, CRON_BUDGET_COOLDOWN_MS]], "it pages once, on its key, daily");
  eq(over.resolved, [], "and clears nothing");
  eq(over.posts.length, 1, "one query per check");
  eq(over.posts[0].url, CF_TELEMETRY_URL, "to the Workers Logs endpoint");
  eq(over.posts[0].auth, `Bearer ${TOKEN}`, "with the token as a bearer");
  eq(JSON.parse(over.posts[0].body), cronCpuQueryBody(NOW), "the pinned query, over the trailing day");

  const within = await run(TOKEN, day(45_000));
  eq(within.health.status, "within", "a measured day under the line");
  eq(within.notified, [], "pages nothing");
  eq(within.resolved, [CRON_BUDGET_ALERT_KEY], "and is the all clear, including for the wall time page still open from 2026-10-03");

  for (const token of [undefined, "", "   "]) {
    const unset = await run(token, day(90_000));
    eq(unset.health.status, "not-configured", `an unset token (${JSON.stringify(token)}) is its own state`);
    eq(unset.posts.length, 0, "and spends no subrequest");
    eq(unset.notified, [], "it never pages");
    eq(unset.resolved, [], "and never claims health");
    eq(
      unset.info.map(([k, c]) => [k, c]),
      [[CRON_CPU_NOT_CONFIGURED_KEY, CRON_CPU_NOT_CONFIGURED_COOLDOWN_MS]],
      "it says so on the info channel, at most daily",
    );
  }

  for (const [why, answer] of [
    ["a fetch that throws", async () => { throw new Error("network down"); }],
    ["a refused token", async () => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } })],
    ["a query error", async () => ({ status: 400, body: { success: false, errors: [{ code: 7003, message: "unknown key" }] } })],
    ["an empty day", async () => ({ status: 200, body: envelope([]) })],
    ["a body that is not JSON", async () => ({ status: 200, body: null })],
  ] as const) {
    const r = await run(TOKEN, answer as () => Promise<{ status: number; body: unknown }>);
    eq(r.health.status, "unmeasured", `${why} is unmeasured`);
    eq(r.notified, [], `${why} pages nothing`);
    eq(r.resolved, [], `${why} clears nothing`);
    eq(r.info, [], `${why} is not the unset state`);
  }

  // The token must never reach a line anybody reads.
  const leaky = await run(TOKEN, async () => ({ status: 403, body: { success: false, errors: [{ code: 1, message: `bad token ${TOKEN}` }] } }));
  for (const line of leaky.logs) assert(!line.includes(TOKEN), "no log line carries the token, even when the API echoes it");
}

// --- a failed send or all clear never escapes the check -----------------------------
{
  const failingOver = await runCronCpuCheck({
    token: TOKEN,
    nowMs: NOW,
    post: async () => (await day(90_000)()),
    notify: async () => {
      throw new Error("slack down");
    },
    info: async () => {},
    resolve: async () => true,
  });
  eq(failingOver.status, "over", "a page that fails to send still returns its verdict");
  const failingClear = await runCronCpuCheck({
    token: TOKEN,
    nowMs: NOW,
    post: async () => (await day(1_000)()),
    notify: async () => {},
    info: async () => {},
    resolve: async () => {
      throw new Error("slack down");
    },
  });
  eq(failingClear.status, "within", "an all clear that fails to send still returns its verdict");
  const failingInfo = await runCronCpuCheck({
    token: undefined,
    nowMs: NOW,
    post: async () => {
      throw new Error("must not post");
    },
    notify: async () => {},
    info: async () => {
      throw new Error("slack down");
    },
    resolve: async () => true,
  });
  eq(failingInfo.status, "not-configured", "an info line that fails to send still returns its state");
}

// --- the two keys are filed where their kind says -------------------------------------
{
  // The unset line is info, so it belongs with the other things only worth knowing, never
  // beside the pages for a guard that has stopped working.
  eq(alertEntry(CRON_CPU_NOT_CONFIGURED_KEY)?.kind, "info", "the unset line is classified info");
  eq(alertFamily(CRON_CPU_NOT_CONFIGURED_KEY), "something-was-measured-and-is-only-worth-knowing", "and filed in the info family");
  eq(alertEntry(CRON_BUDGET_ALERT_KEY)?.kind, "condition", "the headroom page is a condition");
  eq(alertFamily(CRON_BUDGET_ALERT_KEY), "a-sweep-cannot-keep-up", "filed with the other headroom pages");
}

// --- the watchdog stands down on the verdict lane ONLY while the secret is unset ------
{
  eq(unconfiguredDetector(VERDICT, {}), CF_ANALYTICS_TOKEN_ENV, "unset: the missing setting is named");
  eq(unconfiguredDetector(VERDICT, { CF_ANALYTICS_TOKEN: "  " }), CF_ANALYTICS_TOKEN_ENV, "blank is unset");
  eq(unconfiguredDetector(VERDICT, { CF_ANALYTICS_TOKEN: TOKEN }), null, "set: watched like any detector");
  eq(unconfiguredDetector("verdict:tier-staffing", {}), null, "no other lane is excused");
}

// --- wall time is a log line, not a page ---------------------------------------------
{
  eq(wallPastLine(CRON_BUDGET_WARN_MS), false, "exactly at the line is not past it");
  eq(wallPastLine(CRON_BUDGET_WARN_MS + 1), true, "one millisecond past it is");
  eq(cronBudgetCallsApp("* * * * *"), false, "a minute tick never calls the app");
  eq(cronBudgetCallsApp("*/5 * * * *"), false, "nor a five minute tick, however slow");
  eq(cronBudgetCallsApp(CRON_BUDGET_VERDICT_CRON), true, "only the hourly tick does");
  eq(CRON_BUDGET_WINDOW_MS, 24 * HOUR, "the window judged is a day");
}

// --- what the Worker sends, through the dispatcher's own request builder ---------------
{
  const tick = { tickId: "abc123", cronSecret: "s3cret" };
  const sent: Request[] = [];
  const errors: string[] = [];
  const warns: Record<string, unknown>[] = [];
  const deps = (fetch: (r: Request) => Promise<Response>): LaneRunDeps => ({
    fetch,
    now: () => 0,
    log: {
      error: (_tag, fields) => errors.push(String(fields.msg)),
      warn: (_tag, fields) => warns.push(fields),
      info: () => {},
    },
  });
  const ok = deps(async (r) => {
    sent.push(r);
    return new Response("{}", { status: 200 });
  });
  await recordCronBudget("* * * * *", 30_000, tick, ok);
  eq(sent.length, 0, "a healthy minute tick sends nothing");
  eq(warns.length, 0, "and logs nothing extra");
  await recordCronBudget("*/5 * * * *", CRON_BUDGET_WARN_MS + 24_000.4, tick, ok);
  eq(sent.length, 0, "a slow tick sends nothing: wall time no longer pages or writes");
  eq(warns.length, 1, "it is logged");
  eq([warns[0].cron, warns[0].wall_ms, warns[0].tick], ["*/5 * * * *", 84_000, "abc123"], "with the schedule, the rounded wall time and the tick");
  await recordCronBudget(CRON_BUDGET_VERDICT_CRON, 1_000, tick, ok);
  eq(sent.length, 1, "the hourly tick asks the app to measure CPU");
  const url = new URL(sent[0].url);
  eq(url.pathname, CRON_BUDGET_ROUTE, "at the cron budget route");
  eq(url.search, "", "carrying nothing in the query");
  eq(sent[0].headers.get("authorization"), "Bearer s3cret", "with the cron secret");
  eq(sent[0].headers.get(TICK_ID_HEADER), "abc123", "and the tick id");
  await recordCronBudget(CRON_BUDGET_VERDICT_CRON, 1_000, tick, deps(async () => { throw new Error("boom"); }));
  await recordCronBudget(CRON_BUDGET_VERDICT_CRON, 1_000, tick, deps(async () => new Response("", { status: 500 })));
  eq(errors, ["the cron budget check threw", "the cron budget check failed"], "a throw or a refusal is logged, never thrown out of the tick");
}

// --- the wiring ---------------------------------------------------------------------
{
  const worker = read("worker/index.ts");
  assert(/recordCronBudget\(controller\.cron, totalMs, tick, deps\)/.test(worker), "the Worker hands each tick's total over");
  const laneRun = read("worker/lane-run.ts");
  assert(/cronBudgetCallsApp\(cron\)/.test(laneRun) && /wallPastLine\(totalMs\)/.test(laneRun), "judged by the shared decisions");
  assert(/laneRequest\(CRON_BUDGET_ROUTE, tick\)/.test(laneRun), "and handed to the route like every lane request");
  eq(CRON_BUDGET_ROUTE, "/api/cron/cron-budget", "the route the Worker calls");
  const route = read("src/app/api/cron/cron-budget/route.ts");
  assert(route.includes("isAuthorizedCron(req)"), "the route takes the cron secret");
  assert(/runCronCpuCheck\(/.test(route), "the route runs the CPU check");
  assert(/recordDetectorVerdict\(CRON_BUDGET_VERDICT_LANE, cronCpuReachedVerdict\(/.test(route), "and stamps the verdict only on a measured day");
  assert(/process\.env\.CF_ANALYTICS_TOKEN/.test(route), "the token is read from the Worker's environment by its literal name");
  const monitor = read("src/app/api/cron/monitor/route.ts");
  assert(!/cron_budget|runCronBudgetCheck|cron-budget/.test(monitor), "the monitor lane no longer judges wall time");
  const watchdog = read("src/lib/monitor/lane-watchdog.ts");
  assert(/unconfiguredDetector\(/.test(watchdog), "the watchdog consults the unset secret before calling the verdict lane blind");
}

finish();
