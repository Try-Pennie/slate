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

// --- #3338: drops made BEHIND other confirms for the same time ----------------------
//
// A confirm that loses the insert race, or waits in its slot's line while the ones
// ahead of it book, now walks the ladder rather than being told the time is taken.
// Those two branches are counted apart so either one never firing is seen (L551).
// They are counted over every RUNG drop, not only a debt tier drop: the Low pilot's
// whole ladder sits inside one tier, so its drops are all sideways, and counting
// only tier drops would read zero for ever there.
{
  const rows = [
    row({ dropped_behind: "race" }, 0.5, "r1"),
    row({ dropped_behind: "line" }, 2, "l1"),
    row({ dropped_behind: "line", booked_tier: "high" }, 3, "l-sideways"), // a sideways rung drop
    row({ dropped_behind: "race" }, 10, "r-old"), // outside 7, inside 30
    row({}, 1, "plain"), // a drop nobody contended
    row({ dropped_behind: "line" }, 31, "l-gone"), // outside both
    // #3489 step 3: walked past advisors other confirms were still booking.
    row({ dropped_behind: "claimed" }, 4, "c1"),
  ];
  const c = countTierDrops(rows, NOW);
  eq(c.behind.week, { race: 1, line: 2, claimed: 1 }, "behind, last 7 days: every branch, a sideways drop included");
  eq(c.behind.month, { race: 2, line: 2, claimed: 1 }, "behind, last 30 days");
  eq(c.month.total, 5, "the tier drop count is unchanged by the mark: the sideways drop is still not a tier drop");
  eq(
    tierDropCause(row({ dropped_behind: "line" }).routing_trace),
    "lost-at-confirm",
    "the mark does not change a tier drop's cause, which is about what was on show",
  );
  const none = countTierDrops([row({}, 1, "plain")], NOW);
  eq(none.behind, { week: { race: 0, line: 0, claimed: 0 }, month: { race: 0, line: 0, claimed: 0 } }, "nothing contended reads zero, never absent");

  // An unreadable stamp is never silently left out of the contended counts either
  // (L50): it is counted once as unreadable, whether or not the drop was also a
  // tier drop, and placed in no window.
  const sideways: TierDropRow = { ...row({ dropped_behind: "line", booked_tier: "high" }, 1, "bad-sideways"), created_at: "not a date" };
  const tierDrop: TierDropRow = { ...row({ dropped_behind: "race" }, 1, "bad-tier"), created_at: "not a date" };
  const bad = countTierDrops([sideways, tierDrop, row({ dropped_behind: "line" }, 1, "ok")], NOW);
  eq(bad.unreadableStamps, 2, "both unreadable contended drops are counted as unreadable, each once");
  eq(bad.behind.month, { race: 0, line: 1, claimed: 0 }, "and neither is placed in a window");
  eq(bad.month.total, 1, "the tier drop count holds only the readable tier drop");
}

eq(tierLabel("very_high"), "Very High", "labels come from the one tier table");
eq(tierLabel("gold"), null, "an unknown key has no label rather than a guess");

finish();
