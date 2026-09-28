import {
  cascadeFloorTier,
  rungExcludesLow,
  tierLadder,
  tierKeyOf,
  tierPoolCode,
  wholeTierPoolCode,
} from "../src/lib/routing/tiers.ts";
import { assert, finish } from "./lib/harness.ts";

// --- an UNCONSTRAINED code (backend 0 or 1) gains no same tier rung (#2486) ---
//
// It is already the whole debt tier's pool, so there is nothing at its own tier
// to cross to. A rung between 111 and 101 would be worse than useless: the two
// resolve one pool by criteria, so the only thing it could add is somebody hand
// named on the other bucket, and reading that as coverage is the fail open
// #2485 refused to ship and #2253 was opened about.
assert(tierLadder("511").join(",") === "511,411,311,211", "ultra high cascades to Medium and stops (#2842)");
assert(tierLadder("412").join(",") === "412,312,212", "very high cascades to Medium and stops, digits 1+2 preserved");
assert(tierLadder("312").join(",") === "312,212,112", "high may still cascade to Low (#2842)");
assert(tierLadder("111").join(",") === "111", "low tier has no lower rung");
assert(tierLadder("bad").join(",") === "bad", "invalid code returns itself only");
assert(tierLadder("300").join(",") === "300,200,100", "a None backend gains no same tier rung");

// --- an ACHIEVE code crosses to the tier's whole pool before dropping (#2486) ---
//
// Dan, 2026-09-16: "if bucket 511 is empty, let's try all the other 5xx buckets
// first before falling down to 4". The unconstrained rung IS the rest of the
// tier: digits 0 and 1 leave backend_service unset, so T1C selects every agent
// in debt team T whatever backend they carry.
//
// MEASURED CAVEAT, and it is the reason this shipped as a safety net rather than
// as a routing improvement (2026-09-17): all 94 bookable agents carry `achieve`
// and none has an unset backend, so T1C and T3C select the same people and this
// rung changes no routing outcome today. It exists so that the debt tier alarm
// (#2505), which mutes a bucket level finding whenever the tier is staffed,
// cannot go quiet on a lead who is in fact refused if those tags ever diverge.
assert(
  tierLadder("532").join(",") === "532,512,432,412,332,312,232,212",
  `an Achieve code crosses to the tier pool first (got ${tierLadder("532").join(",")})`,
);
assert(
  tierLadder("130").join(",") === "130,110",
  `the bottom Achieve rung still reaches its tier pool (got ${tierLadder("130").join(",")})`,
);

// ALL FIFTEEN Achieve codes, rung by rung rather than by a rule restated here: a
// test that re-derives the ladder from the same idea the code uses can only prove
// the two agree with each other (L107).
const ACHIEVE_LADDERS: Record<string, string> = {
  "130": "130,110",
  "131": "131,111",
  "132": "132,112",
  "230": "230,210,130,110",
  "231": "231,211,131,111",
  "232": "232,212,132,112",
  "330": "330,310,230,210,130,110",
  "331": "331,311,231,211,131,111",
  "332": "332,312,232,212,132,112",
  "430": "430,410,330,310,230,210",
  "431": "431,411,331,311,231,211",
  "432": "432,412,332,312,232,212",
  "530": "530,510,430,410,330,310,230,210",
  "531": "531,511,431,411,331,311,231,211",
  "532": "532,512,432,412,332,312,232,212",
};
assert(Object.keys(ACHIEVE_LADDERS).length === 15, "every Achieve code is covered");
for (const [code, want] of Object.entries(ACHIEVE_LADDERS)) {
  assert(tierLadder(code).join(",") === want, `${code} ladder (got ${tierLadder(code).join(",")})`);
}

