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
  coverageProgressUnreadableNotice,
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

// copy rules
for (const [name, text] of [
  ["description", said],
  ["time off note", note],
  ["name", COVERAGE_PANEL_NAME],
  ["where", where],
  ["nothing to move, window named", named],
  ["nothing to move, open ended", openEnded],
  ["nothing moved on this run", moved],
  ["unreadable progress", unreadable],
] as const) {
  // Written as escapes, not literals: the pre push style gate cannot tell a line
  // BANNING the character from a line using it, and it is right not to try.
  assert(!/[\u2014\u2013]/.test(text), `${name} carries no dash punctuation`);
  assert(!/undefined|null|NaN/.test(text), `${name} leaks no placeholder`);
}

finish();
