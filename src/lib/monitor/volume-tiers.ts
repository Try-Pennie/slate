/**
 * The debt tiers the low volume floors are scoped to (#2874).
 *
 * WHY. The floors were fitted to the Low tier only, and everything that judged or
 * learned from them counted EVERY booking. Widening the pilot to another tier would
 * then add that tier's bookings to counts judged against Low's floors (so the alarm
 * is slow to see Low going dark) and to the traffic Low's floors are relearned from
 * (so the widening is learned as ordinary growth). The fix used to be an edit to
 * `FLOOR_SCOPE` and a hand run refit.
 *
 * WHAT. Every floor is scoped to one tier, and every count or read that feeds it is
 * filtered to that tier, so a booking in one tier can never move another tier's
 * alarm. A booking belongs to the tier of the bucket that took it (the first digit
 * of its XBC code, `xbc.ts`), which is the population the alarm can count; a lead a
 * tier fallback moved down a tier counts in the tier it was booked into.
 *
 * WHICH TIERS SLATE CARRIES is derived from the bookings it takes, never a constant:
 * a tier is carried from its first real page booking on or after the measurement
 * date (`EARLIEST_RAMP_END`). That first booking is also the tier's ramp start, set
 * automatically, and the floor learner fits each tier from its own bookings after it
 * (`volume-relearn.ts`). A declared ramp end, when a person sets one, can only move a
 * tier's start LATER, never earlier than its own first booking.
 *
 * ANCHORS. A tier's anchor is its cal.com measurement THINNED to the share of the
 * tier Slate carries (#2893, `carried-share.ts`), the floor under its learned floor.
 * Every measurement of a tier is listed in `TIER_MEASUREMENTS`: Low's two page fit
 * (`volume-baseline.ts`) and every tier's whole tier fit
 * (`volume-baseline-tiers.ts`, Medium, High and Very High measured 2026-09-29). Until
 * the refit has measured a tier's share, the anchors are `TIER_ANCHORS`, Low's two
 * page fit alone, which is exactly what was armed before the shares existed. A tier
 * beside Low is judged only once it has been learned, and until then it is UNJUDGED
 * and says so on /admin/alerts rather than reading as quiet (L678).
 *
 * ULTRA HIGH HAS NO ANCHOR, BY MEASUREMENT (#2888). Re-measured 2026-10-01 over
 * 2026-07-30 to 2026-10-01 15:45 UTC, which ends just before the split sent half
 * of every tier to Slate (`MEASURE_END=2026-10-01T15:45:00Z`, so the count is the
 * whole tier, not cal.com's half): 3,404 bookings, and no hour the alarm judges
 * carries a floor above zero, so the command refused to save it. Thinning only
 * lowers a floor, so no share Slate carries could give it one either. It is judged
 * from its own learned floors alone, and this measurement cannot be taken again
 * once cal.com stops taking Ultra High leads at cutover (#65).
 *
 * No `@/` imports, so node scripts can drive it.
 */
import { DEBT_TIER } from "../xbc.ts";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline.ts";
import { WHOLE_TIER_MEASUREMENTS } from "./volume-baseline-tiers.ts";
import { VOLUME_ALERT_KEY, VOLUME_COUNT_UNREADABLE_KEY } from "./booking-volume.ts";
import type { VolumeBaseline } from "./volume-floors.ts";

/**
 * Every debt tier. Written as a literal so `VolumeTier` is a union and a typo in
 * a tier fails `tsc`; `scripts/test-volume-tiers.ts` holds it equal to the routing
 * vocabulary's own keys (`DEBT_TIER`), so the two cannot drift (L41).
 */
export const VOLUME_TIERS = ["1", "2", "3", "4", "5"] as const;

/** A debt tier digit, "1" (Low) to "5" (Ultra High). */
export type VolumeTier = (typeof VOLUME_TIERS)[number];

/** Low: the tier the committed measurement, the per page floors and the pilot describe. */
export const LOW_TIER = "1" satisfies VolumeTier;

/**
 * The anchors in force BEFORE the refit has measured a tier's carried share (#2893):
 * Low's two page measurement alone, the state that was armed before the shares
 * existed, so a deploy or an unreadable share record changes nothing a person set
 * up. `scripts/test-volume-tiers.ts` holds Low's entry to the tier the committed
 * measurement actually counted, and `scripts/test-volume-tier-anchors.ts` holds this
 * to Low alone.
 */
export const TIER_ANCHORS: Readonly<Partial<Record<VolumeTier, VolumeBaseline>>> = {
  [LOW_TIER]: MEASURED_VOLUME_BASELINE,
};

/**
 * Every cal.com measurement of each tier, to be thinned to the share Slate carries
 * (#2893). Adding one is a measurement (`pnpm measure:volume-floors`), never a hand
 * typed floor. Low has two, its two page fit and the whole tier; each other measured
 * tier has its whole tier fit; Ultra High has none, so it never has an anchor.
 */
