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
  countRefusedPeople,
  FAILURE_RATE_ALERT_KEY,
  type FailureRateResult,
  type OutcomeReading,
  type RateThresholds,
  type RateWindowState,
  type RefusedPeople,
} from "../src/lib/monitor/booking-failure-rate.ts";
import { FAILURE_RATE_FIT, MEASURED_ATTEMPT_TRAFFIC, SHIPPED_FAILURE_RATE_THRESHOLDS } from "../src/lib/monitor/failure-rate-thresholds.ts";
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
  assert(msg.includes("38"), "the page states how many attempts failed");
  assert(msg.includes("82"), "the page states how many attempts there were");
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
  const people = formatFailureRateAlert({ ...base, refused: { people: 4, refusals: 35, withoutLead: 0 } });
  assert(
    people.startsWith(
      "4 people were refused a time in the last 180 minutes (35 refusals); 38 of 82 attempts failed overall (46%).",
    ),
    `it leads with people, then attempts overall (got: ${people})`,
  );
  assert(people.includes("slot_unavailable (35)"), "and still names the failing code");
  assert(!DASHES.test(people), "no dashes in the people form either");

  const single = formatFailureRateAlert({ ...base, refused: { people: 1, refusals: 1, withoutLead: 0 } });
  assert(
    single.startsWith("1 person was refused a time in the last 180 minutes (1 refusal);"),
    `one person and one refusal read in the singular (got: ${single})`,
  );
  const oneRetrying = formatFailureRateAlert({ ...base, refused: { people: 1, refusals: 5, withoutLead: 0 } });
  assert(
    oneRetrying.startsWith("1 person was refused a time in the last 180 minutes (5 refusals);"),
    "one lead retrying five times reads as one person, five refusals",
  );

  // A refusal with no lead id cannot be told apart from anybody, so the count is a
  // floor and says so (L11: claim only what was measured).
  const floor = formatFailureRateAlert({ ...base, refused: { people: 3, refusals: 6, withoutLead: 2 } });
  assert(floor.startsWith("At least 3 people were refused a time"), `an unidentified refusal makes it a floor (got: ${floor})`);

  // No people form when nothing was refused (the failures were internal errors and
  // the like, which carry nobody) or when the people read failed.
  const noneRefused = formatFailureRateAlert({ ...base, refused: { people: 0, refusals: 0, withoutLead: 0 } });
  assert(noneRefused.startsWith("38 of 82 booking attempts failed"), "zero refusals falls back to attempts");
  const unread = formatFailureRateAlert({ ...base, refused: null });
  assert(unread.startsWith("38 of 82 booking attempts failed"), "an unread people count falls back to attempts");
  // Refusals happened but not one carried a lead id: there is nobody to count, and
  // "At least 0 people" would be a claim about people the page cannot make.
  const nobodyKnown = formatFailureRateAlert({ ...base, refused: { people: 0, refusals: 4, withoutLead: 4 } });
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
    rotated.includes("_TRYPENNIE, _CANARY or _MARCIA) was rotated") && rotated.includes("BOOKING_API_KEY_REGAL") && !rotated.includes("shared"),
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
  /** The `sinceMs` of every refused-people read the check made. */
  peopleReads: number[];
}

function harness(overrides: {
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

finish();
