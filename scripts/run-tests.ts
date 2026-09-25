// Parallel orchestrator for the node-native test suite (#604).
//
// Replaces the old `for f in scripts/test-*.ts; do node ... "$f" || exit 1; done`
// bash loop, which was fail-fast (the first red file hid every later failure)
// and noisy (every green file spammed its "ok:" lines). This runner instead:
//   - runs every file (NEVER aborts on the first failure),
//   - runs them through a bounded concurrency pool (~CPU count) for speed,
//   - stays quiet on green: only a live progress line + a final summary,
//   - dumps each failed file's full captured output at the end,
//   - reports per-file timing and the slowest files,
//   - exits non-zero if ANY file failed.
//
// Each test file is a standalone process that ends with process.exit(0|1); a
// non-zero exit (or a crash) is a failure. That contract is unchanged.
//
// Usage:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/run-tests.ts
//   node ... scripts/run-tests.ts <file...>   # explicit files (used by tests)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { availableParallelism } from "node:os";
import { discoverSuiteNames } from "./lib/suite-discovery.ts";
import {
  formatTripwireFindings,
  resolveTripwireMode,
  startTreeWatch,
  tripwireFailed,
  tripwireWatchRoot,
  type TreeWatch,
} from "./lib/tree-write-tripwire.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// The shifted run (#2503). `SLATE_CLOCK_SHIFT=+1d pnpm test:node` asks every suite
// what it will do on a day that has not happened yet, which is the only way a test
// whose meaning is a relationship between a fixture and today is found before it
// goes red on main by itself. The hook goes on the CHILD's argv rather than into
// NODE_OPTIONS so the shift is visible in the command the runner actually ran.
const clockShiftSpec = process.env.SLATE_CLOCK_SHIFT?.trim() ?? "";

const NODE_ARGS = [
  "--experimental-strip-types",
  ...(clockShiftSpec ? ["--import", "./scripts/shift-clock.ts"] : []),
  "--import",
  "./scripts/register-paths.mjs",
];

// The tree write tripwire (#2733): watches scripts/, src/ and worker/ for the
// length of the run and fails it on any write a suite, or anything a suite starts,
// makes there. Armed only in CI and the pre-push gate's isolated checkout; the
// rules and the reasons are in scripts/lib/tree-write-tripwire.ts. The ROOT is
// overridable only so its own test can point it at a throwaway tree rather than
// planting writes in this one.
const tripwire = resolveTripwireMode(process.env);
const watchRoot = tripwireWatchRoot(process.env, repoRoot);

// Every suite is told an outer run covers the tree, so a suite that starts this
// runner again (test-run-tests.ts does) does not arm a second watcher that would
// see its concurrent siblings' writes and blame them on itself.
const childEnv: NodeJS.ProcessEnv = { ...process.env, SLATE_TREE_TRIPWIRE: "nested" };
const SUSPECT_GRACE_MS = 2_000;

function discover(): string[] {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.map((a) => resolve(repoRoot, a));
  return discoverSuiteNames(here).map((f) => resolve(here, f));
}

interface Result {
  file: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  ms: number;
}

function runFile(file: string): Promise<Result> {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const child = spawn("node", [...NODE_ARGS, file], {
      cwd: repoRoot,
      env: childEnv,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (err) => {
      output += `\n<runner: failed to spawn: ${err.message}>\n`;
      resolvePromise({
        file,
        code: 1,
        signal: null,
        output,
        ms: performance.now() - started,
      });
    });
    child.on("close", (code, signal) => {
      resolvePromise({
        file,
        code,
        signal,
        output,
        ms: performance.now() - started,
      });
    });
  });
}

const isPass = (r: Result) => r.code === 0 && r.signal === null;

