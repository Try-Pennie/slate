// A detector that has never once reached a verdict (#1394).
//
// The bug class this guards: a fail-safe detector reports `unverified` or
// `skipped` rather than guessing, which is right, and the cost is that "nothing
// to report" and "could not check anything" render identically. The
// availability-truth probe sat in exactly that state for its entire life before
// #1377: it ran on every tick, advanced its rotation, logged, and had never once
// compared a real calendar. The existing lane heartbeats could not see it,
// because the lane genuinely RAN; what it never did was CONCLUDE.
//
// So the three pieces tested here: which outcomes count as a measured verdict
// (nothing else may stamp), how long each detector may go without one, and copy
// that says "has not reached a verdict" rather than "has not run".
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-verdict-freshness.ts
import {
  VERDICT_STALE_BOUNDS_MS,
  findStaleLanes,
  describeGap,
} from "../src/lib/monitor/health.ts";
import {
  AVAILABILITY_TRUTH_VERDICT_LANE,
  FAILURE_RATE_VERDICT_LANE,
  LOW_VOLUME_VERDICT_LANE,
  OOO_PROTECTION_VERDICT_LANE,
  TWILIO_ROSTER_VERDICT_LANE,
  LANE_WATCHDOG_VERDICT_LANE,
  REGAL_CALLS_VERDICT_LANE,
  TIER_STAFFING_VERDICT_LANE,
  tierStaffingReachedVerdict,
  BURST_COUNTER_VERDICT_LANE,
  KILL_SWITCH_VERDICT_LANE,
  CONFIRM_LINE_VERDICT_LANE,
  REROUTE_DRILL_VERDICT_LANE,
  BELOW_LEAD_TIER_VERDICT_LANE,
  CROSS_SYSTEM_BOOKINGS_VERDICT_LANE,
  ROSTER_COVERAGE_VERDICT_LANE,
  AVAILABILITY_SCAN_VERDICT_LANE,
  CALENDAR_WINDOW_VERDICT_LANE,
  BUSY_DRIFT_VERDICT_LANE,
  OFFERED_NOBODY_FREE_VERDICT_LANE,
  offeredNobodyFreeReachedVerdict,
  BUFFER_BREACH_VERDICT_LANE,
  bufferBreachReachedVerdict,
  CRON_BUDGET_VERDICT_LANE,
  OFFSITE_ORIGIN_VERDICT_LANE,
  AUTH_SIGN_IN_VERDICT_LANE,
  AUTH_UNEXPECTED_SIGN_IN_VERDICT_LANE,
  AWAITING_ACTIVATION_VERDICT_LANE,
  STRANDED_HIRES_VERDICT_LANE,
  AUDIT_CHAIN_VERDICT_LANE,
  REGAL_CALL_FEED_VERDICT_LANE,
  REGAL_CALL_OUTCOMES_VERDICT_LANE,
  ADVISOR_PHOTOS_VERDICT_LANE,
  BUSY_MINUTES_VERDICT_LANE,
  AVAILABILITY_LATENCY_VERDICT_LANE,
  auditChainReachedVerdict,
  laneWatchdogReachedVerdict,
  twilioRosterReachedVerdict,
  truthReachedVerdict,
  failureRateReachedVerdict,
  lowVolumeReachedVerdict,
  parkedDetector,
  detectorParkState,
  PARKED_VERDICT_DETECTORS,
} from "../src/lib/monitor/verdict-freshness.ts";
import {
  verdictBlindAlertText,
  verdictRecoveryText,
  verdictUnparkAlertText,
  verdictUnparkLapsedText,
} from "../src/lib/monitor/lane-copy.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const HOUR = 60 * 60_000;

// --- which outcomes count as a MEASURED verdict -------------------------------
// The whole point. A tick that skipped, could not read Google, or judged too
// small a sample has measured nothing, and stamping on it would recreate the
// exact blindness this exists to catch.
{
  assert(
    truthReachedVerdict({
      status: "checked",
      code: "101",
      armed: false,
      verdict: { status: "healthy", verified: 12, drifted: 0, driftPct: 0 },
    }),
    "availability truth: a measured healthy sample is a verdict",
  );
  assert(
    truthReachedVerdict({
      status: "checked",
      code: "101",
      armed: true,
      verdict: { status: "drifted", verified: 10, drifted: 8, driftPct: 80 },
    }),
    "availability truth: a measured drifted sample is a verdict",
  );
  assert(
    !truthReachedVerdict({ status: "skipped", why: "bucket is offering no times to check" }),
    "availability truth: the skip that hid the probe's blindness for its whole life is NOT a verdict",
  );
  assert(
    !truthReachedVerdict({ status: "unverified", code: "101" }),
    "availability truth: Google unreadable is NOT a verdict",
  );
  assert(
    !truthReachedVerdict({
      status: "checked",
      code: "101",
      armed: false,
      verdict: { status: "unverified", verified: 1, unverified: 9 },
    }),
    "availability truth: a sample too small to judge is NOT a verdict, even though the tick reports checked",
  );
  assert(!truthReachedVerdict({ status: "errored" }), "availability truth: a thrown step is NOT a verdict");
}

