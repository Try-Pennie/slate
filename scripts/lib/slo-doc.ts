// The lines docs/slo.md must carry, generated from the constants the checks and the targets
// actually use (#3141, L41).
//
// docs/slo.md ends on a rule ("a number in this document that no check reads is worse than
// an undocumented threshold"), and nothing enforced it: the failure rate row still said one
// hour after #2494 moved the window to three, and still said "disarmed" two days after it was
// armed. So every number the document quotes is a WHOLE LINE generated here, and the guard
// requires that exact line. A bare number would be satisfied by the same digits anywhere in
// the file (L135); a line is satisfied only where it is meant.
import {
  AVAILABILITY_TARGET_PCT,
  BOOKING_SUCCESS_TARGET_PCT,
  BUDGET_MONTH_DAYS,
  PILOT_MEASUREMENT,
  SERVER_FAULT_ERROR_CODES,
  sloArithmetic,
} from "../../src/lib/monitor/slo-targets.ts";
import {
  CRON_BUDGET_WARN_MS,
  CRON_BUDGET_WINDOW_MS,
  CRON_CPU_LIMIT_MS,
} from "../../src/lib/monitor/cron-budget.ts";
import { SHIPPED_FAILURE_RATE_THRESHOLDS } from "../../src/lib/monitor/failure-rate-thresholds.ts";
import { BOOKING_BUDGET_ALERT_KEYS, BUDGET_WARN_SHARE } from "../../src/lib/monitor/slo-budget.ts";
import { AVAILABILITY_P50_BUDGET_MS, LATENCY_SAMPLES } from "./latency-slo.ts";

export interface SloDocLine {
  label: string;
  line: string;
}

const n = (v: number) => v.toLocaleString("en-US");
const s = (ms: number) => `${ms / 1000}s`;

