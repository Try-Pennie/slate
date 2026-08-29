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

// --- #1592: the parallel split hides behind ONE fan-in check named `ci` ------
// The pipeline is split into independent legs that run in parallel, but the
// outside world still reads a single check. Two consumers depend on that name
// LITERALLY and neither is in this file:
//   - .github/workflows/main-push-guard.yml resolves whether a merge was green by
//     selecting `.check_runs[] | select(.name == "ci")` on the PR head (twice);
//   - the deploy job below gates on `needs: [ci, ...]`.
// So the fan-in job's key must stay `ci`, and it must FAIL when any leg fails.
const jobsBlock = ci.match(/^jobs:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
assert(jobsBlock.trim().length > 0, "ci.yml has a `jobs:` block");

const jobNames = [...jobsBlock.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
assert(jobNames.length > 0, "the jobs in ci.yml are readable");
assert(jobNames.includes("ci"), "#1592: a job literally named `ci` still exists (main-push-guard selects that check name)");

/**
 * The text of one job, from its key to the next top-level job key (or EOF).
 * Line-based rather than a regex: every job key sits at the same two-space
 * indent as the lines inside its neighbours, so an `(?:[ \t]+.*\n)*` block
 * match runs to the end of the file and hands back every job at once.
 */
function jobBlock(name: string): string {
  const lines = jobsBlock.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[\w-]+:$/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const fanIn = jobBlock("ci");
const needsLine = fanIn.match(/^\s*needs:\s*(.+)$/m)?.[1] ?? "";
const fanInNeeds = [...needsLine.matchAll(/[\w-]+/g)].map((m) => m[0]);
assert(fanInNeeds.length > 0, "#1592: the `ci` job is a fan-in with a `needs` list");

// Jobs deliberately OUTSIDE the gate, each with the reason it is out. Anything
// not listed here and not in the fan-in's needs fails this guard, so a job added
// later is covered by construction rather than silently falling out of the gate
// (L96: a guard driven by a hand-written registry checks only what the registry
// lists). The reason is required, so an exemption is a decision and not a
// default (L129, L233).
const FAN_IN_EXEMPT: Record<string, string> = {
  ci: "the fan-in itself",
  deploy: "runs AFTER the gate (needs: [ci, migration-drift]), it is not one of its legs",
  "migration-drift": "gates the deploy directly and is skipped on dependabot PRs, so it cannot be a leg of a check that must conclude on every PR",
  coverage: "report-only (#603); a coverage blip must never block a merge",
  "security-scan": "detective by design (#1042): its rule packs are fetched at run time, so a newly published rule must not block a deploy",
};

for (const name of jobNames) {
  const gated = fanInNeeds.includes(name);
  const exempt = Object.prototype.hasOwnProperty.call(FAN_IN_EXEMPT, name);
  assert(
    gated || exempt,
    `#1592: job \`${name}\` is either a leg of the \`ci\` fan-in or listed in FAN_IN_EXEMPT with a reason (a new job must not silently fall outside the gate)`,
  );
  assert(
    !(gated && exempt),
    `#1592: job \`${name}\` is both a leg of the fan-in and listed as exempt; the exemption is stale`,
  );
}
for (const name of Object.keys(FAN_IN_EXEMPT)) {
  assert(
    jobNames.includes(name),
    `#1592: FAN_IN_EXEMPT names \`${name}\`, which is not a job in ci.yml (a renamed or deleted job must not leave a stale exemption standing)`,
  );
  assert(
    FAN_IN_EXEMPT[name].trim().length > 0,
    `#1592: the exemption for \`${name}\` states why it is outside the gate`,
  );
}
for (const leg of fanInNeeds) {
  assert(
    jobNames.includes(leg),
    `#1592: the fan-in needs \`${leg}\`, which is a job that exists (a typo in needs makes the gate wait on nothing)`,
  );
}

// THE ONE THAT MATTERS. Without `if: always()` the fan-in is SKIPPED the moment a
// leg fails, and a skipped check is not a failed one: main-push-guard's jq reads
// it as "null" (unknown), which the classifier deliberately tolerates. A red PR
// would then merge with the guard saying nothing.
assert(
  /^\s*if:\s*always\(\)\s*$/m.test(fanIn),
  "#1592: the fan-in runs `if: always()`, so a failed leg produces a FAILED check rather than a skipped one",
);
// ...and `always()` alone passes green regardless, so the job must actually judge
// the legs. Derived from `needs.*.result`, never a hand-listed set of job names,
// or adding a leg would leave it unjudged (L41).
assert(
  /needs\.\*\.result/.test(fanIn),
  "#1592: the fan-in judges its legs via `needs.*.result` (derived from the needs list, so a new leg is judged without editing the check)",
);
assert(
  /exit 1/.test(fanIn),
  "#1592: the fan-in exits non-zero when a leg did not succeed",
);
assert(
  /!=\s*"success"/.test(fanIn) || /!=\s*'success'/.test(fanIn),
  "#1592: the fan-in requires each leg to be exactly `success`, so a skipped or cancelled leg is not read as a pass",
);

// The deploy still hangs off the fan-in, so a broken leg cannot ship.
assert(
  /needs:\s*\[[^\]]*\bci\b[^\]]*\]/.test(jobBlock("deploy")),
  "#1592: deploy still needs the `ci` fan-in (and so, transitively, every leg)",
);

// --- the guard's literal check name, read from the guard itself --------------
// The coupling is across two files, so assert it from the OTHER side rather than
// restating the string here: a rename in ci.yml with the guard left alone is
// exactly the failure this pins.
const guard = readFileSync(
  join(ROOT, ".github", "workflows", "main-push-guard.yml"),
  "utf8",
);
const guardNames = [...guard.matchAll(/select\(\.name == "([\w-]+)"\)/g)].map((m) => m[1]);
assert(
  guardNames.length >= 2,
  "main-push-guard still resolves a merge's CI by check name (both the association and the claim route)",
);
for (const name of guardNames) {
  assert(
    jobNames.includes(name),
    `#1592: main-push-guard reads the check named \`${name}\`, which must be a job in ci.yml (otherwise the merge backstop reads a check that never reports)`,
  );
  assert(
    name === "ci" || fanInNeeds.includes(name),
    `#1592: the check \`${name}\` that main-push-guard trusts is the fan-in, so it covers every leg`,
  );
}


finish();
