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
// all-day events (#616): without a timezone the window defaults to UTC midnight
// (isBusyEvent only needs null-ness); WITH an agent timezone it anchors to LOCAL
// midnight so the block matches the agent's actual all-day OOO/holiday. Google's
// end.date is EXCLUSIVE (the day after), so a single all-day event blocks exactly
// the local 00:00-24:00 with no bleed into adjacent days.
assert(
  JSON.stringify(eventWindow({ start: { date: "2026-06-08" }, end: { date: "2026-06-09" } })) ===
    JSON.stringify({ start: "2026-06-08T00:00:00.000Z", end: "2026-06-09T00:00:00.000Z" }),
  "all-day event without a tz defaults to midnight UTC",
);
assert(
  JSON.stringify(eventWindow({ start: { date: "2026-07-04" }, end: { date: "2026-07-05" } }, "America/New_York")) ===
    JSON.stringify({ start: "2026-07-04T04:00:00.000Z", end: "2026-07-05T04:00:00.000Z" }),
  "all-day event in ET (summer/EDT) blocks local 00:00-24:00 (04:00Z), not UTC midnight",
);
assert(
  JSON.stringify(eventWindow({ start: { date: "2026-07-04" }, end: { date: "2026-07-05" } }, "America/Los_Angeles")) ===
    JSON.stringify({ start: "2026-07-04T07:00:00.000Z", end: "2026-07-05T07:00:00.000Z" }),
  "all-day event in PT (summer/PDT) anchors to local midnight (07:00Z)",
);
assert(
  JSON.stringify(eventWindow({ start: { date: "2026-01-15" }, end: { date: "2026-01-16" } }, "America/New_York")) ===
    JSON.stringify({ start: "2026-01-15T05:00:00.000Z", end: "2026-01-16T05:00:00.000Z" }),
  "all-day event in ET (winter/EST) uses the DST-correct offset (05:00Z)",
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

// partitionBusyWrites: events owned by a Slate booking (#166) are NEVER mirrored
// into a second source=gcal block (the double-count). They ARE queued for delete
// (#586): if a push-sync raced the booking's create and cached a stray source=gcal
// mirror before the booking committed, this deletes it. The delete targets gcal
// rows by gcal_event_id, so the booking's own source=slate block (null
// gcal_event_id) is never matched, and its lifecycle still belongs to the booking.
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
    deletes.includes("slateAAA") && deletes.includes("slateBBB"),
    "a Slate-owned event is queued for delete to clear any stray gcal mirror (#586)",
  );
  assert(
    !deletes.includes("ext1"),
    "an external busy event is upserted, not deleted",
  );
}
// partitionBusyWrites threads the agent timezone into all-day windows (#616) so
// an OOO/holiday block lands on the agent's local day, not UTC midnight.
{
  const events = [
    { id: "ooo", start: { date: "2026-07-04" }, end: { date: "2026-07-05" } },
  ];
  const { upserts } = partitionBusyWrites("u1", "cal-1", events, new Set(), "America/New_York");
  assert(
    upserts.length === 1 &&
      upserts[0].starts_at === "2026-07-04T04:00:00.000Z" &&
      upserts[0].ends_at === "2026-07-05T04:00:00.000Z",
    "all-day OOO upserts a local-midnight-anchored block for an ET agent",
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
