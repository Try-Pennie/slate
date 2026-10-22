/**
 * The panel copy that answers "is this section necessary?" (#1876).
 *
 * The old wording was about time off, which is the one situation that is already
 * automatic, so a reader who knew that concluded the panel was redundant. These
 * assertions are on the two claims that stop that happening: it must not describe
 * itself as being about absence, and it must SAY that approved time off is
 * handled on its own.
 */
// Run: node --experimental-strip-types scripts/test-coverage-panel-copy.ts
import {
  COVERAGE_PANEL_NAME,
  coverageNothingMovedNotice,
  coverageNothingToMoveSentence,
  coveragePanelDescription,
  coveragePanelTimeOffNote,
  coveragePanelWhere,
  coverageMoveMayStart,
  coveragePreviewLine,
  coverageProgressUnreadableNotice,
  coverageCouldNotPlaceHeading,
  coverageStrandedMovesLead,
  coverageStrandedUnreadableNotice,
} from "../src/lib/booking/coverage-panel-copy.ts";
import { assert, finish } from "./lib/harness.ts";

// the name
assert(
  COVERAGE_PANEL_NAME === "Move upcoming bookings",
  "names the action rather than the one situation that is automatic",
);
assert(
  !/coverage/i.test(COVERAGE_PANEL_NAME),
  "does not call itself Coverage, which reads as being about absence",
);

// where another surface sends a reader
const where = coveragePanelWhere();
assert(where.includes(COVERAGE_PANEL_NAME), "derives the name rather than spelling it again");
assert(
  coveragePanelWhere("their").startsWith("Move upcoming bookings on their"),
  "takes the possessive from the caller, so the sentence around it reads",
);

// the description
const said = coveragePanelDescription("Aria Patel");
assert(said.includes("Aria Patel"), "names whose bookings would move");
assert(
  !/while they are out|time off|absen/i.test(said),
  "does not describe itself as being about time off, which is the automatic case",
);
// #2121: the four situations are NOT named. Nobody arrives at this panel
// wondering whether their reason qualifies, and the list ran four cases long
// above the controls, pushing the three sentences that carry information further
// down. The situations stay recorded in the module docstring, where they explain
// to a maintainer why the panel exists, which is a different question.
for (const when of [/left the pool/i, /Salesforce/i, /escalat/i, /out sick/i]) {
  assert(!when.test(said), `does not list the occasion ${when} above the controls`);
}
assert(
  !/for any reason/i.test(said),
  "does not open by ruling on whether the reader's reason qualifies",
);
// What it does to a booking, which the old copy got right and must not lose.
assert(/keeps its exact time/i.test(said), "says the time does not change");
assert(/one short note/i.test(said), "says the customer is told once");
assert(/stays put/i.test(said), "says an unplaceable booking is left alone");

// the time off note
const note = coveragePanelTimeOffNote();
assert(
  /already moves these on its own/i.test(note),
  "says plainly that approved time off does this automatically",
);
assert(
  /stopped or did not finish/i.test(note),
  "and names the time off case that DOES come back here, so the reassurance is not read as never",
);


/**
 * The zero outcome, on the arrival the panel is opened ON (#2136).
 *
 * It used to read "in the range you chose", which is true only when the reader
 * set the range on this panel. A time off approval enqueues a sweep and the Team
 * Time Off row links straight to it, and offboarding enqueues an open ended one,
 * so on those arrivals nobody chose anything and the sentence names a decision
 * the reader did not make.
 */
const named = coverageNothingToMoveSentence(
  "Adam",
  "2026-08-12T00:00:00.000Z",
  "2026-08-19T23:59:59.999Z",
  "UTC",
);
assert(!/you chose|your range|the range you/i.test(named), "never claims the reader chose the window");
assert(/Aug 12/.test(named) && /Aug 19/.test(named), "names the window it is talking about");
assert(/nothing was reassigned/i.test(named), "still says what the outcome was");

const openEnded = coverageNothingToMoveSentence("Adam", "2026-08-12T00:00:00.000Z", null, "UTC");
assert(/Aug 12/.test(openEnded), "names the start of an open ended sweep");
assert(
  /onward/i.test(openEnded) && !/between/i.test(openEnded),
  "and says it runs onward rather than inventing an end",
);

// A window it could not read is said WITHOUT naming one. An unreadable bound is
// the one case where naming a date would be a claim nothing measured (L11), and
// the panel must not print "Invalid Date" at a reader either.
for (const [name, start, end] of [
  ["an unreadable start", "not-a-date", null],
  ["an unreadable end", "2026-08-12T00:00:00.000Z", "wobbly"],
  ["a missing start", null, null],
] as const) {
  const vague = coverageNothingToMoveSentence("Adam", start, end, "UTC");
  assert(/nothing was reassigned/i.test(vague), `${name}: still says what the outcome was`);
  assert(
    !/Invalid Date|NaN|undefined|null/.test(vague),
    `${name}: prints no broken date at the reader`,
  );
  assert(!/between|onward/i.test(vague), `${name}: names no window it could not read`);
}

/**
 * The zero outcome on the run the reader started HERE (#2142). It goes back to the
 * form, so the sentence says what the run did rather than offering to "start
 * another" a move nobody started.
 */
const moved = coverageNothingMovedNotice("Adam");
assert(/nothing/i.test(moved), "says nothing moved");
assert(!/another/i.test(moved), "never says another, because nothing was started");

/**
 * A reply the panel could not read (#2135). Its own state, and it may claim only
 * what was actually measured: something arrived and could not be read. It is NOT
 * the lost contact message, which is about no reply at all, and the two carry
 * different remedies because a stale page is fixed by reloading and a lost
 * connection is not.
 */
