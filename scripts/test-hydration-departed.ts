// #3805: the calendar refresh rotation leaves out the calendars of agents who have LEFT.
//
// WHAT WENT WRONG. The rotation read every `agent_calendars` row with no user filter. 26
// calendars belonged to departed agents (`users.deactivated_at` set), and Google answers
// every one of them 403 notACalendarUser. The shared eligibility gate holds an established
// failure back to its periodic retry slot, so its attempt stamp is always old, and
// least-recently-attempted-first then puts it at the FRONT of a batch of 2 whenever its
// slot opens. Two in one tick is an all failed tick, four of those in 90 minutes paged
// `hydration_all_failing` on 2026-10-16 about a lane with nothing wrong with it.
//
// The rule is "departed", deliberately NOT `hasLeftPool`: an active agent who is not
// bookable still has a calendar worth keeping warm, and an active agent whose account loses
// Calendar is exactly what the alert exists for (L342).
//
// The clock is injected everywhere: every tick below runs at an instant this file chose.
//
// Run: node --experimental-strip-types scripts/test-hydration-departed.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  planHydrationTick,
  departedFromEmbed,
  hydrationBatchSize,
  hydrationMeasuredTick,
  hydrationTickVerdict,
  runHydrationTickCheck,
  type HydrationTickVerdict,
} from "@/lib/google/hydration";
import { syncEligible } from "@/lib/google/sync-coalesce";

const MINUTE = 60_000;
const TICK_MS = 15 * MINUTE;
/** A fixed instant, on a whole minute, so every slot computation is reproducible. */
const START = Date.UTC(2026, 9, 16, 13, 0, 0);

interface Row {
  id: string;
  sync_token: string | null;
  last_failure_kind: "gone" | "not-provisioned" | "transient" | null;
  consecutive_failures: number;
  last_bootstrap_attempt_at: string | null;
  sync_claimed_at: string | null;
  departed: boolean;
}

/** A departed agent's calendar as production holds it: established not-provisioned, last
 *  attempted months ago because its retry slot is rare. */
function departedRow(i: number): Row {
  return {
    id: `departed-${i}`,
    sync_token: "tok",
    last_failure_kind: "not-provisioned",
    consecutive_failures: 10 + i,
    last_bootstrap_attempt_at: "2026-06-20T12:00:00.000Z",
    sync_claimed_at: null,
    departed: true,
  };
}

function healthyRow(i: number, attemptMs: number): Row {
  return {
    id: `active-${i}`,
    sync_token: "tok",
    last_failure_kind: null,
    consecutive_failures: 0,
    last_bootstrap_attempt_at: new Date(attemptMs).toISOString(),
    sync_claimed_at: null,
    departed: false,
  };
}

/**
 * One tick of the lane, driven the way the route drives it: plan, "hydrate" each calendar
 * in the batch (a not-provisioned calendar fails, anything else succeeds), stamp the
 * attempt, and judge the tick with the same two functions the route calls.
 */
function runTick(rows: Row[], nowMs: number): { picked: string[]; verdict: HydrationTickVerdict } {
  const plan = planHydrationTick(rows, nowMs);
  let refreshed = 0;
  let unreachable = 0;
  for (const c of plan.due) {
    const row = rows.find((r) => r.id === c.id)!;
    row.last_bootstrap_attempt_at = new Date(nowMs).toISOString();
    if (row.last_failure_kind === "not-provisioned") {
      unreachable++;
      row.consecutive_failures++;
    } else {
      refreshed++;
    }
  }
  const verdict = hydrationTickVerdict(
    hydrationMeasuredTick({ due: plan.due.length, refreshed, failed: unreachable, skipped: 0 }),
  );
  return { picked: plan.due.map((c) => c.id), verdict };
}

/** The first minute at or after `fromMs` where at least `atLeast` of `rows` have their
 *  retry slot open. Found rather than hardcoded, so the fixture states its precondition
 *  instead of depending on a hash nobody can see. */
function minuteWithOpenSlots(rows: Row[], fromMs: number, atLeast: number): number {
  for (let m = 0; m < 600; m++) {
    const at = fromMs + m * MINUTE;
    if (rows.filter((r) => syncEligible(r, at)).length >= atLeast) return at;
  }
  throw new Error(`fixture: no minute in ten hours has ${atLeast} retry slots open`);
}

