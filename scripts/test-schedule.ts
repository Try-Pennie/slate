// Sanity test for the default working-hours rule builder (agents cron).
// Run: node --experimental-strip-types scripts/test-schedule.ts
import { defaultRuleRows } from "../src/lib/schedule-core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
