// #3179: warn when half a month's booking error budget is spent.
//
// docs/slo.md sets two monthly targets (#3141): booking success 98.5% and
// availability 99.5% of counted booking requests. Both were read by hand with a SQL
// query, so a month could spend its whole budget with nothing saying so until
// somebody thought to look. The monitor lane now reads the month to date and pages
// at half of either budget, a condition that clears on a measured month back under
// half (in practice, the first tick of the next month).
//
// What is pinned here, each with a control where a guard could pass vacuously:
//   1. The budgets are derived from the targets module, never typed again (L41).
//   2. The budget in requests is the share of the month's requests, floored at the
//      documented projection, so a busy month earns more room and a quiet first day
//      does not read as a tiny budget blown by one error.
//   3. Half spent pages; under half is a MEASURED clear; a reading that cannot be
//      right (negative, faults above errors, errors above requests) is unmeasured and
//      sends nothing in either direction (#1134, #1152).
//   4. The run sends one page per spent budget, clears the rest in one batch, and a
//      read that throws clears nothing.
//
// Run: node --experimental-strip-types scripts/test-slo-budget.ts
import {
  BOOKING_BUDGET_ALERT_KEYS,
  BUDGET_WARN_SHARE,
  judgeBudgets,
  monthStartDay,
  runSloBudgetCheck,
  sloBudgetClearText,
  sloBudgetPageText,
  type MonthToDate,
} from "../src/lib/monitor/slo-budget.ts";
import {
  AVAILABILITY_TARGET_PCT,
  BOOKING_SUCCESS_TARGET_PCT,
  sloArithmetic,
} from "../src/lib/monitor/slo-targets.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const projected = sloArithmetic().requestsPerMonth;
const month = (over: Partial<MonthToDate> = {}): MonthToDate => ({
  month: "2026-10",
  requests: 4000,
  errors: 0,
  serverFaults: 0,
  ...over,
});

// --- 1. derived from the targets module ---------------------------------------
eq(BUDGET_WARN_SHARE, 0.5, "the warning is at half the budget");
{
  const j = judgeBudgets(month(), projected);
  assert(j.success.kind === "within" && j.availability.kind === "within", "a clean month is within both");
  if (j.success.kind === "within" && j.availability.kind === "within") {
    eq(j.success.spend.targetPct, BOOKING_SUCCESS_TARGET_PCT, "booking success target comes from slo-targets");
    eq(j.availability.spend.targetPct, AVAILABILITY_TARGET_PCT, "availability target comes from slo-targets");
    eq(
      j.success.spend.allowed,
      sloArithmetic().bookingErrorBudgetPerMonth,
      "at or under the projected traffic, the budget is the documented one (about 199)",
    );
    eq(
      j.availability.spend.allowed,
      sloArithmetic().availabilityBudgetPerMonth,
      "and the availability budget is the documented one (about 66)",
    );
  }
}

// --- 2. the budget moves with traffic, never below the projection ---------------
{
  const busy = judgeBudgets(month({ requests: projected * 2 }), projected);
  assert(busy.success.kind === "within", "a busy clean month is within");
  if (busy.success.kind === "within") {
    eq(
      busy.success.spend.allowed,
      Math.floor((projected * 2 * (100 - BOOKING_SUCCESS_TARGET_PCT)) / 100),
      "a month already past the projection has a budget sized on its real requests",
    );
  }
  const quiet = judgeBudgets(month({ requests: 3, errors: 1 }), projected);
  assert(
    quiet.success.kind === "within",
    "one error in the first three requests of a month is not half of a month's budget",
  );
}

// --- 3. the threshold, both ways -----------------------------------------------
{
  const allowed = sloArithmetic().bookingErrorBudgetPerMonth;
  const half = Math.ceil(allowed * BUDGET_WARN_SHARE);
  const at = judgeBudgets(month({ errors: half }), projected);
  eq(at.success.kind, "half-spent", `${half} errors of ${allowed} allowed is half spent`);
  const under = judgeBudgets(month({ errors: half - 1 }), projected);
  eq(under.success.kind, "within", `${half - 1} errors is still under half`);
  // The two budgets judge different numerators: ordinary errors spend only the
  // booking success budget, server faults spend both.
  eq(at.availability.kind, "within", "ordinary errors do not spend the availability budget");

  const faults = Math.ceil(sloArithmetic().availabilityBudgetPerMonth * BUDGET_WARN_SHARE);
  const faulting = judgeBudgets(month({ errors: faults, serverFaults: faults }), projected);
  eq(faulting.availability.kind, "half-spent", "server faults spend the availability budget");
}