const unreadable = coverageProgressUnreadableNotice();
assert(/read/i.test(unreadable), "says the reply could not be read");
assert(/keeps running|still running/i.test(unreadable), "says the move itself is unaffected");
assert(/reload/i.test(unreadable), "and names the remedy that actually clears a stale page");
assert(!/lost contact/i.test(unreadable), "does not borrow the lost contact wording");


/**
 * The line under the range controls, which is the only thing telling a reader how
 * much work they are about to start.
 *
 * Its four states are one function because they are one line, and because a count
 * that could not be READ used to fall into the same null as a count nobody had
 * asked for yet, so a failed read said "Enter a range to see how many bookings
 * would move" at somebody who had entered one (L10, L11).
 */
const previewLines = {
  unasked: coveragePreviewLine({ kind: "unasked" }),
  counting: coveragePreviewLine({ kind: "counting" }),
  unreadable: coveragePreviewLine({ kind: "unreadable" }),
  none: coveragePreviewLine({ kind: "count", count: 0 }),
  one: coveragePreviewLine({ kind: "count", count: 1 }),
  many: coveragePreviewLine({ kind: "count", count: 5 }),
};
assert(/1 booking would/.test(previewLines.one), "counts one booking in the singular");
assert(/5 bookings would/.test(previewLines.many), "and several in the plural");
assert(/no upcoming bookings/i.test(previewLines.none), "says a range holding nothing holds nothing");
assert(
  /couldn't count|could not count/i.test(previewLines.unreadable),
  "says a count it could not read was not read",
);
assert(
  previewLines.unreadable !== previewLines.unasked,
  "and never borrows the line for a range nobody has entered, which is the message that reads as healthy",
);
// Every state distinct, or two causes are one outcome in practice (L11, L260).
const seen = new Set(Object.values(previewLines));
assert(seen.size === Object.keys(previewLines).length, "every preview state says something of its own");

/**
 * Which preview states may START a move (#2157).
 *
 * The panel used to disable the button on a count of zero and while a count was in
 * flight, and leave it LIVE for a count that could not be read at all: "we could
 * not count" was treated as permission, on the one control here whose consequence
 * is customer facing and not undoable in a click.
 *
 * Refusing is the recoverable direction. A manager blocked by an unreadable count
 * still has every booking where it was and can press again, or count again; a
 * sweep started on an unreadable count has already moved real appointments onto
 * other advisors and there is no single control that puts them back. So the move
 * may start from a MEASURED count above zero and from nothing else, which also
 * takes in the state before anybody has asked, where the line beside the button
 * says to enter a range and the button used to be live anyway.
 */
assert(coverageMoveMayStart({ kind: "count", count: 5 }), "a measured count above zero may start");
assert(coverageMoveMayStart({ kind: "count", count: 1 }), "one booking is still a move");
assert(!coverageMoveMayStart({ kind: "count", count: 0 }), "a measured zero may not");
assert(!coverageMoveMayStart({ kind: "counting" }), "a count in flight may not");
assert(!coverageMoveMayStart({ kind: "unasked" }), "and neither may a range nobody has entered");
assert(
  !coverageMoveMayStart({ kind: "unreadable" }),
  "an unreadable count REFUSES the move: it is not a count of zero, and it is not permission either",
);
// The line and the button have to agree, so the refusal has to be on the line:
// a control that silently does nothing is worse than one that says why (L109).
assert(
  /cannot start|can't start/i.test(previewLines.unreadable),
  "and the line beside the button says the move cannot start, rather than leaving a dead control",
);

// #3595: the agent page's standing list of calls the last move could not place.
// The heading is the move's own list heading, from one function, so the two
// surfaces showing the same rows cannot name them differently (L118).
assert(coverageCouldNotPlaceHeading(6) === "Couldn't place (6)", "the heading carries the count");
assert(
  coverageStrandedMovesLead(1) === "Left by the move on",
  "one move is named as the move, and the time follows it",
);
assert(
  coverageStrandedMovesLead(2) === "Left by 2 moves, the latest on",
  "several moves are counted, and the time named is the latest",
);
const strandedUnreadable = coverageStrandedUnreadableNotice("Robert Bekele");
assert(
  /could not check/i.test(strandedUnreadable) && strandedUnreadable.includes("Robert Bekele"),
  "a failed read says it could not check, for whom, never that nothing is waiting",
);
assert(/reload/i.test(strandedUnreadable), "and names the one thing that can clear it");
assert(!/nothing|none|no calls/i.test(strandedUnreadable), "an unread list claims no absence");

// copy rules
for (const [name, text] of [
  ["could not place heading", coverageCouldNotPlaceHeading(3)],
  ["stranded moves lead, one", coverageStrandedMovesLead(1)],
  ["stranded moves lead, several", coverageStrandedMovesLead(4)],
  ["stranded unreadable", strandedUnreadable],
  ["description", said],
  ["time off note", note],
  ["name", COVERAGE_PANEL_NAME],
  ["where", where],
  ["nothing to move, window named", named],
  ["nothing to move, open ended", openEnded],
  ["nothing moved on this run", moved],
  ["unreadable progress", unreadable],
  ...Object.entries(previewLines).map(([k, v]) => [`preview ${k}`, v] as const),
] as const) {
  // Written as escapes, not literals: the pre push style gate cannot tell a line
  // BANNING the character from a line using it, and it is right not to try.
  assert(!/[\u2014\u2013]/.test(text), `${name} carries no dash punctuation`);
  assert(!/undefined|null|NaN/.test(text), `${name} leaks no placeholder`);
}

finish();
