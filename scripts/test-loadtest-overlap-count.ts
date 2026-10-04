// The overlap count is PRINTED on a passing run, not only on a failing one (#2323).
//
// The judge reported the overlap check only when it failed, so a passing run's
// report carried no line about overlapping bookings at all, and the one number the
// run exists to produce after #2274 had to be inferred from the absence of a
// finding. On 2026-09-14 (run 34862015419) the measured section listed attempts,
// rate, latency, 5xx, refusals and freshness and said nothing about overlaps; the
// record on #2284 had to state "0 pairs" from the judge's silence plus the
// preflight's planted clash.
//
// A measured zero and a check that never ran read the same when neither prints
// (L98, L11). So the count is a MEASUREMENT like every other number in that
// section, and it says what it is a count OF.
//
// Run: node --experimental-strip-types scripts/test-loadtest-overlap-count.ts
import { measure, overlaps } from "./loadtest/judge-booking-run.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const AGENT = "agent-1";

function booking(id: string, startIso: string, endIso: string, agent = AGENT) {
  return {
    id,
    external_id: id,
    status: "confirmed",
    assigned_user_id: agent,
    starts_at: startIso,
    ends_at: endIso,
    idempotency_key: `k-${id}`,
  };
}

function input(bookings: ReturnType<typeof booking>[]) {
  return {
    runId: "r",
    target: { drivers: 4, perDriverPerMinute: 15, minutes: 10 },
    driverResults: [],
    burstResults: [],
    freshnessSamples: [],
    bookings,
    bookingIdsWithBusyBlock: [],
    slotUniqueIndexPresent: true,
    overlapConstraintPresent: true,
    ipCeilingControl: {} as never,
    platform: {} as never,
    expectedLegs: { burstDrivers: 0, faultPct: 0 },
    unreadableDriverFiles: [],
    budgets: { cpuMsP99: 2500, cronCpuMs: 120_000 },
  };
}

// --- a clean run REPORTS a zero, rather than saying nothing ------------------------
{
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
      booking("b", "2026-09-16T14:20:00.000Z", "2026-09-16T14:40:00.000Z"),
    ]),
  );
  eq(m.overlappingPairs, 0, "a clean run measures ZERO overlapping pairs");
  eq(m.sameSlotPairs, 0, "and zero pairs at the same slot");
  eq(m.activeBookings, 2, "over a stated number of active bookings, so the zero has a denominator");
}

// --- back to back is not an overlap ------------------------------------------------
{
  // Half-open `[starts_at, ends_at)`: a call ending at 14:20 and one starting at
  // 14:20 do not clash, and counting them would make every full day a finding.
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
      booking("b", "2026-09-16T14:20:00.000Z", "2026-09-16T14:40:00.000Z"),
    ]),
  );
  eq(m.overlappingPairs, 0, "back to back calls are not a clash");
}

// --- the #2274 shape: adjacent offered times on a longer appointment ------------------
{
  // 20 minutes on a 10 minute grid, so two adjacent offered times overlap by ten.
  // `bookings_active_slot_uniq` is unique on (agent, starts_at) and cannot see it.
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
      booking("b", "2026-09-16T14:10:00.000Z", "2026-09-16T14:30:00.000Z"),
    ]),
  );
  eq(m.overlappingPairs, 1, "two adjacent starts on one agent are one overlapping pair");
  eq(m.sameSlotPairs, 0, "and they are NOT the same slot, which is the whole point of #2274");
}

// --- the same slot twice ---------------------------------------------------------------
{
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
      booking("b", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
    ]),
  );
  eq(m.sameSlotPairs, 1, "two bookings at one instant on one agent are a same slot pair");
  eq(m.overlappingPairs, 1, "which is also an overlap, and both are counted");
}

// --- EVERY overlapping pair is counted, not just adjacent ones ---------------------------
{
  // Three mutually overlapping bookings are THREE pairs. Counting only neighbours
  // after a sort reports two, and a number printed as a measurement has to be the
  // number (L63).
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:30:00.000Z"),
      booking("b", "2026-09-16T14:10:00.000Z", "2026-09-16T14:40:00.000Z"),
      booking("c", "2026-09-16T14:20:00.000Z", "2026-09-16T14:50:00.000Z"),
    ]),
  );
  eq(m.overlappingPairs, 3, "three mutually overlapping bookings are three pairs");
}

// --- two agents never clash with each other -----------------------------------------------
{
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z", "agent-1"),
      booking("b", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z", "agent-2"),
    ]),
  );
  eq(m.overlappingPairs, 0, "the same time on two different agents is not a clash");
  eq(m.sameSlotPairs, 0, "nor a same slot pair");
  eq(m.activeBookings, 2, "and both are still active bookings");
}

// --- a cancelled booking holds no slot ------------------------------------------------------
{
  const cancelled = {
    ...booking("b", "2026-09-16T14:10:00.000Z", "2026-09-16T14:30:00.000Z"),
    status: "cancelled",
  };
  const m = measure(input([booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"), cancelled]));
  eq(m.overlappingPairs, 0, "a cancelled booking is not holding a slot");
  eq(m.activeBookings, 1, "and is not counted in the denominator either");
}

// --- an unreadable bound counts as an overlap, never as clear ---------------------------------
{
  // The one comparison in this file whose permissive answer would HIDE a double
  // booking. A NaN bound compares false against everything, so a check written the
  // obvious way lands on "no clash" with no error raised anywhere (L50).
  const m = measure(
    input([
      booking("a", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
      booking("b", "not a date", "also not a date"),
    ]),
  );
  eq(m.overlappingPairs, 1, "an unreadable bound is counted as a clash rather than waved through");
  assert(
    overlaps(
      booking("x", "nope", "nope"),
      booking("y", "2026-09-16T14:00:00.000Z", "2026-09-16T14:20:00.000Z"),
    ),
    "and the predicate itself fails closed",
  );
}

// --- nothing to measure is a zero over a zero, and says so -------------------------------------
{
  // A run with no bookings must not print "0 overlapping pairs" as though it had
  // looked at something: the denominator is what tells them apart (L98).
  const m = measure(input([]));
  eq(m.overlappingPairs, 0, "no bookings, no pairs");
  eq(m.activeBookings, 0, "and the denominator says nothing was looked at");
}

finish();
