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

/** One empty bucket whose tier-drop fallback still serves a customer: `via` is
 *  the first lower ladder rung that has slots. */
export interface FallbackCovered {
  code: string;
  via: string;
}

export interface EmptyBucketClassification {
  /** Empty buckets whose ENTIRE tier ladder is also dry: a real customer
   *  dead-end. These page at normal urgency. */
  page: string[];
  /** Empty buckets a lower ladder rung still covers: no customer is stranded,
   *  so these are a low-priority info signal, not a page. */
  covered: FallbackCovered[];
}

/**
 * Split the empty-but-should-show buckets (from `failingBuckets`) by whether the
 * booker's tier-drop fallback still serves a customer (#567). For each failing
 * bucket we walk the SAME ladder the booker uses (`getBucketSlotsWithFallback` /
 * `selectWithTierFallback`) over the already-loaded slot counts, skipping
 * synthetic test buckets exactly as the booking cascade does: the first lower
 * rung with slots means the bucket is `covered`; an all-dry ladder means `page`.
 * Pure — the caller injects `ladder` (the real `tierLadder`) and `bucketInfo`
 * (slot count + is_test per code) so this stays node-native testable and does no
 * extra IO (the probe already loaded every bucket's slot count).
 */
export function classifyEmptyBuckets(
  rows: BucketHealth[],
  opts: {
    nowMs: number;
    freshWindowMs: number;
    ladder: (code: string) => string[];
    bucketInfo: Map<string, { slotCount: number; isTest: boolean }>;
  },
): EmptyBucketClassification {
  const failing = failingBuckets(rows, { nowMs: opts.nowMs, freshWindowMs: opts.freshWindowMs });
  const page: string[] = [];
  const covered: FallbackCovered[] = [];
  for (const code of failing) {
    // Lower tiers only (drop the requested code itself, which is empty).
    const rungs = opts.ladder(code).slice(1);
    let via: string | null = null;
    for (const rung of rungs) {
      const info = opts.bucketInfo.get(rung);
      // Skip missing rows and synthetic test buckets (the booker cascade skips
      // them too), so a test bucket's slots never masquerade as real coverage.
      if (!info || info.isTest) continue;
      if (info.slotCount > 0) {
        via = rung;
        break;
      }
    }
    if (via) covered.push({ code, via });
    else page.push(code);
  }
  return { page, covered };
}

const ALERT_NAME_CAP = 8;

/** Slack body for a sustained empty-availability fault. Only fires now for a true
 *  customer dead-end (the requested bucket AND its whole tier ladder are empty),
 *  so the copy says so. No em/en dashes (the copy lint forbids them). */
export function formatEmptyAvailabilityAlert(codes: string[]): string {
  const head = codes.slice(0, ALERT_NAME_CAP).join(", ");
  const more = codes.length > ALERT_NAME_CAP ? ` and ${codes.length - ALERT_NAME_CAP} more` : "";
  return (
    `Slate: ${codes.length} bucket(s) have agents on shift but show NO booking times, ` +
    `and their lower fallback tiers are also empty (${head}${more}). ` +
    `A customer requesting these tiers cannot book; check calendar sync and agent schedules.`
  );
}

/** Low-priority info signal (#567): empty buckets the tier-drop fallback still
 *  covers, so no customer is stranded. Names each empty bucket and the lower rung
 *  serving it. No em/en dashes (copy rule). */
export function formatFallbackCoveredNotice(covered: FallbackCovered[]): string {
  const head = covered
    .slice(0, ALERT_NAME_CAP)
    .map((c) => `${c.code} via ${c.via}`)
    .join(", ");
  const more = covered.length > ALERT_NAME_CAP ? ` and ${covered.length - ALERT_NAME_CAP} more` : "";
  return (
    `Slate (info): ${covered.length} tier(s) show no times but the fallback is covering them ` +
    `(${head}${more}). No customer is blocked; this is a thin-capacity heads up, not an outage.`
  );
}
