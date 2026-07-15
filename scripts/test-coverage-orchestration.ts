// The merge at the heart of the cross-harness coverage report (#603): a file hit
// by BOTH the node suite and vitest must report the UNION of covered lines, not
// whichever harness ran last. If this were wrong, a well-tested file could look
// half-covered and the whole report would mislead. Run:
//   node --experimental-strip-types scripts/test-coverage-merge.ts
import { mergeCoverage, handleExit, collectCoverageJsons } from "./coverage.mjs";
import { assert, finish } from "./lib/harness.ts";

// Minimal istanbul coverage-final.json for one 3-statement file. `s` maps
// statement id -> hit count; statementMap gives each a location.
const fileCov = (hits: Record<string, number>) => ({
  "/repo/src/x.ts": {
    path: "/repo/src/x.ts",
    statementMap: {
      "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } },
      "1": { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
      "2": { start: { line: 3, column: 0 }, end: { line: 3, column: 9 } },
    },
    s: hits,
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  },
});

// Harness A covers statements 0 and 1; harness B covers statement 2. Neither
// alone reaches full coverage; the union does.
const A = fileCov({ "0": 3, "1": 1, "2": 0 });
const B = fileCov({ "0": 0, "1": 0, "2": 5 });

{
  const merged = mergeCoverage([A, B]);
  const summary = merged.fileCoverageFor("/repo/src/x.ts").toSummary();
  assert(summary.statements.covered === 3, "union covers all 3 statements (2 from A + 1 from B)");
  assert(summary.statements.pct === 100, "a file covered across both harnesses reports 100 percent");
}

// The merge must ADD hit counts, not overwrite: statement 0 was hit in A only,
// and must still count as covered even though B recorded 0 for it.
{
  const merged = mergeCoverage([A, B]);
  const s = merged.fileCoverageFor("/repo/src/x.ts").s;
  assert(s["0"] === 3 && s["2"] === 5, "hit counts are summed across harnesses, not clobbered");
}

// A single harness with a genuine gap is reported honestly (no false 100).
{
  const merged = mergeCoverage([A]);
  const summary = merged.fileCoverageFor("/repo/src/x.ts").toSummary();
  assert(summary.statements.covered === 2 && summary.statements.pct < 100, "one harness alone keeps its real gap");
}

// Empty input is a valid empty report, not a crash.
{
  const merged = mergeCoverage([]);
  assert(merged.files().length === 0, "merging nothing yields an empty coverage map");
}

// handleExit: a sub-step that failed must fail the whole run, not press on and
// merge a partial (misleadingly low) result.
{
  let exited: number | null = null;
  const cont = handleExit(0, "node suite", () => (exited = 1));
  assert(cont === true && exited === null, "a zero exit continues without exiting");

  const cont2 = handleExit(2, "vitest", (code) => (exited = code));
  assert(cont2 === false && exited === 2, "a non-zero exit propagates the code and stops the run");

  handleExit(null, "c8", (code) => (exited = code));
  assert(exited === 1, "a null status (signal/crash) is treated as failure code 1");
}

// collectCoverageJsons: one harness producing no output must be tolerated (warn,
// skip), so the other harness's coverage still reports instead of crashing.
{
  const fs = {
    existsSync: (f: string) => f.includes("present"),
    readFileSync: () => JSON.stringify({ "/x.ts": { path: "/x.ts", s: {}, statementMap: {}, fnMap: {}, f: {}, branchMap: {}, b: {} } }),
  };
  const got = collectCoverageJsons(["/a/present.json", "/b/missing.json"], fs);
  assert(got.length === 1, "a missing coverage json is skipped, the present one is kept");
}

finish();
