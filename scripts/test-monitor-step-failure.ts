// A monitor check that fails on EVERY tick is contained, logged and never paged (#2382).
//
// Since #1281 every check on the monitor lane runs inside `steps.run`, which
// catches a throw, returns the fallback, records `ok: false` and never throws. The
// route then logs `steps.fields()` and stamps the lane heartbeat unconditionally.
// So a step that throws forever is written once per tick into a 7 day log nobody
// is paged from, the heartbeat stays fresh, the watchdog is silent and
// /api/health is green. Before #1281 the same throw killed the tick, the
// heartbeat lapsed, and the watchdog paged within the monitor lane's 20 minute
// bound; containment removed the only signal without adding a replacement.
//
// The widest case is `lane_watchdog`, which is itself one of those steps: if it
// throws, the dead man's switch for every other lane is dead behind a live
// heartbeat, and the sync, recompute and outbox lanes can all stop with nothing
// saying so (L71).
//
// What is pinned here: the streak that decides when a failing step speaks, the
// re-arm streak that decides when it may say it is over, the two states that must
// produce NEITHER (a step that did not run this tick, and a streak store that
// could not be read), the copy, and the watchdog's own verdict stamp.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-monitor-step-failure.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStepRunner } from "../src/lib/monitor/step-runner.ts";
import { LANE_STALE_BOUNDS_MS, LANE_WATCHDOG_UNJUDGED } from "../src/lib/monitor/health.ts";
import {
  LANE_WATCHDOG_VERDICT_LANE,
  laneWatchdogReachedVerdict,
} from "../src/lib/monitor/verdict-freshness.ts";
import {
  MONITOR_CADENCE_MS,
  MONITOR_STEP_FAILING_TICKS,
  MONITOR_STEP_STREAK_WINDOW_S,
  SETUP_STEP_READS,
  checksGatedByStep,
  judgeMonitorSteps,
  monitorStepFailingAlert,
  monitorStepRecoveryText,
  stepCadenceMs,
  stepFailingAlertKey,
  stepFailingRuns,
  stepFailStreakKey,
  stepOkStreakKey,
  stepRearmRuns,
  stepStreakWindowS,
  type MonitorStepStreaks,
} from "../src/lib/monitor/step-failure.ts";
import {
  CROSS_SYSTEM_BOOKINGS_CADENCE_MS,
  crossSystemBookingsDue,
} from "../src/lib/monitor/cross-system-bookings.ts";
import { ALL_SETUP_READ } from "../src/lib/monitor/setup-gates.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { memoryStreaks } from "./lib/memory-step-streaks.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const ROOT = join(import.meta.dirname, "..");


/** One tick's outcomes, in the shape `steps.outcomes()` returns. */
const tick = (...steps: { name: string; ok: boolean }[]) => steps;

// --- the threshold is DERIVED, not declared beside the thing it protects ------
{
  // The pre-#1281 behaviour is the bar: a throwing step killed the tick, the
  // heartbeat lapsed, and the watchdog paged one `monitor` bound later. The
  // replacement must not be slower than the thing it replaces.
  eq(MONITOR_CADENCE_MS, 5 * 60_000, "the monitor lane's cadence is five minutes");
  eq(
    MONITOR_STEP_FAILING_TICKS,
    Math.floor(LANE_STALE_BOUNDS_MS.monitor / MONITOR_CADENCE_MS),
    "the failing-step threshold is derived from the monitor lane's own stale bound, so widening that bound moves this with it",
  );
  assert(
    MONITOR_STEP_FAILING_TICKS > 1,
    "one bad tick never pages, so a transient blip at Supabase or Google cannot wake anybody",
  );
  assert(
    MONITOR_STEP_FAILING_TICKS * MONITOR_CADENCE_MS <= LANE_STALE_BOUNDS_MS.monitor,
    "a step failing forever pages no later than the lapsed heartbeat used to, before containment removed that signal",
  );
  assert(
    MONITOR_STEP_STREAK_WINDOW_S * 1000 >= 2 * MONITOR_STEP_FAILING_TICKS * MONITOR_CADENCE_MS,
    "the streak window comfortably holds a whole streak, so a late tick cannot split one genuine run in two",
  );
}

