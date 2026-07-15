// Repo invariant (#603): the merged code-coverage machinery stays wired.
//
// Coverage spans two harnesses (node scripts + vitest) merged by scripts/
// coverage.mjs into one lcov + summary. This guard fails the build if a piece is
// removed, so the report can't silently rot: the deps, the orchestrator, the
// package script, and the CI step must all be present. It does NOT run coverage
// (too slow); the CI job is the behavioral check that it still produces numbers.
// Run: node --experimental-strip-types scripts/test-coverage-wiring.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// 1. The orchestrator exists and merges BOTH harnesses into lcov + a summary.
{
  assert(existsSync(join(ROOT, "scripts/coverage.mjs")), "scripts/coverage.mjs exists");
  const cov = read("scripts/coverage.mjs");
  assert(/NODE_V8_COVERAGE/.test(cov), "coverage.mjs captures the node-native suite via NODE_V8_COVERAGE");
  assert(/--coverage/.test(cov), "coverage.mjs runs vitest with coverage");
  assert(/createCoverageMap/.test(cov) && /\.merge\(/.test(cov), "coverage.mjs merges the two harnesses");
  assert(/lcovonly/.test(cov), "coverage.mjs emits an lcov report");
  assert(/text-summary/.test(cov), "coverage.mjs emits a text summary");
}

// 2. The tools it needs are declared, so a frozen-lockfile CI install has them.
{
  const pkg = JSON.parse(read("package.json"));
  const dev = pkg.devDependencies ?? {};
  for (const d of ["c8", "@vitest/coverage-v8", "istanbul-lib-coverage", "istanbul-lib-report", "istanbul-reports"]) {
    assert(d in dev, `devDependency ${d} is declared`);
  }
  assert(pkg.scripts?.["test:coverage"] === "node scripts/coverage.mjs", "package.json wires the test:coverage script");
}

// 3. CI runs it, so the summary is actually published (report-only, not a gate).
{
  const ci = read(".github/workflows/ci.yml");
  assert(/test:coverage/.test(ci), "CI invokes the coverage report");
  assert(/upload-artifact/.test(ci) && /lcov/.test(ci), "CI uploads the lcov artifact");
}

finish();
