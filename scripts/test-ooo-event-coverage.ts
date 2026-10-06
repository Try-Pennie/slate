// #3360: does the agent's time off event still cover the APPROVED window?
//
// The judge both the calendar sync (at the moment it sees an edit) and the monitor
// lane (every 5 minutes, and the only place the all-clear is decided) read, so the
// page and its ending can never mean two different things. Pure interval
// arithmetic, so every branch is pinned here with no clock and no network.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ooo-event-coverage.ts
import {
  judgeEventCoverage,
  uncoveredSpans,
  OOO_EVENT_TOLERANCE_MS,
} from "../src/lib/ooo/event-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ms = (iso: string) => Date.parse(iso);
const MIN = 60_000;

// The real 2026-10-06 shape: approved all of Wednesday 2026-10-07 in MT (06:00Z to
// 05:59Z next day), and the event edited to start at 11:30 AM MT (17:30Z).
const approved = { startsAt: "2026-10-07T06:00:00.000Z", endsAt: "2026-10-08T05:59:00.000Z" };
const before = ms("2026-10-06T09:00:00.000Z");

// --- uncoveredSpans -------------------------------------------------------------
{
  const w = { startMs: ms(approved.startsAt), endMs: ms(approved.endsAt) };
  eq(
    uncoveredSpans(w, [{ startMs: ms("2026-10-07T17:30:00.000Z"), endMs: w.endMs }]),
    [{ startMs: w.startMs, endMs: ms("2026-10-07T17:30:00.000Z") }],
    "an event starting late leaves exactly the head of the window open",
  );
  eq(uncoveredSpans(w, [{ ...w }]), [], "an exact event leaves nothing open");
  eq(uncoveredSpans(w, []), [{ ...w }], "no cover at all leaves the whole window open");
  eq(
    uncoveredSpans(w, [
      { startMs: w.startMs, endMs: ms("2026-10-07T12:00:00.000Z") },
      { startMs: ms("2026-10-07T14:00:00.000Z"), endMs: w.endMs },
    ]),
    [{ startMs: ms("2026-10-07T12:00:00.000Z"), endMs: ms("2026-10-07T14:00:00.000Z") }],
    "a hole in the middle is reported as the hole, between two covers",
  );
  eq(
    uncoveredSpans(w, [
      { startMs: w.startMs, endMs: ms("2026-10-07T14:00:00.000Z") },
      { startMs: ms("2026-10-07T12:00:00.000Z"), endMs: w.endMs },
    ]),
    [],
    "overlapping covers merge into one",
  );
  eq(
    uncoveredSpans(w, [{ startMs: w.startMs - 3_600_000, endMs: w.endMs + 3_600_000 }]),
    [],
    "a WIDER event covers the window: nothing approved is open",
  );
  // The tolerance is the verify command's default, so a one minute rounding never
  // pages from the sync while the command calls the same pair verified (L107).
  eq(OOO_EVENT_TOLERANCE_MS, MIN, "tolerance matches verify:ooo-protection's default of one minute");
  eq(
    uncoveredSpans(w, [{ startMs: w.startMs + MIN, endMs: w.endMs - MIN }]),
    [],
    "a sliver of one minute at either end is rounding, not a gap",
  );
  eq(
    uncoveredSpans(w, [{ startMs: w.startMs + MIN + 1, endMs: w.endMs }]),
    [{ startMs: w.startMs, endMs: w.startMs + MIN + 1 }],
    "just past the tolerance IS a gap: the boundary is not widened silently",
  );
}

// --- judgeEventCoverage ------------------------------------------------------------
{
  const shortened = judgeEventCoverage({
    ...approved,
    nowMs: before,
    cover: [{ startsAt: "2026-10-07T17:30:00.000Z", endsAt: approved.endsAt }],
  });
  assert(shortened.kind === "uncovered", "the measured case is judged uncovered");
  if (shortened.kind === "uncovered") {
    eq(shortened.spans.length, 1, "one open span");
    eq(
      shortened.spans[0]!.endMs - shortened.spans[0]!.startMs,
      690 * MIN,
      "the open span is the 690 minutes verify:ooo-protection reported",
    );
  }

  eq(
    judgeEventCoverage({ ...approved, nowMs: before, cover: [{ ...approved }] }).kind,
    "covered",
    "an event matching the request is covered",
  );
  eq(
    judgeEventCoverage({ ...approved, nowMs: before, cover: null }).kind,
    "not-blocking",
    "no busy event at all (deleted, cancelled, marked free) is its own verdict",
  );
  eq(
    judgeEventCoverage({ ...approved, nowMs: before, cover: [] }).kind,
    "not-blocking",
    "an empty cover list reads the same as no event, never as covered",
  );

  // Only the part of the window still ahead is judged: hours already passed cannot
  // be booked into, and paging about them asks for work nobody can do.
  const midday = ms("2026-10-07T18:00:00.000Z");
  eq(
    judgeEventCoverage({
      ...approved,
      nowMs: midday,
      cover: [{ startsAt: "2026-10-07T17:30:00.000Z", endsAt: approved.endsAt }],
    }).kind,
    "covered",
    "an open head that is already in the past is not a finding",
  );
  eq(
    judgeEventCoverage({ ...approved, nowMs: ms(approved.endsAt) + 1, cover: null }).kind,
    "passed",
    "a window entirely in the past is passed, whatever the calendar says",
  );

  // Unreadable stamps are never coverage and never a finding (L50): they cannot be
  // compared, so they are reported as such.
  eq(
    judgeEventCoverage({ startsAt: "garbage", endsAt: approved.endsAt, nowMs: before, cover: null })
      .kind,
    "unreadable",
    "an unreadable approved window is unreadable, not a finding",
  );
  eq(
    judgeEventCoverage({
      ...approved,
      nowMs: before,
      cover: [{ startsAt: "nope", endsAt: approved.endsAt }],
    }).kind,
    "unreadable",
    "an unreadable cover is unreadable, never silently dropped into a gap",
  );
}

finish();