export const TIER_MEASUREMENTS: Readonly<Partial<Record<VolumeTier, readonly VolumeBaseline[]>>> = {
  ...Object.fromEntries((Object.entries(WHOLE_TIER_MEASUREMENTS) as [VolumeTier, VolumeBaseline][]).map(([t, whole]) => [t, [whole]])),
  // Low's two page fit is listed whether or not its whole tier fit exists, so Low can
  // never be left with nothing to thin.
  [LOW_TIER]: [MEASURED_VOLUME_BASELINE, ...(WHOLE_TIER_MEASUREMENTS[LOW_TIER] ? [WHOLE_TIER_MEASUREMENTS[LOW_TIER]] : [])],
};

export function isVolumeTier(value: string): value is VolumeTier {
  return (VOLUME_TIERS as readonly string[]).includes(value);
}

/**
 * A value for every tier, from pairs built by walking `VOLUME_TIERS`. Throws when
 * a tier is missing, so a record typed as covering every tier really does: a tier
 * left out would otherwise read as undefined, which callers treat as "nobody".
 */
export function recordOfTiers<T>(pairs: readonly (readonly [VolumeTier, T])[]): Record<VolumeTier, T> {
  const out = new Map<VolumeTier, T>(pairs);
  for (const tier of VOLUME_TIERS) {
    if (!out.has(tier)) throw new Error(`volume tiers: no value for tier ${tier}`);
  }
  return Object.fromEntries(out) as Record<VolumeTier, T>;
}

const XBC = /^([1-5])[0-3][0-2]$/;

/** The tier of a bucket code, or null for a code that is not an XBC (the test buckets). */
export function tierOfBucketCode(code: string | null | undefined): VolumeTier | null {
  const tier = XBC.exec((code ?? "").trim())?.[1];
  return tier !== undefined && isVolumeTier(tier) ? tier : null;
}

/** "Low", "Ultra High": a tier as the team says it. */
export function tierLabel(tier: VolumeTier): string {
  const t = DEBT_TIER[tier];
  if (!t) throw new Error(`volume tiers: ${tier} is not a debt tier`);
  return t.label;
}

/**
 * The `like` pattern selecting a tier's bucket codes, for a filter on the embedded
 * bucket. Refuses anything that is not a tier, so a typo cannot become a pattern
 * that matches nothing and reads as a tier with no bookings (L100).
 */
export function tierCodePattern(tier: VolumeTier): string {
  if (!isVolumeTier(tier)) throw new Error(`volume tiers: ${tier} is not a debt tier`);
  return `${tier}%`;
}

/**
 * When a tier's floors may start being learned: its first real booking, or a
 * declared ramp end when that is later. Null while the tier has taken no booking,
 * which is the tier not being carried at all.
 */
export function tierRampStartMs(firstBookingMs: number | null, declaredRampEndMs: number | null): number | null {
  if (firstBookingMs === null) return null;
  return declaredRampEndMs === null ? firstBookingMs : Math.max(firstBookingMs, declaredRampEndMs);
}

/** The alert family for a tier other than Low (#2874), one key per tier (L707). */
export const TIER_VOLUME_ALERT_PREFIX = "low_tier_volume";

/** The family for a tier's count that could not be read (#2874), one key per tier. */
export const TIER_COUNT_UNREADABLE_PREFIX = "volume_count_unreadable";

/**
 * A tier's "count unreadable" key. Low keeps `volume_count_unreadable`; every other
 * tier has its own, so one tier's readable count never clears another's page.
 */
export function tierCountUnreadableKey(tier: VolumeTier): string {
  if (!isVolumeTier(tier)) throw new Error(`volume tiers: ${tier} is not a debt tier`);
  return tier === LOW_TIER ? VOLUME_COUNT_UNREADABLE_KEY : `${TIER_COUNT_UNREADABLE_PREFIX}:${tier}`;
}

/** The family for a tier whose check itself failed to run (#2874), one key per tier. */
export const TIER_CHECK_FAILED_PREFIX = "tier_volume_check_failed";

/** A tier's "check failed" key. Only tiers beside Low use it; Low's check is its own step. */
export function tierCheckFailedKey(tier: VolumeTier): string {
  if (!isVolumeTier(tier)) throw new Error(`volume tiers: ${tier} is not a debt tier`);
  return `${TIER_CHECK_FAILED_PREFIX}:${tier}`;
}

/**
 * A tier's low volume alert key. Low keeps `low_booking_volume`, the key it has
 * paged on since #370, so an open page, its cooldown and its runbook entry carry
 * over; every other tier has its own key in the `low_tier_volume` family.
 */
export function tierVolumeAlertKey(tier: VolumeTier): string {
  if (!isVolumeTier(tier)) throw new Error(`volume tiers: ${tier} is not a debt tier`);
  return tier === LOW_TIER ? VOLUME_ALERT_KEY : `${TIER_VOLUME_ALERT_PREFIX}:${tier}`;
}
