// Sanity test for the default working-hours rule builder (agents cron).
// Run: node --experimental-strip-types scripts/test-schedule.ts
import {
  defaultRuleRows,
  SEED_START_MINUTE,
  SEED_END_MINUTE,
  SEED_START_TIME,
  SEED_END_TIME,
  minutesToTime,
} from "../src/lib/schedule-core.ts";
import { assert, finish } from "./lib/harness.ts";

const org = {
  default_timezone: "America/New_York",
  default_start_minute: 540,
  default_end_minute: 1020,
  default_weekdays: [1, 2, 3, 4, 5],
};

const rows = defaultRuleRows("sched-1", org);
assert(rows.length === 5, "one rule per default weekday");
assert(
  rows.every(
    (r) =>
      r.schedule_id === "sched-1" &&
      r.start_minute === 540 &&
      r.end_minute === 1020,
  ),
  "rows carry the schedule id and 9:00-17:00 minutes",
);
assert(
  rows.map((r) => r.weekday).join(",") === "1,2,3,4,5",
  "weekdays are Luxon Mon..Fri",
);
assert(
  defaultRuleRows("s", { ...org, default_weekdays: [] }).length === 0,
  "no weekdays -> no rows",
);
assert(
  defaultRuleRows("s", { ...org, default_end_minute: 540 }).length === 0,
  "degenerate window (end <= start) -> no rows",
);

// --- #1299: the seed working day lives in ONE place --------------------------------
//
// 09:00 was written out by hand in three places that have to move together: the org
// defaults a new agent inherits, the admin form's fallback when the field is blank,
// and the smoke seed. Three copies of a number that must agree is how a backfill
// silently reverts, so the number now has one home and both call sites read it.
{
  assert(SEED_START_MINUTE === 8 * 60, "the seeded day starts at 08:00, expressed in minutes");
  assert(SEED_END_MINUTE === 17 * 60, "the seeded day still ends at 17:00");
  assert(
    SEED_END_MINUTE > SEED_START_MINUTE,
    "the seeded window is not degenerate, which defaultRuleRows would silently drop",
  );

  // The form fallbacks are the SAME value, formatted, rather than a second literal.
  assert(SEED_START_TIME === "08:00", `the form fallback start is derived, not typed (got ${SEED_START_TIME})`);
  assert(SEED_END_TIME === "17:00", `the form fallback end is derived, not typed (got ${SEED_END_TIME})`);
  assert(
    minutesToTime(SEED_START_MINUTE) === SEED_START_TIME &&
      minutesToTime(SEED_END_MINUTE) === SEED_END_TIME,
    "the two forms of the seed day cannot drift: one is computed from the other",
  );

  // Zero-padding, since a fallback of "8:00" would not parse as a time input value.
  assert(minutesToTime(9 * 60 + 5) === "09:05", "minutesToTime zero-pads both halves");
  assert(minutesToTime(0) === "00:00", "midnight formats as 00:00, not 0:0");
  assert(minutesToTime(23 * 60 + 59) === "23:59", "the last minute of the day formats correctly");

  // And an org built from the seed produces the day agents actually get.
  const seeded = defaultRuleRows("s", {
    default_timezone: "America/New_York",
    default_start_minute: SEED_START_MINUTE,
    default_end_minute: SEED_END_MINUTE,
    default_weekdays: [1, 2, 3, 4, 5],
  });
  assert(seeded.length === 5, "the seeded org gives a new agent five weekday rules");
  assert(
    seeded.every((r) => r.start_minute === 480 && r.end_minute === 1020),
    "a newly synced agent starts at 08:00 like the backfilled roster, not 09:00",
  );
}

finish();
