// Tests for the vitest arm of the runtime tree write tripwire (#2759).
//
// #2733 put the tripwire around the node suites only, and said so: `pnpm test`
// runs vitest after the node runner has exited, so a vitest file writing into
// scripts/, src/ or worker/ went unwatched. The vitest arm is a global setup
// (scripts/vitest-tree-tripwire.ts) that Slate's vitest.config.ts declares, built
// on the same library, armed by the same rule.
//
// Two halves, each blind where the other looks (L3):
//   - WIRED: the real vitest.config.ts declares the global setup. Without this the
//     arm could be perfect and never run.
//   - WORKS: the real global setup, run by real vitest over a fixture test that
//     writes from inside a vitest worker, fails the run and names the path (L1),
//     and the same test writing outside the tree passes, saying it was watched.
//
// Every run is pointed at a throwaway root through SLATE_TREE_TRIPWIRE_ROOT, so
// the positive control never writes into this repository, where concurrent suites
// are walking the tree (the #2712 hazard itself).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-vitest-tree-tripwire.ts
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TRIPWIRE_FENCE_TIMEOUT_MS, TRIPWIRE_WATCHED_DIRS } from "./lib/tree-write-tripwire.ts";
import { untilWatched } from "./lib/tripwire-retry.ts";
import { assert, finish } from "./lib/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const setupFile = resolve(here, "vitest-tree-tripwire.ts");
const fixtureDir = resolve(here, "__fixtures__/vitest-tripwire");
const FIXTURE_FILES = ["vitest.config.mjs", "writes-tree.test.mjs"];
const vitestBin = resolve(repoRoot, "node_modules/.bin/vitest");

// --- WIRED: the app's own vitest config runs the arm --------------------------
{
  const declares = (config: unknown): boolean => {
    const gs = (config as { test?: { globalSetup?: string | string[] } }).test?.globalSetup;
    const list = gs === undefined ? [] : Array.isArray(gs) ? gs : [gs];
    return list.some((p) => resolve(repoRoot, p) === setupFile);
  };
  const real = (await import(pathToFileURL(resolve(repoRoot, "vitest.config.ts")).href)).default;
  assert(declares(real), "vitest.config.ts declares scripts/vitest-tree-tripwire.ts as a global setup");
  // The control (L1): the config as it was before #2759 must fail the check.
  const before = { ...real, test: { ...real.test, globalSetup: undefined } };
  assert(!declares(before), "and the check fails on a config that does not");
}

// --- WORKS: real vitest, real global setup, a planted write ------------------
const base = mkdtempSync(join(tmpdir(), "slate-vitest-tripwire-"));
let made = 0;
function makeRoot(): string {
  const root = join(base, `root-${made++}`);
  for (const d of TRIPWIRE_WATCHED_DIRS) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(join(root, "src", "a", "b"), { recursive: true });
  writeFileSync(join(root, "src", "a", "b", "c.ts"), "export const c = 1;\n");
  // macOS reports watch events under /private/var while tmpdir() says /var.
  return realpathSync(root);
}

// Each run gets its own COPY of the fixture, in the temp base: vitest writes a
// results cache and a bundled config beside the root it runs in, so running it on
// the fixture in place would write into scripts/ (the #2712 hazard, which the
// outer run's tripwire would rightly fail). Measured: the first draft of this
// suite ran in place and left scripts/__fixtures__/vitest-tripwire/node_modules.
// Long enough for a vitest whose global setup and teardown fences BOTH wait out a
// stalled stream, plus the run; derived from the fence so they cannot drift (#3524).
const VITEST_TIMEOUT_MS = 2 * TRIPWIRE_FENCE_TIMEOUT_MS + 60_000;

// A run whose own tripwire says it could not watch measured nothing, so it is re-run,
// each attempt on a fresh copy, never read as the behaviour under test (#3524, L411).
function runVitest(env: Record<string, string | undefined>): Promise<{ status: number | null; out: string }> {
  const label = `vitest with ${Object.entries(env)
    .filter(([k]) => k === "SLATE_TREE_TRIPWIRE" || k === "GITHUB_ACTIONS")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "nothing armed"}`;
  return untilWatched(() => runVitestOnce(env), label);
}

function runVitestOnce(env: Record<string, string | undefined>): Promise<{ status: number | null; out: string }> {
  const copy = join(base, `vitest-${made++}`);
  cpSync(fixtureDir, copy, { recursive: true });
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    TRIPWIRE_FIXTURE_GLOBAL_SETUP: setupFile,
  };
  // The run under test must not inherit whatever armed or disarmed THIS one.
  delete childEnv.SLATE_TREE_TRIPWIRE;
  delete childEnv.GITHUB_ACTIONS;
  Object.assign(childEnv, env);
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  return new Promise((res) => {
    const child = spawn(vitestBin, ["run", "--config", join(copy, "vitest.config.mjs"), "--root", copy], {
      cwd: copy,
      env: childEnv as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), VITEST_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ status: null, out: out + `\n<could not start vitest: ${err.message}>` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      res({ status, out });
    });
  });
}

