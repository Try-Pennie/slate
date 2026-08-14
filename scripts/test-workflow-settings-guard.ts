// The pre-push wiring for the workflow-settings check (#1500).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-workflow-settings-guard.ts
//
// `scripts/test-workflow-settings-checker.ts` proves the CHECKER decides
// correctly. This proves the guard around it fires when it should and, just as
// importantly, does not fire when it should not: a gate that blocks every push
// gets skipped, and a gate that never runs is indistinguishable from no gate
// (L65).
//
// Driven through the real shell script with stub `pnpm` and `gh` on PATH, so
// nothing here re-implements the logic it is checking.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, finish } from "./lib/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(repoRoot, ".githooks/lib/workflow-settings-guard.sh");

interface Run {
  code: number;
  err: string;
  /** Whether the stub checker was actually invoked, which no exit code reveals. */
  ran: boolean;
}

/**
 * @param changed newline separated paths this push touches
 * @param checkerExit what the stub `pnpm check:workflow-settings` returns
 * @param withGh false puts NO gh on PATH at all
 */
function runGuard(
  changed: string,
  checkerExit: number,
  opts: { withGh?: boolean; env?: Record<string, string> } = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), "wf-guard-"));
  const marker = join(dir, "ran");
  try {
    // The stub touches a marker file, so "the checker ran" is observable
    // independently of the guard's exit code. Without it, a guard that skipped
    // and a guard that ran a passing checker are the same exit 0 (L1).
    // The marker is written with a shell REDIRECT, not `touch`: PATH is isolated
    // to this directory, so an external command inside the stub would not be
    // found and the stub would silently fail to record that it ran.
    writeFileSync(
      join(dir, "pnpm"),
      `#!/bin/sh\n: > '${marker}'\necho 'stub checker output'\nexit ${checkerExit}\n`,
    );
    chmodSync(join(dir, "pnpm"), 0o755);
    if (opts.withGh !== false) {
      writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, "gh"), 0o755);
    }
    // PATH is REPLACED by this ONE directory, so a real gh or pnpm elsewhere can
    // never answer for the stubs. That matters more than it looks: a CI runner
    // has gh at /usr/bin, so keeping the system path on the "gh is absent" case
    // let the real gh answer and the case tested nothing (L141). The externals
    // the guard genuinely needs are symlinked in instead of borrowing a whole
    // system directory.
    for (const tool of ["grep", "sh"]) {
      const real = spawnSync("/usr/bin/which", [tool], { encoding: "utf8" }).stdout.trim();
      if (!real) throw new Error(`could not locate ${tool}, so this test cannot isolate PATH`);
      symlinkSync(real, join(dir, tool));
    }
    // bash by ABSOLUTE path: it is not on the isolated PATH either, and a
    // spawn that fails to find its own shell would report as the guard exiting
    // non-zero, which is indistinguishable from the guard blocking the push.
    const bash = spawnSync("/usr/bin/which", ["bash"], { encoding: "utf8" }).stdout.trim();
    if (!bash) throw new Error("could not locate bash");
    const r = spawnSync(bash, [guard, changed], {
      encoding: "utf8",
      env: { PATH: dir, ...(opts.env ?? {}) },
    });
    if (r.error) throw r.error;
    return {
      code: r.status ?? 1,
      err: `${r.stderr ?? ""}${r.stdout ?? ""}`,
      ran: existsSync(marker),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WORKFLOW_CHANGE = ".github/workflows/smoke-canary.yml\nsrc/lib/booking/core.ts";
const NO_WORKFLOW_CHANGE = "src/lib/booking/core.ts\ndocs/api.md";

// --- a workflow changed and a reference is missing: blocked --------------------
{
  const r = runGuard(WORKFLOW_CHANGE, 1);
  assert(r.ran, "the checker is actually run when a workflow changed");
  assert(r.code === 1, `and a failing checker blocks the push (exit ${r.code})`);
  assert(r.err.includes("stub checker output"), "the checker's own findings are shown, not swallowed");
  assert(
    /empty string/i.test(r.err),
    "and the guard says why it matters, since GitHub reports no error of its own",
  );
  assert(
    r.err.includes("SKIP_WORKFLOW_SETTINGS_CHECK=1"),
    "and names the deliberate, visible way past it",
  );
}

// --- a workflow changed and everything exists: through ------------------------
{
  const r = runGuard(WORKFLOW_CHANGE, 0);
  assert(r.ran, "the checker runs");
  assert(r.code === 0, "and a passing checker lets the push through");
  assert(r.err.trim() === "", `quietly (got ${JSON.stringify(r.err)})`);
}

// --- no workflow touched: not run at all --------------------------------------
//
// The half that keeps this gate acceptable. Every ordinary push would otherwise
// pay a GitHub round trip for a file it did not change.
{
  const r = runGuard(NO_WORKFLOW_CHANGE, 1);
  assert(r.code === 0, "a push that touches no workflow is never blocked");
  assert(!r.ran, "and the checker is not even run");
}
{
  // An empty diff (a first push with no upstream) is the same case.
  const r = runGuard("", 1);
  assert(r.code === 0 && !r.ran, "an empty change list runs nothing and blocks nothing");
}

// --- a path that merely MENTIONS the directory is not a workflow change -------
{
  const r = runGuard("docs/.github/workflows-notes.md\nREADME.md", 1);
  assert(r.code === 0 && !r.ran, "the match is anchored to the real workflows directory");
}

// --- gh absent: fails open, but SAYS so ---------------------------------------
//
// Blocking every push made without gh auth would be worse than the gap. Silence
// would be worse still: a permanently unauthenticated machine would look exactly
// like a clean run (L98).
{
  const r = runGuard(WORKFLOW_CHANGE, 1, { withGh: false });
  assert(r.code === 0, "no gh does not block the push");
  assert(!r.ran, "and the checker is not run, since it could not work");
  assert(
    /nothing verified/i.test(r.err),
    `but it says nothing was verified (got ${JSON.stringify(r.err)})`,
  );
}

// --- the override -------------------------------------------------------------
{
  const r = runGuard(WORKFLOW_CHANGE, 1, { env: { SKIP_WORKFLOW_SETTINGS_CHECK: "1" } });
  assert(r.code === 0 && !r.ran, "the documented override skips it entirely");
}
{
  // And only that exact value, so a stray truthy string does not silently disarm it.
  const r = runGuard(WORKFLOW_CHANGE, 1, { env: { SKIP_WORKFLOW_SETTINGS_CHECK: "true" } });
  assert(r.code === 1 && r.ran, "anything other than 1 leaves the gate armed");
}

// --- an UNREADABLE diff runs the check, it does not skip it -------------------
//
// The caller passes the literal "UNKNOWN" when `git diff` failed (no upstream
// yet, a detached HEAD). An unreadable diff and a push that touched no workflow
// would otherwise be the same empty string, and the skip would be silent, which
// is the shape #1436 exists to catch.
{
  const r = runGuard("UNKNOWN", 1);
  assert(r.ran, "an unreadable diff still runs the check");
  assert(r.code === 1, "and a failing checker still blocks");
}
{
  const r = runGuard("UNKNOWN", 0);
  assert(r.ran && r.code === 0, "and a passing checker still lets it through");
}


finish();
