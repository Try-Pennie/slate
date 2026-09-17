// A lead is never sent looking for something Pennie does not send (#2364).
//
// The not found screen told a lead to "open the most recent confirmation email
// from Pennie and follow the manage link there". There is no such email. #64
// settled the confirmation as Google's native calendar invitation, sent from the
// ADVISOR's calendar, and Slate sends nothing else. The recovery itself is real
// (PR #71 put "Reschedule or cancel: <link>" in the event description), so the
// sentence was pointing at the right link by the wrong name, which is the kind of
// instruction that sends somebody hunting for a thing that is not there (L111).
//
// Three sentences said it, not one, so this guards the CLASS rather than the
// instance (L30): the not found screen, the refusal on the phone correction path,
// and the duplicate notice's withheld case. Each one names the calendar invitation
// now.
//
// It is a phrase ban, and that is deliberate. #64 is a recorded decision that can
// be reversed, and #2359 may add a 24 hour reminder email from the advisor. Either
// one makes this guard fail, which is the point: the sentence a lead reads must be
// re-read when the thing it names changes, rather than staying correct once and
// going stale.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lead-copy-names-what-exists.ts
import { bookerCopyScreens } from "../src/lib/booking/copy-preview.ts";
import { NOT_FOUND_COPY, MANAGE_PHONE_NOT_FOUND } from "../src/lib/booking/manage-copy.ts";
import { DUPLICATE_COPY } from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/**
 * What Pennie does not send. Matched case insensitively over every previewed
 * line, since the preview is the enumeration of what a lead can read and is
 * derived from the builders rather than maintained beside them (L41, L96).
 */
const PHANTOM = /confirmation email|email from pennie|email we sent/i;

const screens = bookerCopyScreens();

// Anti-vacuity: a broken import would make every assertion below pass over an
// empty list, which is the exact shape these guards exist to refuse (L98).
assert(screens.length >= 10, `the preview enumerates the lead-facing screens (got ${screens.length})`);
const lines = screens.flatMap((s) => s.lines.map((l) => ({ ...l, screen: s.screen })));
assert(lines.length >= 50, `and their states (got ${lines.length})`);

for (const line of lines) {
  assert(
    !PHANTOM.test(line.text),
    `${line.screen} / ${line.state} names no email Pennie sends (got: ${line.text})`,
  );
}

// The positive control. Without it a typo in the pattern, or a preview that
// stopped enumerating, would report the tree clean for ever (L1).
assert(
  PHANTOM.test("Check the confirmation email we sent you if you need to view or change it."),
  "the sentence this guard was written about IS caught",
);
assert(
  !PHANTOM.test("Look for the calendar invitation your advisor sent for this call."),
  "while the sentence that replaced it is not",
);

// --- and each of the three says what to open instead ---------------------------
// A phrase ban alone would be satisfied by deleting the instruction, which would
// leave a lead with a dead link and no way back (L283).
for (const [where, text] of [
  ["the not found screen", NOT_FOUND_COPY.recovery],
  ["the refused phone correction", MANAGE_PHONE_NOT_FOUND],
  ["the withheld duplicate notice", DUPLICATE_COPY.checkYourEmail],
] as const) {
  assert(/calendar invitation/i.test(text), `${where} names the calendar invitation (got: ${text})`);
}

// The not found screen keeps its three jobs: name what happened, say why it may
// have happened, and say what to do. A heading on its own is the dead end #634
// was opened about.
eq(
  [NOT_FOUND_COPY.heading, NOT_FOUND_COPY.causes, NOT_FOUND_COPY.recovery].filter(
    (s) => s.trim().length > 0,
  ).length,
  3,
  "the not found screen still says what happened, why, and what to do",
);

finish();
