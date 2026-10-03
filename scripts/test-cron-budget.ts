// #3141: cron CPU headroom, watched daily instead of read by hand.
//
// The Worker cannot read its own CPU, so it times each invocation's lanes and records a tick
// whose WALL time passed half `limits.cpu_ms`, plus an hourly stamp proving it is still
// recording. The monitor lane judges the trailing day. What this pins:
//
//   - the ceiling is the one wrangler.jsonc really sets, and the stamping cron really fires;
//   - the load run's bar and this check share one ceiling and one margin (L41);
//   - the verdict, in all three directions: over pages even when the stamp is stale, a
//     measured quiet day clears, and a failed read, a stale stamp or a writer that never
//     stamped clear NOTHING (#1134, #1152, #1394);
//   - the Worker and the monitor lane are really wired to it (L3).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cron-budget.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  CRON_BUDGET_ALERT_KEY,
  CRON_BUDGET_BREACH_PREFIX,
  CRON_BUDGET_COOLDOWN_MS,
  CRON_BUDGET_ROUTE,
  CRON_BUDGET_VERDICT_CRON,
  CRON_BUDGET_WARN_MS,
  CRON_BUDGET_WARN_SHARE,
  CRON_BUDGET_WINDOW_MS,
  CRON_CPU_LIMIT_MS,
  cronBudgetHealth,
  cronBudgetWrites,
  formatCronBudgetAlert,
  formatCronBudgetRecovery,
  runCronBudgetCheck,
} from "../src/lib/monitor/cron-budget.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { recordCronBudget, TICK_ID_HEADER, type LaneRunDeps } from "../worker/lane-run.ts";
import { WRANGLER_CRON_CPU_MS } from "./loadtest/platform-reading.ts";
import { CRON_CPU_MARGIN_SHARE } from "./loadtest/judge-booking-run.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const VERDICT = "verdict:cron-budget";
const HOUR = 60 * 60_000;
const BOUND = 6 * HOUR;
const NOW = Date.UTC(2026, 9, 3, 15, 0);