export function expectedSloDocLines(): SloDocLine[] {
  const a = sloArithmetic();
  const m = PILOT_MEASUREMENT;
  const errorTerms = Object.entries(m.errors).map(([code, count]) => `${count} \`${code}\``);
  const fr = SHIPPED_FAILURE_RATE_THRESHOLDS;
  const steadyDays = m.createdPerSteadyDay.map(n).join(" and ");
  return [
    {
      label: "booking success target row",
      line:
        `| Booking success | **${BOOKING_SUCCESS_TARGET_PCT}%** of counted booking requests end without an error ` +
        `| **${a.bookingErrorBudgetPct}%** of requests, about **${n(a.bookingErrorBudgetPerMonth)}** a month ` +
        `| **${a.successPct}%** (${a.errors} errors in ${n(a.requests)}) |`,
    },
    {
      label: "availability target row",
      line:
        `| Availability | **${AVAILABILITY_TARGET_PCT}%** of counted booking requests end without a server fault ` +
        `| **${a.availabilityBudgetPct}%** of requests, about **${n(a.availabilityBudgetPerMonth)}** a month ` +
        `| no server fault in ${n(a.requests)}, so at most **${a.faultUpperBoundPct}%** at 95% confidence |`,
    },
    {
      label: "pilot request count",
      line:
        `- **Requests counted:** ${n(m.outcomes.created)} created, ${m.outcomes.rescheduled} rescheduled, ` +
        `${m.outcomes.cancelled} cancelled, ${m.outcomes.deduped} deduped, ${m.outcomes.confirm_required} ` +
        `confirm required and ${a.errors} errors, **${n(a.requests)}** in all.`,
    },
    {
      label: "pilot errors",
      line:
        `- **Errors:** ${errorTerms.join(", ")}. None is a server fault, so the measured success share is ` +
        `1 minus ${a.errors} / ${n(a.requests)} = **${a.successPct}%**, and the server fault share is zero.`,
    },
    {
      label: "monthly request estimate",
      line:
        `- **A month of requests:** ${steadyDays} created on the two whole days after the split, ` +
        `${a.steadyCreatedPerDay} a day, times ${n(a.requests)} / ${n(m.outcomes.created)} requests per booking ` +
        `created, times ${BUDGET_MONTH_DAYS} days = about **${n(a.requestsPerMonth)}**.`,
    },
    {
      label: "booking error budget",
      line:
        `- **Booking success budget:** 100 minus ${BOOKING_SUCCESS_TARGET_PCT} = **${a.bookingErrorBudgetPct}%**, ` +
        `${a.bookingErrorBudgetPct}% of ${n(a.requestsPerMonth)} = about **${n(a.bookingErrorBudgetPerMonth)}** ` +
        `errored requests a month.`,
    },
    {
      label: "availability error budget",
      line:
        `- **Availability budget:** 100 minus ${AVAILABILITY_TARGET_PCT} = **${a.availabilityBudgetPct}%**, ` +
        `${a.availabilityBudgetPct}% of ${n(a.requestsPerMonth)} = about **${n(a.availabilityBudgetPerMonth)}** ` +
        `server faults a month. Zero faults in ${n(a.requests)} bounds the true rate below 3 / ${n(a.requests)} = ` +
        `**${a.faultUpperBoundPct}%** at 95% confidence (the rule of three), and the target sits under that.`,
    },
    {
      label: "server fault codes",
      line: `Server fault codes: ${SERVER_FAULT_ERROR_CODES.map((c) => `\`${c}\``).join(", ")}.`,
    },
    {
      label: "server fault SQL list",
      line: `  in (${SERVER_FAULT_ERROR_CODES.map((c) => `'${c}'`).join(", ")})`,
    },
    {
      label: "automated budget check",
      line:
        `The monitor lane computes both every tick (\`booking_budget\` step, \`src/lib/monitor/slo-budget.ts\`) ` +
        `and pages ${Object.values(BOOKING_BUDGET_ALERT_KEYS).map((k) => `\`${k}\``).join(" or ")} once ` +
        `**${BUDGET_WARN_SHARE * 100}%** of a month's budget is spent, judging the same non-test, on site ` +
        `population as the hourly failure page.`,
    },
    {
      label: "hand query population filter",
      line: `where not is_test and host_class <> 'offsite'`,
    },
    {
      label: "cron headroom row",
      line:
        `| Cron wall time headroom | No tick past **${s(CRON_BUDGET_WARN_MS)}** of wall time, half the ` +
        `**${s(CRON_CPU_LIMIT_MS)}** \`limits.cpu_ms\`, in any **${CRON_BUDGET_WINDOW_MS / 3_600_000} hours** ` +
        `| The monitor lane's \`cron_budget\` step, from what \`worker/index.ts\` records per tick ` +
        `| \`src/lib/monitor/cron-budget.ts\` |`,
    },
    {
      label: "failure rate row",
      line:
        `| Share of booking attempts that end in an error | pages above **${fr.failPct}%** in a rolling ` +
        `**${fr.windowMs / 3_600_000} hour** window, with at least **${fr.minAttempts}** attempts ` +
        `| behind the "customers are failing to book" switch under Admin, Alerts |`,
    },
    {
      label: "availability latency row",
      line:
        `| The cached availability read | median under **${AVAILABILITY_P50_BUDGET_MS}ms** across ` +
        `**${LATENCY_SAMPLES}** samples, first dropped | The canary's latency step, every 30 minutes (#1047) |`,
    },
  ];
}

/** Statements the document made that stopped being true, and must not come back. */
export const RETIRED_SLO_CLAIMS: readonly { label: string; pattern: RegExp }[] = [
  { label: "the pre pilot no traffic caveat", pattern: /no real customer traffic/i },
  { label: "the failure rate page as disarmed", pattern: /\*\*Disarmed\.?\*\*/ },
  // #3179 computes the monthly budgets on the monitor lane.
  { label: "that nothing computes the monthly targets", pattern: /Nothing computes these/i },
];

/** Every expected line missing from `doc`, and every retired claim still in it. Empty is clean. */
export function sloDocFindings(
  doc: string,
  lines: SloDocLine[] = expectedSloDocLines(),
  retired = RETIRED_SLO_CLAIMS,
): string[] {
  const present = new Set(doc.split("\n"));
  const out: string[] = [];
  for (const { label, line } of lines) {
    if (!present.has(line)) out.push(`docs/slo.md no longer carries the ${label}, which should read:\n${line}`);
  }
  for (const { label, pattern } of retired) {
    if (pattern.test(doc)) out.push(`docs/slo.md still states ${label}`);
  }
  return out;
}
