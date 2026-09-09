import { DEBT_TIER } from "../xbc.ts";

/**
 * Pure: the Slack notice for a booking routed through a relaxed legal pool
 * (#2158). Mirrors `tierFallbackAlert`, which is the same shape of fact: a
 * breadcrumb about a routing decision on a booking that has already been made.
 *
 * It is deliberately NOT quiet. A lead who asked for legal help has been given an
 * advisor nobody has cleared for legal work, which is a compromise taken over
 * showing them nothing, and the whole reason it is acceptable is that somebody is
 * told every time it happens. The cooldown is per bucket so a widespread problem
 * shows as several codes rather than one.
 *
 * Returns null when nothing was relaxed, so a caller cannot report a widening
 * that did not happen.
 */
export function legalRelaxedAlert(input: {
  requestedCode: string;
  /** How many agents the widened pool actually offered. */
  pooledAgents: number;
}): { key: string; cooldownMs: number; text: string } | null {
  if (input.pooledAgents <= 0) return null;
  // The tier by NAME, not by its digit. Read rendered in `pnpm preview:alerts`,
  // "the 4 tier's whole pool" is a code fragment leaking into a sentence somebody
  // reads on a phone; "the Very High tier" is the same fact in the vocabulary the
  // reader already has.
  const tier = DEBT_TIER[input.requestedCode[0]]?.label ?? input.requestedCode[0];
  return {
    key: `legal_relaxed:${input.requestedCode}`,
    // An hour, matching the single-rung tier notice: frequent enough to notice a
    // new one, quiet enough that a busy morning does not bury everything else.
    cooldownMs: 60 * 60 * 1000,
    text:
      `Routing notice: a booking for bucket ${input.requestedCode} was routed to an advisor who is not marked legal eligible. ` +
      `That bucket has nobody matching its legal rule, so the rule was dropped and the ${tier} tier's whole pool ` +
      `(${input.pooledAgents} ${input.pooledAgents === 1 ? "agent" : "agents"}) was offered instead. ` +
      `This stops as soon as agents carry a legal eligibility value; until then every legal booking on this code arrives this way.`,
  };
}
