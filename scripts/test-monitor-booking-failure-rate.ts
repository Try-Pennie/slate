// Pure logic for the booking-failure-rate page (#1313): turning a DAILY
// cumulative tally into a rolling short window, and deciding when a wave of
// refused bookings is a page rather than ordinary contention. Run:
//   node --experimental-strip-types scripts/test-monitor-booking-failure-rate.ts
//
// The case this exists for: on 2026-08-06 cal.com refused 50+ confirms in about
// two hours and reported nothing. Inside a DAY's totals that wave is invisible,
// which is why the window, and the day-rollover edge below, are the whole trick.
import {
  advanceWindow,
  runBookingFailureRateCheck,
  windowTotals,
  judgeFailureRate,
  formatFailureRateAlert,
  formatFailureRateAllClear,
  FAILURE_RATE_ALERT_KEY,
  type FailureRateResult,
  type OutcomeReading,
  type RateThresholds,
  type RateWindowState,
} from "../src/lib/monitor/booking-failure-rate.ts";
import { SHIPPED_FAILURE_RATE_THRESHOLDS } from "../src/lib/monitor/failure-rate-thresholds.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes: writing the characters themselves
 *  would trip the repo's own copy lint on this very file. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 11, 14, 0, 0);

const THRESHOLDS: RateThresholds = { windowMs: 60 * MIN, minAttempts: 20, failPct: 20 };

const reading = (
  day: string,
  attempts: number,
  failures: number,
  byCode: Record<string, number> = {},
): OutcomeReading => ({ day, attempts, failures, byCode });

// --- advanceWindow: the first reading establishes a baseline, never a delta ---
{
  // The whole of today's accumulated total is NOT something that happened since
  // the last tick; counting it as one would page on the first tick after a deploy.
  const { state, rebased } = advanceWindow(null, reading("2026-08-11", 400, 40), T0, THRESHOLDS.windowMs);
  eq(rebased, "first", "the first ever reading reports itself as a baseline");
  eq(state.samples.length, 0, "the first reading contributes NO sample (today's total is not a delta)");
  eq(state.attempts, 400, "the first reading is stored as the baseline attempts");
  eq(state.failures, 40, "the first reading is stored as the baseline failures");
  const totals = windowTotals(state, T0, THRESHOLDS.windowMs);
  eq(totals.attempts, 0, "an empty window measures zero attempts, not today's total");
}

// --- advanceWindow: consecutive readings inside one day give deltas ---
{
  const first = advanceWindow(null, reading("2026-08-11", 100, 5), T0, THRESHOLDS.windowMs).state;
  const { state, rebased } = advanceWindow(
    first,
    reading("2026-08-11", 130, 11, { slot_unavailable: 8, internal: 3 }),
    T0 + 5 * MIN,
    THRESHOLDS.windowMs,
  );
  eq(rebased, null, "an ordinary consecutive reading is not a rebase");
  eq(state.samples.length, 1, "a consecutive reading appends one sample");
  eq(state.samples[0].attempts, 30, "the sample holds the ATTEMPTS delta, not the running total");
  eq(state.samples[0].failures, 6, "the sample holds the FAILURES delta");
  eq(state.attempts, 130, "the stored baseline advances to the new reading");
}

// --- advanceWindow: the ET day rollover (the one edge that silently lies) ---
{
  // At midnight ET the daily counter resets, so tomorrow's first reading is
  // SMALLER than today's last. Subtracting gives a large negative number, and
  // clamping it to zero would read as "no failures", which is the healthy answer
  // at exactly the moment we stopped measuring.
  const yesterday = advanceWindow(null, reading("2026-08-11", 900, 30), T0, THRESHOLDS.windowMs).state;
  const midWindow = advanceWindow(
    yesterday,
    reading("2026-08-11", 940, 34),
    T0 + 5 * MIN,
    THRESHOLDS.windowMs,
  ).state;
  const { state, rebased } = advanceWindow(
    midWindow,
    reading("2026-08-12", 3, 0),
    T0 + 10 * MIN,
    THRESHOLDS.windowMs,
  );
  eq(rebased, "rollover", "a new ET day reports itself as a rollover");
  eq(state.day, "2026-08-12", "the rollover adopts the new day");
  eq(state.attempts, 3, "the rollover re-baselines on the new day's totals");
  assert(
    state.samples.every((s) => s.attempts >= 0 && s.failures >= 0),
    "the rollover NEVER records a negative delta",
  );
  eq(state.samples.length, 1, "the rollover skips its own crossing delta (unknowable) but KEEPS the window");
  eq(
    windowTotals(state, T0 + 10 * MIN, THRESHOLDS.windowMs).failures,
    4,
    "measurements from the last hour survive the rollover: the window is time-based, not day-based",
  );
}