// --- the incident: departed calendars in their retry slot never take the batch ---------
{
  const departed = Array.from({ length: 26 }, (_, i) => departedRow(i));
  const firstTick = minuteWithOpenSlots(departed, START, 2);
  const fleet = (): Row[] => [
    ...departed.map((r) => ({ ...r })),
    ...Array.from({ length: 8 }, (_, i) => healthyRow(i, firstTick - (i + 1) * 3 * 60 * MINUTE)),
  ];

  // Precondition: at the first tick, at least two departed calendars ARE eligible under
  // the shared gate, so the fixture really reproduces 2026-10-16 rather than a tick that
  // was healthy for an unrelated reason.
  assert(
    departed.filter((r) => syncEligible(r, firstTick)).length >= 2,
    "fixture: two departed calendars have their retry slot open on the first tick",
  );

  const rows = fleet();
  const pickedEver = new Set<string>();
  const verdicts: HydrationTickVerdict[] = [];
  for (let t = 0; t < 96; t++) {
    const { picked, verdict } = runTick(rows, firstTick + t * TICK_MS);
    picked.forEach((id) => pickedEver.add(id));
    verdicts.push(verdict);
  }
  eq(
    [...pickedEver].filter((id) => id.startsWith("departed-")),
    [],
    "across a whole day of ticks, no departed agent's calendar is ever selected",
  );
  eq(
    verdicts.filter((v) => v !== "healthy"),
    [],
    "and every tick is healthy",
  );

  // Positive control: the same fleet with nobody marked departed, which is the rotation as
  // it stood. It must reproduce the incident, or the assertions above prove nothing (L1).
  const before = fleet().map((r) => ({ ...r, departed: false }));
  const first = runTick(before, firstTick);
  assert(
    first.picked.filter((id) => id.startsWith("departed-")).length >= 2,
    "control: without the rule, two departed calendars take the front of the batch",
  );
  eq(first.verdict, "all-failed", "control: and the tick reads as all failed, the false page");
}

// --- an ACTIVE agent whose calendar fails every tick still pages ---------------------
{
  // Only failing calendars, so nothing else can refresh and turn a tick healthy: one bad
  // calendar among working ones is deliberately not this signal's job (#1544).
  const active: Row = {
    id: "active-not-provisioned",
    sync_token: "tok",
    last_failure_kind: "not-provisioned",
    consecutive_failures: 5,
    last_bootstrap_attempt_at: "2026-10-15T12:00:00.000Z",
    sync_claimed_at: null,
    departed: false,
  };
  const rows: Row[] = [active, ...Array.from({ length: 26 }, (_, i) => departedRow(i))];

  let streak = 0;
  const notified: string[] = [];
  let at = START;
  const verdicts: HydrationTickVerdict[] = [];
  for (let t = 0; t < 4; t++) {
    at = minuteWithOpenSlots([rows[0]!], at + MINUTE, 1);
    const plan = planHydrationTick(rows, at);
    eq(plan.due.map((c) => c.id), [active.id], `tick ${t + 1} selects the active agent's calendar`);
    rows[0]!.last_bootstrap_attempt_at = new Date(at).toISOString();
    rows[0]!.consecutive_failures++;
    const verdict = await runHydrationTickCheck({
      tick: hydrationMeasuredTick({ due: plan.due.length, refreshed: 0, failed: 1, skipped: 0 }),
      recordStreak: async () => ++streak >= 4,
      clearStreak: async () => {
        streak = 0;
      },
      notify: async (key) => {
        notified.push(key);
      },
      resolve: async () => false,
      cooldownMs: 0,
      consecutiveTicks: 4,
    });
    verdicts.push(verdict);
  }
  eq(verdicts, ["all-failed", "all-failed", "all-failed", "all-failed"], "every tick reads as all failed");
  eq(notified, ["hydration_all_failing"], "and the fourth pages, as the alert exists to");
}

