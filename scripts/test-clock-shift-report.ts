// What the shifted test run SAYS, pinned offline (#2503).
//
// The run itself needs a runner and three passes of the whole suite, so the thing
// that decides what it means is tested here instead, through hand written logs with
// no network, no clock and no child process. Three outcomes have to stay apart:
// agreement, a suite that depends on what day it is, and a run that measured
// nothing. The third is the one that would otherwise pass as the first, which is
// the whole reason a shifted run exists rather than a hope that somebody remembers
// to try one (L98, L11).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-clock-shift-report.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decideClockShiftReport,
  expectedSuiteCount,
  judgeShift,
  readShiftLog,
  readShiftOutcome,
} from "./lib/clock-shift-report.ts";
import { collectVerdicts, run } from "./notify-clock-shift.ts";
import { discoverSuiteNames } from "./lib/suite-discovery.ts";
import { formatRunSummary } from "./lib/run-summary.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPTS = resolve(import.meta.dirname);

// The summary lines come from the SAME function the runner prints with (#2813), so
// a field the runner adds reaches these fixtures the day it ships. Hand typed lines
// stopped at the clock and stayed green for weeks after the runner stopped doing so.
const summary = (passed: number, failed: number, clock: string, tripwire = "on") =>
  formatRunSummary({ passed, failed, wallMs: 12160, concurrency: 14, clock, tripwire });
const green = (n: number, clock: string) =>
  `Slowest: scripts/test-a.ts 900ms\nPASS: ${summary(n, 0, clock)}\n`;
const red = (pass: number, fail: number, clock: string, names: string[]) =>
  `=== FAILED: ${names[0]} (exit 1) ===\nFAIL: a fixture went stale\n` +
  `FAIL: ${summary(pass, fail, clock)}\n` +
  `Failed: ${names.join(", ")}\n`;

