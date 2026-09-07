/**
 * Pure logic for the catch-all rate page (#1908).
 *
 * A lead whose routing code is blank or unreadable is routed to the Low pool
 * rather than refused. That is the right behaviour, and it is also a defect
 * absorber: every rescued lead is one whose upstream page failed to send a code,
 * and the whole reason this was worth building is that cal.com has been doing the
 * same thing silently and nobody knew it was carrying roughly 2 percent of all
 * bookings.
 *
 * So the rescue is counted, and a RISE in it pages. Without that, the fix would
 * reproduce the exact condition it was written to end: a rescue nobody can see.
 *
 * NO DELTA MACHINERY, deliberately. The sibling booking-failure-rate check carries
 * a lot of it because its counter is bucketed by ET day and a short window has to
 * be reconstructed from differences. `routing_decisions` carries `created_at`, so
 * a window here is just a query, and copying that shape would be two things that
 * have to agree about what an hour means for no gain.
 *
 * NO VERDICT STAMP, deliberately. The three detectors in `verdict-freshness.ts`
 * carry one because a fail-safe check can sit blind for weeks and look healthy.
 * This one will read `unmeasured` for the whole parallel run, since no leads reach
 * Slate until cutover, and that is the CORRECT answer rather than a blindness to
 * page about: a stamp here would produce a daily "has never concluded" notice
 * about a state everybody already knows. It is named here rather than left out
 * silently, because an omission that is right is indistinguishable from one that
 * was forgotten (L129).
 *
 * Its liveness comes from the lane, not from itself: the step runs inside the
 * monitor lane's own failure boundary, and the lane watchdog is what notices if
 * the lane stops firing (L13, L71).
 *
 * No `@/` imports, so `scripts/test-catchall-rate.ts` drives every branch
 * node-natively; the counting and the sending are injected by the caller.
 */

/** alert_state row key for the page and its all-clear. ONE constant, so the two
 *  cannot drift onto different keys and leave a page nobody can clear. */
export const CATCHALL_RATE_ALERT_KEY = "catchall_rate";

/**
 * The share of bookings above which this pages.
 *
 * Calibrated against the incumbent rather than guessed: cal.com's own catch-all
 * carries 105 of 6,000 recent routing form responses (1.75 percent), and 4 of the
 * newest 200 measured on 2026-09-07 (2 percent). Five percent is about two and a
 * half times that, which is a real regression in whatever upstream page stopped
 * sending codes rather than ordinary movement.
 */
export const CATCHALL_RATE_THRESHOLD = 0.05;

/**
 * How many rescues must be in the window before the RATE is allowed to page.
 *
 * A proportion over one or two bookings is noise, and paging on it teaches
 * somebody to ignore the alert (L36).
 */
export const CATCHALL_MIN_COUNT = 3;

/**
 * The share at which volume stops mattering.
 *
 * A floor added to stop a rate being noisy at small samples also silences the
 * SATURATION case, because a proportion cannot tell one bad out of two from
 * twelve out of twelve (L139). If half of everything booked is being rescued,
 * something upstream has broken completely, and that is worth saying on the
 * second booking rather than the fourth.
 */
export const CATCHALL_SATURATION_SHARE = 0.5;

export interface CatchallWindow {
  /** Bookings in the window whose code was blank or unreadable. */
  catchall: number;
  /** Every booking in the window, rescued or not. */
  total: number;
  /** How far back the counts reach, for the message. */
  windowHours: number;
}

export type CatchallVerdict =
  /** Nothing was booked in the window, so there is no rate to judge. NOT healthy:
   *  judging nothing is never a pass (L98), and before cutover this is the
   *  expected state, which is exactly why it must not read as an all clear. */
  | { kind: "unmeasured"; reason: string }
  /** Measured, and within tolerance. */
  | { kind: "healthy"; share: number; catchall: number; total: number }
  /** Measured, and above what the incumbent runs at. */
  | {
      kind: "page";
      share: number;
      catchall: number;
      total: number;
      /** Which rule fired, because the two mean different things: a rate above
       *  the threshold is drift, saturation is something upstream fully broken. */
      trigger: "rate" | "saturation";
    };

/**
 * Judge one window.
 *
 * Note what is NOT here: any notion of whether the roster is live. Dan's call
 * (2026-09-07) is that this pages from day one. Before cutover nothing should
 * reach the booker at all, so a rescued booking then is itself worth knowing
 * about, and arming it later is one more thing to remember.
 */
export function catchallVerdict(w: CatchallWindow): CatchallVerdict {
  if (!Number.isFinite(w.total) || w.total <= 0) {
    return {
      kind: "unmeasured",
      reason: `no bookings recorded in the last ${w.windowHours}h, so there is no rate to judge`,
    };
  }
  if (!Number.isFinite(w.catchall) || w.catchall < 0) {
    return { kind: "unmeasured", reason: "the rescued count could not be read" };
  }
  // A count larger than the total is not a very high rate, it is a broken read,
  // and reporting it as 300 percent would send somebody hunting for an upstream
  // fault that is actually ours.
  if (w.catchall > w.total) {
    return {
      kind: "unmeasured",
      reason: `counted ${w.catchall} rescued out of ${w.total} booked, which cannot be right`,
    };
  }

  const share = w.catchall / w.total;
  if (w.catchall > 0 && share >= CATCHALL_SATURATION_SHARE) {
    return { kind: "page", share, catchall: w.catchall, total: w.total, trigger: "saturation" };
  }
  if (w.catchall >= CATCHALL_MIN_COUNT && share > CATCHALL_RATE_THRESHOLD) {
    return { kind: "page", share, catchall: w.catchall, total: w.total, trigger: "rate" };
  }
  return { kind: "healthy", share, catchall: w.catchall, total: w.total };
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/**
 * What the page says.
 *
 * It names the number, the window and what to go and look at, because a person
 * reading this on a phone needs to know whether to act now. The upstream cause is
 * named as the thing to check, since every rescue is a link that arrived without
 * a routing code and the fix is never in Slate.
 */
export function catchallPageText(v: Extract<CatchallVerdict, { kind: "page" }>, windowHours: number): string {
  const lead =
    v.trigger === "saturation"
      ? `${pct(v.share)} of bookings in the last ${windowHours}h arrived with no usable routing code`
      : `Bookings arriving with no usable routing code have risen to ${pct(v.share)} over the last ${windowHours}h`;
  return (
    `${lead} (${v.catchall} of ${v.total}). They were routed to the Low pool rather than turned away, ` +
    `so nobody was blocked, but a lead whose real tier was higher has been booked with the wrong team. ` +
    `The cause is upstream: a page is building booking links without an xbc. ` +
    `Check routing_decisions.requested_code for what actually arrived.`
  );
}

/** What the all-clear says. A condition, so it owes one (see the alert catalog):
 *  somebody who read the page needs to know when it is over. */
export function catchallClearText(share: number, windowHours: number): string {
  return (
    `Bookings with no usable routing code are back to ${pct(share)} over the last ${windowHours}h, ` +
    `within the ${pct(CATCHALL_RATE_THRESHOLD)} the incumbent runs at.`
  );
}
