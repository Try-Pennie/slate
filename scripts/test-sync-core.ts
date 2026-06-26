// Sanity test for the pure calendar-sync helpers.
// Run: node --experimental-strip-types scripts/test-sync-core.ts
import {
  eventWindow,
  isBusyEvent,
  partitionBusyWrites,
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

// partitionBusyWrites — busy events become upsert rows, the rest become deletes
{
  const events = [
    { id: "e1", start: { dateTime: "2026-06-08T13:00:00Z" }, end: { dateTime: "2026-06-08T13:30:00Z" } },
    { id: "e2", status: "cancelled", start: { dateTime: "x" }, end: { dateTime: "y" } },
    { id: "e3", transparency: "transparent", start: { dateTime: "2026-06-08T15:00:00Z" }, end: { dateTime: "2026-06-08T16:00:00Z" } },
    { start: { dateTime: "2026-06-08T17:00:00Z" }, end: { dateTime: "2026-06-08T18:00:00Z" } }, // no id -> skipped
  ];
  const { upserts, deletes } = partitionBusyWrites("u1", "cal-1", events);
  assert(upserts.length === 1 && upserts[0].gcal_event_id === "e1", "only the busy event becomes an upsert row");
  assert(
    upserts[0].user_id === "u1" &&
      upserts[0].calendar_id === "cal-1" &&
      upserts[0].source === "gcal" &&
      upserts[0].starts_at === "2026-06-08T13:00:00Z" &&
      upserts[0].ends_at === "2026-06-08T13:30:00Z",
    "upsert row carries user/calendar/source and the event window",
  );
  assert(
    JSON.stringify(deletes) === JSON.stringify(["e2", "e3"]),
    "cancelled + free events become deletes; the id-less event is skipped entirely",
  );
}

// partitionBusyWrites — events owned by a Slate booking (#166) are skipped
// entirely. The booking's own source=slate block is the single owner of that
// slot, so the sync must NOT mirror the Slate-created Google event into a second
// source=gcal block (the double-count) — and must NOT queue it for delete either,
// since the block's lifecycle belongs to the booking, not the sync.
{
  const events = [
    { id: "slateAAA", start: { dateTime: "2026-06-08T13:00:00Z" }, end: { dateTime: "2026-06-08T13:30:00Z" } }, // a Slate booking's event
    { id: "ext1", start: { dateTime: "2026-06-08T14:00:00Z" }, end: { dateTime: "2026-06-08T14:30:00Z" } }, // an externally-booked event
    { id: "slateBBB", status: "cancelled", start: { dateTime: "x" }, end: { dateTime: "y" } }, // a cancelled Slate event
  ];
  const slateOwned = new Set(["slateAAA", "slateBBB"]);
  const { upserts, deletes } = partitionBusyWrites("u1", "cal-1", events, slateOwned);
  assert(
    upserts.length === 1 && upserts[0].gcal_event_id === "ext1",
    "a Slate-owned event is NOT mirrored as a gcal block (only the external event upserts)",
  );
  assert(
    !deletes.includes("slateBBB") && deletes.length === 0,
    "a Slate-owned event is skipped entirely, never queued for delete (the booking owns its block)",
  );
}
{
  // No skip set -> identical to the prior behavior (every busy event mirrors).
  const events = [
    { id: "e1", start: { dateTime: "2026-06-08T13:00:00Z" }, end: { dateTime: "2026-06-08T13:30:00Z" } },
  ];
  assert(
    partitionBusyWrites("u1", "cal-1", events).upserts.length === 1,
    "no skip set -> behaves exactly as before (backward compatible)",
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
