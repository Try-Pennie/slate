// #3802: the fold table (`ALERT_FOLDS`, src/lib/notify/alert-folds.ts) says which
// alerts another alert EXPLAINS, and the throttle holds those while it fires. A key in
// it that names nothing is the worst way for it to be wrong, because the hold then
// silently applies to no key at all and the duplicate pages come back with every test
// about a single alert still passing. So this guard holds the table to:
//
//   1. every explainer is a key the alert catalog holds exactly, and a condition;
//   2. every explained key is in the catalog (a family member counts) and a condition;
//   3. nothing explains itself, nothing is explained twice, and no explainer is also
//      explained (a chain nothing would ever resolve);
//   4. each fold says why, and each explained key has a label and a usable grace;
//   5. for the CI refusal, every explained key is a lane the canary workflow stamps,
//      and its grace is that lane's own bound, so the table cannot claim a lane only an
//      Actions run stamps when something else stamps it, or wait the wrong length.
//
// Each check carries a positive control: a broken table fed to the same function must
// be refused, or a green run could mean a validator that refuses nothing (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alert-folds.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALERT_FOLDS,
  explainedLabels,
  foldFor,
  foldTableProblems,
  type AlertFold,
} from "../src/lib/notify/alert-folds.ts";
import { alertEntry, alertKindOf } from "../src/lib/notify/alert-catalog.ts";
import {
  CANARY_STALE_BOUNDS_MS,
  LANE_STALE_BOUNDS_MS,
  POOL_GROUPING_STALE_BOUNDS_MS,
  VERDICT_STALE_BOUNDS_MS,
} from "../src/lib/monitor/health.ts";
import { formatCiRefusedAlert, formatCiStartedRecovery, REFUSAL_ALERT_KEY } from "../src/lib/monitor/github-ci-health.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const kindOf = (key: string) => alertKindOf(key);
const exact = (key: string) => alertEntry(key) !== undefined;

// 1 to 4 on the real table.
const problems = foldTableProblems(ALERT_FOLDS, kindOf, exact);
eq(problems, [], "the fold table names only real conditions, each once, with a reason, a label and a grace");
assert(ALERT_FOLDS.length > 0, "the fold table is populated");

// Positive controls: each class of mistake is refused.
const good = ALERT_FOLDS[0] as AlertFold;
const lane = good.explains[0];
const broken = (fold: Partial<AlertFold>, label: string, pattern: RegExp) => {
  const found = foldTableProblems([{ ...good, ...fold }], kindOf, exact);
  assert(found.some((p) => pattern.test(p)), `CONTROL: ${label} is refused (${found.join("; ") || "nothing"})`);
};
broken({ explainer: "ci_runs_refusd" }, "an explainer the catalog does not hold", /not a key in the alert catalog/);
broken({ explainer: "cron_lane_stale:*" }, "a family as explainer", /is a family/);
broken({ explainer: "verify_on_book_outage" }, "an incident as explainer", /not a condition/);
broken({ explains: [{ ...lane, key: "smoke_canary_stale:smoke-canary" }] }, "an explained key nothing sends", /not in the alert catalog/);
broken({ explains: [{ ...lane, key: "verify_on_book_outage" }] }, "an incident explained", /not a condition/);
broken({ explains: [{ ...lane, key: good.explainer }] }, "a key explaining itself", /explains itself/);
broken({ explains: [lane, lane] }, "a key explained twice", /explained by both/);
broken({ explains: [{ ...lane, graceMs: Number.NaN }] }, "a grace that is not a number", /no usable grace/);
broken({ explains: [{ ...lane, label: " " }] }, "a key with no label", /no label/);
broken({ why: "because" }, "a fold with no reason", /carries no reason/);
broken({ explains: [] }, "a fold explaining nothing", /explains nothing/);
{
  const chain = foldTableProblems(
    [good, { explainer: "main_not_deployed", why: good.why, explains: [{ ...lane, key: good.explainer }] }],
    kindOf,
    exact,
  );
  assert(chain.some((p) => /a chain/.test(p)), "CONTROL: an explainer that is also explained is refused");
}

// 5: the CI refusal's lanes are the canary's own, waiting their own bound.
const ci = ALERT_FOLDS.find((f) => f.explainer === REFUSAL_ALERT_KEY);
assert(ci !== undefined, "the CI refusal has a fold");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repoRoot, ".github/workflows/smoke-canary.yml"), "utf8");
const bounds: Record<string, number> = { ...CANARY_STALE_BOUNDS_MS, ...VERDICT_STALE_BOUNDS_MS };
for (const e of ci?.explains ?? []) {
  const m = /^cron_lane_stale:(.+)$/.exec(e.key);
  assert(m !== null, `${e.key} is a stale lane key, as the lane watchdog sends it`);
  const laneName = m?.[1] ?? "";
  eq(e.graceMs, bounds[laneName], `${laneName} waits its own bound after the CI refusal clears`);
  // The bare heartbeat route stamps smoke-canary; every other lane is named on it.
  const stamped =
    laneName === "smoke-canary"
      ? /\/api\/smoke\/heartbeat"/.test(workflow)
      : workflow.includes(`/api/smoke/heartbeat?lane=${laneName}"`);
  assert(stamped, `${laneName} is stamped by the smoke canary workflow, so a CI stop explains it`);
  eq(foldFor(e.key)?.explainer, REFUSAL_ALERT_KEY, `${e.key} resolves to the CI refusal`);
}
eq(foldFor("cron_lane_stale:sync"), null, "a Worker cron lane is explained by nothing: CI cannot stop it");

// 6: the pool grouping is published only by the recompute lane, so it waits while the
// core lanes' page is firing, which names it (2026-10-26: it posted as a sixth page).
const lanesFold = ALERT_FOLDS.find((f) => f.explainer === "cron_lanes_stale");
assert(lanesFold !== undefined, "the core lanes' page has a fold");
eq(foldFor("cron_lane_stale:pool-grouping")?.explainer, "cron_lanes_stale", "the pool grouping waits on the core lanes' page");
eq(
  foldFor("cron_lane_stale:pool-grouping")?.folded.graceMs,
  POOL_GROUPING_STALE_BOUNDS_MS["pool-grouping"],
  "and waits its own bound after that page clears",
);

// 7 (#4265): a Google outage pages the calendar breaker AND the placeholder seat, whose
// calendar probe fails through the same outage, so the seat waits while the breaker fires,
// and after it clears waits one monitor lane bound, the lane the seat check runs on.
eq(foldFor("placeholder_seat_failing")?.explainer, "google_calendar_breaker_open", "the seat page waits on the calendar breaker");
eq(foldFor("placeholder_seat_failing")?.folded.graceMs, LANE_STALE_BOUNDS_MS.monitor, "and waits the monitor lane's bound after it clears");
eq(foldFor("placeholder_missing"), null, "a missing placeholder is no Google outage, so nothing holds it");

// The CI page and its all-clear name every folded lane, from the same table.
const page = formatCiRefusedAlert({ runName: "CI", runUrl: "https://github.com/Try-Pennie/slate/actions/runs/1" });
const allClear = formatCiStartedRecovery();
for (const label of explainedLabels(REFUSAL_ALERT_KEY)) {
  assert(page.toLowerCase().includes(label.toLowerCase()), `the CI refused page names "${label}"`);
  assert(allClear.toLowerCase().includes(label.toLowerCase()), `the CI all-clear names "${label}"`);
}

finish();
