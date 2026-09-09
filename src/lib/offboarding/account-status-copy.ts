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
 * The panel's own description: what deactivating means, and what it asks.
 *
 * Ends by naming the OTHER axis and where it is, because the question this panel
 * has to answer is which of the two a reader wants. The bookable toggle stays up
 * in Access deliberately: it is an everyday control and this is a departure, so
 * they are separated by consequence (the #1873 rule), and the difference is
 * carried by that sentence rather than by putting a routine switch beside a
 * destructive one.
 *
 * #2123 CUT TWO THINGS. The list of what an agent drops out of ran "the booking
 * pool, the round robin, the calendar sync and every picker": four internal
 * systems to make one point, and three of the four are things a reader has no way
 * to check. One is enough, and the booking pool is the one they can see.
 *
 * And the closing sentence explained REACTIVATING inside the explanation of
 * deactivating. It has moved to `reactivateExplanation` below, where that control
 * actually is, rather than being deleted: the claim it corrects is the one thing
 * on this panel a reader previously acted on and got wrong, and losing it would
 * put the false belief straight back.
 *
 * #2124 REWROTE THE MIDDLE. It said "It does not move their upcoming bookings:
 * those stay with them until somebody moves them", which stopped being true the
 * moment deactivating started asking. The panel says a choice is coming, because
 * a screen describing behaviour the product no longer has is worse than one
 * saying nothing at all.
 */
export function deactivateExplanation(): string {
  return (
    `Deactivating says this person has left. They drop out of the booking pool and ` +
    `their history is kept. If they still hold upcoming bookings, you choose at the ` +
    `confirm whether to move those to another advisor or leave them where they are.`
  );
}

/**
 * What reactivating does, said where reactivating is offered (#2123).
 *
 * This is the fact that used to close `deactivateExplanation`, and it is here for
 * the reason it was moved rather than dropped: "Fully reversible by reactivating"
 * was the one claim on this panel that was FALSE, and a reader who believes it
 * brings a returning agent back and then wonders why they receive nothing.
 * Deactivating clears `bookable` in the same write (#1324) and reactivating
 * deliberately does not restore it, because re-admitting somebody to the routing
 * pool is the decision `users.bookable` exists to make deliberately.
 *
 * It is shown only when the account IS deactivated, which is the only time the
 * Reactivate control is on the page, so it explains the control in front of the
 * reader rather than one they cannot see.
 */
export function reactivateExplanation(): string {
  return (
    `Reactivating brings the account back, and it does not make them bookable again: ` +
    `that stays a separate decision under Access. Any upcoming bookings that were ` +
    `moved when they left stay with whoever took them.`
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
