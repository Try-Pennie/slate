import { tierFallbackAlert } from "../src/lib/routing/tier-alert.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { assert, finish } from "./lib/harness.ts";

// #1909 changed what a RUNG is. A Beyond code now overflows sideways to Achieve
// in the same debt tier before dropping one, so the first rung below the request
// is no longer a tier drop at all. This alert counted rungs and escalated at two,
// which under the new ladder makes an ordinary overflow plus a single tier drop
// page as a deep cascade on the day it ships.
//
// So it is derived from the two CODES rather than from a count somebody passes
// in: what happened is visible in them, and a count cannot say which kind of
// movement it was (L107).

assert(tierFallbackAlert({ requestedCode: "511", effectiveCode: "511" }) === null, "no movement => no alert");

// --- a sideways overflow, same debt tier ---
const overflow = tierFallbackAlert({ requestedCode: "522", effectiveCode: "532" })!;
assert(overflow.key === "tier_fallback_overflow:522", `overflow has its own key (got ${overflow.key})`);
assert(overflow.cooldownMs === 60 * 60 * 1000, "an overflow is a 60-min throttled notice");
assert(/^Routing notice:/.test(overflow.text), "an overflow reads as a notice, not an alert");
assert(/same debt tier/.test(overflow.text), `the overflow says the tier did not move (got ${overflow.text})`);
assert(!/dropped/.test(overflow.text), `an overflow never says a tier was dropped (got ${overflow.text})`);

// --- one debt tier down ---
const one = tierFallbackAlert({ requestedCode: "511", effectiveCode: "411" })!;
assert(one.key === "tier_fallback:511", "single-tier key");
assert(one.cooldownMs === 60 * 60 * 1000, "a single tier drop is a 60-min throttled notice");
assert(/^Routing notice:/.test(one.text), "single-tier text is a notice, not an alert");

// The case the old threshold got wrong: an overflow AND one tier drop is two
// rungs and one tier, and must stay a notice.
const overflowThenDrop = tierFallbackAlert({ requestedCode: "522", effectiveCode: "432" })!;
assert(
  overflowThenDrop.key === "tier_fallback:522",
  `an overflow plus one tier drop is still one tier (got ${overflowThenDrop.key})`,
);
assert(overflowThenDrop.cooldownMs === 60 * 60 * 1000, "and still a throttled notice");
assert(
  /Achieve/.test(overflowThenDrop.text),
  `it still says the backend changed too (got ${overflowThenDrop.text})`,
);

// --- two or more debt tiers down: the capacity problem ---
const deep = tierFallbackAlert({ requestedCode: "511", effectiveCode: "311" })!;
assert(deep.key === "tier_fallback_deep:511", "deep-drop key is distinct");
assert(deep.cooldownMs === 5 * 60 * 1000, "deep drop escalates (shorter cooldown)");
assert(/^Routing alert:/.test(deep.text), "deep-drop text reads as an alert, not a notice");
assert(/2 debt tiers/.test(deep.text), `the deep drop counts TIERS, not rungs (got ${deep.text})`);

// Four rungs of the new Beyond ladder is two tiers, and must read as two.
const deepBeyond = tierFallbackAlert({ requestedCode: "522", effectiveCode: "332" })!;
assert(deepBeyond.key === "tier_fallback_deep:522", "a deep Beyond cascade escalates");
assert(/2 debt tiers/.test(deepBeyond.text), `and says two, not four (got ${deepBeyond.text})`);

// --- a pair the LADDER cannot produce says nothing ---
//
// The old preview fixtures were "411 -> 410" and "411 -> 400", which change the
// legal digit. No rung of any ladder does that, so they were describing movements
// routing cannot make, and under a code that derives its facts from the two codes
// they would have read as a same tier overflow. A pair off the ladder is a code
// fault, recorded in the routing trace; this notice cannot describe it and does
// not try (L11).
for (const bad of [
  { requestedCode: "411", effectiveCode: "410", why: "the legal digit changed" },
  { requestedCode: "411", effectiveCode: "400", why: "the legal digit changed on a tier drop" },
  { requestedCode: "511", effectiveCode: "421", why: "the legal digit changed the other way" },
  { requestedCode: "512", effectiveCode: "532", why: "a code whose backend does not overflow" },
]) {
  assert(
    tierFallbackAlert({ requestedCode: bad.requestedCode, effectiveCode: bad.effectiveCode }) === null,
    `off the ladder alerts nothing: ${bad.why}`,
  );
}

// And every pair the ladder CAN produce does alert, so the guard above cannot
// quietly silence the real cases (L1).
for (const code of ["522", "511", "412", "300"]) {
  for (const rung of tierLadder(code).slice(1)) {
    assert(
      tierFallbackAlert({ requestedCode: code, effectiveCode: rung }) !== null,
      `${code} -> ${rung} is a real rung and alerts`,
    );
  }
}

// --- a code it cannot read says nothing rather than a wrong number ---
for (const bad of [
  { requestedCode: "nope", effectiveCode: "411" },
  { requestedCode: "511", effectiveCode: "nope" },
]) {
  assert(tierFallbackAlert(bad) === null, `an unreadable code alerts nothing (${JSON.stringify(bad)})`);
}

// A movement UPWARD is not a fallback and cannot be described as one.
assert(tierFallbackAlert({ requestedCode: "111", effectiveCode: "511" }) === null, "an upward move alerts nothing");

finish();
