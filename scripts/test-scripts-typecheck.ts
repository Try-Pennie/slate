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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BREAKING_CODES,
  breakingErrors,
  hasOptOut,
  parseTscErrors,
} from "./lib/scan-scripts-typecheck.ts";
import { typecheckWithControl, unreadConfigFiles } from "./lib/typecheck-program.ts";
import { assert, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = "tsconfig.scripts.json";
const CONTROL_SOURCE = "export const planted = thisNameIsNotDefined;\n";

/**
 * How many times the tree has been typechecked. Asserted to be ONE at the end:
 * the run costs about 10s and used to happen twice on every push and every CI
 * job, once for the verdict and once again to re-prove the guard could still
 * fail (#1516).
 */
let tscRuns = 0;

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

// --- the coverage rule, on fixtures ---------------------------------------------
{
  const named = ["/r/scripts/a.ts", "/r/scripts/b.ts"];
  assert(
    unreadConfigFiles(named, new Set(named)).length === 0,
    "a run that read every file its config names reports nothing unread",
  );
  assert(
    unreadConfigFiles(named, new Set(["/r/scripts/a.ts", "/tmp/typecheck-control.ts"])).join() ===
      "/r/scripts/b.ts",
    "a run that read the control and skipped part of the tree is caught, naming the file",
  );
}

// --- the real tree, judged by a run that PROVED it looked -----------------------
//
// One typecheck, not two. Everything the guard reports is satisfied by a run that
// never looked at `scripts/` at all: a wrong `include`, a config that failed to
// load, and a genuinely clean tree all produce the same empty error list (L1,
// L98). So the single run carries a planted undefined identifier and has to come
// back with exactly that error and nothing else breaking, AND it has to have read
// every file the config names.
//
// Two runs is how this started, and the second one paid ~10s on every push, every
// pre-push gate and every CI job to re-prove a property the first run can prove
// for free (#1516). Folding them together is also strictly stronger evidence: the
// control vouches for THE run that produced the verdict, rather than for a second
// invocation that merely resembled it (L70).
//
// The control lives in a temp directory, never in `scripts/` (#2712). It used to
// be planted in the tree, and every concurrent suite walking `scripts/` could list
// it and then fail to open it: ENOENT on unrelated PRs, and once on main, where it
// skipped a deploy. Being outside the tree, the control alone can no longer prove
// the run read `scripts/`, so that is now proved directly: the program must have
// read every file the config's include resolves to, and those must include this
// very file.
const run = typecheckWithControl(repoRoot, CONFIG, CONTROL_SOURCE);
tscRuns++;
// The control's temp directory is gone by now, so its source (annotation free,
// which is the point) is supplied directly to the opt-out lookup.
const found = breakingErrors(run.output, (file) =>
  file === run.controlFile ? CONTROL_SOURCE.split("\n") : readSource(file),
);

const isControl = (file: string) => file === run.controlFile;
const control = found.filter((e) => isControl(e.file));
const breaking = found.filter((e) => !isControl(e.file));

// THE CONTROL. Without this the two assertions below are answered identically by
// a healthy tree and by a tsc that read no files at all.
const controlCaught = control.some((e) => e.code === "TS2304");
assert(
  controlCaught,
  controlCaught
    ? "this run reports the class it watches: it caught the planted undefined name"
    : control.length > 0
      ? `the planted control was found but not as TS2304 (got ${control.map((e) => e.code).join(", ")}), so the class this guard watches is not the class being reported`
      : "the planted undefined name was NOT caught, so this run reports nothing and its verdict below means nothing",
);

// THE COVERAGE. The control proves this pipeline reports the class; this proves
// the run it came from read the tree the verdict is about.
const self = fileURLToPath(import.meta.url);
const namesTree = run.configFiles.includes(self) && run.configFiles.length > 200;
assert(
  namesTree,
  namesTree
    ? `${CONFIG} names the scripts tree (${run.configFiles.length} files, this suite among them)`
    : `${CONFIG} names only ${run.configFiles.length} file(s)${run.configFiles.includes(self) ? "" : ", not even this suite"}, so the run did not cover scripts/ (check its include)`,
);
const unread = unreadConfigFiles(run.configFiles, run.readFiles);
assert(
  unread.length === 0,
  unread.length === 0
    ? `the run read every one of the ${run.configFiles.length} files ${CONFIG} names`
    : `the run never read ${unread.length} file(s) ${CONFIG} names, so the verdict is about a subset:\n` +
        unread.slice(0, 10).map((f) => `  ${f}`).join("\n"),
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
  `the tree is typechecked exactly once per run (${tscRuns}x); a second pass doubles the slowest suite in CI`,
);

finish();