// --- a step that throws on N consecutive ticks pages exactly once -------------
{
  const streaks = memoryStreaks();
  const pages: string[][] = [];
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS; i++) {
    const verdict = await judgeMonitorSteps(
      tick({ name: "inactive_bookings", ok: false }, { name: "migration_drift", ok: true }),
      streaks,
    );
    pages.push(verdict.page.map((p) => p.step));
  }
  const spoke = pages.filter((p) => p.length > 0);
  eq(spoke.length, 1, `exactly one of the first ${MONITOR_STEP_FAILING_TICKS} ticks pages`);
  eq(
    pages[MONITOR_STEP_FAILING_TICKS - 1],
    ["inactive_bookings"],
    "and it is the Nth tick, naming the step that failed rather than only counting it",
  );
  assert(
    !pages[MONITOR_STEP_FAILING_TICKS - 1].includes("migration_drift"),
    "a step that succeeded on the same tick is not named in the page",
  );
}

// --- a step that throws FEWER than N times does not page ----------------------
{
  const streaks = memoryStreaks();
  let spoke = 0;
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS - 1; i++) {
    const verdict = await judgeMonitorSteps(tick({ name: "override_sweep", ok: false }), streaks);
    spoke += verdict.page.length;
  }
  eq(spoke, 0, "a run shorter than the threshold stays silent");
}

// --- one good tick interrupts the streak, so a flapping step never pages ------
{
  const streaks = memoryStreaks();
  let spoke = 0;
  for (let i = 0; i < 4 * MONITOR_STEP_FAILING_TICKS; i++) {
    const verdict = await judgeMonitorSteps(
      tick({ name: "override_sweep", ok: i % 2 === 0 }),
      streaks,
    );
    spoke += verdict.page.length;
  }
  eq(spoke, 0, "a step alternating between failing and working never reaches a consecutive streak");
}

// --- a step that recovers sends the all clear, and only after the re-arm ------
{
  const streaks = memoryStreaks();
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS; i++) {
    await judgeMonitorSteps(tick({ name: "lane_watchdog", ok: false }), streaks);
  }
  const clears: string[][] = [];
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS; i++) {
    const verdict = await judgeMonitorSteps(tick({ name: "lane_watchdog", ok: true }), streaks);
    eq(verdict.page.length, 0, "a working step never pages");
    clears.push(verdict.recovered);
  }
  eq(clears[0], [], "one healthy tick is not the condition being over (L160)");
  eq(
    clears[MONITOR_STEP_FAILING_TICKS - 1],
    ["lane_watchdog"],
    "the all clear arrives once the step has completed for a whole re-arm window",
  );
}

// --- a step that did NOT run this tick clears nothing and pages nothing -------
//
// The all-clear must hang off a MEASURED healthy result, never off "we did not
// see it fail". A step absent from the outcomes is a step nothing measured: an
// earlier gate stood it down, or the tick died before reaching it.
{
  const streaks = memoryStreaks();
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS; i++) {
    await judgeMonitorSteps(tick({ name: "avail_truth", ok: false }), streaks);
  }
  const resolvedForAbsentStep: string[] = [];
  let pagedForAbsentStep = 0;
  for (let i = 0; i < 3 * MONITOR_STEP_FAILING_TICKS; i++) {
    const verdict = await judgeMonitorSteps(tick({ name: "migration_drift", ok: true }), streaks);
    pagedForAbsentStep += verdict.page.filter((p) => p.step === "avail_truth").length;
    resolvedForAbsentStep.push(...verdict.recovered.filter((s) => s === "avail_truth"));
  }
  eq(resolvedForAbsentStep.length, 0, "a step missing from the tick is never all-cleared: nothing measured it working");
  eq(pagedForAbsentStep, 0, "and it is never paged on either, for the same reason");
  eq(
    streaks.counts.get(stepFailStreakKey("avail_truth")),
    MONITOR_STEP_FAILING_TICKS,
    "its failure streak is left exactly where it was, so the page stands until the step is measured again",
  );
  assert(
    !streaks.counts.has(stepOkStreakKey("avail_truth")),
    "and a tick that never ran it grows no re-arm streak for it",
  );
}

