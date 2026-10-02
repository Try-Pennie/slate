// #2843: the Ultra High and Very High cascade, counted once a day instead of paged
// once a booking. Sales ops decided on 2026-09-28 that these leads SHOULD cascade
// (as far as Medium, never to a Low carrier, #2842), so a lead taken by a lower
// tier is the rule working, and the number is published rather than judged.
import {
  CASCADE_CODES_BELOW,
  TOP_TIER_CASCADE_COOLDOWN_MS,
  TOP_TIER_CASCADE_WINDOW_HOURS,
  TOP_TIER_CODES,
  topTierCascadeNoticeText,
  topTierCascadeVerdict,
  type TopTierCascadeWindow,
} from "../src/lib/monitor/top-tier-cascade.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the code lists are derived, and cover exactly what the ladder can produce ---
eq(Object.keys(TOP_TIER_CODES).sort(), ["ultra_high", "very_high"], "two top tiers");
assert(TOP_TIER_CODES.ultra_high.length === 12 && TOP_TIER_CODES.very_high.length === 12, "twelve codes each");
assert(TOP_TIER_CODES.ultra_high.every((c) => c[0] === "5"), "Ultra codes start with 5");
assert(TOP_TIER_CODES.very_high.every((c) => c[0] === "4"), "Very High codes start with 4");
// Every rung the ladder can land a top tier lead on BELOW their tier is on the
// booked side, and no rung in their own tier is, so a sideways Beyond overflow is
// never counted as a cascade (#2228).
for (const tier of ["ultra_high", "very_high"] as const) {
  const below = new Set(CASCADE_CODES_BELOW[tier]);
  for (const code of TOP_TIER_CODES[tier]) {
    for (const rung of tierLadder(code)) {
      const cascaded = rung[0] !== code[0];
      assert(below.has(rung) === cascaded, `${code} -> ${rung} is ${cascaded ? "" : "not "}a cascade`);
    }
  }
  // Low IS on the booked side, deliberately: the ladder cannot reach it, so a
  // booking counted there means the floor broke, and a list stopping at Medium
  // would leave exactly that booking uncounted.
  assert([...below].some((c) => c[0] === "1"), `${tier}: a booking that reached Low would still be counted`);
}

// --- the verdict ---
const w = (o: Partial<TopTierCascadeWindow>): TopTierCascadeWindow => ({
  ultraBooked: 0, ultraCascaded: 0, veryHighBooked: 0, veryHighCascaded: 0,
  windowHours: TOP_TIER_CASCADE_WINDOW_HOURS, ...o,
});
eq(topTierCascadeVerdict(w({})).kind, "unmeasured", "no top tier bookings is unmeasured, never quiet (L98)");
eq(topTierCascadeVerdict(w({ ultraBooked: 4 })).kind, "quiet", "bookings and no cascade is quiet");
eq(topTierCascadeVerdict(w({ ultraBooked: 4, ultraCascaded: 1 })).kind, "report", "a cascade is reported");
eq(topTierCascadeVerdict(w({ veryHighBooked: 2, veryHighCascaded: 2 })).kind, "report", "a Very High cascade alone is reported");
eq(
  topTierCascadeVerdict(w({ ultraBooked: 1, ultraCascaded: 2 })).kind,
  "unmeasured",
  "more cascades than bookings is a broken read, not a very high rate",
);
eq(topTierCascadeVerdict(w({ ultraBooked: Number.NaN })).kind, "unmeasured", "an unreadable count is unmeasured");
eq(topTierCascadeVerdict(w({ ultraBooked: 3, ultraCascaded: -1 })).kind, "unmeasured", "a negative count is unmeasured");

// --- the notice ---
{
  const v = topTierCascadeVerdict(w({ ultraBooked: 8, ultraCascaded: 3, veryHighBooked: 1, veryHighCascaded: 1 }));
  assert(v.kind === "report", "fixture reports");
  const text = topTierCascadeNoticeText(v as Extract<typeof v, { kind: "report" }>, 24);
  assert(text.includes("Ultra High: 3 of 8 bookings went to a lower tier"), `plural reads right (got ${text})`);
  assert(text.includes("Very High: 1 of 1 booking went to a lower tier"), `singular reads right (got ${text})`);
  assert(/Medium/.test(text) && /Low/.test(text), "it states the rule it is reporting on");
  assert(/No action is needed/.test(text), "it says no action is being asked for");
  assert(!/^Slate/.test(text), "it does not open with Slate");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
}
{
  // A tier with no bookings is left out rather than printed as "0 of 0".
  const v = topTierCascadeVerdict(w({ veryHighBooked: 5, veryHighCascaded: 2 }));
  const text = topTierCascadeNoticeText(v as Extract<typeof v, { kind: "report" }>, 24);
  assert(!/Ultra High:/.test(text), `a tier nobody booked is not mentioned (got ${text})`);
  assert(text.includes("Very High: 2 of 5 bookings"), "the tier with bookings is");
}

// Pinned to the window, so two reports never describe the same bookings.
assert(TOP_TIER_CASCADE_COOLDOWN_MS === TOP_TIER_CASCADE_WINDOW_HOURS * 3600_000, "cooldown equals the window");

finish();
