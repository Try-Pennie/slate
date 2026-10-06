/**
 * The read half of the monthly error budget check (#3179). Kept out of slo-budget.ts so
 * that module stays node-testable with no `@/` imports.
 *
 * The month to date is ONE call to the same aggregate RPC the hourly failure page reads
 * (`readCountedOutcomeMix`), from the first of the month, so the two judge one population
 * and the read costs one subrequest on a lane whose invocation is shared. It throws on a
 * failed read rather than answering zeros, which would read as a month with nothing spent
 * and clear a standing page. (`readCountedOutcomeMix` reads through `unwrap`, so a failed
 * read throws here before any count, the error codes included, is built.)
 */
import { outcomeDay, readCountedOutcomeMix } from "@/lib/monitor/booking-failure-rate-store";
import { monthStartDay, type MonthToDate } from "@/lib/monitor/slo-budget";
import { SERVER_FAULT_ERROR_CODES } from "@/lib/monitor/slo-targets";

export async function readMonthToDate(nowMs: number): Promise<MonthToDate> {
  const since = monthStartDay(outcomeDay(nowMs));
  const mix = await readCountedOutcomeMix(since);
  const errors = mix.outcomes.find((o) => o.outcome === "error")?.count ?? 0;
  const serverFaults = mix.errors
    .filter((e) => SERVER_FAULT_ERROR_CODES.includes(e.code))
    .reduce((sum, e) => sum + e.count, 0);
  // The error mix by code comes back on the SAME read (#3374), so the page's split
  // costs no second subrequest and judges the same population as the counts.
  const errorCodes = mix.errors.map((e) => ({ code: e.code, count: e.count }));
  return { month: since.slice(0, 7), requests: mix.total, errors, serverFaults, errorCodes };
}
