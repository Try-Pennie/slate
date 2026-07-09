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

/** A `FallbackCovered` enriched by the caller with the human tier names and the
 *  eligible-agent depth of both tiers (#585), so the notice is actionable at a
 *  glance without the on-call reader decoding raw codes. `emptyDepth` /
 *  `coverDepth` are null when the count is unknown (e.g. a budget-truncated
 *  scan left that bucket out of the health scan). */
export interface FallbackCoveredDetail extends FallbackCovered {
  tierName: string;
  viaTierName: string;
  emptyDepth: number | null;
  coverDepth: number | null;
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

/** Low-priority info signal (#567), self-explaining (#585): empty buckets the
 *  tier-drop fallback still covers, so no customer is stranded. Each line names
 *  the empty tier and its covering rung by human name, states the likely cause
 *  (eligible agents on shift but no times, so calendars look full), and flags a
 *  one-deep covering tier as thin coverage. No em/en dashes (copy rule). */
export function formatFallbackCoveredNotice(covered: FallbackCoveredDetail[]): string {
  const lines = covered.slice(0, ALERT_NAME_CAP).map((c) => {
    const cause =
      c.emptyDepth === 1
        ? "its sole agent looks fully booked"
        : c.emptyDepth != null
          ? `its ${c.emptyDepth} agents look fully booked`
          : "its agents look fully booked";
    const cover =
      c.coverDepth === 1
        ? ", which is only one agent deep, so coverage is thin"
        : c.coverDepth != null
          ? `, ${c.coverDepth} agents deep`
          : "";
    return `${c.code} (${c.tierName}): ${cause}; covered by ${c.via} (${c.viaTierName})${cover}.`;
  });
  const more =
    covered.length > ALERT_NAME_CAP ? ` (and ${covered.length - ALERT_NAME_CAP} more)` : "";
  return (
    `Slate (info): ${covered.length} tier(s) show no times, but a lower tier is still ` +
    `covering them, so no customer is blocked (thin-capacity heads up, not an outage).${more}\n` +
    lines.join("\n")
  );
}

/** Why a paged (dead-end) bucket shows no times, from a live recompute vs the
 *  cached zero. `bookedSolid`: recompute also 0 (calendars genuinely full).
 *  `dataAnomaly`: recompute > 0 (cache disagrees with reality). `unverified`:
 *  the recompute failed, so the cause could not be confirmed. */
export interface DeadEndCause {
  bookedSolid: string[];
  dataAnomaly: string[];
  unverified: string[];
}

/** Split the paged bucket codes by live recompute slot count. A code missing
 *  from the map, or mapped to null, is `unverified` (recompute failed): we still
 *  surface it, erring toward flagging a possible problem over going silent. */
export function classifyDeadEndCause(
  pageCodes: string[],
  recomputeSlotCount: Map<string, number | null>,
): DeadEndCause {
  const bookedSolid: string[] = [];
  const dataAnomaly: string[] = [];
  const unverified: string[] = [];
  for (const code of pageCodes) {
    const count = recomputeSlotCount.get(code);
    if (!recomputeSlotCount.has(code) || count === null || count === undefined) {
      unverified.push(code);
    } else if (count > 0) {
      dataAnomaly.push(code);
    } else {
      bookedSolid.push(code);
    }
  }
  return { bookedSolid, dataAnomaly, unverified };
}

/** Truncated "code, code and N more" for one cause group. */
function capList(codes: string[]): string {
  const head = codes.slice(0, ALERT_NAME_CAP).join(", ");
  const more = codes.length > ALERT_NAME_CAP ? ` and ${codes.length - ALERT_NAME_CAP} more` : "";
  return `${head}${more}`;
}

/** Urgent page body for real dead-ends whose cause is a data/sync fault (or could
 *  not be verified). Booked-solid buckets are NOT included here (they are a quiet
 *  info signal). No em/en dashes (copy lint). */
export function formatDataAnomalyAlert(cause: DeadEndCause): string {
  const parts: string[] = [];
  if (cause.dataAnomaly.length) {
    parts.push(
      `${cause.dataAnomaly.length} bucket(s) show NO booking times but the agents' ` +
        `calendars are OPEN (${capList(cause.dataAnomaly)}): the cached availability ` +
        `disagrees with reality. Check the precompute and calendar sync pipeline.`,
    );
  }
  if (cause.unverified.length) {
    parts.push(
      `${cause.unverified.length} bucket(s) could not be verified because the live ` +
        `recompute failed (${capList(cause.unverified)}); treat as a possible sync issue.`,
    );
  }
  return `Slate: ${parts.join(" ")}`;
}

/** Low-priority info body: tiers empty because the agents are booked solid. This
 *  is a capacity fact, not an outage, so it whispers on a long cooldown. No
 *  em/en dashes (copy lint). */
export function formatBookedSolidNotice(bookedSolid: string[]): string {
  return (
    `Slate (info): ${bookedSolid.length} tier(s) show no booking times because the ` +
    `agents are booked solid (${capList(bookedSolid)}). Calendars are full, not ` +
    `broken; this is a capacity heads up, so check staffing if it persists.`
  );
}