{
  assert(
    failureRateReachedVerdict({
      status: "checked",
      armed: false,
      rebased: null,
      verdict: { status: "healthy", attempts: 40, failures: 1, pct: 2.5, topCodes: [] },
    }),
    "failure rate: a measured healthy window is a verdict",
  );
  assert(
    failureRateReachedVerdict({
      status: "checked",
      armed: true,
      rebased: null,
      verdict: { status: "breach", attempts: 40, failures: 20, pct: 50, topCodes: [] },
    }),
    "failure rate: a measured breach is a verdict",
  );
  assert(
    !failureRateReachedVerdict({
      status: "checked",
      armed: false,
      rebased: null,
      verdict: { status: "insufficient", attempts: 2, failures: 0 },
    }),
    "failure rate: too few attempts to judge is NOT a verdict (the permanent state on a dark roster)",
  );
  assert(
    !failureRateReachedVerdict({ status: "unverified", why: "tally" }),
    "failure rate: an unreadable tally is NOT a verdict",
  );
  assert(!failureRateReachedVerdict({ status: "errored" }), "failure rate: a thrown step is NOT a verdict");
}

{
  assert(
    lowVolumeReachedVerdict({ status: "checked", armed: false, windows: [], breaches: [] }),
    "low volume: a tick that read the counts is a verdict",
  );
  assert(
    !lowVolumeReachedVerdict({ status: "outside-hours" }),
    "low volume: outside business hours is NOT a verdict",
  );
  assert(
    !lowVolumeReachedVerdict({ status: "count-unreadable" }),
    "low volume: an unreadable count is NOT a verdict (it is the false zero #1158 removed)",
  );
  assert(!lowVolumeReachedVerdict({ status: "unverified" }), "low volume: unverified is NOT a verdict");
}

// --- the Twilio half of the roster sync (#2114) --------------------------------
{
  assert(
    twilioRosterReachedVerdict({ ok: true }),
    "twilio roster: a run that read Twilio and judged the roster IS a verdict",
  );
  assert(
    !twilioRosterReachedVerdict({ ok: false }),
    "twilio roster: a refused read is NOT a verdict, or the detector would report itself as concluding while blind",
  );
  // #2382: the sixth, and the one that watches the watchman. Its two non-verdicts
  // arrive by different routes and both have to be silent: the runner's fallback
  // when the step threw, and the watchdog's own answer when it ran and could not
  // read the heartbeats. The second is the dangerous one, because it used to be a
  // bare empty stale list, which is exactly what a healthy fleet returns.
  assert(
    laneWatchdogReachedVerdict({ judged: true, stale: [] }),
    "lane watchdog: a tick that read the heartbeats and found every lane healthy IS a verdict",
  );
  assert(
    !laneWatchdogReachedVerdict({ judged: false, stale: [] }),
    "lane watchdog: a tick that judged nothing is NOT a verdict, however healthy its empty list looks",
  );
}