async function main() {
  if (tripwire.kind === "refused") {
    console.error(`run-tests: ${tripwire.why}. Nothing was run.`);
    process.exit(1);
  }
  const files = discover();
  if (files.length === 0) {
    console.error("run-tests: no test files matched.");
    process.exit(1);
  }

  // Who to name beside a tree write. An event is delivered a little after the
  // write, and a suite whose child wrote on its way out has often exited by then,
  // so a suite that finished within SUSPECT_GRACE_MS is named too. These are
  // suspects for a person to read, never a verdict anything acts on.
  const running = new Set<string>();
  const endedAt = new Map<string, number>();
  const suspects = () => {
    const now = performance.now();
    const recent = [...endedAt].filter(([, t]) => now - t <= SUSPECT_GRACE_MS).map(([f]) => f);
    return [...new Set([...running, ...recent])].map((f) => relative(repoRoot, f));
  };
  let treeWatch: TreeWatch | null = null;
  if (tripwire.kind === "on") {
    const started = await startTreeWatch(watchRoot, suspects);
    if ("error" in started) {
      console.error(`run-tests: tree write tripwire could not start: ${started.error}. Nothing was run.`);
      process.exit(1);
    }
    treeWatch = started.watch;
    console.log(`tree write tripwire ON (${tripwire.why}): any write into scripts/, src/ or worker/ fails this run.`);
  } else {
    console.log(`tree write tripwire OFF: ${tripwire.why}.`);
  }

  const concurrency = Math.max(1, Math.min(availableParallelism(), files.length));
  const results: Result[] = [];
  const tty = process.stdout.isTTY;
  let done = 0;
  let failed = 0;

  const drawProgress = () => {
    if (!tty) return;
    process.stdout.write(
      `\rrunning ${done}/${files.length}  (${done - failed} passed, ${failed} failed)   `,
    );
  };

  const queue = [...files];
  const started = performance.now();
  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      running.add(next);
      const r = await runFile(next);
      running.delete(next);
      endedAt.set(next, performance.now());
      results.push(r);
      done++;
      if (!isPass(r)) failed++;
      drawProgress();
    }
  }
  drawProgress();
  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );
  const wall = performance.now() - started;
  if (tty) process.stdout.write("\r" + " ".repeat(48) + "\r");

  const failures = results.filter((r) => !isPass(r));
  const rel = (f: string) => relative(repoRoot, f);

  // Stopping waits for the tripwire's own end probe, so every write raised before
  // the last suite exited has been delivered before the verdict is read.
  const watched = treeWatch ? await treeWatch.stop() : null;

  // Full output for every red file, so two broken files are BOTH visible.
  for (const r of failures) {
    const why =
      r.signal !== null ? `signal ${r.signal}` : `exit ${r.code}`;
    console.error(`\n=== FAILED: ${rel(r.file)} (${why}) ===`);
    console.error(r.output.trimEnd() || "<no output>");
  }

  // Slowest files (only when there's more than a handful, to aid perf triage).
  if (results.length > 5) {
    const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(
      "\nSlowest: " +
        slowest.map((r) => `${rel(r.file)} ${Math.round(r.ms)}ms`).join(", "),
    );
  }

  const passed = results.length - failures.length;
  // The shift is named in the SUMMARY line, not only at the top, because that line
  // is what a workflow step and a person scrolling to the bottom both read. A
  // shifted run reporting the same sentence as an ordinary one would let a shift
  // that never applied read as a clean result (L98).
  const clock = clockShiftSpec ? `, clock ${clockShiftSpec}` : "";
  // The tripwire's state rides in the summary for the same reason: an unwatched
  // pass must never read like a watched one.
  const trip = `, tripwire ${tripwire.kind}`;
  const summary = `${passed} passed, ${failures.length} failed in ${(wall / 1000).toFixed(2)}s (concurrency ${concurrency}${clock}${trip})`;

  const findings = watched ? formatTripwireFindings(watched) : [];
  if (findings.length > 0) console.error("\n" + findings.join("\n"));
  const tripped = watched !== null && tripwireFailed(watched);
  if (failures.length > 0 || tripped) {
    console.error(`\nFAIL: ${summary}`);
    if (failures.length > 0) {
      console.error("Failed: " + failures.map((r) => rel(r.file)).join(", "));
    }
    process.exit(1);
  }
  console.log(`PASS: ${summary}`);
  process.exit(0);
}

main();
