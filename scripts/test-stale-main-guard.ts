// The pre-push stale-main guard (#1612).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-stale-main-guard.ts
//
// A branch created from a stale `origin/main` ref silently carries commits that
// are already on main. Its diff against its own merge base then shows another
// change's work as its own, and the symptom surfaces only at PR time as a merge
// conflict, which reads as an ordinary rebase rather than as a branch that was
// wrong from the start. That happened twice on 2026-08-29 and cost two
// thrown-away PRs.
//
// This drives the REAL shell script with a stub `git` on PATH, so nothing here
// re-implements the decision it is checking. Both directions are proved: the
// refusing case must refuse AND the clean case must pass, because a one-sided
// test is satisfied by a guard hard-wired to a single answer (L1).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(repoRoot, ".githooks/lib/stale-main-guard.sh");

interface Run {
  code: number;
  err: string;
  /** Which git subcommands the guard actually invoked, in order. */
  gitCalls: string[];
}

/**
 * The externals an isolated run needs, resolved ONCE (the same reason
 * test-workflow-settings-guard.ts resolves its own): a missing one throws here
 * rather than resolving to an empty string, because an empty path would fail
 * later as something that reads like the guard refusing the push.
 */
const ISOLATED_PATH_TOOLS = ["grep", "sh"] as const;
const REAL_PATHS: Record<(typeof ISOLATED_PATH_TOOLS)[number] | "bash", string> = (() => {
  const resolved = {} as Record<string, string>;
  for (const tool of [...ISOLATED_PATH_TOOLS, "bash"]) {
    const real = spawnSync("/usr/bin/which", [tool], { encoding: "utf8" }).stdout.trim();
    if (!real) {
      throw new Error(
        `could not locate ${tool}, so this test cannot isolate PATH and its results would mean nothing`,
      );
    }
    resolved[tool] = real;
  }
  return resolved as Record<(typeof ISOLATED_PATH_TOOLS)[number] | "bash", string>;
})();

interface Opts {
  /** Exit status of the stub `git fetch`. Non-zero stands for no network. */
  fetchExit?: number;
  /** Exit status of the stub `git cherry`. */
  cherryExit?: number;
  /** What the stub `git cherry -v` prints. */
  cherryOut?: string;
  env?: Record<string, string>;
}