// --- a step that RAN but measured nothing counts as neither (#3955, L792) ------
//
// Most gated checks consult their gate INSIDE their step, so a shut gate still
// appears in the outcomes. Recorded as a healthy run, four ticks of a shut gate
// cleared a standing page with "it is being checked once more", which is the one
// thing that was not happening. Marked unmeasured, it moves neither streak.
{
  const streaks = memoryStreaks();
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS; i++) {
    await judgeMonitorSteps(tick({ name: "below_lead_tier", ok: false }), streaks);
  }
  let recovered = 0;
  let paged = 0;
  for (let i = 0; i < 3 * MONITOR_STEP_FAILING_TICKS; i++) {
    const verdict = await judgeMonitorSteps([{ name: "below_lead_tier", ok: true, measured: false }], streaks);
    recovered += verdict.recovered.length;
    paged += verdict.page.length;
  }
  eq(recovered, 0, "a step whose gate was shut for a whole re-arm window is never all-cleared");
  eq(paged, 0, "and an unmeasured tick never adds to a page either");
  eq(
    streaks.counts.get(stepFailStreakKey("below_lead_tier")),
    MONITOR_STEP_FAILING_TICKS,
    "its failure streak stands, so the page stays open until the step is measured working",
  );
  assert(!streaks.counts.has(stepOkStreakKey("below_lead_tier")), "and no re-arm streak grows for it");

  // A name both unmeasured and failed in one tick (the runner sums duplicates) is a failure.
  const both = memoryStreaks();
  await judgeMonitorSteps(
    [
      { name: "dup", ok: true, measured: false },
      { name: "dup", ok: false },
    ],
    both,
  );
  eq(both.counts.get(stepFailStreakKey("dup")), 1, "a throw beside an unmeasured run of the same name still counts");
}

