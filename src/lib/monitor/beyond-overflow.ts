/**
 * The Beyond overflow, counted once a day instead of paged once a booking
 * (#2228).
 *
 * WHAT IT REPLACED. #1909 gave a Beyond code an overflow rung: when no Beyond
 * agent is free, an Achieve agent in the SAME debt tier takes the booking.
 * `tierFallbackAlert` sent `tier_fallback_overflow:<code>` for every placement,
 * throttled one hour per requested code across fifteen Beyond codes. Measured
 * against production on 2026-09-10 and again on 2026-09-13: 88 bookable agents
 * are Achieve only, 1 is Beyond only, 1 is both. So a Beyond bucket's pool is at
 * most two people against 88 for Achieve, and once real traffic starts the
 * overflow is not the exception, it is what happens to a Beyond lead whenever
 * neither of those two is free, which on a two person pool is most of the time.
 * A sustained stream of pages reporting the system working as designed is the
 * alert nobody reads by the second week (L36).
 *
 * THE DECISION BEHIND IT, so nobody reopens it from the numbers alone. Dan,
 * 2026-09-13: "we're moving off beyond entirely. So we really shouldn't be
 * getting many beyond bookngs". Beyond is being retired as a backend service, so
 * a two person pool is not an under staffing bug, it is what winding a service
 * down looks like, and STAFFING IS NOT THE FIX. That is why this is a count on
 * the info channel and never a page, and why the copy says outright that no
 * staffing action is being asked for: an operator who reads a routing notice and
 * goes looking for somebody to add has been sent to do the wrong thing.
 *
 * WHY THE CONSEQUENCE IS STILL NAMED IN EVERY REPORT. Achieve does not lend in
 * Colorado or West Virginia, so a Beyond lead in either state who overflows is
 * booked with an agent who cannot place them. Dan accepted that on 2026-09-04 as
 * a RARE fallback (see `src/lib/routing/tiers.ts`); at a pool of two it is no
 * longer rare. It deliberately does NOT get its own louder key, and the reason is
 * not that it stopped mattering: SLATE HOLDS NO GEOGRAPHY FOR THE LEAD. There is
 * no state on `bookings`, none on `routing_decisions`, and `prefill` is an
 * arbitrary blob nothing defines. A separate alert key for "a Colorado Beyond
 * lead overflowed" would be a detector that can never once fire, which reads in
 * Slack exactly like a detector finding nothing wrong (L98, L543). So the
 * exposure is carried IN this notice, in every report, stated as what it is: the
 * count is the size of the exposure, and the message says plainly that Slate
 * cannot tell which of them are affected, because a message may claim only what
 * its check actually measured (L11). Quantifying it needs the lead's state, which
 * lives upstream in Salesforce.
 *
 * NO VERDICT STAMP and NO ALL CLEAR, both deliberately. It is classified `info`
 * in the alert catalog, so it never resolves: there is no condition to end, only
 * a number that was true of yesterday. And the three detectors in
 * `verdict-freshness.ts` carry a stamp because a fail safe check can sit blind
 * for weeks and look healthy; this one will read `unmeasured` for the whole
 * parallel run, since no leads reach Slate until cutover, and that is the CORRECT
 * answer rather than a blindness to page about. Both omissions are named here
 * rather than left silent, because an omission that is right is indistinguishable
 * from one that was forgotten (L129).
 *
 * Its liveness comes from the lane, not from itself: the step runs inside the
 * monitor lane's own failure boundary, and the lane watchdog notices if the lane
 * stops firing (L13, L71).
 *
 * Imports only `../xbc.ts` and `../routing/tiers.ts` relatively, so
 * `scripts/test-beyond-overflow.ts` drives every branch node-natively; the
 * counting and the sending are injected by the caller.
 */
import { allXbcCodes, BACKEND } from "../xbc.ts";

/** alert_state row key for the notice. ONE constant, so the sender, the catalog
 *  and the preview cannot drift onto different keys. */
export const BEYOND_OVERFLOW_NOTICE_KEY = "beyond_overflow_rate";

/**
 * How far back a report counts.
 *
 * A day, because the thing being reported is a steady behaviour rather than a
 * burst, and because a day is the unit somebody can compare against yesterday
 * without doing arithmetic.
 */
export const BEYOND_OVERFLOW_WINDOW_HOURS = 24;

/**
 * How often it may speak.
 *
 * Pinned to the window, so two consecutive reports can never both describe the
 * same overflows: a shorter cooldown would resend most of yesterday's count as
 * though it were new, which is the per booking noise this replaced wearing a
 * different shape. `scripts/test-beyond-overflow.ts` holds the two together.
 */
export const BEYOND_OVERFLOW_COOLDOWN_MS = BEYOND_OVERFLOW_WINDOW_HOURS * 60 * 60 * 1000;

/** Every bucket code whose backend digit is Beyond, derived from the same
 *  enumeration the bucket seeder uses rather than typed out, so widening the
 *  matrix moves both together (L41). */
