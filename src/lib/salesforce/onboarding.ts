// How a new hire becomes bookable (#2071), decided in one pure place.
//
// Until this shipped, an agent existed in Slate only once a debt tier was ticked
// on their Salesforce User record, and arrived not bookable for a person to flip
// by hand. Measured on 2026-09-08 that produced two invisible states at once: four
// hires sat non-bookable in Slate with Low Debt ticked and cal.com already routing
// to two of them, and four more sat in Salesforce on the Chatter Free profile with
// no Slate row at all. A non-bookable row is a legitimate state and a missing row
// leaves no trace, so nothing could report either.
//
// The rule, as Dan gave it: a hire is created in Salesforce on the Chatter Free
// profile with no debt team and is added to Slate not bookable. The FIRST time they
// are moved to the Sales profile or given a debt team, they become bookable.
//
// Two properties are load bearing and both are here rather than in the sync:
//
// - It is a TRANSITION, never a level. "Has tiers and is not bookable" describes a
//   manager somebody deliberately held out of the pool just as well as it describes
//   a hire nobody has flipped yet, so the trigger is "did not qualify, now does".
//   Nothing ever switches a person OFF on its own.
// - A refused flip is remembered. The transition happens once; if the activation
//   gate refuses it that hour (no Google calendar yet), the next hour sees tiers
//   against tiers, which is the human hold shape above. `bookable_pending_since`
//   is the mark that tells the two apart, and any explicit bookable write settles
//   it, whether the sync's or a person's.
import type { Attributes } from "@/lib/db/types";

/**
 * Salesforce profiles whose ACTIVE users are Slate agents whether or not they
 * carry a debt tier. Anybody with a tier on any other profile is still synced,
 * as before, so a tiered manager keeps updating.
 *
 * `Chatter Free User` is the licence a hire is created with before they are moved
 * to Sales, and it is the only signal Slate can see of "this person is being
 * onboarded": the cal.com "Redistribute" attribute that marks the same state has
 * no Salesforce field (#2033).
 */
export const AGENT_PROFILES = ["Sales", "Chatter Free User"] as const;

/** The profile a hire is moved to when they start taking calls. */
export const SALES_PROFILE = "Sales";

/** The SOQL clause that admits the profiles above, derived from the one list. */
export function agentProfileSoql(): string {
  return `Profile.Name IN (${AGENT_PROFILES.map((p) => `'${p}'`).join(", ")})`;
}

/**
 * Whether these attributes describe somebody who should be taking bookings: on the
 * Sales profile.
 *
 * THE PROFILE ALONE, since #2182. A first debt tier used to count as well, on the
 * grounds that either is something a person did on purpose. That held while both
 * came from Salesforce. #2152 moved the tier to Twilio, and Dan's call
 * (2026-09-10) is that becoming bookable stays a Salesforce decision: a Twilio tag
 * says what somebody can be ROUTED FOR, never that they are taking calls.
 *
 * The consequence, stated rather than left to be discovered: somebody who stays on
 * Chatter Free and is given a tier is now never made bookable by anything. That is
 * the intent, and it is a state somebody is waiting on a Salesforce edit in, so the
 * roster sync counts them rather than leaving it silent (L636).
 */
export function qualifiesForBooking(attrs: Attributes | null | undefined): boolean {
  return attrs?.role === SALES_PROFILE;
}

/**
 * Whether this row is carrying tiers on a profile that will never make them
 * bookable, so somebody is waiting on a Salesforce edit nobody has been told is
 * owed (#2182).
 *
 * Counted rather than acted on. Acting would be the very rule this change removed.
 */
export function tieredButNotOnSales(attrs: Attributes | null | undefined): boolean {
  if (!attrs || attrs.role === SALES_PROFILE) return false;
  const tiers = attrs.debt_team;
  return Array.isArray(tiers) && tiers.length > 0;
}

/**
 * Whether this row is on Sales, not bookable, and nothing on record says why
 * (#2621).
 *
 * The flip below fires on a TRANSITION, which is what keeps it from overturning a
 * hold somebody chose (L60). Its blind spot is every row that was ALREADY on Sales
 * and not bookable when it shipped on 2026-09-08: they never see a transition, so
 * no activation is ever attempted (L389). Three hires sat in that state for up to
 * eighteen days while cal.com routed them leads, and were found only by the parity
 * sweep.
 *
 * The same state is also a deliberate hold, so it is COUNTED every run rather than
 * acted on (L636). A reason on record takes a row out of the count: a pending flip
 * is already reported as pending, and a Redistribute mark says Slate took them out
 * of the pool because of the Twilio tag. What is left is the set a person has to
 * settle, one way or the other.
 */
export function onSalesWithNoRecordedHold(input: {
  attributes: Attributes | null | undefined;
  bookable: boolean;
  deactivated: boolean;
  pending: boolean;
  markedRedistribute: boolean;
}): boolean {
  if (input.bookable || input.deactivated || input.pending || input.markedRedistribute) return false;
  return qualifiesForBooking(input.attributes);
}

export type FlipReason = "sales-profile" | "retry";

export interface OnboardingInput {
  /** The attributes Slate held before this run; null for a row being created now. */
  prev: Attributes | null;
  /** The attributes Salesforce holds now. */
  next: Attributes;
  bookable: boolean;
  deactivated: boolean;
  /** `bookable_pending_since` is set: an earlier flip was planned and refused. */
  pending: boolean;
}

export type OnboardingPlan = { action: "none" } | { action: "flip"; reason: FlipReason };

/**
 * Decide whether this run should try to make the person bookable.
 *
 * Order matters and each early return is a rule somebody stated:
 * somebody who has left is never put back by a Salesforce edit; somebody already
 * in the pool needs nothing; a pending flip is retried whatever the attributes now
 * say, because the mark IS the intent; and otherwise only the transition from
 * not qualifying to qualifying flips. A brand new row has no "before", and one
 * that already qualifies on arrival flips at once, since a hire created straight
 * onto Sales with a tier would otherwise never see a transition at all.
 */
export function planOnboardingFlip(input: OnboardingInput): OnboardingPlan {
  if (input.deactivated) return { action: "none" };
  if (input.bookable) return { action: "none" };
  if (input.pending) return { action: "flip", reason: "retry" };
  if (!qualifiesForBooking(input.next)) return { action: "none" };
  if (input.prev !== null && qualifiesForBooking(input.prev)) return { action: "none" };
  return { action: "flip", reason: "sales-profile" };
}
