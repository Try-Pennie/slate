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

finish();
