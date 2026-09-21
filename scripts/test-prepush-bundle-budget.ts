// The pre-push gate weighs the client bundle where Slate actually builds it (#2571).
//
// A global pre-push guard (~/.claude/hooks/check-bundle-budget.sh) weighs the
// gzipped client chunks from the build output in the CHECKOUT and refuses growth
// past 3% and 10 KB over a recorded total. Slate's gate builds in an isolated
// worktree (#490), never in the checkout, so the checkout's build is always older
// than the commit being pushed and that guard says "build is stale, nothing
// judged" on every Slate push: inert here while reading as installed.
//
// So the hook calls the same measurer itself, against the isolated tree, right
// after the Cloudflare build's `wait` succeeds and before the tree is removed.
// This file pins the properties of that step which nothing else would notice
// losing, by reading the hook's text:
//
// 1. The call is PRESENT and sits after the build's verdict and before the
//    script's final exit (the tree is removed by the EXIT trap, so "before the
//    last exit" is "while the tree still exists").
// 2. It keys the record the way the global guard does: the same state directory
//    default and the same `--remote` keying, so the two can never hold two
//    budgets for one repository.
// 3. A machine without the shared measurer gets a PRINTED skip saying the bundle
//    was not weighed, never a silent pass (L98) and never a refusal.
// 4. Both overrides are honoured by the names the global guard uses, and a
//    measurer exit of 2 fails the push like any other gate leg.
// 5. It is not backgrounded (it needs the finished build), which
//    test-prepush-overlap.ts also enforces through its "exactly one backgrounded
//    command" count.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-prepush-bundle-budget.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const HOOK_PATH = join(ROOT, ".githooks", "pre-push");
const hook = readFileSync(HOOK_PATH, "utf8");

// The default the global guard uses, spelled the way it spells it. The whole
// point of the step is that both write ONE record file, so the literal is
// asserted here and, where the global guard is installed, cross-checked against
// its own text below.
const STATE_DIR_DEFAULT = '"${BUNDLE_BUDGET_STATE_DIR:-$HOME/.claude/state/bundle-budget}"';
const MEASURER = "bundle-budget.py";

/** Every assertion about the step, over some hook text, so the positive controls
 *  below can re-run them against text where the answer is known to be wrong. */
