import { tierLadder, tierKeyOf } from "../src/lib/routing/tiers.ts";
import { assert, finish } from "./lib/harness.ts";

// --- codes whose backend is None, Both or Achieve: unchanged (#1909) ---
assert(tierLadder("511").join(",") === "511,411,311,211,111", "ultra high cascades to low, same backend/legal");
assert(tierLadder("412").join(",") === "412,312,212,112", "very high cascades down, digits 1+2 preserved");
assert(tierLadder("111").join(",") === "111", "low tier has no lower rung");
assert(tierLadder("bad").join(",") === "bad", "invalid code returns itself only");
assert(tierLadder("300").join(",") === "300,200,100", "a None backend keeps the plain ladder");
assert(tierLadder("532").join(",") === "532,432,332,232,132", "an Achieve code keeps the plain ladder");

// --- a BEYOND code overflows to Achieve in the same tier first, then cascades ---
//
// Dan, 2026-09-04: when a Beyond bucket has nobody available, overflow to Achieve
// in the SAME debt tier, and only if that is also empty drop a tier and repeat.
// Today's ladder holds the backend digit fixed, so every rung of a Beyond code
// demands a Beyond agent: with one bookable Beyond agent it walks five rungs to
// the same person and ends on a bucket with nobody in it.
assert(
  tierLadder("522").join(",") === "522,532,422,432,322,332,222,232,122,132",
  `a Beyond code interleaves the same tier Achieve rung (got ${tierLadder("522").join(",")})`,
);
assert(
  tierLadder("122").join(",") === "122,132",
  `the bottom Beyond rung still reaches Achieve (got ${tierLadder("122").join(",")})`,
);

// ALL FIFTEEN Beyond codes, each asserted rung by rung rather than by a rule
// restated here: a test that re-derives the ladder from the same idea the code
// uses can only prove the two agree with each other (L107).
const BEYOND_LADDERS: Record<string, string> = {
  "120": "120,130",
  "121": "121,131",
  "122": "122,132",
  "220": "220,230,120,130",
  "221": "221,231,121,131",
  "222": "222,232,122,132",
  "320": "320,330,220,230,120,130",
  "321": "321,331,221,231,121,131",
  "322": "322,332,222,232,122,132",
  "420": "420,430,320,330,220,230,120,130",
  "421": "421,431,321,331,221,231,121,131",
  "422": "422,432,322,332,222,232,122,132",
  "520": "520,530,420,430,320,330,220,230,120,130",
  "521": "521,531,421,431,321,331,221,231,121,131",
  "522": "522,532,422,432,322,332,222,232,122,132",
};
assert(Object.keys(BEYOND_LADDERS).length === 15, "every Beyond code is covered");
for (const [code, want] of Object.entries(BEYOND_LADDERS)) {
  assert(tierLadder(code).join(",") === want, `${code} ladder (got ${tierLadder(code).join(",")})`);
  // The legal digit is carried unchanged onto every rung, including the overflow
  // one: overflow changes WHO can serve the lead, never what they asked for.
  assert(
    tierLadder(code).every((rung) => rung[2] === code[2]),
    `every rung of ${code} keeps the legal digit`,
  );
}

// Each rung is a real XBC code and no rung repeats, so the walk can never try the
// same bucket twice or ask for one that cannot exist.
for (const code of ["522", "422", "322", "222", "122"]) {
  const ladder = tierLadder(code);
  assert(new Set(ladder).size === ladder.length, `${code} has no repeated rung`);
  assert(ladder.every((r) => /^[1-5][0-3][0-2]$/.test(r)), `${code} rungs are all valid codes`);
  assert(ladder[0] === code, `${code} asks for what was requested first`);
}

assert(tierKeyOf("511") === "ultra_high", "first digit 5 => ultra_high");
assert(tierKeyOf("411") === "very_high", "first digit 4 => very_high");
assert(tierKeyOf("bad") === null, "invalid code => null");

finish();
