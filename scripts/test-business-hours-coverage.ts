// The coverage readout inside the business-hours editor (#1297).
//
// Run: node --experimental-strip-types scripts/test-business-hours-coverage.ts
//
// It answers one question for the person editing the week: if I open this hour, is
// anyone actually rostered to take a booking in it? Getting that wrong in either
// direction is worse than not showing it, so three things are pinned here.
//
//  1. THREE HONEST STATES. A count, a real zero, and "could not check". The roster
//     read THROWS on failure rather than returning empty (`loadAllWorkingHours`), so
//     an unreadable roster must never render as "nobody covers this": that reads as a
//     staffing problem and someone would go and fix a roster that is fine.
//
//  2. THE DENOMINATOR COUNTS WHO CAN ACTUALLY TAKE A BOOKING. Measured in production
//     2026-08-06: 13 users carry the bookable flag, but 11 of those are deactivated
//     leavers whose flag was never cleared, so the real figure is 2. Counting the flag
//     alone overstates the pool by 11 people, and the whole point of this readout is
//     to be a number someone can act on.
//
//  3. EACH ZONE IS ITS OWN. The org's hours are in the org's clock and an agent's are
//     in theirs, exactly as the gates judge them. Every live agent is Eastern, so no
//     real data could tell a correct implementation from one that just compares minute
//     numbers, which is why the cases below are synthetic.
import {
  coverageForDate,
  coverageForWeek,
  type CoverageAgent,
} from "../src/lib/booking/business-hours-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { DateTime } from "luxon";

const ZONE = "America/New_York";
/** Monday 2026-06-08 is the reference week for every case below. */
const WEEK_START = "2026-06-08";

const openWeek = (weekdays: number[], start = 8 * 60, end = 20 * 60) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    is_open: weekdays.includes(weekday),
    start_minute: start,
    end_minute: end,
  }));

const agent = (timezone: string, weekdays: number[], start: number, end: number): CoverageAgent => ({
  timezone,
  rules: weekdays.map((weekday) => ({ weekday, start_minute: start, end_minute: end })),
});

const hoursFor = (res: { ok: true; days: { weekday: number; hours: { hour: number; agents: number }[] }[] }, weekday: number) =>
  res.days.find((d) => d.weekday === weekday)!.hours;

// --- could not check: the state that must never look like a real zero ----------------
{
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: null, // the roster read threw
    weekStartIso: WEEK_START,
  });
  eq(res.ok, false, "an unreadable roster reports could-not-check");
  assert(
    !("days" in res),
    "and carries no counts at all, so no part of the UI can render a zero from it",
  );
}

// --- a real zero is different from could-not-check ------------------------------------
{
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: [], // read fine; genuinely nobody bookable
    weekStartIso: WEEK_START,
  });
  assert(res.ok, "an empty but SUCCESSFUL read is a measured answer, not a failure");
  if (res.ok) {
    eq(res.bookableAgents, 0, "the denominator is a measured zero");
    assert(
      hoursFor(res, 1).every((h) => h.agents === 0),
      "every open hour honestly reports nobody covering it",
    );
  }
}

// --- the ordinary case: an agent covers part of the open day --------------------------
{
  // Org open 08:00 to 20:00 Monday; one agent works 09:00 to 17:00 Eastern.
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: [agent(ZONE, [1], 9 * 60, 17 * 60)],
    weekStartIso: WEEK_START,
  });
  assert(res.ok, "a readable roster reports counts");
  if (res.ok) {
    eq(res.bookableAgents, 1, "the denominator is who was passed in");
    const hours = hoursFor(res, 1);
    eq(hours.length, 12, "one entry per open hour, 08:00 through 19:00");
    eq(hours[0].hour, 8, "the readout starts at the hour the org opens");
    eq(hours[0].agents, 0, "08:00 is inside the org's day but before the agent starts");
    eq(hours.find((h) => h.hour === 9)!.agents, 1, "09:00 is covered");
    eq(hours.find((h) => h.hour === 16)!.agents, 1, "16:00 is the last covered hour");
    eq(
      hours.filter((h) => h.hour >= 17).every((h) => h.agents === 0),
      true,
      "17:00 to 20:00 is open but uncovered, which is the gap the copy has to explain",
    );
  }
}

// --- a closed day is not reported as uncovered ----------------------------------------
{
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: [agent(ZONE, [1, 2], 9 * 60, 17 * 60)],
    weekStartIso: WEEK_START,
  });
  if (res.ok) {
    const tuesday = res.days.find((d) => d.weekday === 2)!;
    eq(tuesday.is_open, false, "Tuesday is closed");
    eq(
      tuesday.hours.length,
      0,
      "a closed day lists no hours, so it cannot be read as a coverage gap",
    );
  }
}

// --- each side is judged in its OWN zone ----------------------------------------------
{
  // Org open 08:00 to 20:00 Eastern. The agent is in Los Angeles working 06:00 to
  // 09:00 Pacific, which is 09:00 to 12:00 Eastern: they cover the org's 09:00, 10:00
  // and 11:00. Comparing raw minute numbers would instead claim they cover 06:00 to
  // 09:00 Eastern, of which the org is only open for one hour, and would show 09:00
  // to 11:00 as a staffing gap that does not exist.
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: [agent("America/Los_Angeles", [1], 6 * 60, 9 * 60)],
    weekStartIso: WEEK_START,
  });
  if (res.ok) {
    const hours = hoursFor(res, 1);
    const covered = hours.filter((h) => h.agents > 0).map((h) => h.hour);
    eq(covered.join(","), "9,10,11", "a Pacific agent's morning maps onto the org's mid-morning");
    eq(
      hours.find((h) => h.hour === 8)!.agents,
      0,
      "and the org's 08:00 is NOT covered, which a raw minute comparison would claim it was",
    );
  }
}

