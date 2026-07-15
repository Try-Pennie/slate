// Verify-on-book calendar-list resolution (#314): a FAILED read of an agent's
// calendars must be distinguishable from a genuine "no calendars yet" so the
// caller can skip the agent (never verify against an unknown calendar set and
// risk a double-book) rather than silently checking only the primary calendar.
import {
  calendarIdsFromResult,
  freeAgentsFromBusy,
  busyByCalendarFromResponse,
} from "../src/lib/booking/core.ts";
import { assert, finish } from "./lib/harness.ts";

// A real query error -> readFailed, no ids. The caller skips the agent + alerts.
{
  const r = calendarIdsFromResult({ data: null, error: { message: "boom" } });
  assert(r.readFailed === true, "a query error is flagged readFailed");
  assert(r.ids.length === 0, "a failed read yields no calendar ids");
}

// Rows present, no error -> the calendar ids, not failed.
{
  const r = calendarIdsFromResult({
    data: [{ calendar_id: "primary" }, { calendar_id: "team@x.com" }],
    error: null,
  });
  assert(r.readFailed === false, "a clean read is not failed");
  assert(
    JSON.stringify(r.ids) === JSON.stringify(["primary", "team@x.com"]),
    "returns the calendar ids in order",
  );
}

// Genuine empty (no rows, no error) -> NOT failed, empty ids. This is the
// pre-first-sync case; the caller falls back to the primary calendar as before.
{
  const r = calendarIdsFromResult({ data: [], error: null });
  assert(r.readFailed === false && r.ids.length === 0, "empty-with-no-error is a clean empty, not a failure");
}
{
  const r = calendarIdsFromResult({ data: null, error: null });
  assert(r.readFailed === false && r.ids.length === 0, "null-data-no-error is a clean empty, not a failure");
}

// --- freeAgentsFromBusy: map a bulk freeBusy response back to free agents ---
// The single-call verifier queries many agents' calendars in one cross-identity
// freeBusy call (#167). This pure step decides, per agent, free vs busy vs
// "couldn't tell -> fall back to a direct per-agent check". An agent is free
// only if EVERY one of their calendars resolved cleanly AND none overlaps the
// slot — anything unread (missing/error) is never assumed free (no double-book).
const START = Date.parse("2026-06-08T13:00:00.000Z");
const END = Date.parse("2026-06-08T13:30:00.000Z");
const overlapping = [{ start: "2026-06-08T13:15:00.000Z", end: "2026-06-08T13:45:00.000Z" }];

{
  // Single-calendar agent, no busy -> free.
  const r = freeAgentsFromBusy(
    [{ email: "a@x", calendarIds: ["a@x"] }],
    new Map([["a@x", { busy: [], error: false }]]),
    START,
    END,
  );
  assert(r.free.has("a@x"), "clean, no busy -> free");
  assert(r.needsFallback.size === 0, "clean agent needs no fallback");
}

{
  // Overlapping busy -> definitively busy (not free, no fallback).
  const r = freeAgentsFromBusy(
    [{ email: "a@x", calendarIds: ["a@x"] }],
    new Map([["a@x", { busy: overlapping, error: false }]]),
    START,
    END,
  );
  assert(!r.free.has("a@x"), "overlapping busy -> not free");
  assert(!r.needsFallback.has("a@x"), "a cleanly-read busy agent needs no fallback");
}

{
  // Non-overlapping busy (abutting the slot end) -> free; boundaries are exclusive.
  const abutting = [{ start: "2026-06-08T13:30:00.000Z", end: "2026-06-08T14:00:00.000Z" }];
  const r = freeAgentsFromBusy(
    [{ email: "a@x", calendarIds: ["a@x"] }],
    new Map([["a@x", { busy: abutting, error: false }]]),
    START,
    END,
  );
  assert(r.free.has("a@x"), "busy starting exactly at slot end does not overlap -> free");
}

{
  // Multi-calendar agent: busy on a SECONDARY calendar makes them unavailable.
  const r = freeAgentsFromBusy(
    [{ email: "a@x", calendarIds: ["a@x", "team@x"] }],
    new Map([
      ["a@x", { busy: [], error: false }],
      ["team@x", { busy: overlapping, error: false }],
    ]),
    START,
    END,
  );
  assert(!r.free.has("a@x"), "busy on any one calendar -> not free");
  assert(!r.needsFallback.has("a@x"), "all calendars read cleanly -> no fallback");
}

{
  // A per-calendar error -> can't conclude; agent needs a direct fallback check.
  const r = freeAgentsFromBusy(
    [{ email: "a@x", calendarIds: ["a@x", "team@x"] }],
    new Map([
      ["a@x", { busy: [], error: false }],
      ["team@x", { busy: [], error: true }],
    ]),
    START,
    END,
  );
  assert(!r.free.has("a@x"), "an errored calendar is never assumed free");
  assert(r.needsFallback.has("a@x"), "an errored calendar routes the agent to fallback");
}

{
  // A calendar missing from the response entirely -> fallback (never assume free).
  const r = freeAgentsFromBusy(
    [{ email: "a@x", calendarIds: ["a@x"] }],
    new Map(),
    START,
    END,
  );
  assert(!r.free.has("a@x") && r.needsFallback.has("a@x"), "missing calendar -> fallback");
}

{
  // Mixed batch: one free, one busy, one needs fallback — all classified at once.
  const r = freeAgentsFromBusy(
    [
      { email: "free@x", calendarIds: ["free@x"] },
      { email: "busy@x", calendarIds: ["busy@x"] },
      { email: "err@x", calendarIds: ["err@x"] },
    ],
    new Map([
      ["free@x", { busy: [], error: false }],
      ["busy@x", { busy: overlapping, error: false }],
      ["err@x", { busy: [], error: true }],
    ]),
    START,
    END,
  );
  assert(r.free.has("free@x") && r.free.size === 1, "mixed: only the clean-free agent is free");
  assert(r.needsFallback.has("err@x") && r.needsFallback.size === 1, "mixed: only the errored agent falls back");
}

// --- busyByCalendarFromResponse: parse a bulk freeBusy response safely ---
// Anything Google didn't return cleanly (absent key or an `errors` entry) MUST
// become error:true so the downstream classifier never assumes that calendar free.
{
  const m = busyByCalendarFromResponse(["a@x", "b@x", "c@x"], {
    "a@x": { busy: [{ start: "2026-06-08T13:00:00.000Z", end: "2026-06-08T13:30:00.000Z" }] },
    "b@x": { errors: [{ domain: "calendar", reason: "tooManyCalendarsRequested" }] },
    // c@x absent from the response entirely
  });
  assert(m.get("a@x")?.error === false && m.get("a@x")?.busy.length === 1, "parses a clean busy calendar");
  assert(m.get("b@x")?.error === true, "a calendar with errors is marked error");
  assert(m.get("c@x")?.error === true, "a calendar absent from the response is marked error");
}

{
  // A busy entry missing start/end is dropped; undefined calendars -> all error.
  const m = busyByCalendarFromResponse(["a@x"], {
    "a@x": { busy: [{ start: "2026-06-08T13:00:00.000Z" }, { start: "x", end: "y" }] },
  });
  assert(m.get("a@x")?.busy.length === 1, "drops a busy entry missing start or end");
  const none = busyByCalendarFromResponse(["a@x"], undefined);
  assert(none.get("a@x")?.error === true, "no calendars object -> every requested id is error");
}

finish();
