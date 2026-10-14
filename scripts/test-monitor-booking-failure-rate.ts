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
  formatFailureBurstEnded,
  countRefusedPeople,
  readRecent,
  failureSpan,
  FAILURE_RATE_ALERT_KEY,
  FAILURE_BURST_ENDED_ALERT_KEY,
  type FailureRateResult,
  type OutcomeReading,
  type RateSample,
  type RateThresholds,
  type RateWindowState,
  type RecentThresholds,
  type RefusedPeople,
} from "../src/lib/monitor/booking-failure-rate.ts";
import {
  FAILURE_RATE_FIT,
  MEASURED_ATTEMPT_TRAFFIC,
  SHIPPED_FAILURE_RATE_RECENT,
  SHIPPED_FAILURE_RATE_THRESHOLDS,
} from "../src/lib/monitor/failure-rate-thresholds.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes: writing the characters themselves
 *  would trip the repo's own copy lint on this very file. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 11, 14, 0, 0);

const THRESHOLDS: RateThresholds = { windowMs: 60 * MIN, minAttempts: 20, failPct: 20 };
const RECENT: RecentThresholds = { windowMs: 30 * MIN, minAttempts: 5, recoverPct: 5 };

/** The recent half every live page now carries (#3275): what the last 30 minutes
 *  held, and when the window's failures were recorded. Spread into the copy tests
 *  below, which are about the opening and the codes rather than about these. */
