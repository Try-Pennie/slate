/**
 * Pure logic for the booking-failure-rate page (#1313).
 *
 * On 2026-08-06 cal.com refused more than 50 confirms in about two hours and
 * reported nothing; the only detector was Pennie's SMS complaint monitor. Slate
 * counts every booking attempt (#418, and both booker routes now record one), but
 * the tally is bucketed by DAY, and a wave of fifty refusals is invisible inside a
 * day's worth of successes. Nothing pages on it.
 *
 * The trick that gets a short window out of a daily counter without a schema
 * change: the tally is MONOTONIC within a day, so two consecutive reads give a
 * delta. The monitor lane runs every 5 minutes, so accumulating those deltas into
 * a rolling window held in one state row yields 5-minute resolution over any
 * window length.
 *
 * The edge that would silently lie is the ET day rollover: at midnight the
 * counter resets, so the next reading is SMALLER and the subtraction goes
 * negative. Clamping that to zero would report "no failures", which is the
 * healthy answer at exactly the moment we stopped measuring. Every non-advance
 * (first reading, rollover, an impossible same-day decrease) therefore
 * re-baselines and records NO sample, and says which it was.
 *
 * The window itself is time-based rather than day-based, so a rollover keeps the
 * measurements from the preceding hour: they are still true, and emptying the
 * window at midnight would blind the check for an hour every night.
 *
 * No `@/` imports, so scripts/test-monitor-booking-failure-rate.ts drives every
 * branch node-natively; the IO (the mix RPC, the state row, Slack) is injected by
 * the caller from booking-failure-rate-store.ts.
 */

import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state row key for the page and its all-clear. One constant, so the two
 *  can never drift onto different keys and leave a page that cannot be cleared. */

export const FAILURE_RATE_ALERT_KEY = "booking_failure_rate";

/** One tick's reading of the CUMULATIVE totals for the current ET day. */
export interface OutcomeReading {
  /** The ET calendar day these totals belong to. */
  day: string;
  /** Every recorded booking attempt today, across all outcomes. */
  attempts: number;
  /** Today's `error` outcome total. */
  failures: number;
  /** Today's error totals by error code. */
  byCode: Record<string, number>;
  /**
   * Today's SELF INFLICTED refusal totals (#1442 / #1450 / #1709), carried
   * through the same window as everything else.
   *
   * Deliberately NOT added to `attempts` or `failures`: the failure share is
   * unchanged by this, which is the whole reason these are counted apart. They
   * ride here because the window machinery is already exactly what they need
   * (a cumulative daily counter differenced into 5-minute intervals, rebasing at
   * the ET rollover) and building a second copy of it would be two things that
   * must agree about what "an hour" means.
   *
   * Optional, like the sample's, so an absent map reads as "nothing measured"
   * rather than taking the step down on the first tick after a deploy.
   */
  refusals?: Record<string, number>;
}

/** What changed between two consecutive readings: a real measurement of one
 *  interval, which is the thing a day's running total can never give you. */
export interface RateSample {
  atMs: number;
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
  /** #1442 / #1450 / #1709. Optional on the way IN, because a state row written
   *  before this shipped has samples without it, and a missing key must read as
   *  "not measured then" rather than crash the lane on the first tick after a
   *  deploy. */
  refusals?: Record<string, number>;
}

/** The single persisted state row: the last reading (the baseline the next delta
 *  is taken against) plus the live window of samples. */
export interface RateWindowState {
  day: string;
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
  /** The refusal baseline the next delta is measured against. Same optionality
   *  as the sample's, and for the same reason. */
  refusals?: Record<string, number>;
  samples: RateSample[];
}

/** Why a reading produced no sample, or null when it produced one normally. */
export type Rebase = "first" | "rollover" | "decrease" | null;

export interface RateThresholds {
  /** How far back the window reaches. */
  windowMs: number;
  /** Below this many measured attempts the window cannot be judged at all. */
  minAttempts: number;
  /** Failure share (percent) that must be EXCEEDED to page. */
  failPct: number;
}

/**
 * Drop samples that have aged out of the window. Strictly older than the cutoff
 * goes; a sample exactly on the boundary is still inside the window.
 *
 * Exported because the reminder lane's own rolling window (#2496) is judged by
 * `judgeFailureRate` below and so has to age its samples by exactly the same rule.
 * A second copy of this filter would be two things that must agree about what "in
 * the window" means, and the drift between them would be silent (L370).
 */
export function pruneSamples(
  samples: RateSample[],
  atMs: number,
  windowMs: number,
): RateSample[] {
  const cutoff = atMs - windowMs;
  return samples.filter((s) => s.atMs > cutoff);
}