// --- a step that measures on a SLOWER cadence is counted in its own runs -------
//
// `cross_system_bookings` reads cal.com once an hour, on the monitor tick in the
// first five minutes of it. Counted in five minute ticks, its eleven idle ticks an
// hour broke every failure streak, and a forty minute window could never hold four
// hourly failures anyway, so a check throwing on every one of its runs never paged
// (bidspoke#2538 is the same defect on another lane). The store below keeps the
// real `rate_limit_hit` contract, a FIXED window from the first hit, because the
// window is half of what broke.
{
  let nowMs = Date.UTC(2026, 9, 23, 0, 0, 0);
  const rows = new Map<string, { start: number; count: number }>();
  const windowed: MonitorStepStreaks = {
    async bump(key, windowSeconds, alertAt) {
      const r = rows.get(key);
      if (!r || r.start < nowMs - windowSeconds * 1000) rows.set(key, { start: nowMs, count: 1 });
      else r.count++;
      return rows.get(key)!.count >= alertAt;
    },
    async clear(key) {
      rows.delete(key);
    },
  };
  const hourly = "cross_system_bookings";
  eq(
    stepCadenceMs(hourly),
    CROSS_SYSTEM_BOOKINGS_CADENCE_MS,
    "the hourly check's cadence is read from the check itself, not restated",
  );
  eq(stepCadenceMs("inactive_bookings"), MONITOR_CADENCE_MS, "every other step runs at the lane's own cadence");
  eq(stepFailingRuns("inactive_bookings"), MONITOR_STEP_FAILING_TICKS, "an every tick step keeps its threshold");
  eq(stepStreakWindowS("inactive_bookings"), MONITOR_STEP_STREAK_WINDOW_S, "and its window");
  assert(stepFailingRuns(hourly) >= 2, "one failed hourly run is still a blip, never a page");
  assert(
    stepStreakWindowS(hourly) * 1000 >= (stepFailingRuns(hourly) + 1) * CROSS_SYSTEM_BOOKINGS_CADENCE_MS,
    "the hourly streak's window holds all its runs with one to spare, so consecutive runs are never split",
  );

  // Its due rule fires on exactly one monitor tick per cadence, which is what makes
  // counting it in runs of that cadence right.
  const dueTicks: number[] = [];
  for (let t = nowMs; t < nowMs + 24 * 60 * 60_000; t += MONITOR_CADENCE_MS) {
    if (crossSystemBookingsDue(t)) dueTicks.push(t);
  }
  eq(dueTicks.length, (24 * 60 * 60_000) / CROSS_SYSTEM_BOOKINGS_CADENCE_MS, "the check is due once per cadence");
  assert(
    dueTicks.every((t, i) => i === 0 || t - dueTicks[i - 1] === CROSS_SYSTEM_BOOKINGS_CADENCE_MS),
    "and its runs are exactly one cadence apart",
  );

  // Throwing on every run it makes, idle (and saying so) on every tick between.
  const pagedAt: number[] = [];
  for (let i = 0; i < 4 * 12; i++, nowMs += MONITOR_CADENCE_MS) {
    const due = crossSystemBookingsDue(nowMs);
    const verdict = await judgeMonitorSteps(
      [
        due ? { name: hourly, ok: false } : { name: hourly, ok: true, measured: false },
        { name: "migration_drift", ok: true },
      ],
      windowed,
    );
    if (verdict.page.some((p) => p.step === hourly)) pagedAt.push(i);
    eq(verdict.recovered.includes(hourly), false, "an idle tick between failing runs never reads as recovery");
  }
  assert(pagedAt.length > 0, "an hourly check throwing on every run pages");
  eq(
    pagedAt[0],
    (stepFailingRuns(hourly) - 1) * 12,
    "on its Nth failing run, counted in its own runs rather than the lane's ticks",
  );

  // And it ends only on its own healthy runs, the idle ticks between moving nothing.
  const recoveredAt: number[] = [];
  for (let i = 0; i < 4 * 12; i++, nowMs += MONITOR_CADENCE_MS) {
    const due = crossSystemBookingsDue(nowMs);
    const verdict = await judgeMonitorSteps(
      [{ name: hourly, ok: true, measured: due }],
      windowed,
    );
    if (verdict.recovered.includes(hourly)) recoveredAt.push(i);
  }
  eq(recoveredAt[0], (stepRearmRuns(hourly) - 1) * 12, "the all clear lands on its Nth healthy run, not on idle ticks");

  const page = monitorStepFailingAlert({ step: hourly, ticks: stepFailingRuns(hourly), reason: null, gated: [] });
  assert(
    page.includes(`${stepFailingRuns(hourly)} consecutive runs`) && page.includes("hours"),
    `the hourly page counts runs and hours, not five minute ticks: ${page}`,
  );
  assert(!page.includes("ticks"), "and never calls an hourly run a tick");
  const clear = monitorStepRecoveryText(hourly, stepRearmRuns(hourly));
  assert(
    clear.includes(`${stepRearmRuns(hourly)} consecutive runs`) && !clear.includes("ticks"),
    `the hourly all clear counts runs too: ${clear}`,
  );
  assert(!DASHES.test(page) && !DASHES.test(clear), "neither holds an em or en dash");
}

// --- a tick whose streak store cannot be read speaks in NEITHER direction -----
{
  const blind = memoryStreaks({ readable: false });
  const resolvedOnBlindTick: string[] = [];
  let pagedOnBlindTick = 0;
  for (let i = 0; i < 4 * MONITOR_STEP_FAILING_TICKS; i++) {
    const failing = await judgeMonitorSteps(tick({ name: "sync_staleness", ok: false }), blind);
    const healthy = await judgeMonitorSteps(tick({ name: "sync_staleness", ok: true }), blind);
    pagedOnBlindTick += failing.page.length + healthy.page.length;
    resolvedOnBlindTick.push(...failing.recovered, ...healthy.recovered);
  }
  eq(
    resolvedOnBlindTick.length,
    0,
    "a tick whose streak store could not be read announces no recovery: it measured nothing, so it clears nothing",
  );
  eq(
    pagedOnBlindTick,
    0,
    "and it invents no page either, because a streak that could not be tracked is not a streak",
  );
}

