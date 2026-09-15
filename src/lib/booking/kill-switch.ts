/**
 * The public booking kill switch (#2297): whether Slate is still taking bookings
 * from the embed, decided per request from a stored flag rather than a deploy.
 *
 * ## Why this exists
 *
 * Every public booking puts a real Google invite on a real agent's calendar and
 * fires a real `booking.created` webhook into Regal, and neither is recalled by
 * cancelling the booking afterwards. Before this there was no way to stop that
 * happening without a deploy. The only lever was flipping `bookable` across the
 * roster, which also stops availability computing, so it destroyed the signal you
 * would want while working out what was wrong.
 *
 * At cutover it is the lever somebody reaches for when the landing pages are
 * pointed at Slate and something is wrong, which is the moment it earns its keep.
 *
 * ## What it does NOT close
 *
 * Only the public booking WRITE. Availability still computes, the slot cache still
 * fills, Google sync still runs and both canaries still pass, deliberately:
 *
 * - `scripts/smoke-embed-render.ts` drives a REAL bucket through the public page in
 *   headless chromium and cannot send a bearer token, by construction. Closing the
 *   public availability READ as well would take the repo's only browser check dark.
 * - the key-authed booking API (`/api/bookings`) is an authenticated integration
 *   path, not the lead-facing one the landing pages post to, and the API canary is
 *   the only automated proof a booking can still be made end to end.
 * - reschedule and cancel stay open. A lead who already holds a call must be able
 *   to move or drop it; refusing them strands somebody the switch was never about,
 *   and a stranded lead becomes a no-show rather than a prevented booking.
 *
 * So what it removes is exactly the harm it was opened about: a NEW booking nobody
 * can take back.
 */

/** The refusal ids this gate can produce, named in `refusal-catalog.ts`. */
export type PublicBookingRefusal = "booking_paused" | "booking_pause_unreadable";

export type PublicBookingDecision =
  | { allow: true }
  | { allow: false; refusal: PublicBookingRefusal };

/**
 * Judge the stored flag. `null` means the flag could not be READ, which is never
 * the same fact as it reading false.
 *
 * **This gate fails CLOSED**, and it is the only one in the booking path that does.
 * The reasoning, and the bound on what that costs, is in
 * `scripts/test-booking-kill-switch.ts` beside the test that drives it: a switch a
 * failed read turns back on cannot be relied on at the moment somebody reaches for
 * it (L42), and the booking write already cannot complete without Postgres, so the
 * case this actually refuses is a column it cannot read while the database answers
 * everything else, which is a half-applied migration rather than an outage.
 *
 * The two refusals are separate because they send two different people to do two
 * different things, and a shared one would let the deliberate pause explain away
 * the fault (L11).
 */
export function judgePublicBooking(paused: boolean | null): PublicBookingDecision {
  if (paused === null) return { allow: false, refusal: "booking_pause_unreadable" };
  if (paused) return { allow: false, refusal: "booking_paused" };
  return { allow: true };
}
