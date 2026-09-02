// Pure logic for the cal.com parity probe (#1731). Run:
//   node --experimental-strip-types scripts/test-availability-parity.ts
//
// WHY A COVERAGE COMPARISON AND NOT A SLOT DIFF. cal.com and Slate legitimately
// disagree about individual instants: they carry their own slot interval (cal.com
// offers the review event every 10 minutes), their own duration, buffers and
// minimum notice. A probe demanding instant-for-instant equality would be red on
// the day it shipped for reasons nobody should fix, and a check that is always red
// stops being read (L36). So the comparison is at the (day, hour) level: an hour
// either system offers anything in is an hour it considers open, and that survives
// every one of those differences.
//
// The finding the Phase 1 shadow exists to catch is Slate offering LESS than
// cal.com: an agent whose working hours are wrong (#1255 records the whole roster
// scheduled 9 to 17 while real hours are 8am to 8pm), a bucket with no members, a
// calendar that never synced. Slate offering MORE is reported separately and is
// usually cal.com holding an out of office entry Slate has not been told about.
//
// BOTH-EMPTY IS NEVER A PASS. Two systems that offer nothing agree perfectly and
// have proved nothing at all (L98), which is exactly the state the dark roster
// (#1272) produces today, so it gets its own verdict and its own non-zero exit.
import {
  compareCoverage,
  bucketByDayHour,
  parseCalcomSlots,
  detectPinIgnored,
  type ParityInput,
} from "./lib/availability-parity.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
// A Wednesday, chosen so nothing here depends on the day the suite runs.
const day = "2026-09-09";
/** An ISO instant at a local wall-clock hour in ZONE (EDT on this date, UTC-4). */
const at = (hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 8, 9, hour + 4, minute)).toISOString();

const base = (over: Partial<ParityInput>): ParityInput => ({
  calcomSlots: [],
  slateSlots: [],
  zone: ZONE,
  ...over,
});

// --- parsing cal.com's answer -------------------------------------------------
{
  const parsed = parseCalcomSlots({
    "2026-09-09": [{ start: at(9) }, { start: at(9, 10) }],
    "2026-09-10": [{ start: "2026-09-10T13:00:00.000Z" }],
  });
  assert(parsed.ok, "a well-formed slots payload parses");
  if (parsed.ok) eq(parsed.slots.length, 3, "every date's slots are flattened into one list");
}
{
  // An empty object is what cal.com returns for a pool with no availability. It is
  // readable and genuinely empty, which is a different thing from unreadable, and
  // the caller must be able to tell those apart to report the right reason.
  const parsed = parseCalcomSlots({});
  assert(parsed.ok, "an empty payload parses rather than erroring");
  if (parsed.ok) eq(parsed.slots.length, 0, "and yields no slots");
}
{
  const parsed = parseCalcomSlots(null);
  assert(!parsed.ok, "a null payload is refused, never read as an empty day");
}
{
  const parsed = parseCalcomSlots([{ start: at(9) }]);
  assert(!parsed.ok, "an array payload is refused: the contract is an object keyed by date");
}
{
  // A shape change in one date's value must not be averaged away into a smaller
  // number of slots that still looks like an answer (L340).
  const parsed = parseCalcomSlots({ "2026-09-09": "09:00" });
  assert(!parsed.ok, "a date whose value is not a list of slots is refused");
}

// --- bucketing ----------------------------------------------------------------
{
  const buckets = bucketByDayHour([at(9), at(9, 30), at(14)], ZONE);
  eq([...(buckets.get(day) ?? [])].sort((a, b) => a - b), [9, 14], "instants bucket by LOCAL hour");
}
{
  // The zone is load bearing: the same instants bucket into different local hours,
  // and a probe that bucketed in UTC would report a false hours mismatch every day.
  const buckets = bucketByDayHour([at(9)], "UTC");
  eq([...(buckets.get("2026-09-09") ?? [])], [13], "the same instant buckets differently in UTC");
}
{
  const buckets = bucketByDayHour(["not-a-date"], ZONE);
  eq(buckets.size, 0, "an unreadable instant is dropped rather than bucketed as NaN");
}