// --- several agents accumulate --------------------------------------------------------
{
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: [
      agent(ZONE, [1], 8 * 60, 12 * 60),
      agent(ZONE, [1], 10 * 60, 20 * 60),
      agent(ZONE, [2], 8 * 60, 20 * 60), // Tuesday only, so contributes nothing Monday
    ],
    weekStartIso: WEEK_START,
  });
  if (res.ok) {
    eq(res.bookableAgents, 3, "the denominator counts everyone bookable, not only those working");
    const hours = hoursFor(res, 1);
    eq(hours.find((h) => h.hour === 8)!.agents, 1, "08:00 has one");
    eq(hours.find((h) => h.hour === 10)!.agents, 2, "10:00 has both, so counts accumulate");
    eq(hours.find((h) => h.hour === 19)!.agents, 1, "19:00 has only the late agent");
  }
}

// --- the thinnest hour, which is what the summary line reports -------------------------
{
  const res = coverageForWeek({
    businessHours: openWeek([1]),
    zone: ZONE,
    agents: [agent(ZONE, [1], 9 * 60, 17 * 60)],
    weekStartIso: WEEK_START,
  });
  if (res.ok) {
    eq(res.uncoveredHours, 4, "08:00 plus 17:00, 18:00 and 19:00 are open with nobody on");
    assert(
      res.uncoveredHours > 0,
      "a non-zero uncovered count is what makes the summary line say something is worth reading",
    );
  }
}

// --- approved time off discounts an hour, and is counted apart (#1582) -----------
//
// An agent on shift whose approved leave overlaps an hour cannot take a booking in
// it, so counting them as coverage reports a fully-away day as fully staffed, the
// opposite of the truth. `away` is its own number rather than a silent decrement,
// because "everybody scheduled is away" and "nobody was ever scheduled" are
// different facts for different people, and a surface that folds them together
// re-creates the confusion the grid exists to remove.
{
  const zone = "America/New_York";
  // 2026-12-21 is a Monday. On shift 09:00 to 12:00 in the org's zone.
  const at = (h: number, m = 0) =>
    DateTime.fromISO("2026-12-21", { zone }).set({ hour: h, minute: m }).toMillis();
  const agent: CoverageAgent = {
    timezone: zone,
    rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 12 * 60 }],
    out: [{ startMs: at(10), endMs: at(10, 30) }],
  };

  const day = coverageForDate({
    window: { start_minute: 9 * 60, end_minute: 12 * 60 },
    zone,
    dateIso: "2026-12-21",
    agents: [agent],
  });
  eq(
    day.hours.map((h) => `${h.hour}:${h.agents}/${h.away}`).join(" "),
    "9:1/0 10:0/1 11:1/0",
    "leave overlapping any part of an hour discounts it, and only that hour",
  );

  // Half-open both sides: leave that merely abuts an hour leaves it covered,
  // matching the overlap convention the coverage reassignment reads (#1236).
  const abutting = coverageForDate({
    window: { start_minute: 9 * 60, end_minute: 12 * 60 },
    zone,
    dateIso: "2026-12-21",
    agents: [{ ...agent, out: [{ startMs: at(9), endMs: at(10) }] }],
  });
  eq(
    abutting.hours.map((h) => `${h.hour}:${h.agents}/${h.away}`).join(" "),
    "9:0/1 10:1/0 11:1/0",
    "leave ending exactly on the hour boundary frees the next hour",
  );

  // Away counts only the ROSTERED: an agent who was never on shift for the hour
  // is unrostered there, not away, or a day off would double-report as leave.
  const offShift = coverageForDate({
    window: { start_minute: 9 * 60, end_minute: 12 * 60 },
    zone,
    dateIso: "2026-12-21",
    agents: [
      {
        timezone: zone,
        rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 10 * 60 }],
        out: [{ startMs: at(9), endMs: at(12) }],
      },
    ],
  });
  eq(
    offShift.hours.map((h) => `${h.hour}:${h.agents}/${h.away}`).join(" "),
    "9:0/1 10:0/0 11:0/0",
    "an agent is away only in hours they were rostered to work",
  );

  // An agent with no `out` at all behaves exactly as before, so the settings
  // screen and the roster alarm, which never load leave, are unchanged.
  const plain = coverageForDate({
    window: { start_minute: 9 * 60, end_minute: 12 * 60 },
    zone,
    dateIso: "2026-12-21",
    agents: [{ timezone: zone, rules: [{ weekday: 1, start_minute: 9 * 60, end_minute: 12 * 60 }] }],
  });
  eq(
    plain.hours.map((h) => `${h.hour}:${h.agents}/${h.away}`).join(" "),
    "9:1/0 10:1/0 11:1/0",
    "an agent without leave loaded is judged exactly as before",
  );
}

finish();