const LIVE = {
  recentMinutes: 30,
  recent: { attempts: 6, failures: 3 },
  span: { firstMs: T0 - 50 * MIN, newestMs: T0 },
};

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
  const msg = formatFailureRateAlert({ ...LIVE,
    attempts: 82,
    failures: 38,
    pct: 46,
    windowMinutes: 60,
    topCodes: [
      { code: "slot_unavailable", count: 35 },
      { code: "internal", count: 3 },
    ],
  });
  assert(msg.includes("38"), "the page states how many attempts failed");
  assert(msg.includes("82"), "the page states how many attempts there were");
  assert(msg.includes("slot_unavailable"), "the page names the dominant failure so it is actionable");
  assert(!DASHES.test(msg), "the page uses no em/en dashes (copy rule)");
  assert(!/^Slate\b/.test(msg), "the page does not open with the word Slate (it arrives under Slate's own name)");

  const one = formatFailureRateAlert({ ...LIVE,
    attempts: 21,
    failures: 1,
    pct: 5,
    windowMinutes: 60,
    topCodes: [{ code: "internal", count: 1 }],
  });
  // #3633: the window counts attempts, not people, and one lead retrying five times
  // is five attempts. The page says attempts so it cannot read as five customers.
  assert(!/customer/i.test(msg), "the page never calls an attempt a customer");
  assert(!/customer/i.test(one), "the single case never calls an attempt a customer either");
  assert(/\b38 of 82 booking attempts failed\b/.test(msg), "it reads as attempts failed out of attempts");
  assert(/\b1 of 21 booking attempts failed\b/.test(one), "and reads the same way for a single failure");

  // #3633: with the refused people counted, the page LEADS with people, and the
  // refusal count beside them comes from the same read, so the two always agree.
  const base = {
    attempts: 82,
    failures: 38,
    pct: 46,
    windowMinutes: 180,
    topCodes: [{ code: "slot_unavailable", count: 35 }],
  };
  const people = formatFailureRateAlert({ ...LIVE, ...base, refused: { people: 4, refusals: 35, withoutLead: 0 } });
  assert(
    people.startsWith(
      "4 people were refused a time in the last 180 minutes (35 refusals); 38 of 82 attempts failed overall (46%).",
    ),
    `it leads with people, then attempts overall (got: ${people})`,
  );
  assert(people.includes("slot_unavailable (35)"), "and still names the failing code");
  assert(!DASHES.test(people), "no dashes in the people form either");

  const single = formatFailureRateAlert({ ...LIVE, ...base, refused: { people: 1, refusals: 1, withoutLead: 0 } });
  assert(
    single.startsWith("1 person was refused a time in the last 180 minutes (1 refusal);"),
    `one person and one refusal read in the singular (got: ${single})`,
  );
  const oneRetrying = formatFailureRateAlert({ ...LIVE, ...base, refused: { people: 1, refusals: 5, withoutLead: 0 } });
  assert(
    oneRetrying.startsWith("1 person was refused a time in the last 180 minutes (5 refusals);"),
    "one lead retrying five times reads as one person, five refusals",
  );

  // A refusal with no lead id cannot be told apart from anybody, so the count is a
  // floor and says so (L11: claim only what was measured).
  const floor = formatFailureRateAlert({ ...LIVE, ...base, refused: { people: 3, refusals: 6, withoutLead: 2 } });
  assert(floor.startsWith("At least 3 people were refused a time"), `an unidentified refusal makes it a floor (got: ${floor})`);

  // No people form when nothing was refused (the failures were internal errors and
  // the like, which carry nobody) or when the people read failed.
  const noneRefused = formatFailureRateAlert({ ...LIVE, ...base, refused: { people: 0, refusals: 0, withoutLead: 0 } });
  assert(noneRefused.startsWith("38 of 82 booking attempts failed"), "zero refusals falls back to attempts");
  const unread = formatFailureRateAlert({ ...LIVE, ...base, refused: null });
  assert(unread.startsWith("38 of 82 booking attempts failed"), "an unread people count falls back to attempts");
  // Refusals happened but not one carried a lead id: there is nobody to count, and
  // "At least 0 people" would be a claim about people the page cannot make.
  const nobodyKnown = formatFailureRateAlert({ ...LIVE, ...base, refused: { people: 0, refusals: 4, withoutLead: 4 } });
  assert(
    nobodyKnown.startsWith("38 of 82 booking attempts failed"),
    `refusals with no lead id at all fall back to attempts (got: ${nobodyKnown})`,
  );
  assert(!/\b0 people\b/.test(nobodyKnown), "and never say 0 people");

  // countRefusedPeople: distinct leads among the window's refusals (#3633).
  const counted: RefusedPeople = countRefusedPeople([
    { lead_id: "00QUi000011BI7B", is_test: false },
    { lead_id: "00QUi000011BI7B", is_test: false },
    { lead_id: "00QUi000011BI7B", is_test: false },
    { lead_id: "00QUl00000OipHQ", is_test: false },
    { lead_id: "00QUl00000OipHQ", is_test: false },
  ]);
  eq(counted, { people: 2, refusals: 5, withoutLead: 0 }, "the 2026-10-12 shape: two leads, five refusals");

  eq(
    countRefusedPeople([
      { lead_id: "SMOKE0000000001", is_test: true },
      { lead_id: "00QUi000011BI7B", is_test: false },
    ]),
    { people: 1, refusals: 1, withoutLead: 0 },
    "a test bucket's refusal is left out, as the tally leaves it out",
  );
  eq(
    countRefusedPeople([{ lead_id: "00QUi000011BI7B", is_test: null }]),
    { people: 1, refusals: 1, withoutLead: 0 },
    "a bucket that could not be read counts as real, the direction the tally takes",
  );
  eq(
    countRefusedPeople([{ lead_id: null, is_test: false }, { lead_id: "", is_test: false }]),
    { people: 0, refusals: 2, withoutLead: 2 },
    "a refusal with no lead id is a refusal, never a person",
  );
  eq(countRefusedPeople([]), { people: 0, refusals: 0, withoutLead: 0 }, "nothing refused is nothing");

  // L36: never embed canned remediation that can steer a diagnosis wrong. The
  // slot_unavailable guidance ("the times being offered are not really free") is
  // the right first move when THAT is what is failing, and actively misleading
  // when the booker is throwing 500s instead.
  assert(
    msg.includes("not really free"),
    "a slot_unavailable wave says what it means, so the reader knows to check availability",
  );
  const internalWave = formatFailureRateAlert({ ...LIVE,
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
  const rotated = formatFailureRateAlert({ ...LIVE,
    attempts: 31,
    failures: 29,
    pct: 94,
    windowMinutes: 60,
    topCodes: [{ code: "API_KEY_REJECTED", count: 29 }],
  });
  assert(
    rotated.includes("_TRYPENNIE, _CANARY or _MARCIA) was rotated") && rotated.includes("BOOKING_API_KEY_REGAL") && !rotated.includes("shared"),
    "a rejected-key wave says to check whether the key was rotated without the caller being updated",
  );
  assert(
    rotated.includes("Counted per refused call"),
    "and says the count is refused CALLS, so a retrying bot is not read as that many distinct leads",
  );
  assert(!DASHES.test(rotated), "the rejected-key page uses no em/en dashes");

  const unset = formatFailureRateAlert({ ...LIVE,
    attempts: 18,
    failures: 18,
    pct: 100,
    windowMinutes: 60,
    topCodes: [{ code: "API_NOT_CONFIGURED", count: 18 }],
  });
  assert(
    unset.includes("BOOKING_API_KEY_REGAL, _TRYPENNIE, _CANARY, _MARCIA) on the deployed Worker"),
    "an unconfigured endpoint points at the secret on the Worker, which is where that repair is",
  );
  assert(
    !unset.includes("rotated"),
    "and does NOT repeat the rotation advice, which cannot fix a secret nobody set (L36)",
  );
  // #2865: the bare shared pair is read by nothing, so naming it would send the
  // reader to set a secret that cannot bring the endpoint back.
  assert(
    !/BOOKING_API_KEY\b(?!_)/.test(unset) && !/BOOKING_API_KEY\b(?!_)/.test(rotated),
    "neither credential page names the retired shared BOOKING_API_KEY",
  );
  assert(
    !internalWave.includes("BOOKING_API_KEY"),
    "an internal-error wave carries no credential advice, so the reader is not sent at the wrong system",
  );
  // The default really is empty rather than a stray sentence, so a code with no
  // written advice reads as the bare naming it always did.
  const noAdvice = formatFailureRateAlert({ ...LIVE,
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

  // #3275: the all-clear speaks ONLY about the recent attempts it stood down on.
  // "Completing again" beside the window's 18% read as a contradiction (Dan,
  // 2026-10-14), and the window's share was never what ended it.
  const clear = formatFailureRateAllClear({ recentMinutes: 30, recent: { attempts: 9, failures: 0 }, newestFailureMs: T0 });
  eq(
    clear,
    "Bookings are completing again: all 9 attempts in the last 30 minutes completed, and nothing has failed since 10:00am ET.",
    "the all-clear states the clean run it stood down on and when the last failure was, in ET",
  );
  assert(!clear.includes("%"), "the all-clear quotes no window share");
  assert(!DASHES.test(clear), "the all-clear uses no em/en dashes");
  eq(
    formatFailureRateAllClear({ recentMinutes: 30, recent: { attempts: 24, failures: 1 }, newestFailureMs: T0 }),
    "Bookings are completing again: 23 of 24 attempts in the last 30 minutes completed.",
    "a clean run holding one ordinary failure says so rather than claiming all completed",
  );
  eq(
    formatFailureRateAllClear({ recentMinutes: 30, recent: { attempts: 9, failures: 0 }, newestFailureMs: null }),
    "Bookings are completing again: all 9 attempts in the last 30 minutes completed.",
    "with no failure left in the window it names no time",
  );
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
  /** The `sinceMs` of every refused-people read the check made. */
  peopleReads: number[];
}

function harness(overrides: {
  /** What `resolve` answers: whether a page was open for it to settle. */
  resolveAnswers?: boolean;
  state?: RateWindowState | null;
  loadThrows?: boolean;
  reading?: OutcomeReading | null;
  readThrows?: boolean;
  armed?: boolean;
  notifyThrows?: boolean;
  saveThrows?: boolean;
  /** What the refused-people read answers, or "throws". Defaults to nobody refused. */
  refused?: RefusedPeople | "throws";
}): Harness {
  const notified: { key: string; text: string }[] = [];
  const resolved: string[] = [];
  const saved: RateWindowState[] = [];
  const errors: { context: string; err: unknown }[] = [];
  const peopleReads: number[] = [];
  return {
    notified,
    resolved,
    saved,
    errors,
    peopleReads,
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
        readRefusedPeople: async (sinceMs) => {
          peopleReads.push(sinceMs);
          if (overrides.refused === "throws") throw new Error("routing_decisions read failed");
          return overrides.refused ?? { people: 0, refusals: 0, withoutLead: 0 };
        },
        thresholds: THRESHOLDS,
        recent: RECENT,
        armed: overrides.armed ?? true,
        cooldownMs: 30 * MIN,
        notify: async (key, _cooldownMs, text) => {
          if (overrides.notifyThrows) throw new Error("slack down");
          notified.push({ key, text });
        },
        resolve: async (key) => {
          resolved.push(key);
          return overrides.resolveAnswers ?? true;
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

// --- The SHIPPED thresholds are derived from measured traffic ---
//
// #2484 fitted them by hand to one landing page (10 attempts in four hours). #2494
// derives them from the committed cal.com measurement at Slate's share of the split;
// scripts/test-failure-rate-fit.ts holds the derivation and the measurement to the
// fixtures. What stays here is the property the route depends on, asserted on the
// SHIPPED constant rather than a copy (L63): the floor is reachable by the traffic it
// judges, and one failure cannot carry the share at the floor (L139).
{
  const hours = SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs / 3_600_000;
  assert(Number.isInteger(hours) && hours >= 1 && hours <= 4, `the window is a whole number of hours, at most four (got ${hours})`);
  const reach = MEASURED_ATTEMPT_TRAFFIC.windowReach[String(hours)] ?? 0;
  assert(
    Math.floor(reach * MEASURED_ATTEMPT_TRAFFIC.slateShare) >= SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts,
    "Slate's share of the measured traffic reaches the attempt floor inside the shipped window",
  );
  // Driven through the real judge: at the floor, one failure fewer than the fit
  // demands is healthy, and that many is a breach (L63: the guarded quantity).
  const n = SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts;
  const k = FAILURE_RATE_FIT.failuresToBreachAtFloor;
  const at = (failures: number) =>
    judgeFailureRate(
      { day: "2026-10-01", attempts: 0, failures: 0, byCode: {}, samples: [{ atMs: 1_000, attempts: n, failures, byCode: {} }] },
      1_000,
      SHIPPED_FAILURE_RATE_THRESHOLDS,
    ).status;
  eq(at(k - 1), "healthy", `${k - 1} failures out of the floor of ${n} do not page`);
  eq(at(k), "breach", `${k} failures out of the floor of ${n} do`);
}

// #3633: the refused-people read. It happens only on an armed breach tick, because
// four cron lanes share one invocation's subrequest budget and a read on every
// healthy five minute tick would spend it to say nothing.
{
  const h = harness({ state: BREACHING, refused: { people: 2, refusals: 10, withoutLead: 0 } });
  await h.run();
  eq(h.peopleReads, [T0 + MIN - THRESHOLDS.windowMs], "an armed breach reads people over exactly the page's window");
  eq(h.notified.length, 1, "and pages");
  assert(
    h.notified[0].text.startsWith("2 people were refused a time in the last 60 minutes (10 refusals);"),
    `and the page leads with them (got: ${h.notified[0]?.text})`,
  );
}
{
  const h = harness({ state: HEALTHY });
  await h.run();
  eq(h.peopleReads.length, 0, "a healthy window reads no people");
}
{
  const h = harness({ state: BREACHING, armed: false });
  await h.run();
  eq(h.peopleReads.length, 0, "a disarmed breach sends nothing, so it reads no people");
}
{
  // The people count is a refinement of the page, never a condition of it.
  const h = harness({ state: BREACHING, refused: "throws" });
  const out = await h.run();
  eq(out.status, "checked", "a failed people read does not fail the tick");
  eq(h.notified.length, 1, "the page still goes out");
  assert(
    /^\d+ of \d+ booking attempts failed/.test(h.notified[0].text),
    `in the attempts form (got: ${h.notified[0]?.text})`,
  );
  eq(h.errors.map((e) => e.context), ["refusedPeople"], "and the failed read is reported, not swallowed");
}

// --- #3275: the recent window, and what it lets the page say ----------------------
//
// The verdict is a share over a fixed 180 minute window, so it used to re-page and
// all-clear around the threshold as OLD failures and successes aged out. On
// 2026-10-14 it paged at 6:00am ET on 8 of 38 (21%) when the last failure had been
// at 5:01am, then said "Bookings are completing again" at 6:05am on 7 of 39 (18%)
// because a 3:02am failure aged out. Nothing had recovered. These pin the fix: the
// page says when the failures were, a burst that already ended reads as one, and
// the all-clear stands on a measured run of recent attempts, never on the share.

const sample = (atMs: number, attempts: number, failures: number): RateSample => ({
  atMs,
  attempts,
  failures,
  byCode: failures > 0 ? { slot_unavailable: failures } : {},
});
const windowOf = (samples: RateSample[]): RateWindowState => ({
  day: "2026-08-11",
  attempts: 1000,
  failures: 100,
  // The harness's reading carries these codes, so a baseline matching it keeps the
  // tick's own sample free of a spurious code delta.
  byCode: { slot_unavailable: 90, internal: 10 },
  samples,
});

// readRecent: what the last 30 minutes measured, and whether it is a clean run.
{
  const w = windowOf([sample(T0 - 40 * MIN, 10, 8), sample(T0 - 25 * MIN, 3, 0), sample(T0, 4, 0)]);
  const r = readRecent(w, T0, RECENT);
  eq([r.attempts, r.failures], [7, 0], "only the samples inside the recent window count");
  eq(r.completing, true, "seven attempts, none failed, is a measured clean run");
  const edge = readRecent(windowOf([sample(T0 - 30 * MIN, 9, 0)]), T0, RECENT);
  eq(edge.attempts, 0, "a sample exactly 30 minutes old is outside, by the same rule the window ages by");
}
{
  const thin = readRecent(windowOf([sample(T0, 4, 0)]), T0, RECENT);
  eq(thin.completing, false, "four clean attempts are below the floor of five, so they prove nothing (L98)");
  const none = readRecent(windowOf([sample(T0 - 45 * MIN, 30, 10)]), T0, RECENT);
  eq([none.attempts, none.completing], [0, false], "no recent attempts at all is not a recovery");
}
{
  // "All or nearly all": at most a quarter of the paging share may fail.
  eq(readRecent(windowOf([sample(T0, 20, 1)]), T0, RECENT).completing, true, "1 of 20 failing (5%) still counts as completing");
  eq(readRecent(windowOf([sample(T0, 19, 1)]), T0, RECENT).completing, false, "1 of 19 (5.3%) does not");
  eq(readRecent(windowOf([sample(T0, 9, 1)]), T0, RECENT).completing, false, "and one failure in a small run is not a clean run");
}

// failureSpan: when the window's failures were recorded.
{
  const w = windowOf([
    sample(T0 - 70 * MIN, 5, 2),
    sample(T0 - 55 * MIN, 5, 1),
    sample(T0 - 20 * MIN, 5, 0),
    sample(T0 - 15 * MIN, 5, 3),
    sample(T0, 5, 0),
  ]);
  eq(failureSpan(w, T0, THRESHOLDS.windowMs), { firstMs: T0 - 55 * MIN, newestMs: T0 - 15 * MIN }, "the first and newest failing samples inside the window");
  eq(failureSpan(windowOf([sample(T0, 5, 0)]), T0, THRESHOLDS.windowMs), null, "a window with no failure has no span");
}

// The copy: a live page says it is still happening and when; a burst that ended says so.
{
  const live = formatFailureRateAlert({
    attempts: 38,
    failures: 8,
    pct: 21,
    windowMinutes: 180,
    topCodes: [{ code: "slot_unavailable", count: 8 }],
    recentMinutes: 30,
    recent: { attempts: 6, failures: 3 },
    span: { firstMs: T0 - 175 * MIN, newestMs: T0 },
  });
  assert(
    live.startsWith(
      "8 of 38 booking attempts failed in the last 180 minutes (21%). Still failing: 3 of 6 attempts in the last 30 minutes failed. " +
        "The failures in that window were recorded between 7:05am and 10:00am ET.",
    ),
    `a live page says it is still failing, how much, and when, in ET (got: ${live})`,
  );
  assert(!DASHES.test(live), "the live page uses no em/en dashes");
  const lone = formatFailureRateAlert({ ...LIVE, attempts: 20, failures: 5, pct: 25, windowMinutes: 180, topCodes: [], recent: { attempts: 1, failures: 1 }, span: { firstMs: T0, newestMs: T0 } });
  assert(
    lone.includes("Still failing: the only attempt in the last 30 minutes failed. The failures in that window were all recorded at 10:00am ET."),
    `one attempt and one recording time read in the singular (got: ${lone})`,
  );
}
{
  const base = {
    attempts: 38,
    failures: 8,
    pct: 21,
    windowMinutes: 180,
    topCodes: [{ code: "slot_unavailable", count: 8 }],
    recentMinutes: 30,
    span: { firstMs: T0 - 175 * MIN, newestMs: T0 - 55 * MIN },
  };
  const ended = formatFailureBurstEnded({ ...base, recent: { attempts: 6, failures: 0 }, minRecentAttempts: 5 });
  assert(
    ended.startsWith(
      "Bookings failed in a burst that has stopped: nothing has failed since 9:05am ET, and all 6 attempts in the last 30 minutes completed. " +
        "8 of 38 booking attempts failed in the last 180 minutes (21%), recorded between 7:05am and 9:05am ET.",
    ),
    `a burst that ended reads as past, with when it ran and the clean run since (got: ${ended})`,
  );
  assert(ended.includes("Failed with: slot_unavailable (8)."), "it names what failed, in the past tense");
  assert(!/Still failing|Failing with/.test(ended), "and never reads as a live outage");
  assert(!DASHES.test(ended), "the burst notice uses no em/en dashes");

  const thin = formatFailureBurstEnded({ ...base, recent: { attempts: 2, failures: 0 }, minRecentAttempts: 5 });
  assert(
    thin.startsWith(
      "Bookings failed in a burst, and nothing has failed since 9:05am ET, but only 2 attempts came in the last 30 minutes, " +
        "too few to say bookings are completing again.",
    ),
    `too few recent attempts says exactly that, rather than claiming a recovery (L11) (got: ${thin})`,
  );
  const one = formatFailureBurstEnded({ ...base, recent: { attempts: 1, failures: 0 }, minRecentAttempts: 5 });
  assert(one.includes("but only 1 attempt came in the last 30 minutes"), `one attempt reads in the singular (got: ${one})`);
  const none = formatFailureBurstEnded({ ...base, recent: { attempts: 0, failures: 0 }, minRecentAttempts: 5 });
  assert(
    none.startsWith(
      "Bookings failed in a burst, and nothing has failed since 9:05am ET, but nobody has tried to book in the last 30 minutes, " +
        "so whether bookings are completing again is not yet known.",
    ),
    `no recent attempts at all says nothing is known yet (got: ${none})`,
  );
  const people = formatFailureBurstEnded({
    ...base,
    recent: { attempts: 6, failures: 0 },
    minRecentAttempts: 5,
    refused: { people: 3, refusals: 5, withoutLead: 0 },
  });
  assert(
    people.includes(
      "3 people were refused a time in the last 180 minutes (5 refusals); 8 of 38 attempts failed overall (21%), recorded between 7:05am and 9:05am ET.",
    ),
    `the burst notice leads with people the same way the page does (got: ${people})`,
  );
}

// The decision, through the real check.
{
  // A burst that ended 45 minutes ago, never paged, with a clean recent run: one past
  // notice on its OWN key, and no page on the condition key (which would owe an
  // all-clear five minutes later, the 6:05 message).
  const ended = windowOf([sample(T0 - 50 * MIN, 10, 6), sample(T0 - 45 * MIN, 5, 0), sample(T0 - 20 * MIN, 7, 0)]);
  const h = harness({ state: ended, resolveAnswers: false });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "breach", "the window is still over the line (6 of 22)");
  eq(h.notified.map((n) => n.key), [FAILURE_BURST_ENDED_ALERT_KEY], "an ended burst sends one past notice and no page");
  eq(h.resolved, [FAILURE_RATE_ALERT_KEY], "the clean recent run still settles any page that was open");
  assert(
    out.status === "checked" && out.state.samples.some((s) => s.told === "past"),
    "and the window remembers it was told, so the notice is once per burst",
  );
}
{
  // The same, when a page WAS open: its all-clear is the news, so no past notice too.
  const ended = windowOf([sample(T0 - 50 * MIN, 10, 6), sample(T0 - 45 * MIN, 5, 0), sample(T0 - 20 * MIN, 7, 0)]);
  const h = harness({ state: ended, resolveAnswers: true });
  await h.run();
  eq(h.resolved, [FAILURE_RATE_ALERT_KEY], "the open page is all-cleared");
  eq(h.notified.length, 0, "and the past notice is not sent on top of it");
}
{
  // Already told about this burst (a live page, earlier in the window): nothing more.
  const told = windowOf([{ ...sample(T0 - 50 * MIN, 10, 6), told: "live" }, sample(T0 - 45 * MIN, 5, 0), sample(T0 - 20 * MIN, 7, 0)]);
  const h = harness({ state: told, resolveAnswers: false });
  await h.run();
  eq(h.notified.length, 0, "a burst somebody was already told about is not reported again");
}
{
  // Too few recent attempts: the burst notice says so, and nothing is all-cleared.
  const thin = windowOf([sample(T0 - 50 * MIN, 10, 6), sample(T0 - 45 * MIN, 12, 0), sample(T0 - 20 * MIN, 2, 0)]);
  const h = harness({ state: thin, resolveAnswers: false });
  await h.run();
  eq(h.resolved.length, 0, "two recent attempts are too few to stand anything down (L695, L98)");
  eq(h.notified.map((n) => n.key), [FAILURE_BURST_ENDED_ALERT_KEY], "the burst is still reported, once");
  assert(h.notified[0]?.text.includes("too few to say bookings are completing again"), "and says why it claims no recovery");
}
{
  // A live burst: failures inside the recent window, more than a clean run allows.
  const live = windowOf([sample(T0 - 50 * MIN, 10, 2), sample(T0 - 10 * MIN, 12, 5)]);
  const h = harness({ state: live, resolveAnswers: false });
  const out = await h.run();
  eq(h.notified.map((n) => n.key), [FAILURE_RATE_ALERT_KEY], "a live burst pages on the condition key");
  assert(h.notified[0]?.text.includes("Still failing: 5 of 12 attempts in the last 30 minutes failed."), "and says it is still failing");
  eq(h.resolved.length, 0, "and settles nothing");
  assert(out.status === "checked" && out.state.samples.at(-1)?.told === "live", "the window records that a page went out");
}
{
  // Over the line on OLD failures, with one ordinary failure in a clean recent run:
  // neither a live page nor a past notice yet, and the open page may stand down.
  const w = windowOf([sample(T0 - 50 * MIN, 10, 7), sample(T0 - 10 * MIN, 20, 1)]);
  const h = harness({ state: w, resolveAnswers: true });
  await h.run();
  eq(h.notified.length, 0, "old failures plus one ordinary race do not re-page");
  eq(h.resolved, [FAILURE_RATE_ALERT_KEY], "19 of 20 recent attempts completing stands the page down");
}
{
  // A window that holds nothing recent (the first reading after the state was lost):
  // no recent attempts were measured, so nothing may be all-cleared.
  const h = harness({ state: null, resolveAnswers: true });
  const out = await h.run();
  eq(out.status, "checked", "a fresh baseline is a checked tick");
  eq(h.resolved.length, 0, "with no recent attempts measured there is no all-clear");
  eq(h.notified.length, 0, "and no page");
}
{
  // A resolve that throws cannot say whether a page was open, so the burst is still
  // reported: a possible duplicate is better than a burst nobody hears about.
  const ended = windowOf([sample(T0 - 50 * MIN, 10, 6), sample(T0 - 45 * MIN, 5, 0), sample(T0 - 20 * MIN, 7, 0)]);
  const errors: string[] = [];
  const notified: string[] = [];
  await runBookingFailureRateCheck({
    nowMs: T0 + MIN,
    loadState: async () => ended,
    saveState: async () => {},
    readToday: async () => reading("2026-08-11", 1000, 100),
    readRefusedPeople: async () => ({ people: 0, refusals: 0, withoutLead: 0 }),
    thresholds: THRESHOLDS,
    recent: RECENT,
    armed: true,
    cooldownMs: 30 * MIN,
    notify: async (key) => {
      notified.push(key);
    },
    resolve: async () => {
      throw new Error("alert_state unreadable");
    },
    onError: (context) => errors.push(context),
  });
  eq(errors, ["resolve"], "the failed resolve is reported");
  eq(notified, [FAILURE_BURST_ENDED_ALERT_KEY], "and the burst is still reported");
}
{
  // A burst notice whose send FAILED is asked for again on the next tick (L33): the
  // dispatcher leaves a short retry stamp on a failed post, which only helps if the
  // check calls it again. Its own cooldown, not the window's marker, holds a
  // delivered notice to once.
  let state: RateWindowState | null = windowOf([
    sample(T0 - 50 * MIN, 10, 6),
    sample(T0 - 45 * MIN, 5, 0),
    sample(T0 - 20 * MIN, 7, 0),
  ]);
  const calls: { key: string; cooldownMs: number }[] = [];
  let slackDown = true;
  const tick = (nowMs: number) =>
    runBookingFailureRateCheck({
      nowMs,
      loadState: async () => state,
      saveState: async (s) => {
        state = s;
      },
      readToday: async () => reading("2026-08-11", 1000, 100, { slot_unavailable: 90, internal: 10 }),
      readRefusedPeople: async () => ({ people: 0, refusals: 0, withoutLead: 0 }),
      thresholds: THRESHOLDS,
      recent: RECENT,
      armed: true,
      cooldownMs: 30 * MIN,
      notify: async (key, cooldownMs) => {
        calls.push({ key, cooldownMs });
        if (slackDown) throw new Error("slack down");
      },
      resolve: async () => false,
      onError: () => {},
    });
  await tick(T0 + MIN);
  slackDown = false;
  await tick(T0 + 6 * MIN);
  eq(
    calls.map((c) => c.key),
    [FAILURE_BURST_ENDED_ALERT_KEY, FAILURE_BURST_ENDED_ALERT_KEY],
    "a burst notice that failed to send is asked for again on the next tick",
  );
  eq(calls[0]?.cooldownMs, THRESHOLDS.windowMs, "on a cooldown as long as the window, so a delivered one goes once per burst");
}
{
  // Disarmed: measured, never told, so nothing is marked as told either.
  const ended = windowOf([sample(T0 - 50 * MIN, 10, 6), sample(T0 - 45 * MIN, 5, 0), sample(T0 - 20 * MIN, 7, 0)]);
  const h = harness({ state: ended, armed: false });
  const out = await h.run();
  eq(h.notified.length + h.resolved.length, 0, "a disarmed check sends nothing about a burst");
  assert(out.status === "checked" && !out.state.samples.some((s) => s.told), "and records nobody as told");
}

// --- #3275: the lane, five minutes at a time, against a dispatcher model ------------

interface Sent {
  atMs: number;
  key: string;
  text: string;
  kind: "page" | "clear";
}

/**
 * Drives the REAL check one tick at a time against a model of `alert_state` that
 * behaves as the dispatcher does: a page is held by its cooldown, an all-clear goes
 * out only for a page that is open, and settling one clears its cooldown. The tally
 * is cumulative, as the real one is, so the window is built by the real
 * `advanceWindow` rather than written by hand.
 */
function lane(day: string) {
  let state: RateWindowState | null = null;
  let tallyAttempts = 0;
  let tallyFailures = 0;
  const byCode: Record<string, number> = {};
  const lastSent = new Map<string, number>();
  const firing = new Set<string>();
  const sent: Sent[] = [];
  return {
    sent,
    async tick(atMs: number, a: number, f: number): Promise<FailureRateResult> {
      tallyAttempts += a;
      tallyFailures += f;
      if (f > 0) byCode.slot_unavailable = (byCode.slot_unavailable ?? 0) + f;
      return runBookingFailureRateCheck({
        nowMs: atMs,
        loadState: async () => (state ? structuredClone(state) : null),
        saveState: async (s) => {
          state = structuredClone(s);
        },
        readToday: async () => ({ day, attempts: tallyAttempts, failures: tallyFailures, byCode: { ...byCode } }),
        readRefusedPeople: async () => ({ people: 0, refusals: 0, withoutLead: 0 }),
        thresholds: SHIPPED_FAILURE_RATE_THRESHOLDS,
        recent: SHIPPED_FAILURE_RATE_RECENT,
        armed: true,
        cooldownMs: 30 * MIN,
        notify: async (key, cooldownMs, text) => {
          const last = lastSent.get(key);
          if (last !== undefined && atMs - last < cooldownMs) return;
          lastSent.set(key, atMs);
          firing.add(key);
          sent.push({ atMs, key, text, kind: "page" });
        },
        resolve: async (key, text) => {
          if (!firing.has(key)) return false;
          firing.delete(key);
          lastSent.delete(key);
          sent.push({ atMs, key, text, kind: "clear" });
          return true;
        },
      });
    },
  };
}

/** An instant on 2026-10-14 (EDT, four hours behind UTC), by ET clock time. */
const oct14 = (h: number, m: number) => Date.UTC(2026, 9, 14, h + 4, m);

// The regression: 2026-10-14, the exact 6:00 and 6:05am ET sequence.
{
  const l = lane("2026-10-14");
  // Overnight traffic, clean, so the share stays under the line until 6:00 as it did.
  await l.tick(oct14(0, 0), 0, 0);
  for (let t = oct14(0, 5); t <= oct14(2, 55); t += 5 * MIN) await l.tick(t, 2, 0);
  await l.tick(oct14(3, 0), 3, 0);
  // 3:05 to 6:00: one attempt a tick, and the eight failures where they fell. The
  // 3:02 failure is recorded by the 3:05 tick, 4:08 to 4:11 by 4:10 and 4:15, the
  // three refusals at 4:46 to 4:47 by 4:50, and the 5:01 race by 5:05.
  const failing: Record<string, [number, number]> = {
    "3:05": [1, 1],
    "3:10": [0, 0],
    "4:10": [2, 2],
    "4:15": [1, 1],
    "4:50": [3, 3],
    "5:05": [1, 1],
  };
  let at600: FailureRateResult | null = null;
  for (let t = oct14(3, 5); t <= oct14(6, 0); t += 5 * MIN) {
    const d = new Date(t - 4 * 60 * MIN);
    const label = `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const [a, f] = failing[label] ?? [1, 0];
    const out = await l.tick(t, a, f);
    if (t === oct14(6, 0)) at600 = out;
  }
  assert(
    at600 !== null && at600.status === "checked" && at600.verdict.status === "breach" && at600.verdict.attempts === 38 && at600.verdict.failures === 8,
    "at 6:00am the window holds 8 failures in 38 attempts (21%), as the page did",
  );
  eq(l.sent.length, 1, "by 6:00am exactly one message has gone out");
  eq(l.sent[0]?.key, FAILURE_BURST_ENDED_ALERT_KEY, "and it is the past notice, not a page on the live condition");
  eq(l.sent[0]?.atMs, oct14(6, 0), "sent at 6:00am");
  assert(
    (l.sent[0]?.text ?? "").startsWith(
      "Bookings failed in a burst that has stopped: nothing has failed since 5:05am ET, and all 6 attempts in the last 30 minutes completed. " +
        "8 of 38 booking attempts failed in the last 180 minutes (21%), recorded between 3:05am and 5:05am ET.",
    ),
    `it reads as a burst that already ended, with when (got: ${l.sent[0]?.text})`,
  );

  // 6:05: the 3:02 failure ages out and two bookings complete (7 of 39, 18%).
  const at605 = await l.tick(oct14(6, 5), 2, 0);
  assert(
    at605.status === "checked" && at605.verdict.status === "healthy" && at605.verdict.failures === 7 && at605.verdict.attempts === 39,
    "at 6:05am the window reads 7 of 39, as it did",
  );
  // And the rest of the morning, clean.
  for (let t = oct14(6, 10); t <= oct14(9, 0); t += 5 * MIN) await l.tick(t, 1, 0);
  eq(l.sent.length, 1, "no all-clear at 6:05am, and nothing else all morning: nothing recovered, so nothing says it did");
  assert(!l.sent.some((s) => s.text.includes("completing again")), "no message claims bookings are completing again");
}

/** An instant on 2026-10-04 (EDT), by ET clock time. */
const oct4 = (h: number, m: number) => Date.UTC(2026, 9, 4, h + 4, m);

// A live burst (the 2026-10-04 shape): pages while it is happening, stands down once
// on a measured clean run, and does not re-page or re-clear as the old failures age.
{
  const l = lane("2026-10-04");
  await l.tick(oct4(17, 0), 0, 0);
  for (let t = oct4(17, 5); t <= oct4(19, 25); t += 5 * MIN) await l.tick(t, 2, 0);
  // 19:30 to 20:45: 21 refusals over sixteen ticks.
  let k = 0;
  for (let t = oct4(19, 30); t <= oct4(20, 45); t += 5 * MIN, k++) await l.tick(t, 2, k < 5 ? 2 : 1);
  const lastFailure = oct4(20, 45);
  // Then bookings complete, one a tick, until the day ends.
  for (let t = oct4(20, 50); t <= oct4(23, 55); t += 5 * MIN) await l.tick(t, 1, 0);

  const pages = l.sent.filter((s) => s.key === FAILURE_RATE_ALERT_KEY && s.kind === "page");
  const clears = l.sent.filter((s) => s.kind === "clear");
  assert(pages.length >= 1, "the live burst pages");
  assert(pages.every((p) => p.atMs <= lastFailure), "every page went out while it was still failing, none on old failures");
  assert(pages.every((p) => p.text.includes("Still failing:")), "and each says it is still failing");
  eq(clears.length, 1, "exactly one all-clear, never a second as the old failures age out");
  eq(clears[0]?.atMs, oct4(21, 15), "sent once the last 30 minutes held no failure and at least five attempts");
  eq(
    clears[0]?.text,
    "Bookings are completing again: all 6 attempts in the last 30 minutes completed, and nothing has failed since 8:45pm ET.",
    "the all-clear quotes the clean run it stood down on",
  );
  eq(l.sent.filter((s) => s.key === FAILURE_BURST_ENDED_ALERT_KEY).length, 0, "and no past notice for a burst somebody was paged about");
}

// Too few recent attempts: a night burst pages, then the night goes quiet. Nothing is
// all-cleared off a thin run; the all-clear waits for a measured one.
{
  const l = lane("2026-10-14");
  await l.tick(oct14(0, 0), 0, 0);
  for (let t = oct14(0, 5); t <= oct14(0, 55); t += 5 * MIN) await l.tick(t, 2, 0);
  for (let t = oct14(1, 0); t <= oct14(1, 30); t += 5 * MIN) await l.tick(t, 3, 3);
  // One attempt every fifteen minutes until 3:00, so a 30 minute window holds two.
  for (let t = oct14(1, 35); t < oct14(3, 0); t += 5 * MIN) await l.tick(t, (t - oct14(1, 45)) % (15 * MIN) === 0 ? 1 : 0, 0);
  const beforeTraffic = l.sent.length;
  assert(l.sent.some((s) => s.key === FAILURE_RATE_ALERT_KEY && s.kind === "page"), "the night burst paged");
  eq(l.sent.filter((s) => s.kind === "clear").length, 0, "no all-clear while the recent window held too few attempts");
  eq(l.sent.filter((s) => s.key === FAILURE_BURST_ENDED_ALERT_KEY).length, 0, "and no past notice for a burst already paged");
  // Morning traffic: one attempt a tick. Five clean attempts inside 30 minutes is the floor.
  for (let t = oct14(3, 0); t <= oct14(4, 0); t += 5 * MIN) await l.tick(t, 1, 0);
  const clears = l.sent.slice(beforeTraffic).filter((s) => s.kind === "clear");
  eq(clears.length, 1, "the all-clear comes once the recent window holds a measured clean run");
  eq(clears[0]?.atMs, oct14(3, 20), "at the tick the last 30 minutes first held five clean attempts");
}

// The SHIPPED recent window: shorter than the window it stands down, and a clean run
// that cannot be carried by one lucky attempt.
{
  const r = SHIPPED_FAILURE_RATE_RECENT;
  assert(r.windowMs < SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs, "the recent window is shorter than the judged window");
  assert(r.minAttempts >= 5, "a clean run needs at least five attempts");
  assert(r.recoverPct < SHIPPED_FAILURE_RATE_THRESHOLDS.failPct, "standing down takes a far lower share than paging (hysteresis)");
}

finish();
