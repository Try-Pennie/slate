// What the agent page says about deactivating and reactivating, and how they
// differ from not bookable (#1875, #2123, #2124).
//
// The original defect was a SENTENCE: the panel said deactivating is "Fully
// reversible by reactivating", which is false, and said nothing about the other
// axis. A test that checked the button rendered would have passed straight
// through it, which is why the claims are asserted here.
//
// The behaviour half of the pair lives in `offboarding/service.test.ts` ("leaves
// the bookable flag alone when reactivating"). These two together are what stop
// the copy and the behaviour drifting apart again.
// Run: node --experimental-strip-types scripts/test-account-status-copy.ts
import {
  deactivateExplanation,
  notBookableContrast,
  reactivateExplanation,
} from "../src/lib/offboarding/account-status-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const said = deactivateExplanation();

assert(/left/i.test(said), "says what deactivating means: they have left");
assert(/history is kept/i.test(said), "says the history survives");

// #2124: the bookings are no longer left behind by default, and they are no
// longer swept behind the admin's back either. The press asks. So the sentence
// that said they stay put is gone, and what replaces it says a CHOICE is coming,
// because a panel describing behaviour the product no longer has is worse than
// one saying nothing (the interaction #2123 and #2124 were filed to meet).
assert(
  !/does not move their upcoming bookings|stay with them until somebody moves them/i.test(said),
  "no longer claims the bookings are left where they are",
);
assert(
  /upcoming bookings/i.test(said) && /choose|choice|ask/i.test(said),
  "says the upcoming bookings are a choice made at the press",
);

// #2123: the list of internal systems is gone. Naming four to make one point
// spends the reader's attention on three things they cannot check.
for (const named of [/round robin/i, /calendar sync/i, /every picker/i]) {
  assert(!named.test(said), `does not name the internal system ${named}`);
}
assert(/booking pool/i.test(said), "keeps the one a reader can actually check");

// #2123: reactivating is explained where reactivating is OFFERED, not inside the
// explanation of a different control. The fact itself must not be lost with the
// sentence: it is the one claim on this panel that was previously false, and a
// reader who believes the opposite reactivates a returning agent and wonders why
// they receive nothing.
const back = reactivateExplanation();
assert(
  !/reactivating/i.test(said),
  "the deactivate explanation does not explain the other control",
);
assert(
  /does not make them bookable|not bookable again/i.test(back),
  "and reactivating says what it does NOT restore, where that control is",
);
assert(
  !/fully reversible/i.test(back) && !/fully reversible/i.test(said),
  "neither claims the account change is fully reversible",
);

const other = notBookableContrast();
assert(
  /Not bookable/.test(other) && /Access/.test(other),
  "names the other axis and where its control is, so a reader can choose between them",
);
assert(
  /still works here/i.test(other),
  "says what not bookable means, rather than only naming it",
);

for (const [name, text] of [
  ["explanation", said],
  ["reactivate explanation", back],
  ["contrast", other],
] as const) {
  // Escapes, not literals: the pre push style gate cannot tell a line banning
  // the character from one using it, and it is right not to try.
  assert(!/[\u2014\u2013]/.test(text), `${name} carries no dash punctuation`);
  assert(!/undefined|null|NaN/.test(text), `${name} leaks no placeholder`);
  assert(text.trim().endsWith("."), `${name} is written as sentences`);
}

finish();