// --- the two streaks are keyed apart, per step and per direction --------------
{
  const streaks = memoryStreaks();
  await judgeMonitorSteps(
    tick({ name: "override_sweep", ok: false }, { name: "migration_drift", ok: true }),
    streaks,
  );
  assert(
    streaks.counts.has(stepFailStreakKey("override_sweep")),
    "a failing step counts against its OWN failure streak",
  );
  assert(
    streaks.counts.has(stepOkStreakKey("migration_drift")),
    "a working step counts against its OWN re-arm streak",
  );
  assert(
    stepFailStreakKey("a") !== stepOkStreakKey("a") &&
      stepFailStreakKey("a") !== stepFailStreakKey("b"),
    "no two streaks share a key, in either direction or across steps",
  );
  assert(
    stepFailingAlertKey("override_sweep") === "monitor_step_failing:override_sweep",
    "the alert key is per step, so one failing step cannot throttle away the first page for another",
  );
}

// --- a failing SETUP read names the checks it took down -----------------------
{
  // Derived from the shipped `monitorSetupGates`, never a second hand list: the
  // gate decides what a failed read stands down, so it must be the thing asked.
  const gatedByBuckets = checksGatedByStep("setup_buckets");
  assert(gatedByBuckets.length > 0, "an unreadable bucket list takes at least one check down");
  const gatedByHorizon = checksGatedByStep("setup_horizon");
  assert(
    gatedByHorizon.length > 0 && gatedByHorizon.join() !== gatedByBuckets.join(),
    "each setup read takes its OWN dependents down, so the message is not one list for all five",
  );
  eq(
    checksGatedByStep("inactive_bookings"),
    [],
    "an ordinary check gates nothing, so its page never claims to have taken others down",
  );
  // Every gated check is named in words, never by its raw key (#2593 shipped
  // `belowLeadTier` and #2505 `tierStaffing` with no name, so an unreadable
  // bucket list or week paged the camelCase key). `tsc` enforces the map's keys;
  // this asserts what reaches the page.
  for (const step of Object.keys(SETUP_STEP_READS)) {
    for (const name of checksGatedByStep(step)) {
      assert(/^the [a-z]/.test(name) && !/[a-z][A-Z]/.test(name), `${step} names ${name} in words, not as a gate key`);
    }
  }
  assert(
    checksGatedByStep("setup_buckets").includes("the booking below the lead's Salesforce tier check"),
    "an unreadable bucket list says it took the below lead tier check down",
  );
  for (const step of Object.keys(SETUP_STEP_READS)) {
    assert(
      checksGatedByStep(step).length > 0,
      `${step} is a setup read whose failure stands checks down, and the page says which`,
    );
  }
  // #2773: the settings read is a setup read like the others, so a sustained
  // failure with nothing to fall back on pages naming the switches it took down,
  // rather than those checks going quiet one tick at a time with nothing said.
  const gatedBySettings = checksGatedByStep("setup_settings");
  for (const name of [
    "the booking failure rate page",
    "the waiting to become bookable page",
    "the unroutable Regal caller alarm",
    "the unreadable Regal events alarm",
    "the low booking volume alarm",
  ]) {
    assert(gatedBySettings.includes(name), `an unreadable settings read says it took down ${name}`);
  }
  assert(
    !gatedBySettings.includes("the availability scan"),
    "and does not claim a check that needs only a cooldown, which keeps running",
  );
  // Exhaustive in the other direction too: every readiness flag has its setup step,
  // so a read added to the gates cannot page as nothing.
  eq(
    Object.values(SETUP_STEP_READS).sort().join(","),
    Object.keys(ALL_SETUP_READ).sort().join(","),
    "every setup readiness flag is performed by a named setup step",
  );
}

