/**
 * Each tier's cal.com measurement, applied in proportion to the share of that tier
 * Slate carries (#2893).
 *
 * WHY. A cal.com measurement counts a WHOLE population: every booking of a tier, or
 * every booking from the pages Slate was first given. The pilot moves pages, and
 * since trypennie's split (Halo-lab-Trypennie/trypennie#517) it moves a percentage
 * of the leads on those pages too, so Slate carries PART of what was measured.
 * Floors fitted to the whole are floors part of it can never clear: as the floor
 * under learned floors they raise them past the traffic Slate sees, and the alarm
 * false pages (108 to 283 times in two normal weeks, measured in
 * `scripts/lib/volume-floor-scope.ts`). Low's measurement was refitted by hand for
 * the pages Slate carries (#2878, #2870), which a split undoes again.
 *
 * WHAT. Once a day the refit (`volume-relearn.ts`) counts, per tier, the bookings
 * Slate took and the bookings cal.com took over the same 24 hours. Slate's share is
 * its count over both, measured rather than configured, so neither a percentage
 * typed in Salesforce nor a page list in the code has to be kept in step with it.
 * Each tier's measurement is then THINNED to that share and becomes the floor under
 * its learned floors, and Low's floors before it has learned.
 *
 * THINNING. Slate's half of a split is a binomial thinning of the whole: every lead
 * lands in Slate's half with the same chance. So a whole tier floor F, which the
 * whole tier clears nearly every time, becomes the largest k that a binomial draw of
 * F at the share falls below no more often than the fit's own chance tolerance
 * (`FLOOR_FIT.poissonAlpha`). Whenever the whole tier clears F, Slate's half then
 * clears k with that same reliability, so the thinned floor pages no more often than
 * the original did, plus the chance the fit already allows for. It is exact at a
 * share of 1 (k is F) and conservative below it: a lower floor is the harmless side
 * of this trade, since a floor too high pages about nothing (L648).
 *
 * WHICH MEASUREMENT. The narrowest one that covers what Slate carries, thinned by
 * the rest. Low has two: its fit to the pages Slate carries and the whole tier.
 * Since every Low page joined (#2870) both cover the whole tier, so a 50% split
 * thins either by half; were a page held off again, its page fit would be the
 * narrower one. No measurement is ever scaled UP past what it measured.
 *
 * AN OUTAGE IS NOT A SHARE. The share is counted from the bookings the alarm
 * watches, so Slate losing bookings reads as Slate's share falling, and applying it
 * would lower the floors of an alarm that is watching an outage, then post it an
 * all-clear. What separates the two is where the leads went: a split MOVES them to
 * cal.com and the tier's total holds, while an outage LOSES them and the total falls
 * with the share. So a day's share is applied only when the whole tier's traffic,
 * judged against its measured weekly shape, held within `levelHoldRatio` of the day
 * the share in force was measured. Otherwise the share in force is HELD, and says so
 * on /admin/alerts. The same guard holds a share that ROSE because cal.com lost
 * bookings. A hold gives way after `holdExpiryDays`, so a real split that happened to
 * land on a quiet week is not refused for ever (L523).
 *
 * No `@/` imports, so node scripts can drive it.
 */
import { parseStampMs } from "../date/stamp.ts";
import { FLOOR_FIT, SERIES_BUCKET_MINUTES, cellAt, type VolumeBaseline } from "./volume-floors.ts";
import { TIER_ANCHORS, TIER_MEASUREMENTS, isVolumeTier, type VolumeTier } from "./volume-tiers.ts";

