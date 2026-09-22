/**
 * What the manage page SAYS about the number and about booking again (#2615, #2616).
 *
 * #2616: the stored number is `+1XXXXXXXXXX` on essentially every booking, and
 * the sentences that name it are read by a person. The formatting lives INSIDE
 * the builders, so this asserts it there: a caller handing over the raw stored
 * value must still get a readable sentence.
 *
 * #2615: "team" is Slate's word for a routing pool and no lead has ever been
 * shown one, so the copy after a booking ends must not promise the same one.
 *
 * Run: node --experimental-strip-types scripts/test-manage-copy-display.ts
 */
import { advisorWillCall, phoneSaved, DONE_COPY } from "../src/lib/booking/manage-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

eq(
  advisorWillCall("+16317937858"),
  "Your advisor will call you at (631) 793-7858.",
  "the stored form is formatted inside the builder",
);
eq(
  advisorWillCall(null),
  "Your advisor will call you at the number you gave us.",
  "no number keeps its fallback phrase",
);
eq(
  advisorWillCall("   "),
  "Your advisor will call you at the number you gave us.",
  "a blank number takes the fallback rather than leaving a gap",
);
eq(
  phoneSaved("+12155559999"),
  "Saved. Your advisor will call you at (215) 555-9999.",
  "the save confirmation formats the stored number too",
);
eq(
  advisorWillCall("+44 20 7946 0958"),
  "Your advisor will call you at +44 20 7946 0958.",
  "a number the formatter cannot read as US is shown as stored, not truncated",
);

for (const [key, text] of Object.entries(DONE_COPY)) {
  assert(!/\bteam\b/i.test(text), `DONE_COPY.${key} does not name a team a lead never saw`);
}
eq(
  DONE_COPY.cancelledBody,
  "Changed your mind? You can grab a new time whenever you are ready.",
  "the cancelled body reads without the team",
);
eq(
  DONE_COPY.happenedBody,
  "Need to talk again? You can book another time whenever you are ready.",
  "and so does its sibling for a call that happened",
);

finish();