// --- the verdicts -------------------------------------------------------------
{
  const r = compareCoverage(base({
    calcomSlots: [at(9), at(10), at(11)],
    slateSlots: [at(9, 20), at(10, 30), at(11, 5)],
  }));
  eq(r.verdict, "agree", "the same open hours agree despite different minutes");
  eq(r.missingInSlate.length, 0, "and nothing is reported missing");
}
{
  // The #1255 shape: cal.com open 8am to 8pm, Slate stuck on 9 to 5.
  const calcom = [8, 9, 12, 16, 17, 18, 19].map((h) => at(h));
  const slate = [9, 12, 16].map((h) => at(h));
  const r = compareCoverage(base({ calcomSlots: calcom, slateSlots: slate }));
  eq(r.verdict, "slate-under-offers", "hours cal.com offers and Slate does not is the headline finding");
  eq(
    r.missingInSlate.map((d) => `${d.day}:${d.hours.join(",")}`),
    [`${day}:8,17,18,19`],
    "and the finding names the day and the exact hours",
  );
}
{
  const r = compareCoverage(base({
    calcomSlots: [at(9)],
    slateSlots: [at(9), at(15)],
  }));
  eq(r.verdict, "slate-over-offers", "Slate open where cal.com is not is reported separately");
  eq(r.missingInCalcom.map((d) => d.hours.join(",")), ["15"], "naming the hours cal.com withholds");
}
{
  // Under-offering outranks over-offering when both are present: the direction
  // that loses a lead a bookable time is the one the operator must act on.
  const r = compareCoverage(base({
    calcomSlots: [at(8), at(9)],
    slateSlots: [at(9), at(15)],
  }));
  eq(r.verdict, "slate-under-offers", "under-offering wins when both directions are present");
  eq(r.missingInCalcom.length, 1, "and the other direction is still reported, not discarded");
}
{
  const r = compareCoverage(base({ calcomSlots: [at(9)], slateSlots: [] }));
  eq(r.verdict, "slate-offers-nothing", "cal.com offering while Slate offers nothing is its own verdict");
}
{
  const r = compareCoverage(base({ calcomSlots: [], slateSlots: [at(9)] }));
  eq(r.verdict, "calcom-offers-nothing", "the reverse is also its own verdict, never folded into agreement");
}
{
  // The state the dark roster produces. Perfect agreement, zero information.
  const r = compareCoverage(base({ calcomSlots: [], slateSlots: [] }));
  eq(r.verdict, "neither-offers", "two empty answers agree perfectly and prove nothing");
  assert(r.verdict !== "agree", "and must never be reported as agreement");
}
{
  // A day only one system reaches at all (a horizon difference) is a missing DAY,
  // not twenty-four missing hours, so the report says what actually differs.
  const r = compareCoverage(base({
    calcomSlots: [at(9), "2026-09-20T13:00:00.000Z"],
    slateSlots: [at(9)],
  }));
  eq(r.verdict, "slate-under-offers", "a day cal.com reaches and Slate does not is under-offering");
  eq(r.missingInSlate.map((d) => d.day), ["2026-09-20"], "reported against that day");
  eq(r.daysCompared, 1, "and the day count reflects only the days BOTH systems could answer for");
}

// --- the silent pin fallback --------------------------------------------------
// cal.com ignores a routedTeamMemberIds pin naming a non-host and answers with the
// WHOLE pool instead, with no error. Compared against one agent's Slate
// availability the pool always offers more, which reads as Slate under-offering:
// a false finding that would send somebody to fix an agent who is fine. The only
// way to see it is to ask a second question whose answer is known to be the pool.
{
  const pool = [at(9), at(10), at(11)];
  assert(detectPinIgnored(pool, [...pool]), "a pinned answer identical to the bogus-pin answer means the pin was ignored");
}
{
  assert(
    !detectPinIgnored([at(9)], [at(9), at(10), at(11)]),
    "a pinned answer narrower than the pool means the pin was honoured",
  );
}
{
  // Order is not identity: the same set arriving in a different order is still the
  // same answer, and a comparison by position would call the pin honoured (L228).
  assert(
    detectPinIgnored([at(9), at(10)], [at(10), at(9)]),
    "the comparison is by set membership, not by order",
  );
}
{
  // Two genuinely empty answers are not evidence the pin was ignored: an agent with
  // no availability and a pool with none look the same here, and calling that
  // "ignored" would refuse a run whose real finding is that both are empty.
  assert(!detectPinIgnored([], []), "two empty answers do not prove the pin was ignored");
}

finish();