function runGuard(branch: string, opts: Opts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "stale-main-guard-"));
  const log = join(dir, "git-calls");
  try {
    // The stub logs its subcommand, so "the guard actually fetched" and "the
    // guard actually compared" are observable independently of the exit code.
    // Without that, a guard that skipped and a guard that ran and found nothing
    // are the same exit 0 (L1).
    //
    // Every line of it is a shell BUILTIN (`echo`, a redirect), because PATH is
    // replaced by this one directory: a `cat` heredoc here silently printed
    // nothing at all, and the guard then read an empty comparison and let the
    // push through, which is the very answer the refusing case is asserting
    // against.
    const cherryLines = (opts.cherryOut ?? "").split("\n").filter((l) => l !== "");
    const stub = [
      "#!/bin/sh",
      `echo "$1" >> '${log}'`,
      'case "$1" in',
      `  fetch) exit ${opts.fetchExit ?? 0} ;;`,
      "  cherry)",
      ...cherryLines.map((l) => `    echo '${l.replace(/'/g, "'\\''")}'`),
      `    exit ${opts.cherryExit ?? 0} ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n");
    writeFileSync(join(dir, "git"), stub);
    chmodSync(join(dir, "git"), 0o755);
    // PATH is REPLACED by this ONE directory, so the real git can never answer
    // for the stub. A real git here would reach the network and make the result
    // depend on the machine rather than on the fixture.
    for (const tool of ISOLATED_PATH_TOOLS) {
      symlinkSync(REAL_PATHS[tool], join(dir, tool));
    }
    const r = spawnSync(REAL_PATHS.bash, [guard, branch], {
      encoding: "utf8",
      env: { PATH: dir, ...(opts.env ?? {}) },
    });
    if (r.error) throw r.error;
    return {
      code: r.status ?? 1,
      err: `${r.stderr ?? ""}${r.stdout ?? ""}`,
      gitCalls: existsSync(log)
        ? readFileSync(log, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
        : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Real `git cherry -v` output, so the fixture cannot be kinder than the thing it
// stands in for: it prints the FULL forty character sha, and the subject is the
// half of the line that tells a reader which change this actually is.
const ALREADY_ON_MAIN = "f5242f80eb8982c4f2d7fab2af43e25b769aed04";
const OWN_WORK = "3c81de0a1b6d4e9f2c7a8b5d0e3f1a4c6b9d2e78";
const DUPLICATE_COMMITS = [
  `- ${ALREADY_ON_MAIN} Give every job in every workflow a timeout`,
  `+ ${OWN_WORK} Refuse a push from a branch built on a stale main`,
].join("\n");
const CLEAN_COMMITS = [
  `+ ${OWN_WORK} Refuse a push from a branch built on a stale main`,
  "+ 7b19aa4c2f8e0d6a3b1c5e9f7a2d4b8c0e6f1a35 Name the enforcement in the dispatch playbook",
].join("\n");

// Captured so the three outcomes can be compared against each other, since a
// guard whose "could not check" reads like its "checked and clean" has three
// outcomes and one message (L11).
let noNetworkMessage = "";
let unreadableMessage = "";

// --- the branch carries a commit already on main: blocked ---------------------
{
  const r = runGuard("feat/some-work", { cherryOut: DUPLICATE_COMMITS });
  assert(r.gitCalls.includes("fetch"), "origin/main is fetched before anything is judged");
  assert(r.gitCalls.includes("cherry"), "and the branch is compared against what was fetched");
  assert(r.code === 1, `a branch carrying a commit already on main is refused (exit ${r.code})`);
  assert(
    r.err.includes(ALREADY_ON_MAIN.slice(0, 12)) &&
      r.err.includes("Give every job in every workflow a timeout"),
    "and the offending commit is NAMED, sha and subject",
  );
  assert(
    !r.err.includes(ALREADY_ON_MAIN),
    "with the sha shortened, so the subject is not pushed off the line",
  );
  assert(
    !r.err.includes(OWN_WORK.slice(0, 12)),
    "while the branch's own new commits are not accused",
  );
  assert(/patch id/i.test(r.err), "it says the match is by patch id, not by sha");
  assert(/ALLOW_STALE_MAIN=1/.test(r.err), "and names the deliberate, visible way past it");
  assert(
    /origin\/main/.test(r.err) && /checkout -b/.test(r.err),
    "and suggests rebuilding off current main",
  );
}

// --- the branch is clean: through, silently -----------------------------------
//
// The half that proves the guard is not hard-wired to refuse (L1).
{
  const r = runGuard("feat/some-work", { cherryOut: CLEAN_COMMITS });
  assert(r.gitCalls.includes("cherry"), "a clean branch is still actually compared");
  assert(r.code === 0, `and is not blocked (exit ${r.code})`);
  assert(r.err.trim() === "", `quietly (got ${JSON.stringify(r.err)})`);
}
{
  // No commits at all ahead of main is the same case.
  const r = runGuard("feat/some-work", { cherryOut: "" });
  assert(r.code === 0 && r.err.trim() === "", "an empty comparison blocks nothing and says nothing");
}
{
  // The marker is anchored to the start of the line: a subject that merely
  // contains "- " is a new commit, not a duplicate one.
  const r = runGuard("feat/some-work", { cherryOut: "+ 7b19aa4 Drop the - separator from the label" });
  assert(r.code === 0, "a hyphen inside a subject is not read as a duplicate marker");
}

// --- no network: fails OPEN, and SAYS so --------------------------------------
//
// Blocking every push made offline would be worse than the gap. Silence would be
// worse still: a machine that can never reach origin would look exactly like a
// clean run (L98).
{
  const r = runGuard("feat/some-work", { fetchExit: 1, cherryOut: DUPLICATE_COMMITS });
  assert(r.code === 0, "an unreachable origin does not block the push");
  assert(
    r.gitCalls.includes("fetch") && !r.gitCalls.includes("cherry"),
    "and nothing is compared against a ref that was never updated",
  );
  assert(
    /nothing checked/i.test(r.err),
    `but it says nothing was checked (got ${JSON.stringify(r.err)})`,
  );
  assert(!/^\s*$/.test(r.err), "the fail-open path is never silent");
  noNetworkMessage = r.err;
}

// --- fetched, but the comparison itself failed --------------------------------
//
// A different cause, so a different message (L11): the reader who sees this has
// a working network and a repository problem, and the two remedies differ.
{
  const r = runGuard("feat/some-work", { cherryExit: 128, cherryOut: "" });
  assert(r.code === 0, "an unreadable comparison does not block the push");
  assert(/nothing checked/i.test(r.err), "and it too says nothing was checked");
  unreadableMessage = r.err;
}
assert(
  noNetworkMessage !== "" && unreadableMessage !== "" && noNetworkMessage !== unreadableMessage,
  "an unreachable origin and an unreadable comparison do not share their wording",
);

// --- the override -------------------------------------------------------------
{
  const r = runGuard("feat/some-work", {
    cherryOut: DUPLICATE_COMMITS,
    env: { ALLOW_STALE_MAIN: "1" },
  });
  assert(r.code === 0, "the documented override lets the push through");
  assert(r.gitCalls.length === 0, "and costs no fetch at all");
}
{
  // Only that exact value, so a stray truthy string cannot silently disarm it.
  const r = runGuard("feat/some-work", {
    cherryOut: DUPLICATE_COMMITS,
    env: { ALLOW_STALE_MAIN: "true" },
  });
  assert(r.code === 1, "anything other than 1 leaves the gate armed");
}

// --- branches the guard has nothing to say about ------------------------------
{
  const r = runGuard("main", { cherryOut: DUPLICATE_COMMITS });
  assert(r.code === 0 && r.gitCalls.length === 0, "main itself is never compared against main");
}
{
  // A detached HEAD has no branch name, and the hook passes the empty string.
  const r = runGuard("", { cherryOut: DUPLICATE_COMMITS });
  assert(r.code === 0 && r.gitCalls.length === 0, "an empty branch name is left alone");
}

// --- the hook actually calls it -----------------------------------------------
//
// The decision being correct is worth nothing if nothing invokes it. A guard
// that never runs is indistinguishable from no guard (L65).
{
  const hook = readFileSync(join(repoRoot, ".githooks/pre-push"), "utf8");
  assert(
    /stale-main-guard\.sh/.test(hook),
    "the pre-push hook invokes the stale-main guard",
  );
  assert(
    /stale-main-guard\.sh"?\s+"\$branch"/.test(hook),
    "and hands it the branch name, which is what it decides on",
  );
  assert(
    /ALLOW_STALE_MAIN/.test(hook),
    "and the hook documents the override beside the others",
  );
}

// --- the playbook that states the rule names its enforcement ------------------
//
// AGENTS.md stated this rule for months with nothing enforcing it, which is how
// it was broken twice in one day. A rule that lives only in a document is a hope
// (L27), so the document must now point at the guard and its override.
{
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert(
    /stale-main-guard\.sh/.test(agents),
    "AGENTS.md names the guard that enforces the merge-base rule",
  );
  assert(/ALLOW_STALE_MAIN/.test(agents), "and names its override");
}

finish();