// --- advanceWindow: a rollover the DECREASE check cannot catch ---------------
{
  // The rollover branch is not merely a nicer label for a negative delta. If the
  // lane is down overnight and the new day is busier than the old one's total,
  // the new reading is LARGER, so nothing looks wrong: subtracting yesterday's
  // total from today's yields a plausible positive delta that measures nothing
  // real, and it lands in the window as if it happened in the last five minutes.
  const yesterdayEvening: RateWindowState = {
    day: "2026-08-11",
    attempts: 100,
    failures: 4,
    byCode: { internal: 4 },
    samples: [],
  };
  const { state, rebased } = advanceWindow(
    yesterdayEvening,
    reading("2026-08-12", 500, 60, { slot_unavailable: 60 }),
    T0,
    THRESHOLDS.windowMs,
  );
  eq(rebased, "rollover", "a busier new day is a rollover, even though its totals are LARGER");
  eq(state.samples.length, 0, "the rollover records no sample, so 400 stale attempts cannot enter the window");
  eq(
    windowTotals(state, T0, THRESHOLDS.windowMs).failures,
    0,
    "a day's worth of failures never lands in the window as if it were the last five minutes",
  );
}

// --- advanceWindow: a same-day DECREASE is also a rebase, never a zero delta ---
{
  // Should not happen (the tally is monotonic within a day) but a retention prune
  // or a hand correction could do it. Scoring it as zero new failures would be a
  // measurement we did not make.
  const prev: RateWindowState = { day: "2026-08-11", attempts: 500, failures: 50, byCode: {}, samples: [] };
  const { state, rebased } = advanceWindow(prev, reading("2026-08-11", 480, 48), T0, THRESHOLDS.windowMs);
  eq(rebased, "decrease", "a same-day decrease reports itself rather than being silently absorbed");
  eq(state.samples.length, 0, "a decrease contributes no sample");
  eq(state.attempts, 480, "a decrease re-baselines on the smaller reading");
}

// --- windowTotals: samples older than the window are dropped ---
{
  let state = advanceWindow(null, reading("2026-08-11", 0, 0), T0, THRESHOLDS.windowMs).state;
  // 13 ticks, five minutes apart: 65 minutes, so the oldest falls out of a 60-min window.
  for (let i = 1; i <= 13; i++) {
    state = advanceWindow(
      state,
      reading("2026-08-11", i * 10, i * 1),
      T0 + i * 5 * MIN,
      THRESHOLDS.windowMs,
    ).state;
  }
  const at = T0 + 13 * 5 * MIN;
  eq(state.samples.length, 12, "samples older than the window are pruned as they age out");
  eq(windowTotals(state, at, THRESHOLDS.windowMs).attempts, 120, "the window totals only the last hour");
}

// --- judgeFailureRate: a small sample can never page, and can never all-clear ---
{
  const state: RateWindowState = {
    day: "2026-08-11",
    attempts: 3,
    failures: 3,
    byCode: {},
    samples: [{ atMs: T0, attempts: 1, failures: 1, byCode: { slot_unavailable: 1 } }],
  };
  const verdict = judgeFailureRate(state, T0, THRESHOLDS);
  eq(verdict.status, "insufficient", "1 of 1 attempts failing in a quiet hour does not page");
  assert(
    verdict.status !== "healthy",
    "a sample too small to judge is NOT healthy: it must not send an all-clear either (L98)",
  );
}

