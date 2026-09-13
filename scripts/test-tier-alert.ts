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

// --- a sideways overflow, same debt tier: counted, never paged (#2228) ---
//
// This used to return `tier_fallback_overflow:<code>` per booking. Measured on
// 2026-09-10 and again on 2026-09-13, a Beyond bucket's pool is at most two
// people against 88 for Achieve, so once traffic starts the overflow is what
// happens to a Beyond lead most of the time. Dan, 2026-09-13: "we're moving off
// beyond entirely. So we really shouldn't be getting many beyond bookngs". The
// overflow is therefore expected behaviour rather than an incident, and a page
// per booking reporting the system working as designed is the alert nobody reads
// by the second week (L36). It is now a once a day count on the info channel,
// `beyond_overflow_rate`, built in src/lib/monitor/beyond-overflow.ts.
for (const pair of [
  { requestedCode: "522", effectiveCode: "532", why: "Ultra High Beyond overflows to Achieve" },
  { requestedCode: "120", effectiveCode: "130", why: "the Low plus Beyond hole at the bottom" },
  { requestedCode: "321", effectiveCode: "331", why: "a mid tier overflow" },
]) {
  assert(
    tierFallbackAlert(pair) === null,
    `a sideways overflow sends nothing per booking: ${pair.why}`,
  );
}

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

// And every pair the ladder CAN produce that MOVED A DEBT TIER does alert, so the
// guard above cannot quietly silence the real cases (L1), and #2228's silencing of
// the overflow cannot creep outward into the tier drops it was never about.
{
  let alerted = 0;
  let silenced = 0;
  for (const code of ["522", "511", "412", "300"]) {
    for (const rung of tierLadder(code).slice(1)) {
      const sameTier = rung[0] === code[0];
      if (sameTier) {
        assert(
          tierFallbackAlert({ requestedCode: code, effectiveCode: rung }) === null,
          `${code} to ${rung} is the overflow rung and is counted, not sent`,
        );
        silenced += 1;
        continue;
      }
      assert(
        tierFallbackAlert({ requestedCode: code, effectiveCode: rung }) !== null,
        `${code} to ${rung} dropped a debt tier and still alerts`,
      );
      alerted += 1;
    }
  }
  // Anti-vacuity: a loop that classified everything one way would pass both
  // branches above by never entering the other (L98).
  assert(alerted > 10, `the tier drops are really being asserted (${alerted})`);
  assert(silenced > 0, `and so are the overflow rungs (${silenced})`);
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
