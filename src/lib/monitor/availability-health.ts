/**
 * Pure logic for the availability-health probe (#371): the DB-only "this bucket
 * should be bookable but shows no times" signal, plus the per-agent on-shift gate
 * that keeps it quiet when a bucket is legitimately closed (no eligible agent
 * working right now). No `@/` imports so scripts/test-monitor-availability-health.ts
 * can run it node-native; the IO (eligible counts, schedules, bucket_slots reads,
 * Slack) lives in the cron route.
 */
import { DateTime } from "luxon";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { rungExcludesLow } from "../routing/tiers.ts";

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

/**
 * True when the bucket SHOULD be showing times right now: the org is open, and at
 * least one of its eligible agents is on shift.
 *
 * The org's own hours belong here (#1296) because `failingBuckets` below pages on
 * "an agent is working but the booker shows nothing", and the read path now filters
 * cached slots to the org's hours. Without this, closing the org would be
 * indistinguishable from a wedged cache: the count drops to zero for an entirely
 * intended reason, an agent is still rostered, and the probe pages about a bucket
 * behaving exactly as configured.
 *
 * Each side is judged in its OWN zone, matching the gate: the org's window in the
 * org's clock, each agent's in theirs.
 */
export function anyOnShift(
  nowMs: number,
  agents: AgentShift[],
  businessHours: AgentShift,
): boolean {
  if (!isWorkingNow(nowMs, businessHours.timezone, businessHours.rules)) return false;
  return agents.some((a) => isWorkingNow(nowMs, a.timezone, a.rules));
}