const prune = pruneSamples;

/** Per-code delta between two cumulative maps, keeping only real increases. A
 *  code that appears for the first time counts from zero. */
function codeDeltas(
  prev: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, total] of Object.entries(next)) {
    const delta = total - (prev[code] ?? 0);
    if (delta > 0) out[code] = delta;
  }
  return out;
}

/**
 * Fold one reading into the window.
 *
 * Returns the new state and, when no sample could honestly be derived, WHY. A
 * rebase keeps the existing window (those samples are still true and still
 * inside it) and only replaces the baseline the next delta is measured against.
 */
export function advanceWindow(
  prev: RateWindowState | null,
  reading: OutcomeReading,
  atMs: number,
  windowMs: number,
): { state: RateWindowState; rebased: Rebase } {
  const baseline: RateWindowState = {
    day: reading.day,
    attempts: reading.attempts,
    failures: reading.failures,
    byCode: reading.byCode,
    refusals: reading.refusals,
    samples: prune(prev?.samples ?? [], atMs, windowMs),
  };

  if (prev === null) return { state: baseline, rebased: "first" };
  // A new ET day: the counter restarted, so the crossing interval's true delta
  // spans two days' rows and cannot be recovered from these two readings. Skip
  // the sample rather than invent one; one missing 5-minute sample out of twelve
  // is a far smaller error than a negative or a fabricated zero.
  if (prev.day !== reading.day) return { state: baseline, rebased: "rollover" };
  // Impossible while the tally only ever increments, so if it happens the rows
  // were pruned or corrected underneath us. Scoring it as zero new failures
  // would be a measurement we did not make.
  if (reading.attempts < prev.attempts || reading.failures < prev.failures) {
    return { state: baseline, rebased: "decrease" };
  }

  const sample: RateSample = {
    atMs,
    attempts: reading.attempts - prev.attempts,
    failures: reading.failures - prev.failures,
    byCode: codeDeltas(prev.byCode, reading.byCode),
    // Same delta rule as the codes, and for the same reason: the tally is
    // cumulative per ET day, so only the difference between two readings measures
    // an interval. A rebase records NO sample at all, so the refusals cannot be
    // credited to the wrong day either.
    // Both sides defaulted: a state row written before migration 0113 has no
    // baseline, and a reading assembled by anything that predates this carries no
    // refusals. Either absence must read as "nothing measured", never throw, or a
    // check that exists to speak where nothing else does would take the whole
    // lane's step down on the first tick after a deploy.
    refusals: codeDeltas(prev.refusals ?? {}, reading.refusals ?? {}),
  };
  return {
    state: { ...baseline, samples: prune([...baseline.samples, sample], atMs, windowMs) },
    rebased: null,
  };
}

export interface WindowTotals {
  attempts: number;
  failures: number;
  byCode: Record<string, number>;
}

/** Sum the samples still inside the window as of `atMs`. */
export function windowTotals(
  state: RateWindowState,
  atMs: number,
  windowMs: number,
): WindowTotals {
  const live = prune(state.samples, atMs, windowMs);
  const byCode: Record<string, number> = {};
  let attempts = 0;
  let failures = 0;
  for (const s of live) {
    attempts += s.attempts;
    failures += s.failures;
    for (const [code, n] of Object.entries(s.byCode)) byCode[code] = (byCode[code] ?? 0) + n;
  }
  return { attempts, failures, byCode };
}

export interface CodeCount {
  code: string;
  count: number;
}

export type RateVerdict =
  /** Too few measured attempts to judge. NOT healthy: it must never all-clear. */
  | { status: "insufficient"; attempts: number; failures: number }
  | { status: "healthy"; attempts: number; failures: number; pct: number; topCodes: CodeCount[] }
  | { status: "breach"; attempts: number; failures: number; pct: number; topCodes: CodeCount[] };

/**
 * Judge the window.
 *
 * Three outcomes, not two. `insufficient` exists because a quiet hour where 1 of
 * 1 attempts failed must neither page nor send an all-clear: a window too small
 * to judge measured nothing, and an all-clear hung off it would be the #1134
 * defect (a recovery notice off a signal that was never read).
 *
 * The share is compared BEFORE rounding, so a true 20.4% cannot present as an
 * at-threshold 20 and pass. `pct` is the rounded number for the reader.
 */