// --- judgeFailureRate: a measured healthy window ---
{
  const state: RateWindowState = {
    day: "2026-08-11",
    attempts: 0,
    failures: 0,
    byCode: {},
    samples: [{ atMs: T0, attempts: 100, failures: 5, byCode: { slot_unavailable: 5 } }],
  };
  const verdict = judgeFailureRate(state, T0, THRESHOLDS);
  eq(verdict.status, "healthy", "100 attempts at a 5% failure share is measured healthy");
  if (verdict.status === "healthy") eq(verdict.pct, 5, "the healthy verdict reports the measured share");
}

// --- judgeFailureRate: the cal.com shape pages, and names what is failing ---
{
  const state: RateWindowState = {
    day: "2026-08-11",
    attempts: 0,
    failures: 0,
    byCode: {},
    samples: [
      { atMs: T0, attempts: 40, failures: 18, byCode: { slot_unavailable: 16, internal: 2 } },
      { atMs: T0 + 5 * MIN, attempts: 42, failures: 20, byCode: { slot_unavailable: 19, internal: 1 } },
    ],
  };
  const verdict = judgeFailureRate(state, T0 + 5 * MIN, THRESHOLDS);
  eq(verdict.status, "breach", "38 failures in 82 attempts crosses the threshold");
  if (verdict.status === "breach") {
    eq(verdict.failures, 38, "the breach reports the measured failure count");
    eq(verdict.attempts, 82, "the breach reports the measured attempt count");
    eq(verdict.topCodes[0].code, "slot_unavailable", "the dominant error code leads, so the page is actionable");
    eq(verdict.topCodes[0].count, 35, "the dominant code's count is summed across the window");
  }
}

// --- judgeFailureRate: exactly at the threshold is healthy, not a breach ---
{
  const state: RateWindowState = {
    day: "2026-08-11",
    attempts: 0,
    failures: 0,
    byCode: {},
    samples: [{ atMs: T0, attempts: 100, failures: 20, byCode: { internal: 20 } }],
  };
  eq(
    judgeFailureRate(state, T0, THRESHOLDS).status,
    "healthy",
    "a share exactly AT the threshold is healthy (the page is for crossing it)",
  );
}