/** The knobs, in one place so the refit, the page and the tests read the same numbers. */
export const CARRIED_SHARE = {
  /** The window each daily reading counts, ending at the refit. */
  windowHours: 24,
  /** Below this many bookings across both systems a day's share is too thin to read (L716). */
  minBookings: 30,
  /** A share change is applied only while the tier's traffic holds at this share of its level when the share in force was measured. */
  levelHoldRatio: 0.8,
  /** A move this small is day to day noise, applied whatever the traffic did. */
  shareNoise: 0.05,
  /** How long a held share holds before the day's reading is applied anyway. */
  holdExpiryDays: 14,
  /** How far a share may sit above a measurement's coverage and still be that measurement, untouched. */
  scopeTolerance: 0.1,
} as const;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The largest k for which a binomial draw of `n` at `p` falls below k with
 * probability at most `alpha`: a floor of `n` on the whole, thinned to a share `p`.
 */
export function binomialFloor(n: number, p: number, alpha: number): number {
  if (!(n > 0) || !(p > 0)) return 0;
  if (p >= 1) return n;
  const q = 1 - p;
  let pmf = Math.pow(q, n); // P(X = 0)
  let below = 0; // P(X < k)
  let k = 0;
  // Walk up while P(X < k + 1) stays within alpha.
  while (k < n && below + pmf <= alpha) {
    below += pmf;
    pmf = (pmf * (n - k) * p) / ((k + 1) * q);
    k += 1;
  }
  return k;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const twoPlaces = (n: number) => Math.round(n * 100) / 100;

/**
 * A measurement thinned to `factor` of the traffic it measured. Refuses a factor
 * outside 0 to 1, including one that is not a number, which every comparison would
 * otherwise read as a floor of zero (L50): a measurement is never scaled up.
 */
export function thinBaseline(b: VolumeBaseline, factor: number): VolumeBaseline {
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
    throw new Error(`carried share: cannot thin a measurement by ${factor}; a factor is between 0 and 1`);
  }
  if (factor === 1) return b;
  const alpha = FLOOR_FIT.poissonAlpha;
  return {
    ...b,
    scope: `${b.scope}, thinned to ${pct(factor)} of it`,
    tierShare: twoPlaces((b.tierShare ?? 1) * factor),
    cells: b.cells.map((day) =>
      day.map((c) => ({
        floor30: binomialFloor(c.floor30, factor, alpha),
        floor120: binomialFloor(c.floor120, factor, alpha),
        typical120: Math.round(c.typical120 * factor),
      })),
    ),
  };
}

/** The share of its tier a measurement covers: its own, or the whole tier's. */
const coverage = (b: VolumeBaseline) => b.tierShare ?? 1;

/**
 * The floor under a tier Slate carries `share` of: the narrowest measurement that
 * covers it, thinned by the rest. Null for a tier nobody measured.
 */
export function carriedAnchor(measurements: readonly VolumeBaseline[] | undefined, share: number): VolumeBaseline | null {
  if (!measurements || measurements.length === 0) return null;
  const byCoverage = [...measurements].sort((a, b) => coverage(a) - coverage(b));
  const reach = share * (1 - CARRIED_SHARE.scopeTolerance);
  const chosen = byCoverage.find((b) => coverage(b) >= reach) ?? byCoverage[byCoverage.length - 1]!;
  return thinBaseline(chosen, Math.max(0, Math.min(1, share / coverage(chosen))));
}

/**
 * Where a tier's anchor comes from: the anchors in force before any share has been
 * measured (Low's committed fit alone, which covers every Low page since #2870), and
 * every measurement of each tier to thin once one has.
 */
export interface AnchorSource {
  unmeasured: Readonly<Partial<Record<VolumeTier, VolumeBaseline>>>;
  measurements: Readonly<Partial<Record<VolumeTier, readonly VolumeBaseline[]>>>;
}

export const REAL_ANCHOR_SOURCE: AnchorSource = { unmeasured: TIER_ANCHORS, measurements: TIER_MEASUREMENTS };

/** A tier's anchor at the share in force, or with none measured, the one it had before. */
export function anchorFor(tier: VolumeTier, share: number | null, source: AnchorSource): VolumeBaseline | null {
  if (share === null) return source.unmeasured[tier] ?? null;
  return carriedAnchor(source.measurements[tier], share);
}

