/**
 * Pure logic for the availability-health probe (#371): the DB-only "this bucket
 * should be bookable but shows no times" signal, plus the per-agent on-shift gate
 * that keeps it quiet when a bucket is legitimately closed (no eligible agent
 * working right now). No `@/` imports so scripts/test-monitor-availability-health.ts
 * can run it node-native; the IO (eligible counts, schedules, bucket_slots reads,
 * Slack) lives in the cron route.
 */
import { DateTime } from "luxon";

/** A working-hours window for one weekday (1=Mon..7=Sun), minutes from local
 *  midnight. Structurally matches availability/compute.ts's WorkingRule. */
export interface WorkingRule {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

/** True when `nowMs`, expressed in the agent's OWN timezone, falls inside one of
 *  their working-hours rules. Anchored per-agent in their zone so it tracks both
 *  daylight-saving and agents who work non-Eastern hours. An agent with no rules
 *  is never on shift (matches how availability treats a scheduleless agent). */
export function isWorkingNow(nowMs: number, timezone: string, rules: WorkingRule[]): boolean {
  const dt = DateTime.fromMillis(nowMs, { zone: timezone });
  const minute = dt.hour * 60 + dt.minute;
  return rules.some(
    (r) => r.weekday === dt.weekday && r.start_minute <= minute && minute < r.end_minute,
  );
}

export interface AgentShift {
  timezone: string;
  rules: WorkingRule[];
}

/** True when at least one of the bucket's eligible agents is on shift now. */
export function anyOnShift(nowMs: number, agents: AgentShift[]): boolean {
  return agents.some((a) => isWorkingNow(nowMs, a.timezone, a.rules));
}

export interface BucketHealth {
  code: string;
  eligibleCount: number;
  slotCount: number;
  /** When the cached bucket_slots row was last computed (epoch ms), or null if
   *  the bucket has no cached row at all. */
  computedAtMs: number | null;
  /** Whether any eligible agent is on shift right now (i.e. the bucket should be
   *  showing times). */
  onShiftNow: boolean;
}

/**
 * Buckets that SHOULD show availability but don't: an eligible agent is on shift,
 * the cache is FRESH (so the precompute genuinely produced zero, not a missing or
 * stale row), yet zero slots. A bucket with nobody on shift is legitimately
 * closed; a missing/stale row is the recompute lane's concern; a zero-agent
 * bucket is #327's. This is the distinct "agents working but the booker shows
 * nothing" signal (wedged sync, broken schedules, empty cache).
 */
export function failingBuckets(
  rows: BucketHealth[],
  opts: { nowMs: number; freshWindowMs: number },
): string[] {
  return rows
    .filter(
      (r) =>
        r.eligibleCount > 0 &&
        r.onShiftNow &&
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
    `Slate: ${codes.length} bucket(s) have agents on shift but show NO booking times ` +
    `(${head}${more}). The booker may be serving empty availability; ` +
    `check calendar sync and agent schedules.`
  );
}
