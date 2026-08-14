// #1491: every canary scenario gets a STATED slot separation.
//
// #1489 fixed the cross-bucket scenario, whose two slots were chosen with zero
// margin and collided three times in ten days. The same design was still present
// everywhere else: each scenario indexed into `slotsA`, one availability read taken
// at the top of the run, with hardcoded offsets (0, 1, 2, 3, 4) whose gaps are one
// or two slots wide while the seeded event is 20 minutes. Scenarios 2 and 7 both
// started from index 2.
//
// That matters because a scenario whose instants land inside another's event fails
// as a dedupe or a NO_ELIGIBLE_AGENTS re-route, which reads as a booking
// regression rather than as the fixture problem it is. Nothing had tripped yet,
// which was luck: the list is already stale by the time the later scenarios run.
//
// The plan below replaces the implicit offsets with a reservation that REFUSES
// rather than returning a colliding slot, and that anchors on the instant a booking
// actually landed on rather than the one requested.
//
// Run: node --experimental-strip-types scripts/test-smoke-slot-plan.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  MIN_SLOTS_FOR_RUN,
  SCENARIOS_RESERVING_SLOTS,
  SCENARIO_MIN_GAP_MS,
  SLOT_STEP_MS,
  createSlotPlan,
} from "./lib/smoke-slot-plan.ts";

/** Ten-minute slots from a fixed base, the real SMOKE cadence. */
function slotsFrom(baseIso: string, count: number, stepMs = 10 * 60_000): string[] {
  const base = Date.parse(baseIso);
  return Array.from({ length: count }, (_, i) => new Date(base + i * stepMs).toISOString());
}

const BASE = "2026-09-01T13:00:00.000Z";

// --- the first reservation takes the first slot ---
{
  const plan = createSlotPlan(slotsFrom(BASE, 24));
  const first = plan.reserve("scenario 1");
  assert(first.ok, "the first reservation succeeds");
  eq(first.ok && first.start, BASE, "and it is the earliest slot on offer");
}

// --- every later reservation clears the stated gap from all earlier ones ---
{
  const plan = createSlotPlan(slotsFrom(BASE, 48));
  const picks: string[] = [];
  for (const label of ["one", "two", "three", "four", "five", "six"]) {
    const r = plan.reserve(label);
    assert(r.ok, `${label} reserved`);
    if (r.ok) picks.push(r.start);
  }
  eq(picks.length, 6, "six scenarios each got a slot");
  // Pairwise, not just consecutive: the point is that NO two scenarios can land
  // inside each other's event, and a consecutive-only check would miss a picker
  // that wrapped back around.
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const gap = Math.abs(Date.parse(picks[i]!) - Date.parse(picks[j]!));
      assert(
        gap >= SCENARIO_MIN_GAP_MS,
        `picks ${i} and ${j} are at least the stated gap apart (${Math.round(gap / 60_000)} min)`,
      );
    }
  }
  eq(new Set(picks).size, picks.length, "and no slot is handed out twice");
}

// --- it REFUSES rather than returning a colliding slot ---
{
  // Four slots spanning 30 minutes: after the first reservation nothing else clears
  // an hour, so the second must fail as itself.
  const plan = createSlotPlan(slotsFrom(BASE, 4));
  assert(plan.reserve("first").ok, "the first still succeeds in a thin window");
  const second = plan.reserve("second");
  assert(!second.ok, "the second REFUSES rather than colliding");
  assert(
    !second.ok && second.reason.includes("second"),
    `the refusal names the scenario that could not be placed (got: ${!second.ok ? second.reason : ""})`,
  );
  assert(
    !second.ok && /min/.test(second.reason),
    "and states the gap it needed, so a thin window is diagnosable mid-incident",
  );
}
{
  const plan = createSlotPlan([]);
  const r = plan.reserve("only");
  assert(!r.ok, "an empty slot list refuses");
  assert(!r.ok && /no open slots|no slots/i.test(r.reason), "and says the list was empty");
}

// --- anchoring on what was BOOKED, not what was requested ---
{
  // The API can land a booking on an instant other than the one asked for, and the
  // retry helper deliberately advances past a taken slot. Recording the REQUESTED
  // slot would then leave the plan believing a window is free when it is not.
  const plan = createSlotPlan(slotsFrom(BASE, 48));
  const first = plan.reserve("requested");
  assert(first.ok, "reserved a slot");
  // It actually landed four hours later than reserved.
  const landed = new Date(Date.parse(BASE) + 4 * 60 * 60_000).toISOString();
  plan.record(landed);

  const next = plan.reserve("after");
  assert(next.ok, "the next reservation still succeeds");
  if (next.ok) {
    const gapFromLanded = Math.abs(Date.parse(next.start) - Date.parse(landed));
    assert(
      gapFromLanded >= SCENARIO_MIN_GAP_MS,
      `the next pick clears the gap from where the booking LANDED (${Math.round(gapFromLanded / 60_000)} min)`,
    );
  }
}

// --- an unreadable stamp is never silently accepted ---
{
  // Date.parse yields NaN for an unreadable stamp and every comparison with NaN is
  // false, so an unguarded gap check would accept the very first colliding slot.
  const plan = createSlotPlan(["not-a-date", ...slotsFrom(BASE, 24)]);
  const first = plan.reserve("one");
  assert(first.ok, "an unreadable candidate is skipped, not returned");
  eq(first.ok && first.start, BASE, "the first READABLE slot is used instead");

  const plan2 = createSlotPlan(slotsFrom(BASE, 24));
  assert(plan2.reserve("one").ok, "reserved");
  plan2.record("not-a-date");
  const after = plan2.reserve("two");
  assert(
    !after.ok,
    "recording an unreadable booked start REFUSES the next reservation rather than guessing",
  );
}

// --- the gap is wider than any event the smoke buckets book ---
{
  // 20 minute seeded event. A gap at or below that lets two scenarios overlap, and
  // an overlap is what returns NO_ELIGIBLE_AGENTS on the single-member bucket.
  assert(
    SCENARIO_MIN_GAP_MS > 20 * 60_000,
    `the stated gap (${SCENARIO_MIN_GAP_MS / 60_000} min) exceeds the 20 min seeded event`,
  );
}

// --- the availability gate's floor really covers what the plan needs ---
{
  // A floor below the plan's need lets the run start and refuse mid-way, which pages
  // with a per-scenario message instead of one clear "this window is too thin".
  const plan = createSlotPlan(slotsFrom(BASE, MIN_SLOTS_FOR_RUN, SLOT_STEP_MS));
  for (let i = 0; i < SCENARIOS_RESERVING_SLOTS; i++) {
    const r = plan.reserve(`scenario ${i}`);
    assert(r.ok, `a run at exactly the floor places scenario ${i}${r.ok ? "" : `: ${r.reason}`}`);
  }
  // And one slot fewer than the floor must NOT be enough, or the floor is padding
  // rather than a measurement.
  const thin = createSlotPlan(
    slotsFrom(BASE, Math.floor(((SCENARIOS_RESERVING_SLOTS - 1) * SCENARIO_MIN_GAP_MS) / SLOT_STEP_MS), SLOT_STEP_MS),
  );
  let placed = 0;
  for (let i = 0; i < SCENARIOS_RESERVING_SLOTS; i++) {
    if (thin.reserve(`scenario ${i}`).ok) placed++;
  }
  assert(
    placed < SCENARIOS_RESERVING_SLOTS,
    `a window below the floor cannot place every scenario (placed ${placed})`,
  );
}

finish();
