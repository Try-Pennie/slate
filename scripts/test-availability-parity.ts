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
  parseSlateSlots,
  detectPinIgnored,
  rosterReadiness,
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
{
  // A start that is a string but not an instant would survive parsing and then be
  // dropped during bucketing, which yields a SMALLER cal.com answer. That is
  // indistinguishable from cal.com genuinely offering less, and gets reported as
  // Slate over-offering: a finding about the payload dressed as one about the
  // roster. So it is refused at the parse.
  const parsed = parseCalcomSlots({ "2026-09-09": [{ start: at(9) }, { start: "half past nine" }] });
  assert(!parsed.ok, "a start that is not a readable instant is refused, never silently dropped");
}

// --- reading Slate's answer ---------------------------------------------------
// The same refusals in the opposite direction. A SMALLER Slate answer is reported
// as Slate under-offering, the headline finding, so a read defect here would be
// indistinguishable from the roster problem the probe exists to catch.
{
  const parsed = parseSlateSlots({ slots: [at(9), at(10)] });
  assert(parsed.ok, "a well-formed availability body parses");
  if (parsed.ok) eq(parsed.slots.length, 2, "keeping every slot");
}
{
  const parsed = parseSlateSlots({ slots: [] });
  assert(parsed.ok, "an empty slots array parses: Slate offering nothing is a real answer");
}
{
  // Not the same as an empty array. Collapsing it into one would report
  // `slate-offers-nothing`, a finding about the roster, from a body we could not read.
  const parsed = parseSlateSlots({ orgName: "Pennie" });
  assert(!parsed.ok, "a body with no slots array is refused, never read as offering nothing");
}
{
  const parsed = parseSlateSlots(null);
  assert(!parsed.ok, "a null body is refused");
}
{
  const parsed = parseSlateSlots({ slots: [at(9), 42] });
  assert(!parsed.ok, "a non-string slot is refused, never filtered out");
}
{
  const parsed = parseSlateSlots({ slots: [at(9), "tomorrow morning"] });
  assert(!parsed.ok, "a slot that is not a readable instant is refused, never dropped");
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
// --- the shared reach ---------------------------------------------------------
// The two systems do not look equally far ahead. Measured against live cal.com on
// 2026-09-02, its pool reached about two days while Slate's horizon runs much
// further, so every day past cal.com's reach would be reported as Slate offering
// more, on every run, forever. That is the always-red check this file's header
// refuses to build (L36). So the hours are compared only across the range BOTH
// systems answered for, and each system's extra days are reported as their own
// fact rather than as a finding about the other.
{
  const r = compareCoverage(base({
    calcomSlots: [at(9), "2026-09-20T13:00:00.000Z"],
    slateSlots: [at(9)],
  }));
  eq(r.verdict, "agree", "a day only cal.com reaches is not an hours finding");
  eq(r.calcomOnlyDays, ["2026-09-20"], "it is reported as a day beyond the shared range");
  eq(r.daysCompared, 1, "and only the shared day is compared");
}
{
  // The direction that actually happens: Slate looks further ahead than cal.com.
  const r = compareCoverage(base({
    calcomSlots: [at(9)],
    slateSlots: [at(9), "2026-09-20T13:00:00.000Z", "2026-09-21T13:00:00.000Z"],
  }));
  eq(r.verdict, "agree", "days past cal.com's reach are not Slate over-offering");
  eq(r.slateOnlyDays, ["2026-09-20", "2026-09-21"], "they are reported as beyond the shared range");
}
{
  // Inside the shared range a missing day IS the finding, and must not be excused
  // by the same rule that excuses the horizon. Slate answers for the 9th and the
  // 11th, so the 10th sits INSIDE its reach and is genuinely missing.
  const r = compareCoverage(base({
    calcomSlots: [at(9), "2026-09-10T13:00:00.000Z", "2026-09-11T13:00:00.000Z"],
    slateSlots: [at(9), "2026-09-11T13:00:00.000Z"],
  }));
  eq(r.verdict, "slate-under-offers", "a day missing INSIDE the shared range is still a finding");
  eq(r.missingInSlate.map((d) => d.day), ["2026-09-10"], "named as that day");
  eq(r.slateOnlyDays.length, 0, "and nothing is excused as horizon");
}
{
  // No overlap at all: cal.com answers for one week, Slate for another. Nothing can
  // be compared, and reporting agreement would be a pass over a run that measured
  // nothing (L98).
  const r = compareCoverage(base({
    calcomSlots: [at(9)],
    slateSlots: ["2026-09-20T13:00:00.000Z"],
  }));
  eq(r.verdict, "no-shared-days", "two non-overlapping ranges compare nothing");
  eq(r.daysCompared, 0, "and nothing is counted as compared");
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

// --- the roster must be hydrated before any of this means anything ------------
// An agent flipped bookable holds no cached busy time until the watch lane has
// discovered their calendar and the sync lane has hydrated it (#1736). During that
// window the booker sees them as free for every hour their working hours allow, so
// a parity run taken then measures the DRAIN and reports it as a roster finding.
// The instruction "wait for it to settle" lives in an issue, and a rule that lives
// only in an issue is a hope (L27), so the probe refuses instead.
const NEED = Date.UTC(2026, 8, 16);
const ready = (over: Partial<{ hasCalendar: boolean; syncWindowToMs: number | null }> = {}) => ({
  userId: "u",
  hasCalendar: true,
  syncWindowToMs: NEED + 86_400_000,
  ...over,
});
{
  const r = rosterReadiness([ready(), ready()], NEED);
  assert(r.ready, "every agent with a calendar hydrated past the window is ready");
  eq(r.noCalendar, 0, "with nothing missing a calendar");
  eq(r.notHydrated, 0, "and nothing under-hydrated");
}
{
  const r = rosterReadiness([ready(), ready({ hasCalendar: false })], NEED);
  assert(!r.ready, "one agent with no calendar row makes the pool unready");
  eq(r.noCalendar, 1, "counted as missing a calendar");
  eq(r.notHydrated, 0, "and not double counted as under-hydrated");
}
{
  const r = rosterReadiness([ready({ syncWindowToMs: null })], NEED);
  assert(!r.ready, "a calendar that has never hydrated is not ready");
  eq(r.notHydrated, 1, "counted as under-hydrated");
}
{
  // An unreadable stamp arrives as null for the same reason the existing coverage
  // check scores it UNCOVERED: a stamp nobody can read, silently scored as fine, is
  // the shape where NaN lands on the healthy branch.
  const r = rosterReadiness([ready({ syncWindowToMs: NEED - 1 })], NEED);
  assert(!r.ready, "a window ending before the compared range is not ready");
  eq(r.notHydrated, 1, "and says so as under-hydration, not as a missing calendar");
}
{
  // Exactly reaching the end of the window counts as covered: the comparison asks
  // nothing about instants past it.
  assert(rosterReadiness([ready({ syncWindowToMs: NEED })], NEED).ready, "a window reaching exactly the end is ready");
}
{
  // An empty pool is NOT ready. Reporting it ready would let a bucket with nobody
  // in it pass the gate and go on to compare, where two empty answers agree
  // perfectly and prove nothing (L98).
  const r = rosterReadiness([], NEED);
  assert(!r.ready, "an empty pool is never ready: there is nothing to be ready");
}

finish();
