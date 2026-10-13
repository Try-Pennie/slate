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
// A horizon well past every window above, so those cases are judged exactly as before.
const FAR = ms("2027-01-01T00:00:00.000Z");

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
    measuredUntilMs: FAR,
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
    judgeEventCoverage({ ...approved, nowMs: before, measuredUntilMs: FAR, cover: [{ ...approved }] }).kind,
    "covered",
    "an event matching the request is covered",
  );
  eq(
    judgeEventCoverage({ ...approved, nowMs: before, measuredUntilMs: FAR, cover: null }).kind,
    "not-blocking",
    "no busy event at all (deleted, cancelled, marked free) is its own verdict",
  );
  eq(
    judgeEventCoverage({ ...approved, nowMs: before, measuredUntilMs: FAR, cover: [] }).kind,
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
      measuredUntilMs: FAR,
      cover: [{ startsAt: "2026-10-07T17:30:00.000Z", endsAt: approved.endsAt }],
    }).kind,
    "covered",
    "an open head that is already in the past is not a finding",
  );
  eq(
    judgeEventCoverage({ ...approved, nowMs: ms(approved.endsAt) + 1, measuredUntilMs: FAR, cover: null }).kind,
    "passed",
    "a window entirely in the past is passed, whatever the calendar says",
  );

  // Unreadable stamps are never coverage and never a finding (L50): they cannot be
  // compared, so they are reported as such.
  eq(
    judgeEventCoverage({ startsAt: "garbage", endsAt: approved.endsAt, nowMs: before, measuredUntilMs: FAR, cover: null })
      .kind,
    "unreadable",
    "an unreadable approved window is unreadable, not a finding",
  );
  eq(
    judgeEventCoverage({
      ...approved,
      nowMs: before,
      measuredUntilMs: FAR,
      cover: [{ startsAt: "nope", endsAt: approved.endsAt }],
    }).kind,
    "unreadable",
    "an unreadable cover is unreadable, never silently dropped into a gap",
  );
}

// --- the cache's horizon (#3655) ----------------------------------------------------
// The calendar sync DELETES the mirror of any event that changes while it starts past
// its write window (#1264), so past the calendar's mirrored horizon an absent mirror
// measures the sync's cut off, not the calendar. On 2026-10-12 that paged three times
// about events `verify:ooo-protection` then read intact in Google. Past the horizon the
// judge must say it could not tell; inside it, an absent mirror is still a finding.
{
  const DAY = 24 * 60 * MIN;
  const now = ms("2026-10-13T12:00:00.000Z");
  const horizon = now + 21 * DAY;
  const at = (d: number) => new Date(now + d * DAY).toISOString();

  // The positive control the issue asks for: approved 30 days out, mirror gone.
  eq(
    judgeEventCoverage({ startsAt: at(30), endsAt: at(34), nowMs: now, measuredUntilMs: horizon, cover: null }),
    { kind: "unmeasured" },
    "a window wholly past the horizon with no mirror is unmeasured, never not-blocking",
  );
  eq(
    judgeEventCoverage({
      startsAt: at(30),
      endsAt: at(34),
      nowMs: now,
      measuredUntilMs: horizon,
      cover: [{ startsAt: at(31), endsAt: at(34) }],
    }),
    { kind: "unmeasured" },
    "past the horizon a mirror that looks short is not a finding either: a later edit there deletes it rather than updating it",
  );
  eq(
    judgeEventCoverage({ startsAt: at(30), endsAt: at(34), nowMs: now, measuredUntilMs: now, cover: null }),
    { kind: "unmeasured" },
    "a calendar with no mirrored horizon at all (the horizon is now) measures nothing ahead",
  );

  // Inside the horizon an absent mirror still pages.
  eq(
    judgeEventCoverage({ startsAt: at(5), endsAt: at(7), nowMs: now, measuredUntilMs: horizon, cover: null }),
    { kind: "not-blocking", unmeasured: null },
    "inside the horizon a missing mirror is still the calendar blocking nothing",
  );
  eq(
    judgeEventCoverage({
      startsAt: at(5),
      endsAt: at(7),
      nowMs: now,
      measuredUntilMs: horizon,
      cover: [{ startsAt: at(5), endsAt: at(7) }],
    }),
    { kind: "covered", unmeasured: null },
    "inside the horizon a matching mirror is covered with nothing left unmeasured",
  );

  // Straddling the horizon: only the part inside it is judged, and the rest is named.
  const beyond = { startMs: horizon, endMs: now + 24 * DAY };
  eq(
    judgeEventCoverage({
      startsAt: at(19),
      endsAt: at(24),
      nowMs: now,
      measuredUntilMs: horizon,
      cover: [{ startsAt: at(19), endsAt: at(21) }],
    }),
    { kind: "covered", unmeasured: beyond },
    "a mirror covering the part inside the horizon is covered there, and the rest is unmeasured, not open",
  );
  eq(
    judgeEventCoverage({ startsAt: at(19), endsAt: at(24), nowMs: now, measuredUntilMs: horizon, cover: null }),
    { kind: "not-blocking", unmeasured: beyond },
    "a straddling window with no mirror is not-blocking for the part inside the horizon only",
  );
  eq(
    judgeEventCoverage({
      startsAt: at(19),
      endsAt: at(24),
      nowMs: now,
      measuredUntilMs: horizon,
      cover: [{ startsAt: at(20), endsAt: at(24) }],
    }),
    { kind: "uncovered", spans: [{ startMs: now + 19 * DAY, endMs: now + 20 * DAY }], unmeasured: beyond },
    "a straddling window reports only the open span inside the horizon, never the unmeasured tail",
  );

  // The sync half judges the event Google just sent, which is a measurement at any
  // distance, so it passes no horizon and a shortened event 30 days out still pages.
  eq(
    judgeEventCoverage({
      startsAt: at(30),
      endsAt: at(34),
      nowMs: now,
      measuredUntilMs: Infinity,
      cover: [{ startsAt: at(31), endsAt: at(34) }],
    }),
    { kind: "uncovered", spans: [{ startMs: now + 30 * DAY, endMs: now + 31 * DAY }], unmeasured: null },
    "with the event itself in hand there is no horizon: a shortened event 30 days out is uncovered",
  );
}

finish();
