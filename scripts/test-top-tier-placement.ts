// A top tier lead booked where the routing rule forbids. Sales ops decided on
// 2026-09-28 (#2842) that Ultra High and Very High leads may cascade, but no lower
// than Medium and never to an advisor who also carries Low. A cascade inside that
// rule is routing working and posts NOTHING (Dan, 2026-10-29: "I don't need this
// notification. It only matters if it goes to a tier it's not supposed to"); a
// placement outside it pages once per booking.
import {
  CASCADE_CODES_BELOW,
  TOP_TIER_CODES,
  TOP_TIER_PLACEMENT_COOLDOWN_MS,
  TOP_TIER_PLACEMENT_LOOKBACK_HOURS,
  checkTopTierPlacements,
  formatForbiddenPlacementAlert,
  judgeTopTierPlacements,
  topTierPlacementKey,
  type PlacementAdvisor,
  type PlacementRow,
} from "../src/lib/monitor/top-tier-placement.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the code lists are derived, and cover exactly what the ladder can produce ---
eq(Object.keys(TOP_TIER_CODES).sort(), ["ultra_high", "very_high"], "two top tiers");
assert(TOP_TIER_CODES.ultra_high.length === 12 && TOP_TIER_CODES.very_high.length === 12, "twelve codes each");
assert(TOP_TIER_CODES.ultra_high.every((c) => c[0] === "5"), "Ultra codes start with 5");
assert(TOP_TIER_CODES.very_high.every((c) => c[0] === "4"), "Very High codes start with 4");
for (const tier of ["ultra_high", "very_high"] as const) {
  const below = new Set(CASCADE_CODES_BELOW[tier]);
  for (const code of TOP_TIER_CODES[tier]) {
    for (const rung of tierLadder(code)) {
      // Every rung the ladder can land a top tier lead on below their tier is read,
      // and no rung in their own tier is, so a sideways move is never judged (#2228).
      const cascaded = rung[0] !== code[0];
      assert(below.has(rung) === cascaded, `${code} -> ${rung} is ${cascaded ? "" : "not "}read as a cascade`);
      // The check's own rule is written out by tier digit rather than asked of the
      // ladder (L721), so the two are held together here: no rung the ladder offers
      // a top tier lead is one the check would call forbidden.
      assert(Number(rung[0]) >= 2, `${code} -> ${rung}: the ladder never offers below Medium`);
    }
  }
  // Low IS read, deliberately: the ladder cannot reach it, so a booking there means
  // the floor broke, and a read stopping at Medium would miss exactly that booking.
  assert([...below].some((c) => c[0] === "1"), `${tier}: a booking that reached Low is still read`);
}

// --- the judgement ---
const advisor = (id: string, teams: string[], name: string | null = `Advisor ${id}`): PlacementAdvisor => ({
  id,
  name,
  email: `${id}@example.com`,
  attributes: { debt_team: teams },
});
const row = (o: Partial<PlacementRow>): PlacementRow => ({
  booking_id: "b1",
  requested_code: "511",
  bucket_code: "411",
  chosen_user_id: "u1",
  ...o,
});
const advisors = new Map<string, PlacementAdvisor>([
  ["vh", advisor("vh", ["very_high"])],
  ["med", advisor("med", ["medium"])],
  ["medlow", advisor("medlow", ["medium", "low"], "Dana Ruiz")],
  ["highlow", advisor("highlow", ["high", "low"])],
  ["low", advisor("low", ["low"], "Sam Lee")],
]);
{
  // Allowed cascades: down one tier, down to Medium, from either top tier.
  const allowed = [
    row({ requested_code: "511", bucket_code: "411", chosen_user_id: "vh" }),
    row({ requested_code: "511", bucket_code: "211", chosen_user_id: "med" }),
    row({ requested_code: "412", bucket_code: "212", chosen_user_id: "med" }),
  ];
  const j = judgeTopTierPlacements(allowed, advisors);
  eq(j.forbidden.length, 0, "a cascade inside the rule is not forbidden");
  eq(j.allowed, 3, "each allowed cascade is counted as allowed");
  eq(j.unmeasured.length, 0, "and none is unmeasured");
}
{
  const j = judgeTopTierPlacements(
    [row({ booking_id: "b-low", requested_code: "511", bucket_code: "111", chosen_user_id: "low" })],
    advisors,
  );
  eq(j.forbidden.map((f) => f.breach), ["below-medium"], "a top tier lead booked on Low is forbidden");
}
{
  const j = judgeTopTierPlacements(
    [
      row({ booking_id: "b-ml", requested_code: "411", bucket_code: "211", chosen_user_id: "medlow" }),
      row({ booking_id: "b-hl", requested_code: "511", bucket_code: "311", chosen_user_id: "highlow" }),
    ],
    advisors,
  );
  eq(
    j.forbidden.map((f) => f.breach),
    ["low-carrier", "low-carrier"],
    "an advisor below the lead's tier who also carries Low is forbidden, on Medium or High",
  );
}
{
  // Below Medium is judged from the codes alone, so an advisor nobody could read
  // still pages; the Low carrier half needs the advisor, so it is unmeasured.
  const j = judgeTopTierPlacements(
    [
      row({ booking_id: "b-gone", requested_code: "511", bucket_code: "111", chosen_user_id: "nobody" }),
      row({ booking_id: "b-unknown", requested_code: "511", bucket_code: "311", chosen_user_id: "nobody" }),
      row({ booking_id: "b-null", requested_code: "411", bucket_code: "211", chosen_user_id: null }),
      row({ booking_id: null, requested_code: "411", bucket_code: "111", chosen_user_id: "low" }),
      row({ booking_id: "b-odd", requested_code: "511", bucket_code: "zzz", chosen_user_id: "low" }),
    ],
    advisors,
  );
  eq(j.forbidden.map((f) => f.row.booking_id), ["b-gone"], "below Medium pages without the advisor");
  eq(
    j.unmeasured.map((u) => u.reason),
    ["advisor-unread", "advisor-unread", "no-booking-id", "code-unreadable"],
    "each case it cannot judge is unmeasured under its own reason, never allowed",
  );
  eq(j.allowed, 0, "an unmeasured placement is not counted as allowed");
}

