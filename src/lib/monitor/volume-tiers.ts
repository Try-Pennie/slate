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
 * ANCHORS. A tier's anchor is the cal.com measurement of that tier, the floor under
 * its learned floor. Only Low has been measured (`volume-baseline.ts`, 2026-09-25),
 * so a tier without one is judged only once it has been learned, and until then it
 * is UNJUDGED and says so on /admin/alerts rather than reading as quiet (L678).
 *
 * No `@/` imports, so node scripts can drive it.
 */
import { DEBT_TIER } from "../xbc.ts";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline.ts";
import { VOLUME_ALERT_KEY, VOLUME_COUNT_UNREADABLE_KEY } from "./booking-volume.ts";
import type { VolumeBaseline } from "./volume-floors.ts";

/** A debt tier digit, "1" (Low) to "5" (Ultra High). */
export type VolumeTier = string;

/** Every debt tier, from the routing vocabulary rather than typed out (L41). */
export const VOLUME_TIERS: readonly VolumeTier[] = Object.keys(DEBT_TIER).sort();

/** Low: the tier the committed measurement, the per page floors and the pilot describe. */
export const LOW_TIER: VolumeTier = "1";

/**
 * Each measured tier's cal.com floors, the floor under whatever is learned for it.
 * Adding a tier's anchor is a measurement of that tier (`pnpm measure:volume-floors`),
 * never a hand typed floor. `scripts/test-volume-tiers.ts` holds Low's entry to the
 * tier the committed measurement actually counted.
 */
export const TIER_ANCHORS: Readonly<Partial<Record<VolumeTier, VolumeBaseline>>> = {
  [LOW_TIER]: MEASURED_VOLUME_BASELINE,
};

export function isVolumeTier(value: string): value is VolumeTier {
  return VOLUME_TIERS.includes(value);
}

const XBC = /^([1-5])[0-3][0-2]$/;

/** The tier of a bucket code, or null for a code that is not an XBC (the test buckets). */
export function tierOfBucketCode(code: string | null | undefined): VolumeTier | null {
  const m = XBC.exec((code ?? "").trim());
  return m && isVolumeTier(m[1]!) ? m[1]! : null;
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

/**
 * A tier's low volume alert key. Low keeps `low_booking_volume`, the key it has
 * paged on since #370, so an open page, its cooldown and its runbook entry carry
 * over; every other tier has its own key in the `low_tier_volume` family.
 */
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

export function tierVolumeAlertKey(tier: VolumeTier): string {
  if (!isVolumeTier(tier)) throw new Error(`volume tiers: ${tier} is not a debt tier`);
  return tier === LOW_TIER ? VOLUME_ALERT_KEY : `${TIER_VOLUME_ALERT_PREFIX}:${tier}`;
}