export function judgeFailureRate(
  state: RateWindowState,
  atMs: number,
  thresholds: RateThresholds,
): RateVerdict {
  const { attempts, failures, byCode } = windowTotals(state, atMs, thresholds.windowMs);
  if (attempts < thresholds.minAttempts) return { status: "insufficient", attempts, failures };

  const pct = Math.round((failures / attempts) * 100);
  const topCodes = Object.entries(byCode)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const over = failures * 100 > thresholds.failPct * attempts;
  return { status: over ? "breach" : "healthy", attempts, failures, pct, topCodes };
}

/** "1 customer" / "3 customers": the count reads as a sentence either way. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The top few codes as "slot_unavailable (35), internal (3)". */
function codeList(codes: CodeCount[]): string {
  return codes
    .slice(0, 3)
    .map((c) => `${c.code} (${c.count})`)
    .join(", ");
}

/**
 * The page. States what it measured (how many, out of how many, over what
 * window) and names the dominant error code, because the code is what tells the
 * reader which system to look at: `slot_unavailable` means the times being
 * offered are not really free, `no_eligible_agents` means a bucket has nobody,
 * `internal` means the booker itself is throwing. Points at where the per-call
 * detail lives rather than pasting any of it (#1133).
 *
 * The guidance sentence is CONDITIONAL on what is actually failing. An alert that
 * always advises checking availability would send the reader to the wrong system
 * every time the booker is the thing throwing, and canned remediation that steers
 * a diagnosis wrong is how a page becomes something people learn to distrust
 * (L36). So it appears only when slot_unavailable is what leads.
 */
/**
 * The one sentence saying what to DO about the code that is failing most, or
 * nothing when the code speaks for itself.
 *
 * A page that names a code and stops leaves the reader to work out the repair
 * mid-incident, and two of these codes have repairs that are not guessable from
 * the name (L111: advice has to name an action that changes the state, and L80: a
 * message naming a specific cause owes the reader somewhere to go).
 *
 * Not every code needs one, and the empty default is deliberate rather than an
 * omission: `no_eligible_agents` and `internal` already page on their own with
 * their own copy, and a generic sentence bolted onto them would say less than the
 * code does. Keyed on the TOP code only, because a page with three sentences of
 * advice for three codes is a page nobody finishes on a phone.
 */
const CODE_GUIDANCE: Record<string, string> = {
  slot_unavailable:
    "slot_unavailable means the times being offered are not really free, so start with the " +
    "availability cache.",
  // #1429. Both of these mean the direct booking integration is locked out, so
  // every lead it handles is refused until someone fixes a secret. The two are
  // named apart because the repair is in different hands.
  API_KEY_REJECTED:
    "API_KEY_REJECTED means the caller is presenting a key Slate does not accept, so every lead " +
    "it handles is refused until the key is fixed. Check whether that caller's key " +
    "(BOOKING_API_KEY_REGAL, _TRYPENNIE, _CANARY, or the shared BOOKING_API_KEY) was rotated " +
    "without the caller being updated. Counted per refused call, so a caller that retries can " +
    "appear more than once.",
  API_NOT_CONFIGURED:
    "API_NOT_CONFIGURED means Slate has no booking API key set, so the endpoint refuses " +
    "everyone. Check the booking API key secrets (BOOKING_API_KEY and the per caller " +
    "BOOKING_API_KEY_REGAL, _TRYPENNIE, _CANARY) on the deployed Worker. Counted per refused " +
    "call, so a caller that retries can appear more than once.",
};

function guidanceFor(code: string | undefined): string {
  const advice = code ? CODE_GUIDANCE[code] : undefined;
  return advice ? ` ${advice}` : "";
}

export function formatFailureRateAlert(input: {
  attempts: number;
  failures: number;
  pct: number;
  windowMinutes: number;
  topCodes: CodeCount[];
}): string {
  const codes = codeList(input.topCodes);
  const naming = codes ? ` Failing with: ${codes}.` : "";
  const guidance = guidanceFor(input.topCodes[0]?.code);
  return (
    `${plural(input.failures, "customer")} could not complete a booking in the last ` +
    `${input.windowMinutes} minutes, out of ${input.attempts} who tried (${input.pct}%).` +
    `${naming}${guidance} The per call breakdown is in the booking outcome panel.`
  );
}

export type FailureRateResult =
  /** The tick could not read what it needs, so it claims nothing in either
   *  direction. Deliberately NOT folded into a zero-failure "healthy". */
  | { status: "unverified"; why: "state" | "tally" }
  | {
      status: "checked";
      armed: boolean;
      verdict: RateVerdict;
      rebased: Rebase;
      /**
       * The window this tick just advanced and persisted (#1442/#1450/#1709).
       *
       * Handed back rather than re-read by the refusal signals beside it: four
       * cron lanes share one invocation's subrequest budget, and a second load of
       * a row this step has already written would spend that budget to learn
       * nothing. It also removes any chance of the two checks judging different
       * windows, which is how two things that must agree drift apart (L53).
       */
      state: RateWindowState;
    };

