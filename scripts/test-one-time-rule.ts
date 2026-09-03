// One time rule, in one module, and no component may carry its own (#1765).
//
// Slate had two time pickers. Each held its own `pad`, its own character for
// character copy of `to24`, and its own quarter hour snapping, and the snapping
// DISAGREED: the time off form rounded a minute in isolation, so `ceil(50 / 15)`
// gave 60, which is not a minute, and it answered 45 with the hour left alone. A
// typed 5:50pm END became 5:45pm, fourteen minutes shorter than asked for, in the
// one direction its own comment said rounding must never take.
//
// Nothing caught it because each implementation was tested against itself. Two
// spellings of one rule, each locally consistent, is why the disagreement
// survived, and it is why this guard is about the CODE rather than about the
// answers: a second implementation is the defect, whether or not it currently
// agrees.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-one-time-rule.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { scanTimeRules } from "./lib/scan-time-rules.ts";
import { assert, fail, finish } from "./lib/harness.ts";

/** The one module allowed to hold these rules. */
const HOME = "src/lib/date/parse.ts";

/**
 * Components only, which is exactly what the issue asks and no more. The server's
 * own defensive snap in `src/app/admin/actions.ts` is a different concern with a
 * different reason (a value arriving from outside a form), and pulling it in here
 * would make this guard an argument rather than a rule.
 */
function componentFiles(): string[] {
  // The env is scrubbed because the pre-push hook exports GIT_DIR and friends, and
  // an inherited GIT_DIR makes this read the real repo rather than its own cwd
  // (#848/#853). scripts/test-git-env-isolation.ts enforces it.
  return execFileSync("git", ["ls-files", "src/components"], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}


// --- the components ---
{
  const offenders = componentFiles().flatMap((f) => scanTimeRules(f, readFileSync(f, "utf8")));
  if (offenders.length === 0) {
    assert(true, "no component carries its own time conversion, snapping, padding or spelling");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} ${o.why}`);
  }
}

// --- the home module really does export what everything else must import ---
{
  const home = readFileSync(HOME, "utf8");
  for (const name of [
    "padTwo",
    "timeFrom12Hour",
    "twelveHourParts",
    "snapTimeOfDay",
    "formatTimeOfDay",
    "formatClockTime",
    "resolveTypedTime",
    "roundUpToQuarterHour",
    "roundDownToQuarterHour",
  ]) {
    assert(
      new RegExp(`export (?:function|const) ${name}\\b`).test(home),
      `${HOME} exports ${name}, so a component never needs its own`,
    );
  }
  // `snapTimeOfDay` must round the whole TIME. A rule that takes a bare minute is
  // the defect, whatever it is called.
  assert(
    /export function snapTimeOfDay\(\s*hhmm: string/.test(home),
    "snapTimeOfDay takes a time, not a minute: rounding a minute in isolation is the bug",
  );
}

// --- positive controls: the exact shapes the tree carried ---
{
  const caught = (code: string, what: string) => {
    assert(scanTimeRules("fixture.tsx", code).length > 0, `caught: ${what}`);
  };
  const allowed = (code: string, what: string) => {
    const hits = scanTimeRules("fixture.tsx", code);
    assert(hits.length === 0, `allowed: ${what}${hits.length ? ` (wrongly flagged: ${hits[0].why})` : ""}`);
  };

  caught('function to24(hour12: number, minute: number, ampm: "AM" | "PM"): string {', "a second to24");
  caught("function from24(hhmm: string) {", "a second from24");
  caught('const pad = (n: number) => String(n).padStart(2, "0");', "a local pad");
  caught("function snapMinute(m: number, dir: string) {", "a second snapMinute");
  caught("  const n = Math.ceil(m / 15) * 15;", "the snapping rule that produced the defect");
  caught("  return Math.floor(min / 15) * 15;", "the same rule rounding the other way");
  caught('return `${dt.toFormat("h:mm")}${dt.toFormat("a").toLowerCase()}`;', "a time spelled inline");
  caught('return dt.toFormat("ccc d LLL, h:mm a");', "a time spelled inside a longer format");
  caught('return start.toFormat("hh:mm a");', "the two digit hour spelling");

  allowed('return dt.toFormat("ccc, LLL d yyyy");', "a DATE format, which is a different fact");
  allowed('return dt.toFormat("HH:mm");', "the 24 hour spelling, which has only ever had one form");
  allowed("import { padTwo, snapTimeOfDay } from \"@/lib/date/parse\";", "importing the shared rules");
  allowed("const step = Math.floor(minutes / 60);", "arithmetic that is not the snapping rule");
  allowed(
    'return start.toFormat("hh:mm a"); // one-time-rule-ok: a webhook payload field, not display',
    "an opt-out with a reason",
  );
  caught(
    'return start.toFormat("hh:mm a"); // one-time-rule-ok:',
    "an opt-out carrying no reason",
  );

  // And the control that matters most: put the DELETED implementation back into
  // the real component and require this guard to catch it there. A scanner that
  // stopped matching and a clean tree produce the same empty list (L98).
  const real = readFileSync("src/components/ui/DateTimeField.tsx", "utf8");
  const reverted = real.replace(
    "const clamp =",
    'function snapMinute(m: number, dir: "down" | "up"): number {\n  if (dir === "up") {\n    const n = Math.ceil(m / 15) * 15;\n    return n >= 60 ? 45 : n;\n  }\n  return Math.floor(m / 15) * 15;\n}\nconst clamp =',
  );
  assert(
    reverted !== real,
    "the overlay found its anchor in the real component, so the control below is real",
  );
  const hits = scanTimeRules("src/components/ui/DateTimeField.tsx", reverted);
  assert(
    hits.length >= 2,
    `reverting the deleted snapMinute into the real component is caught (${hits.length} findings)`,
  );
}

finish();
