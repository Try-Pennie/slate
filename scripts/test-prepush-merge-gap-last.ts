// The pre-push merge-gap guard is the LAST step before the push (#4355, lesson L1034).
//
// The guard refuses a push onto a branch whose pull request already merged or closed,
// because the commit would be stranded: it never reaches main and nothing says so.
// It ran FIRST, and then the hook spent the whole CI parity gate (install, tsc, lint,
// the tests, the Cloudflare build, the bundle weigh, about 40 seconds and often more)
// before git actually pushed. PRs here merge within seconds of going green, so a pull
// request that was open when the guard asked could merge while the gate ran, and the
// push it had just approved landed on a merged branch. A check guarding an action must
// be the last step before it: any work between them widens the window in which what it
// checked can change.
//
// So the guard still runs first (a push onto an already merged branch should not cost
// the gate), and runs AGAIN as the last thing before every successful exit. The second
// asking reads the pull request from the repository root, because by then the hook has
// moved into the isolated tree it built in.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-prepush-merge-gap-last.ts
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const hook = readFileSync(join(ROOT, ".githooks", "pre-push"), "utf8");

const GUARD_CALL = /^\s*(\(.*)?merge_gap_guard\b(?!\(\))/;

/** Lines that are commands: not blank, not a comment. */
function commandLines(text: string): Array<{ line: string; n: number }> {
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("#");
    });
}

/**
 * Every `exit 0` in the hook whose nearest command line before it is not a call of
 * the merge-gap guard: each one is a push let through with something run after the
 * guard last asked.
 */
function exitsNotGuarded(text: string): number[] {
  const cmds = commandLines(text);
  const bad: number[] = [];
  cmds.forEach(({ line, n }, i) => {
    if (line.trim() !== "exit 0") return;
    const before = cmds[i - 1];
    if (!before || !GUARD_CALL.test(before.line)) bad.push(n);
  });
  return bad;
}

// --- the check can fail (L1): a hook that guards only first is caught -------------
{
  const guardedFirstOnly = [
    "merge_gap_guard() {",
    "  return 0",
    "}",
    "merge_gap_guard",
    "pnpm install --frozen-lockfile --prefer-offline",
    "pnpm test",
    "exit 0",
    "",
  ].join("\n");
  const bad = exitsNotGuarded(guardedFirstOnly);
  assert(bad.length === 1 && bad[0] === 7, `a hook that asks only before the gate is refused (flagged lines: ${bad.join(", ")})`);
}

// --- the real hook ----------------------------------------------------------------
{
  const exits = commandLines(hook).filter(({ line }) => line.trim() === "exit 0");
  assert(exits.length >= 2, `the hook has its two ways of letting a push through (found ${exits.length} exit 0 lines)`);
  const bad = exitsNotGuarded(hook);
  assert(
    bad.length === 0,
    `#4355: every exit that lets a push through is preceded directly by the merge-gap guard (not at lines ${bad.join(", ")})`,
  );

  const calls = commandLines(hook).filter(({ line }) => GUARD_CALL.test(line));
  const installAt = hook.indexOf("pnpm install --frozen-lockfile");
  const budgetAt = hook.lastIndexOf("\nbundle_budget_check");
  assert(installAt > 0 && budgetAt > 0, "the hook still installs and still weighs the bundle");
  const firstCallAt = calls[0] ? hook.indexOf(calls[0].line) : -1;
  assert(
    firstCallAt >= 0 && firstCallAt < installAt,
    "the guard still asks BEFORE the gate, so a push onto a branch already merged does not cost the whole gate",
  );
  const lastCall = calls[calls.length - 1];
  const lastCallAt = lastCall ? hook.lastIndexOf(lastCall.line) : -1;
  assert(lastCallAt > budgetAt, "and asks again AFTER the bundle weigh, the last step of the gate");
}

// --- the guard itself, run with a stub gh -----------------------------------------
const fnMatch = hook.match(/^merge_gap_guard\(\) \{[\s\S]*?^\}/m);
assert(fnMatch !== null, "the hook defines merge_gap_guard as a function the test can lift out");
const fnText = fnMatch?.[0] ?? "merge_gap_guard() { return 0; }";

interface Run {
  code: number;
  out: string;
  ghCwds: string[];
}

function runGuard(opts: { state: string; ghExit?: number; arg?: string; env?: Record<string, string> }): Run {
  const dir = mkdtempSync(join(tmpdir(), "prepush-merge-gap-"));
  try {
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    const elsewhere = join(dir, "isolated-tree");
    mkdirSync(bin);
    mkdirSync(repo);
    mkdirSync(elsewhere);
    const log = join(dir, "gh-cwd");
    // Builtins only (`echo`), because PATH is this one directory.
    writeFileSync(
      join(bin, "gh"),
      ["#!/bin/sh", `echo "$PWD" >> '${log}'`, opts.state ? `echo '${opts.state}'` : ":", `exit ${opts.ghExit ?? 0}`, ""].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const script = join(dir, "run.sh");
    writeFileSync(
      script,
      [
        "set -euo pipefail",
        "branch='feat/some-work'",
        `root_dir='${repo}'`,
        fnText,
        // The late asking happens from inside the isolated tree the gate built.
        `cd '${elsewhere}'`,
        `merge_gap_guard ${opts.arg ?? ""}`,
        "echo 'let through'",
        "",
      ].join("\n"),
    );
    const r = spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: bin, ...(opts.env ?? {}) } });
    if (r.error) throw r.error;
    return {
      code: r.status ?? 1,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      ghCwds: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const r = runGuard({ state: "MERGED" });
  assert(r.code === 1 && /already MERGED/.test(r.out), `a merged pull request refuses the push (exit ${r.code})`);
  assert(!r.out.includes("let through"), "and nothing after the guard runs");
}
{
  const r = runGuard({ state: "CLOSED" });
  assert(r.code === 1 && /already CLOSED/.test(r.out), "a closed pull request refuses the push too");
}
{
  const r = runGuard({ state: "OPEN" });
  assert(r.code === 0 && r.out.includes("let through"), `an open pull request lets the push through (exit ${r.code}: ${r.out.trim()})`);
  assert(r.ghCwds.length === 1, "having actually asked gh");
  assert(
    r.ghCwds[0]?.endsWith("/repo") === true,
    `#4355: gh is asked from the repository root, not the isolated tree the hook moved into (asked from ${r.ghCwds[0]})`,
  );
}
{
  // Fails OPEN on purpose: merge-gap.yml is the server side backstop (see the hook).
  const r = runGuard({ state: "", ghExit: 1 });
  assert(r.code === 0, "a pull request state gh could not read lets the push through, as documented");
}
{
  const r = runGuard({ state: "MERGED", env: { ALLOW_MERGED_PUSH: "1" } });
  assert(r.code === 0 && r.ghCwds.length === 0, "the documented override skips the asking entirely");
}
{
  const r = runGuard({ state: "MERGED", arg: "late" });
  assert(
    r.code === 1 && /while the checks/.test(r.out),
    "the late asking says the pull request merged while the checks ran, a different cause from pushing onto a merged branch",
  );
  const early = runGuard({ state: "MERGED" });
  assert(!/while the checks/.test(early.out), "and the first asking does not claim that");
}

finish();
