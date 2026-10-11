import { matchesCriteria } from "@/lib/availability/match";
import type { Attributes, Criteria } from "@/lib/db/types";

/**
 * The per-booking eligibility predicate for the reroute-on-ineligibility feature (#3582,
 * Phase 1).
 *
 * "Does this agent still serve a booking whose bucket has these criteria?" It mirrors the
 * shipped pool resolver `agentIdsFromPool` for ONE agent, deliberately built on the SAME
 * `matchesCriteria` rather than a second copy of the rule (L263, L342): a manual member of
 * the booking's bucket serves it regardless of attributes, and otherwise the agent must
 * still match the bucket's criteria. `scripts/test-reroute-eligibility.ts` pins the two to
 * agree across shapes, so the reroute trigger can never judge eligibility differently from
 * the booker itself.
 */
export function agentStillServes(
  attributes: Attributes | null | undefined,
  criteria: Criteria | null | undefined,
  isManualMember: boolean,
): boolean {
  if (isManualMember) return true;
  return matchesCriteria(attributes, criteria);
}

/** One of an agent's upcoming bookings, with everything the decision needs about the
 *  booking's OWN bucket. `kind` is the booking kind; an `agent_link` booking (the lead
 *  chose the advisor by name) is never auto-rerouted on a demotion. */
export interface RerouteCandidate {
  bookingId: string;
  kind: string;
  /** The criteria of the booking's own bucket. */
  criteria: Criteria | null;
  /** Whether the agent is a manual member of that bucket (then attributes never matter). */
  isManualMember: boolean;
}

/**
 * Which of an agent's upcoming bookings must reroute after an eligibility change (#3582,
 * Phase 2). Pure, so `scripts/test-reroute-eligibility.ts` drives every branch.
 *
 * A booking reroutes ONLY on a CONFIRMED NARROWING: the agent served it under the `before`
 * attributes and no longer serves it under the `after` attributes. Two fail-safes that keep
 * a transient or incomplete roster read from permanently moving a real customer:
 *
 *  - If EITHER snapshot is null/undefined (unknown, e.g. a failed or partial Twilio read),
 *    nothing reroutes. The caller passes null for "could not read", never an empty object,
 *    so a genuine empty tag set ({} = read, no tags) is still a confirmed narrowing while an
 *    unread one is not (L214, L50). A null attribute must never be fed to `matchesCriteria`
 *    and scored as "ineligible".
 *  - An `agent_link` booking never reroutes: the lead asked for that specific advisor.
 *
 * A widening (an upgrade) reroutes nothing, because the agent still serves everything they
 * did before. A manual member's booking never reroutes, because membership, not attributes,
 * decides it.
 */
export function bookingsToReroute(
  before: Attributes | null | undefined,
  after: Attributes | null | undefined,
  bookings: RerouteCandidate[],
): string[] {
  if (before == null || after == null) return [];
  return bookings
    .filter((b) => b.kind !== "agent_link")
    .filter(
      (b) =>
        agentStillServes(before, b.criteria, b.isManualMember) &&
        !agentStillServes(after, b.criteria, b.isManualMember),
    )
    .map((b) => b.bookingId);
}
