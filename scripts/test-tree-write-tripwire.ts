// Tests for the runtime tree write tripwire in scripts/run-tests.ts (#2733).
//
// The static scan (test-no-tree-writes.ts, #2712) reads a suite's own source, so it
// cannot see a write made by a child process the suite starts or by a helper handed
// a repo path. The tripwire watches the tree itself while the suites run. These
// cases prove it in both directions (L1): a suite whose CHILD writes into a nested
// file of the watched tree must fail the run and be named, and the same suite
// writing outside the tree must pass. They also pin when it is armed, because it is
// deliberately off in a developer's own run and an "off" that reads like "clean"
// would be a check that never ran (L98).
//
// The runner is pointed at a throwaway root through SLATE_TREE_TRIPWIRE_ROOT, so
// the positive control never writes into this repository, where concurrent suites
// are walking the tree (the #2712 hazard itself).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-tree-write-tripwire.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRIPWIRE_WATCHED_DIRS,
  isAllowedTreeWrite,
  probeName,
  resolveTripwireMode,
} from "./lib/tree-write-tripwire.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const runner = resolve(here, "run-tests.ts");
const fx = (name: string) => resolve(here, "__fixtures__/runner", name);

// --- when it is armed: every outcome the contract names (L151) ----------------
{
  const on = (env: Record<string, string | undefined>) => resolveTripwireMode(env);

  const prePush = on({ SLATE_TREE_TRIPWIRE: "pre-push" });
  eq(prePush.kind, "on", "the pre-push gate's isolated tree arms it");
  assert(prePush.kind === "on" && /pre-push/.test(prePush.why), "and says the pre-push gate armed it");

  const ci = on({ GITHUB_ACTIONS: "true" });
  eq(ci.kind, "on", "GitHub Actions arms it with nothing else set");
  assert(ci.kind === "on" && /GitHub Actions/.test(ci.why), "and says GitHub Actions armed it");

  eq(on({ SLATE_TREE_TRIPWIRE: "on" }).kind, "on", "an explicit on arms it anywhere");

  const local = on({});
  eq(local.kind, "off", "a developer's own run leaves it off");
  assert(
    local.kind === "off" && /your own edits/.test(local.why) && /SLATE_TREE_TRIPWIRE=on/.test(local.why),
    "and says why, and how to arm it",
  );
  eq(on({ GITHUB_ACTIONS: "false" }).kind, "off", "only GITHUB_ACTIONS=true counts as CI, not its mere presence");
  eq(on({ CI: "true" }).kind, "off", "a bare CI=true is not GitHub Actions: anything can set it, so it establishes nothing");

  const nested = on({ SLATE_TREE_TRIPWIRE: "nested", GITHUB_ACTIONS: "true" });
  eq(nested.kind, "off", "a runner started by a suite stays off even in CI");
  assert(nested.kind === "off" && /outer run/.test(nested.why), "and says an outer run covers it");

  const off = on({ SLATE_TREE_TRIPWIRE: "off", GITHUB_ACTIONS: "true" });
  eq(off.kind, "off", "an explicit off wins in CI too");
  assert(off.kind === "off" && /SLATE_TREE_TRIPWIRE=off/.test(off.why), "and names the variable that turned it off");

  const bad = on({ SLATE_TREE_TRIPWIRE: "enforce" });
  eq(bad.kind, "refused", "an unknown value is refused rather than read as off");
  assert(bad.kind === "refused" && bad.why.includes('"enforce"'), "and the refusal quotes the value");
}

// --- what counts as a write ---------------------------------------------------
{
  assert(isAllowedTreeWrite(`scripts/${probeName(123, 0)}`), "the tripwire's own probe is allowed");
  assert(!isAllowedTreeWrite("scripts/typecheck-control.tmp.ts"), "#2712's planted control is not allowed");
  assert(!isAllowedTreeWrite("src/lib/x.ts"), "an ordinary source file is not allowed");
  assert(
    !isAllowedTreeWrite(`src/deep/${probeName(123, 0)}`),
    "a probe name is allowed only where the tripwire writes it, at the top of a watched dir",
  );
  eq(TRIPWIRE_WATCHED_DIRS.join(","), "scripts,src,worker", "it watches scripts, src and worker");
}

// --- the pre-push gate arms it, inside its isolated tree only ------------------
{
  const armedInTree = (hook: string) => {
    const cdAt = hook.indexOf('cd "$tree"');
    const armed = /^SLATE_TREE_TRIPWIRE=pre-push pnpm test$/m.exec(hook);
    return cdAt >= 0 && armed !== null && armed.index > cdAt && !/export SLATE_TREE_TRIPWIRE/.test(hook);
  };
  const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
  assert(
    armedInTree(hook),
    "the pre-push gate runs the suite with SLATE_TREE_TRIPWIRE=pre-push, after it has moved into the isolated tree, on that one command",
  );
  // The control (L1): the hook as it was before #2733 must fail the check.
  assert(
    !armedInTree(hook.replace("SLATE_TREE_TRIPWIRE=pre-push pnpm test", "pnpm test")),
    "and the check fails on a hook that runs the suite unarmed",
  );
}