// --- a whole tick's worth of steps, judged in bounded waves -------------------
//
// The lane runs about thirty steps and each costs two round trips, so they are
// advanced six at a time. That must not change WHAT is decided, and the lists
// must not come back in whatever order the waves happened to finish.
{
  const streaks = memoryStreaks();
  const names = Array.from({ length: 31 }, (_, i) => `step_${String(i).padStart(2, "0")}`);
  const failing = new Set(["step_03", "step_17", "step_29"]);
  let last: Awaited<ReturnType<typeof judgeMonitorSteps>> | null = null;
  for (let i = 0; i < MONITOR_STEP_FAILING_TICKS; i++) {
    last = await judgeMonitorSteps(
      names.map((name) => ({ name, ok: !failing.has(name) })),
      streaks,
    );
  }
  eq(
    last!.page.map((p) => p.step),
    ["step_03", "step_17", "step_29"],
    "every failing step in a wide tick is named, in the order the steps ran, never in the order the waves finished",
  );
  eq(
    last!.recovered.length,
    names.length - failing.size,
    "and every step that ran and completed is judged, so none is silently skipped by the batching",
  );
  assert(
    last!.recovered[0] === "step_00" && last!.recovered.at(-1) === "step_30",
    "the all clear list is in step order too",
  );
}

// --- the copy ----------------------------------------------------------------
{
  const page = monitorStepFailingAlert({
    step: "inactive_bookings",
    ticks: MONITOR_STEP_FAILING_TICKS,
    reason: "column bookings.agent_id does not exist",
    gated: [],
  });
  assert(page.includes("inactive_bookings"), "the page names the step, so the reader can grep for it");
  assert(
    page.includes("column bookings.agent_id does not exist"),
    "the page carries the short reason the step failed with",
  );
  assert(
    !/^Slate\b/.test(page),
    "no alert opens with the word Slate: in Slack it arrives under Slate's own app name already",
  );
  assert(!DASHES.test(page), "the page holds no em or en dash");
  assert(!page.includes("undefined") && !page.includes("[object Object]"), "nothing leaks into the page");

  const withGates = monitorStepFailingAlert({
    step: "setup_buckets",
    ticks: MONITOR_STEP_FAILING_TICKS,
    reason: null,
    gated: checksGatedByStep("setup_buckets"),
  });
  assert(
    withGates.includes(checksGatedByStep("setup_buckets")[0]),
    "a failed setup read names the checks it took down, which is the wider half of the fault",
  );
  assert(
    !withGates.includes("undefined") && !withGates.includes("null"),
    "an unreadable reason renders as a sentence, never as a leaked null",
  );

  const clear = monitorStepRecoveryText("inactive_bookings", MONITOR_STEP_FAILING_TICKS);
  assert(clear.includes("inactive_bookings"), "the all clear names the same step the page named");
  assert(!DASHES.test(clear), "the all clear holds no em or en dash");
  assert(!/^Slate\b/.test(clear), "the all clear does not open with the word Slate");
  assert(
    clear !== page,
    "the all clear is its own sentence, never the page repeated",
  );
}

// --- lane_watchdog: a throwing step leaves its verdict stamp UNWRITTEN --------
//
// Driven through the REAL step runner rather than a hand-made outcome, because
// the value the predicate is asked about is the one the runner hands back when a
// step throws, and that is the coupling worth pinning.
{
  const stamped: string[] = [];
  const recordVerdict = async (lane: string, reached: boolean) => {
    if (!reached) return;
    stamped.push(lane);
  };
  const steps = createStepRunner({ now: () => 0, onError: () => {} });

  const threw = await steps.run("lane_watchdog", LANE_WATCHDOG_UNJUDGED, async () => {
    throw new Error("alert_state.last_sent_at does not exist");
  });
  await recordVerdict(LANE_WATCHDOG_VERDICT_LANE, laneWatchdogReachedVerdict(threw));
  eq(stamped, [], "a watchdog step that THREW stamps no verdict, so the detector goes stale");

  const unreadable = await steps.run("lane_watchdog", LANE_WATCHDOG_UNJUDGED, async () => ({
    judged: false,
    stale: [],
  }));
  await recordVerdict(LANE_WATCHDOG_VERDICT_LANE, laneWatchdogReachedVerdict(unreadable));
  eq(
    stamped,
    [],
    "a watchdog that RAN and could not read the heartbeats stamps nothing either: an empty stale list is not a judgement",
  );

  const judged = await steps.run("lane_watchdog", LANE_WATCHDOG_UNJUDGED, async () => ({
    judged: true,
    stale: [],
  }));
  await recordVerdict(LANE_WATCHDOG_VERDICT_LANE, laneWatchdogReachedVerdict(judged));
  eq(
    stamped,
    [LANE_WATCHDOG_VERDICT_LANE],
    "a tick that really judged the lanes, and found them all healthy, DOES stamp",
  );
}

