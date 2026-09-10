// What the working hours week says back after a copy (#2106). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-working-hours-copy.ts
//
// WHAT THIS EXISTS TO STOP. "Copy Monday to every working day" copies onto the days
// that are TICKED and skips the ones that are off. An agent whose only ticked day is
// Monday pressed it and nothing changed, with no message either way: the week was
// identical, the save button was unchanged, and nothing said there were no other
// working days to copy to. A control that can only ever do nothing, silently,
// teaches the person that the control is broken rather than that their week has no
// other days in it (L109).
//
// The successful case was as silent, which is why the fix is a sentence rather than
// a disabled control: an agent pressing it with five days ticked had to read the
// rows to see whether anything had happened.
import { copyMondayOutcome } from "@/lib/admin/working-hours-copy";
import { assert, eq, finish } from "./lib/harness.ts";

eq(
  copyMondayOutcome(0),
  "No other days are ticked, so there was nothing to copy Monday to.",
  "the case the issue was opened about answers in its own words, not with a zero",
);

// The singular is its own sentence, because "1 working days" is the shape that
// reads wrongly at exactly the count nobody puts in a fixture.
eq(copyMondayOutcome(1), "Copied Monday to your one other working day.", "one day reads as one day");
eq(copyMondayOutcome(4), "Copied Monday to your other 4 working days.", "and several read as several");

{
  // The full week: Monday plus six. The largest a real answer can be, so it is
  // asserted rather than assumed to follow from the case above.
  eq(copyMondayOutcome(6), "Copied Monday to your other 6 working days.", "a whole week copies to six");
}

{
  // Every outcome says what HAPPENED rather than what the control is (L604), and
  // none of them can render a bare number with no noun beside it.
  for (const n of [0, 1, 2, 6]) {
    const text = copyMondayOutcome(n);
    assert(text.endsWith("."), `n=${n} is a sentence`);
    assert(!/undefined|NaN/.test(text), `n=${n} renders no placeholder`);
    assert(/Monday/.test(text), `n=${n} names what was copied`);
  }
}

finish();