// --- reading one shift's log ---------------------------------------------------
{
  eq(readShiftLog("+1d", green(499, "+1d"), 499).state, "agreed", "a full clean run agrees");
  eq(readShiftLog("+1d", green(499, "+1d"), 499).executed, 499, "and says how many suites it ran");

  const finding = readShiftLog("+1d", red(497, 2, "+1d", ["scripts/test-x.ts", "scripts/test-y.ts"]), 499);
  eq(finding.state, "date-dependent", "a failure under the shift is a date dependent suite");
  eq(finding.failed.join(","), "scripts/test-x.ts,scripts/test-y.ts", "and it names them");

  // The three ways a run measures nothing, each separate, because a reader sent to
  // look at a stale fixture when the shift never applied has been sent to the wrong
  // problem (L11).
  const noSummary = readShiftLog("+1d", "install failed\n", 499);
  eq(noSummary.state, "unmeasured", "a run that left no summary measured nothing");

  const noClock = readShiftLog(
    "+1d",
    "PASS: 499 passed, 0 failed in 12.16s (concurrency 14)\n",
    499,
  );
  eq(noClock.state, "unmeasured", "a run reporting no clock at all measured nothing");
  assert(
    /ran on today's date/.test(noClock.why),
    `and says the shift never applied (${noClock.why})`,
  );

  const wrongClock = readShiftLog("+13mo", green(499, "+1d"), 499);
  eq(wrongClock.state, "unmeasured", "a run on a different clock than the one asked for");

  const short = readShiftLog("+1d", green(12, "+1d"), 499);
  eq(short.state, "unmeasured", "a run covering fewer suites than the checkout holds");
  assert(/12 suites/.test(short.why), `and says how short it fell (${short.why})`);

  // The REAL line, as the runner has written it since the tree write tripwire
  // (#2733) added a field after the clock (#2813). The fixtures above end at the
  // clock, which is why every one of them stayed green while the nightly run read
  // `+1d, tripwire on` as the clock and reported every shift unmeasured.
  const withTrip = readShiftLog(
    "+1d",
    "PASS: 300 passed, 0 failed in 12.34s (concurrency 4, clock +1d, tripwire on)\n",
    300,
  );
  eq(withTrip.state, "agreed", `a later field does not join the clock (${withTrip.why})`);
  const tripOff = readShiftLog(
    "+1d",
    "PASS: 300 passed, 0 failed in 12.34s (concurrency 4, clock +1d, tripwire off)\n",
    300,
  );
  eq(tripOff.state, "agreed", `nor does it when the tripwire is off (${tripOff.why})`);
  const redTrip = readShiftLog(
    "+1d",
    "FAIL: 298 passed, 2 failed in 12.34s (concurrency 4, clock +1d, tripwire on)\n" +
      "Failed: scripts/test-x.ts, scripts/test-y.ts\n",
    300,
  );
  eq(redTrip.state, "date-dependent", "a failure with the tripwire field is still a finding");
  const noClockTrip = readShiftLog(
    "+1d",
    "PASS: 300 passed, 0 failed in 12.34s (concurrency 4, tripwire on)\n",
    300,
  );
  eq(noClockTrip.state, "unmeasured", "a tripwire field with no clock measured nothing");
  assert(
    /reported no clock at all/.test(noClockTrip.why),
    `and says no clock was reported, not that the summary is missing (${noClockTrip.why})`,
  );
  const wrongClockTrip = readShiftLog(
    "+13mo",
    "PASS: 300 passed, 0 failed in 12.34s (concurrency 4, clock +1d, tripwire on)\n",
    300,
  );
  eq(wrongClockTrip.state, "unmeasured", "a wrong clock beside the tripwire field is refused");
  assert(
    /reported \+1d\.$/.test(wrongClockTrip.why),
    `and names the clock alone, without the field after it (${wrongClockTrip.why})`,
  );

  // Every shape the runner can print, built by the runner's own formatter: each
  // tripwire state, with and without a clock. A clock present must agree, a clock
  // absent must be refused as no clock (never as a missing summary).
  for (const tripwire of ["on", "off"]) {
    const shifted = readShiftLog("+1d", `PASS: ${summary(300, 0, "+1d", tripwire)}\n`, 300);
    eq(shifted.state, "agreed", `the runner's own line agrees, tripwire ${tripwire} (${shifted.why})`);
    const plain = readShiftLog("+1d", `PASS: ${summary(300, 0, "", tripwire)}\n`, 300);
    assert(
      plain.state === "unmeasured" && /reported no clock at all/.test(plain.why),
      `the runner's own unshifted line reads as no clock, tripwire ${tripwire} (${plain.why})`,
    );
  }

  // No two of them explain themselves the same way.
  const reasons = [noSummary, noClock, wrongClock, short].map((v) => v.why);
  eq(new Set(reasons).size, reasons.length, "each unmeasured run gives its own reason");
}

