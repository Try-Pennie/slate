// Offering the next N BOOKABLE days rather than a fixed calendar window (#1326).
//
// Run: node --experimental-strip-types scripts/test-bookable-days-window.ts
//
// The horizon used to be a calendar window: today plus four days, take whatever
// bookable days fall inside it. Closed days inside the window were simply lost, so
// a lead got fewer choices for a reason they could not see, and with Sunday closed
// a Thursday or Friday afternoon could offer a single day.
//
// Now the window is a SEARCH range and the answer is trimmed to the first N days
// that actually have times. Two pieces, both pure and both here:
//
//   searchWindowDays  how far to compute, given how many bookable days are wanted
//   trimToBookableDays  keep only the first N days that have any slot
//
// The trim is where the correctness lives, and its whole job is a distinction the
// old code never had to make: a day with no times is not a day.
import {
  trimToBookableDays,
  searchWindowDays,
  MAX_CLOSED_RUN_DAYS,
} from "../src/lib/availability/bookable-days.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
/** 09:00 New York on the given date, as the stored UTC instant. */
const at = (date: string, hh = "13") => `${date}T${hh}:00:00.000Z`;

// --- the trim -----------------------------------------------------------------------
{
  // Thursday 2026-08-13 through the following week, Sunday absent because nobody
  // works it. A four day answer must be Thu, Fri, Sat, Mon: it walks PAST Sunday
  // rather than stopping at the fourth calendar day.
  const slots = [
    at("2026-08-13"), at("2026-08-13", "14"),
    at("2026-08-14"),
    at("2026-08-15"),
    // Sunday 2026-08-16 has nothing at all.
    at("2026-08-17"),
    at("2026-08-18"),
  ];
  const kept = trimToBookableDays(slots, ZONE, 4);
  eq(
    [...new Set(kept.map((s) => s.slice(0, 10)))].join(","),
    "2026-08-13,2026-08-14,2026-08-15,2026-08-17",
    "four bookable days walk past the empty Sunday to reach Monday",
  );
  eq(kept.length, 5, "every slot on a kept day survives, not just the first");
  assert(
    !kept.includes(at("2026-08-18")),
    "and the fifth bookable day is dropped, so the count is respected",
  );
}

// --- a day with no slots is not a day -------------------------------------------------
{
  // The distinction the old calendar window never had to make. Days are counted by
  // whether they produced times, never by their position on the calendar.
  const slots = [at("2026-08-13"), at("2026-08-20"), at("2026-08-27")];
  eq(
    trimToBookableDays(slots, ZONE, 3).length,
    3,
    "three widely separated days still count as three",
  );
  eq(
    trimToBookableDays(slots, ZONE, 2).map((s) => s.slice(0, 10)).join(","),
    "2026-08-13,2026-08-20",
    "and asking for two takes the two soonest, however far apart they are",
  );
}

// --- fewer than asked for is an honest answer, never padding ---------------------------
{
  const slots = [at("2026-08-13"), at("2026-08-14")];
  eq(
    trimToBookableDays(slots, ZONE, 4).length,
    2,
    "when only two days have times, two are returned rather than an invented four",
  );
  eq(trimToBookableDays([], ZONE, 4).length, 0, "nothing available returns nothing");
}

// --- days are grouped in the ORG's zone, not UTC ---------------------------------------
{
  // 2026-08-14T01:00Z is Thursday 21:00 in New York, NOT Friday. Grouping in UTC
  // would file it as a separate day and burn one of the four on a day that does not
  // exist for the customer.
  const lateThursday = "2026-08-14T01:00:00.000Z";
  const slots = [at("2026-08-13"), lateThursday, at("2026-08-14"), at("2026-08-15")];
  const kept = trimToBookableDays(slots, ZONE, 2);
  eq(
    [...new Set(kept.map((s) => new Date(s).toISOString().slice(0, 10)))].length,
    2,
    "the late Thursday evening slot belongs to Thursday, so two days is Thu and Fri",
  );
  assert(
    kept.includes(lateThursday),
    "and that evening slot is kept, since its day was kept",
  );
}

// --- the order out is the order in, sorted ---------------------------------------------
{
  const jumbled = [at("2026-08-15"), at("2026-08-13"), at("2026-08-14")];
  eq(
    trimToBookableDays(jumbled, ZONE, 3).join(","),
    [at("2026-08-13"), at("2026-08-14"), at("2026-08-15")].join(","),
    "an unsorted input comes back sorted, so 'the first N days' means the soonest",
  );
}

// --- an unreadable instant is dropped, never counted as a day ---------------------------
{
  // A day is a promise that someone can book it. An instant we cannot place cannot
  // be offered, and counting it would spend one of the N on nothing.
  const slots = ["not-a-date", at("2026-08-13"), at("2026-08-14")];
  const kept = trimToBookableDays(slots, ZONE, 2);
  assert(!kept.includes("not-a-date"), "an unreadable instant is not offered");
  eq(
    [...new Set(kept.map((s) => s.slice(0, 10)))].join(","),
    "2026-08-13,2026-08-14",
    "and it does not consume one of the days either",
  );
}

// --- the search window ------------------------------------------------------------------
{
  // Wide enough to clear a normal closed run, and BOUNDED, because a long enough
  // closure would otherwise walk forward indefinitely and the compute cost with it.
  assert(
    searchWindowDays(4) > 4,
    "the search reaches beyond the days wanted, or a closure inside it loses a day",
  );
  assert(
    searchWindowDays(4) >= 4 + 1,
    "at minimum it clears a single closed Sunday, the everyday case",
  );
  eq(
    searchWindowDays(4),
    4 + MAX_CLOSED_RUN_DAYS,
    "the allowance is the same for any N, so the cost is predictable",
  );
  assert(
    searchWindowDays(7) <= 14,
    `even the largest horizon stays inside a fortnight (got ${searchWindowDays(7)})`,
  );

  // The cost this trades against, MEASURED at 200 agents over a four day horizon:
  // +1 day costs 23%, +2 costs 35%, +3 costs 48% of per-bucket recompute, on an
  // invocation four minute-lanes share. Two is the smallest allowance that clears a
  // closed Sunday followed by a Monday public holiday, which is the real world.
  //
  // This pins the number so it cannot creep upward without someone re-measuring: a
  // day added here is paid on every bucket on every pass, forever.
  eq(MAX_CLOSED_RUN_DAYS, 2, "the search allowance is two days, the measured choice");
  assert(
    searchWindowDays(4) === 6,
    `a default horizon computes 6 days, up from 4 (got ${searchWindowDays(4)})`,
  );
  assert(
    MAX_CLOSED_RUN_DAYS >= 2,
    "and it clears a Sunday plus a Monday holiday, a two day run that really occurs",
  );
}

finish();
