/**
 * When a CONTAINED monitor check that keeps failing is allowed to speak (#2382).
 *
 * #1281 gave every check on the monitor lane its own failure boundary, which was
 * right: one broken check used to skip every check below it. What it removed
 * along the way was the only signal that a check was broken at all. A step that
 * throws is caught, its name is appended to the cycle log line, the lane
 * heartbeat is still stamped, and the tick returns 200. Nothing reads
 * `steps_failed`, no alert key mentions a step, and Cloudflare logs have no
 * alerting on top of them and a seven day retention. Before containment the same
 * throw killed the tick, the heartbeat lapsed, and the watchdog paged one
 * `monitor` bound later; that was the loudness containment took away.
 *
 * The widest case is `lane_watchdog`, which is one of those steps: if it throws,
 * the dead man's switch for every other lane is dead behind a live heartbeat and
 * sync, recompute and outbox can all stop with nothing saying so (L71). Its
 * second half is the `verdict:lane-watchdog` stamp in verdict-freshness.ts.
 *
 * PURE: the route hands in this tick's outcomes and a streak store, and a verdict
 * comes back, so scripts/test-monitor-step-failure.ts replays a whole morning of
 * ticks against an in-memory store with no clock and no database.
 *
 * Both sides are STREAKS, copying `src/lib/availability/recompute-alert.ts`
 * rather than inventing a second shape. A single failed tick is a Supabase blip
 * or a bad minute at Google, and paging on one is how a channel gets ignored
 * (L36); a single GOOD tick is not the condition being over either, because a
 * step that alternates is still broken (L160).
 */