// --- the page ---
{
  const [low] = judgeTopTierPlacements(
    [row({ booking_id: "b-low", requested_code: "511", bucket_code: "111", chosen_user_id: "low" })],
    advisors,
  ).forbidden;
  eq(
    formatForbiddenPlacementAlert(low!, "https://slate.example/admin/bookings/b-low"),
    "An Ultra High lead was booked with Sam Lee on the Low team. Ultra High leads should go no lower " +
      "than Medium, so this is a routing bug. Move the call to an advisor on Medium or above.\n" +
      "https://slate.example/admin/bookings/b-low",
    "the below Medium page reads as worded",
  );
  const [carrier] = judgeTopTierPlacements(
    [row({ booking_id: "b-ml", requested_code: "411", bucket_code: "211", chosen_user_id: "medlow" })],
    advisors,
  ).forbidden;
  const text = formatForbiddenPlacementAlert(carrier!, "https://slate.example/admin/bookings/b-ml");
  eq(
    text,
    "A Very High lead was booked with Dana Ruiz, a Medium advisor who is also on the Low team. " +
      "Very High leads sent to a lower tier should never get an advisor who is on the Low team, so this is a routing bug. " +
      "Move the call to an advisor who is not on the Low team.\n" +
      "https://slate.example/admin/bookings/b-ml",
    "the Low carrier page reads as worded",
  );
  assert(!/^Slate/.test(text), "it does not open with Slate");
  const [unnamed] = judgeTopTierPlacements(
    [row({ booking_id: "b-gone", requested_code: "511", bucket_code: "111", chosen_user_id: "nobody" })],
    advisors,
  ).forbidden;
  assert(
    formatForbiddenPlacementAlert(unnamed!, "u").startsWith("An Ultra High lead was booked with an advisor on the Low team."),
    "an advisor who could not be read is not named",
  );
}

// --- the check, end to end through fakes ---
type Sent = { key: string; ms: number; text: string };
const harness = (rows: PlacementRow[] | Error, people: PlacementAdvisor[] | Error) => {
  const sent: Sent[] = [];
  const asked: string[][] = [];
  const run = checkTopTierPlacements({
    loadPlacements: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
    loadAdvisors: async (ids) => {
      asked.push(ids);
      if (people instanceof Error) throw people;
      return people;
    },
    bookingUrl: (id) => `https://slate.example/admin/bookings/${id}`,
    notify: async (key, ms, text) => {
      sent.push({ key, ms, text });
    },
  });
  return { run, sent, asked };
};
{
  const h = harness(
    [
      row({ booking_id: "a", requested_code: "511", bucket_code: "411", chosen_user_id: "vh" }),
      row({ booking_id: "b", requested_code: "411", bucket_code: "211", chosen_user_id: "med" }),
    ],
    [...advisors.values()],
  );
  const result = await h.run;
  eq(h.sent, [], "allowed cascades post nothing");
  eq(result.allowed, 2, "and are counted for the log line");
}
{
  const h = harness(
    [
      row({ booking_id: "a", requested_code: "511", bucket_code: "411", chosen_user_id: "vh" }),
      row({ booking_id: "bad", requested_code: "411", bucket_code: "211", chosen_user_id: "medlow" }),
    ],
    [...advisors.values()],
  );
  const result = await h.run;
  eq(h.sent.map((s) => s.key), [topTierPlacementKey("bad")], "a forbidden placement pages on its own booking key");
  eq(h.sent[0]!.key, "top_tier_forbidden_placement:bad", "the key is the family plus the booking id");
  eq(h.sent[0]!.ms, TOP_TIER_PLACEMENT_COOLDOWN_MS, "on the placement cooldown");
  assert(h.sent[0]!.text.includes("Dana Ruiz"), "naming the advisor");
  eq(h.asked, [["vh", "medlow"]], "advisors are read once, only for the cascades found");
  eq(result.paged, 1, "one page counted");
}
{
  const h = harness([], [...advisors.values()]);
  await h.run;
  eq(h.asked, [], "no cascades, no advisor read");
  eq(h.sent, [], "and nothing posted");
}
{
  // A failed read throws out of the check, so the monitor lane records the step as
  // failing (monitor_step_failing) rather than reading it as a day with nothing wrong.
  const h = harness(new Error("routing_decisions read failed"), [...advisors.values()]);
  let threw = false;
  await h.run.catch(() => (threw = true));
  assert(threw, "an unreadable placement read throws");
  eq(h.sent, [], "and posts nothing");
}
{
  const h = harness(
    [row({ booking_id: "bad", requested_code: "511", bucket_code: "111", chosen_user_id: "low" })],
    new Error("users read failed"),
  );
  let threw = false;
  await h.run.catch(() => (threw = true));
  assert(threw, "an unreadable advisor read throws");
  eq(h.sent, [], "and posts nothing, rather than a page missing half its judgement");
}

// A booking leaves the lookback before its key may post again, so each forbidden
// placement pages exactly once.
assert(
  TOP_TIER_PLACEMENT_COOLDOWN_MS > TOP_TIER_PLACEMENT_LOOKBACK_HOURS * 3600_000,
  "the cooldown outlasts the lookback",
);

finish();