function judge(text: string): { failures: string[] } {
  const failures: string[] = [];
  const demand = (cond: boolean, why: string) => {
    if (!cond) failures.push(why);
  };

  // --- 1. the measurer is called, after the build verdict, before the last exit ---
  const callAt = text.search(/python3 "\$measurer"[^\n]*--repo "\$tree"/);
  demand(callAt >= 0, `the hook calls the shared measurer (${MEASURER}) against the isolated tree`);
  demand(
    /measurer="\$HOME\/\.claude\/hooks\/lib\/bundle-budget\.py"/.test(text),
    "the measurer path is the shared one under $HOME/.claude/hooks/lib, not a repo copy",
  );
  const waitAt = text.indexOf('if ! wait "$build_pid"; then');
  demand(waitAt >= 0, "the build is still waited on");
  demand(callAt > waitAt, "the measurer runs AFTER the build's wait, since it needs the finished build");
  const lastExit = text.lastIndexOf("\nexit 0");
  demand(lastExit > callAt, "the measurer runs BEFORE the hook's final exit, while the isolated tree still exists");
  // The tree is removed by the EXIT trap only. If a removal were added inline
  // before the call, the measurer would read an empty directory and report "no
  // client build output", a skip that would look like a machine without a build.
  const removals = [...text.matchAll(/git worktree remove/g)].map((m) => m.index ?? -1);
  demand(removals.length === 1, `the tree is removed in exactly one place (found ${removals.length})`);
  const cleanupAt = text.indexOf("cleanup() {");
  const trapAt = text.indexOf("trap cleanup EXIT");
  demand(
    cleanupAt >= 0 && trapAt > cleanupAt && removals.every((r) => r > cleanupAt && r < trapAt),
    "the one removal is inside cleanup(), which runs on EXIT, so nothing removes the tree before the measurer reads it",
  );

  // --- 2. one record, keyed like the global guard's -----------------------------
  demand(
    text.includes(`state_dir=${STATE_DIR_DEFAULT}`) && /--state-dir "\$state_dir"/.test(text),
    `the call passes --state-dir with the global guard's default, spelled as the guard spells it (state_dir=${STATE_DIR_DEFAULT})`,
  );
  demand(
    /remote="\$\(git -C "\$root" remote get-url origin[^\n]*\)"/.test(text) && /--remote "\$remote"/.test(text),
    "the record is keyed by the origin remote URL, the same key the global guard uses",
  );
  demand(
    /head_time="\$\(git show -s --format=%ct "\$pushed_sha"[^\n]*\)"/.test(text) && /--head-time "\$head_time"/.test(text),
    "the freshness check is against the PUSHED commit's time, not the checkout's HEAD",
  );

  // --- 3. a missing measurer is a printed skip, not a silent pass ---------------
  const missing = text.match(/if \[ ! -f "\$measurer" \]; then\n([\s\S]*?)\n\s*fi\n/);
  demand(missing !== null, "the hook tests whether the shared measurer file exists");
  const missingBody = missing?.[1] ?? "";
  demand(
    /echo "[^"]*not weighed[^"]*"[^\n]*>&2/.test(missingBody),
    'the missing-measurer branch PRINTS a skip on stderr saying the bundle was "not weighed"',
  );
  demand(/measurer/.test(missingBody.replace(/echo "[^"]*"/g, "")) || /\$measurer/.test(missingBody),
    "the skip names the file it looked for, so the reader knows what is absent");
  demand(
    !/\bexit\b/.test(missingBody),
    "the missing-measurer branch does not exit the hook (it returns from the step so the rest of the gate still counts)",
  );
  demand(/return 0/.test(missingBody), "the missing-measurer branch stands down explicitly with return 0");
  // The same shape for a missing interpreter. The global guard REFUSES on this
  // (L490) and runs before this hook on any machine that has it, so a push on a
  // machine with the measurer and no python3 never reaches here; the branch is
  // for the machine that has neither hook wired, where a refusal would be a gate
  // with no owner. It still prints.
  const noPython = text.match(/if ! command -v python3 >\/dev\/null 2>&1; then\n([\s\S]*?)\n\s*fi\n/);
  demand(noPython !== null, "the hook tests whether python3 is on PATH before calling the measurer");
  demand(
    /echo "[^"]*not weighed[^"]*"[^\n]*>&2/.test(noPython?.[1] ?? ""),
    "the missing-python3 branch prints a skip saying the bundle was not weighed",
  );

  // --- 4. the overrides, by the global guard's names, and exit 2 fails the push -
  demand(/SKIP_BUNDLE_BUDGET_CHECK/.test(text), "SKIP_BUNDLE_BUDGET_CHECK is honoured by name");
  demand(/ACCEPT_BUNDLE_GROWTH/.test(text), "ACCEPT_BUNDLE_GROWTH is honoured by name");
  demand(
    /\[ "\$\{ACCEPT_BUNDLE_GROWTH:-\}" = "1" \] && accept="--accept"/.test(text),
    "ACCEPT_BUNDLE_GROWTH=1 passes --accept to the measurer, which is how the record is raised",
  );
  const skipBranch = text.match(/if \[ "\$\{SKIP_BUNDLE_BUDGET_CHECK:-\}" = "1" \]; then\n([\s\S]*?)\n\s*fi\n/);
  demand(
    /echo "[^"]*not weighed[^"]*"[^\n]*>&2/.test(skipBranch?.[1] ?? ""),
    "SKIP_BUNDLE_BUDGET_CHECK=1 also prints that the bundle was not weighed (a skip that prints nothing is a pass)",
  );
  const verdict = text.slice(callAt);
  demand(
    /\n\s*2\)\n[\s\S]{0,900}?exit 1/.test(verdict),
    "a measurer exit of 2 (grew past both margins) fails the push with exit 1",
  );
  demand(
    /ACCEPT_BUNDLE_GROWTH=1 git push/.test(verdict) && /SKIP_BUNDLE_BUDGET_CHECK=1 git push/.test(verdict),
    "the refusal prints both override hints in the global guard's shape",
  );
  demand(
    /printf '%s\\n' "\$out"/.test(verdict),
    "the refusal prints the measurer's own lines (what grew and the five largest chunks) rather than paraphrasing them",
  );
  demand(
    /\n\s*\*\)\n[\s\S]{0,400}?not judged[\s\S]{0,200}?return 0/.test(verdict),
    "any other measurer exit is a printed 'not judged' skip, matching how the global guard fails open",
  );

  // --- the capture survives set -e (L612) --------------------------------------
  // `out="$(cmd)"; rc=$?` dies on the assignment under set -e before rc is read,
  // so a refusing measurer would kill the hook with no verdict printed.
  demand(
    /rc=0\n\s*out="\$\(python3 "\$measurer"[\s\S]{0,300}?\)" \|\| rc=\$\?/.test(text),
    "the measurer's exit status is captured with `|| rc=$?`, so a non-zero exit reaches the case statement under set -e",
  );

  // --- 5. not backgrounded -----------------------------------------------------
  demand(
    !/python3 "\$measurer"[^\n]*&$/m.test(text),
    "the measurer is not backgrounded: it needs the finished build and its verdict must be read",
  );
  const stepHeader = text.indexOf("# --- 2b. Bundle weight");
  demand(
    stepHeader >= 0 && stepHeader < callAt && /critical path/.test(text.slice(stepHeader, callAt)),
    "the step's comment says it sits on the critical path after the build (a second or two per push)",
  );

  return { failures };
}

