/**
 * What the panel that moves an agent's upcoming bookings CALLS itself, and says
 * about itself (#1876).
 *
 * Dan, reading it: "Is this section necessary? Doesn't reassignation already
 * happen when they request the time off?" That read was half right, and the half
 * that was right is the defect. Approving time off DOES run a coverage sweep on
 * its own (#1239), and time off was the one situation the panel's own words were
 * about: it was titled "Coverage: reassign upcoming bookings" and described as
 * moving bookings "while they are out". Meanwhile its default reason is "Owner
 * reassignment", which is not an absence at all, so the title, the description
 * and the default option each pointed somewhere different.
 *
 * The four situations that are NOT time off, and are the reason the panel exists:
 *
 *   deactivation      deactivating an agent does not move their bookings, and
 *                     the #1215 confirm links straight here
 *   an owner change   Salesforce moved who owns the lead; nothing to do with absence
 *   escalation        moving one booking to somebody else on purpose
 *   a failed sweep    when the sweep behind an approval has to be stopped or did
 *                     not finish, a person opening this panel is the only route back
 *
 * Plus the ordinary ad hoc case, somebody out sick who never filed anything.
 *
 * PURE, and in `lib` rather than inline in the component, for the same reason the
 * time off notices are (`ooo/coverage-notice-copy.ts`): copy that can only be
 * read by rendering the page is copy nobody reviews.
 */

import { parseStampMs } from "../date/stamp.ts";

/**
 * The panel's heading, and the ONE definition of its name.
 *
 * Every message that sends somebody here derives the name from this constant
 * rather than spelling it out, because four Slack sentences and two on screen
 * ones point at this panel and a message naming a section that no longer exists
 * is a dead end wearing the clothes of an instruction (L111). Renaming it here
 * renames it in all of them.
 */
export const COVERAGE_PANEL_NAME = "Move upcoming bookings";

/**
 * How another surface refers to this panel: the name plus where to find it.
 *
 * `whose` is possessive ("that agent's", "their"), because the sentence reaches
 * a reader who is not necessarily looking at the page.
 */
export function coveragePanelWhere(whose = "that agent's"): string {
  return `${COVERAGE_PANEL_NAME} on ${whose} page`;
}

/**
 * What the panel DOES to a booking, which is the question a reader lands on it
 * with.
 *
 * It used to open with the four situations above as a list, `for any reason:
 * they have left the pool, Salesforce changed who owns their leads, one booking
 * needs escalating, or they are out sick with nothing filed`. Nobody arrives
 * here wondering whether their reason qualifies (#2121): they arrive holding a
 * reason, and the list sat four cases long above the controls pushing the three
 * sentences that carry information further down. The situations are recorded in
 * the module docstring above, which answers the maintainer's question of why the
 * panel exists rather than the reader's question of what pressing it will do.
 */
export function coveragePanelDescription(agentName: string): string {
  return (
    `Move ${agentName}'s upcoming bookings to another advisor. Each booking keeps its ` +
    `exact time, the customer gets one short note that a different advisor will meet ` +
    `them, and anything that cannot be placed stays put for you to handle by hand.`
  );
}

/**
 * The sentence that answers Dan's question before a reader has to form it.
 *
 * Says the automatic case is automatic, which turns "is this section redundant"
 * into a reassurance, and then says the one time off case that DOES come back
 * here, so the reassurance is not mistaken for "never needed for time off".
 */
export function coveragePanelTimeOffNote(): string {
  return (
    `Approved time off already moves these on its own, so this is not needed for that. ` +
    `Come here if a sweep behind an approval has to be stopped or did not finish.`
  );
}

/**
 * One bound of a sweep's window, as a person reads it, or null when it cannot be
 * read. Month and day only: the window is a run of days a person picked on two
 * date inputs, and a time on it would be the input's own 23:59:59 showing through.
 */
function coverageWindowDay(iso: string | null | undefined, timeZone?: string): string | null {
  // parseStampMs, never a bare Date.parse: a NaN compares false against every
  // check and would reach the formatter as "Invalid Date" at a reader (#1169).
  const ms = parseStampMs(iso);
  if (ms === null) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(
    new Date(ms),
  );
}

/**
 * The zero outcome on a sweep the reader ARRIVED on rather than started (#2136).
 *
 * It used to read "no upcoming bookings in the range you chose", which is true
 * only when the reader set the range on this panel. A time off approval enqueues a
 * sweep (#1239) and the Team Time Off row links straight to it; offboarding by
 * email enqueues an open ended one. On those arrivals nobody chose a range, so the
 * old sentence named a decision the reader did not make and pointed them at a
 * control they never touched, and it landed on precisely the reader this state
 * exists for: an admin checking whether coverage happened.
 *
 * So it names the window instead of its author. A bound it cannot read is not
 * named at all, because a date nothing could parse is a claim no check made (L11).
 */
export function coverageNothingToMoveSentence(
  agentName: string,
  rangeStartIso: string | null | undefined,
  rangeEndIso: string | null | undefined,
  timeZone?: string,
): string {
  const start = coverageWindowDay(rangeStartIso, timeZone);
  const hasEnd = rangeEndIso != null && rangeEndIso !== "";
  const end = hasEnd ? coverageWindowDay(rangeEndIso, timeZone) : null;
  const window =
    start === null || (hasEnd && end === null)
      ? "in the window this move covered"
      : end === null
        ? `from ${start} onward`
        : `between ${start} and ${end}`;
  return `${agentName} had no upcoming bookings ${window}, so nothing was reassigned.`;
}

/**
 * The zero outcome on a move the reader started HERE (#2142).
 *
 * That case is no longer a screen of its own. It goes back to the form with the
 * range still in it, because the two controls that change the answer are on the
 * form and the count re-reads as they are edited, while the result screen stated
 * the same fact and then took those controls away. The old screen's only way back
 * was a button reading "Start another", and `another` was the one word in it
 * carrying meaning: the run placed nothing, moved nothing and touched no booking,
 * so nothing was started.
 *
 * The form is silent about an action otherwise, which is its own defect (L608), so
 * this is the line that says what the run did.
 */
export function coverageNothingMovedNotice(agentName: string): string {
  return `Nothing moved. ${agentName} had no upcoming bookings left in this range when the move ran.`;
}

/**
 * A progress reply this page could not read (#2135).
 *
 * A third state, beside running and lost contact, and not a blank or a success
 * (L10, L11). It may claim only what was measured, which is that something
 * arrived and could not be read: the move itself is untouched by any of it.
 *
 * The remedy is deliberately NOT the lost contact one. Losing contact is a reply
 * that never came, and reopening later is what fixes it. This is a reply that came
 * and did not fit, whose commonest cause is a page older than the server it is
 * talking to (L598), and a reload is what clears that.
 */
export function coverageProgressUnreadableNotice(): string {
  return (
    `Couldn't read the move's progress. The move keeps running in the background, ` +
    `and reloading this page usually clears this.`
  );
}
