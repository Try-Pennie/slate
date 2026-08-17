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

// --- the two paths agree, on ONE fixture set (#1238) --------------------------
//
// Asserting the bounds' VALUES, as the block above does, says the store was handed what the
// rule computed. It does not say the query those bounds become SELECTS the same appointments
// the predicate does, and that is the half the straddler lives in: a floor on the wrong column
// is a correct-looking bound that quietly drops it.
//
// So both paths run over one committed list of shapes and must return the same set. The
// PostgREST side is simulated as string comparisons, which is exactly what it does with these
// stamps: every fixture is a UTC `...Z` instant with milliseconds, so lexicographic order IS
// chronological order and the simulation cannot flatter the real query by comparing differently.
//
// The monitor's own bulk prefilter (#1238) is the third path and is checked against the same
// list, because it reads the whole roster at once rather than one agent's window and so cannot
// use the bounds directly. It must never exclude an appointment the predicate selects.
{
  const FIXTURES: { name: string; startsAtIso: string; endsAtIso: string }[] = [
    { name: "wholly inside the absence", startsAtIso: "2026-08-18T14:00:00.000Z", endsAtIso: "2026-08-18T14:30:00.000Z" },
    { name: "the straddler, begins before the absence and runs into it", startsAtIso: "2026-08-18T12:30:00.000Z", endsAtIso: "2026-08-18T13:30:00.000Z" },
    { name: "ends exactly when the absence begins", startsAtIso: "2026-08-18T12:00:00.000Z", endsAtIso: "2026-08-18T13:00:00.000Z" },
    { name: "ends before the absence begins", startsAtIso: "2026-08-18T10:00:00.000Z", endsAtIso: "2026-08-18T10:30:00.000Z" },
    { name: "begins exactly when the absence ends", startsAtIso: "2026-08-18T17:00:00.000Z", endsAtIso: "2026-08-18T17:30:00.000Z" },
    { name: "begins after the absence ends", startsAtIso: "2026-08-18T19:00:00.000Z", endsAtIso: "2026-08-18T19:30:00.000Z" },
    { name: "already under way", startsAtIso: "2026-08-18T08:45:00.000Z", endsAtIso: "2026-08-18T13:15:00.000Z" },
    { name: "runs from before the absence to after it", startsAtIso: "2026-08-18T12:00:00.000Z", endsAtIso: "2026-08-18T18:00:00.000Z" },
  ];

  /** What PostgREST returns for the bounds the store applies. */
  const selectedByQuery = (bounds: ReturnType<typeof coverageSelectionBounds>) =>
    FIXTURES.filter(
      (f) =>
        f.startsAtIso > bounds.startsAfterIso &&
        (bounds.startsBeforeIso === null || f.startsAtIso < bounds.startsBeforeIso) &&
        f.endsAtIso > bounds.endsAfterIso,
    ).map((f) => f.name);

  const byPredicate = FIXTURES.filter((f) => movesUnderCoverage(f, WINDOW, NOW)).map((f) => f.name);
  eq(
    selectedByQuery(coverageSelectionBounds(WINDOW, NOW)),
    byPredicate,
    "the sweep's query and the shared predicate select the same appointments",
  );
  assert(
    byPredicate.includes("the straddler, begins before the absence and runs into it"),
    "and the straddler is IN that set, or the agreement is between two paths that both miss it",
  );

  const OPEN = { startIso: WINDOW.startIso, endIso: null };
  eq(
    selectedByQuery(coverageSelectionBounds(OPEN, NOW)),
    FIXTURES.filter((f) => movesUnderCoverage(f, OPEN, NOW)).map((f) => f.name),
    "and they agree on an open ended absence too, where the upper bound disappears",
  );

  // The monitor prefilter, which is a superset filter rather than the exact rule.
  const prefiltered = FIXTURES.filter((f) => f.endsAtIso >= NOW).map((f) => f.name);
  for (const name of byPredicate) {
    assert(
      prefiltered.includes(name),
      `the monitor's ends_at prefilter keeps "${name}", which the predicate selects`,
    );
  }
  // The prefilter has to stay the WIDER of the two candidates, and it is worth being precise
  // about why, because #1238's plan gave a reason that does not survive #1237: with the current
  // predicate a `starts_at >= now` prefilter would lose nothing, since everything the predicate
  // selects starts after now anyway. The real argument is the next change rather than this one.
  // `ends_at >= now` also admits the appointment already UNDER WAY, which the predicate
  // deliberately declines today; a prefilter floored on `starts_at` would pre-exclude it in the
  // read, so a later decision to report in-progress ones would silently select nothing and look
  // like a roster with none.
  const narrower = FIXTURES.filter((f) => f.startsAtIso >= NOW).map((f) => f.name);
  assert(
    prefiltered.length > narrower.length,
    "the ends_at prefilter is the wider net, so the read does not decide what the rule may see",
  );
  assert(
    prefiltered.includes("already under way") && !narrower.includes("already under way"),
    "and what it admits over the narrower one is the in-progress appointment, by name",
  );
}

finish();
