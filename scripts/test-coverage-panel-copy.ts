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
  coveragePanelDescription,
  coveragePanelTimeOffNote,
  coveragePanelWhere,
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

// copy rules
for (const [name, text] of [
  ["description", said],
  ["time off note", note],
  ["name", COVERAGE_PANEL_NAME],
  ["where", where],
] as const) {
  // Written as escapes, not literals: the pre push style gate cannot tell a line
  // BANNING the character from a line using it, and it is right not to try.
  assert(!/[\u2014\u2013]/.test(text), `${name} carries no dash punctuation`);
  assert(!/undefined|null|NaN/.test(text), `${name} leaks no placeholder`);
}

finish();
