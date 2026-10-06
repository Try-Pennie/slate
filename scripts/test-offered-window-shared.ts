// The booker's offered window and its served slot rule, shared (2026-10-02).
//
// The booker offers a lead the next OFFERED_OPEN_DAYS open days, and on a rung
// below a top tier lead's own tier only the times an advisor without Low is free.
// The bucket availability page has to say what that produces, so both sides call
// these two pure functions rather than each holding a copy.
//
// Run: node --experimental-strip-types scripts/test-offered-window-shared.ts
import { offeredWindowEndFor, servedSlotsForRung, todayCountsUntilLabel } from "../src/lib/availability/offered-window.ts";
import { OFFERED_OPEN_DAYS } from "../src/lib/availability/bookable-days.ts";
import { eq, finish } from "./lib/harness.ts";

const WEEK = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
  exceptions: [],
};

eq(OFFERED_OPEN_DAYS, 3, "the booker offers three open days");
// Thursday 2026-08-06 at 11:19 ET with two hours' notice: Thursday, Friday, and
// Monday (the weekend is shut), so the window closes Monday at 17:00 ET.
eq(
  offeredWindowEndFor(WEEK, Date.parse("2026-08-06T15:19:00.000Z"), 120),
  Date.parse("2026-08-10T21:00:00.000Z"),
  "the window spans three OPEN days, skipping a shut weekend",
);
// At 15:30 ET a two hour notice reaches past the close, so today does not count.
eq(
  offeredWindowEndFor(WEEK, Date.parse("2026-08-06T19:30:00.000Z"), 120),
  Date.parse("2026-08-11T21:00:00.000Z"),
  "a today nobody can still book does not spend one of the three days",
);

// #3438: today counts toward the three days only before 6:00pm New York time
// (Dan, 2026-10-06). Advisors' shifts end before the business does, so in the
// evening today had no times and still spent a day. The business week here is
// the live one (Mon to Sat, 08:00 to 20:00), and notice is the live 5 minutes,
// so the old rule alone would still count today at 17:59 AND at 18:00: only the
// cutoff separates the pairs below.
{
  const LIVE = {
    zone: "America/New_York",
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
    exceptions: [],
  };
  // Tuesday 2026-10-06, daylight time (UTC-4).
  eq(
    offeredWindowEndFor(LIVE, Date.parse("2026-10-06T21:59:00.000Z"), 5),
    Date.parse("2026-10-09T00:00:00.000Z"),
    "at 5:59pm EDT today counts: Tuesday, Wednesday, Thursday, closing Thursday 8pm",
  );
  eq(
    offeredWindowEndFor(LIVE, Date.parse("2026-10-06T22:00:00.000Z"), 5),
    Date.parse("2026-10-10T00:00:00.000Z"),
    "at 6:00pm EDT today no longer counts: Wednesday, Thursday, Friday",
  );
  // Tuesday 2026-12-08, standard time (UTC-5). 22:30Z is 5:30pm EST: a cutoff held
  // as a fixed offset from UTC would read it as 6:30pm and drop today wrongly.
  eq(
    offeredWindowEndFor(LIVE, Date.parse("2026-12-08T22:30:00.000Z"), 5),
    Date.parse("2026-12-11T01:00:00.000Z"),
    "at 5:30pm EST today still counts, so the cutoff follows the wall clock across daylight saving",
  );
  eq(
    offeredWindowEndFor(LIVE, Date.parse("2026-12-08T23:00:00.000Z"), 5),
    Date.parse("2026-12-12T01:00:00.000Z"),
    "at 6:00pm EST today no longer counts",
  );
  // Saturday 2026-10-10 at 6:30pm EDT: Sunday is shut, so the next three open
  // days are Monday, Tuesday and Wednesday.
  eq(
    offeredWindowEndFor(LIVE, Date.parse("2026-10-10T22:30:00.000Z"), 5),
    Date.parse("2026-10-15T00:00:00.000Z"),
    "after 6pm on Saturday the strip starts Monday, past a shut Sunday",
  );
}

// The admin page states the cutoff in words built from the same constant.
eq(todayCountsUntilLabel(), "6pm New York time", "the cutoff is said the way the rule holds it");

const row = { slots: ["a", "b"], slotsWithoutLow: ["b"] };
eq(servedSlotsForRung("511", "511", row), ["a", "b"], "a lead's own rung serves every time");
eq(servedSlotsForRung("511", "211", row), ["b"], "a top tier lead's lower tier rung serves only times without Low");
eq(servedSlotsForRung("511", "211", { slots: ["a"] }), [], "and an unknown list without Low serves nothing");
eq(servedSlotsForRung("311", "111", row), ["a", "b"], "a High lead is not a top tier lead");

finish();
