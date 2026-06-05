// Sanity test for the pure calendar-sync helpers.
// Run: node --experimental-strip-types scripts/test-sync-core.ts
import {
  eventWindow,
  isBusyEvent,
  staleBlockIds,
} from "../src/lib/google/sync-core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

// eventWindow
assert(
  JSON.stringify(eventWindow({ start: { dateTime: "2026-06-08T13:00:00Z" }, end: { dateTime: "2026-06-08T13:30:00Z" } })) ===
    JSON.stringify({ start: "2026-06-08T13:00:00Z", end: "2026-06-08T13:30:00Z" }),
  "timed event keeps its dateTimes",
);
assert(
  JSON.stringify(eventWindow({ start: { date: "2026-06-08" }, end: { date: "2026-06-09" } })) ===
    JSON.stringify({ start: "2026-06-08T00:00:00.000Z", end: "2026-06-09T00:00:00.000Z" }),
  "all-day event expands date to midnight UTC",
);
assert(eventWindow({ start: {}, end: {} }) === null, "event with no times yields null");

// isBusyEvent
assert(isBusyEvent({ start: { dateTime: "2026-06-08T13:00:00Z" }, end: { dateTime: "2026-06-08T13:30:00Z" } }), "normal timed event is busy");
assert(!isBusyEvent({ status: "cancelled", start: { dateTime: "x" }, end: { dateTime: "y" } }), "cancelled event is not busy");
assert(!isBusyEvent({ transparency: "transparent", start: { dateTime: "2026-06-08T13:00:00Z" }, end: { dateTime: "2026-06-08T13:30:00Z" } }), "free (transparent) event is not busy");
assert(!isBusyEvent({ start: {}, end: {} }), "timeless event is not busy");

// staleBlockIds
const blocks = [
  { id: "b1", gcal_event_id: "e1" },
  { id: "b2", gcal_event_id: "e2" },
  { id: "b3", gcal_event_id: null },
];
assert(
  JSON.stringify(staleBlockIds(blocks, new Set(["e1"]))) === JSON.stringify(["b2"]),
  "blocks whose event id wasn't seen are stale (null event id ignored)",
);
assert(staleBlockIds(blocks, new Set(["e1", "e2"])).length === 0, "all seen -> nothing stale");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