// --- a BEYOND code: Achieve in the same tier, then the tier's whole pool ---
//
// Dan, 2026-09-04: when a Beyond bucket has nobody available, overflow to Achieve
// in the SAME debt tier, and only if that is also empty drop a tier and repeat.
// #2486 adds the third same tier rung after it, so the walk exhausts the debt
// tier before it takes the lead's advertised tier away from them.
assert(
  tierLadder("522").join(",") ===
    "522,532,512,422,432,412,322,332,312,222,232,212",
  `a Beyond code tries Achieve then the whole tier (got ${tierLadder("522").join(",")})`,
);
assert(
  tierLadder("122").join(",") === "122,132,112",
  `the bottom Beyond rung reaches its tier pool (got ${tierLadder("122").join(",")})`,
);

const BEYOND_LADDERS: Record<string, string> = {
  "120": "120,130,110",
  "121": "121,131,111",
  "122": "122,132,112",
  "220": "220,230,210,120,130,110",
  "221": "221,231,211,121,131,111",
  "222": "222,232,212,122,132,112",
  "320": "320,330,310,220,230,210,120,130,110",
  "321": "321,331,311,221,231,211,121,131,111",
  "322": "322,332,312,222,232,212,122,132,112",
  "420": "420,430,410,320,330,310,220,230,210",
  "421": "421,431,411,321,331,311,221,231,211",
  "422": "422,432,412,322,332,312,222,232,212",
  "520": "520,530,510,420,430,410,320,330,310,220,230,210",
  "521": "521,531,511,421,431,411,321,331,311,221,231,211",
  "522": "522,532,512,422,432,412,322,332,312,222,232,212",
};
assert(Object.keys(BEYOND_LADDERS).length === 15, "every Beyond code is covered");
for (const [code, want] of Object.entries(BEYOND_LADDERS)) {
  assert(tierLadder(code).join(",") === want, `${code} ladder (got ${tierLadder(code).join(",")})`);
}

// --- invariants that must hold for EVERY one of the sixty codes ---
//
// Enumerated from the code space rather than from a hand list, so a rule that
// breaks one family cannot pass by being absent from a fixture (L96).
const ALL_CODES: string[] = [];
for (const t of "12345") for (const b of "0123") for (const l of "012") ALL_CODES.push(`${t}${b}${l}`);
assert(ALL_CODES.length === 60, "the code space is sixty codes");

for (const code of ALL_CODES) {
  const ladder = tierLadder(code);
  assert(ladder[0] === code, `${code} asks for what was requested first`);
  assert(new Set(ladder).size === ladder.length, `${code} has no repeated rung`);
  assert(ladder.every((r) => /^[1-5][0-3][0-2]$/.test(r)), `${code} rungs are all valid codes`);
  // The legal digit is carried unchanged onto every rung, including the two
  // same tier ones: crossing changes WHO can serve the lead, never what they
  // asked for.
  assert(ladder.every((r) => r[2] === code[2]), `every rung of ${code} keeps the legal digit`);
  // The tier digit never rises, and it only ever falls by one, so the walk can
  // never skip a debt tier or offer a lead a HIGHER tier than they asked for.
  for (let i = 1; i < ladder.length; i++) {
    const drop = Number(ladder[i - 1][0]) - Number(ladder[i][0]);
    assert(drop === 0 || drop === 1, `${code} moves one tier at a time (rung ${i})`);
  }
  // Every same tier rung comes before the first rung of the tier below it: the
  // whole point of #2486 is that a tier is exhausted before it is dropped.
  const firstDrop = ladder.findIndex((r) => r[0] !== code[0]);
  const sameTier = firstDrop === -1 ? ladder : ladder.slice(0, firstDrop);
  assert(
    sameTier.every((r) => r[0] === code[0]),
    `${code} finishes its own tier before dropping one`,
  );
  // An unconstrained code is already the whole tier, so it has exactly one rung
  // at its own tier. A specific backend has more than one.
  const unconstrained = code[1] === "0" || code[1] === "1";
  assert(
    unconstrained ? sameTier.length === 1 : sameTier.length > 1,
    `${code} same tier rungs match its backend (${sameTier.join(",")})`,
  );
  // The LAST rung of each tier is that tier's whole pool for a specific backend,
  // so the walk never drops a tier while somebody in it has not been asked.
  if (!unconstrained) {
    assert(
      sameTier[sameTier.length - 1] === `${code[0]}1${code[2]}`,
      `${code} ends its tier on the tier's whole pool`,
    );
  }
}