// --- 3b. a reading that cannot be right is unmeasured ----------------------------
for (const [label, bad] of [
  ["negative errors", { errors: -1 }],
  ["faults above errors", { errors: 2, serverFaults: 3 }],
  ["errors above requests", { requests: 5, errors: 6 }],
  ["a requests count that is not a number", { requests: Number.NaN }],
] as const) {
  const j = judgeBudgets(month(bad), projected);
  assert(
    j.success.kind === "unmeasured" && j.availability.kind === "unmeasured",
    `${label}: unmeasured, never a clear`,
  );
}

// --- the month the tally is bucketed in --------------------------------------
eq(monthStartDay("2026-10-17"), "2026-10-01", "the month starts on its first day");
eq(monthStartDay("2026-01-01"), "2026-01-01", "the first day is its own month start");

// --- copy ----------------------------------------------------------------------
{
  const j = judgeBudgets(month({ errors: 120 }), projected);
  assert(j.success.kind === "half-spent", "fixture is half spent");
  if (j.success.kind === "half-spent") {
    const text = sloBudgetPageText(j.success.spend, "2026-10");
    assert(text.includes("120") && text.includes("199"), "the page names what was spent and what was allowed");
    assert(text.includes("98.5%"), "and the target it is spent against");
    assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
    assert(!/^Slate/.test(text), "does not open with the app's own name");
  }
  const clear = sloBudgetClearText("success", "2026-11");
  assert(clear.length > 0 && !/[\u2014\u2013]/.test(clear), "the all-clear renders");
}

// --- 4. the run ------------------------------------------------------------------
type Sent = { key: string; ms: number; text: string };
async function run(read: () => Promise<MonthToDate>, resolvedKeys: string[] = []) {
  const sent: Sent[] = [];
  const resolved: string[][] = [];
  const logged: Record<string, unknown>[] = [];
  const result = await runSloBudgetCheck({
    read,
    projectedRequestsPerMonth: projected,
    cooldownMs: 24 * 3600_000,
    notify: async (key, ms, text) => {
      sent.push({ key, ms, text });
    },
    resolveRecovered: async (recovered) => {
      resolved.push(recovered.map((r) => r.key));
      resolvedKeys.push(...recovered.map((r) => r.key));
      return recovered.map((r) => r.key);
    },
    log: (fields) => logged.push(fields),
  });
  return { sent, resolved, result, logged };
}
{
  const r = await run(async () => month({ errors: 120 }));
  eq(r.sent.map((s) => s.key), [BOOKING_BUDGET_ALERT_KEYS.success], "a spent success budget pages on its own key");
  eq(r.sent[0]?.ms, 24 * 3600_000, "on the cooldown it was given");
  eq(r.resolved, [[BOOKING_BUDGET_ALERT_KEYS.availability]], "and the budget still within is cleared, measured");
  eq(
    r.logged.map((l) => [l.budget, l.verdict]),
    [["success", "half-spent"], ["availability", "within"]],
    "each budget's verdict is logged, so a quiet month is visible as measured",
  );
}
{
  const r = await run(async () => month());
  eq(r.sent, [], "a clean month pages nothing");
  eq(
    r.resolved,
    [[BOOKING_BUDGET_ALERT_KEYS.success, BOOKING_BUDGET_ALERT_KEYS.availability]],
    "and clears both in one batch",
  );
}
{
  // The silent path: a read that failed clears NOTHING and pages nothing, and the
  // failure reaches the step boundary rather than reading as a healthy month.
  let threw = "";
  let r: Awaited<ReturnType<typeof run>> | null = null;
  const failedResolved: string[] = [];
  try {
    r = await run(async () => {
      throw new Error("booking_api_outcome_mix: permission denied");
    }, failedResolved);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(/permission denied/.test(threw), "a failed read propagates to the step's failure boundary");
  assert(r === null, "and nothing was sent or cleared on the way");
  eq(failedResolved.length, 0, "the resolver was never reached");
}
{
  const r = await run(async () => month({ requests: 5, errors: 6 }));
  eq(r.sent, [], "an impossible reading pages nothing");
  eq(r.resolved.length, 0, "and clears nothing");
}
eq(
  Object.values(BOOKING_BUDGET_ALERT_KEYS).every((k) => k.startsWith("booking_budget:")),
  true,
  "both keys sit under the one catalogued prefix",
);

finish();
