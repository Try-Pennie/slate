// Merged code-coverage report across Slate's two test harnesses (#603).
//
// Slate runs pure logic + orchestration through node-native scripts and
// component/route/mocked-lib code through vitest (see AGENTS.md). Each harness
// exercises different files, and a few (e.g. booking/service.ts) are hit by both,
// so a single-harness report would understate or misattribute coverage. This
// captures V8 coverage from BOTH, converts each to istanbul format, merges them
// into the true union, and emits one lcov + text summary.
//
// Report-only by design (#603): it never fails the build on a low number. A hard
// threshold on this mixed harness would be noisy. Run: pnpm test:coverage
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import libCoverage from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";

/**
 * Merge istanbul coverage-final.json objects into one coverage map. This is the
 * union that makes the cross-harness report honest: a file hit by both the node
 * suite and vitest reports the combined covered lines, because istanbul's merge
 * SUMS hit counts per statement rather than overwriting. Exported so the merge
 * (the one place a bug would silently mis-report) is unit tested apart from the
 * process orchestration below.
 *
 * istanbul's merge adopts the first map for a file by reference and then mutates
 * it, so a caller that reuses an input object would see it corrupted. Clone each
 * input first, so mergeCoverage is a pure read of its arguments.
 */
export function mergeCoverage(coverageJsons) {
  const map = libCoverage.createCoverageMap({});
  for (const json of coverageJsons) map.merge(structuredClone(json));
  return map;
}

/**
 * Fail the whole coverage run if a sub-step exited non-zero, rather than pressing
 * on to merge a partial (and misleadingly low) result. Pure and exit-injected so
 * the non-zero-propagates / zero-continues decision is unit tested without
 * spawning a subprocess. Returns true when the caller may continue.
 */
export function handleExit(status, label, exit = process.exit) {
  if (status !== 0) {
    console.error(`\ncoverage: "${label}" exited ${status}`);
    exit(status ?? 1);
    return false;
  }
  return true;
}

/**
 * Assemble the istanbul jsons the merge consumes, tolerating a harness that
 * produced none (warn, skip) so one empty harness cannot crash the report.
 * fs is injected so the skip-missing branch is testable.
 */
export function collectCoverageJsons(files, fs = { existsSync, readFileSync }) {
  const out = [];
  for (const file of files) {
    if (fs.existsSync(file)) out.push(JSON.parse(fs.readFileSync(file, "utf8")));
    else console.warn(`coverage: no coverage json at ${file}`);
  }
  return out;
}

const ROOT = resolve(import.meta.dirname, "..");
const COV = resolve(ROOT, "coverage");
const NODE_RAW = resolve(COV, "node-v8");
const NODE_OUT = resolve(COV, "node");
const VITEST_OUT = resolve(COV, "vitest");

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  handleExit(res.status, `${cmd} ${args.join(" ")}`);
}

// Only orchestrate the suites when run as a script; importing (for the merge
// test) must have no side effects.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) {
  // Imported as a module: expose the pure helpers only.
} else {
  await main();
}

async function main() {
// Clean slate so a stale run can't inflate the merge.
rmSync(COV, { recursive: true, force: true });
mkdirSync(NODE_RAW, { recursive: true });

// 1. Node-native suite: dump raw V8 coverage (children inherit the env var), then
//    let c8 convert it to an istanbul coverage-final.json against the real sources.
console.log("coverage: running node-native suite...");
run(
  "node",
  ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs", "scripts/run-tests.ts"],
  { NODE_V8_COVERAGE: NODE_RAW },
);
run("node_modules/.bin/c8", [
  "report",
  `--temp-directory=${NODE_RAW}`,
  `--reports-dir=${NODE_OUT}`,
  "--reporter=json",
  "--all",
  "--src=src",
  "--include=src/**",
  "--exclude=src/**/*.test.{ts,tsx}",
]);

// 2. Vitest: its own v8 provider maps esbuild-transformed code back to source
//    (which external c8 cannot), so it owns the vitest half.
console.log("coverage: running vitest with coverage...");
run("node_modules/.bin/vitest", [
  "run",
  "--coverage",
  "--coverage.provider=v8",
  "--coverage.reporter=json",
  "--coverage.all",
  "--coverage.include=src/**",
  "--coverage.exclude=src/**/*.test.{ts,tsx}",
  `--coverage.reportsDirectory=${VITEST_OUT}`,
]);

// 3. Merge the two istanbul maps into the true union and emit lcov + summary.
console.log("coverage: merging...");
const files = [NODE_OUT, VITEST_OUT].map((dir) => resolve(dir, "coverage-final.json"));
const map = mergeCoverage(collectCoverageJsons(files));

const context = createContext({ dir: COV, coverageMap: map });
reports.create("text-summary").execute(context);
reports.create("lcovonly").execute(context);
console.log(`\ncoverage: merged lcov written to ${resolve(COV, "lcov.info")}`);
}
