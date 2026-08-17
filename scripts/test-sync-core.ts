// Sanity test for the pure calendar-sync helpers.
// Run: node --experimental-strip-types scripts/test-sync-core.ts
import {
  eventWindow,
  isAllDayBlock,
  isBusyEvent,
  partitionBusyWrites,
  staleBlockIds,
} from "../src/lib/google/sync-core.ts";
import { assert, finish } from "./lib/harness.ts";

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
//
// #1261: this now judges only the blocks the fetch WOULD have returned. While the bootstrap
// was unbounded above, judging every cached block for the calendar was correct. The moment
// the fetch carries a timeMax, a block outside that window was never in the answer, so
// scoring it "not seen" would delete real busy time for a meeting that is still in the
// calendar and leave the agent bookable during it. That is the only way this design can
// over-delete, which is why the bounds travel from the pass that fetched them.
//
// The two bounds apply to two DIFFERENT fields, quoted from Google's events.list reference:
// timeMin is the "Lower bound (exclusive) for an event's END time" and timeMax the "Upper
// bound (exclusive) for an event's START time". So the fetched set is
// `ends_at > timeMin AND starts_at < timeMax`, and scoping on starts_at for both instead
// would leave an event that began before timeMin but ends after it inside the fetch yet
// outside the judged range: its block would then survive both this reconcile and the past
// prune permanently, over-blocking a readable slot with nothing able to clear it.
const WIN = { timeMinIso: "2026-06-08T00:00:00.000Z", timeMaxIso: "2026-06-29T00:00:00.000Z" };
const inWindow = (id: string, eventId: string | null) => ({
  id,
  gcal_event_id: eventId,
  starts_at: "2026-06-10T13:00:00.000Z",
  ends_at: "2026-06-10T13:30:00.000Z",
});
const blocks = [inWindow("b1", "e1"), inWindow("b2", "e2"), inWindow("b3", null)];
assert(
  JSON.stringify(staleBlockIds(blocks, new Set(["e1"]), WIN)) === JSON.stringify(["b2"]),
  "blocks whose event id wasn't seen are stale (null event id ignored)",
);
assert(
  staleBlockIds(blocks, new Set(["e1", "e2"]), WIN).length === 0,
  "all seen -> nothing stale",
);