/**
 * The monitor-lane step: read, advance the window, judge, and decide whether a
 * human hears about it.
 *
 * Three rules this encodes, each of which has shipped wrong somewhere before:
 *
 *  - A read that failed is `unverified`, never an empty window scored as zero
 *    failures. An empty result here is indistinguishable from a healthy one, so
 *    it must fail loud rather than degrade (#277, #1134, #1152).
 *  - The all-clear hangs off a MEASURED healthy verdict. Not off "we did not
 *    page this tick", which is also true of every tick that could not measure.
 *  - While disarmed it measures and logs but stays silent in BOTH directions
 *    (L56): its first live run must not also be its first enforcing run, and an
 *    all-clear for a page nobody received is noise.
 *
 * Fail-soft throughout: a flaky Slack or a failed state write must never fail the
 * tick, because this lane also carries twelve other checks.
 */
export async function runBookingFailureRateCheck(deps: {
  nowMs: number;
  /** The stored window, or null when there is none yet. THROWS on a read error,
   *  which is why "no state" and "could not read the state" stay distinct. */
  loadState: () => Promise<RateWindowState | null>;
  saveState: (state: RateWindowState) => Promise<void>;
  /** Today's cumulative tally, or null when the read failed. */
  readToday: () => Promise<OutcomeReading | null>;
  thresholds: RateThresholds;
  armed: boolean;
  cooldownMs: number;
  notify: ThrottledNotify;
  resolve: AlertResolve;
  /** Structurally the log helper's field shape (primitives only), spelled out
   *  rather than imported so this module keeps no `@/` dependency. */
  log?: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  /**
   * A step that is deliberately fail-soft still has to be VISIBLE. Slack being
   * down, or a state write failing, must not take the monitor tick down with it,
   * but a caught error that reaches no sink is invisible twice (L13). The caller
   * passes the Error object straight through to `log.error`, which is how
   * Cloudflare gets a serialized stack.
   */
  onError?: (context: "saveState" | "notify" | "resolve", err: unknown) => void;
}): Promise<FailureRateResult> {
  let prev: RateWindowState | null;
  try {
    prev = await deps.loadState();
  } catch {
    deps.log?.({ msg: "failure rate unverified", why: "state unreadable" });
    return { status: "unverified", why: "state" };
  }

  const reading = await deps.readToday().catch(() => null);
  if (reading === null) {
    deps.log?.({ msg: "failure rate unverified", why: "tally unreadable" });
    return { status: "unverified", why: "tally" };
  }

  const windowMinutes = Math.round(deps.thresholds.windowMs / 60_000);
  const { state, rebased } = advanceWindow(prev, reading, deps.nowMs, deps.thresholds.windowMs);
  // Persist BEFORE notifying: a hung Slack must not cost us the window.
  await deps.saveState(state).catch((err) => deps.onError?.("saveState", err));
  const verdict = judgeFailureRate(state, deps.nowMs, deps.thresholds);

  deps.log?.({
    msg: "failure rate",
    status: verdict.status,
    armed: deps.armed,
    rebased,
    window_min: windowMinutes,
    attempts: verdict.attempts,
    failures: verdict.failures,
    pct: verdict.status === "insufficient" ? null : verdict.pct,
    top_code: verdict.status === "insufficient" ? null : (verdict.topCodes[0]?.code ?? null),
  });

  if (deps.armed && verdict.status === "breach") {
    await deps
      .notify(
        FAILURE_RATE_ALERT_KEY,
        deps.cooldownMs,
        formatFailureRateAlert({ ...verdict, windowMinutes }),
      )
      .catch((err) => deps.onError?.("notify", err));
  }
  if (deps.armed && verdict.status === "healthy") {
    await deps
      .resolve(FAILURE_RATE_ALERT_KEY, formatFailureRateAllClear({ ...verdict, windowMinutes }))
      .catch((err) => deps.onError?.("resolve", err));
  }
  return { status: "checked", armed: deps.armed, verdict, rebased, state };
}

/** The all-clear. Hung off a MEASURED healthy window, never off a quiet tick, so
 *  it can only ever say something the check actually observed. */
export function formatFailureRateAllClear(input: {
  attempts: number;
  failures: number;
  pct: number;
  windowMinutes: number;
}): string {
  return (
    `Bookings are completing again: ${input.failures} of ${input.attempts} attempts failed ` +
    `in the last ${input.windowMinutes} minutes (${input.pct}%).`
  );
}
