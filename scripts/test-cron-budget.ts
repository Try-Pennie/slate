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
  eq(judge({ [VERDICT]: NOW - HOUR, sync: NOW }), { status: "within" }, "a fresh stamp and no breach is a measured quiet day");
  eq(
    judge({ [VERDICT]: NOW - HOUR, [breach("* * * * *")]: NOW - CRON_BUDGET_WINDOW_MS - 1 }),
    { status: "within" },
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
  // An undated breach row can never age out, so it is neither a breach nor a clear (L665).
  const undated = judge({ [VERDICT]: NOW - HOUR, [breach("* * * * *")]: 0 });
  eq(undated.status, "unmeasured", "an unreadable breach stamp alone is unmeasured, not a standing breach");
  assert(undated.status === "unmeasured" && undated.unreadable[0] === "* * * * *", "and it names the row");
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
  for (const text of [one, two, formatCronBudgetRecovery()]) {
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

  for (const [why, readStamps] of [
    ["a read that throws", async () => { throw new Error("db down"); }],
    ["a stamp gone stale", async () => ({ [VERDICT]: NOW - BOUND - 1 })],
    ["a writer that never stamped", async () => ({ monitor: NOW })],
    ["an undated breach row on its own", async () => ({ [VERDICT]: NOW, [breach("* * * * *")]: 0 })],
  ] as const) {
    const r = await run(readStamps as () => Promise<Record<string, number | null>>);
    eq(r.health.status, "unmeasured", `${why} is unmeasured`);
    assert(r.notified.length === 0, `${why} pages nothing`);
    assert(r.resolved.length === 0, `${why} clears nothing`);
  }
}

// --- the wiring ---------------------------------------------------------------------
{
  const worker = read("worker/index.ts");
  assert(/cronBudgetWrites\(controller\.cron, totalMs\)/.test(worker), "the Worker judges each tick's total");
  assert(worker.includes("CRON_BUDGET_ROUTE"), "and hands it to the recording route");
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
