// #1050: coverage cannot erode silently.
//
// The merged report is report-only on the NUMBER by design (#603): there is no target
// percentage, because a hard threshold on a mixed two-harness number would be noisy,
// and that decision stands. What it did not cover is EROSION. Nothing stopped the
// number sliding except somebody choosing to read a job log, which is the weakest
// control in the repo: a report nobody opens is indistinguishable from no report.
//
// So this is a ratchet, not a threshold. It fails only on a real drop below a committed
// floor, and the distinction is what makes it survivable: a check that fired on noise
// would be switched off within a week, which is the failure mode to design against.
//
// Run: node --experimental-strip-types scripts/test-coverage-ratchet.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  judgeCoverage,
  statementsPct,
  DEFAULT_TOLERANCE,
  RAISE_AT,
} from "./lib/coverage-ratchet.mjs";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const FLOOR = 63.3;

// --- the three verdicts -------------------------------------------------------
eq(judgeCoverage({ floor: FLOOR, measured: FLOOR }).verdict, "pass", "the floor itself passes");
eq(
  judgeCoverage({ floor: FLOOR, measured: FLOOR + 0.4 }).verdict,
  "pass",
  "a small gain passes without demanding the floor move",
);
eq(
  judgeCoverage({ floor: FLOOR, measured: FLOOR - DEFAULT_TOLERANCE }).verdict,
  "pass",
  "a drop exactly at the tolerance is noise, not erosion",
);
eq(
  judgeCoverage({ floor: FLOOR, measured: FLOOR - DEFAULT_TOLERANCE - 0.01 }).verdict,
  "regressed",
  "a drop past the tolerance fails",
);
eq(
  judgeCoverage({ floor: FLOOR, measured: FLOOR + RAISE_AT }).verdict,
  "raise",
  "a real gain asks for the floor to be raised",
);

// --- an unmeasurable number is a failure, not a pass --------------------------
{
  // The one that matters most (L98). A coverage run that produced no number and a run
  // that produced a healthy one are indistinguishable to anything that only checks for
  // a failure, so "no number" must fail on its own verdict.
  for (const measured of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = judgeCoverage({ floor: FLOOR, measured });
    eq(r.verdict, "unmeasured", `an unreadable number (${String(measured)}) is not a pass`);
    assert(
      /nothing was compared/i.test(r.message),
      "and it says nothing was compared, rather than naming a percentage it did not have",
    );
  }
}

// --- the message carries both numbers ----------------------------------------
{
  // A failure that does not name the floor sends the reader to find it, and a ratchet
  // is only actionable if the two numbers are in front of them.
  const r = judgeCoverage({ floor: FLOOR, measured: 60 });
  assert(r.message.includes("60.00"), "the failure names the measured number");
  assert(r.message.includes("63.30"), "and the floor");
  assert(
    /add a test|move the floor/i.test(r.message),
    "and says what to do about it, both ways",
  );
}
{
  const r = judgeCoverage({ floor: FLOOR, measured: 70 });
  eq(r.suggestFloor, 70, "a raise carries the exact value to write into the floor file");
}

// --- statementsPct: no number means null, never zero -------------------------
eq(statementsPct({ statements: { pct: 63.3 } }), 63.3, "reads the statements percentage");
eq(statementsPct({ statements: { pct: 0 } }), 0, "and zero, which is a real number");
for (const bad of [undefined, null, {}, { statements: {} }, { statements: { pct: "63" } }]) {
  eq(statementsPct(bad), null, `no usable number gives null, not 0 (${JSON.stringify(bad)})`);
}

// --- the floor is committed, and is a real number ----------------------------
{
  const raw = readFileSync(join(ROOT, "scripts", "coverage-floor.json"), "utf8");
  const parsed = JSON.parse(raw) as { statements?: unknown };
  assert(
    typeof parsed.statements === "number" && parsed.statements > 0,
    `the floor file holds a number (${String(parsed.statements)})`,
  );
  // A floor of 0 would be a ratchet that can never fire: it reads as configured and
  // enforces nothing, which is worse than not having one (L182).
  assert(
    (parsed.statements as number) >= 50,
    "and it is not a floor so low that nothing could ever trip it",
  );
  // And it must be MEASURED, not inherited. The first floor here was 63.30, copied from
  // the audit report that asked for the ratchet, while the suite actually covered 85.83:
  // a floor 22 points below reality is a ratchet that reads as protection and cannot
  // fire. A stamp does not prove it is current, but it does mean a stale floor is
  // visible rather than silent.
  assert(
    typeof (parsed as { measuredOn?: unknown }).measuredOn === "string",
    "the floor records WHEN it was measured, so a stale one is visible",
  );
}

// --- the runner actually consults it -----------------------------------------
{
  // Built is not wired (L3). The judgement being right is useless if coverage.mjs
  // prints it and exits 0 regardless.
  const runner = readFileSync(join(ROOT, "scripts", "coverage.mjs"), "utf8");
  assert(runner.includes("judgeCoverage("), "coverage.mjs calls the ratchet");
  assert(
    runner.includes("coverage-floor.json"),
    "and reads the committed floor rather than a literal in the script",
  );
  assert(
    /verdict === "regressed" \|\| judgement\.verdict === "unmeasured"/.test(runner) &&
      /process\.exit\(1\)/.test(runner),
    "and exits non-zero on a regression AND on an unmeasurable number",
  );
  assert(
    runner.includes("GITHUB_STEP_SUMMARY"),
    "and writes the verdict where a person sees it without opening a log, which is the " +
      "whole complaint about the number it replaces",
  );
}

finish();
