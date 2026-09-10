// What the business hours page SAYS a save did (#2219).
//
// Saving a CLOSED date confirmed with "Saved. Leads see that date straight
// away." A closed date is precisely the one leads do not see: the whole point of
// the row is that it is removed from what is offered, so the sentence asserted
// the opposite of what had just happened, and it was the common case (the
// component's own default is closed, because a holiday is the usual reason to
// add a date).
//
// One sentence was written for both outcomes and then rendered over both, which
// is the shape of the defect rather than a wording slip: an action has to say
// what it DID, and two outcomes cannot share one claim (L11, L608).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-business-hours-copy.ts
import {
  HOURS_SAVED_MESSAGE,
  exceptionSavedMessage,
} from "../src/lib/booking/business-hours-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const closed = exceptionSavedMessage({ onDate: "2027-01-01", isOpen: false });
const open = exceptionSavedMessage({ onDate: "2027-01-01", isOpen: true });

// --- the two outcomes are two sentences ---
assert(closed !== open, "a closed save and an open save do not share one sentence");

// --- each names the date it is about, so the notice cannot be read as a claim
//     about the whole week it sits under (L287) ---
assert(closed.includes("Friday, January 1, 2027"), `closed names the date (got ${closed})`);
assert(open.includes("Friday, January 1, 2027"), `open names the date (got ${open})`);

// --- and each says which of the two states was written ---
assert(/\bclosed\b/.test(closed), `closed says Pennie is closed (got ${closed})`);
assert(/\bopen\b/.test(open), `open says Pennie is open (got ${open})`);

// It stops there. What a closed date DOES is already on the card above the form
// ("A closed date is offered to nobody, and the booker tells a lead we are closed
// and when we are back"), so a notice explaining it again would state one fact
// twice on one screen (L605). These pin that it does not, since the obvious fix
// for the wrong sentence was a longer right one.
for (const [what, text] of [["closed", closed], ["open", open]] as const) {
  assert(!/offered/.test(text), `${what} does not re-explain what the card already says`);
  assert(text.length < 60, `${what} stays a confirmation, not a paragraph (got ${text.length})`);
}

// The claim that was wrong. Asserted as the CLAIM rather than as a banned word,
// because a sentence can make it without using either of these (L347): these two
// only pin the exact wording that shipped, and the assertions above are what
// actually say the sentence is right.
for (const [what, text] of [["closed", closed], ["open", open]] as const) {
  assert(!/Leads see that date/.test(text), `${what} does not claim leads see the date`);
}

// --- a date the formatter cannot read shows as itself, never as a blank ---
{
  const broken = exceptionSavedMessage({ onDate: "not-a-date", isOpen: false });
  assert(
    broken.includes("not-a-date"),
    `an unreadable date is shown as stored rather than dropped (got ${broken})`,
  );
}

// --- the WEEKLY save, the sibling sentence on the same page ---
//
// "Saved. Leads see the new hours straight away." had the same shape one rung
// down: a lead never sees the hours, and when a week NARROWS what changes is that
// they are offered fewer times, so the sentence described the opposite of the
// commonest edit too.
assert(
  /offered/.test(HOURS_SAVED_MESSAGE),
  `the weekly save says what leads are offered (got ${HOURS_SAVED_MESSAGE})`,
);
assert(
  !/Leads see the new hours/.test(HOURS_SAVED_MESSAGE),
  "the weekly save does not claim leads see the hours",
);
// Its card already says "A change applies to everyone straight away", so the
// notice does not say it a second time either.
assert(
  !/straight away/.test(HOURS_SAVED_MESSAGE),
  `the weekly save leaves immediacy to the card that states it (got ${HOURS_SAVED_MESSAGE})`,
);

finish();