// --- the shared vocabulary the alarm and the ladder both use (#2505) ---
//
// `legal` is REQUIRED rather than defaulted (L168): the ladder's contract is that
// the legal digit is carried unchanged onto every rung, and a caller that forgot
// it would silently produce a rung naming a different bucket. The alarm asks a
// DIFFERENT question, where the legal digit is irrelevant, so it gets its own
// name rather than a default on this one (L342).
assert(tierPoolCode("5", "2") === "512", "the tier pool code keeps the legal digit it is given");
assert(tierPoolCode("1", "0") === "110", "the tier pool code is the Both backend");
assert(wholeTierPoolCode("5") === "511", "the whole tier pool code is the canonical spelling");
assert(wholeTierPoolCode("1") === "111", "the whole tier pool code works at the bottom tier");
// The ladder's last same tier rung IS that function's answer, so the alarm and
// the router cannot drift on what "the whole tier" means (L107).
for (const code of ALL_CODES) {
  if (code[1] === "0" || code[1] === "1") continue;
  const ladder = tierLadder(code);
  const firstDrop = ladder.findIndex((r) => r[0] !== code[0]);
  const sameTier = firstDrop === -1 ? ladder : ladder.slice(0, firstDrop);
  assert(
    sameTier[sameTier.length - 1] === tierPoolCode(code[0], code[2]),
    `${code} ends its tier on tierPoolCode`,
  );
}


// --- the cascade floor and the Low exclusion (#2842) ---
//
// Sales ops, 2026-09-28 (Slack #C091G6LEQ80, p1790609176877419). Sam: "Only thing
// you want to avoid is giving a ultra as an example to someone who is on low. So
// only cascade down to a medium", "as long as the person who is on Medium isn't
// also on Low", and, asked the highest tier that may reach Low: "A high".
assert(cascadeFloorTier(5) === 2 && cascadeFloorTier(4) === 2, "Ultra and Very High stop at Medium");
assert(
  cascadeFloorTier(3) === 1 && cascadeFloorTier(2) === 1 && cascadeFloorTier(1) === 1,
  "High and below may reach Low",
);
for (const code of ALL_CODES) {
  const ladder = tierLadder(code);
  const floor = cascadeFloorTier(Number(code[0]));
  assert(
    ladder.every((r) => Number(r[0]) >= floor),
    `${code} never drops below its floor (${ladder.join(",")})`,
  );
  // The floor is reached, not merely respected: a ladder that stopped a tier
  // early would pass the check above.
  assert(Number(ladder[ladder.length - 1][0]) === floor, `${code} reaches its floor`);
  for (const rung of ladder) {
    const below = Number(rung[0]) < Number(code[0]);
    const topTier = Number(code[0]) >= 4;
    assert(
      rungExcludesLow(code, rung) === (topTier && below),
      `${code} -> ${rung} excludes Low exactly when a top tier lead is below its own tier`,
    );
  }
}
// The lead's OWN tier never excludes: an Ultra advisor who also carries Low is
// still the Ultra lead's own advisor. Only the cascade is restricted.
assert(!rungExcludesLow("531", "511"), "a same tier rung keeps its whole pool");
assert(rungExcludesLow("531", "431"), "the first rung below an Ultra lead excludes Low");
assert(!rungExcludesLow("331", "131"), "a High lead's cascade keeps Low agents");
assert(!rungExcludesLow("bad", "111"), "an unreadable code excludes nothing it cannot judge");

assert(tierKeyOf("511") === "ultra_high", "first digit 5 => ultra_high");
assert(tierKeyOf("411") === "very_high", "first digit 4 => very_high");
assert(tierKeyOf("bad") === null, "invalid code => null");

finish();
