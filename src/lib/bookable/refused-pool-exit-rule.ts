/**
 * The rule that decides when Google has refused an advisor's calendar for long
 * enough that Slate takes them out of the pool (#3700). Pure and clock free (the
 * time is passed in), so the alert preview can import the period it renders and
 * the sync lane's action (`refused-pool-exit.ts`) judges by the same numbers.
 *
 * An advisor is taken out when EVERY calendar row they hold has been refused
 * throughout the period (`isRefusedThroughoutPeriod`):
 *
 *  - definitive, judged by `isDefinitiveFailure` (both `gone` and `not-provisioned`;
 *    `transient` never), and classified: a null kind is a failure nothing classified,
 *    which is not evidence of a refusal, so it is left alone;
 *  - current: `consecutive_failures` is reset by every good read, so a streak means
 *    the latest read failed and no read since `last_success_at` succeeded. The sync
 *    lane only asks about advisors whose sync failed on THIS tick, so the failure is
 *    a minute old, never a stale stamp on a calendar nobody is reading;
 *  - sustained: `last_success_at` is at least `REFUSED_POOL_EXIT_AFTER_MS` ago, so
 *    nothing has read cleanly for the whole period; a calendar that never read
 *    cleanly has no measured period at all and is left alone;
 *  - measured: at least `REFUSED_POOL_EXIT_MIN_FAILED_READS` failed reads, so an hour
 *    old `last_success_at` meeting one bad read (an advisor not read for a while) is
 *    not mistaken for an hour of refusals.
 *
 * Every calendar rather than any one, so a failing secondary calendar (a shared one
 * deleted, say) beside a healthy primary never removes an advisor whose own account
 * is fine. Since #42 only primaries are stored, so in practice this is the primary.
 *
 * What it cannot see: the kind of each EARLIER failure in the streak, only the
 * latest (`last_failure_kind`). A streak that began transient and turned definitive
 * reads as an hour of refusal. Either way nothing read for an hour and the latest
 * answer is one no retry fixes.
 */
import { isDefinitiveFailure, type FailureKind } from "@/lib/google/sync-health";
import { GONE_BACKOFF_STREAK } from "@/lib/google/sync-coalesce";
import { parseStampMs } from "@/lib/date/stamp";

/**
 * How long Google must have refused an advisor's calendar before Slate takes them
 * out of the pool. Dan's starting value (2026-10-20): long enough that a Workspace
 * change being made and corrected inside a working hour never moves anyone, short
 * enough that an offboarded advisor stops being offered within about an hour.
 */
export const REFUSED_POOL_EXIT_AFTER_MS = 60 * 60_000;

/**
 * The fewest failed reads that make the period a measurement rather than an
 * inference. The sync lane reads a refused calendar every minute until it has failed
 * `GONE_BACKOFF_STREAK` times, then once every ten minutes (`GONE_RETRY_INTERVAL_MIN`).
 * Two reads past the backoff means the refusal was seen again at least ten minutes
 * after it was established, on reads spread across the period, never in one burst.
 * An hour at the lane's cadence gives eight or so, so this is a floor that a healthy
 * lane clears well before the period does.
 */
export const REFUSED_POOL_EXIT_MIN_FAILED_READS = GONE_BACKOFF_STREAK + 2;

/** One `agent_calendars` row as the rule reads it (sync lane columns only). */
export interface RefusedCalendarRow {
  user_id: string;
  calendar_id: string;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_kind: FailureKind | null;
}

/** Whether one calendar has been definitively refused for the whole period. */
export function isRefusedThroughoutPeriod(c: RefusedCalendarRow, nowMs: number): boolean {
  if (c.last_failure_kind === null || !isDefinitiveFailure(c.last_failure_kind)) return false;
  if (c.consecutive_failures < REFUSED_POOL_EXIT_MIN_FAILED_READS) return false;
  const lastOkMs = parseStampMs(c.last_success_at);
  if (lastOkMs === null) return false;
  return nowMs - lastOkMs >= REFUSED_POOL_EXIT_AFTER_MS;
}

/** Advisors every one of whose calendars has been refused for the whole period. */
export function refusedAdvisorIds(calendars: RefusedCalendarRow[], nowMs: number): string[] {
  const verdict = new Map<string, boolean>();
  for (const c of calendars) {
    const refused = isRefusedThroughoutPeriod(c, nowMs);
    verdict.set(c.user_id, (verdict.get(c.user_id) ?? true) && refused);
  }
  return [...verdict].filter(([, refused]) => refused).map(([id]) => id);
}
