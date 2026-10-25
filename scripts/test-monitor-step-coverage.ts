// Every check on the monitor lane runs inside its own boundary (#1281). Run:
//   node --experimental-strip-types scripts/test-monitor-step-coverage.ts
//
// The defect this guards is not a wrong value, it is an OMISSION: a new check
// added straight into the handler runs unguarded, and its first unexpected throw
// silently skips every check below it. That is invisible in review, because an
// unguarded call is the shorter and more natural thing to write.
//
// Derived from the FILE, not from a list of step names (L96). A hand-written
// registry can only check the entries someone remembered to add, and the entry
// that is missing is exactly the one that needed checking. So this reads every
// check invocation in the route and requires each to be wrapped, which means a
// step nobody thought about is covered by construction.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";

const FILE = "src/app/api/cron/monitor/route.ts";
const src = readFileSync(FILE, "utf8");

/** Comments stripped, so a guard can never be satisfied by prose ABOUT a call,
 *  including a comment explaining that one was removed (L103). */
const code = src
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");

// --- every awaited check goes through the runner ---
//
// The shape after wrapping: `await steps.run("name", fallback, () =>` on one
// line, and the check's own call on the NEXT line with no `await`. So an awaited
// call to a `runSomething` / `alertSomething` helper that does NOT sit on a
// steps.run line is an unwrapped step.
{
  const offenders: string[] = [];
  code.split("\n").forEach((line, i) => {
    const callsCheck = /await\s+(run[A-Z]\w*|alertOn[A-Z]\w*)\s*\(/.test(line);
    if (callsCheck && !/steps\.run\s*[<(]/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  eq(
    offenders,
    [],
    "every check on the monitor lane is awaited inside steps.run, so one failing check cannot skip the rest",
  );
}

// --- positive control: the guard still catches the thing it exists to catch ---
{
  // Without this, the assertion above passes just as happily on a file where the
  // pattern was renamed and nothing matches any more (L1).
  const sabotaged = `${code}\n    const sneaky = await runSomeNewCheck({ a: 1 });\n`;
  const offenders = sabotaged
    .split("\n")
    .filter((line) => /await\s+(run[A-Z]\w*|alertOn[A-Z]\w*)\s*\(/.test(line) && !/steps\.run\s*[<(]/.test(line));
  eq(offenders.length, 1, "a check added straight into the handler IS caught");
}

// --- the steps are really there, and each is named once ---
{
  const names = [...code.matchAll(/steps\.run\s*(?:<[^>]*>)?\s*\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
  assert(names.length >= 13, `every documented check is a step (found ${names.length})`);
  eq(
    names.length,
    new Set(names).size,
    `no two steps share a name, or their timings would be summed into one and the measurement would quietly stop meaning what it says (${names.join(", ")})`,
  );
  // The checks the issue named as at risk, each of which exists to catch a
  // customer-visible problem and was previously skippable by an unrelated throw.
  for (const required of ["avail_scan", "avail_truth", "override_sweep", "migration_drift"]) {
    assert(names.includes(required), `${required} runs inside its own boundary`);
  }
}


// --- the SHARED SETUP reads are contained too (#1395) -------------------------
//
// #1281 covered the checks. The reads at the TOP of the handler stayed outside
// every boundary, so a throw in one ended the tick before a single check ran,
// which took out the availability probe and the cal.com override sweep, neither of
// which needs most of those reads.
//
// Derived from the FILE like everything else here: any handler-level `const x =
// await ...` in the try block is a shared read, and it has to be contained. A
// sixth one added later is covered by construction rather than by someone
// remembering this issue.
{
  // Exactly four spaces of indent puts a statement directly in the handler's try
  // block; a read inside an injected callback is nested deeper.
  const HANDLER_AWAIT = /^ {4}const\s+[A-Za-z_$][\w$]*\s*=\s*await\s/;
  // `loadMonitorSettings` is NOT exempt any more (#2773). It used to swallow its
  // own failures into the defaults, which disarmed every switch for the tick; it
  // throws now and is contained like every other setup read.
  // #2382: the step-failure judgement is the one thing here that must NOT be
  // contained, because it is what reports the runner's failures. Putting the
  // reporter behind the fault it reports is the defect one level up, and the
  // assertions below pin that it stays outside the runner and ahead of the
  // heartbeat.
  const EXEMPT = ["judgeMonitorSteps("];
  const offenders: string[] = [];
  code.split("\n").forEach((line, i) => {
    if (!HANDLER_AWAIT.test(line)) return;
    if (/steps\.run\s*[<(]/.test(line)) return;
    if (EXEMPT.some((e) => line.includes(e))) return;
    offenders.push(`${i + 1}: ${line.trim()}`);
  });
  eq(
    offenders,
    [],
    "every shared setup read at the top of the handler runs inside its own boundary, so one " +
      "unreadable input cannot end the tick before any check runs",
  );
}

// Positive control for the same rule, or a renamed pattern would leave it green
// over an unguarded read (L1).
{
  const sabotaged = `${code}\n    const horizon = await loadBookingHorizonDays();\n`;
  const offenders = sabotaged
    .split("\n")
    .filter(
      (line) =>
        /^ {4}const\s+[A-Za-z_$][\w$]*\s*=\s*await\s/.test(line) &&
        !/steps\.run\s*[<(]/.test(line) &&
        !line.includes("judgeMonitorSteps("),
    );
  eq(offenders.length, 1, "a shared read added straight into the handler IS caught");
}

// --- the contained failures are REPORTED, not only logged (#2382) -------------
//
// Containment without a replacement signal is what #1281 shipped: a step that
// threw on every tick was caught, named in a seven day log nobody is paged from,
// and the lane heartbeat was stamped fresh anyway. The exemption above is only
// safe while all three of these hold, so they are asserted here rather than left
// as an unexplained gap (L129).
{
  assert(
    /judgeMonitorSteps\s*\(\s*steps\.outcomes\(\)/.test(code),
    "the tick judges the runner's OWN outcomes, so a step nobody thought about is covered by construction",
  );
  const judgeAt = code.indexOf("judgeMonitorSteps(");
  const heartbeatAt = code.indexOf('recordHeartbeat("monitor")');
  assert(judgeAt >= 0 && heartbeatAt >= 0, "both the judgement and the heartbeat stamp are present");
  assert(
    judgeAt < heartbeatAt,
    "the judgement runs BEFORE the lane stamps its heartbeat, so a fault nobody predicted inside " +
      "the reporter lapses the stamp and pages, exactly as an uncontained throw did before #1281",
  );
  // Inside no step. A `steps.run(` between the judgement and the end of its own
  // statement would mean the reporter is contained by the runner it reports on.
  const judgeStatement = code.slice(judgeAt, heartbeatAt);
  assert(
    !/steps\.run\s*[<(]/.test(judgeStatement),
    "the step-failure judgement is not itself a contained step, or its own failure would be " +
      "swallowed by the very containment it exists to report",
  );
  assert(
    /stepFailingAlertKey\s*\(/.test(code) && /resolveRecovered\s*\(/.test(code),
    "a failing step pages on its own key and the condition has a way to end",
  );
}

// --- and a contained read's failure must GATE its dependents ------------------
// Containment alone is not enough: a read whose failure resolves to a default that
// a check then judges on is worse than the throw it replaced, because the check
// answers confidently instead of skipping. So the gate has to be consulted.
{
  assert(
    /monitorSetupGates\(/.test(code),
    "the handler asks which checks its setup reads entitle it to run",
  );
  // Inside the step, not merely somewhere in the file. A mention in a log line
  // would satisfy `includes` while the check itself still branched on a
  // hand-rolled condition, which is a guard passing on prose about itself (L103).
  for (const [step, gate] of [
    ["avail_scan", "gates.availabilityScan.run"],
    ["avail_truth", "gates.availabilityTruth.run"],
    ["calendar_window", "gates.calendarWindow.run"],
    ["busy_drift", "gates.busyDrift.run"],
    // #2773: the checks whose decision to page is an armed switch.
    ["roster_coverage", "gates.rosterCoverage.run"],
    ["failure_rate", "gates.failureRate.run"],
    ["awaiting_activation", "gates.awaitingActivation.run"],
    ["below_lead_tier", "gates.belowLeadTier.run"],
    ["regal_calls", "gates.regalCalls.run"],
    ["regal_calls_quiet", "gates.regalCallsQuiet.run"],
    ["regal_calls_unreadable", "gates.regalCallsUnreadable.run"],
    // #2944: the call outcome ratio, on the same Regal arming switch.
    ["regal_call_outcomes", "gates.regalCallOutcomes.run"],
    // #3040: the calls inside an advisor's buffer, judged over the horizon.
    ["buffer_breach", "gates.bufferBreach.run"],
  ]) {
    // Indexed off the step NAME rather than the `steps.run` token, because a call
    // carrying a type argument puts the two on different lines.
    const at = code.indexOf(`"${step}"`);
    assert(at >= 0, `${step} is a named step`);
    // The gate is the step body's first decision, so it sits close behind the name.
    // Wide enough for a multi-line runner call plus a comment, narrow enough that a
    // mention further down the check's own wiring cannot satisfy it.
    const body = code.slice(at, at + 400);
    assert(
      body.includes(gate),
      `${step} decides whether to run by consulting ${gate}, not a hand-rolled condition`,
    );
  }
}

// --- and a shut gate is answered as UNMEASURED, never as a healthy run (#3955) --
// A step that consults its gate INSIDE its boundary still appears in the tick's
// outcomes when the gate is shut. Returned plainly, that tick read as the step
// working: four of them all cleared a standing `monitor_step_failing` page saying
// "it is being checked once more" about a check that was not running (L792). So the
// shut branch must go through `step.unmeasured`, which the step failure judgement
// counts in neither direction. Derived from the FILE: every step whose opening
// consults a gate is held to it, so a new gated step is covered by construction (L96).
{
  const shutGatesUnanswered = (text: string): { gated: string[]; offenders: string[] } => {
    const gated: string[] = [];
    const offenders: string[] = [];
    for (let at = text.indexOf("steps.run"); at >= 0; at = text.indexOf("steps.run", at + 1)) {
      // The name is the first argument, past any type argument (whose own string
      // literals, `{ status: "errored" }`, are not names).
      const named = /^steps\.run\s*(?:<[\s\S]*?>\s*)?\(\s*"([a-z_]+)"/.exec(text.slice(at, at + 300));
      if (!named) continue;
      const nameAt = at + named[0].length - named[1].length - 1;
      // The gate is the body's first decision, so it sits close behind the name (as
      // above), and the window stops at the next step so it can never read that one's.
      const next = text.indexOf("steps.run", at + 1);
      const opening = text.slice(nameAt, Math.min(nameAt + 500, next < 0 ? text.length : next));
      if (!/!gates\.\w+\.run/.test(opening)) continue;
      gated.push(named[1]);
      if (!/unmeasured\(/.test(opening)) offenders.push(named[1]);
    }
    return { gated, offenders };
  };
  const { gated, offenders } = shutGatesUnanswered(code);
  eq(offenders, [], "every gated step answers its shut gate as unmeasured, so a skipped tick never reads as a healthy one");
  assert(
    gated.length >= 15,
    `the scan found the gated steps it exists to hold (found ${gated.length}: ${gated.join(", ")})`,
  );
  // Positive control: a gated step written the old way IS caught (L1).
  const sabotaged =
    `${code}\n    const x = await steps.run("new_gated_check", null, async () =>\n      !gates.newCheck.run\n        ? null\n        : runNewCheck({}),\n    );\n`;
  eq(
    shutGatesUnanswered(sabotaged).offenders,
    ["new_gated_check"],
    "a gated step whose shut branch returns a plain value IS caught",
  );
}

// --- the settings read is contained, and falls back to the LAST KNOWN value (#2773)
// A failed settings read used to resolve to the defaults inside the loader, and
// every armed switch defaults to OFF, so one failure disarmed half the lane with
// nothing saying so. The read throws now; here it must run in its own setup step
// (so a sustained failure pages through the step streak), fall back to what this
// isolate last read rather than to the defaults, and be the ONLY settings read on
// the lane, so no check can reach round it to a copy that still falls back.
{
  assert(
    /steps\.run<[^\n]*>\(\s*"setup_settings",\s*lastKnownMonitorSettings\(\),\s*\(\)\s*=>\s*loadMonitorSettings\(\)/.test(code),
    "the settings read runs in the setup_settings step with the last known settings as its fallback",
  );
  eq(
    (code.match(/loadMonitorSettings\(/g) ?? []).length,
    1,
    "the lane reads the settings exactly once, inside that step",
  );
  assert(
    !/settings\.cooldownMs/.test(code),
    "cooldowns come from the one resolved `cooldownMs`, never off a settings value that may be null",
  );
}

// --- and nothing else calls the throwing read unprotected (#2773) ------------
// `loadMonitorSettings` throws now. A lane that needs only a cooldown and called it
// at the top of its handler would be taken down by a settings blip, which is worse
// than the defect being fixed: the work the alarm is about would stop. Those lanes
// use `loadMonitorCooldowns`, which never throws. Walked from `src/`, so a new
// caller is covered by construction rather than by somebody remembering (L96).
{
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  const callers = walk(fileURLToPath(new URL("../src", import.meta.url)))
    .filter((f) => /loadMonitorSettings\(/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(f.indexOf("/src/") + 1))
    .sort();
  eq(
    callers,
    ["src/app/api/cron/monitor/route.ts", "src/lib/monitor/settings.ts"],
    "only the monitor lane (inside its setup step) and the settings module call the throwing read",
  );
}

// --- the cost line is actually emitted, or #1277 is unwired ---
{
  assert(
    /log\.info\("monitor",\s*\{\s*msg:\s*"cycle",\s*\.\.\.steps\.fields\(\)/.test(code),
    "the tick logs every step's own cost, so a slow lane can be attributed rather than guessed at",
  );
}

finish();