// --- copy ---
{
  const msg = formatFailureRateAlert({
    attempts: 82,
    failures: 38,
    pct: 46,
    windowMinutes: 60,
    topCodes: [
      { code: "slot_unavailable", count: 35 },
      { code: "internal", count: 3 },
    ],
  });
  assert(msg.includes("38"), "the page states how many customers were turned away");
  assert(msg.includes("82"), "the page states how many tried");
  assert(msg.includes("slot_unavailable"), "the page names the dominant failure so it is actionable");
  assert(!DASHES.test(msg), "the page uses no em/en dashes (copy rule)");
  assert(!/^Slate\b/.test(msg), "the page does not open with the word Slate (it arrives under Slate's own name)");

  const one = formatFailureRateAlert({
    attempts: 21,
    failures: 1,
    pct: 5,
    windowMinutes: 60,
    topCodes: [{ code: "internal", count: 1 }],
  });
  assert(/\b1 customer\b/.test(one), "a single failure reads as '1 customer', not '1 customers'");
  assert(/\b38 customers\b/.test(msg), "several failures read as 'customers'");

  // L36: never embed canned remediation that can steer a diagnosis wrong. The
  // slot_unavailable guidance ("the times being offered are not really free") is
  // the right first move when THAT is what is failing, and actively misleading
  // when the booker is throwing 500s instead.
  assert(
    msg.includes("not really free"),
    "a slot_unavailable wave says what it means, so the reader knows to check availability",
  );
  const internalWave = formatFailureRateAlert({
    attempts: 60,
    failures: 30,
    pct: 50,
    windowMinutes: 60,
    topCodes: [
      { code: "internal", count: 28 },
      { code: "slot_unavailable", count: 2 },
    ],
  });
  assert(
    !internalWave.includes("not really free"),
    "an internal-error wave does NOT carry the availability advice: it would point the reader at the wrong system",
  );
  assert(
    internalWave.includes("internal"),
    "an internal-error wave still names what is failing",
  );

  // #1429: the two credential codes reach this window now, and neither repair is
  // guessable from the code alone. A page that names API_KEY_REJECTED and stops
  // leaves the reader working out mid-incident which secret to look at (L80/L111),
  // so each names the ACTION that changes the state, and they name different ones:
  // one is a key to fix at the caller, the other a secret missing on the Worker.
  const rotated = formatFailureRateAlert({
    attempts: 31,
    failures: 29,
    pct: 94,
    windowMinutes: 60,
    topCodes: [{ code: "API_KEY_REJECTED", count: 29 }],
  });
  assert(
    rotated.includes("BOOKING_API_KEY was rotated"),
    "a rejected-key wave says to check whether the key was rotated without the caller being updated",
  );
  assert(
    rotated.includes("Counted per refused call"),
    "and says the count is refused CALLS, so a retrying bot is not read as that many distinct leads",
  );
  assert(!DASHES.test(rotated), "the rejected-key page uses no em/en dashes");

  const unset = formatFailureRateAlert({
    attempts: 18,
    failures: 18,
    pct: 100,
    windowMinutes: 60,
    topCodes: [{ code: "API_NOT_CONFIGURED", count: 18 }],
  });
  assert(
    unset.includes("BOOKING_API_KEY secret on the deployed Worker"),
    "an unconfigured endpoint points at the secret on the Worker, which is where that repair is",
  );
  assert(
    !unset.includes("rotated"),
    "and does NOT repeat the rotation advice, which cannot fix a secret nobody set (L36)",
  );
  assert(
    !internalWave.includes("BOOKING_API_KEY"),
    "an internal-error wave carries no credential advice, so the reader is not sent at the wrong system",
  );
  // The default really is empty rather than a stray sentence, so a code with no
  // written advice reads as the bare naming it always did.
  const noAdvice = formatFailureRateAlert({
    attempts: 40,
    failures: 12,
    pct: 30,
    windowMinutes: 60,
    topCodes: [{ code: "no_eligible_agents", count: 12 }],
  });
  assert(
    noAdvice.includes("no_eligible_agents") && !noAdvice.includes("Check "),
    "a code with no written guidance names itself and adds no invented advice",
  );

  const clear = formatFailureRateAllClear({ attempts: 90, failures: 2, pct: 2, windowMinutes: 60 });
  assert(clear.includes("2%"), "the all-clear states the measured share it cleared on");
  assert(!DASHES.test(clear), "the all-clear uses no em/en dashes");
}

// --- the alert key is one constant shared by the page and its all-clear ---
{
  assert(FAILURE_RATE_ALERT_KEY.length > 0, "the feature owns its alert_state key as one constant");
}

// --- runBookingFailureRateCheck: the paging DECISION ------------------------
//
// The gates that decide whether a human is woken, and the failure path that is
// the whole point: a tick that could not READ its signal has measured nothing,
// so it must neither page nor all-clear. A recovery notice off an unread signal
// is this repo's most repeated defect (#1134, #1152).

/** A window already holding a breach: 82 attempts, 38 of them refused. */
const BREACHING: RateWindowState = {
  day: "2026-08-11",
  attempts: 1000,
  failures: 100,
  byCode: { slot_unavailable: 90, internal: 10 },
  samples: [
    { atMs: T0 - 5 * MIN, attempts: 40, failures: 18, byCode: { slot_unavailable: 18 } },
    { atMs: T0, attempts: 42, failures: 20, byCode: { slot_unavailable: 20 } },
  ],
};

/** A window already holding a measured healthy hour: 100 attempts, 2 refused. */
const HEALTHY: RateWindowState = {
  day: "2026-08-11",
  attempts: 1000,
  failures: 100,
  byCode: {},
  samples: [{ atMs: T0, attempts: 100, failures: 2, byCode: { internal: 2 } }],
};

