// The scripts tree is typechecked for the classes that break at RUNTIME (#1504).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-scripts-typecheck.ts
//
// `tsconfig.json` excludes `scripts`, so `pnpm build` and `npx tsc --noEmit`
// never look at ~280 node test suites or at the canary scripts that run against
// live prod every 30 minutes. Two things came out of that:
//
//   - `failureLogPath` was an undefined identifier in `scripts/smoke-booking-api.ts`
//     and tsc reported clean; it surfaced only when the script was run.
//   - in `scripts/test-reconcile-missing-busy-blocks.ts`, an undefined `calls`
//     inside a fake threw BEFORE the fake recorded anything, so the test guarding
//     "a block-lookup read error aborts with ZERO inserts" passed on its own
//     fixture's typo. Had the sweep ever regressed into mass-inserting busy
//     blocks, that test would still have reported success (L140, L1).
//
// The tree carries ~100 errors, almost all nullable and shape mismatches in test
// fakes, so this does NOT demand a clean typecheck. It fails on the two classes
// that ship broken and says which ones it is watching, so widening it later is a
// deliberate act rather than a silent no-op.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  BREAKING_CODES,
  breakingErrors,
  hasOptOut,
  parseTscErrors,
} from "./lib/scan-scripts-typecheck.ts";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const CONFIG = "tsconfig.scripts.json";

/**
 * How many times tsc has been spawned. Asserted to be ONE at the end: the run
 * costs about 10s and used to happen twice on every push and every CI job, once
 * for the verdict and once again to re-prove the guard could still fail (#1516).
 */
let tscRuns = 0;

/** Run tsc over the scripts tree and return its stdout (errors go to stdout). */
function runTsc(): string {
  tscRuns++;
  try {
    execFileSync("npx", ["tsc", "-p", CONFIG, "--noEmit"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "";
  } catch (err) {
    // A non-zero exit is expected: the tree has ~100 non-breaking errors.
    const e = err as { stdout?: string; stderr?: string; code?: string };
    // A missing `npx`/tsc must NOT read as "no errors found" (L98): finding
    // nothing to check is not a pass.
    if (e.code === "ENOENT") {
      throw new Error("could not run tsc (npx not found), so nothing was checked");
    }
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

const readSource = (file: string): string[] => {
  try {
    return readFileSync(join(repoRoot, file), "utf8").split("\n");
  } catch {
    return [];
  }
};

// --- the parse and the opt-out, on fixture lines -------------------------------
{
  const fixture = [
    "scripts/foo.ts(12,7): error TS2304: Cannot find name 'calls'.",
    "scripts/bar.ts(3,1): error TS2339: Property 'x' does not exist on type 'Y'.",
    "Found 2 errors in 2 files.",
  ].join("\n");
  const parsed = parseTscErrors(fixture);
  assert(parsed.length === 2, `both error lines parse (got ${parsed.length})`);
  assert(parsed[0].code === "TS2304" && parsed[0].line === 12, "code and line are read off the line");
  assert(
    breakingErrors(fixture, () => []).map((e) => e.code).join(",") === "TS2304",
    "only the runtime-breaking class fails the build; the shape mismatch does not",
  );

  // The opt-out, in both positions, and never on a bare marker with no reason.
  assert(
    hasOptOut(["const x = y; // typecheck-ok: generated at build time"], 1),
    "the opt-out is honoured on the line itself",
  );
  assert(
    hasOptOut(["// typecheck-ok: generated at build time", "const x = y;"], 2),
    "and in the comment block directly above",
  );
  assert(
    !hasOptOut(["// typecheck-ok:", "const x = y;"], 2),
    "a marker with no reason silences nothing",
  );
  assert(
    !hasOptOut(["const a = 1;", "", "const x = y;"], 3),
    "and an unrelated line above does not silence it",
  );
}

// --- the real tree, judged by a run that PROVED it looked -----------------------
//
// One tsc invocation, not two. Everything the guard reports is satisfied by an
// invocation that never looked at `scripts/` at all: a wrong `include`, a config
// that failed to load, and a genuinely clean tree all produce the same empty
// error list (L1, L98). So a real undefined identifier is planted in the tree
// FIRST, and the single run has to come back with exactly that error and nothing
// else breaking.
//
// Two runs is how this started, and the second one paid ~10s on every push, every
// pre-push gate and every CI job to re-prove a property the first run can prove
// for free (#1516). Folding them together is also strictly stronger evidence: the
// control now vouches for THE run that produced the verdict, rather than for a
// second invocation that merely resembled it (L70).
//
// The control's filename does not match `test-*.ts`, so the suite runner cannot
// pick it up if it somehow survives, and it is removed in a `finally`.
const controlName = "typecheck-control.tmp.ts";
const controlPath = join(repoRoot, "scripts", controlName);

let found: ReturnType<typeof breakingErrors>;
try {
  writeFileSync(controlPath, "export const planted = thisNameIsNotDefined;\n");
  // Read the errors while the control file still exists, so the opt-out lookup
  // sees its real (annotation-free) source rather than an unreadable file.
  found = breakingErrors(runTsc(), readSource);
} finally {
  rmSync(controlPath, { force: true });
}

const isControl = (file: string) => file.includes(controlName);
const control = found.filter((e) => isControl(e.file));
const breaking = found.filter((e) => !isControl(e.file));

// THE CONTROL. Without this the two assertions below are answered identically by
// a healthy tree and by a tsc that read no files at all.
const controlCaught = control.some((e) => e.code === "TS2304");
assert(
  controlCaught,
  controlCaught
    ? "this run was PROVEN to have read scripts/: it caught the planted undefined name"
    : control.length > 0
      ? `the planted control was found but not as TS2304 (got ${control.map((e) => e.code).join(", ")}), so the class this guard watches is not the class being reported`
      : "the planted undefined name was NOT caught, so this run did not look at scripts/ and its verdict below means nothing (check tsconfig.scripts.json's include, and that tsc ran)",
);

assert(
  breaking.length === 0,
  breaking.length === 0
    ? `no undefined names or unresolved imports in scripts/ (watching ${BREAKING_CODES.join(", ")}), on a run proven to have looked`
    : `these break at runtime and must be fixed (or annotated with "// typecheck-ok: <why>"):\n` +
      breaking.map((e) => `  ${e.file}:${e.line} ${e.code} ${e.message}`).join("\n"),
);

// #1516: the whole point. A second invocation creeping back in doubles the
// slowest suite in the pre-push gate and in CI, and nothing else would notice.
assert(
  tscRuns === 1,
  `tsc is spawned exactly once per run (spawned ${tscRuns}x); a second invocation doubles the slowest suite in CI`,
);

finish();
