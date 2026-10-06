/**
 * Is a month's booking error budget half spent (#3179)?
 *
 * docs/slo.md sets two monthly targets from the pilot (#3141): booking success, the share
 * of counted booking requests that end without an error, and availability, the share that
 * end without a server fault. Each leaves an error budget, and both were read by hand
 * with a SQL query at month end, so a month could spend its whole budget with nothing
 * saying so. This is the check that says so at HALF, while there is still a month left
 * to act in.
 *
 * ## What the budget is, in requests
 *
 * A target is a share, so the budget in requests is that share of the MONTH'S requests,
 * which nobody knows until the month is over. Two readings would be wrong in opposite
 * directions: the month to date alone makes the first morning's budget a fraction of one
 * request, so the first error of the month reads as the budget blown; the documented
 * projection alone (about 13,302 requests, `sloArithmetic`) stops growing when traffic
 * does. So the budget is the share of whichever is larger, the projection or the requests
 * already counted: never below the documented figure, and growing with a month that
 * outruns it. A month whose traffic falls well short of the projection is judged against
 * the documented budget, which is the number the targets were written in.
 *
 * ## Which way it fails
 *
 * A reading that cannot be right (a negative count, more faults than errors, more errors
 * than requests) is `unmeasured` and sends nothing in either direction: neither a page
 * built on it nor an all-clear hung off it would be a claim anybody measured (#1134,
 * #1152). A read that fails throws through to the step's failure boundary.
 *
 * PURE, and its one value import is relative, so scripts/test-slo-budget.ts drives every
 * branch node-natively. The read lives in slo-budget-store.ts.
 */
import type { ThrottledNotify } from "./alert-deps";
import {
  AVAILABILITY_TARGET_PCT,
  BOOKING_SUCCESS_TARGET_PCT,
  SERVER_FAULT_ERROR_CODES,
  SLOT_TAKEN_ERROR_CODES,
  sloArithmetic,
} from "./slo-targets.ts";

/** Page once this share of a month's budget is spent. */
export const BUDGET_WARN_SHARE = 0.5;

export type BudgetName = "success" | "availability";

/** One key per budget under one catalogued prefix, so each clears on its own. */
export const BOOKING_BUDGET_ALERT_KEYS: Record<BudgetName, string> = {
  success: "booking_budget:success",
  availability: "booking_budget:availability",
};

/** The month to date, read from `booking_api_outcome_daily` (non-test, on site). */
export interface MonthToDate {
  /** `YYYY-MM`, in the zone the tally is bucketed in. */
  month: string;
  /** Every counted booking request: the outcomes the hourly failure page counts. */
  requests: number;
  /** The error outcome. */
  errors: number;
  /** The errors whose code is a server fault (`SERVER_FAULT_ERROR_CODES`). */
  serverFaults: number;
  /**
   * The month's errors by code, from the same read (#3374), so the page can say which
   * codes spent the budget. An error recorded with no code is not in it (the mix RPC
   * leaves an empty code out), so these can add up to LESS than `errors` and never to more.
   */
  errorCodes: ErrorCount[];
}

export interface ErrorCount {
  code: string;
  count: number;
}

export interface BudgetSpend {
  name: BudgetName;
  targetPct: number;
  /** Requests the budget may spend this month. */
  allowed: number;
  spent: number;
  /** `spent / allowed`. */
  share: number;
  requests: number;
  /** The codes that spent THIS budget, largest first: every error code for booking
   *  success, the server fault codes alone for availability. */
  byCode: ErrorCount[];
}

