import { BACKEND } from "../xbc.ts";
import { tierLadder } from "./tiers.ts";

const XBC = /^[1-5][0-3][0-2]$/;

/**
 * Pure: choose the Slack alert for a routing fallback, from the two CODES.
 *
 * It used to take a rung count and escalate at two. #1909 changed what a rung
 * is: a Beyond code now overflows sideways to Achieve in the SAME debt tier
 * before dropping one, so the first rung below the request is not a tier drop at
 * all, and an ordinary overflow followed by a single tier drop is two rungs. Left
 * as it was, the commonest new fallback would have paged as a deep cascade from
 * the day the ladder shipped, which is how an alert stops being read (L36).
 *
 * A count cannot say which kind of movement happened, and both codes are already
 * in hand, so the two facts are derived here rather than passed in (L107): how
 * many DEBT TIERS were dropped, and whether the backend changed.
 *
 * Three outcomes, each its own key, because they send somebody to do three
 * different things (L11):
 *
 *   * a sideways overflow is the rule working: no Beyond agent was free, an
 *     Achieve agent in the same tier took it. Worth saying, not worth paging.
 *   * one debt tier down is the ordinary fallback.
 *   * two or more is near impossible under normal load and signals a capacity or
 *     systems problem, so it escalates.
 *
 * Returns null when nothing moved, when either code cannot be read, and when the
 * pair is one the LADDER cannot produce. That last guard is not defensive: the
 * preview fixtures this shipped with were `411 -> 410` and `411 -> 400`, which
 * change the legal digit, and no rung of any ladder does that. Fed to a version
 * that derives its facts from the codes, they would have read as a same tier
 * overflow and put a confident wrong sentence in Slack. A pair off the ladder is
 * a code fault; the routing trace records it and this notice does not try to
 * describe it (L11). Asking `tierLadder` rather than re-deriving the rule here
 * means the two can never disagree about what a rung is (L107).
 */
export function tierFallbackAlert(input: {
  requestedCode: string;
  effectiveCode: string;
}): { key: string; cooldownMs: number; text: string } | null {
  const { requestedCode, effectiveCode } = input;
  if (!XBC.test(requestedCode) || !XBC.test(effectiveCode)) return null;
  if (requestedCode === effectiveCode) return null;
  if (!tierLadder(requestedCode).includes(effectiveCode)) return null;

  const tiersDropped = Number(requestedCode[0]) - Number(effectiveCode[0]);
  const backendChanged = requestedCode[1] !== effectiveCode[1];
  // Named, so the notice says who took the booking rather than a digit.
  const took = BACKEND[effectiveCode[1]]?.label ?? "another";

  if (tiersDropped >= 2) {
    return {
      key: `tier_fallback_deep:${requestedCode}`,
      cooldownMs: 5 * 60 * 1000,
      text: `Routing alert: a booking for bucket ${requestedCode} dropped ${tiersDropped} debt tiers to ${effectiveCode} because every tier above it had no availability across the booking window. This should almost never happen. Check for a capacity crunch, mass time off, or a roster or availability problem.`,
    };
  }

  if (tiersDropped === 0) {
    return {
      key: `tier_fallback_overflow:${requestedCode}`,
      cooldownMs: 60 * 60 * 1000,
      text: `Routing notice: a booking for bucket ${requestedCode} went to ${took} in the same debt tier (${effectiveCode}); no agent on the requested backend service had availability across the booking window.`,
    };
  }

  const text = backendChanged
    ? `Routing notice: a booking for bucket ${requestedCode} dropped one debt tier and went to ${took}, landing on ${effectiveCode}; nothing in the requested tier had availability across the booking window.`
    : `Routing notice: a booking for bucket ${requestedCode} dropped one debt tier to ${effectiveCode}; the requested tier had no availability across the booking window.`;
  return { key: `tier_fallback:${requestedCode}`, cooldownMs: 60 * 60 * 1000, text };
}
