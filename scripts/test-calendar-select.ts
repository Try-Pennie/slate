// Sanity test for the calendar busy-aggregation filter.
// Run: node --experimental-strip-types scripts/test-calendar-select.ts
import { selectableCalendarIds } from "../src/lib/google/calendar-select.ts";
import type { CalendarListEntry } from "../src/lib/google/calendar.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const entries: CalendarListEntry[] = [
  { id: "agent@trypennie.com", accessRole: "owner", primary: true },
  { id: "side-project@group.calendar.google.com", accessRole: "owner" },
  { id: "team-ooo@group.calendar.google.com", accessRole: "writer" },
  { id: "followed-team@group.calendar.google.com", accessRole: "reader" },
  { id: "freebusy-only@group.calendar.google.com", accessRole: "freeBusyReader" },
  { id: "en.usa#holiday@group.v.calendar.google.com", accessRole: "reader" },
  { id: "addressbook#contacts@group.v.calendar.google.com", accessRole: "reader" },
  { id: "deleted-cal@group.calendar.google.com", accessRole: "owner", deleted: true },
  { id: "deleted-primary@trypennie.com", accessRole: "owner", primary: true, deleted: true },
  { id: "", accessRole: "owner", primary: true },
];

const ids = selectableCalendarIds(entries);

assert(ids.includes("agent@trypennie.com"), "includes the primary calendar");
assert(
  !ids.includes("side-project@group.calendar.google.com"),
  "excludes owned secondary calendars (primary-only rule, #42)",
);
assert(
  !ids.includes("team-ooo@group.calendar.google.com"),
  "excludes writable shared team calendars (one teammate's OOO must not block everyone)",
);
assert(!ids.includes("followed-team@group.calendar.google.com"), "excludes read-only subscriptions");
assert(!ids.includes("freebusy-only@group.calendar.google.com"), "excludes freeBusyReader calendars");
assert(!ids.some((id) => id.includes("#holiday@")), "excludes holiday calendars");
assert(!ids.some((id) => id.includes("#contacts@")), "excludes birthday/contacts calendars");
assert(!ids.includes("deleted-cal@group.calendar.google.com"), "excludes deleted calendars");
assert(!ids.includes("deleted-primary@trypennie.com"), "excludes a deleted primary");
assert(!ids.includes(""), "excludes entries with no id");
assert(ids.length === 1, `keeps exactly the primary calendar (got ${ids.length})`);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