// --- the bounds ---------------------------------------------------------------
{
  const lanes = Object.keys(VERDICT_STALE_BOUNDS_MS).sort();
  assert(
    lanes.join(",") ===
      [
        AVAILABILITY_TRUTH_VERDICT_LANE,
        FAILURE_RATE_VERDICT_LANE,
        LOW_VOLUME_VERDICT_LANE,
        OOO_PROTECTION_VERDICT_LANE,
        TWILIO_ROSTER_VERDICT_LANE,
        LANE_WATCHDOG_VERDICT_LANE,
        BURST_COUNTER_VERDICT_LANE,
        KILL_SWITCH_VERDICT_LANE,
        CONFIRM_LINE_VERDICT_LANE,
        REROUTE_DRILL_VERDICT_LANE,
        TIER_STAFFING_VERDICT_LANE,
        BELOW_LEAD_TIER_VERDICT_LANE,
        CROSS_SYSTEM_BOOKINGS_VERDICT_LANE,
        REGAL_CALLS_VERDICT_LANE,
        ROSTER_COVERAGE_VERDICT_LANE,
        AVAILABILITY_SCAN_VERDICT_LANE,
        CALENDAR_WINDOW_VERDICT_LANE,
        OFFSITE_ORIGIN_VERDICT_LANE,
        AUTH_SIGN_IN_VERDICT_LANE,
        AUTH_UNEXPECTED_SIGN_IN_VERDICT_LANE,
        AWAITING_ACTIVATION_VERDICT_LANE,
        STRANDED_HIRES_VERDICT_LANE,
        AUDIT_CHAIN_VERDICT_LANE,
        REGAL_CALL_FEED_VERDICT_LANE,
        REGAL_CALL_OUTCOMES_VERDICT_LANE,
        ADVISOR_PHOTOS_VERDICT_LANE,
        BUSY_MINUTES_VERDICT_LANE,
        AVAILABILITY_LATENCY_VERDICT_LANE,
        BUSY_DRIFT_VERDICT_LANE,
        CRON_BUDGET_VERDICT_LANE,
        OFFERED_NOBODY_FREE_VERDICT_LANE,
        BUFFER_BREACH_VERDICT_LANE,
      ]
        .sort()
        .join(","),
    "every detector named by this feature has a bound, and no bound names a detector that does not exist",
  );
  // The two traffic-fed detectors are silent all weekend by design (the volume
  // check is gated to Mon-Fri business hours, and an hourly failure-rate window
  // cannot reach its attempt floor overnight). A bound shorter than the longest
  // legitimate quiet stretch would page every Sunday, which is L36 exactly.
  const FRIDAY_EVENING_TO_MONDAY_MORNING_MS = 60 * HOUR;
  for (const lane of [FAILURE_RATE_VERDICT_LANE, LOW_VOLUME_VERDICT_LANE]) {
    assert(
      VERDICT_STALE_BOUNDS_MS[lane] > FRIDAY_EVENING_TO_MONDAY_MORNING_MS,
      `${lane}'s bound outlasts a whole weekend of legitimate silence`,
    );
  }
  assert(
    VERDICT_STALE_BOUNDS_MS[AVAILABILITY_TRUTH_VERDICT_LANE] >= 5 * HOUR,
    "availability truth's bound covers at least one full pass of the bucket rotation",
  );
}

// --- staleness, including the state the issue is named after ------------------
{
  const now = Date.UTC(2026, 7, 12, 15, 0, 0);
  const bound = VERDICT_STALE_BOUNDS_MS[AVAILABILITY_TRUTH_VERDICT_LANE];

  const fresh = findStaleLanes(
    { [AVAILABILITY_TRUTH_VERDICT_LANE]: now - 60_000 },
    now,
    VERDICT_STALE_BOUNDS_MS,
    true,
  );
  assert(
    !fresh.some((l) => l.lane === AVAILABILITY_TRUTH_VERDICT_LANE),
    "a detector that concluded a minute ago is not blind",
  );

  const stale = findStaleLanes(
    { [AVAILABILITY_TRUTH_VERDICT_LANE]: now - bound - 60_000 },
    now,
    VERDICT_STALE_BOUNDS_MS,
    true,
  );
  assert(
    stale.some((l) => l.lane === AVAILABILITY_TRUTH_VERDICT_LANE),
    "a detector past its bound since its last verdict is blind",
  );

  // The headline case: it has run for months and concluded exactly zero times,
  // so there is no stamp at all. The default leniency (never stamped = fresh
  // deploy, stay quiet) would make this feature unable to detect the very state
  // it was written for, which is why these lanes are judged with neverIsStale on.
  const never = findStaleLanes({}, now, VERDICT_STALE_BOUNDS_MS, true);
  assert(
    never.length === Object.keys(VERDICT_STALE_BOUNDS_MS).length,
    "a detector that has NEVER reached a verdict is reported, not skipped",
  );
  assert(
    never.every((l) => !Number.isFinite(l.ageMs)),
    "never-concluded carries an infinite age, so copy can tell it from a measured gap",
  );
}