// --- a tick where every eligible calendar is departed measured nothing -----------------
{
  const departed = Array.from({ length: 26 }, (_, i) => departedRow(i));
  const at = minuteWithOpenSlots(departed, START, 2);
  const plan = planHydrationTick(departed, at);
  eq(plan.due.length, 0, "nothing is due when only departed calendars are eligible");
  eq(plan.departedSkipped, 26, "and every one of them is counted as left out");
  eq(
    hydrationTickVerdict(hydrationMeasuredTick({ due: 0, refreshed: 0, failed: 0, skipped: 0 })),
    "unmeasured",
    "so the tick neither pages nor clears",
  );
}

// --- the count the cycle line reports, and the batch it is sized from -----------------
{
  // Today's counts (2026-10-16): 153 calendars, 26 of them departed.
  const rows: Row[] = [
    ...Array.from({ length: 127 }, (_, i) => healthyRow(i, START - (i + 1) * MINUTE)),
    ...Array.from({ length: 26 }, (_, i) => departedRow(i)),
  ];
  const plan = planHydrationTick(rows, START);
  eq(plan.considered.length, 127, "the rotation considers the 127 calendars of agents still here");
  eq(plan.departedSkipped, 26, "and reports the 26 it left out");
  eq(plan.batchSize, hydrationBatchSize(127), "the batch is sized over what it considers");
  eq(hydrationBatchSize(153), 2, "before: 153 calendars gave a batch of 2");
  eq(hydrationBatchSize(127), 2, "after: 127 calendars still give a batch of 2");

  // Where the two numbers differ, the considered count must win, or the departed rows
  // would quietly inflate everyone else's refresh rate.
  const big: Row[] = [
    ...Array.from({ length: 200 }, (_, i) => healthyRow(i, START - (i + 1) * MINUTE)),
    ...Array.from({ length: 100 }, (_, i) => departedRow(i)),
  ];
  const bigPlan = planHydrationTick(big, START);
  eq(bigPlan.batchSize, hydrationBatchSize(200), "the batch follows the 200 considered, not all 300");
  assert(hydrationBatchSize(200) !== hydrationBatchSize(300), "fixture: those two sizes really differ");
}

// --- a departed calendar that never loaded is not onboarding owed ---------------------
{
  const neverLoadedDeparted: Row = { ...departedRow(0), last_bootstrap_attempt_at: null, consecutive_failures: 0, last_failure_kind: null };
  const neverLoadedActive: Row = { ...healthyRow(0, START), last_bootstrap_attempt_at: null };
  const plan = planHydrationTick([neverLoadedDeparted, neverLoadedActive], START);
  eq(plan.neverCovered, 1, "only the active agent's never loaded calendar counts as onboarding");
  eq(plan.due.map((c) => c.id), [neverLoadedActive.id], "and only it is taken");
}

// --- a returning agent's calendar comes straight back --------------------------------
{
  // The rule is read off `deactivated_at` on every tick, never cached, so clearing it puts
  // the calendar back in the rotation on the next tick. (Its pool re-entry hydrates it at
  // once anyway, #2302.)
  const back: Row = { ...healthyRow(0, START - 30 * 60 * MINUTE), departed: false };
  const gone: Row = { ...back, departed: true };
  eq(planHydrationTick([gone], START).due.length, 0, "while departed it is left out");
  eq(planHydrationTick([back], START).due.map((c) => c.id), [back.id], "once returned it is selected again");
}

// --- reading `deactivated_at` off the embedded user row ------------------------------
{
  eq(departedFromEmbed({ deactivated_at: null }), false, "a null stamp is somebody still here");
  eq(departedFromEmbed({ deactivated_at: "2026-09-01T00:00:00Z" }), true, "a stamp is somebody who left");
  eq(departedFromEmbed([{ deactivated_at: "2026-09-01T00:00:00Z" }]), true, "the one row array shape reads the same");

  // An embed that did not come back is NOT "still here". Reading it that way would put
  // the departed calendars straight back at the front of the batch, the incident itself.
  for (const [label, value] of [
    ["a missing embed", undefined],
    ["a null embed", null],
    ["an empty array", []],
    ["a row without the column", {}],
    ["a column of the wrong type", { deactivated_at: 7 }],
  ] as const) {
    let threw = false;
    try {
      departedFromEmbed(value);
    } catch {
      threw = true;
    }
    assert(threw, `${label} refuses rather than reading as not departed`);
  }
}

finish();
