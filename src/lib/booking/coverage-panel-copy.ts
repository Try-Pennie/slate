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
