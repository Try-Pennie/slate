// What the agent page says about deactivating, and how it differs from not
// bookable (#1875).
//
// The defect was a SENTENCE: the panel said deactivating is "Fully reversible by
// reactivating", which is false, and said nothing about the other axis. A test
// that checked the button rendered would have passed straight through it, which
// is why the claims are asserted here.
//
// The behaviour half of the pair lives in `offboarding/service.test.ts` ("leaves
// the bookable flag alone when reactivating"). These two together are what stop
// the copy and the behaviour drifting apart again.
// Run: node --experimental-strip-types scripts/test-account-status-copy.ts
import {
  deactivateExplanation,
  notBookableContrast,
} from "../src/lib/offboarding/account-status-copy.ts";
import { assert, finish } from "./lib/harness.ts";

const said = deactivateExplanation();

// The claim that was false. Asserted as an absence, because it is the one thing
// a reader acted on and got wrong.
assert(
  !/fully reversible/i.test(said),
  "does not claim deactivating is fully reversible",
);
assert(
  /does not make them bookable again|not make them bookable/i.test(said),
  "says what reactivating does NOT restore, which is the reason it is not fully reversible",
);
assert(/left/i.test(said), "says what deactivating means: they have left");
assert(
  /does NOT move their upcoming bookings/i.test(said),
  "says the bookings are not moved, which the panel never said at all",
);
assert(/history is kept/i.test(said), "says the history survives");

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
  ["contrast", other],
] as const) {
  // Escapes, not literals: the pre push style gate cannot tell a line banning
  // the character from one using it, and it is right not to try.
  assert(!/[\u2014\u2013]/.test(text), `${name} carries no dash punctuation`);
  assert(!/undefined|null|NaN/.test(text), `${name} leaks no placeholder`);
  assert(text.trim().endsWith("."), `${name} is written as sentences`);
}

finish();
