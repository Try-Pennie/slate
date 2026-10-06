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
//   5. The page says what the budget is and what spending it does (#3374): nothing is
//      blocked or switched off, and it compares the month with the pilot. It splits the
//      errors into a time another lead took first against everything else, naming the
//      largest code in each, or says it could not split them rather than print a zero
//      it never measured (L622).
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
  splitTakenTimes,
  type MonthToDate,
} from "../src/lib/monitor/slo-budget.ts";
import {
  AVAILABILITY_TARGET_PCT,
  BOOKING_SUCCESS_TARGET_PCT,
  SERVER_FAULT_ERROR_CODES,
  SLOT_TAKEN_ERROR_CODES,
  sloArithmetic,
} from "../src/lib/monitor/slo-targets.ts";
import { REFUSAL_CATALOG } from "../src/lib/booking/refusal-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const projected = sloArithmetic().requestsPerMonth;
const month = (over: Partial<MonthToDate> = {}): MonthToDate => ({
  month: "2026-10",
  requests: 4000,
  errors: 0,
  serverFaults: 0,
  errorCodes: [],
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

// --- 5. which codes are a time somebody else took first -------------------------
{
  // Derived from the refusal catalog, never typed again (L41). Every path that tells a
  // lead the time has gone is in it, the booking API's twin included, and nothing else.
  eq(
    [...SLOT_TAKEN_ERROR_CODES].sort(),
    ["SLOT_TAKEN", "reschedule_slot_taken", "slot_unavailable"],
    "the taken time codes are the booker's, the manage page's and the booking API's",
  );
  for (const code of SLOT_TAKEN_ERROR_CODES) {
    assert(!SERVER_FAULT_ERROR_CODES.includes(code), `${code} is not a server fault`);
    assert(
      REFUSAL_CATALOG.some((p) => p.counting.kind === "error" && p.counting.code === code),
      `${code} is a counted error code in the catalog`,
    );
  }
}

// --- 5b. the split, measured and not ----------------------------------------------
// The mix behind the page that fired on 2026-10-06 (#3374): 78 of 102 slot_unavailable.
const ISSUE_MIX = [
  { code: "slot_unavailable", count: 78 },
  { code: "invalid_request", count: 14 },
  { code: "no_eligible_agents", count: 5 },
  { code: "invalid_contact", count: 3 },
  { code: "reschedule_slot_taken", count: 2 },
];
{
  const s = splitTakenTimes(102, ISSUE_MIX);
  eq(s.kind, "measured", "codes that add up to no more than the errors split");
  if (s.kind === "measured") {
    eq(s.taken, 80, "slot_unavailable and reschedule_slot_taken are times taken first");
    eq(s.takenTop, { code: "slot_unavailable", count: 78 }, "the largest taken code is named");
    eq(s.rest, 22, "everything else is the remainder");
    eq(s.restTop, { code: "invalid_request", count: 14 }, "the largest other code is named");
  }
  // An error recorded with no code is not in the mix (the RPC drops an empty code). It
  // belongs to the rest, never to the taken count, which is only what a taken code measured.
  const uncoded = splitTakenTimes(30, [{ code: "slot_unavailable", count: 20 }]);
  eq(
    uncoded.kind === "measured" ? [uncoded.taken, uncoded.rest, uncoded.restTop] : null,
    [20, 10, null],
    "errors with no code count in the rest, and no rest code is named",
  );
  const cases: [string, number, { code: string; count: number }[]][] = [
    ["codes adding up to more than the errors", 5, [{ code: "slot_unavailable", count: 6 }]],
    ["errors with no codes at all", 12, []],
    ["a negative code count", 5, [{ code: "invalid_request", count: -1 }]],
  ];
  for (const [label, errors, codes] of cases) {
    eq(splitTakenTimes(errors, codes).kind, "unmeasured", `${label}: the split is unmeasured, never a zero`);
  }
  eq(splitTakenTimes(0, []).kind, "measured", "no errors and no codes is a measured nothing");
}

// --- 5c. copy ------------------------------------------------------------------
// Built from char codes so this file holds no literal of the characters it bans.
const DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
const noDash = (t: string, label: string) => assert(!DASHES.test(t), `${label}: no dashes`);
const noEmoji = (t: string, label: string) => assert(!/\p{Extended_Pictographic}/u.test(t), `${label}: no emoji`);
const NOT_A_GATE = /Nothing is blocked, slowed or switched off/;
{
  // The page that fired on 2026-10-06, with its real counts.
  const j = judgeBudgets(month({ requests: 2577, errors: 102, errorCodes: ISSUE_MIX }), projected);
  assert(j.success.kind === "half-spent", "the 2026-10-06 fixture is half spent");
  if (j.success.kind === "half-spent") {
    const text = sloBudgetPageText(j.success.spend, "2026-10");
    assert(text.includes("102") && text.includes("199"), "the page names what was spent and what was allowed");
    assert(text.includes("98.5%"), "and the target it is spent against");
    assert(text.includes("October 2026"), "and the month");
    assert(/80 of the 102 were a time that had gone before the lead confirmed/.test(text), "the taken times are counted out of the errors");
    assert(/slot_unavailable, 78/.test(text), "naming the largest taken code");
    assert(/The other 22 are worth a look/.test(text), "and the rest are counted apart from them");
    assert(/invalid_request, 14/.test(text), "naming the largest of the rest");
    assert(NOT_A_GATE.test(text), "it says spending the budget changes nothing");
    assert(/compares this month with the pilot/.test(text), "and what it measures against");
    assert(/not a promise/.test(text), "and that it is an internal measure");
    assert(text.includes("/admin/booking-outcomes"), "and where every code is");
    assert(!/^Slate/.test(text), "does not open with the app's own name");
    eq((text.match(/pilot/g) ?? []).length, 1, "the pilot is named once");
    noDash(text, "success page");
    noEmoji(text, "success page");
  }

  // A split that cannot be measured says so, and never prints a zero for it.
  const bad = judgeBudgets(month({ requests: 2577, errors: 102, errorCodes: [] }), projected);
  if (bad.success.kind === "half-spent") {
    const text = sloBudgetPageText(bad.success.spend, "2026-10");
    assert(
      /Could not tell how many of the 102 were a time that had gone before the lead confirmed/.test(text),
      "an unmeasured split is said out loud",
    );
    assert(!/\b0 of the|None of the/.test(text), "and never reads as none taken");
    assert(NOT_A_GATE.test(text), "the rest of the page still renders");
  } else assert(false, "the unmeasured split fixture is half spent");

  // Every error a taken time, and none.
  const allTaken = judgeBudgets(
    month({ errors: 102, errorCodes: [{ code: "slot_unavailable", count: 102 }] }),
    projected,
  );
  if (allTaken.success.kind === "half-spent") {
    const text = sloBudgetPageText(allTaken.success.spend, "2026-10");
    assert(/All 102 were a time that had gone before the lead confirmed/.test(text), "all taken reads as all");
    assert(!/The other/.test(text), "with no empty rest group");
  } else assert(false, "the all taken fixture is half spent");
  const noneTaken = judgeBudgets(
    month({ errors: 102, errorCodes: [{ code: "invalid_request", count: 102 }] }),
    projected,
  );
  if (noneTaken.success.kind === "half-spent") {
    const text = sloBudgetPageText(noneTaken.success.spend, "2026-10");
    assert(/None of the 102 was a time that had gone before the lead confirmed/.test(text), "none taken reads as none");
    assert(/invalid_request, 102/.test(text), "and still names the largest code");
  } else assert(false, "the none taken fixture is half spent");

  // The availability page: every error there is a fault, so it names the largest one.
  const faults = judgeBudgets(
    month({
      requests: 6200,
      errors: 41,
      serverFaults: 35,
      errorCodes: [
        { code: "internal", count: 30 },
        { code: "slot_unavailable", count: 6 },
        { code: "verify_unavailable", count: 5 },
      ],
    }),
    projected,
  );
  if (faults.availability.kind === "half-spent") {
    const text = sloBudgetPageText(faults.availability.spend, "2026-10");
    assert(text.includes("35") && text.includes("66") && text.includes("99.5%"), "availability counts and target");
    assert(/internal, 30/.test(text), "naming the largest fault code");
    assert(!/slot_unavailable/.test(text), "and never a code that is not a fault");
    assert(!/another lead/.test(text), "with no taken time split, which a fault never is");
    assert(NOT_A_GATE.test(text) && /not a promise/.test(text), "and the same plain statement of what it is");
    assert(!/^Slate/.test(text), "availability page does not open with the app's own name");
    noDash(text, "availability page");
    noEmoji(text, "availability page");
  } else assert(false, "the availability fixture is half spent");

  for (const name of ["success", "availability"] as const) {
    const clear = sloBudgetClearText(name, "2026-11");
    assert(clear.includes("November 2026") && /under half spent/.test(clear), `${name} all-clear renders`);
    assert(!/^Slate/.test(clear), `${name} all-clear does not open with the app's own name`);
    noDash(clear, `${name} all-clear`);
    noEmoji(clear, `${name} all-clear`);
  }
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