// --- the real hook ------------------------------------------------------------
{
  const { failures } = judge(hook);
  for (const f of failures) assert(false, f);
  assert(failures.length === 0, `the pre-push hook weighs the bundle as #2571 requires (${failures.length} gaps)`);
}

// --- the default matches the installed global guard, where one is installed -----
//
// CI has no ~/.claude, so this can only be measured on a machine that has the
// guard. Where it is absent the literal above is all that is checked, and that
// is said rather than counted as agreement (L98).
{
  const globalGuard = join(homedir(), ".claude", "hooks", "check-bundle-budget.sh");
  if (existsSync(globalGuard)) {
    const guardText = readFileSync(globalGuard, "utf8");
    const line = guardText.split("\n").find((l) => /^state_dir=/.test(l)) ?? "";
    assert(
      line.includes(STATE_DIR_DEFAULT),
      `the installed global guard's state_dir default is the one the hook passes (guard line: ${line.trim() || "none found"})`,
    );
    assert(
      /--remote "\$remote"/.test(guardText) && /git remote get-url origin/.test(guardText),
      "the installed global guard keys its record by the origin remote URL too, so both write one file",
    );
  } else {
    assert(true, "no global guard installed here, so the state dir default was checked against the literal only");
  }
}

// --- positive controls: the checks above can fail (L1) ---------------------------
{
  const stripped = hook.replace(/python3 "\$measurer"/g, "python3 removed");
  assert(judge(stripped).failures.length > 0, "a hook with no measurer call fails");

  // Move the call block before the wait: swap the two by cutting the whole step
  // out and pasting it above the wait line.
  const stepStart = hook.indexOf("bundle_budget_check() {");
  const stepEnd = hook.indexOf("\nbundle_budget_check\n");
  const waitAt = hook.indexOf('if ! wait "$build_pid"; then');
  if (stepStart >= 0 && stepEnd > stepStart && waitAt >= 0 && waitAt < stepStart) {
    const step = hook.slice(stepStart, stepEnd + "\nbundle_budget_check\n".length);
    const without = hook.slice(0, stepStart) + hook.slice(stepEnd + "\nbundle_budget_check\n".length);
    const moved = without.slice(0, waitAt) + step + without.slice(waitAt);
    assert(
      judge(moved).failures.some((f) => /AFTER the build's wait/.test(f)),
      "a hook that weighs before the build is waited on fails the ordering check",
    );
  } else {
    assert(false, "the step is shaped as a bundle_budget_check function called after the wait, so the ordering control can be built");
  }

  const silentSkip = hook.replace(
    /if \[ ! -f "\$measurer" \]; then\n[\s\S]*?\n(\s*)fi\n/,
    'if [ ! -f "$measurer" ]; then\n    exit 0\n$1fi\n',
  );
  assert(
    judge(silentSkip).failures.some((f) => /not weighed/.test(f)) &&
      judge(silentSkip).failures.some((f) => /does not exit/.test(f)),
    "a hook whose missing-measurer branch exits 0 silently fails both the printed-skip and the no-exit checks",
  );

  const wrongDir = hook.replace(STATE_DIR_DEFAULT, '"$HOME/.cache/slate-bundle"');
  assert(judge(wrongDir).failures.some((f) => /--state-dir/.test(f)), "a hook with its own state directory fails");

  const noAccept = hook.replace(/ACCEPT_BUNDLE_GROWTH/g, "ACCEPT_GROWTH");
  assert(judge(noAccept).failures.some((f) => /ACCEPT_BUNDLE_GROWTH/.test(f)), "a hook that renames the accept override fails");

  const passOnGrowth = hook.replace(/(\n\s*2\)\n[\s\S]{0,900}?)exit 1/, "$1return 0");
  assert(
    judge(passOnGrowth).failures.some((f) => /exit of 2/.test(f)),
    "a hook that lets a measurer exit of 2 through fails",
  );

  const semicolonCapture = hook.replace(/\)" \|\| rc=\$\?/, ')"; rc=$?');
  assert(
    judge(semicolonCapture).failures.some((f) => /rc=\$\?/.test(f)),
    "a hook capturing the exit with `; rc=$?` (dead under set -e) fails",
  );
}

finish();
