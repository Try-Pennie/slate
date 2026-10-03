/**
 * The monthly booking targets in docs/slo.md, and the pilot measurement they were set from (#3141).
 *
 * Dan, 2026-10-03: set each target from pilot data, a little below what the pilot actually
 * achieved; they are internal measures, not promises. So the measurement is written down here
 * as data and every figure the document quotes (the measured shares, the targets' error
 * budgets, the monthly request count they are spent against) is DERIVED from it, never typed a
 * second time. `scripts/test-slo-doc.ts` reads the document and fails when a number in it is
 * not the number this file produces, so the prose cannot drift from the decision (L41).
 *
 * PURE, and its one import is relative, so the node suite reads it without the alias hook.
 */
import { REFUSAL_CATALOG } from "../booking/refusal-catalog.ts";

/**
 * Production `booking_api_outcome_daily`, non-test rows, 2026-09-29 to 2026-10-03 (the last
 * day partial), read on 2026-10-03. Every outcome the failure share counts is here; none was
 * recorded as `confirm_required`, and no error carried a server fault code at all.
 *
 * `createdPerSteadyDay` is the two whole days after the split sent half of every tier to
 * Slate (2026-10-01 15:46 UTC): the days before it carried one landing page and the last day
 * is partial, so neither is a rate a month will run at.
 */
export const PILOT_MEASUREMENT = {
  from: "2026-09-29",
  to: "2026-10-03",
  outcomes: {
    created: 1092,
    rescheduled: 40,
    cancelled: 57,
    deduped: 4,
    confirm_required: 0,
  },
  errors: {
    slot_unavailable: 6,
    invalid_request: 5,
    reschedule_slot_taken: 2,
  },
  createdPerSteadyDay: [357, 446],
} as const;

/** Share of counted booking requests that must NOT end in an error, per calendar month. */
export const BOOKING_SUCCESS_TARGET_PCT = 98.5;

/** Share of counted booking requests that must NOT end in a server fault (a 5xx), per month. */
export const AVAILABILITY_TARGET_PCT = 99.5;

/** Days in the month the budgets are quoted for. A 31 day month spends the same share. */
export const BUDGET_MONTH_DAYS = 30;

/**
 * Every error code the booking paths record for a SERVER fault: a 5xx the customer did nothing
 * to cause. Derived from the refusal catalog's own record of what each path answers, so a new
 * 5xx path joins the availability numerator by being catalogued, and a hand list cannot fall
 * behind it (L41, L96).
 */
export const SERVER_FAULT_ERROR_CODES: readonly string[] = REFUSAL_CATALOG.flatMap((path) =>
  path.counting.kind === "error" && /^5\d\d\b/.test(path.outcome) ? [path.counting.code] : [],
);

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Rounded to `places` decimals, as the document prints it. */
function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Everything the document quotes, computed. Requests are every outcome the booking failure
 * share counts (`OUTCOME_ORDER`), errors included, so the targets and the hourly page judge one
 * population.
 */
export function sloArithmetic(m: typeof PILOT_MEASUREMENT = PILOT_MEASUREMENT) {
  const errors = sum(Object.values(m.errors));
  const serverFaults = sum(
    Object.entries(m.errors)
      .filter(([code]) => SERVER_FAULT_ERROR_CODES.includes(code))
      .map(([, n]) => n),
  );
  const requests = sum(Object.values(m.outcomes)) + errors;
  const successPct = round(100 * (1 - errors / requests), 2);
  // Zero faults in n requests bounds the true fault rate below 3/n at 95 percent confidence
  // (the rule of three), which is what a target "a little below" a perfect pilot is set under.
  const faultUpperBoundPct = round((100 * 3) / requests, 2);
  const requestsPerCreated = requests / m.outcomes.created;
  const steadyCreatedPerDay = sum(m.createdPerSteadyDay) / m.createdPerSteadyDay.length;
  const requestsPerMonth = Math.round(steadyCreatedPerDay * requestsPerCreated * BUDGET_MONTH_DAYS);
  const bookingErrorBudgetPct = round(100 - BOOKING_SUCCESS_TARGET_PCT, 2);
  const availabilityBudgetPct = round(100 - AVAILABILITY_TARGET_PCT, 2);
  return {
    requests,
    errors,
    serverFaults,
    successPct,
    faultUpperBoundPct,
    steadyCreatedPerDay,
    requestsPerMonth,
    bookingErrorBudgetPct,
    bookingErrorBudgetPerMonth: Math.floor((requestsPerMonth * bookingErrorBudgetPct) / 100),
    availabilityBudgetPct,
    availabilityBudgetPerMonth: Math.floor((requestsPerMonth * availabilityBudgetPct) / 100),
  };
}
