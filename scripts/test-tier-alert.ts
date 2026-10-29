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

// --- a sideways overflow, same debt tier: never paged (#2228) ---
//
// This used to return `tier_fallback_overflow:<code>` per booking. Measured on
// 2026-09-10 and again on 2026-09-13, a Beyond bucket's pool is at most two
// people against 88 for Achieve, so once traffic starts the overflow is what
// happens to a Beyond lead most of the time. Dan, 2026-09-13: "we're moving off
// beyond entirely. So we really shouldn't be getting many beyond bookngs". The
// overflow is therefore expected behaviour rather than an incident, and a page
// per booking reporting the system working as designed is the alert nobody reads
// by the second week (L36). It became a once a day info count
// (`beyond_overflow_rate`), which Dan removed on 2026-10-02.
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

// --- a top tier lead's cascade: never paged (#2843) ---
//
// Sales ops decided on 2026-09-28 (Slack #C091G6LEQ80, p1790609176877419) that an
// Ultra High or Very High lead SHOULD be cascaded rather than booked days out, as
// far as Medium. There are six Ultra advisors, so with a three day window that is
// ordinary routing, and a page per booking reporting it would be the alert nobody
// reads by the second week (L36). Only a placement OUTSIDE the rule pages, from the
// monitor lane (`top_tier_forbidden_placement`, src/lib/monitor/top-tier-placement.ts).
for (const code of ["511", "522", "531", "412", "421", "430"]) {
  for (const rung of tierLadder(code).slice(1)) {
    if (rung[0] === code[0]) continue;
    assert(
      tierFallbackAlert({ requestedCode: code, effectiveCode: rung }) === null,
      `a top tier cascade sends nothing per booking: ${code} to ${rung}`,
    );
  }
}

// --- one debt tier down: counted on the admin page, never sent ---
//
// Sales ops decided on 2026-10-02 (Slack, Sam: "For an edge case I'll always
// choose less friction because the variance of enrollment rate is not crazy
// different across debt tiers unless you get to low") that a lead who loses
// their tier's last opening keeps the time they picked and drops one tier. That
// is the ladder working as designed, so a Slack line per booking reporting it is
// the alert nobody reads (L36). It is counted on /admin/routing instead. The
// notice's old wording was also false for the commonest case: it said the tier
// "had no availability across the booking window" when the tier had times on
// show and lost the last one at confirm.
assert(
  tierFallbackAlert({ requestedCode: "311", effectiveCode: "211" }) === null,
  "a single tier drop sends nothing",
);
// The case the old threshold got wrong: an overflow AND one tier drop is two
// rungs and still one tier, so it is quiet too rather than escalating.
assert(
  tierFallbackAlert({ requestedCode: "322", effectiveCode: "232" }) === null,
  "an overflow plus one tier drop is still one tier, and sends nothing",
);

// --- two or more debt tiers down: the capacity problem ---
const deep = tierFallbackAlert({ requestedCode: "311", effectiveCode: "111" })!;
assert(deep.key === "tier_fallback_deep:311", "deep-drop key is distinct");
assert(deep.cooldownMs === 5 * 60 * 1000, "deep drop escalates (shorter cooldown)");
assert(/^Routing alert:/.test(deep.text), "deep-drop text reads as an alert, not a notice");
assert(/2 debt tiers/.test(deep.text), `the deep drop counts TIERS, not rungs (got ${deep.text})`);
// #3338: a drop can now also be made at confirm, by a lead who lost the insert race
// on a tier above or waited behind other leads confirming the same time, so the
// tiers above may well have had times across the window. The page says only what
// the walk measured, the time it was asked for, which is true either way (L11, L680).
assert(!/across the booking window/.test(deep.text), `the deep drop does not claim the whole window was empty (got ${deep.text})`);
assert(/could take that time when the lead confirmed/.test(deep.text), `it says no tier above could take that time at confirm (got ${deep.text})`);
assert(/same time/.test(deep.text), `and names leads confirming the same time among the causes to check (got ${deep.text})`);

// Four rungs of the new Beyond ladder is two tiers, and must read as two.
const deepBeyond = tierFallbackAlert({ requestedCode: "322", effectiveCode: "132" })!;
assert(deepBeyond.key === "tier_fallback_deep:322", "a deep Beyond cascade escalates");
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

// Every pair the ladder CAN produce is classified by how many debt tiers it
// moved: zero (the overflow rung) and one are quiet, two or more alert. Driven
// off the real ladder so neither silencing can creep into the deep drops (L1).
{
  let alerted = 0;
  let silenced = 0;
  for (const code of ["322", "311", "312", "300", "222", "231"]) {
    for (const rung of tierLadder(code).slice(1)) {
      const tiers = Number(code[0]) - Number(rung[0]);
      const out = tierFallbackAlert({ requestedCode: code, effectiveCode: rung });
      if (tiers < 2) {
        assert(out === null, `${code} to ${rung} moved ${tiers} tier(s) and is counted, not sent`);
        silenced += 1;
        continue;
      }
      assert(out !== null && out.key === `tier_fallback_deep:${code}`, `${code} to ${rung} dropped ${tiers} tiers and still alerts`);
      alerted += 1;
    }
  }
  // Anti-vacuity: a loop that classified everything one way would pass both
  // branches above by never entering the other (L98).
  assert(alerted > 3, `the deep drops are really being asserted (${alerted})`);
  assert(silenced > 3, `and so are the quiet rungs (${silenced})`);
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