// --- end to end, against a throwaway root -------------------------------------
// One temp base holds every throwaway root, so one removal cleans them all. The
// realpath is taken only for what is handed to the runner: macOS reports watch
// events under /private/var while tmpdir() says /var.
const base = mkdtempSync(join(tmpdir(), "slate-tripwire-"));
let made = 0;
function makeRoot(): string {
  const root = join(base, `root-${made++}`);
  for (const d of TRIPWIRE_WATCHED_DIRS) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(join(root, "src", "a", "b"), { recursive: true });
  writeFileSync(join(root, "src", "a", "b", "c.ts"), "export const c = 1;\n");
  return realpathSync(root);
}

function runRunner(files: string[], env: Record<string, string | undefined>) {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  // The run under test must not inherit whatever armed or disarmed THIS one.
  delete childEnv.SLATE_TREE_TRIPWIRE;
  delete childEnv.GITHUB_ACTIONS;
  Object.assign(childEnv, env);
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs", runner, ...files],
    { cwd: repoRoot, encoding: "utf8", env: childEnv as NodeJS.ProcessEnv, timeout: 60_000 },
  );
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

try {
  // THE POSITIVE CONTROL: a child process modifies an EXISTING file two levels
  // down. Nested and modified (not created at the top) is the hard case for a
  // recursive watch on Linux, which is what CI runs.
  {
    const root = makeRoot();
    const r = runRunner([fx("writes-tree.ts")], {
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: root,
      TRIPWIRE_FIXTURE_TARGET: join(root, "src", "a", "b", "c.ts"),
    });
    assert(r.status === 1, `a suite whose child writes into the tree fails the run (status ${r.status})`);
    assert(r.out.includes("src/a/b/c.ts"), "and the run names the path written");
    assert(
      /writes-tree\.ts/.test(r.out.slice(r.out.indexOf("src/a/b/c.ts"))),
      "and names the suite that was running when it was written",
    );
    assert(/1 passed, 0 failed/.test(r.out), "the suite itself passed, so it is the tripwire that failed the run");
    if (r.status !== 1) console.error(r.out);
  }

  // A new file in a NEW directory is caught too.
  {
    const root = makeRoot();
    const r = runRunner([fx("writes-tree.ts")], {
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: root,
      TRIPWIRE_FIXTURE_TARGET: join(root, "worker", "fresh.ts"),
    });
    assert(r.status === 1 && r.out.includes("worker/fresh.ts"), "a file created at the top of worker/ is caught and named");
  }

  // The negative control: the same suite writing OUTSIDE the tree passes, and
  // the run says the tripwire was on, so a pass is not an unwatched pass.
  {
    const root = makeRoot();
    // Beside the watched root, not inside it.
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    const r = runRunner([fx("writes-tree.ts"), fx("pass-a.ts")], {
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: root,
      TRIPWIRE_FIXTURE_TARGET: join(outside, "scratch.txt"),
    });
    assert(r.status === 0, `a write outside the tree passes (status ${r.status})`);
    assert(/tree write tripwire ON/.test(r.out), "and the run says the tripwire was on");
    assert(/tripwire on\)/.test(r.out), "and the summary line carries it");
    if (r.status !== 0) console.error(r.out);
  }

  // Off in a developer's run: the same tree write passes, and SAYS it was unwatched.
  {
    const root = makeRoot();
    const r = runRunner([fx("writes-tree.ts")], {
      SLATE_TREE_TRIPWIRE_ROOT: root,
      TRIPWIRE_FIXTURE_TARGET: join(root, "src", "a", "b", "c.ts"),
    });
    assert(r.status === 0, "with the tripwire off, a tree write does not fail the run");
    assert(/tree write tripwire OFF/.test(r.out), "and the run says the tripwire was off");
    assert(/tripwire off\)/.test(r.out), "and the summary line carries it, so off never reads as clean");
  }

  // CI arms it with nothing else set.
  {
    const root = makeRoot();
    const r = runRunner([fx("writes-tree.ts")], {
      GITHUB_ACTIONS: "true",
      SLATE_TREE_TRIPWIRE_ROOT: root,
      TRIPWIRE_FIXTURE_TARGET: join(root, "src", "a", "b", "c.ts"),
    });
    assert(r.status === 1 && r.out.includes("src/a/b/c.ts"), "under GitHub Actions a tree write fails the run");
  }

  // Suites are told an outer run covers them, so a runner they start stays off.
  {
    const root = makeRoot();
    const r = runRunner([fx("reports-tripwire-env.ts")], {
      SLATE_TREE_TRIPWIRE: "on",
      SLATE_TREE_TRIPWIRE_ROOT: root,
    });
    assert(r.status === 0, "every suite is started with SLATE_TREE_TRIPWIRE=nested");
    if (r.status !== 0) console.error(r.out);
  }

  // An unknown value refuses before running anything.
  {
    const r = runRunner([fx("fail-a.ts")], { SLATE_TREE_TRIPWIRE: "enforce" });
    assert(r.status === 1 && r.out.includes('"enforce"'), "an unknown SLATE_TREE_TRIPWIRE is refused by name");
    assert(!r.out.includes("fail-a marker ALPHA"), "and no suite ran");
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

finish();