interface Harness {
  run: () => Promise<FailureRateResult>;
  notified: { key: string; text: string }[];
  resolved: string[];
  saved: RateWindowState[];
  errors: { context: string; err: unknown }[];
}

function harness(overrides: {
  state?: RateWindowState | null;
  loadThrows?: boolean;
  reading?: OutcomeReading | null;
  readThrows?: boolean;
  armed?: boolean;
  notifyThrows?: boolean;
  saveThrows?: boolean;
}): Harness {
  const notified: { key: string; text: string }[] = [];
  const resolved: string[] = [];
  const saved: RateWindowState[] = [];
  const errors: { context: string; err: unknown }[] = [];
  return {
    notified,
    resolved,
    saved,
    errors,
    run: () =>
      runBookingFailureRateCheck({
        nowMs: T0 + MIN,
        loadState: async () => {
          if (overrides.loadThrows) throw new Error("state row unreadable");
          return overrides.state ?? null;
        },
        readToday: async () => {
          if (overrides.readThrows) throw new Error("mix RPC failed");
          return overrides.reading === undefined
            ? reading("2026-08-11", 1000, 100, { slot_unavailable: 90, internal: 10 })
            : overrides.reading;
        },
        saveState: async (s) => {
          if (overrides.saveThrows) throw new Error("state write failed");
          saved.push(s);
        },
        thresholds: THRESHOLDS,
        armed: overrides.armed ?? true,
        cooldownMs: 30 * MIN,
        notify: async (key, _cooldownMs, text) => {
          if (overrides.notifyThrows) throw new Error("slack down");
          notified.push({ key, text });
        },
        resolve: async (key) => {
          resolved.push(key);
          return true;
        },
        onError: (context, err) => {
          errors.push({ context, err });
        },
      }),
  };
}

// The failure path: an unreadable signal claims nothing.
{
  const h = harness({ state: BREACHING, reading: null });
  const out = await h.run();
  eq(out.status, "unverified", "a tally that could not be read is unverified, never zero failures");
  eq(h.notified.length, 0, "an unverified tick does not page");
  eq(h.resolved.length, 0, "an unverified tick does NOT all-clear (it measured nothing)");
  eq(h.saved.length, 0, "an unverified tick does not advance the stored window");
}
{
  const h = harness({ state: HEALTHY, readThrows: true });
  const out = await h.run();
  eq(out.status, "unverified", "a THROWING tally read is unverified, and the tick survives it");
  eq(h.resolved.length, 0, "a throwing read never sends an all-clear off a healthy-looking empty window");
}
{
  const h = harness({ loadThrows: true });
  const out = await h.run();
  eq(out.status, "unverified", "an unreadable state row is unverified rather than a silent window reset");
  eq(h.notified.length, 0, "an unreadable state row does not page");
  eq(h.resolved.length, 0, "an unreadable state row does not all-clear");
}