// --- describeGap: a bound of days must not be read out in minutes -------------
{
  assert(describeGap(45 * 60_000) === "45 minutes", "sub-hour gaps read in minutes");
  assert(describeGap(90 * 60_000) === "2 hours", "an hour or more reads in hours");
  assert(describeGap(26 * HOUR) === "26 hours", "just over a day still reads in hours");
  assert(describeGap(4 * 24 * HOUR) === "4 days", "multi-day gaps read in days, not 5760 minutes");
  assert(describeGap(1 * 60_000) === "1 minute", "singular minute");
  assert(describeGap(60 * HOUR) === "3 days", "a weekend-long gap reads in days");
}

// --- copy ---------------------------------------------------------------------
{
  const measured = verdictBlindAlertText({
    lane: AVAILABILITY_TRUTH_VERDICT_LANE,
    ageMs: 30 * HOUR,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[AVAILABILITY_TRUTH_VERDICT_LANE],
    unreadable: false,
  });
  assert(measured.includes("30 hours"), "measured copy quotes the real gap");
  assert(
    /verdict|conclu/i.test(measured),
    "measured copy says the detector has not CONCLUDED, not that it has not run",
  );
  assert(
    !measured.startsWith("Slate"),
    "copy does not open with Slate (Slack already shows the app name)",
  );
  assert(!DASHES.test(measured), "no dashes as punctuation");
  assert(!/undefined|NaN|\[object Object\]/.test(measured), "measured copy renders no placeholder leak");
  assert(
    !measured.includes(AVAILABILITY_TRUTH_VERDICT_LANE),
    "copy names the detector in words, not by its internal lane key",
  );

  const never = verdictBlindAlertText({
    lane: FAILURE_RATE_VERDICT_LANE,
    ageMs: Infinity,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[FAILURE_RATE_VERDICT_LANE],
    unreadable: false,
  });
  assert(/never/i.test(never), "never-concluded copy says so plainly");
  assert(!/Infinity|NaN/.test(never), "never-concluded copy quotes no arithmetic on infinity");
  assert(!DASHES.test(never), "never-concluded copy has no dashes");

  const unreadable = verdictBlindAlertText({
    lane: LOW_VOLUME_VERDICT_LANE,
    ageMs: Date.now(),
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[LOW_VOLUME_VERDICT_LANE],
    unreadable: true,
  });
  assert(
    /cannot be read/i.test(unreadable),
    "an unreadable record says so, rather than quoting an age it never measured",
  );

  // Every detector gets its own words. One shared "a detector went blind" would
  // send the reader looking for the wrong thing, which is the #1123 defect.
  // Derived from the bounds map rather than listed by hand, so a fifth detector
  // is covered by construction: a hand kept list can only check the lanes
  // somebody remembered to add to it (L96), and those are the ones already safe.
  const allVerdictLanes = Object.keys(VERDICT_STALE_BOUNDS_MS);
  const texts = allVerdictLanes.map((lane) =>
    verdictBlindAlertText({ lane, ageMs: 30 * HOUR, maxStaleMs: HOUR, unreadable: false }),
  );
  assert(
    new Set(texts).size === allVerdictLanes.length,
    "each detector's page describes that detector, not a generic one",
  );
  for (const t of texts) assert(t.length > 80, "each page says what stopped being measured");

  // #2382: the watchdog's own page has TWO causes, and the first is not about the
  // watchdog. Only the monitor lane writes this stamp, so a monitor lane that is
  // not running at all lands here too, and that case already pages under its own
  // name. A page that named only tag=lane-watchdog would be advice about the wrong
  // fault most of the times it can fire (L11).
  const watchdogPage = verdictBlindAlertText({
    lane: LANE_WATCHDOG_VERDICT_LANE,
    ageMs: 9 * HOUR,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[LANE_WATCHDOG_VERDICT_LANE],
    unreadable: false,
  });
  assert(
    /monitor lane is stale/i.test(watchdogPage),
    "the blind watchdog page sends the reader at the monitor lane's own staleness first, since that is the commoner cause of this stamp going cold",
  );
  assert(
    watchdogPage.includes("tag=lane-watchdog"),
    "and still names the watchdog's own logs, which is the other cause",
  );

  const recovery = verdictRecoveryText(AVAILABILITY_TRUTH_VERDICT_LANE);
  assert(/no action is needed/i.test(recovery), "the all-clear closes the loop");
  assert(!DASHES.test(recovery), "recovery copy has no dashes");
  assert(
    new Set(allVerdictLanes.map(verdictRecoveryText)).size === allVerdictLanes.length,
    "each detector's all-clear names what is being measured again",
  );
}

