/**
 * Pure logic for the availability-health probe (#371): the DB-only "this bucket
 * should be bookable but shows no times" signal, plus the business-hours gate
 * that keeps it quiet outside the hours customers actually book. No `@/` imports
 * so scripts/test-monitor-availability-health.ts can run it node-native; the IO
 * (eligible-agent counts, bucket_slots reads, Slack) lives in the cron route.
 */
import { DateTime } from "luxon";

export interface BusinessHoursConfig {
  /** IANA zone the hours are expressed in (Eastern, so it tracks DST). */
  zone: string;
  /** Luxon weekdays the probe is active: 1=Mon .. 7=Sun. */
  weekdays: number[];
  /** Local hour the window opens (inclusive). */
  startHour: number;
  /** Local hour the window closes (exclusive). */
  endHour: number;
}

/** True when `nowMs` falls on an active weekday within [startHour, endHour) in
 *  the configured zone. Anchored in Eastern time so the window doesn't drift an
 *  hour across daylight-saving. */
export function isWithinBusinessHours(nowMs: number, cfg: BusinessHoursConfig): boolean {
  const dt = DateTime.fromMillis(nowMs, { zone: cfg.zone });
  if (!cfg.weekdays.includes(dt.weekday)) return false;
  return dt.hour >= cfg.startHour && dt.hour < cfg.endHour;
}

export interface BucketHealth {
  code: string;
  eligibleCount: number;
  slotCount: number;
  /** When the cached bucket_slots row was last computed (epoch ms), or null if
   *  the bucket has no cached row at all. */
  computedAtMs: number | null;
}

/**
 * Buckets that SHOULD show availability but don't: they have eligible agents,
 * their cache is FRESH (so the precompute genuinely produced zero, rather than
 * the row being missing or stale), yet zero slots. A missing/stale row is the
 * recompute lane's concern; a zero-agent bucket is #327's. This is the distinct
 * "agents assigned but the booker shows nothing" signal (wedged sync, broken
 * schedules, empty cache).
 */
export function failingBuckets(
  rows: BucketHealth[],
  opts: { nowMs: number; freshWindowMs: number },
): string[] {
  return rows
    .filter(
      (r) =>
        r.eligibleCount > 0 &&
        r.slotCount === 0 &&
        r.computedAtMs !== null &&
        opts.nowMs - r.computedAtMs <= opts.freshWindowMs,
    )
    .map((r) => r.code);
}

const ALERT_NAME_CAP = 8;

/** Slack body for a sustained empty-availability fault. No em/en dashes (the
 *  copy lint forbids them in user-facing strings); colons only. */
export function formatEmptyAvailabilityAlert(codes: string[]): string {
  const head = codes.slice(0, ALERT_NAME_CAP).join(", ");
  const more = codes.length > ALERT_NAME_CAP ? ` and ${codes.length - ALERT_NAME_CAP} more` : "";
  return (
    `Slate: ${codes.length} bucket(s) have eligible agents but show NO booking times ` +
    `during business hours (${head}${more}). The booker may be serving empty availability; ` +
    `check calendar sync and agent schedules.`
  );
}
