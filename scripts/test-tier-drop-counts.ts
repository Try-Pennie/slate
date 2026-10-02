// How often a lead drops a debt tier at confirm, by cause (2026-10-02). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-tier-drop-counts.ts
//
// Sales ops decided a lead who loses their tier's last opening keeps the time they
// picked and drops a tier, so it no longer pages; /admin/routing counts it instead.
// What this file pins:
//  - every cause is reachable, and no two inputs that mean different things land
//    in the same one (L11, L517);
//  - a sideways overflow, an upward move, and a booking with no drop are not tier
//    drops at all, so they are never counted;
//  - a booking made before the shown tier was saved reads "not recorded", never
//    as either cause (L192);
//  - the 7 and 30 day windows are judged against an injected clock, at both edges.
import {
  TIER_DROP_CAUSES,
  countTierDrops,
  tierDropCause,
  tierLabel,
  type TierDropRow,
} from "@/lib/routing/tier-drop-counts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);
const DAY = 86_400_000;

function row(over: Partial<TierDropRow["routing_trace"] & object> | null, ageDays = 1, id = "bk"): TierDropRow {
  return {
    id,
    created_at: new Date(NOW - ageDays * DAY).toISOString(),
    routing_trace:
      over === null
        ? null
        : {
            tier_fallback: true,
            requested_tier: "high",
            booked_tier: "medium",
            displayed_tier: "high",
            bucket_code: "211",
            ...over,
          },
  };
}

// --- the cause of one drop -----------------------------------------------------------
eq(tierDropCause(row({}).routing_trace), "lost-at-confirm", "the lead's tier was on show and lost its last opening at confirm");
eq(
  tierDropCause(row({ displayed_tier: "medium" }).routing_trace),
  "nothing-on-show",
  "the booker was already showing the lower tier, so the lead's own tier had no times",
);
eq(tierDropCause(row({ displayed_tier: null }).routing_trace), "not-recorded", "a failed display read is not recorded");
{
  const before = row({});
  delete (before.routing_trace as Record<string, unknown>).displayed_tier;
  eq(tierDropCause(before.routing_trace), "not-recorded", "a booking made before the field existed is not recorded");
}

// Not a tier drop at all, so never counted under any cause.
eq(tierDropCause(row({ tier_fallback: false, booked_tier: "high" }).routing_trace), null, "no drop recorded");
eq(tierDropCause(row({ booked_tier: "high" }).routing_trace), null, "a sideways overflow keeps the debt tier");
eq(tierDropCause(row({ requested_tier: "medium", booked_tier: "high" }).routing_trace), null, "an upward move is not a drop");
eq(tierDropCause(row({ requested_tier: null }).routing_trace), null, "an unknown requested tier cannot be judged");
eq(tierDropCause(row({ booked_tier: "gold" }).routing_trace), null, "an unknown booked tier cannot be judged");
eq(tierDropCause(null), null, "a booking with no trace is not a drop");

// Every cause is produced by some input above (L151): a cause no input can reach
// would be a row on the page that always reads zero.
{
  const reached = new Set(
    [row({}), row({ displayed_tier: "medium" }), row({ displayed_tier: null })].map((r) => tierDropCause(r.routing_trace)),
  );
  for (const c of TIER_DROP_CAUSES) assert(reached.has(c), `the cause ${c} is reachable`);
}

// --- the windows ---------------------------------------------------------------------
{
  const rows = [
    row({}, 0.5, "a"),
    row({ displayed_tier: "medium" }, 6.9, "b"),
    row({}, 7.1, "c"), // outside 7, inside 30
    row({ displayed_tier: null }, 29.9, "d"),
    row({}, 30.1, "e"), // outside both
    row({ booked_tier: "high" }, 1, "overflow"), // not a drop
  ];
  const c = countTierDrops(rows, NOW);
  eq(c.week, { "lost-at-confirm": 1, "nothing-on-show": 1, "not-recorded": 0, total: 2 }, "the last 7 days");
  eq(c.month, { "lost-at-confirm": 2, "nothing-on-show": 1, "not-recorded": 1, total: 4 }, "the last 30 days");
  eq(
    c.recent.map((d) => d.id),
    ["a", "b", "c", "d"],
    "the drops inside 30 days, newest first, with nothing that is not a drop",
  );
  eq(c.recent[0].requestedLabel, "High", "a drop names the tier the lead was routed to");
  eq(c.recent[0].bookedLabel, "Medium", "and the tier that took the call");
}

// An unreadable stamp is never silently placed in a window (L50): it is left out
// and counted, so the page can say so.
{
  const bad: TierDropRow = { ...row({}), id: "bad", created_at: "not a date" };
  const c = countTierDrops([bad, row({}, 1, "ok")], NOW);
  eq(c.month.total, 1, "an unreadable stamp is not counted in a window");
  eq(c.unreadableStamps, 1, "and is counted as unreadable");
}

eq(tierLabel("very_high"), "Very High", "labels come from the one tier table");
eq(tierLabel("gold"), null, "an unknown key has no label rather than a guess");

finish();
