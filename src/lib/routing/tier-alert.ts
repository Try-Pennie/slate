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
 * Two outcomes reach Slack from here, each its own key, because they send
 * somebody to do two different things (L11):
 *
 *   * one debt tier down is the ordinary fallback.
 *   * two or more is near impossible under normal load and signals a capacity or
 *     systems problem, so it escalates.
 *
 * A third movement, the sideways overflow, deliberately sends NOTHING from here
 * any more (#2228): it is expected behaviour on a two person Beyond pool and is
 * reported as a daily count instead. The reasoning is on the branch below.
 *
 * Returns null for that overflow, when nothing moved, when either code cannot be
 * read, and when the pair is one the LADDER cannot produce. That last guard is not defensive: the
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
  //
  // Digits 0 and 1 are NOT backend services and must not be rendered as though
  // they were. `BACKEND["1"].label` is "Both" and `BACKEND["0"].label` is "None",
  // so before #2486 made those rungs reachable this read "went to Both", which
  // states an attribute of the person who took the booking that nothing measured:
  // the digit means the pool carries no backend restriction, not that the agent
  // serves both services (L192). Whoever took it is whoever was free in that
  // tier, which is what the sentence now says.
  const landedUnconstrained = effectiveCode[1] === "0" || effectiveCode[1] === "1";
  const took = landedUnconstrained
    ? "the tier's whole pool"
    : (BACKEND[effectiveCode[1]]?.label ?? "another");

  if (tiersDropped >= 2) {
    return {
      key: `tier_fallback_deep:${requestedCode}`,
      cooldownMs: 5 * 60 * 1000,
      text: `Routing alert: a booking for bucket ${requestedCode} dropped ${tiersDropped} debt tiers to ${effectiveCode} because every tier above it had no availability across the booking window. This should almost never happen. Check for a capacity crunch, mass time off, or a roster or availability problem.`,
    };
  }

  // A SIDEWAYS OVERFLOW SENDS NOTHING PER BOOKING (#2228).
  //
  // It used to return `tier_fallback_overflow:<code>`, throttled an hour per
  // requested code across fifteen Beyond codes. Measured against production on
  // 2026-09-10 and again on 2026-09-13: 88 bookable agents are Achieve only, 1 is
  // Beyond only, 1 is both, so a Beyond bucket's pool is at most two people
  // against 88. Once traffic starts, an overflow is not the exception, it is what
  // happens to a Beyond lead whenever neither of those two is free.
  //
  // Dan settled what that means on 2026-09-13: "we're moving off beyond entirely.
  // So we really shouldn't be getting many beyond bookngs". Beyond is being
  // retired, so a two person pool is what winding a service down looks like and
  // STAFFING IS NOT THE FIX. A stream of pages reporting the ladder working as
  // designed is the alert nobody reads by the second week (L36).
  //
  // So it is counted instead, once a day, on the info channel:
  // `beyond_overflow_rate` in `src/lib/monitor/beyond-overflow.ts`, read from
  // `routing_decisions` by the monitor lane. Null here is the WHOLE of the change
  // at this site; the count is somewhere that can see a rate rather than one
  // placement. The Colorado and West Virginia consequence recorded on `tiers.ts`
  // is named in that notice's copy, deliberately, rather than being lost in an
  // aggregate.
  //
  // Note what is NOT silenced: a Beyond code that ALSO dropped a debt tier (522 to
  // 432) still alerts below. That means the whole Achieve pool in the requested
  // tier was busy too, which on 88 agents is genuinely unusual.
  if (tiersDropped === 0) return null;

  const text = backendChanged
    ? `Routing notice: a booking for bucket ${requestedCode} dropped one debt tier and went to ${took}, landing on ${effectiveCode}; nothing in the requested tier had availability across the booking window.`
    : `Routing notice: a booking for bucket ${requestedCode} dropped one debt tier to ${effectiveCode}; the requested tier had no availability across the booking window.`;
  return { key: `tier_fallback:${requestedCode}`, cooldownMs: 60 * 60 * 1000, text };
}
