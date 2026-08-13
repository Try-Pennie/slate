// Repo invariant (#602): CI must not run the whole pipeline twice per commit, and
// it must never cancel a run on main.
//
// `on: push` (unfiltered) + `on: pull_request` meant every PR commit ran typecheck,
// lint, ~126 node suites, vitest AND the full OpenNext build TWICE: once for the
// branch push, once for the PR. Doubled Actions minutes, doubled flaky exposure,
// slower feedback.
//
// The fix is easy to undo by accident (deleting one line of YAML brings the double
// run straight back), and the cancellation half is genuinely dangerous to get wrong:
// a run on `main` is what DEPLOYS to production, so cancelling one could interrupt a
// deploy mid-flight. Both are pinned here.
// Run: node --experimental-strip-types scripts/test-ci-workflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

// The `on:` block, up to the next top-level key.
const onBlock = ci.match(/^on:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
assert(onBlock.trim().length > 0, "ci.yml has an `on:` trigger block");

// --- no double run -------------------------------------------------------
// A bare `push:` with no branch filter fires on every branch, which is what
// duplicated the pipeline alongside `pull_request`.
const pushFiltered = /push:\s*\n\s+branches:\s*\n\s+-\s*main\b/.test(onBlock);
assert(
  pushFiltered,
  "#602: `push` is restricted to main (an unfiltered push re-runs the whole pipeline on every PR commit)",
);
assert(
  /pull_request:/.test(onBlock),
  "PR branches are still covered by the pull_request trigger",
);

// --- main still deploys --------------------------------------------------
// Restricting push to main must not break the deploy, which is gated on a push to
// main. If push stopped firing on main, merges would silently stop deploying.
assert(
  /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/.test(ci),
  "the deploy job still triggers on a push to main (merges keep deploying)",
);

// --- cancellation, and the main exemption --------------------------------
const concurrency = ci.match(/^concurrency:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? "";
assert(concurrency.trim().length > 0, "#602: a concurrency group exists");
assert(
  /group:.*github\.ref/.test(concurrency),
  "the concurrency group is keyed on the ref (so one branch can't cancel another)",
);
// THE DANGEROUS ONE. `cancel-in-progress: true` (unconditional) would let a second
// merge cancel the first merge's IN-FLIGHT PRODUCTION DEPLOY. It must be an
// expression that exempts main.
assert(
  !/cancel-in-progress:\s*true\s*$/m.test(concurrency),
  "#602: cancel-in-progress is NOT an unconditional true (that would cancel a running deploy on main)",
);
assert(
  /cancel-in-progress:.*github\.ref != 'refs\/heads\/main'/.test(concurrency),
  "#602: cancellation is explicitly disabled on main, so a merge's deploy is never interrupted",
);

// --- migration-drift skips Dependabot PRs, but stays fail-loud elsewhere -----
// Dependabot PRs never touch supabase/migrations and never receive the repo
// secrets migration-drift needs, so the job can only false-fail there. It is
// skipped on dependabot/* PR branches so routine bumps go green and merge
// without the manual recreate-on-a-normal-branch dance. This must be scoped to
// dependabot ONLY: a blanket skip (or reintroducing the #766 `exit 0` on missing
// secrets) would let real drift merge unchecked on normal branches.
const migBlock =
  ci.match(/^  migration-drift:\n((?:[ \t]+.*\n|\n)*?)^  deploy:/m)?.[1] ?? "";
assert(migBlock.trim().length > 0, "the migration-drift job exists in ci.yml");
assert(
  /if:.*startsWith\(github\.head_ref,\s*'dependabot\//.test(migBlock),
  "migration-drift is skipped only on dependabot/* PR branches (head_ref is empty on push-to-main, so main still runs the real check)",
);
// #766 regression guard: the skip must not have weakened the fail-loud path.
// On any non-dependabot branch with missing secrets, the job must still exit 1
// rather than pass green having checked nothing.
assert(
  /-z "\$SUPABASE_ACCESS_TOKEN"/.test(migBlock) &&
    /::error::migration-drift cannot run/.test(migBlock) &&
    /exit 1/.test(migBlock),
  "#766: migration-drift still fails loud (exit 1) when its secrets are absent, so a non-dependabot branch can't pass green while verifying nothing",
);

// --- #1437: the CLI download gets a second attempt, and only a second -------
// The download hung up its socket three times in one afternoon and failed the
// job before any of our code ran, which skipped the deploy for a good commit.
// Actions has no native step retry, so this is a `continue-on-error` first
// attempt plus a second gated on its outcome. Both halves are asserted: the id
// without the gate would swallow a genuinely broken install and run the gate with
// no CLI at all.
const setupId = migBlock.match(/uses: supabase\/setup-cli@\S+.*\n\s+id: ([\w-]+)\n/)?.[1] ?? "";
assert(setupId.length > 0, "#1437: the first setup-cli attempt carries an id so its outcome can be read");
assert(
  /uses: supabase\/setup-cli@\S+.*\n\s+id: [\w-]+\n\s+continue-on-error: true/.test(migBlock),
  "#1437: the first setup-cli attempt is allowed to fail so a second can run",
);
assert(
  new RegExp(`if: steps\\.${setupId}\\.outcome == 'failure'`).test(migBlock),
  "#1437: the retry runs ONLY when the first attempt failed (never unconditionally)",
);
assert(
  (migBlock.match(/uses: supabase\/setup-cli@\S+/g) ?? []).length === 2,
  "#1437: exactly two install attempts, so a dead download still fails the job rather than retrying forever",
);
assert(
  !/continue-on-error/.test(migBlock.split("Retry the Supabase CLI install")[1] ?? ""),
  "#1437: the SECOND attempt is not continue-on-error, or a job with no CLI would carry on to the gate",
);

// --- #1437: the CLI calls live in the tested script, not in the run block ----
// The retry that stops a Supabase 502 failing a good commit has to sit where a
// suite can drive it. A bare `supabase link` back in the YAML would be that rule
// leaking back into a place nothing can test, which is the #1433 objection.
assert(
  /check-migration-drift\.ts[\s\\]+--project-ref\s+\w+/.test(migBlock),
  "#1437: the gate runs the script with the project ref, so link + list + retry are all inside it",
);
assert(
  !/^\s*supabase (link|migration)/m.test(migBlock),
  "#1437: no raw `supabase link` / `supabase migration list` in the run block (the retry would be untestable there)",
);
assert(
  !/\/tmp\/mig\.txt/.test(migBlock),
  "#1437: the tee-to-a-tempfile pipeline is gone (the script prints the table itself)",
);

finish();
