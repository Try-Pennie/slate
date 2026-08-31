// The acceptance table for "show only bookable days in the booker" (#1298).
//
// Run: node --experimental-strip-types scripts/test-booker-offered-days-table.ts
//
// #1326 changed `horizon_days` from a count of CALENDAR days to a count of
// BOOKABLE days, and #1330 / #1336 made the strip draw exactly the days the API
// offers. Both landed with unit tests for their own piece: `searchWindowDays` and
// `trimToBookableDays` are covered by `test-bookable-days-window.ts`, and the
// chips by `BookerStrip.test.tsx`.
//
// What was never pinned is the thing Dan actually measured and signed off on: for
// each weekday, and on each side of the moment today drops out, WHICH days the
// booker ends up offering. That answer is the product of four pieces (the search
// window, the three gates, the trim, and the grouping into viewer days), so every
// one of them can stay green while the answer as a whole is wrong. This file
// drives the real pieces end to end and asserts the table.
//
// The parameters are the ones the measurement assumed, stated in the issue:
// agents finish at 17:00, the call is 20 minutes and needs 120 minutes' notice, so
// the last bookable start is 16:40 and today stops being offerable at 14:40.
//
// BOTH ends of every clock-relative fixture are pinned (L130): the week is a fixed
// week of real dates AND the clock is a fixed instant inside it. A fixture that
// pinned only one would drift into a different case as real time moved, and would
// then pass while asserting about a day nobody chose.
import { DateTime } from "luxon";
import { computeBucketSlots, type MemberAvailability } from "../src/lib/availability/compute.ts";
import { trimToBookableDays, MAX_CLOSED_RUN_DAYS } from "../src/lib/availability/bookable-days.ts";
import { daysWithSlots } from "../src/lib/booking/slot-picker.ts";
import { slotCacheKey } from "../src/lib/availability/cache-key.ts";
import { SEEDED_BUSINESS_HOURS, BUSINESS_ZONE } from "../src/lib/booking/business-hours.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = BUSINESS_ZONE;

/**
 * A fixed week with no DST transition in it, so the fixture measures the rules
 * rather than an offset change. Monday 2026-09-14 through Sunday 2026-09-20; US
 * Eastern is on EDT for all of it (DST ends 2026-11-01).
 */
const WEEK: Record<string, string> = {
  Mon: "2026-09-14",
  Tue: "2026-09-15",
  Wed: "2026-09-16",
  Thu: "2026-09-17",
  Fri: "2026-09-18",
  Sat: "2026-09-19",
  Sun: "2026-09-20",
};

/** The org's stored week: Monday to Saturday, 8am to 8pm, Sunday shut. */
const BUSINESS_HOURS = {
  zone: ZONE,
  rules: SEEDED_BUSINESS_HOURS,
  exceptions: [],
};

/** One agent, on shift Monday to Saturday 08:00 to 17:00, with an empty diary. */
function agent(): MemberAvailability {
  return {
    userId: "agent-1",
    timezone: ZONE,
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      start_minute: 8 * 60,
      end_minute: 17 * 60,
    })),
    busy: [],
    bookingStartsMs: [],
    dayCounts: new Map<string, number>(),
  };
}

const DURATION_MIN = 20;
const NOTICE_MIN = 120;

/**
 * The days the booker offers, given a wall-clock instant and a horizon. This is
 * the real read path in miniature: the window comes from `slotCacheKey` (so the
 * search allowance is the shipped one, never a number restated here), the slots
 * from the shared three-gate predicate, the count from `trimToBookableDays`, and
 * the grouping from the same `daysWithSlots` the strip is fed.
 */
function offeredDays(
  nowIso: string,
  horizonDays: number,
  opts?: { members?: MemberAvailability[]; hours?: typeof BUSINESS_HOURS },
): string[] {
  const hours = opts?.hours ?? BUSINESS_HOURS;
  const { fromIso, toIso } = slotCacheKey("XBC", nowIso, horizonDays);
  const slots = computeBucketSlots({
    members: opts?.members ?? [agent()],
    durationMin: DURATION_MIN,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: NOTICE_MIN,
    dailyCap: null,
    slotIntervalMin: DURATION_MIN,
    businessHours: hours,
    from: fromIso,
    to: toIso,
    nowMs: DateTime.fromISO(nowIso).toMillis(),
  });
  return daysWithSlots(trimToBookableDays(slots, ZONE, horizonDays), ZONE);
}

