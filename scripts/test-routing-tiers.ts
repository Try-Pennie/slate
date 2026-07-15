import { tierLadder, tierKeyOf } from "../src/lib/routing/tiers.ts";
import { assert, finish } from "./lib/harness.ts";

assert(tierLadder("511").join(",") === "511,411,311,211,111", "ultra high cascades to low, same backend/legal");
assert(tierLadder("412").join(",") === "412,312,212,112", "very high cascades down, digits 1+2 preserved");
assert(tierLadder("111").join(",") === "111", "low tier has no lower rung");
assert(tierLadder("bad").join(",") === "bad", "invalid code returns itself only");

assert(tierKeyOf("511") === "ultra_high", "first digit 5 => ultra_high");
assert(tierKeyOf("411") === "very_high", "first digit 4 => very_high");
assert(tierKeyOf("bad") === null, "invalid code => null");

finish();
