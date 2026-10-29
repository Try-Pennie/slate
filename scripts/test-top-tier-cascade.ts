// #2843: the Ultra High and Very High cascade, counted once a day instead of paged
// once a booking. Sales ops decided on 2026-09-28 that these leads SHOULD cascade
// (as far as Medium, never to a Low carrier, #2842), so a lead taken by a lower
// tier is the rule working, and the number is published rather than judged.
import {
  CASCADE_CODES_BELOW,
  TOP_TIER_CASCADE_COOLDOWN_MS,
  TOP_TIER_CASCADE_NOTICE_KEY,
  TOP_TIER_CASCADE_WINDOW_HOURS,
  TOP_TIER_CODES,
  topTierCascadeNoticeText,
  topTierCascadeVerdict,
  type TopTierCascadeWindow,
} from "../src/lib/monitor/top-tier-cascade.ts";
import { withSeverityLead } from "../src/lib/notify/severity-lead.ts";
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

// The night of 2026-10-28 (#2843 reworded): Ultra High 31 booked and none cascaded,
// Very High 28 booked and one cascaded. That is a report, because one lead left
// their tier, and the same day with no cascade at all would have said nothing.
const oct28 = w({ ultraBooked: 31, ultraCascaded: 0, veryHighBooked: 28, veryHighCascaded: 1 });
eq(topTierCascadeVerdict(oct28).kind, "report", "one cascade across both tiers is reported");
eq(
  topTierCascadeVerdict({ ...oct28, veryHighCascaded: 0 }).kind,
  "quiet",
  "the same day with no cascade stays quiet",
);
eq(
  topTierCascadeVerdict({ ...oct28, veryHighBooked: Number.POSITIVE_INFINITY }).kind,
  "unmeasured",
  "the same day with one count unreadable posts nothing",
);

// --- the notice ---
const reportText = (win: TopTierCascadeWindow): string => {
  const v = topTierCascadeVerdict(win);
  assert(v.kind === "report", `fixture reports (got ${v.kind})`);
  return topTierCascadeNoticeText(v as Extract<typeof v, { kind: "report" }>, win.windowHours);
};
{
  // The whole message is pinned: Dan asked for words a sales manager reads in five
  // seconds, the two counts and one line on when to act (2026-10-28, "Reword.
  // Terrible"). A substring test is how the old sentence about the routing rule
  // and the second "no action needed" stayed in.
  eq(
    reportText(oct28),
    "Top tier bookings that went to a lower tier advisor in the last 24 hours:\n" +
      "Ultra High: 0 of 31\n" +
      "Very High: 1 of 28\n" +
      "If more of them go to a lower tier week over week, the top tiers don't have enough advisors for the leads coming in.",
    "the 2026-10-28 day reads as worded",
  );
}
{
  // As posted, the dispatcher's info lead says there is nothing to do now, and the
  // notice must not say it a second time.
  const posted = withSeverityLead(reportText(oct28), TOP_TIER_CASCADE_NOTICE_KEY, "info");
  eq((posted.match(/no action/gi) ?? []).length, 1, `"no action" is said once, by the lead (got ${posted})`);
  assert(!/2026-09-28|sales ops|Medium/.test(posted), "it does not explain the routing rule back to the people who set it");
}
{
  const text = reportText(w({ ultraBooked: 8, ultraCascaded: 3, veryHighBooked: 1, veryHighCascaded: 1 }));
  assert(text.includes("\nUltra High: 3 of 8\n"), `Ultra High count on its own line (got ${text})`);
  assert(text.includes("\nVery High: 1 of 1\n"), `Very High count on its own line (got ${text})`);
  assert(!/^Slate/.test(text), "it does not open with Slate");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
}
{
  // A tier with no bookings is left out rather than printed as "0 of 0".
  const text = reportText(w({ veryHighBooked: 5, veryHighCascaded: 2 }));
  assert(!/Ultra High:/.test(text), `a tier nobody booked is not mentioned (got ${text})`);
  assert(text.includes("\nVery High: 2 of 5\n"), `the tier with bookings is (got ${text})`);
}

// Pinned to the window, so two reports never describe the same bookings.
assert(TOP_TIER_CASCADE_COOLDOWN_MS === TOP_TIER_CASCADE_WINDOW_HOURS * 3600_000, "cooldown equals the window");

finish();