// --- the decision across every shift -------------------------------------------
{
  const all = ["+1d", "+3mo", "+13mo"];
  const clean = all.map((s) => readShiftLog(s, green(499, s), 499));

  const agreed = decideClockShiftReport(all, clean, "https://example.test/run/1");
  eq(agreed.alert, null, "three clean shifts say nothing");
  assert(agreed.ok, "and the job stays green");
  assert(/499 suites/.test(agreed.detail), `and the log says what was covered (${agreed.detail})`);

  // A shift whose step produced no log at all. This is the one a shorter list would
  // swallow: two shifts agreeing is not three shifts agreeing.
  const dropped = decideClockShiftReport(all, clean.slice(0, 2), "https://example.test/run/2");
  assert(dropped.alert !== null, "a shift that produced no log at all is reported");
  assert(!dropped.ok, "and the job goes red");
  assert(/\+13mo/.test(dropped.alert ?? ""), "naming the shift that never ran");

  const finding = decideClockShiftReport(
    all,
    [
      clean[0]!,
      readShiftLog("+3mo", red(498, 1, "+3mo", ["scripts/test-booking-reminder.ts"]), 499),
      clean[2]!,
    ],
    "https://example.test/run/3",
  );
  assert(!finding.ok, "a date dependent suite fails the run");
  assert(
    /scripts\/test-booking-reminder\.ts/.test(finding.alert ?? ""),
    "and the message names the suite",
  );
  assert(
    /\+3mo/.test(finding.alert ?? ""),
    "and the shift that found it, so it can be reproduced locally",
  );
  assert(
    /https:\/\/example\.test\/run\/3/.test(finding.alert ?? ""),
    "and where the run is",
  );

  // Asking for nothing is not agreement.
  const nothing = decideClockShiftReport([], [], "");
  assert(!nothing.ok, "a run that asked for no shifts is not a pass");

  // The copy rules apply: these land in Slack like any other alert.
  const texts = [dropped.alert, finding.alert, nothing.alert].filter(
    (t): t is string => t !== null,
  );
  for (const text of texts) {
    // Compared by code point so this file holds no literal dash for the copy lint
    // to catch: it cannot tell a line banning the character from one using it.
    assert(
      ![...text].some((c) => c.charCodeAt(0) === 0x2014 || c.charCodeAt(0) === 0x2013),
      `no em or en dash in ${JSON.stringify(text.slice(0, 60))}`,
    );
    assert(!/^\s*Slate\b/i.test(text), "does not open with the word Slate");
    assert(!/undefined|NaN|\[object Object\]/.test(text), "renders no placeholder leak");
  }
}

