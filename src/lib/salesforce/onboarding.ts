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
 * Whether these Salesforce attributes describe somebody who should be taking
 * bookings: on the Sales profile, or carrying at least one debt tier. Either alone
 * is enough, because either alone is something a person did on purpose.
 */
export function qualifiesForBooking(attrs: Attributes | null | undefined): boolean {
  if (!attrs) return false;
  if (attrs.role === SALES_PROFILE) return true;
  const tiers = attrs.debt_team;
  return Array.isArray(tiers) && tiers.length > 0;
}

export type FlipReason = "first-tier" | "sales-profile" | "retry";

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
  // Reported as the tier when both arrived together, since the tier is what
  // routing keys on and what a reader will go and check.
  const tiers = input.next.debt_team;
  const gainedTier = Array.isArray(tiers) && tiers.length > 0;
  return { action: "flip", reason: gainedTier ? "first-tier" : "sales-profile" };
}