// --- the numbers are the deployment's ------------------------------------------
{
  const wrangler = read("wrangler.jsonc");
  const limit = /"limits"\s*:\s*\{\s*"cpu_ms"\s*:\s*(\d+)/.exec(wrangler);
  assert(limit !== null, "wrangler.jsonc still declares limits.cpu_ms where this reads it");
  eq(CRON_CPU_LIMIT_MS, Number(limit?.[1]), "CRON_CPU_LIMIT_MS is wrangler.jsonc's limits.cpu_ms");
  eq(CRON_BUDGET_WARN_MS, CRON_CPU_LIMIT_MS * CRON_BUDGET_WARN_SHARE, "the line is derived from the ceiling");
  eq(CRON_BUDGET_WARN_SHARE, 0.5, "the line is half the ceiling, as #3141 asked");
  assert(
    wrangler.includes(`"${CRON_BUDGET_VERDICT_CRON}"`) && CRON_BUDGET_VERDICT_CRON in CRON_ROUTES,
    "the cron that stamps the verdict is a trigger wrangler.jsonc really fires",
  );
  eq(WRANGLER_CRON_CPU_MS, CRON_CPU_LIMIT_MS, "the load run judges against the same ceiling");
  eq(CRON_CPU_MARGIN_SHARE, CRON_BUDGET_WARN_SHARE, "and fails at the same margin this warns at");
}

// --- what one tick records ------------------------------------------------------
{
  eq(cronBudgetWrites("* * * * *", 30_000), { breach: false, verdict: false }, "a healthy minute tick records nothing");
  eq(cronBudgetWrites("* * * * *", CRON_BUDGET_WARN_MS).breach, false, "exactly at the line is not past it");
  eq(cronBudgetWrites("* * * * *", CRON_BUDGET_WARN_MS + 1).breach, true, "one millisecond past it is");
  eq(cronBudgetWrites(CRON_BUDGET_VERDICT_CRON, 5_000), { breach: false, verdict: true }, "the hourly tick stamps whatever it measured");
}

// --- the verdict ------------------------------------------------------------------
const judge = (stamps: Record<string, number | null> | null) =>
  cronBudgetHealth({ stamps, nowMs: NOW, verdictBoundMs: BOUND, verdictLane: VERDICT });
const breach = (cron: string) => `${CRON_BUDGET_BREACH_PREFIX}${cron}`;
{
  eq(judge(null).status, "unmeasured", "a failed read is unmeasured");
  eq(judge({ sync: NOW }).status, "unmeasured", "a writer that never stamped is unmeasured, not quiet");
  eq(judge({ [VERDICT]: NOW - BOUND - 1 }).status, "unmeasured", "a stale stamp is unmeasured");
  eq(judge({ [VERDICT]: NOW - HOUR, sync: NOW }), { status: "within", unreadable: [] }, "a fresh stamp and no breach is a measured quiet day");
  eq(
    judge({ [VERDICT]: NOW - HOUR, [breach("* * * * *")]: NOW - CRON_BUDGET_WINDOW_MS - 1 }),
    { status: "within", unreadable: [] },
    "a breach older than the window has aged out",
  );

  const over = judge({ [VERDICT]: NOW - HOUR, [breach("*/5 * * * *")]: NOW - 2 * HOUR, [breach("* * * * *")]: NOW - HOUR });
  eq(over.status, "over", "a breach inside the window is over");
  if (over.status === "over") {
    eq(over.breaches.map((b) => b.cron), ["* * * * *", "*/5 * * * *"], "every schedule is named, in a stable order");
  }
  eq(
    judge({ [VERDICT]: NOW - BOUND - 1, [breach("* * * * *")]: NOW - HOUR }).status,
    "over",
    "a breach is a positive measurement and pages even while the stamp is stale",
  );
  // An undated breach row can never age out, so it is never counted as a breach: that would
  // page for ever (L665). Nor may it hold the all clear back, or an open alert waits on a
  // breach that may never come. So the readable rows decide, and the undated one is named.
  const undated = judge({ [VERDICT]: NOW - HOUR, [breach("* * * * *")]: 0 });
  eq(undated, { status: "within", unreadable: ["* * * * *"] }, "an undated row alone does not stop a measured quiet day");
  eq(
    judge({ [VERDICT]: NOW - BOUND - 1, [breach("* * * * *")]: 0 }).status,
    "unmeasured",
    "but a stale stamp still measures nothing, undated row or not",
  );
  const beside = judge({ [VERDICT]: NOW - HOUR, [breach("* * * * *")]: 0, [breach("*/5 * * * *")]: NOW - HOUR });
  eq(
    beside,
    { status: "over", breaches: [{ cron: "*/5 * * * *", atMs: NOW - HOUR }], unreadable: ["* * * * *"] },
    "beside a real breach it is carried as not judged, never counted as one",
  );
}

// --- the copy ---------------------------------------------------------------------
{
  const one = formatCronBudgetAlert({ status: "over", breaches: [{ cron: "* * * * *", atMs: NOW - HOUR }], unreadable: [] });
  assert(!one.includes("Not judged"), "no undated note when every row is dated");
  assert(one.startsWith("1 cron schedule had"), "singular grammar for one schedule");
  assert(one.includes("60s of wall time") && one.includes("120s CPU ceiling"), "it names wall time and the ceiling, derived");
  assert(one.includes("2026-10-03 14:00 UTC"), "it dates the latest tick");
  const two = formatCronBudgetAlert({
    status: "over",
    breaches: [
      { cron: "* * * * *", atMs: NOW },
      { cron: "*/5 * * * *", atMs: NOW - 2 * HOUR },
    ],
    unreadable: ["0 * * * *"],
  });
  assert(two.startsWith("2 cron schedules had"), "plural grammar");
  assert(/Not judged: the row for `0 \* \* \* \*`/.test(two), "an undated row is named in the page as not judged");
  const recovered = formatCronBudgetRecovery({ status: "within", unreadable: [] });
  assert(!/not judged/i.test(recovered), "a clean all clear has no undated note");
  // The page and the all clear must never claim CPU safety from wall time (#3141 review).
  for (const text of [one, two, recovered]) {
    assert(!/at or above CPU|under half its/i.test(text), "no copy claims wall time bounds CPU");
    assert(/does not measure CPU|not CPU/i.test(text), "every message says it is not CPU");
  }
  for (const text of [one, two, recovered]) {
    assert(!/[\u2014\u2013]/.test(text), "no dashes in the copy");
  }
}

// --- the step: who pages and who clears ---------------------------------------------
async function run(readStamps: () => Promise<Record<string, number | null>>) {
  const notified: [string, number][] = [];
  const resolved: string[] = [];
  const health = await runCronBudgetCheck({
    nowMs: NOW,
    read: readStamps,
    verdictBoundMs: BOUND,
    verdictLane: VERDICT,
    notify: async (key, cooldown) => {
      notified.push([key, cooldown]);
    },
    resolve: async (key) => {
      resolved.push(key);
      return true;
    },
  });
  return { health, notified, resolved };
}
{
  const over = await run(async () => ({ [VERDICT]: NOW, [breach("* * * * *")]: NOW }));
  eq(over.notified, [[CRON_BUDGET_ALERT_KEY, CRON_BUDGET_COOLDOWN_MS]], "over pages once, on its key, daily");
  eq(over.resolved, [], "and clears nothing");

  const within = await run(async () => ({ [VERDICT]: NOW }));
  eq(within.notified, [], "a measured quiet day pages nothing");
  eq(within.resolved, [CRON_BUDGET_ALERT_KEY], "and is the all clear");

  // An open alert must be able to clear with only an undated row left behind (L665): the
  // readable rows are a measured quiet day, and the all clear names the row it did not judge.
  const texts: string[] = [];
  const undatedOnly = await runCronBudgetCheck({
    nowMs: NOW,
    read: async () => ({ [VERDICT]: NOW, [breach("* * * * *")]: 0 }),
    verdictBoundMs: BOUND,
    verdictLane: VERDICT,
    notify: async () => {
      throw new Error("must not page");
    },
    resolve: async (_key, text) => {
      texts.push(text);
      return true;
    },
  });
  eq(undatedOnly.status, "within", "an undated row alone is a measured quiet day");
  eq(texts.length, 1, "and it sends the all clear");
  assert(/not judged/i.test(texts[0]) && texts[0].includes("`* * * * *`"), "which names the undated row as not judged");

  for (const [why, readStamps] of [
    ["a read that throws", async () => { throw new Error("db down"); }],
    ["a stamp gone stale", async () => ({ [VERDICT]: NOW - BOUND - 1 })],
    ["a writer that never stamped", async () => ({ monitor: NOW })],
  ] as const) {
    const r = await run(readStamps as () => Promise<Record<string, number | null>>);
    eq(r.health.status, "unmeasured", `${why} is unmeasured`);
    assert(r.notified.length === 0, `${why} pages nothing`);
    assert(r.resolved.length === 0, `${why} clears nothing`);
  }
}

// --- a failed send or all clear is logged by the shared logger and never escapes the step --
{
  const failingOver = await runCronBudgetCheck({
    nowMs: NOW,
    read: async () => ({ [VERDICT]: NOW, [breach("* * * * *")]: NOW }),
    verdictBoundMs: BOUND,
    verdictLane: VERDICT,
    notify: async () => {
      throw new Error("slack down");
    },
    resolve: async () => true,
  });
  eq(failingOver.status, "over", "a page that fails to send still returns its verdict");
  const failingClear = await runCronBudgetCheck({
    nowMs: NOW,
    read: async () => ({ [VERDICT]: NOW }),
    verdictBoundMs: BOUND,
    verdictLane: VERDICT,
    notify: async () => {},
    resolve: async () => {
      throw new Error("slack down");
    },
  });
  eq(failingClear.status, "within", "an all clear that fails to send still returns its verdict");
}

// --- what the Worker sends, through the dispatcher's own request builder ---------------
{
  const tick = { tickId: "abc123", cronSecret: "s3cret" };
  const sent: Request[] = [];
  const errors: string[] = [];
  const deps = (fetch: (r: Request) => Promise<Response>): LaneRunDeps => ({
    fetch,
    now: () => 0,
    log: { error: (_tag, fields) => errors.push(String(fields.msg)) },
  });
  const ok = deps(async (r) => {
    sent.push(r);
    return new Response("{}", { status: 200 });
  });
  await recordCronBudget("* * * * *", 30_000, tick, ok);
  eq(sent.length, 0, "a healthy minute tick sends nothing");
  await recordCronBudget("* * * * *", CRON_BUDGET_WARN_MS + 2_400.4, tick, ok);
  eq(sent.length, 1, "a tick past the line sends one measurement");
  const url = new URL(sent[0].url);
  eq(url.pathname, CRON_BUDGET_ROUTE, "to the recording route");
  eq([url.searchParams.get("cron"), url.searchParams.get("wall_ms")], ["* * * * *", "62400"], "carrying the cron and the rounded wall time");
  eq(sent[0].headers.get("authorization"), "Bearer s3cret", "with the cron secret");
  eq(sent[0].headers.get(TICK_ID_HEADER), "abc123", "and the tick id");
  await recordCronBudget(CRON_BUDGET_VERDICT_CRON, 1_000, tick, ok);
  eq(sent.length, 2, "the hourly tick sends one whatever it measured");
  await recordCronBudget("* * * * *", CRON_BUDGET_WARN_MS + 1, tick, deps(async () => { throw new Error("boom"); }));
  await recordCronBudget("* * * * *", CRON_BUDGET_WARN_MS + 1, tick, deps(async () => new Response("", { status: 500 })));
  eq(errors, ["recording the tick threw", "recording the tick failed"], "a throw or a refusal is logged, never thrown out of the tick");
}

// --- the wiring ---------------------------------------------------------------------
{
  const worker = read("worker/index.ts");
  assert(/recordCronBudget\(controller\.cron, totalMs, tick, deps\)/.test(worker), "the Worker records each tick's total");
  const laneRun = read("worker/lane-run.ts");
  assert(/cronBudgetWrites\(cron, totalMs\)/.test(laneRun), "judged by the shared decision");
  assert(/laneRequest\(`\$\{CRON_BUDGET_ROUTE\}/.test(laneRun), "and handed to the recording route like every lane request");
  eq(CRON_BUDGET_ROUTE, "/api/cron/cron-budget", "the route the Worker calls");
  const route = read("src/app/api/cron/cron-budget/route.ts");
  assert(route.includes("isAuthorizedCron(req)"), "the recording route takes the cron secret");
  const monitor = read("src/app/api/cron/monitor/route.ts");
  assert(
    /steps\.run\("cron_budget", null, \(\) =>\s*runCronBudgetCheck\(/.test(monitor),
    "the monitor lane runs the check inside its own step boundary",
  );
}

finish();
