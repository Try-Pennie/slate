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
  readShiftLog,
} from "./lib/clock-shift-report.ts";
import { collectVerdicts, run } from "./notify-clock-shift.ts";
import { discoverSuiteNames } from "./lib/suite-discovery.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPTS = resolve(import.meta.dirname);

const green = (n: number, clock: string) =>
  `Slowest: scripts/test-a.ts 900ms\nPASS: ${n} passed, 0 failed in 12.16s (concurrency 14, clock ${clock})\n`;
const red = (pass: number, fail: number, clock: string, names: string[]) =>
  `=== FAILED: ${names[0]} (exit 1) ===\nFAIL: a fixture went stale\n` +
  `FAIL: ${pass} passed, ${fail} failed in 12.16s (concurrency 14, clock ${clock})\n` +
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