/** A wall-clock instant on one of the fixture's days, in the org's zone. */
const at = (dayName: string, hhmm: string): string => {
  const iso = DateTime.fromISO(`${WEEK[dayName]}T${hhmm}`, { zone: ZONE }).toUTC().toISO();
  if (iso === null) throw new Error(`unreadable fixture instant: ${dayName} ${hhmm}`);
  return iso;
};

/** Render an offered-day list back into the table's weekday shorthand. */
const asWeekdays = (days: string[]): string =>
  days.map((d) => DateTime.fromISO(d, { zone: ZONE }).toFormat("ccc")).join(", ");

/** Calendar days between `today` and the furthest offered date. */
const furthest = (dayName: string, days: string[]): number => {
  const today = DateTime.fromISO(WEEK[dayName], { zone: ZONE }).startOf("day");
  const last = DateTime.fromISO(days[days.length - 1], { zone: ZONE }).startOf("day");
  return Math.round(last.diff(today, "days").days);
};

// --- the measured table (Dan, 2026-08-07) ---------------------------------------------
//
// Today leaves the strip after 14:40, so each row is asserted on both sides of it.
// "before" is 10:00 and "after" is 15:00, which are the same side of that boundary
// as any other time in their half.
{
  const TABLE: {
    today: string;
    before: string;
    after: string;
    furthestBefore: number;
    furthestAfter: number;
  }[] = [
    { today: "Mon", before: "Mon, Tue, Wed, Thu", after: "Tue, Wed, Thu, Fri", furthestBefore: 3, furthestAfter: 4 },
    { today: "Tue", before: "Tue, Wed, Thu, Fri", after: "Wed, Thu, Fri, Sat", furthestBefore: 3, furthestAfter: 4 },
    { today: "Wed", before: "Wed, Thu, Fri, Sat", after: "Thu, Fri, Sat, Mon", furthestBefore: 3, furthestAfter: 5 },
    { today: "Thu", before: "Thu, Fri, Sat, Mon", after: "Fri, Sat, Mon, Tue", furthestBefore: 4, furthestAfter: 5 },
    { today: "Fri", before: "Fri, Sat, Mon, Tue", after: "Sat, Mon, Tue, Wed", furthestBefore: 4, furthestAfter: 5 },
    { today: "Sat", before: "Sat, Mon, Tue, Wed", after: "Mon, Tue, Wed, Thu", furthestBefore: 4, furthestAfter: 5 },
    // Sunday is shut, so today is never offerable and both halves read the same.
    { today: "Sun", before: "Mon, Tue, Wed, Thu", after: "Mon, Tue, Wed, Thu", furthestBefore: 4, furthestAfter: 4 },
  ];

  for (const row of TABLE) {
    const before = offeredDays(at(row.today, "10:00"), 4);
    eq(asWeekdays(before), row.before, `${row.today} before 2:40pm offers ${row.before}`);
    eq(before.length, 4, `${row.today} before 2:40pm offers four days, never fewer`);
    eq(
      furthest(row.today, before),
      row.furthestBefore,
      `${row.today} before 2:40pm reaches +${row.furthestBefore}`,
    );

    const after = offeredDays(at(row.today, "15:00"), 4);
    eq(asWeekdays(after), row.after, `${row.today} after 2:40pm offers ${row.after}`);
    eq(after.length, 4, `${row.today} after 2:40pm offers four days, never fewer`);
    eq(
      furthest(row.today, after),
      row.furthestAfter,
      `${row.today} after 2:40pm reaches +${row.furthestAfter}`,
    );
  }
}

// --- the boundary itself --------------------------------------------------------------
//
// The table's two halves are separated by a real moment, not by a convention, and
// the moment is derived: 17:00 close, minus the 20 minute call, minus 120 minutes'
// notice, is 14:40. Asserting both sides of it proves the halves differ for the
// reason the table says they do, rather than because 10:00 and 15:00 happen to sit
// in different places.
{
  const today = "Wed";
  const justBefore = offeredDays(at(today, "14:39"), 4);
  const justAfter = offeredDays(at(today, "14:41"), 4);
  assert(
    justBefore[0] === WEEK["Wed"],
    "at 14:39 today is still offered (the last 16:40 start is still 121 minutes off)",
  );
  assert(
    justAfter[0] === WEEK["Thu"],
    "at 14:41 today has dropped out and the strip starts tomorrow",
  );
  eq(justBefore.length, 4, "the strip is four days on the near side of the boundary");
  eq(justAfter.length, 4, "and still four days on the far side, not three");
}