import { LANE_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { CROSS_SYSTEM_BOOKINGS_CADENCE_MS } from "@/lib/monitor/cross-system-bookings";
import { AUTH_UNEXPECTED_SIGN_IN_CADENCE_MS } from "@/lib/monitor/auth-unexpected-sign-ins";
import {
  ALL_SETUP_READ,
  monitorSetupGates,
  type SetupReadiness,
} from "@/lib/monitor/setup-gates";

/** The monitor lane's cron cadence. */
export const MONITOR_CADENCE_MS = 5 * 60_000;

/**
 * Consecutive failed ticks before the page. DERIVED from the monitor lane's own
 * stale bound rather than declared beside it (the #1248 rule the recompute
 * streak follows), because that bound IS the thing being restored: before #1281
 * a step that threw took the tick down, the heartbeat lapsed, and the watchdog
 * paged exactly one `monitor` bound later. A replacement slower than what it
 * replaces would be a regression nobody could see, and widening the bound has to
 * move this with it.
 *
 * Four ticks, twenty minutes, at today's values.
 */
export const MONITOR_STEP_FAILING_TICKS = Math.floor(
  LANE_STALE_BOUNDS_MS.monitor / MONITOR_CADENCE_MS,
);

/** Consecutive healthy ticks before the all clear: the L160 re-arm window. */
export const MONITOR_STEP_REARM_TICKS = MONITOR_STEP_FAILING_TICKS;

/**
 * The `rate_limit_hit` window each streak is counted in. It must hold the whole
 * streak comfortably, because the window is FIXED from the first hit and a hit
 * past its end starts the count again at one; twice the streak leaves room for a
 * late tick without ever splitting a genuine run in two.
 */
export const MONITOR_STEP_STREAK_WINDOW_S =
  (2 * Math.max(MONITOR_STEP_FAILING_TICKS, MONITOR_STEP_REARM_TICKS) * MONITOR_CADENCE_MS) / 1000;

/**
 * A failing step stays failing until somebody deploys a fix, so re-page every two
 * hours rather than every five minutes. Same reasoning and the same number as the
 * recompute lane's headroom page.
 */
export const MONITOR_STEP_ALERT_COOLDOWN_MS = 2 * 60 * 60_000;

/**
 * Steps that do their work on a SLOWER cadence than the lane's tick (#3955, L792).
 *
 * Such a step still runs on every tick, and on the ticks it is not due it marks
 * itself unmeasured, so those ticks move neither streak. That is half the fix: a
 * streak counted in five minute ticks, inside a window sized for five minute ticks,
 * still cannot hold four hourly failures, because the fixed window has expired
 * before the second one arrives. So each such step is counted in runs of its own
 * cadence, with a window sized for them. The cadence is read from the check itself,
 * never restated here. An every tick step needs no entry.
 */
export const MONITOR_STEP_CADENCE_MS: Readonly<Record<string, number>> = {
  cross_system_bookings: CROSS_SYSTEM_BOOKINGS_CADENCE_MS,
  // #4379: the sign in method claims and the account listing are read once an hour.
  auth_unexpected_sign_in: AUTH_UNEXPECTED_SIGN_IN_CADENCE_MS,
};

/** How often `step` actually does its work. */
export function stepCadenceMs(step: string): number {
  return MONITOR_STEP_CADENCE_MS[step] ?? MONITOR_CADENCE_MS;
}

/**
 * Consecutive failing RUNS of `step` before its page. The same derivation as
 * `MONITOR_STEP_FAILING_TICKS`, in the step's own runs, so an every tick step is
 * unchanged. A step slower than the lane's stale bound cannot page inside it at
 * all, so it pages on its second failing run: one failed run is still a blip (L36),
 * the precedent the hourly coverage retry set (`sweep-failure.ts`).
 */
export function stepFailingRuns(step: string): number {
  return Math.max(2, Math.floor(LANE_STALE_BOUNDS_MS.monitor / stepCadenceMs(step)));
}

/** Consecutive healthy runs of `step` before its all clear: the L160 re-arm window. */
export function stepRearmRuns(step: string): number {
  return stepFailingRuns(step);
}

/** The fixed `rate_limit_hit` window `step`'s streaks are counted in, sized for its cadence. */
export function stepStreakWindowS(step: string): number {
  return (2 * Math.max(stepFailingRuns(step), stepRearmRuns(step)) * stepCadenceMs(step)) / 1000;
}

/** How many steps' streaks are advanced at once. See `judgeMonitorSteps`. */
const JUDGE_CONCURRENCY = 6;

/**
 * Per step, so one broken check cannot throttle away the first page for another.
 * A family key (`monitor_step_failing:*` in the alert catalog), like
 * `cron_lane_stale:*`.
 */
export const stepFailingAlertKey = (step: string) => `monitor_step_failing:${step}`;

/** The two streak counters, kept apart from each other and from the alert key. */
export const stepFailStreakKey = (step: string) => `monitor_step_fail:${step}`;
export const stepOkStreakKey = (step: string) => `monitor_step_ok:${step}`;

/**
 * The two operations the decision needs from `src/lib/notify/streak.ts`.
 * `bump` answers whether the streak has REACHED its threshold (and keeps
 * answering true on every hit after), and answers FALSE on a tracking failure so
 * a streak is never invented; `clear` forgets the streak.
 */
export interface MonitorStepStreaks {
  bump(key: string, windowSeconds: number, alertAt: number): Promise<boolean>;
  clear(key: string): Promise<void>;
}

/** One step's outcome this tick, the shape `steps.outcomes()` returns. */
export interface StepTickOutcome {
  name: string;
  ok: boolean;
  /** False when the step ran and measured nothing (`StepContext.unmeasured`). Absent means measured. */
  measured?: boolean;
}

export interface MonitorStepVerdict {
  /** Steps that have now failed for the whole window: page (the cooldown throttles repeats). */
  page: { step: string }[];
  /** Steps that have now worked for the whole re-arm window: the condition is over. */
  recovered: string[];
}

/**
 * Which handler-level setup read each `setup_*` step performs (#1395).
 *
 * The map exists so a failed READ can say what it took DOWN, which is the wider
 * half of that fault: `monitorSetupGates` correctly stands its dependents down,
 * every tick, silently, and a page naming only the read would send somebody
 * looking for one broken check when six are not running.
 */
export const SETUP_STEP_READS: Record<string, keyof SetupReadiness> = {
  setup_buckets: "buckets",
  setup_slot_rows: "slotHealth",
  setup_business_hours: "businessHours",
  setup_hours: "workingHours",
  setup_horizon: "horizonDays",
  // #2773: the armed switches and floors. Null only with no last known value.
  setup_settings: "settings",
};

/**
 * Reader-facing names for the gated checks, so the page is a sentence.
 *
 * Keyed on the gates `monitorSetupGates` actually returns, so a new gate with no
 * name here fails `tsc` rather than reaching a page as its raw camelCase key.
 */
const GATE_NAMES: Record<keyof ReturnType<typeof monitorSetupGates>, string> = {
  availabilityScan: "the availability scan",
  availabilityTruth: "the availability drift probe",
  lowVolume: "the low booking volume alarm",
  rosterCoverage: "the roster coverage check",
  calendarWindow: "the calendar hydration check",
  busyDrift: "the busy drift sampler",
  poolFullness: "the nearly full pool whisper",
  tierStaffing: "the debt tier staffing alarm",
  belowLeadTier: "the booking below the lead's Salesforce tier check",
  offsiteOrigin: "the real booking from an off site host page check",
  regalCallsQuiet: "the no Regal calls all business day alarm",
  failureRate: "the booking failure rate page",
  awaitingActivation: "the waiting to become bookable page",
  regalCalls: "the unroutable Regal caller alarm",
  regalCallsUnreadable: "the unreadable Regal events alarm",
  regalCallOutcomes: "the missing Regal call outcomes alarm",
  offeredNobodyFree: "the served time the confirm refuses alarm",
  bufferBreach: "the calls inside an advisor's buffer check",
  placeholderCalls: "the placeholder call nobody called check",
  transferQueue: "the live transfer queue probe",
};

/**
 * The checks that cannot run while `step` is failing.
 *
 * ASKED of the shipped `monitorSetupGates` rather than listed here (L41): the
 * gate is what actually stands a check down, so a dependency added there reaches
 * this message with nothing to remember. Only the read under test is turned off,
 * so the answer is what THIS step took down rather than the union of everything
 * that happens to be broken.
 */
export function checksGatedByStep(step: string): string[] {
  const read = SETUP_STEP_READS[step];
  if (!read) return [];
  const gates = monitorSetupGates({ ...ALL_SETUP_READ, [read]: false });
  return Object.entries(gates)
    .filter(([, gate]) => !gate.run)
    .map(([name]) => GATE_NAMES[name as keyof typeof GATE_NAMES]);
}

/** "a, b and c", or "a and b", or "a". */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Judge one tick's step outcomes.
 *
 * A step is judged only if this tick MEASURED it. A step absent from `outcomes`
 * did not run (a gate outside it stood it down, or the tick died before reaching
 * it), and a step that ran but marked itself unmeasured (its gate inside the step
 * was shut, it was not due, its org was closed) did no work this tick (#3955).
 * Neither streak moves for either: "we did not see it fail" is not a healthy
 * result, and building an all clear on it is the defect
 * scripts/test-all-clear-failure-coverage.ts exists to stop. A step slower than the
 * lane is counted in its own runs (`MONITOR_STEP_CADENCE_MS`).
 *
 * A step that appears twice with one failure counts as failing, since the runner
 * sums duplicate names and the interesting half is the throw.
 */
export async function judgeMonitorSteps(
  outcomes: StepTickOutcome[],
  streaks: MonitorStepStreaks,
): Promise<MonitorStepVerdict> {
  const failed = new Set<string>();
  const seen: string[] = [];
  for (const o of outcomes) {
    if (o.ok && o.measured === false) continue;
    if (!seen.includes(o.name)) seen.push(o.name);
    if (!o.ok) failed.add(o.name);
  }

  const judgeOne = async (step: string): Promise<{ page: boolean; recovered: boolean }> => {
    if (failed.has(step)) {
      await streaks.clear(stepOkStreakKey(step));
      const speak = await streaks.bump(stepFailStreakKey(step), stepStreakWindowS(step), stepFailingRuns(step));
      return { page: speak, recovered: false };
    }
    await streaks.clear(stepFailStreakKey(step));
    const clear = await streaks.bump(stepOkStreakKey(step), stepStreakWindowS(step), stepRearmRuns(step));
    return { page: false, recovered: clear };
  };

  // In bounded waves, and the bound is not decoration. The lane runs about thirty
  // steps and each one costs two round trips, so doing them one after another
  // would add roughly sixty serial waits to every tick for work that is almost
  // always "nothing changed". Subrequests are not the constraint here (the
  // platform ceiling is 10,000 per invocation and steady state across all lanes is
  // about 760), the WALL TIME is. Six matches the Cloudflare simultaneous
  // connection bound used by the recompute lane.
  //
  // Results are collected by INDEX, not by completion order, so the page and
  // all-clear lists read the same on every run whatever order the waves finish in.
  const results: { page: boolean; recovered: boolean }[] = new Array(seen.length);
  for (let i = 0; i < seen.length; i += JUDGE_CONCURRENCY) {
    const wave = seen.slice(i, i + JUDGE_CONCURRENCY);
    const settled = await Promise.all(wave.map((step) => judgeOne(step)));
    settled.forEach((r, j) => {
      results[i + j] = r;
    });
  }

  const page: { step: string }[] = [];
  const recovered: string[] = [];
  seen.forEach((step, i) => {
    if (results[i].page) page.push({ step });
    if (results[i].recovered) recovered.push(step);
  });
  return { page, recovered };
}

/** An every tick step's runs are ticks; a slower step's are its own runs, never "ticks". */
function runNoun(step: string): string {
  return stepCadenceMs(step) === MONITOR_CADENCE_MS ? "ticks" : "runs";
}

/** "20 minutes" or "2 hours", whichever reads naturally. */
function aboutDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/**
 * The page. It has to carry the one thing the reader cannot work out from Slack:
 * that this is invisible everywhere else, so nothing will escalate it and no
 * other surface will show it.
 *
 * `reason` is already shortened by `shortErrorReason`; a raw error body never
 * reaches here (#1135).
 */
export function monitorStepFailingAlert(input: {
  step: string;
  ticks: number;
  reason: string | null;
  gated: string[];
}): string {
  const because = input.reason
    ? `It is failing with: ${input.reason}.`
    : `The tick recorded no reason for it, which is itself worth a look.`;
  const took = input.gated.length
    ? ` It is a shared read, so while it fails ${list(input.gated)} cannot run at all.`
    : "";
  return (
    `The monitor lane's ${input.step} step has thrown on ${input.ticks} consecutive ${runNoun(input.step)} ` +
    `(about ${aboutDuration(input.ticks * stepCadenceMs(input.step))}), so it has reported nothing in that time. ${because}${took} ` +
    `Nothing else can see this: the failure is contained so the other checks keep running, ` +
    `the lane still stamps its heartbeat, and /api/health stays green. ` +
    `Read the Worker logs for tag=monitor step=${input.step}.`
  );
}

/**
 * The all clear. It says how long the step has been working, because the page
 * was about a run of failures and one good tick was never the answer.
 */
export function monitorStepRecoveryText(step: string, ticks: number): string {
  return (
    `The monitor lane's ${step} step is running again. It has completed on ${ticks} ` +
    `consecutive ${runNoun(step)}, so whatever it checks is being checked once more and the earlier ` +
    `page is cleared. No action is needed.`
  );
}