export interface BucketHealth {
  code: string;
  eligibleCount: number;
  /** How many slots a lead is being OFFERED, after the org-hours filter (#1296).
   *  `null` means the count could not be measured, which is NOT zero: an
   *  unmeasured bucket is excluded from every conclusion below rather than
   *  contributing a number nobody earned. */
  slotCount: number | null;
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
        // Strict equality, so an UNMEASURED bucket (null) is never read as a
        // confident zero and can never page (#1296).
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
    /**
     * `slotCountWithoutLow` (#2842) is what a rung below a top tier lead's own
     * tier is judged on, as the booker judges it. Absent or null is unmeasured,
     * so that rung is no rescue for those leads.
     */
    bucketInfo: Map<string, { slotCount: number | null; slotCountWithoutLow?: number | null; isTest: boolean }>;
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
      // An unmeasured rung (null) must not claim to cover a tier it might not, so
      // it is skipped rather than counted either way (#1296).
      // #2842: the same list the booker serves that lead from this rung.
      const count = rungExcludesLow(code, rung) ? (info.slotCountWithoutLow ?? null) : info.slotCount;
      if (count !== null && count > 0) {
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
    `${covered.length} tier(s) show no times, but a lower tier is still ` +
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

/**
 * What this tick establishes about the data-anomaly condition (#1134).
 *
 * Three outcomes, not two, and the third is the whole point. The bucket scan is
 * budget-bounded (`mapWithConcurrency` stops starting work at the monitor's
 * deadline), so a slow tick can finish early having examined a fraction of the
 * buckets and produce an empty anomaly list. Treating that as health would clear
 * an outstanding page on the strength of a scan that never looked, which is the
 * #1149 defect in a different lane.
 *
 * `bookedSolid` deliberately does not count against health: a genuinely full
 * calendar is a capacity fact routed to the info channel, and letting it hold this
 * page open would mean a busy week suppresses the all-clear indefinitely.
 */
export type AvailabilityVerdict = "healthy" | "alerting" | "unknown";

export function availabilityAlertVerdict(
  cause: DeadEndCause,
  scanTruncated: boolean,
): AvailabilityVerdict {
  // A real finding still alerts from a partial scan: not finishing the sweep does
  // not make what it did find any less true.
  if (cause.dataAnomaly.length > 0 || cause.unverified.length > 0) return "alerting";
  return scanTruncated ? "unknown" : "healthy";
}

/** The alert_state key the data-anomaly page and its all-clear share. */
export const DATA_ANOMALY_ALERT_KEY = "availability_data_anomaly";

/**
 * Page or all-clear on the availability verdict (#1152).
 *
 * The decision used to sit inline in the monitor lane, where the only way to ask
 * "does a truncated scan stay silent?" was to stand up the whole 577-line route.
 * So nobody asked, and the one branch that must never fire off an unread scan was
 * the one branch with no test. Injecting `notify` and `resolve` (the same shape
 * `runMigrationDriftCheck` already uses in that lane) makes all three outcomes
 * answerable directly.
 *
 * `unknown` is the outcome that matters: it neither pages nor all-clears, because
 * a scan that ran out of budget has no opinion about health.
 *
 * Best-effort dispatch, like every other alert on the monitor lane: a flaky Slack
 * must not fail the tick, and the firing marker survives for the next attempt.
 */
export async function reportAvailabilityHealth(deps: {
  cause: DeadEndCause;
  scanTruncated: boolean;
  cooldownMs: number;
  /** Buckets the lane self-healed this tick, named in the page. */
  healed: string[];
  notify: ThrottledNotify;
  resolve: AlertResolve;
}): Promise<{ verdict: AvailabilityVerdict; cleared: boolean }> {
  const verdict = availabilityAlertVerdict(deps.cause, deps.scanTruncated);
  if (verdict === "alerting") {
    await deps
      .notify(
        DATA_ANOMALY_ALERT_KEY,
        deps.cooldownMs,
        formatDataAnomalyAlert(deps.cause, deps.healed),
      )
      .catch(() => {});
    return { verdict, cleared: false };
  }
  if (verdict === "unknown") return { verdict, cleared: false };
  // Reachable on the ordinary healthy tick, which is the point: a recovery gated
  // on the fault still being present could never run.
  const cleared = await deps
    .resolve(DATA_ANOMALY_ALERT_KEY, formatAvailabilityRecovery())
    .catch(() => false);
  return { verdict, cleared };
}

/**
 * The all-clear for the data-anomaly page (#1134). Carries no remediation: the
 * page it clears said to go and check the precompute and calendar sync pipeline,
 * and repeating that here would send someone to investigate a fault that is over.
 */
export function formatAvailabilityRecovery(): string {
  return (
    `Availability is healthy again. Every bucket that should be offering ` +
    `booking times is showing them, and the cached availability agrees with the ` +
    `agents' calendars, so the earlier page about buckets showing no times is ` +
    `cleared. No action is needed.`
  );
}

/** Truncated "code, code and N more" for one cause group. */
function capList(codes: string[]): string {
  const head = codes.slice(0, ALERT_NAME_CAP).join(", ");
  const more = codes.length > ALERT_NAME_CAP ? ` and ${codes.length - ALERT_NAME_CAP} more` : "";
  return `${head}${more}`;
}

/** Below this many unverified buckets there is no evidence of a BROAD failure, so
 *  the alert stays specific and names them (one bad bucket is investigable). */
const BROAD_FAILURE_MIN = 5;
/** Share of dead-end buckets that must be unverified before we call it upstream. */
const BROAD_FAILURE_RATIO = 0.75;

/**
 * Whether a run's unverified group looks like ONE upstream outage (Google or sync
 * down, or the monitor deadline hit for most buckets) rather than N independent
 * bucket faults (#572). Requires both a floor and a dominant share: a recompute
 * that succeeded for most buckets is not broadly failing, and three failures out
 * of three is too small a sample to blame upstream.
 */
export function isBroadRecomputeFailure(cause: DeadEndCause): boolean {
  const total = cause.bookedSolid.length + cause.dataAnomaly.length + cause.unverified.length;
  if (cause.unverified.length < BROAD_FAILURE_MIN) return false;
  return cause.unverified.length / total >= BROAD_FAILURE_RATIO;
}

/** Urgent page body for real dead-ends whose cause is a data/sync fault (or could
 *  not be verified). Booked-solid buckets are NOT included here (they are a quiet
 *  info signal). No em/en dashes (copy lint). */
export function formatDataAnomalyAlert(cause: DeadEndCause, healed: string[] = []): string {
  const parts: string[] = [];
  if (cause.dataAnomaly.length) {
    parts.push(
      `${cause.dataAnomaly.length} bucket(s) show NO booking times but the agents' ` +
        `calendars are OPEN (${capList(cause.dataAnomaly)}): the cached availability ` +
        `disagrees with reality. Check the precompute and calendar sync pipeline.`,
    );
    if (healed.length) {
      // #573: the customer impact was auto-recovered this run, but the root cause
      // still needs a fix, so the page stays urgent, not resolved.
      parts.push(
        `Auto-recompute rewrote the fresh availability for ${healed.length} of these ` +
          `(${capList(healed)}) so the booker recovered now, but this masks a real fault: ` +
          `find why the cache went stale.`,
      );
    }
  }
  if (cause.unverified.length) {
    if (isBroadRecomputeFailure(cause)) {
      // One clear signal. Naming an arbitrary 8 of 54 codes invites on-call to
      // chase individual buckets when the cause is upstream of all of them.
      const total = cause.bookedSolid.length + cause.dataAnomaly.length + cause.unverified.length;
      parts.push(
        `The live availability recompute is failing broadly: ${cause.unverified.length} of ` +
          `${total} dead-end bucket(s) could not be verified. This is most likely a single ` +
          `upstream outage (Google or calendar sync), not ${cause.unverified.length} separate ` +
          `bucket faults. Check calendar sync and the precompute pipeline before investigating ` +
          `individual buckets.`,
      );
    } else {
      parts.push(
        `${cause.unverified.length} bucket(s) could not be verified because the live ` +
          `recompute failed (${capList(cause.unverified)}); treat as a possible sync issue.`,
      );
    }
  }
  return `${parts.join(" ")}`;
}

/**
 * Tiers empty because the agents are booked solid (#1412).
 *
 * A PAGE. Nothing is broken, and that is the point worth stating plainly in the
 * message, because the reader has to know within the first line that they are not
 * looking for a fault: they are looking at leads being turned away while every
 * calendar behaves correctly. The action is staffing, and it is today's, not
 * tomorrow's (L106).
 *
 * It names the tiers, because "we are full" without saying where is not something
 * anyone can act on. No em/en dashes (copy lint).
 */
export function formatBookedSolidAlert(bookedSolid: string[]): string {
  // Every clause agrees with the count. Reading it in `pnpm preview:alerts` is what
  // caught "3 tiers ... because ITS agents" and "1 tier ... on THOSE funnels": both
  // render perfectly well through a substring assertion.
  const n = bookedSolid.length;
  const one = n === 1;
  const subject = one
    ? "1 tier is offering no booking times"
    : `${n} tiers are offering no booking times`;
  const whose = one ? "its" : "their";
  const funnel = one ? "that funnel" : "those funnels";
  return (
    `${subject} because ${whose} agents are booked solid (${capList(bookedSolid)}). ` +
    `Nothing is broken: the calendars are genuinely full, and every lead landing on ` +
    `${funnel} right now is being turned away. This needs coverage added today, ` +
    `not a fix.`
  );
}

/** The all-clear, hung off a scan that saw EVERY bucket and found none full. */
export function formatBookedSolidRecovery(): string {
  return (
    `Every booking tier is offering times again, so leads are getting through on ` +
    `all of them and the earlier booked solid page is cleared. No action is needed.`
  );
}