/** Every tier's anchor at the shares in force. */
export function anchorsFor(
  shares: StoredCarriedShare | null,
  source: AnchorSource,
): Partial<Record<VolumeTier, VolumeBaseline>> {
  const out: Partial<Record<VolumeTier, VolumeBaseline>> = {};
  const tiers = new Set<VolumeTier>([
    ...(Object.keys(source.unmeasured) as VolumeTier[]),
    ...(Object.keys(source.measurements) as VolumeTier[]),
  ]);
  for (const tier of tiers) {
    const a = anchorFor(tier, shares?.tiers[tier]?.applied?.share ?? null, source);
    if (a) out[tier] = a;
  }
  return out;
}

/**
 * The bookings a whole tier measurement expects over [fromMs, toMs): its median
 * two hour count spread evenly over each five minute bucket, at each bucket's own
 * weekday and hour. The normalizer the traffic guard judges a day's total against,
 * so a Saturday is compared with a Saturday rather than read as a collapse.
 */
export function expectedBookings(whole: VolumeBaseline, fromMs: number, toMs: number): number {
  const per = SERIES_BUCKET_MINUTES * 60_000;
  const perBucket = SERIES_BUCKET_MINUTES / 120;
  let sum = 0;
  for (let t = fromMs; t < toMs; t += per) {
    const { weekday, hour } = cellAt(whole, t);
    sum += (whole.cells[weekday - 1]?.[hour]?.typical120 ?? 0) * perBucket;
  }
  return Math.round(sum * 100) / 100;
}

/** One day's reading, as applied. */
export interface ShareReading {
  /** Slate's bookings over both systems', to two places. */
  share: number;
  slate: number;
  /** cal.com's bookings, 0 when cal.com was switched off. */
  calcom: number;
  /** Both systems' total over what the whole tier measurement expects, or null with no such measurement. */
  level: number | null;
  from: string;
  to: string;
}

export const SHARE_OUTCOMES = ["applied", "held", "hold-expired", "too-few", "closed-day", "calcom-off"] as const;
export type ShareOutcome = (typeof SHARE_OUTCOMES)[number];

/** One tier's share, as stored with the refit. */
export interface StoredTierShare {
  /** The reading in force, or null when no day has been readable yet. */
  applied: ShareReading | null;
  /** What the latest reading counted and what became of it. */
  last: { slate: number; calcom: number | null; level: number | null; outcome: ShareOutcome };
  /** When the share in force started being held, or null when it is not held. */
  heldSince: string | null;
}

/**
 * One tier's share as a check that thins by it reads it (#3193), from
 * `shareInForce` in volume-relearn.ts. A share that is not known says which way it
 * is not known, and is never read as 1 (the whole tier's floors, which false page
 * under partial traffic) or as 0 (floors that can never breach).
 */
export type ShareInForce =
  /** The share in force. */
  | {
      state: "applied";
      share: number;
      /** Set when the refit is holding the share in force (see AN OUTAGE IS NOT A SHARE). */
      heldSince: string | null;
      /** The end of the day the share in force was counted over. */
      countedTo: string;
    }
  /** No refit has measured a readable day for this tier yet. */
  | { state: "unmeasured" }
  /** The stored refit does not read. */
  | { state: "unreadable" };

/** Every tier's share, as the refit stores it (`StoredVolumeLearning.carriedShare`). */
export interface StoredCarriedShare {
  measuredAt: string;
  from: string;
  to: string;
  tiers: Partial<Record<VolumeTier, StoredTierShare>>;
}

/**
 * One tier's reading for one day, judged against the one before. Pure: the refit
 * supplies the counts and whether the window touched a closed day.
 */
