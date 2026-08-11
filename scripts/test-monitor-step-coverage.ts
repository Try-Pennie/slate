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
import { readFileSync } from "node:fs";
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

// --- the cost line is actually emitted, or #1277 is unwired ---
{
  assert(
    /log\.info\("monitor",\s*\{\s*msg:\s*"cycle",\s*\.\.\.steps\.fields\(\)/.test(code),
    "the tick logs every step's own cost, so a slow lane can be attributed rather than guessed at",
  );
}

finish();