// --- how a pass ended, when its own log cannot say (#3960) -----------------------
//
// On 2026-10-20 the +13mo pass was cut off by the job's time limit and the alert
// said it "died before the suite finished. Read the step's output", where the step
// had printed nothing. Each shift is its own job now, and each job leaves a small
// marker saying how its pass ended, so a pass stopped by the clock says so.
{
  const partial = "Slowest: scripts/test-a.ts 900ms\n";
  const marker = (lines: string[]) => readShiftOutcome(lines.join("\n") + "\n");

  const cutMarker = marker(["exit=124", "seconds=1080", "step=success", "limit_minutes=18"]);
  eq(cutMarker.exit, 124, "the marker gives the suite's exit code");
  eq(cutMarker.seconds, 1080, "and how long the pass ran");
  eq(cutMarker.limitMinutes, 18, "and the pass's own time limit");
  eq(cutMarker.step, "success", "and how GitHub says the step ended");

  const unreadable = marker(["exit=abc", "seconds=", "limit_minutes=NaN"]);
  eq(unreadable.exit, null, "an unreadable exit code is null, never NaN (L50)");
  eq(unreadable.seconds, null, "and so is an empty duration");
  eq(unreadable.limitMinutes, null, "and an unreadable limit");
  eq(unreadable.step, "", "and a marker naming no step reads as an unknown step");

  const cut = judgeShift("+13mo", partial, cutMarker, 499);
  eq(cut.state, "unmeasured", "a pass stopped by its time limit measured nothing");
  assert(/18 minute time limit/.test(cut.why), `and says it hit its time limit (${cut.why})`);
  assert(!/died before/.test(cut.why), `rather than that it died (${cut.why})`);
  assert(/\+13mo job's log/.test(cut.why), `and says where its partial log is (${cut.why})`);

  // timeout's KILL after the grace exits 137 rather than 124. Past the limit that is
  // the same finding; well inside it, something else killed the pass, and blaming
  // the clock would send somebody to raise a limit nothing reached.
  const killedLate = judgeShift(
    "+13mo",
    partial,
    marker(["exit=137", "seconds=1110", "step=success", "limit_minutes=18"]),
    499,
  );
  assert(/time limit/.test(killedLate.why), `a kill after the limit is the limit (${killedLate.why})`);
  const killedEarly = judgeShift(
    "+13mo",
    partial,
    marker(["exit=137", "seconds=200", "step=success", "limit_minutes=18"]),
    499,
  );
  assert(!/time limit/.test(killedEarly.why), `a kill inside the limit is not blamed on it (${killedEarly.why})`);
  assert(/no summary line/.test(killedEarly.why), `and reads as a pass that died (${killedEarly.why})`);
  assert(/\+13mo job's log/.test(killedEarly.why), `pointing at that job's log (${killedEarly.why})`);

  const cancelled = judgeShift("+13mo", partial, marker(["step=cancelled", "limit_minutes=18"]), 499);
  eq(cancelled.state, "unmeasured", "a cancelled pass measured nothing");
  assert(/cancelled/.test(cancelled.why), `and says it was cancelled (${cancelled.why})`);
  assert(/\+13mo job's log/.test(cancelled.why), `and where its partial log is (${cancelled.why})`);

  const skipped = judgeShift("+3mo", null, marker(["step=skipped", "limit_minutes=18"]), 499);
  eq(skipped.state, "unmeasured", "a job that never reached the suite measured nothing");
  assert(/before the suite started/.test(skipped.why), `and says the suite never started (${skipped.why})`);

  const nothing = judgeShift("+1d", null, null, 499);
  eq(nothing.state, "unmeasured", "a shift with no log and no marker measured nothing");
  assert(/never reached the report/.test(nothing.why), `and says nothing arrived (${nothing.why})`);

  // A pass that printed its summary finished the suite, whatever the marker says
  // about the moments after it: the summary is the verdict.
  const finished = judgeShift("+1d", green(499, "+1d"), cutMarker, 499);
  eq(finished.state, "agreed", "a pass that printed its summary is judged by it");
  const finding = judgeShift(
    "+1d",
    red(498, 1, "+1d", ["scripts/test-x.ts"]),
    marker(["exit=1", "seconds=530", "step=success", "limit_minutes=18"]),
    499,
  );
  eq(finding.state, "date-dependent", "and a failure under the shift is still a finding");

  const reasons = [cut, killedEarly, cancelled, skipped, nothing].map((v) => v.why);
  eq(new Set(reasons).size, reasons.length, "each way a pass ends early gives its own reason");

  // The 2026-10-20 shape end to end: two passes agree, the third is cut off.
  const all = ["+1d", "+3mo", "+13mo"];
  const decision = decideClockShiftReport(
    all,
    [judgeShift("+1d", green(499, "+1d"), null, 499), judgeShift("+3mo", green(499, "+3mo"), null, 499), cut],
    "https://example.test/run/4",
  );
  assert(!decision.ok, "a cut off pass fails the run");
  const text = decision.alert ?? "";
  assert(/\+13mo/.test(text) && /time limit/.test(text), `and the alert says which pass hit the limit (${text})`);
  assert(!/died before/.test(text), "without saying it died");
  assert(
    ![...text].some((c) => c.charCodeAt(0) === 0x2014 || c.charCodeAt(0) === 0x2013),
    "with no em or en dash",
  );
  for (const v of [cut, killedEarly, cancelled, skipped, nothing]) {
    assert(!/undefined|NaN|null|\[object Object\]/.test(v.why), `renders no placeholder (${v.why})`);
  }
}

// --- the expected count comes from the checkout --------------------------------
{
  const real = expectedSuiteCount(SCRIPTS);
  eq(real, discoverSuiteNames(SCRIPTS).length, "the floor is the suite the runner would discover");
  assert(real > 400, `and it is the real tree rather than an empty read (${real} suites)`);
  assert(
    discoverSuiteNames(SCRIPTS).includes("test-clock-shift.ts"),
    "which includes this change's own suites",
  );
}

// --- the notifier's own wiring, with a fake Slack -------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "slate-clock-report-"));
  try {
    const all = ["+1d", "+3mo"];
    for (const spec of all) writeFileSync(join(dir, `${spec}.log`), green(499, spec), "utf8");

    const verdicts = collectVerdicts(dir, all, 499);
    eq(verdicts.length, 2, "a log is found by the shift it is named for");
    eq(verdicts.every((v) => v.state === "agreed"), true, "and read as agreement");

    const posted: string[] = [];
    const post = async (msg: { text: string }) => {
      posted.push(msg.text);
      return { ok: true };
    };

    const quiet = await run(post, { CLOCK_SHIFTS: all.join(" ") }, { dir, scriptsDir: SCRIPTS });
    // The real checkout holds more suites than these logs claim, so this ALSO
    // proves the floor is read from the tree rather than from the log: were it
    // taken from the log the run would agree with itself.
    assert(!quiet.ok, "a log claiming fewer suites than the checkout holds is refused");
    eq(posted.length, 1, "and somebody is told");

    posted.length = 0;
    const real = expectedSuiteCount(SCRIPTS);
    for (const spec of all) writeFileSync(join(dir, `${spec}.log`), green(real, spec), "utf8");
    const ok = await run(post, { CLOCK_SHIFTS: all.join(" ") }, { dir, scriptsDir: SCRIPTS });
    assert(ok.ok, "a run covering the whole suite on both shifts passes");
    eq(posted.length, 0, "and says nothing, because an all is well every day stops being read");

    // Slack refusing is its own red: an unsent alert is not evidence the suite is
    // date independent (L53, two checks must never share one status).
    posted.length = 0;
    writeFileSync(join(dir, "+1d.log"), red(real - 1, 1, "+1d", ["scripts/test-z.ts"]), "utf8");
    const unsent = await run(
      async () => ({ ok: false, error: "channel_not_found" }),
      { CLOCK_SHIFTS: all.join(" ") },
      { dir, scriptsDir: SCRIPTS },
    );
    assert(!unsent.ok, "a finding whose alert could not be posted is still red");
    assert(/channel_not_found/.test(unsent.reason), "and says Slack was the reason");

    // The fan in reads each job's marker beside its log (#3960): a partial log with
    // a marker saying the pass hit its limit is reported as cut off, and a shift
    // whose job left nothing at all is still named rather than dropped.
    posted.length = 0;
    const three = ["+1d", "+3mo", "+13mo"];
    writeFileSync(join(dir, "+1d.log"), green(real, "+1d"), "utf8");
    writeFileSync(join(dir, "+3mo.log"), "Slowest: scripts/test-a.ts 900ms\n", "utf8");
    writeFileSync(
      join(dir, "+3mo.outcome"),
      "exit=124\nseconds=1080\nstep=success\nlimit_minutes=18\n",
      "utf8",
    );
    const fannedIn = collectVerdicts(dir, three, real);
    eq(fannedIn.map((v) => v.spec).join(" "), "+1d +3mo +13mo", "every shift asked for gets a verdict");
    eq(fannedIn[0]?.state, "agreed", "the finished pass agrees");
    assert(/time limit/.test(fannedIn[1]?.why ?? ""), `the cut off pass says so (${fannedIn[1]?.why})`);
    assert(
      /never reached the report/.test(fannedIn[2]?.why ?? ""),
      `the shift whose job left nothing is named (${fannedIn[2]?.why})`,
    );
    const cutRun = await run(post, { CLOCK_SHIFTS: three.join(" ") }, { dir, scriptsDir: SCRIPTS });
    assert(!cutRun.ok, "a run with a cut off pass is red");
    eq(posted.length, 1, "and somebody is told");
    assert(/\+3mo run measured nothing: it hit its 18 minute time limit/.test(posted[0] ?? ""), `once (${posted[0]})`);

    // A directory that is not there at all is a missing verdict per shift, never an
    // empty list read as nothing to report.
    const none = collectVerdicts(join(dir, "gone"), all, real);
    eq(none.length, 0, "an absent log directory yields no verdicts");
    assert(
      !decideClockShiftReport(all, none, "").ok,
      "which the decision reports rather than passing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

finish();
