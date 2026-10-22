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

/**
 * The heading over the calls a move could not place (#2122), with their count.
 *
 * ONE spelling for the two surfaces that show those rows (#3595): the move's own
 * progress view, and the standing list at the top of the agent page. The same rows
 * under two different headings would read as two different sets (L118).
 */
export function coverageCouldNotPlaceHeading(count: number): string {
  return `Couldn't place (${count})`;
}

/**
 * The words before the time on the agent page's standing list (#3595), saying which
 * move left these calls. The time itself is rendered in the viewer's zone by
 * `ViewerTime`, so it is not part of this string.
 *
 * Several moves can strand calls on one agent (an approved time off, then a
 * Redistribute), so with more than one the count is said and the time named is the
 * latest, rather than one move's time standing for calls another move left.
 */
export function coverageStrandedMovesLead(moves: number): string {
  return moves > 1 ? `Left by ${moves} moves, the latest on` : "Left by the move on";
}

/**
 * The standing list could not be read (#3595). Its own state, never an empty list:
 * an empty list is what a healthy agent shows, so a failed read drawn that way would
 * tell the reader nothing is waiting when nothing was measured (L10, L11). One plain
 * sentence and the one thing that can clear it.
 */
export function coverageStrandedUnreadableNotice(agentName: string): string {
  return `Slate could not check whether a move left any calls with ${agentName} to place by hand. Reload the page to try again.`;
}

/**
 * What the range preview has to say, as one value rather than a number beside a
 * flag explaining how the number was obtained (L544).
 *
 * `unreadable` is the state that did not exist: a count that came back in a shape
 * nothing could read fell into the same null as a count nobody had asked for yet,
 * so a failed read told a reader who had entered a range to enter one (L10, L11).
 */
export type CoveragePreviewState =
  | { kind: "unasked" }
  | { kind: "counting" }
  | { kind: "unreadable" }
  | { kind: "count"; count: number };

/**
 * Whether the move may be STARTED from this preview state (#2157).
 *
 * The panel disabled its start button on a count of zero and while a count was in
 * flight, and left it live for a count that could not be READ at all, so "we could
 * not count" was treated as permission on the one control here whose consequence is
 * customer facing and not undoable in a click. The count is the only thing on the
 * panel that says how big the thing about to happen is.
 *
 * REFUSING is the recoverable direction, and that is the whole argument. A manager
 * blocked by an unreadable count still has every booking where it was; they can
 * count again, or come back when the read recovers, and nothing has been done to
 * anybody. A sweep started on an unreadable count has already moved real people's
 * appointments onto other advisors, and no single control puts them back.
 *
 * Written as the one state that MAY start rather than as a list of states that may
 * not, so a fifth state added later is refused by default rather than inheriting
 * permission from nobody having thought about it.
 *
 * It lives beside the line the same state renders, because the button's enabled
 * state and the sentence next to it are one decision: two predicates in two files
 * is exactly how a live button ended up beside a sentence saying nothing was
 * counted.
 */
export function coverageMoveMayStart(state: CoveragePreviewState): boolean {
  return state.kind === "count" && state.count > 0;
}

/**
 * The one line under the range controls. All four states here rather than three
 * inline in the component and a fourth added beside them, because they are one
 * sentence taking one of four values and splitting them is how two of them drift.
 */
export function coveragePreviewLine(state: CoveragePreviewState): string {
  switch (state.kind) {
    case "counting":
      return "Counting bookings in range…";
    case "unreadable":
      // #2157. It used to end "Try again in a moment", which named an action that
      // changes nothing: the count is debounced on the range, so a reader who does
      // not edit the dates gets no second attempt however long they wait (L111).
      // The panel puts a Count again control beside this line, and the line says
      // what the refusal is rather than repeating that control's own label (L605).
      return "Couldn't count the bookings in this range, so the move cannot start.";
    case "count":
      return state.count === 0
        ? "No upcoming bookings in this range."
        : `${state.count} booking${state.count === 1 ? "" : "s"} would be reassigned.`;
    case "unasked":
      return "Enter a range to see how many bookings would move.";
  }
}