export function judgeTierShare(input: {
  previous: StoredTierShare | null;
  slate: number;
  /** cal.com's count, or null when cal.com is switched off here. */
  calcom: number | null;
  level: number | null;
  touchesClosed: boolean;
  fromIso: string;
  toIso: string;
  nowMs: number;
}): StoredTierShare {
  const prev = input.previous;
  const keep = (outcome: ShareOutcome): StoredTierShare => ({
    applied: prev?.applied ?? null,
    last: { slate: input.slate, calcom: input.calcom, level: input.level, outcome },
    heldSince: prev?.heldSince ?? null,
  });
  const apply = (share: number, outcome: ShareOutcome): StoredTierShare => ({
    applied: {
      share,
      slate: input.slate,
      calcom: input.calcom ?? 0,
      level: input.level,
      from: input.fromIso,
      to: input.toIso,
    },
    last: { slate: input.slate, calcom: input.calcom, level: input.level, outcome },
    heldSince: null,
  });

  // With cal.com off there is nothing else to carry the tier: the state cutover
  // freezes at. It is only ever reached through cal.com being unconfigured here,
  // never through a read that answered empty, which is a count of zero instead.
  if (input.calcom === null) return apply(1, "calcom-off");
  if (input.touchesClosed) return keep("closed-day");
  const total = input.slate + input.calcom;
  if (total < CARRIED_SHARE.minBookings) return keep("too-few");
  const share = twoPlaces(input.slate / total);

  const inForce = prev?.applied ?? null;
  if (!inForce) return apply(share, "applied");
  const moved = Math.abs(share - inForce.share) > CARRIED_SHARE.shareNoise;
  const fell =
    input.level !== null && inForce.level !== null && input.level < CARRIED_SHARE.levelHoldRatio * inForce.level;
  if (!moved || !fell) return apply(share, "applied");

  const heldSince = prev?.heldSince ?? input.toIso;
  const heldMs = parseStampMs(heldSince);
  // An unreadable start is expired: holding for ever on a stamp nobody can read is
  // the failure the expiry exists to prevent.
  if (heldMs === null || input.nowMs - heldMs >= CARRIED_SHARE.holdExpiryDays * DAY_MS) {
    return apply(share, "hold-expired");
  }
  return { ...keep("held"), heldSince };
}

/** A finite count, 0 or more: the check every stored count in the volume records passes. */
export const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
/** A stored instant that parses, so no NaN reaches a comparison (L50). */
export const isInstant = (s: unknown): s is string => typeof s === "string" && parseStampMs(s) !== null;
const isLevel = (n: unknown) => n === null || isCount(n);

function isReading(r: unknown): r is ShareReading {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
  return (
    isCount(v.share) &&
    (v.share as number) <= 1 &&
    isCount(v.slate) &&
    isCount(v.calcom) &&
    isLevel(v.level) &&
    isInstant(v.from) &&
    isInstant(v.to)
  );
}

function isTierShare(e: unknown): e is StoredTierShare {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  if (v.applied !== null && !isReading(v.applied)) return false;
  if (v.heldSince !== null && !isInstant(v.heldSince)) return false;
  const last = v.last as Record<string, unknown> | null;
  if (!last || typeof last !== "object") return false;
  return (
    isCount(last.slate) &&
    (last.calcom === null || isCount(last.calcom)) &&
    isLevel(last.level) &&
    (SHARE_OUTCOMES as readonly unknown[]).includes(last.outcome)
  );
}

/** A stored share record, validated field by field (L688): it lives in a jsonb column. */
export function isStoredCarriedShare(raw: unknown): raw is StoredCarriedShare {
  if (!raw || typeof raw !== "object") return false;
  const v = raw as Record<string, unknown>;
  if (!isInstant(v.measuredAt) || !isInstant(v.from) || !isInstant(v.to)) return false;
  if (!v.tiers || typeof v.tiers !== "object") return false;
  return Object.entries(v.tiers as Record<string, unknown>).every(([tier, e]) => isVolumeTier(tier) && isTierShare(e));
}
