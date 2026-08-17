// #1237: which of an absent agent's bookings a coverage sweep moves.
//
// ONE named rule, and the issue asks for it as three separate invariants because each catches
// a different way of getting it wrong:
//
//   starts_at > now          never touch an appointment already under way;
//   starts_at < window_end   it must begin before the absence ends;
//   ends_at   > window_start it must still be running when the absence begins.
//
// The third is the one today's query misses. It floors the start at the window start
// (`.gte("starts_at", startFloor)`), so an appointment that BEGINS before the window and runs
// into it is never selected, and the customer keeps a slot with an advisor who is away.
//
// No lead-time threshold, deliberately: everything still ahead moves, because the advisor is
// definitely absent and the alternative is a customer sitting in an empty meeting.
//
// Run: node --experimental-strip-types scripts/test-coverage-selection.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { movesUnderCoverage, coverageSelectionBounds } from "@/lib/booking/coverage-selection";

const NOW = "2026-08-18T09:00:00.000Z";
const WINDOW = { startIso: "2026-08-18T13:00:00.000Z", endIso: "2026-08-18T17:00:00.000Z" };
const b = (starts: string, ends: string) => ({ startsAtIso: starts, endsAtIso: ends });

// --- invariant 1: never move an appointment already under way -----------------
{
  assert(
    !movesUnderCoverage(b("2026-08-18T08:30:00.000Z", "2026-08-18T09:30:00.000Z"), WINDOW, NOW),
    "an appointment that has already started is never moved, even though it overlaps now",
  );
  assert(
    !movesUnderCoverage(b("2026-08-18T09:00:00.000Z", "2026-08-18T14:00:00.000Z"), WINDOW, NOW),
    "one starting exactly now is not moved either: the customer may already be in it",
  );
  assert(
    movesUnderCoverage(b("2026-08-18T13:30:00.000Z", "2026-08-18T14:00:00.000Z"), WINDOW, NOW),
    "one still ahead is moved",
  );
}

// --- invariant 2: it must begin before the absence ends -----------------------
{
  assert(
    !movesUnderCoverage(b("2026-08-18T17:00:00.000Z", "2026-08-18T17:30:00.000Z"), WINDOW, NOW),
    "one starting exactly when the absence ends is not the absence's problem",
  );
  assert(
    !movesUnderCoverage(b("2026-08-18T18:00:00.000Z", "2026-08-18T18:30:00.000Z"), WINDOW, NOW),
    "nor one starting after it",
  );
}

// --- invariant 3: it must still be running when the absence begins ------------
{
  // THE CASE TODAY'S QUERY MISSES. Begins before the window, runs into it, so the advisor is
  // away for part of a call the customer is already booked into.
  assert(
    movesUnderCoverage(b("2026-08-18T12:30:00.000Z", "2026-08-18T13:30:00.000Z"), WINDOW, NOW),
    "an appointment that begins BEFORE the window and runs into it is moved",
  );
  assert(
    !movesUnderCoverage(b("2026-08-18T12:00:00.000Z", "2026-08-18T13:00:00.000Z"), WINDOW, NOW),
    "one that finishes exactly as the absence begins is left alone",
  );
  assert(
    !movesUnderCoverage(b("2026-08-18T10:00:00.000Z", "2026-08-18T10:30:00.000Z"), WINDOW, NOW),
    "and one entirely before it is left alone",
  );
}

// --- a half day window passes exact timestamps, not whole days ----------------
{
  const half = { startIso: "2026-08-18T13:00:00.000Z", endIso: "2026-08-18T17:00:00.000Z" };
  assert(
    !movesUnderCoverage(b("2026-08-18T11:00:00.000Z", "2026-08-18T11:30:00.000Z"), half, NOW),
    "a morning appointment survives an afternoon absence",
  );
  assert(
    movesUnderCoverage(b("2026-08-18T15:00:00.000Z", "2026-08-18T15:30:00.000Z"), half, NOW),
    "an afternoon one does not",
  );
}

// --- an open ended window (no end) --------------------------------------------
{
  const open = { startIso: "2026-08-18T13:00:00.000Z", endIso: null };
  assert(
    movesUnderCoverage(b("2027-01-01T10:00:00.000Z", "2027-01-01T10:30:00.000Z"), open, NOW),
    "with no end, everything from the window start onward is in scope",
  );
  assert(
    !movesUnderCoverage(b("2026-08-18T10:00:00.000Z", "2026-08-18T10:30:00.000Z"), open, NOW),
    "but still not something finishing before it begins",
  );
}

// --- an unreadable timestamp is never moved -----------------------------------
{
  // Date.parse gives NaN and every comparison with NaN is false, so the permissive reading is
  // "does not match" either way. Stated explicitly rather than relied on, because the harm is
  // asymmetric: moving a booking is a customer-visible action taken on data we could not read.
  assert(
    !movesUnderCoverage(b("not-a-date", "2026-08-18T14:00:00.000Z"), WINDOW, NOW),
    "a booking with an unreadable start is never moved",
  );
  assert(
    !movesUnderCoverage(b("2026-08-18T13:30:00.000Z", "nope"), WINDOW, NOW),
    "nor one with an unreadable end",
  );
}

// --- the bounds the query must apply ------------------------------------------
{
  // The same rule, in the shape the store hands to PostgREST, so the query and the predicate
  // cannot drift into meaning different things about the same window (L16).
  const bounds = coverageSelectionBounds(WINDOW, NOW);
  eq(bounds.startsAfterIso, NOW, "starts_at is bounded by NOW, not by the window start");
  eq(bounds.startsBeforeIso, WINDOW.endIso, "and above by the window end");
  eq(bounds.endsAfterIso, WINDOW.startIso, "while ends_at is bounded by the window start");

  const openBounds = coverageSelectionBounds({ startIso: WINDOW.startIso, endIso: null }, NOW);
  eq(openBounds.startsBeforeIso, null, "an open ended window has no upper bound on the start");
}

finish();