export const BEYOND_CODES: string[] = allXbcCodes().filter(
  (c) => BACKEND[c[1]!]?.key === "beyond",
);

/**
 * Every bucket code whose backend digit is Achieve.
 *
 * This is the BOOKED side of the count, and it is the whole 15 rather than only
 * the same tier partner on purpose: a Beyond code can reach an Achieve pool one
 * or more debt tiers down as well (522 to 432), and that carries exactly the same
 * Colorado consequence as 522 to 532. `scripts/test-beyond-overflow.ts` asks the
 * real `tierLadder` whether every Achieve rung any Beyond code can reach is in
 * here, so the two can never disagree about what a rung is (L107).
 */
export const ACHIEVE_CODES: string[] = allXbcCodes().filter(
  (c) => BACKEND[c[1]!]?.key === "achieve",
);

export interface BeyondOverflowWindow {
  /** Bookings in the window requested on a Beyond code and taken by an Achieve agent. */
  overflowed: number;
  /** Every booking in the window requested on a Beyond code, overflowed or not. */
  beyondBooked: number;
  /** How far back the counts reach, for the message. */
  windowHours: number;
}

export type BeyondOverflowVerdict =
  /** Nothing countable. NOT healthy: judging nothing is never a pass (L98), and
   *  before cutover this is the expected state, which is exactly why it must not
   *  read as a report of zero overflows. */
  | { kind: "unmeasured"; reason: string }
  /** Measured, and no Beyond lead had to leave the Beyond pool. Nothing to say. */
  | { kind: "quiet"; beyondBooked: number }
  /** Measured, and some did. One line, once a window. */
  | { kind: "report"; overflowed: number; beyondBooked: number };

/**
 * Judge one window.
 *
 * There is no threshold and no floor, and that is a consequence of what this
 * reports rather than an omission. A rate threshold exists to separate ordinary
 * movement from a regression; here EVERY overflow is ordinary movement by
 * decision, so the number is being published rather than judged, and the only
 * question is whether there is a number to publish at all.
 */
export function beyondOverflowVerdict(w: BeyondOverflowWindow): BeyondOverflowVerdict {
  if (!Number.isFinite(w.beyondBooked) || w.beyondBooked <= 0) {
    return {
      kind: "unmeasured",
      reason: `nothing was booked on a Beyond code in the last ${w.windowHours}h, so there is nothing to count`,
    };
  }
  if (!Number.isFinite(w.overflowed) || w.overflowed < 0) {
    return { kind: "unmeasured", reason: "the overflow count could not be read" };
  }
  // More overflows than Beyond bookings is not a very high rate, it is a broken
  // read, and publishing it would send somebody hunting for a routing fault that
  // is actually ours.
  if (w.overflowed > w.beyondBooked) {
    return {
      kind: "unmeasured",
      reason: `counted ${w.overflowed} overflows out of ${w.beyondBooked} Beyond bookings, which cannot be right`,
    };
  }
  if (w.overflowed === 0) return { kind: "quiet", beyondBooked: w.beyondBooked };
  return { kind: "report", overflowed: w.overflowed, beyondBooked: w.beyondBooked };
}

/**
 * What the notice says.
 *
 * Three jobs, in this order, because that is the order a reader needs them: the
 * number, then permission to not act on it, then the one part of it that is worth
 * a look. The premise is dated and attributed so a reader can re-check it rather
 * than taking this file's word for it a year later (L316).
 */
export function beyondOverflowNoticeText(
  v: Extract<BeyondOverflowVerdict, { kind: "report" }>,
  windowHours: number,
): string {
  // The noun agrees with the TOTAL and the verb with the COUNT, because they are
  // different numbers: "1 of 7 Beyond bookings was taken" is right and
  // "1 of 97 bookable agent" is the 2026-07-28 page this rule comes from.
  const noun = v.beyondBooked === 1 ? "Beyond booking" : "Beyond bookings";
  const verb = v.overflowed === 1 ? "was taken" : "were taken";
  const which =
    v.overflowed === 1
      ? "so it cannot say whether that one is affected"
      : `so it cannot say which of the ${v.overflowed} are affected`;
  return (
    `Beyond overflow, last ${windowHours}h: ${v.overflowed} of ${v.beyondBooked} ${noun} ${verb} ` +
    `by an Achieve agent because no Beyond agent was free. This is expected. Pennie is moving off ` +
    `Beyond as a backend service (Dan, 2026-09-13), so the Beyond pool is small on purpose and the ` +
    `overflow rung is the routing ladder working. No staffing action is being asked for. ` +
    // Phrased as the RULE rather than as a claim that it happened, because this
    // check did not measure it and a message may claim only what it measured (L11).
    `One thing to check: Achieve does not lend in Colorado or West Virginia, so an overflowed ` +
    `lead in either state has been booked with somebody who cannot place them. Slate does not ` +
    `hold the lead's state, ${which}. Look them up in Salesforce if the count is larger than ` +
    `you expected.`
  );
}
