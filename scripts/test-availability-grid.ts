// Which hours of which days anyone can be booked (#1302).
//
// The point of the grid is not the numbers, it is that an empty hour has four
// different causes and each one is somebody else's job: the org is shut, nobody
// is rostered, everybody rostered is booked out, or the roster could not be read
// at all. Every existing surface renders all four as the same silence, which is
// how a whole roster falling out of the bookable pool (2026-08-05) surfaced as
// sixty identical alerts saying individual buckets were empty.
//
// So what is tested here is the SEPARATION, in both directions, plus the two
// distinctions that are easy to collapse and expensive when they are: unreadable
// is not zero, and past the horizon is not booked out.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-availability-grid.ts
import {
  buildAvailabilityGrid,
  bucketsOfferingByHour,
  dayHourKey,
  gridTotals,
  type GridDayInput,
} from "../src/lib/admin/availability-grid.ts";
import type { CoverageDay } from "../src/lib/booking/business-hours-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";

/** An open day covering 9, 10 and 11 with the given agent counts. */
const openDay = (weekday: number, agents: number[]): CoverageDay => ({
  weekday,
  is_open: true,
  hours: agents.map((a, i) => ({ hour: 9 + i, agents: a })),
});

const closedDay = (weekday: number): CoverageDay => ({ weekday, is_open: false, hours: [] });

const day = (over: Partial<GridDayInput> = {}): GridDayInput => ({
  iso: "2026-08-25",
  weekday: 1,
  withinHorizon: true,
  coverage: openDay(1, [3, 3, 3]),
  ...over,
});

// --- the four causes are four different answers --------------------------------
{
  const offering = new Map([[dayHourKey("2026-08-25", 9), 42]]);
  const grid = buildAvailabilityGrid({
    days: [day({ coverage: openDay(1, [3, 0, 3]) })],
    bucketsByDayHour: offering,
  });

  eq(grid.hours, [9, 10, 11], "the hour axis is the org's open hours");
  const [nine, ten, eleven] = grid.days[0].cells;

  eq(nine.kind, "open", "agents on shift and a bucket offering reads as bookable");
  assert(nine.kind === "open" && nine.buckets === 42, "and says how many pools can take it");
  assert(nine.kind === "open" && nine.agents === 3, "and how many people are behind it");

  eq(ten.kind, "unrostered", "an open hour with nobody on shift is a rostering answer");

  // The one that is easiest to get wrong: staffed, inside the horizon, and no
  // bucket offering. That is a full calendar, which is a completely different
  // problem from having nobody rostered, and the two must never share a state.
  eq(eleven.kind, "booked", "staffed with nothing left to offer is booked out");
  assert(eleven.kind === "booked" && eleven.agents === 3, "and still names the people on shift");
}

// --- a closed day is not a coverage gap ----------------------------------------
{
  const grid = buildAvailabilityGrid({
    days: [
      day({ iso: "2026-08-25", weekday: 1, coverage: openDay(1, [2, 2, 2]) }),
      day({ iso: "2026-08-30", weekday: 7, coverage: closedDay(7) }),
    ],
    bucketsByDayHour: new Map(),
  });
  assert(
    grid.days[1].cells.every((c) => c.kind === "closed"),
    "a day the org is shut reads as closed, never as nobody rostered",
  );
  // An open day still has hours outside its own window, and those are closed in
  // exactly the same sense: there is nothing to staff.
  const shortDay = buildAvailabilityGrid({
    days: [
      day({ coverage: openDay(1, [2, 2, 2]) }),
      day({
        iso: "2026-08-26",
        weekday: 2,
        coverage: { weekday: 2, is_open: true, hours: [{ hour: 10, agents: 2 }] },
      }),
    ],
    bucketsByDayHour: new Map(),
  });
  eq(shortDay.hours, [9, 10, 11], "the axis is the union, so a shorter day does not crop the week");
  eq(shortDay.days[1].cells[0].kind, "closed", "an hour outside a day's own window is closed");
  assert(shortDay.days[1].cells[1].kind !== "closed", "and the hour it IS open is judged");
}

