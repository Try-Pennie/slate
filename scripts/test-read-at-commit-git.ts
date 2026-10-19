// #3854: `readAtCommit` against REAL git, in a checkout made the way the deploy job's is.
//
// scripts/test-object-worker-skip.ts drives `readAtCommit` through a fake git written to
// answer "the way CI did". A fake encodes its author's belief about git, and the belief
// is the thing that was wrong the first time: the older line check shipped in #3838 sure
// that `git fetch origin <commit>` would fetch the serving commit, and on its first
// production deploy (CI run 38974803936, deploy job log lines 501 to 504) git answered
// `fatal: couldn't find remote ref f911f9ef0076`, because the commit tag is a 12
// character abbreviation and a server answers a fetch only for a full object id.
//
// So this builds the checkout with the commands actions/checkout ran in that job (read off
// its log: `git init`, `git remote add origin`, a `--depth=1` fetch of one sha into
// refs/remotes/origin/main, `git checkout --force -B main`), against an origin in a temp
// directory reached over file:// (a plain path would ignore --depth), and asks real git.
// Its first assertion is the control: the pre-#3858 fetch must FAIL here exactly as it
// did in CI, or this fixture is not the condition it claims to reproduce (L1).
//
// No network, and nothing is written to the tree: both repositories live under one
// mkdtemp directory removed at the end (scripts/test-no-tree-writes.ts).
//
// Run: node --experimental-strip-types scripts/test-read-at-commit-git.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { protocolFromSource, readAtCommit, type GitRun } from "./lib/object-worker-skip.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SOURCE_DIR = "src/lib/booking";
const SOURCE_PATH = `${SOURCE_DIR}/confirm-line-object.ts`;
const root = mkdtempSync(join(tmpdir(), "slate-read-at-commit-"));

// The machine's own git config (signing, url rewrites, a default branch) must not decide
// what this test sees, so every call reads none of it. And the pre-push hook's GIT_DIR
// must not reach it either, or these calls would act on the repository being pushed
// rather than their own cwd (#848, scripts/test-git-env-isolation.ts).
const gitEnv = {
  ...scrubbedGitEnv(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function run(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function must(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (!r.ok) throw new Error(`fixture: git ${args.join(" ")} failed: ${r.err}`);
  return r.out.trim();
}
/** The runner `liveAppProtocol` hands `readAtCommit`: stdout, or null on a non zero exit. */
function runnerIn(cwd: string): { git: GitRun; calls: string[] } {
  const calls: string[] = [];
  const git: GitRun = (args) => {
    calls.push(args.join(" "));
    const r = run(cwd, args);
    return r.ok ? r.out : null;
  };
  return { git, calls };
}

// --- origin: three commits on main, plus one on a branch that was deleted ------------
const origin = join(root, "origin");
mkdirSync(origin);
/** Commit the protocol source at `protocol` on origin's current branch; its sha. */
function commitProtocol(protocol: number, note: string): string {
  mkdirSync(join(origin, SOURCE_DIR), { recursive: true });
  writeFileSync(join(origin, SOURCE_PATH), `// ${note}\nexport const CONFIRM_LINE_PROTOCOL = ${protocol};\n`);
  must(origin, ["add", SOURCE_PATH]);
  must(origin, ["commit", "-q", "-m", note]);
  return must(origin, ["rev-parse", "HEAD"]);
}
must(origin, ["init", "-q", "-b", "main"]);
commitProtocol(1, "first");
const serving = commitProtocol(2, "the commit the live app was deployed from");
const head = commitProtocol(3, "the commit this deploy checks out");
must(origin, ["checkout", "-q", "-b", "gone"]);
const gone = commitProtocol(4, "a hand deployed branch, since deleted");
must(origin, ["checkout", "-q", "main"]);
must(origin, ["branch", "-q", "-D", "gone"]);
const originUrl = `file://${origin}`;

let n = 0;
/** A fresh checkout made by actions/checkout's own commands, at `sha`, one commit deep. */
function ciCheckout(sha: string, url = originUrl): string {
  const dir = join(root, `ci-${n++}`);
  mkdirSync(dir);
  must(dir, ["init", "-q", dir]);
  must(dir, ["remote", "add", "origin", url]);
  must(dir, ["-c", "protocol.version=2", "fetch", "-q", "--no-tags", "--prune", "--no-recurse-submodules", "--depth=1", "origin", `+${sha}:refs/remotes/origin/main`]);
  must(dir, ["checkout", "-q", "--force", "-B", "main", "refs/remotes/origin/main"]);
  return dir;
}
const abbrev = (sha: string) => sha.slice(0, 12);

try {
  // --- the control: this fixture IS the condition CI met --------------------------------
  {
    const dir = ciCheckout(head);
    eq(must(dir, ["rev-parse", "--is-shallow-repository"]), "true", "control: the checkout is shallow, as the deploy job's is");
    assert(!run(dir, ["show", `${abbrev(serving)}:${SOURCE_PATH}`]).ok, "control: the serving commit is not in it");
    const old = run(dir, ["fetch", "--no-tags", "origin", abbrev(serving)]);
    assert(!old.ok && /couldn't find remote ref/.test(old.err), `control: fetching the abbreviation fails exactly as it did in CI (${old.err.trim()})`);
  }

  // --- what the deploy job meets: an abbreviated tag, one commit deep ---------------------
  {
    const dir = ciCheckout(head);
    const { git, calls } = runnerIn(dir);
    const r = readAtCommit(git, abbrev(serving), SOURCE_PATH);
    assert("source" in r, `an abbreviated serving commit is read from a depth 1 checkout (${JSON.stringify(r)}; git ran: ${calls.join(" | ")})`);
    eq(protocolFromSource("source" in r ? r.source : null), 2, "and it is the serving commit's protocol, not the checked out one's");
  }
  {
    const dir = ciCheckout(head);
    const { git, calls } = runnerIn(dir);
    const r = readAtCommit(git, serving, SOURCE_PATH);
    eq(protocolFromSource("source" in r ? r.source : null), 2, `a full serving commit is read too (git ran: ${calls.join(" | ")})`);
    eq(must(dir, ["rev-parse", "--is-shallow-repository"]), "true", "and fetching it one deep leaves the checkout shallow");
  }
  {
    const dir = ciCheckout(serving);
    const { git, calls } = runnerIn(dir);
    const r = readAtCommit(git, abbrev(serving), SOURCE_PATH);
    eq(protocolFromSource("source" in r ? r.source : null), 2, "the serving commit being the one checked out is read with no fetch");
    assert(!calls.some((c) => c.startsWith("fetch")), `and nothing is fetched (git ran: ${calls.join(" | ")})`);
  }

  // --- every way it still cannot be read says which, with real git's answers (L11) -------
  {
    const dir = ciCheckout(head);
    const r = readAtCommit(runnerIn(dir).git, abbrev(gone), SOURCE_PATH);
    assert("unreadable" in r && /no branch/.test(r.unreadable), `a commit on no branch origin has says so (${JSON.stringify(r)})`);
  }
  {
    const dir = ciCheckout(head);
    must(dir, ["remote", "set-url", "origin", `file://${join(root, "no-such-origin")}`]);
    const r = readAtCommit(runnerIn(dir).git, abbrev(serving), SOURCE_PATH);
    assert("unreadable" in r && /fetch/.test(r.unreadable) && /failed/.test(r.unreadable), `an origin that cannot be reached says the fetch failed (${JSON.stringify(r)})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

finish();
