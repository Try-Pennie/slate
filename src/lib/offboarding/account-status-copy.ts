/**
 * What the agent page says about deactivating, and how it differs from making
 * somebody not bookable (#1875).
 *
 * Dan: "I am not clear how deactivating differs from making somebody
 * unbookable." The screen was not going to tell him. It said deactivating is
 * "Fully reversible by reactivating", which is the one claim on the panel that
 * is FALSE, and it said nothing at all about the other axis.
 *
 * THE TWO AXES, which the code is explicit about (`db/types.ts`):
 *
 *   not bookable   the ON SHIFT switch. They still work here: in the roster, in
 *                  pickers, able to be somebody's manager of record, able to log
 *                  in and hold time off. They just receive no new bookings right
 *                  now. Flip it back and they do.
 *   deactivated    they have LEFT. Out of the pool, the round robin, the calendar
 *                  sync and watch loop, the admin roster and the manager pickers.
 *                  The row is kept so their history survives.
 *
 * WHY "FULLY REVERSIBLE" WAS WRONG. Deactivating sets `bookable = false` in the
 * same write (#1324), and reactivating deliberately does NOT restore it:
 * re-admitting somebody to the routing pool is the decision `users.bookable`
 * exists to make deliberately (`offboarding/service.ts`, and the behaviour is
 * pinned by "leaves the bookable flag alone when reactivating" in
 * `service.test.ts`). Anyone trusting the old sentence would reactivate a
 * returning agent and wonder why they receive nothing.
 *
 * It also never said that deactivating leaves their upcoming bookings WITH them.
 * Nothing is moved. There is a confirm that warns about it (#1215) but only when
 * they hold something, so an agent with an empty calendar was offboarded in one
 * click with nothing on the panel saying what it does.
 *
 * PURE so the claims can be asserted rather than discovered: the defect here was
 * a sentence, and a test that only checked the button rendered would have passed
 * straight through it.
 */

/**
 * The panel's own description: what deactivating means, what it does not do, and
 * what reactivating does not bring back.
 *
 * Ends by naming the OTHER axis and where it is, because the question this panel
 * has to answer is which of the two a reader wants. The bookable toggle stays up
 * in Access deliberately: it is an everyday control and this is a departure, so
 * they are separated by consequence (the #1873 rule), and the difference is
 * carried by this sentence rather than by putting a routine switch beside a
 * destructive one.
 */
export function deactivateExplanation(): string {
  return (
    `Deactivating says this person has left. They drop out of the booking pool, the ` +
    `round robin, the calendar sync and every picker, and their history is kept. It does ` +
    `not move their upcoming bookings: those stay with them until somebody moves them. ` +
    `Reactivating brings the account back, but it does not make them bookable again: ` +
    `that stays a separate decision.`
  );
}

/**
 * The one line that tells the two axes apart, for a reader who wants the other
 * one.
 */
export function notBookableContrast(): string {
  return (
    `To stop new bookings for somebody who still works here, leave the account active ` +
    `and use Not bookable under Access instead. They keep everything else and go back ` +
    `into the rotation whenever you flip it back.`
  );
}