/** Largest first, ties by code, so the code a page names never depends on read order. */
function largestFirst(codes: readonly ErrorCount[]): ErrorCount[] {
  return [...codes].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * The booking success errors split into a time that had gone before the lead confirmed
 * (`SLOT_TAKEN_ERROR_CODES`, usually another lead booking it first) and everything else
 * (#3374). Those are different things to whoever reads the page: one is a month that
 * sold out, the other a month where something needs looking at.
 *
 * `taken` is only what was measured under a taken code; an error with no code belongs to
 * the rest. The split is `unmeasured` when the codes cannot be the errors' own breakdown
 * (more than the errors, a negative count) or when there are errors and no codes at all,
 * where a taken count of zero would be a claim nobody measured (L622).
 */
export type TakenSplit =
  | { kind: "measured"; taken: number; takenTop: ErrorCount | null; rest: number; restTop: ErrorCount | null }
  | { kind: "unmeasured"; reason: string };

export function splitTakenTimes(errors: number, byCode: readonly ErrorCount[]): TakenSplit {
  if (!byCode.every((e) => Number.isFinite(e.count) && e.count >= 0)) {
    return { kind: "unmeasured", reason: "an error code count came back that is not a count" };
  }
  const coded = byCode.reduce((sum, e) => sum + e.count, 0);
  if (coded > errors) {
    return { kind: "unmeasured", reason: `the error codes add up to ${count(coded)}, more than the errors` };
  }
  if (errors > 0 && coded === 0) {
    return { kind: "unmeasured", reason: "the read carried no error codes for them" };
  }
  const sorted = largestFirst(byCode).filter((e) => e.count > 0);
  const takenCodes = sorted.filter((e) => SLOT_TAKEN_ERROR_CODES.includes(e.code));
  const restCodes = sorted.filter((e) => !SLOT_TAKEN_ERROR_CODES.includes(e.code));
  const taken = takenCodes.reduce((sum, e) => sum + e.count, 0);
  return {
    kind: "measured",
    taken,
    takenTop: takenCodes[0] ?? null,
    rest: errors - taken,
    restTop: restCodes[0] ?? null,
  };
}

export type BudgetVerdict =
  | { kind: "unmeasured"; reason: string }
  | { kind: "half-spent"; spend: BudgetSpend }
  | { kind: "within"; spend: BudgetSpend };

/** The first day of the month a tally day belongs to, as the RPC's `p_since`. */
export function monthStartDay(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`;
}

function unreadable(m: MonthToDate): string | null {
  const counts = [m.requests, m.errors, m.serverFaults];
  if (!counts.every((n) => Number.isFinite(n) && n >= 0)) return "a count came back that is not a count";
  if (m.serverFaults > m.errors) return `counted ${m.serverFaults} server faults in ${m.errors} errors`;
  if (m.errors > m.requests) return `counted ${m.errors} errors in ${m.requests} requests`;
  return null;
}

/** Judge both budgets for the month to date. */
export function judgeBudgets(
  m: MonthToDate,
  projectedRequestsPerMonth: number = sloArithmetic().requestsPerMonth,
): Record<BudgetName, BudgetVerdict> {
  const reason = unreadable(m);
  if (reason) {
    const unmeasured: BudgetVerdict = { kind: "unmeasured", reason };
    return { success: unmeasured, availability: unmeasured };
  }
  const monthRequests = Math.max(projectedRequestsPerMonth, m.requests);
  const judge = (name: BudgetName, targetPct: number, spent: number, byCode: ErrorCount[]): BudgetVerdict => {
    // At least one, so a budget can never be zero and every error read as all of it.
    const allowed = Math.max(1, Math.floor((monthRequests * (100 - targetPct)) / 100));
    const spend: BudgetSpend = {
      name,
      targetPct,
      allowed,
      spent,
      share: spent / allowed,
      requests: m.requests,
      byCode: largestFirst(byCode),
    };
    return spend.share >= BUDGET_WARN_SHARE ? { kind: "half-spent", spend } : { kind: "within", spend };
  };
  return {
    success: judge("success", BOOKING_SUCCESS_TARGET_PCT, m.errors, m.errorCodes),
    availability: judge(
      "availability",
      AVAILABILITY_TARGET_PCT,
      m.serverFaults,
      m.errorCodes.filter((e) => SERVER_FAULT_ERROR_CODES.includes(e.code)),
    ),
  };
}

const WHAT: Record<BudgetName, { budget: string; spentOn: string; target: string }> = {
  success: {
    budget: "booking error budget",
    spentOn: "booking requests ended in an error",
    target: "success target",
  },
  availability: {
    budget: "availability error budget",
    spentOn: "booking requests ended in a server fault",
    target: "availability target",
  },
};

/**
 * What spending the budget does, which is nothing (#3374). The 2026-10-06 page left its
 * reader asking twice what it meant and what happens when it runs out; the answers lived
 * only in docs/slo.md (Dan, 2026-10-03: internal measures, not promises).
 */
const NOT_A_GATE =
  "Nothing is blocked, slowed or switched off when the budget runs out: it compares this month with the pilot, " +
  "and is an internal measure, not a promise.";

const WHERE = "Every code is in the booking outcome panel (/admin/booking-outcomes).";

const TAKEN = "a time that had gone before the lead confirmed";
const WHY_TAKEN = "usually because another lead booked it first";

const largest = (e: ErrorCount): string => `largest code ${e.code}, ${count(e.count)}`;

/** The second line of the booking success page: taken times against everything else. */
function takenLine(spent: number, byCode: readonly ErrorCount[]): string {
  const split = splitTakenTimes(spent, byCode);
  const n = count(spent);
  if (split.kind === "unmeasured") {
    return `Could not tell how many of the ${n} were ${TAKEN}: ${split.reason}.`;
  }
  const restTop = split.restTop ? ` (${largest(split.restTop)})` : ", though none of them carried an error code";
  if (split.taken === 0) {
    return `None of the ${n} was ${TAKEN}, so every one is worth a look${restTop}.`;
  }
  const takenTop = split.takenTop ? ` (${largest(split.takenTop)})` : "";
  if (split.rest === 0) {
    return `All ${n} were ${TAKEN}, ${WHY_TAKEN}${takenTop}.`;
  }
  const taken = `${count(split.taken)} of the ${n} ${split.taken === 1 ? "was" : "were"} ${TAKEN}, ${WHY_TAKEN}${takenTop}.`;
  const rest = split.rest === 1 ? "The other one is worth a look" : `The other ${count(split.rest)} are worth a look`;
  return `${taken} ${rest}${restTop}.`;
}

/** The second line of the availability page: every error there is a fault of ours. */
function faultLine(byCode: readonly ErrorCount[]): string {
  const top = byCode.find((e) => e.count > 0);
  return (
    `Each was a lead turned away by a fault of ours, not of theirs${top ? ` (${largest(top)})` : ""}. ` +
    "The faults themselves are in the Worker logs."
  );
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `2026-10` as `October 2026`, with no locale or clock involved. */
function monthName(month: string): string {
  const name = MONTHS[Number(month.slice(5, 7)) - 1];
  return name ? `${name} ${month.slice(0, 4)}` : month;
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;
const count = (n: number): string => n.toLocaleString("en-US");

/**
 * What the page says, one line each so it reads on a phone: what was spent against what;
 * what spent it (for booking success, a taken time against everything else); and what
 * spending it does, which is nothing, with where to look.
 */
export function sloBudgetPageText(s: BudgetSpend, month: string): string {
  const w = WHAT[s.name];
  const spent =
    `${pct(s.share)} of the ${monthName(month)} ${w.budget} is spent: ` +
    `${count(s.spent)} ${w.spentOn}, of about ${count(s.allowed)} the ${s.targetPct}% ${w.target} allows ` +
    `this month (${count(s.requests)} requests so far).`;
  const what = s.name === "success" ? takenLine(s.spent, s.byCode) : faultLine(s.byCode);
  return `${spent}\n${what}\n${NOT_A_GATE} ${WHERE}`;
}

/** What the all-clear says. A condition, so it owes one. */
export function sloBudgetClearText(name: BudgetName, month: string): string {
  return `The ${monthName(month)} ${WHAT[name].budget} is under half spent.`;
}

export interface SloBudgetDeps {
  /** The month to date. THROWS on a failed read, never answers zeros. */
  read: () => Promise<MonthToDate>;
  projectedRequestsPerMonth?: number;
  cooldownMs: number;
  notify: ThrottledNotify;
  /** `resolveRecovered`: one alert_state read for both keys. */
  resolveRecovered: (recovered: { key: string; text: string }[]) => Promise<unknown>;
  /** One line per budget per tick, the measured figures or why there were none. */
  log?: (fields: Record<string, unknown>) => void;
}

/**
 * One tick: page each budget at or past half, and clear the rest. The clears are hung
 * off a MEASURED within verdict only; an unmeasured reading does neither, and a read
 * that throws is thrown on before anything is sent or cleared.
 */
export async function runSloBudgetCheck(
  deps: SloBudgetDeps,
): Promise<{ month: string; verdicts: Record<BudgetName, BudgetVerdict> }> {
  const m = await deps.read();
  const verdicts = judgeBudgets(m, deps.projectedRequestsPerMonth);
  const recovered: { key: string; text: string }[] = [];
  for (const name of ["success", "availability"] as const) {
    const v = verdicts[name];
    deps.log?.({
      month: m.month,
      budget: name,
      verdict: v.kind,
      ...(v.kind === "unmeasured" ? { why: v.reason } : { spent: v.spend.spent, allowed: v.spend.allowed }),
    });
    if (v.kind === "half-spent") {
      await deps.notify(BOOKING_BUDGET_ALERT_KEYS[name], deps.cooldownMs, sloBudgetPageText(v.spend, m.month));
    } else if (v.kind === "within") {
      recovered.push({ key: BOOKING_BUDGET_ALERT_KEYS[name], text: sloBudgetClearText(name, m.month) });
    }
  }
  // all-clear-proof: scripts/test-slo-budget.ts - pins that a failed read and an
  // impossible reading each clear nothing (resolved.length, 0).
  if (recovered.length > 0) await deps.resolveRecovered(recovered);
  return { month: m.month, verdicts };
}
