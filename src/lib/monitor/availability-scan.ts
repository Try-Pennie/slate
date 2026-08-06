/**
 * Orchestration for the availability-health probe (#371, extracted in #1158):
 * probe every bucket, classify the empties, verify dead-ends with a live
 * recompute, self-heal data anomalies, and page / whisper / all-clear.
 *
 * The pieces it composes each carry their own suite; what lived untested in the
 * 572-line route was THIS composition, the part that actually decides whether a
 * human gets woken up. Everything that touches the world (reads, the recompute,
 * the heal lock, Slack) is injected, so scripts/test-monitor-availability-scan.ts
 * drives every paging decision node-natively. No `@/` imports for the same
 * reason (relative `.ts` imports only, matching routing/tiers.ts).
 */
import {
  anyOnShift,
  classifyEmptyBuckets,
  classifyDeadEndCause,
  formatBookedSolidNotice,
  formatFallbackCoveredNotice,
  reportAvailabilityHealth,
  type AgentShift,
  type BucketHealth,
  type DeadEndCause,
  type FallbackCovered,
  type FallbackCoveredDetail,
} from "./availability-health.ts";
import { selfHealDataAnomalies, type SelfHealResult } from "./anomaly-selfheal.ts";
import { verifyAnomalies, type AnomalyVerifyResult } from "./anomaly-verify.ts";
import { mapWithConcurrency } from "../google/sync-pace.ts";

/** Quiet info: a dead-end because agents are booked solid. Full calendars are a
 *  good outcome, not an incident, so this whispers on a long cooldown. */
export const BOOKED_SOLID_INFO_KEY = "availability_booked_solid";
/** Low-priority info signal (#567): empty tiers the fallback is quietly covering. */
export const FALLBACK_COVERED_INFO_KEY = "fallback_covered_availability";

export interface ScanBucket {
  code: string;
  isTest: boolean;
}

export interface AvailabilityScanDeps {
  nowMs: number;
  freshWindowMs: number;
  probeConcurrency: number;
  deadlineMs: number;
  buckets: ScanBucket[];
  slotByCode: Map<string, { slotCount: number | null; computedAtMs: number }>;
  ladder: (code: string) => string[];
  nameOf: (code: string) => string;
  eligibleIds: (code: string) => Promise<string[]>;
  shiftFor: (userId: string) => AgentShift;
  /** The ORG's opening hours (#1296). A bucket whose org is shut right now is
   *  legitimately closed, not an outage, so it is not "should be showing times". */
  businessHours: AgentShift;
  /** Live recompute slot count for a dead-end code, or null when it failed. */
  recomputeSlots: (code: string) => Promise<number | null>;
  claimHeal: (code: string) => Promise<boolean>;
  heal: (code: string) => Promise<void>;
  onHealError: (code: string, err: unknown) => void;
  /**
   * #1167: re-check a suspected anomaly before paging, so a momentary
   * disagreement does not wake anyone. See anomaly-verify.ts; `cachedSlots` must
   * be a FRESH read of the bucket's cached row (not the map this scan started
   * with, whose whole point is that it may be the stale side of the comparison).
   */
  verify: {
    attempts: number;
    delayMs: number;
    maxBuckets: number;
    cachedSlots: (code: string) => Promise<number | null>;
    wait: (ms: number) => Promise<void>;
  };
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  info: (key: string, cooldownMs: number, text: string) => Promise<void>;
  resolve: (key: string, text: string) => Promise<boolean>;
  cooldownMs: { dataAnomaly: number; bookedSolid: number; fallbackCovered: number };
  log: (fields: Record<string, unknown>) => void;
}

export interface AvailabilityScanResult {
  bucketsScanned: number;
  /** Real customer dead-ends (whole ladder dry). */
  page: string[];
  covered: FallbackCovered[];
  cause: DeadEndCause;
  selfHeal: SelfHealResult;
  /** What re-verification concluded (#1167), including the blips it filtered. */
  verified: AnomalyVerifyResult;
  truncated: boolean;
  /** Whether a recovery notice actually went out this tick. */
  cleared: boolean;
}

