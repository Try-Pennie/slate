// The booker's offered window and its served slot rule, shared (2026-10-02).
//
// The booker offers a lead the next OFFERED_OPEN_DAYS open days, and on a rung
// below a top tier lead's own tier only the times an advisor without Low is free.
// The bucket availability page has to say what that produces, so both sides call
// these two pure functions rather than each holding a copy.
//
// Run: node --experimental-strip-types scripts/test-offered-window-shared.ts
import { offeredWindowEndFor, servedSlotsForRung } from "../src/lib/availability/offered-window.ts";
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

const row = { slots: ["a", "b"], slotsWithoutLow: ["b"] };
eq(servedSlotsForRung("511", "511", row), ["a", "b"], "a lead's own rung serves every time");
eq(servedSlotsForRung("511", "211", row), ["b"], "a top tier lead's lower tier rung serves only times without Low");
eq(servedSlotsForRung("511", "211", { slots: ["a"] }), [], "and an unknown list without Low serves nothing");
eq(servedSlotsForRung("311", "111", row), ["a", "b"], "a High lead is not a top tier lead");

finish();
