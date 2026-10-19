/**
 * The words on the Hours page's "Days offered" card (#3922), as settled in
 * `docs/design/days-offered.html` over four design rounds (Dan, 2026-10-19).
 *
 * The card holds two settings: how many open days every lead is offered, and how
 * many extra days the last resort (#2841) may add when every tier a lead may use is
 * full. Before #3922 the editable box was the furthest day, labelled "Most days
 * offered", beside a paragraph saying a lead is offered 3, so Dan read the two as
 * contradicting each other. Each now has its own name, held here ONCE: the labels,
 * the server's refusals, the save button, the saved sentence and the unsaved changes
 * warning all read these constants, so no third name ("booking horizon") can creep
 * back in (D9).
 *
 * Pure (no imports at all), so the node suite, the client card and the e2e spec can
 * all reach it.
 */

/** The card's heading, and the name the save, the notice and the warning use. */
export const DAYS_OFFERED = "Days offered";

/** The one button, saving both values (D9). */
export const SAVE_DAYS_OFFERED = `Save ${DAYS_OFFERED.toLowerCase()}`;

/** The saved sentence (D9). */
export const DAYS_OFFERED_SAVED = `${DAYS_OFFERED} saved.`;

/** What the unsaved changes warning says is unsaved: "You have unsaved changes to the days offered". */
export const DAYS_OFFERED_UNSAVED = `changes to the ${DAYS_OFFERED.toLowerCase()}`;

/** The first control's label. */
export const OFFERED_DAYS_LABEL = "Offered open days";

/** The second control's label. */
export const EXTRA_DAYS_LABEL = "Last resort extra days";

/** The domain of each, said once, on the term (D7, L604). */
export const OFFERED_DAYS_HINT = "Every lead sees this many open days.";
export const EXTRA_DAYS_HINT = "Added when every tier a lead may use is full. 0 means no last resort.";

/** The one qualification the offered days need, from the cutoff constant's own label (D8). */
export function todayCountsNote(cutoffLabel: string): string {
  return `Today counts only before ${cutoffLabel}.`;
}

/** The fact line's term (D3). */
export const FURTHEST_DAY_TERM = "Furthest a lead can be offered";

/**
 * The fact line's value, in two parts so the day can carry the weight the design
 * gives it: "Day 4" then "(3 offered + 1 extra)". Kept although it repeats both
 * values, because the furthest day is the number a reader is actually asking about
 * (D3, Dan's choice in round 2).
 */
export function furthestDayValue(offered: number, extra: number): { day: string; sum: string } {
  return { day: `Day ${offered + extra}`, sum: `(${offered} offered + ${extra} extra)` };
}

/** Said in place of the card when its settings could not be read. */
export const DAYS_OFFERED_UNREADABLE =
  "The days offered could not be read just now, so nothing is shown here. Reload in a moment. " +
  "The stored values are unchanged and the booker is still using them.";
