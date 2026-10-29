import { isTopTierCode, tierLadder } from "./tiers.ts";

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
 * in hand, so how many DEBT TIERS were dropped is derived here rather than passed
 * in (L107).
 *
 * One outcome reaches Slack from here: two or more debt tiers down, which is near
 * impossible under normal load and signals a capacity or systems problem.
 *
 * Every smaller movement deliberately sends NOTHING, each for a recorded reason
 * on its branch below: the sideways overflow (#2228), a top tier lead's cascade
 * (#2843), and a single tier drop (2026-10-02).
 *
 * Returns null for those, when nothing moved, when either code cannot be
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

  // A TOP TIER CASCADE SENDS NOTHING PER BOOKING (#2843).
  //
  // Sales ops decided on 2026-09-28 (Slack #C091G6LEQ80, p1790609176877419) that an
  // Ultra High or Very High lead is cascaded rather than booked days out: Sam, "We
  // never really want to book out further than 3 days if we can help it", with the
  // cascade stopping at Medium and skipping anybody who also carries Low (#2842).
  // There are six Ultra advisors, so inside a three day window this is ordinary
  // routing, and a page per booking reporting it is the alert nobody reads by the
  // second week (L36). Dan removed even the daily count of them on 2026-10-29.
  // A placement OUTSIDE the rule (below Medium, or an advisor who also carries Low)
  // pages from the monitor lane, `top_tier_forbidden_placement` in
  // `src/lib/monitor/top-tier-placement.ts`, because this function sees only codes,
  // and a pair the ladder cannot produce returns null below.
  //
  // The ladder already refuses to go lower than the floor, so any pair that gets
  // this far is inside the rule. What is genuinely wrong for these leads, every
  // allowed tier full, is a different event with its own signal (#2841), and it
  // must not page twice.
  if (tiersDropped > 0 && isTopTierCode(requestedCode)) return null;
  // #3338: the reason says only what the walk measured, the one time the lead
  // asked for. It used to say every tier above "had no availability across the
  // booking window", which was never measured here and is false for a drop at
  // confirm: since #3338 a lead who loses the insert race on a tier above, or waits
  // behind other leads confirming the same time, walks on down like any confirm,
  // while the tiers above still have times on show (L11, L680).
  if (tiersDropped >= 2) {
    return {
      key: `tier_fallback_deep:${requestedCode}`,
      cooldownMs: 5 * 60 * 1000,
      text: `Routing alert: a booking for bucket ${requestedCode} dropped ${tiersDropped} debt tiers to ${effectiveCode} because no tier above it could take that time when the lead confirmed. This should almost never happen. Check for a capacity crunch, mass time off, a roster or availability problem, or many leads confirming the same time.`,
    };
  }

  // NOTHING SMALLER THAN TWO TIERS SENDS ANYTHING PER BOOKING.
  //
  // A SIDEWAYS OVERFLOW (#2228). It used to return `tier_fallback_overflow:<code>`,
  // throttled an hour per requested code across fifteen Beyond codes. Measured on
  // 2026-09-10 and 2026-09-13: 88 bookable agents are Achieve only, 1 is Beyond
  // only, 1 is both, so once traffic starts an overflow is what happens to a Beyond
  // lead whenever neither of those two is free. Dan, 2026-09-13: "we're moving off
  // beyond entirely". It was then a once a day count on the info channel
  // (`beyond_overflow_rate`), and Dan removed that too on 2026-10-02, so a sideways
  // overflow is reported nowhere. The decision log row still records each one.
  //
  // A SINGLE TIER DROP. It used to return `tier_fallback:<code>`, a Routing notice
  // throttled an hour per code. Sales ops decided on 2026-10-02 (Slack, Sam:
  // "For an edge case I'll always choose less friction because the variance of
  // enrollment rate is not crazy different across debt tiers unless you get to
  // low") that a lead who loses their tier's last opening keeps the time they
  // picked and drops a tier, so this is the ladder working as designed. Its
  // wording was also false for the commonest case: it said the tier "had no
  // availability across the booking window" when the tier had times on show and
  // lost the last one at confirm, which happens while cal.com books the same
  // calendars. Both cases are counted on /admin/routing (`tier-drop-counts.ts`),
  // split by whether the lead's own tier was on show when they confirmed.
  return null;
}
