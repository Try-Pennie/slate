// Slot separation for the booking canary's cross-bucket scenario (#1489).
//
// Scenario [2] books one synthetic person into SMOKE and then rebooks them into
// SMOKE2, expecting a cross-bucket MOVE. That only happens when the two starts are
// different instants: `decidePersonBooking` (src/lib/booking/person-dedupe.ts)
// compares start instants only and never the bucket, so a same-instant rebook
// always returns `deduped`. Correct and documented (docs/booking-api.md), which is
// why the fix belongs here in the fixture and not in the product.
//
// The old code took `slotsB[0]` and assumed it differed from the slot booked in
// SMOKE. Both lists are reads of the same live availability cache taken at
// different moments, and the healthy margin between them is exactly one event
// length, so one stale read closes it precisely and the canary pages. Three
// identical false pages in ten days.
//
// The margin also has to be wide enough that the two events cannot OVERLAP, not
// merely differ: the cross-bucket move CREATES the new booking before cancelling
// the old one (src/lib/booking/orchestration.ts), and SMOKE2's only member is the
// same agent holding the SMOKE booking, so an overlapping start comes back
// NO_ELIGIBLE_AGENTS instead of moving.

/** Symmetric margin between the two cross-bucket starts. Wider than any event
 *  length the smoke buckets book (20 min seeded), so neither event can overlap
 *  the other, and matching the gap `laterSlot` uses for the same reason. */
export const CROSS_BUCKET_MIN_GAP_MS = 60 * 60 * 1000;

export type CrossBucketSlot =
  | { ok: true; start: string }
  | { ok: false; reason: string };

/** Minutes, for a reason string a human reads mid-incident. */
function mins(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * Choose the start to rebook into the SECOND bucket, given the instant already
 * booked in the first.
 *
 * Returns the first candidate at least `minGapMs` from `bookedStartIso` in either
 * direction (earlier is fine once it clears the margin), skipping any candidate
 * whose stamp cannot be read. Refuses with a named reason rather than returning a
 * colliding slot, so a too-thin window fails as itself instead of as a dedupe
 * regression.
 *
 * An unreadable `bookedStartIso` is a refusal, not a free pass: `Date.parse`
 * yields NaN and every comparison with NaN is false, so an unguarded difference
 * check would silently accept the very first slot, which is the collision this
 * exists to prevent.
 */
export function chooseCrossBucketSlot(
  slots: string[],
  bookedStartIso: string,
  minGapMs: number = CROSS_BUCKET_MIN_GAP_MS,
): CrossBucketSlot {
  const bookedMs = Date.parse(bookedStartIso);
  if (!Number.isFinite(bookedMs)) {
    return { ok: false, reason: `the booked start is unreadable (got ${JSON.stringify(bookedStartIso)})` };
  }
  if (slots.length === 0) {
    return { ok: false, reason: "the second bucket returned no open slots" };
  }

  let nearestMs: number | null = null;
  for (const slot of slots) {
    const ms = Date.parse(slot);
    if (!Number.isFinite(ms)) continue; // unreadable candidate, never a pick
    const gap = Math.abs(ms - bookedMs);
    if (gap >= minGapMs) return { ok: true, start: slot };
    if (nearestMs === null || gap > nearestMs) nearestMs = gap;
  }

  if (nearestMs === null) {
    return { ok: false, reason: `the second bucket returned ${slots.length} slot(s), none with a readable start` };
  }
  return {
    ok: false,
    reason:
      `no slot in the second bucket is ${mins(minGapMs)} from the booking at ${bookedStartIso} ` +
      `(widest gap on offer: ${mins(nearestMs)} across ${slots.length} slot(s))`,
  };
}