// --- the route wires all of it, or none of the above ships -------------------
//
// Read from the file for the same reason scripts/test-monitor-step-coverage.ts
// does: the wiring is what makes the pure decision above reach production, and a
// pure module nothing calls is the shape of a guard that verifies nothing (L3).
{
  const route = readFileSync(join(ROOT, "src/app/api/cron/monitor/route.ts"), "utf8");
  const code = route
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert(
    /judgeMonitorSteps\s*\(/.test(code),
    "the monitor route judges its own steps' outcomes",
  );
  assert(
    /steps\.run\s*\(\s*"lane_watchdog"\s*,\s*LANE_WATCHDOG_UNJUDGED/.test(code),
    "the watchdog step's fallback is the value that stamps nothing, never an empty stale list that reads as a clean judgement",
  );
  assert(
    /recordDetectorVerdict\s*\(\s*\n?\s*LANE_WATCHDOG_VERDICT_LANE\s*,\s*\n?\s*laneWatchdogReachedVerdict\s*\(/.test(
      code,
    ),
    "the watchdog's verdict is stamped through the same predicate this file pins",
  );
  assert(
    /stepFailingAlertKey\s*\(/.test(code),
    "the page is sent on the per step key",
  );
  // #3955: the copy counts each step in its own runs, which only holds if the route
  // asks per step rather than passing the lane's tick count to every page.
  assert(
    /ticks:\s*stepFailingRuns\(step\)/.test(code),
    "the page states the failing step's own run count",
  );
  assert(
    /monitorStepRecoveryText\(step,\s*stepRearmRuns\(step\)\)/.test(code),
    "the all clear states the recovered step's own run count",
  );
  // The hourly check's idle ticks are unmeasured, or its streak is broken eleven times an hour.
  const crossAt = code.indexOf('"cross_system_bookings"');
  assert(crossAt >= 0, "the hourly cross system check is a named step");
  const crossBody = code.slice(crossAt, code.indexOf("steps.run", crossAt + 30));
  assert(
    /status\s*===\s*"not-due"[\s\S]{0,80}unmeasured\(/.test(crossBody),
    "a tick on which the hourly check is not due is recorded as unmeasured",
  );
  // Derived from the file (L96): ANY step that answers a not-due tick works on a slower
  // cadence, and without a declared one its runs are counted in ticks inside a window
  // that expires between them, so it could never page.
  const slower: string[] = [];
  for (let at = code.indexOf("steps.run"); at >= 0; at = code.indexOf("steps.run", at + 1)) {
    const named = /^steps\.run\s*(?:<[\s\S]*?>\s*)?\(\s*"([a-z_]+)"/.exec(code.slice(at, at + 300));
    if (!named) continue;
    const next = code.indexOf("steps.run", at + 1);
    if (/"not-due"/.test(code.slice(at, next < 0 ? code.length : next))) slower.push(named[1]);
  }
  assert(slower.includes("cross_system_bookings"), "the scan finds the hourly check it exists to hold");
  eq(
    slower.filter((step) => stepCadenceMs(step) === MONITOR_CADENCE_MS),
    [],
    "every step with a not-due tick declares its own cadence in MONITOR_STEP_CADENCE_MS",
  );
}

finish();