// --- built is not wired (L3) ---------------------------------------------------
// The heartbeat coverage guard proves every stamp has a bound and every bound has
// a stamp, but both would still hold if the monitor lane never CALLED any of them.
// The stamps would then never land, all three detectors would page as blind, and
// the feature would fail in the loudest possible way while every test stayed green.
{
  const route = readFileSync(
    join(import.meta.dirname, "..", "src", "app", "api", "cron", "monitor", "route.ts"),
    "utf8",
  );
  // Strip comments first: a guard satisfied by a comment ABOUT the call, including
  // one explaining that it was removed, is indistinguishable from one that works (L103).
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(
    code.includes("recordDetectorVerdict("),
    "the monitor lane actually stamps detector verdicts",
  );
  // NOT every verdict lane, and the exception is stated rather than left to be
  // inferred from the list (L400). `verdict:burst-counter` (#2392) is stamped by a
  // GitHub workflow through the key authed heartbeat endpoint, because the whole
  // point of that check is to CALL the Durable Object, which is the one thing the
  // monitor lane must not do. Its own wiring is proved by
  // scripts/test-burst-counter-schedule.ts and by the workflow stamp list in
  // scripts/test-heartbeat-lane-coverage.ts.
  for (const [name, predicate] of [
    ["AVAILABILITY_TRUTH_VERDICT_LANE", "truthReachedVerdict"],
    ["FAILURE_RATE_VERDICT_LANE", "failureRateReachedVerdict"],
    ["LOW_VOLUME_VERDICT_LANE", "lowVolumeReachedVerdict"],
  ]) {
    assert(
      new RegExp(`recordDetectorVerdict\\(\\s*${name}\\s*,\\s*${predicate}\\(`).test(code),
      `${name} is stamped from ${predicate}, not from a hand-rolled second opinion`,
    );
  }
}