// --- the horizon is the only knob -----------------------------------------------------
{
  // A horizon of 1 is a legitimate setting (HORIZON_MIN), and it must read as one
  // real day rather than as an empty strip or a crash.
  const one = offeredDays(at("Thu", "10:00"), 1);
  eq(one.length, 1, "a horizon of 1 offers exactly one day");
  eq(asWeekdays(one), "Thu", "and it is today, while today is still bookable");

  const oneLate = offeredDays(at("Sat", "15:00"), 1);
  eq(asWeekdays(oneLate), "Mon", "a horizon of 1 on a Saturday afternoon walks past Sunday to Monday");

  // Every horizon in range keeps the promise the setting makes: N days offered,
  // whatever falls closed in between. Above the search allowance a run of closed
  // days can legitimately shorten the answer, which the next section covers.
  for (const n of [2, 3, 4, 5]) {
    eq(offeredDays(at("Thu", "15:00"), n).length, n, `a horizon of ${n} offers ${n} days`);
  }
}

// --- the walk is bounded, and says so by offering fewer -------------------------------
{
  // An org shut for longer than the search allowance must not spin looking for a
  // fourth bookable day. The bound is `MAX_CLOSED_RUN_DAYS` beyond the horizon, and
  // exhausting it returns FEWER days rather than an empty answer or a hang: fewer is
  // the honest report of a long closure, and the caller can tell it apart from
  // nothing at all.
  const shutAllWeek = { zone: ZONE, rules: [], exceptions: [] };
  const none = offeredDays(at("Mon", "10:00"), 4, { hours: shutAllWeek });
  eq(none.length, 0, "an org shut every day offers no days at all, rather than hanging");

  // Standing on the Friday before a shut Sunday AND a holiday Monday, the fourth
  // bookable day would be the Thursday, at +6. The search window reaches +5, so the
  // answer comes back short. That is the bound doing its job: the alternative is
  // widening the window on every bucket on every pass, forever, to cover a closure
  // that happens a handful of times a year.
  const overHoliday = offeredDays(at("Fri", "15:00"), 4, {
    hours: {
      zone: ZONE,
      rules: SEEDED_BUSINESS_HOURS,
      exceptions: [
        // The Monday AFTER the fixture week, so the closure sits inside the run.
        {
          on_date:
            DateTime.fromISO(WEEK["Mon"], { zone: ZONE }).plus({ days: 7 }).toISODate() ?? "",
          is_open: false,
          start_minute: null,
          end_minute: null,
        },
      ],
    },
  });
  assert(
    overHoliday.length < 4,
    "a Sunday plus a Monday holiday plus the Tuesday beyond the allowance shortens the answer honestly",
  );
  assert(
    overHoliday.length > 0,
    "and it is still a real answer, not an empty strip that would read as a quiet day",
  );

  eq(MAX_CLOSED_RUN_DAYS, 2, "the allowance the table was measured against is still two days");
}

// --- a shut day is skipped, never blanked ---------------------------------------------
{
  // The gap the strip draws its dashed rule for has to be a real gap in the offered
  // dates, not a chip the strip is expected to know is missing. Wednesday afternoon
  // offers Thu, Fri, Sat, Mon: the Sunday is simply absent from the list.
  const days = offeredDays(at("Wed", "15:00"), 4);
  assert(!days.includes(WEEK["Sun"]), "the shut Sunday is absent from the offered days");
  const gaps = days.filter((iso, i) => {
    if (i === 0) return false;
    const prev = DateTime.fromISO(days[i - 1], { zone: ZONE });
    return Math.round(DateTime.fromISO(iso, { zone: ZONE }).diff(prev, "days").days) > 1;
  });
  eq(gaps.length, 1, "exactly one gap in the run, which is the one the strip marks");
}

finish();