// The behaviour the issue asks for, asserted as BEHAVIOUR. Comparing the reconcile's range
// to the fetch's range would compare a value to itself and pass while the semantics were
// wrong, so each case is built from a block and an answer instead.
{
  // Straddles the LOWER bound: began before timeMin, ends after it. Google returns it
  // (timeMin bounds the END time), so it is in the judged set.
  const straddlesLower = {
    id: "lower",
    gcal_event_id: "eL",
    starts_at: "2026-06-07T22:00:00.000Z",
    ends_at: "2026-06-08T02:00:00.000Z",
  };
  assert(
    staleBlockIds([straddlesLower], new Set(["eL"]), WIN).length === 0,
    "a block straddling the lower bound whose event is STILL PRESENT survives",
  );
  assert(
    JSON.stringify(staleBlockIds([straddlesLower], new Set(), WIN)) === JSON.stringify(["lower"]),
    "and the same block is removed once its event has VANISHED",
  );

  // Straddles the UPPER bound: starts before timeMax, ends after it. Google returns it
  // (timeMax bounds the START time), so it is judged too.
  const straddlesUpper = {
    id: "upper",
    gcal_event_id: "eU",
    starts_at: "2026-06-28T22:00:00.000Z",
    ends_at: "2026-06-29T02:00:00.000Z",
  };
  assert(
    staleBlockIds([straddlesUpper], new Set(["eU"]), WIN).length === 0,
    "a block straddling the upper bound whose event is still present survives",
  );
  assert(
    JSON.stringify(staleBlockIds([straddlesUpper], new Set(), WIN)) === JSON.stringify(["upper"]),
    "and is removed once its event has vanished",
  );

  // ENTIRELY OUTSIDE the window, in both directions. The fetch never asked about these, so
  // an empty answer says nothing about them and they must be left alone. This is the case
  // that turns a bounded fetch into deleted busy time if it is got wrong.
  const beforeWindow = {
    id: "before",
    gcal_event_id: "eB",
    starts_at: "2026-06-01T09:00:00.000Z",
    ends_at: "2026-06-01T10:00:00.000Z",
  };
  const afterWindow = {
    id: "after",
    gcal_event_id: "eA",
    starts_at: "2026-07-15T09:00:00.000Z",
    ends_at: "2026-07-15T10:00:00.000Z",
  };
  assert(
    staleBlockIds([beforeWindow, afterWindow], new Set(), WIN).length === 0,
    "blocks entirely outside the fetched window are NEVER stale, however empty the answer",
  );
  // And the positive control for that claim, in the same fixture: an in-window block with
  // the same empty answer IS removed. Without this the assertion above would pass on a
  // function that had simply stopped deleting anything (L159).
  assert(
    JSON.stringify(staleBlockIds([beforeWindow, afterWindow, inWindow("mid", "eM")], new Set(), WIN)) ===
      JSON.stringify(["mid"]),
    "while an in-window block with the same empty answer IS removed",
  );

  // A block with an unreadable stamp is left alone. Date.parse gives NaN, every comparison
  // with NaN is false, and the fail-safe side of "is this inside the fetched window" is to
  // treat it as outside and not delete it (L50).
  const unreadable = {
    id: "bad",
    gcal_event_id: "eX",
    starts_at: "not-a-date",
    ends_at: "not-a-date",
  };
  assert(
    staleBlockIds([unreadable], new Set(), WIN).length === 0,
    "a block with an unreadable time is never deleted, because we cannot tell it was fetched",
  );
}

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
// partitionBusyWrites: two DISTINCT gcal events that occupy the identical window
// are BOTH kept. This is the legitimate "duplicate busy block" from #739 (a daily
// recurring hold coinciding with a weekly one at the same local time). They carry
// different gcal_event_ids, so the (user_id, gcal_event_id) unique index is
// satisfied and both belong in the cache. Only a SAME id (deduped by the index) or
// a Slate-owned mirror (#166, suppressed above) collapses; coincident distinct
// events must not.
{
  const win = { start: { dateTime: "2026-06-08T19:30:00Z" }, end: { dateTime: "2026-06-08T20:00:00Z" } };
  const events = [
    { id: "dailyHold_20260608T193000Z", ...win },
    { id: "weeklyHold_20260608T193000Z", ...win },
  ];
  const { upserts, deletes } = partitionBusyWrites("u1", "cal-1", events);
  assert(
    upserts.length === 2 &&
      upserts.every((u) => u.starts_at === "2026-06-08T19:30:00Z" && u.ends_at === "2026-06-08T20:00:00Z"),
    "#739: two distinct gcal events at the identical window both upsert (not a bug, not collapsed)",
  );
  assert(deletes.length === 0, "#739: coincident distinct events are not treated as stale/dup deletes");
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

// isAllDayBlock (#744): read the #616 convention back off a STORED block, so a
// Google-native all-day OOO can discount an agent from tier staffing depth. A
// block is all-day when both ends land exactly on local midnight in the agent's
// own timezone.
{
  const ET = "America/New_York";
  assert(
    isAllDayBlock("2026-07-09T04:00:00.000Z", "2026-07-10T04:00:00.000Z", ET),
    "ET all-day block (local n to n) is all-day",
  );
  assert(
    isAllDayBlock("2026-07-06T04:00:00.000Z", "2026-07-10T04:00:00.000Z", ET),
    "multi-day ET all-day block (a vacation) is all-day",
  );
  assert(
    !isAllDayBlock("2026-07-09T13:00:00.000Z", "2026-07-09T13:30:00.000Z", ET),
    "a timed 30-minute meeting is not all-day",
  );
  assert(
    !isAllDayBlock("2026-07-09T13:00:00.000Z", "2026-07-09T21:00:00.000Z", ET),
    "a timed block covering the whole workday is still not all-day",
  );
  // The same instants are NOT local n in another zone: an ET agent's
  // all-day block must not read as all-day for a PT agent.
  assert(
    !isAllDayBlock("2026-07-09T04:00:00.000Z", "2026-07-10T04:00:00.000Z", "America/Los_Angeles"),
    "ET-anchored block is not all-day when read in PT",
  );
  assert(
    isAllDayBlock("2026-07-09T07:00:00.000Z", "2026-07-10T07:00:00.000Z", "America/Los_Angeles"),
    "PT all-day block (local n to n) is all-day",
  );
  // DST: 2026-11-01 ET falls back, so this local day is 25 hours, not 24. A
  // duration check would miss it; anchoring on local n does not.
  assert(
    isAllDayBlock("2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", ET),
    "a 25-hour DST fall-back day is still all-day",
  );
  assert(
    !isAllDayBlock("2026-07-09T04:00:00.000Z", "2026-07-09T04:00:00.000Z", ET),
    "a zero-length block is not all-day",
  );
  assert(
    isAllDayBlock("2026-07-09T00:00:00.000Z", "2026-07-10T00:00:00.000Z", "Not/AZone"),
    "an unusable zone falls back to UTC n (matches allDayToUtc)",
  );
}

finish();