// --- The un-park copy must not render an issue number it does not have ---
//
// Exposed by #2484, which emptied `PARKED_VERDICT_DETECTORS`. Both of these
// builders read the park entry for its issue number, and a lane with no entry
// rendered the literal word undefined into a sentence somebody reads on a phone:
// "close #undefined". In production these are sent only while a lane IS parked, so
// this is the rare path rather than the common one, and that is exactly the kind
// that ships unexercised (L535). It names the registry instead, which is where the
// reader has to go either way.
//
// It stood on the failure rate lane until #2499 parked that one again, so it asks
// the time off check instead. The lane it names has to be one with NO entry, which
// the assertion below is what establishes: reading a registry that happens to hold
// the lane would compare "#undefined" against "#undefined", both sides going
// missing together (L70).
{
  const NOT_PARKED = OOO_PROTECTION_VERDICT_LANE;
  assert(parkedDetector(NOT_PARKED) === null, "the lane driven here really has no park entry");

  for (const text of [verdictUnparkAlertText(NOT_PARKED), verdictUnparkLapsedText(NOT_PARKED)]) {
    assert(!/undefined/.test(text), "no un-park copy renders the word undefined");
    assert(!/#\s*$|#\D/.test(text.replace(/#\d+/g, "")), "and leaves no bare hash where a number should be");
    assert(
      /PARKED_VERDICT_DETECTORS/.test(text),
      "it names the registry, which is where a reader goes whether or not an issue is recorded",
    );
    assert(!DASHES.test(text), "no dashes as punctuation");
  }

  // And when an entry DOES exist the issue number is still quoted, so this did not
  // quietly drop the pointer for the case that has one.
  const parkedLane = Object.keys(PARKED_VERDICT_DETECTORS)[0];
  if (parkedLane) {
    const entry = parkedDetector(parkedLane);
    assert(
      verdictUnparkAlertText(parkedLane).includes(`#${entry?.issue}`),
      "a parked lane's copy still names its issue",
    );
  }
}

// --- the below lead tier watch is armed (#2696) --------------------------------
//
// Parked by #2593 because no real lead had an upcoming booking to compare. The
// Low pilot went live on 2026-09-29 and the lane stamped a verdict on the monitor
// tick of 2026-09-30 18:33 UTC, which is the un-park page doing its job. Left
// parked, the check could go blind (an unreadable Salesforce, a broken bookings
// read) with nothing saying so, while the page it guards is armed and trusted.
{
  assert(
    parkedDetector(BELOW_LEAD_TIER_VERDICT_LANE) === null,
    "the below lead tier watch is armed now that real leads are booking",
  );
  assert(
    detectorParkState(BELOW_LEAD_TIER_VERDICT_LANE, null, 0) === "armed",
    "so a lane that never concluded is judged against its bound rather than kept quiet",
  );
}

// --- the debt tier alarm's verdict (#2505) ------------------------------------
//
// Both directions, because this is the detector most likely to sit blind: every
// debt tier is staffed today, so it ships having never fired, and only the
// ABSENCE of this stamp can tell a working alarm from a dead one.
assert(
  tierStaffingReachedVerdict({ measuredAny: true }),
  "a tick that judged at least one tier has concluded",
);
assert(
  !tierStaffingReachedVerdict({ measuredAny: false }),
  "a tick where every tier was unmeasured has NOT concluded, so it stamps nothing",
);
assert(
  !tierStaffingReachedVerdict(null),
  "a tick that skipped or threw has not concluded either",
);

// --- the served versus confirm check's verdict (#3381) ----------------------------
//
// Only a tick that JUDGED a served time concludes: an unreadable read, a tick whose
// every candidate read failed, and a tick with nothing served are all silent, and
// stamping them would let a check that never once held a served time against the
// confirm read as one that keeps finding them agree.
{
  const measured = (judged: number) => ({
    status: "measured" as const,
    judged,
    nobodyFree: 0,
    unreadable: judged === 0 ? 2 : 0,
    persisting: [],
    suspects: 0,
    paged: false,
    cleared: false,
  });
  assert(offeredNobodyFreeReachedVerdict(measured(1)), "a tick that judged a served time has concluded");
  assert(!offeredNobodyFreeReachedVerdict(measured(0)), "a tick that judged nothing has NOT concluded");
  assert(
    !offeredNobodyFreeReachedVerdict({ status: "unreadable", why: "could not read the pools" }),
    "an unreadable tick has not concluded",
  );
  assert(!offeredNobodyFreeReachedVerdict(null), "a tick that skipped or threw has not concluded either");
}

// --- the buffer breach check (#3040) ---------------------------------------------
{
  const measured = (examined: number, unassigned = 0) => ({
    status: "measured" as const,
    examined,
    unassigned,
    breaches: 0,
    forced: 0,
    breachPairs: [],
    forcedPairs: [],
  });
  assert(bufferBreachReachedVerdict(measured(1)), "a tick that judged a booking has concluded, breach or not");
  assert(!bufferBreachReachedVerdict(measured(0)), "a tick that read no bookings has NOT concluded");
  assert(
    !bufferBreachReachedVerdict(measured(3, 3)),
    "a tick whose every booking had no advisor judged no pair, so it has NOT concluded",
  );
  assert(!bufferBreachReachedVerdict(null), "a tick that skipped or threw has not concluded either");
}

// --- a lane outside the family is named as a code fault, never a crash (L11) ---------
// Every family lane has copy, which tsc enforces on VERDICT_SUBJECT's type. A string
// off the heartbeat table that is not in the family can only be a code fault, and the
// page about it must still render rather than throw inside the alert path.
{
  const text = verdictBlindAlertText({ lane: "verdict:nobody-declared", ageMs: 7 * HOUR, maxStaleMs: 6 * HOUR, unreadable: false });
  assert(/verdict:nobody-declared/.test(text), "an undeclared lane's blind page names the lane");
  assert(/code fault/.test(text), "and says it is a code fault");
  assert(!/undefined/.test(text), "and renders no undefined");
  assert(/verdict:nobody-declared/.test(verdictRecoveryText("verdict:nobody-declared")), "its all clear names the lane too");
}
// --- the audit chain walk (#3090) ------------------------------------------------
// Every tick that read and judged rows concludes, including one part way through a
// walk; only an unmeasured tick or a thrown step does not.
assert(auditChainReachedVerdict({ status: "progressing", checked: 500, passSeq: 500 }), "an audit chain tick part way through a walk has concluded");
assert(auditChainReachedVerdict({ status: "intact", checked: 12, throughSeq: 4012 }), "a complete walk has concluded");
assert(
  auditChainReachedVerdict({ status: "broken", break: { kind: "altered", seq: 3, id: "x" }, checked: 2 }),
  "a walk that met a break has concluded",
);
assert(!auditChainReachedVerdict({ status: "unmeasured", why: "read refused" }), "an unmeasured audit chain tick has NOT concluded");
assert(!auditChainReachedVerdict(null), "nor has an audit chain step that threw");

finish();
