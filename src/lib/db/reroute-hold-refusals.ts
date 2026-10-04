/**
 * The refusal words the reroute hold RPCs return (#3247, migration 0166).
 *
 * Each function returns a word rather than raising, so the reroute routes (#3249)
 * can give every refusal its own message (L11). These lists are the TypeScript half
 * of that vocabulary; `scripts/test-reroute-hold-refusals.ts` reads the words out of
 * the migration's function bodies and fails when the two disagree in either
 * direction. No runtime imports, so the node suite can read it.
 */

/** Why place_reroute_hold declined to hold an advisor. */
export const PLACE_REROUTE_HOLD_REFUSALS = [
  "booking_not_found",
  "org_mismatch",
  "booking_inactive",
  "agent_link",
  "booking_started",
  "agent_is_current",
  "agent_not_in_org",
  "bucket_not_in_org",
  "event_type_mismatch",
  "confirm_in_progress",
  "agent_busy",
  "agent_held",
] as const;
export type PlaceRerouteHoldRefusal = (typeof PLACE_REROUTE_HOLD_REFUSALS)[number];

/** Why claim_reroute_hold declined to start a confirm. `hold_consumed` carries the
 *  first confirm's stored result, so a second confirm can return it. */
export const CLAIM_REROUTE_HOLD_REFUSALS = [
  "hold_not_found",
  "hold_consumed",
  "hold_expired",
  "booking_inactive",
  "booking_moved",
] as const;
export type ClaimRerouteHoldRefusal = (typeof CLAIM_REROUTE_HOLD_REFUSALS)[number];

/** Why the bucket aware reassign_booking_swap wrote nothing. */
export const REROUTE_SWAP_REFUSALS = [
  "booking_inactive",
  "agent_link",
  "bucket_mismatch",
  "hold_not_found",
  "hold_consumed",
  "hold_expired",
  "hold_not_claimed",
  "hold_mismatch",
  "booking_moved",
] as const;
export type RerouteSwapRefusal = (typeof REROUTE_SWAP_REFUSALS)[number];

/**
 * The constraint name the bookings trigger raises a held advisor under, with
 * SQLSTATE 23P01 (exclusion_violation), so `isSlotClash` reads it as a lost race
 * exactly as it reads the overlap constraint.
 */
export const REROUTE_HOLD_CONSTRAINT = "reroute_hold";