try {
  const rootIn = makeRoot();
  const rootNew = makeRoot();
  const rootOut = makeRoot();
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  const rootOff = makeRoot();
  const rootCi = makeRoot();
  const rootNested = makeRoot();
  const rootRefused = makeRoot();
  const refusedTarget = join(rootRefused, "src", "refused.ts");

  // Independent runs, so they go concurrently: each vitest start is the cost.
  const [inTree, newFile, outTree, off, ci, nested, refused] = await Promise.all([
    // THE POSITIVE CONTROL: an existing file two levels down, modified from inside
    // a vitest worker. Nested and modified is the hard case for a recursive watch
    // on Linux, which is what CI runs.
    runVitest({
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: rootIn,
      TRIPWIRE_FIXTURE_TARGET: join(rootIn, "src", "a", "b", "c.ts"),
    }),
    runVitest({
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: rootNew,
      TRIPWIRE_FIXTURE_TARGET: join(rootNew, "worker", "fresh.ts"),
    }),
    runVitest({
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: rootOut,
      TRIPWIRE_FIXTURE_TARGET: join(outside, "scratch.txt"),
    }),
    runVitest({
      SLATE_TREE_TRIPWIRE_ROOT: rootOff,
      TRIPWIRE_FIXTURE_TARGET: join(rootOff, "src", "a", "b", "c.ts"),
    }),
    runVitest({
      GITHUB_ACTIONS: "true",
      SLATE_TREE_TRIPWIRE_ROOT: rootCi,
      TRIPWIRE_FIXTURE_TARGET: join(rootCi, "src", "a", "b", "c.ts"),
    }),
    runVitest({
      SLATE_TREE_TRIPWIRE: "nested",
      GITHUB_ACTIONS: "true",
      SLATE_TREE_TRIPWIRE_ROOT: rootNested,
      TRIPWIRE_FIXTURE_TARGET: join(rootNested, "src", "a", "b", "c.ts"),
    }),
    runVitest({
      SLATE_TREE_TRIPWIRE: "enforce",
      SLATE_TREE_TRIPWIRE_ROOT: rootRefused,
      TRIPWIRE_FIXTURE_TARGET: refusedTarget,
    }),
  ]);

  assert(inTree.status === 1, `a vitest file writing into the tree fails the run (status ${inTree.status})`);
  assert(/TREE WRITES/.test(inTree.out) && inTree.out.includes("src/a/b/c.ts"), "and the run names the path written");
  assert(/1 passed/.test(inTree.out), "the test itself passed, so it is the tripwire that failed the run");
  assert(/tree write tripwire ON/.test(inTree.out), "and the run said the tripwire was on");
  if (inTree.status !== 1 || !inTree.out.includes("src/a/b/c.ts")) console.error(inTree.out);

  assert(
    newFile.status === 1 && newFile.out.includes("worker/fresh.ts"),
    "a file created at the top of worker/ is caught and named",
  );
  if (newFile.status !== 1) console.error(newFile.out);

  // The negative control: the same test writing OUTSIDE the tree passes, and says
  // it was watched, so a pass is not an unwatched pass.
  assert(outTree.status === 0, `a write outside the tree passes (status ${outTree.status})`);
  assert(/tree write tripwire ON/.test(outTree.out), "and the run says the tripwire was on");
  assert(!/TREE WRITES|TREE WATCH FAILED/.test(outTree.out), "and reports nothing");
  if (outTree.status !== 0) console.error(outTree.out);

  // Off in a developer's run: the same tree write passes, and SAYS it was unwatched.
  assert(off.status === 0, "with the tripwire off, a tree write does not fail the run");
  assert(/tree write tripwire OFF/.test(off.out), "and the run says the tripwire was off");

  assert(ci.status === 1 && ci.out.includes("src/a/b/c.ts"), "under GitHub Actions a tree write fails the run");

  assert(nested.status === 0 && /tree write tripwire OFF/.test(nested.out), "a vitest started by a suite stays off, even in CI");

  assert(refused.status === 1 && refused.out.includes('"enforce"'), "an unknown SLATE_TREE_TRIPWIRE is refused by name");
  assert(!existsSync(refusedTarget), "and no test ran");

  // None of those runs wrote into the committed fixture, which sits in the tree.
  const left = readdirSync(fixtureDir).sort().join(",");
  assert(
    left === [...FIXTURE_FILES].sort().join(","),
    `the committed fixture directory holds only its own files after every run (found: ${left})`,
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}

finish();