// The paging gates.
{
  const h = harness({ state: BREACHING, armed: true });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "breach", "a breaching window is judged a breach");
  eq(h.notified.length, 1, "an armed breach pages");
  eq(h.notified[0].key, FAILURE_RATE_ALERT_KEY, "the page uses the feature's one alert key");
  assert(h.notified[0].text.includes("38"), "the page carries the measured failure count");
  eq(h.resolved.length, 0, "a breach does not also all-clear");
  eq(h.saved.length, 1, "a checked tick advances the stored window");
}
{
  const h = harness({ state: BREACHING, armed: false });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "breach", "a disarmed check still MEASURES the breach");
  eq(h.notified.length, 0, "a disarmed breach observes only: it does not page (L56)");
  eq(h.resolved.length, 0, "a disarmed breach does not all-clear either");
}
{
  const h = harness({ state: HEALTHY, armed: true });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "healthy", "a measured healthy window is healthy");
  eq(h.resolved.length, 1, "an armed healthy window sends the all-clear, hung off the MEASURED result");
  eq(h.resolved[0], FAILURE_RATE_ALERT_KEY, "the all-clear clears the same key the page set");
  eq(h.notified.length, 0, "a healthy window does not page");
}
{
  const h = harness({ state: HEALTHY, armed: false });
  const out = await h.run();
  eq(h.resolved.length, 0, "a disarmed healthy window sends no all-clear (nothing was ever sent to clear)");
  assert(out.status === "checked", "a disarmed tick still reports what it measured");
}
{
  // A quiet hour: too few attempts to judge. Neither direction may fire.
  const quiet: RateWindowState = {
    day: "2026-08-11",
    attempts: 1000,
    failures: 100,
    byCode: {},
    samples: [{ atMs: T0, attempts: 1, failures: 1, byCode: { internal: 1 } }],
  };
  const h = harness({ state: quiet, armed: true });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "insufficient", "a tiny sample is insufficient");
  eq(h.notified.length, 0, "1 of 1 failing does not page");
  eq(h.resolved.length, 0, "a sample too small to judge does NOT all-clear (L98)");
}
{
  const h = harness({ state: BREACHING, armed: true, notifyThrows: true });
  const out = await h.run();
  eq(out.status, "checked", "a Slack failure does not fail the monitor tick");
  eq(h.saved.length, 1, "a Slack failure still advances the window");
  eq(h.errors.length, 1, "a Slack failure is REPORTED, not swallowed into silence");
  eq(h.errors[0].context, "notify", "the report names which step failed");
}
{
  // Fail-soft, but not invisible: a window that could not be persisted means the
  // next tick re-baselines and loses an interval, which is worth a log line.
  const h = harness({ state: BREACHING, armed: true, saveThrows: true });
  const out = await h.run();
  eq(out.status, "checked", "a failed state write does not fail the tick");
  eq(h.errors.length, 1, "a failed state write is reported");
  eq(h.errors[0].context, "saveState", "the report names the failed write");
}

// --- The SHIPPED thresholds must be clearable by the traffic they will judge ---
//
// #2484. The floor shipped at 20 attempts in a rolling hour, chosen with no real
// traffic to fit it to: every booking Slate had taken was the canary's. Measured
// against cal.com's routing form responses on 2026-09-16, over 27,122 real leads
// in 14 days:
//
//   the whole Low tier   median 29 an hour, p25 17
//   the biggest ONE page median 18 an hour, p25 10, and only 44 percent of its
//                        active hours reach 20
//
// The pilot flips ONE page, so the tier's own volume overstates what reaches Slate
// that morning. Armed at 20 in an hour the check would report `insufficient` on
// most ticks of flip day, which renders identically to healthy and is the state
// #1394 exists to notice.
//
// This asserts the SHIPPED constant rather than a copy of it, so a later edit that
// walks the floor back up has to come past this (L63, L107).
{
  assert(
    SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs === 4 * 60 * 60_000,
    "the window is four hours, so the denominator is about 72 Low attempts on the pilot page",
  );
  assert(
    SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts === 10,
    "and the floor is 10, which the rolling window reaches about 35 minutes after the flip",
  );

  // The measured pilot rate, and the two quieter pages, must all reach the floor
  // inside the window. Written as the measurement rather than as the numbers it
  // produced, so re-running `pnpm measure:lead-hours` can be compared against it.
  const MEASURED_LOW_PER_HOUR = { biggestPage: 18, middlePage: 7, smallestPage: 5 };
  const windowHours = SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs / 3_600_000;
  for (const [page, perHour] of Object.entries(MEASURED_LOW_PER_HOUR)) {
    assert(
      perHour * windowHours >= SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts,
      `${page} reaches the attempt floor inside one window at its measured median (${perHour} an hour)`,
    );
  }

  // And the floor is not so low that a single failure carries the share over the
  // line: at 10 attempts and 20 percent, it takes three. A floor where one failure
  // pages is a check that reports ordinary contention as an outage (L139).
  const onePct = (1 / SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts) * 100;
  assert(
    onePct <= SHIPPED_FAILURE_RATE_THRESHOLDS.failPct,
    "one failed booking at the floor does not by itself exceed the share",
  );
}

finish();