// --- unreadable is not zero ----------------------------------------------------
// `loadCoverageAgents` throws rather than returning an empty pool precisely so
// this distinction survives. An unreadable roster rendered as "nobody covers
// this" sends somebody to fix a roster that was fine (L11).
{
  const grid = buildAvailabilityGrid({
    days: [day(), day({ iso: "2026-08-26", weekday: 2, coverage: null })],
    bucketsByDayHour: new Map([[dayHourKey("2026-08-25", 9), 5]]),
  });
  assert(!grid.measurable, "one unreadable day makes the whole grid unmeasured");
  assert(
    grid.days.every((d) => d.cells.every((c) => c.kind === "unknown")),
    "and no cell claims an answer, including the days that did read",
  );
}

// --- past the horizon is not booked out ----------------------------------------
// The horizon is four days, and a fully staffed Friday beyond it is offering
// nothing yet. Scoring that as booked would report a healthy roster as full, and
// the two are opposite problems.
{
  const grid = buildAvailabilityGrid({
    days: [day({ iso: "2026-09-10", weekday: 4, withinHorizon: false })],
    bucketsByDayHour: new Map(),
  });
  assert(
    grid.days[0].cells.every((c) => c.kind === "beyond-horizon"),
    "a staffed day past the horizon says so rather than reading as booked out",
  );
  assert(
    grid.days[0].cells.every((c) => c.kind === "beyond-horizon" && c.agents === 3),
    "and still reports who is on shift, which is the part that IS measured",
  );

  // An unstaffed hour past the horizon is still a rostering answer: it is
  // measurable today and actionable today, so the horizon must not hide it.
  const unstaffed = buildAvailabilityGrid({
    days: [day({ withinHorizon: false, coverage: openDay(1, [0, 0, 0]) })],
    bucketsByDayHour: new Map(),
  });
  assert(
    unstaffed.days[0].cells.every((c) => c.kind === "unrostered"),
    "nobody rostered outranks the horizon, because it can be fixed now",
  );
}

// --- counting pools, not times -------------------------------------------------
// A start time is the SAME time in most of the sixty buckets, so summing starts
// would report sixty for one bookable moment.
{
  const hours = {
    zone: ZONE,
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })), exceptions: [] };
  const slot = (t: string) => `2026-08-25T${t}:00.000-04:00`;
  const counts = bucketsOfferingByHour(
    [
      // Three starts inside the 09:00 hour, one bucket. Must count ONCE.
      { payload: { slots: [slot("09:00"), slot("09:15"), slot("09:30")], eventType: { duration_min: 15 } } },
      { payload: { slots: [slot("09:00")], eventType: { duration_min: 15 } } },
      { payload: { slots: [slot("11:00")], eventType: { duration_min: 15 } } },
      // No duration, so it cannot be judged against the window at all, and it
      // contributes nothing rather than a number it did not earn (#1296).
      { payload: { slots: [slot("09:00")] } },
      { payload: null },
    ],
    hours,
    ZONE,
  );
  eq(counts.get(dayHourKey("2026-08-25", 9)), 2, "two pools can be booked at 09:00, not four starts");
  eq(counts.get(dayHourKey("2026-08-25", 11)), 1, "and one at 11:00");

  // A slot outside the org's window is not being offered to anybody, so it must
  // not appear as availability on a screen an operator trusts.
  const narrow = bucketsOfferingByHour(
    [{ payload: { slots: [slot("07:00")], eventType: { duration_min: 15 } } }],
    hours,
    ZONE,
  );
  eq(narrow.size, 0, "a slot outside the org's hours is not offered, so it is not counted");
}

// --- the summary above the grid ------------------------------------------------
{
  const grid = buildAvailabilityGrid({
    days: [day({ coverage: openDay(1, [1, 2, 2]) }), day({ iso: "2026-08-31", weekday: 7, coverage: closedDay(7) })],
    bucketsByDayHour: new Map([[dayHourKey("2026-08-25", 9), 7]]),
  });
  const totals = gridTotals(grid);
  eq(totals.open, 1, "one bookable hour");
  eq(totals.booked, 2, "two staffed but full");
  eq(totals.closed, 3, "and a shut day");
  eq(totals.unrostered, 0, "nothing miscounted into the rostering bucket");
  eq(
    Object.values(totals).reduce((a, b) => a + b, 0),
    grid.days.length * grid.hours.length,
    "every cell is counted exactly once",
  );
}

finish();
