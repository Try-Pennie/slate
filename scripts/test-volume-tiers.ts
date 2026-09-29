// The debt tiers the low volume floors are scoped to (#2874). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-volume-tiers.ts
//
// What this pins:
// - the tier list is the routing vocabulary's, and a booking's tier is its bucket
//   code's first digit, with the test buckets belonging to no tier;
// - Low's anchor is the committed measurement, and that measurement really counted
//   the Low tier, so the anchor is filed under the tier it describes (L70); that Low
//   is the ONLY anchor, and the other tiers' saved measurements, are held by
//   test-volume-tier-anchors.ts;
// - a tier's ramp start is its first real booking, and a declared ramp end can only
//   move it later;
// - each tier has its own alert key, Low keeping the one it has always paged on.
import { readFileSync } from "node:fs";
import {
  LOW_TIER,
  TIER_ANCHORS,
  TIER_VOLUME_ALERT_PREFIX,
  VOLUME_TIERS,
  isVolumeTier,
  tierCodePattern,
  tierLabel,
  tierOfBucketCode,
  tierRampStartMs,
  tierVolumeAlertKey,
  tierCountUnreadableKey,
} from "../src/lib/monitor/volume-tiers.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { DEBT_TIER } from "../src/lib/xbc.ts";
import { VOLUME_ALERT_KEY, VOLUME_COUNT_UNREADABLE_KEY } from "../src/lib/monitor/booking-volume.ts";
import { FLOOR_SCOPE, type VolumeFixture } from "./lib/volume-floor-scope.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the vocabulary ---
eq([...VOLUME_TIERS], ["1", "2", "3", "4", "5"], "the tiers are the five debt tiers");
eq([...VOLUME_TIERS], Object.keys(DEBT_TIER).sort(), "exactly the routing vocabulary's, so the typed list cannot drift from it");
eq(tierLabel("1"), "Low", "tier 1 is Low");
eq(tierLabel("5"), "Ultra High", "tier 5 is Ultra High");
let threw = false;
try {
  tierLabel("9");
} catch {
  threw = true;
}
assert(threw, "a digit that is not a tier is refused, never labelled");

// --- a booking's tier is its bucket's ---
eq(tierOfBucketCode("111"), "1", "a Low code is tier 1");
eq(tierOfBucketCode("532"), "5", "an Ultra High code is tier 5");
eq(tierOfBucketCode(" 411 "), "4", "surrounding space is ignored");
for (const code of ["SMOKE", "611", "141", "113", "", null, undefined]) {
  eq(tierOfBucketCode(code), null, `${JSON.stringify(code)} belongs to no tier`);
}
eq(tierCodePattern("3"), "3%", "a tier's bucket codes are selected by their first digit");
threw = false;
try {
  tierCodePattern("1%");
} catch {
  threw = true;
}
assert(threw, "a pattern is refused for anything that is not a tier, so a typo cannot match nothing");

// --- the anchors ---
// That Low is the only anchor, and that the tiers beside it have saved measurements
// that are not in force until #2893, is pinned by scripts/test-volume-tier-anchors.ts.
assert(TIER_ANCHORS[LOW_TIER] === MEASURED_VOLUME_BASELINE, "Low's anchor is the committed measurement");
const fixture = JSON.parse(readFileSync("scripts/fixtures/calcom-low-bookings.json", "utf8")) as VolumeFixture;
eq(fixture.tier, LOW_TIER, "and the committed measurement counted exactly that tier");
eq(FLOOR_SCOPE.tier, LOW_TIER, "which is the tier the measurement script is scoped to");
for (const tier of Object.keys(TIER_ANCHORS)) {
  assert(isVolumeTier(tier), `every anchor is filed under a real tier (${tier})`);
}

// --- the ramp start ---
const FIRST = Date.parse("2026-10-05T14:00:00Z");
eq(tierRampStartMs(null, null), null, "a tier with no booking is not carried, so it has no ramp start");
eq(tierRampStartMs(null, FIRST), null, "and a declared ramp end does not carry a tier nobody has booked");
eq(tierRampStartMs(FIRST, null), FIRST, "a tier's first real booking is its ramp start");
eq(tierRampStartMs(FIRST, FIRST + 86_400_000), FIRST + 86_400_000, "a later declared ramp end moves it later");
eq(tierRampStartMs(FIRST, FIRST - 86_400_000), FIRST, "an earlier one cannot start learning before the tier's own traffic");

// --- one alert key per tier ---
eq(tierVolumeAlertKey(LOW_TIER), VOLUME_ALERT_KEY, "Low keeps the key it has always paged on");
const keys = VOLUME_TIERS.map(tierVolumeAlertKey);
eq(new Set(keys).size, keys.length, "every tier has its own key, so one tier's cooldown never silences another's");
for (const tier of VOLUME_TIERS.filter((t) => t !== LOW_TIER)) {
  eq(tierVolumeAlertKey(tier), `${TIER_VOLUME_ALERT_PREFIX}:${tier}`, `tier ${tier} pages in the tier family`);
}

// --- one count unreadable key per tier (#2874) ---
eq(tierCountUnreadableKey(LOW_TIER), VOLUME_COUNT_UNREADABLE_KEY, "Low keeps the unreadable key it has always paged on");
const unreadKeys = VOLUME_TIERS.map(tierCountUnreadableKey);
eq(new Set(unreadKeys).size, unreadKeys.length, "every tier has its own, so one tier's readable count never clears another's page");

finish();