export async function runAvailabilityScan(deps: AvailabilityScanDeps): Promise<AvailabilityScanResult> {
  // Probe each bucket: eligible agents, cached slot count, and whether anyone is
  // on shift right now (per agent, in the agent's own timezone). A probe that
  // throws fails the tick loudly (mapWithConcurrency does not catch), matching
  // the route's original behavior.
  const { results, truncated } = await mapWithConcurrency<ScanBucket, BucketHealth>(
    deps.buckets,
    deps.probeConcurrency,
    async (bucket) => {
      const slot = deps.slotByCode.get(bucket.code);
      const ids = await deps.eligibleIds(bucket.code);
      return {
        code: bucket.code,
        eligibleCount: ids.length,
        // A bucket with NO cached row at all is a genuine zero (nothing has ever
        // been computed); a row whose count could not be measured stays null so it
        // is excluded from the conclusions rather than paging as an empty bucket.
        slotCount: slot ? slot.slotCount : 0,
        computedAtMs: slot?.computedAtMs ?? null,
        onShiftNow: anyOnShift(deps.nowMs, ids.map(deps.shiftFor), deps.businessHours),
      };
    },
    { deadlineMs: deps.deadlineMs },
  );
  const health = results.filter(Boolean) as BucketHealth[];

  // Slot count + is_test per code, so the classifier can walk the tier ladder
  // (skipping synthetic test buckets, like the booker's fallback) with no extra IO.
  const bucketInfo = new Map(
    deps.buckets.map((b) => [
      b.code,
      // Same rule for the ladder walk: `null > 0` is false, so an unmeasured rung
      // never claims to cover a tier it might not.
      { slotCount: deps.slotByCode.get(b.code)?.slotCount ?? 0, isTest: b.isTest },
    ]),
  );
  // Split empty-but-should-show buckets by whether the tier-drop fallback still
  // serves a customer (#567): only a true dead-end (whole ladder dry) pages; a
  // fallback-covered tier is a low-priority info signal, not an outage.
  const { page, covered } = classifyEmptyBuckets(health, {
    nowMs: deps.nowMs,
    freshWindowMs: deps.freshWindowMs,
    ladder: deps.ladder,
    bucketInfo,
  });

  // For each paged bucket (the rare all-ladder-dry dead-end), recompute
  // availability live and compare to the cached zero: recompute 0 = booked solid;
  // > 0 = the cache disagrees with the calendars (data anomaly); a failed or
  // throwing recompute = unverified.
  const recomputeCounts = new Map<string, number | null>();
  if (page.length) {
    const { results: recomputes } = await mapWithConcurrency<string, { code: string; count: number | null }>(
      page,
      deps.probeConcurrency,
      async (code) => ({ code, count: await deps.recomputeSlots(code).catch(() => null) }),
      { deadlineMs: deps.deadlineMs },
    );
    for (const r of recomputes) if (r) recomputeCounts.set(r.code, r.count);
  }
  const firstPass = classifyDeadEndCause(page, recomputeCounts);

  // #1167: re-check the suspects before anyone is woken. A single tick's
  // disagreement can be momentary (a read landing mid-write, a recompute that
  // briefly answered wrong), and paging on it is how a real page later gets
  // ignored. Only buckets that KEEP disagreeing survive.
  //
  // This runs BEFORE the self-heal on purpose: the heal rewrites the cache, so
  // afterwards the two sides always agree and there is nothing left to compare.
  // Every inconclusive path inside fails closed (keeps the finding), so a broken
  // re-check can never silence a page; anomaly-verify.ts carries that reasoning
  // and scripts/test-monitor-anomaly-verify.ts pins each path.
  const verified = await verifyAnomalies({
    dataAnomaly: firstPass.dataAnomaly,
    unverified: firstPass.unverified,
    attempts: deps.verify.attempts,
    delayMs: deps.verify.delayMs,
    maxBuckets: deps.verify.maxBuckets,
    deadlineMs: deps.deadlineMs,
    now: () => Date.now(),
    cachedSlots: deps.verify.cachedSlots,
    recomputeSlots: deps.recomputeSlots,
    wait: deps.verify.wait,
  });
  // Re-verification can move a bucket between causes (a recovered recompute that
  // agrees with the empty cache is booked solid, not a mystery), so the cause the
  // rest of the tick acts on is the verified one.
  const cause: DeadEndCause = {
    dataAnomaly: verified.dataAnomaly,
    unverified: verified.unverified,
    bookedSolid: [...firstPass.bookedSolid, ...verified.bookedSolid],
  };

  // #573: self-heal each data-anomaly bucket (cache empty but a live recompute
  // found times), capped at once per bucket per window via the injected claim
  // (a non-released lock). We STILL page below so the root-cause sync/precompute
  // bug is fixed, not just papered over.
  let selfHeal: SelfHealResult = { healed: [], skipped: [], failed: [] };
  if (cause.dataAnomaly.length) {
    selfHeal = await selfHealDataAnomalies(cause.dataAnomaly, {
      claim: deps.claimHeal,
      heal: deps.heal,
      onError: deps.onHealError,
    });
  }

  // #1134: three outcomes, not two. `unknown` is a scan that ran out of budget
  // before covering every bucket, so its empty anomaly list proves nothing and
  // must neither page nor all-clear.
  // all-clear-proof: scripts/test-monitor-availability-scan.ts - a truncated scan
  // sends no all-clear and a paging tick does not also all-clear, driven through
  // this orchestration; the verdict table itself is pinned in
  // scripts/test-monitor-availability-health.ts.
  const { cleared } = await reportAvailabilityHealth({
    cause,
    scanTruncated: truncated,
    cooldownMs: deps.cooldownMs.dataAnomaly,
    healed: selfHeal.healed,
    notify: deps.notify,
    resolve: deps.resolve,
  });

  if (cause.bookedSolid.length) {
    await deps
      .info(BOOKED_SOLID_INFO_KEY, deps.cooldownMs.bookedSolid, formatBookedSolidNotice(cause.bookedSolid))
      .catch(() => {});
  }
  if (covered.length) {
    // Enrich each covered tier with its human name and the eligible-agent depth
    // of both tiers (#585), so the on-call notice needs no code lookup. A code
    // missing from the health scan (budget-truncated) leaves the depth null and
    // the notice omits it.
    const eligibleByCode = new Map(health.map((h) => [h.code, h.eligibleCount]));
    const coveredDetail: FallbackCoveredDetail[] = covered.map((c) => ({
      ...c,
      tierName: deps.nameOf(c.code),
      viaTierName: deps.nameOf(c.via),
      emptyDepth: eligibleByCode.get(c.code) ?? null,
      coverDepth: eligibleByCode.get(c.via) ?? null,
    }));
    await deps
      .info(
        FALLBACK_COVERED_INFO_KEY,
        deps.cooldownMs.fallbackCovered,
        formatFallbackCoveredNotice(coveredDetail),
      )
      .catch(() => {});
  }

  deps.log({
    dead_end: page.length,
    anomaly: cause.dataAnomaly.length,
    // A filtered blip pages nobody, so the log is the only place it is visible.
    // Without this we could not tell "nothing is wrong" from "verification is
    // eating real findings" (#1167).
    verify_resolved: verified.resolved.length ? verified.resolved.join(",") : null,
    verify_skipped: verified.skipped ? (verified.reason ?? true) : null,
    self_healed: selfHeal.healed.length ? selfHeal.healed.join(",") : null,
    self_heal_failed: selfHeal.failed.length ? selfHeal.failed.join(",") : null,
    booked_solid: cause.bookedSolid.length,
    unverified: cause.unverified.length,
    fallback_covered: covered.length,
    buckets: deps.buckets.length,
    page: page.length ? page.join(",") : null,
    covered: covered.length ? covered.map((c) => `${c.code}->${c.via}`).join(",") : null,
    truncated,
  });

  return {
    bucketsScanned: deps.buckets.length,
    page,
    covered,
    cause,
    selfHeal,
    verified,
    truncated,
    cleared,
  };
}
