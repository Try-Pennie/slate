// Repo invariant (#113): the server-side merge-gap backstop must stay wired up.
//
// The local pre-push merge-gap guard (.githooks/pre-push) fails open (no gh, no
// hooksPath, non-interactive contexts). The .github/workflows/merge-gap.yml
// workflow is the backstop that cannot be bypassed by a missing local hook: it
// fires on a push to any non-main branch and fails when the branch already has a
// merged/closed PR and no open one. If this trigger or its fail step is deleted,
// the fail-open surface #113 flagged returns silently, so it is pinned here.
//
// It must ALSO stay cheap: it must not run the full pipeline (that would bring
// back the #602 double-run alongside ci.yml's pull_request trigger).
// Run: node --experimental-strip-types scripts/test-merge-gap-workflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import { mergeGapVerdict } from "./lib/merge-gap.ts";

const ROOT = join(import.meta.dirname, "..");
const wf = readFileSync(join(ROOT, ".github", "workflows", "merge-gap.yml"), "utf8");

// Fires on push to non-main branches (the contexts the local hook misses). A
// merged/closed-PR branch push does not trigger ci.yml (push there is main-only),
// so this needs its own push trigger.
assert(
  /on:\s*\n\s+push:\s*\n\s+branches-ignore:\s*\n\s+-\s*main\b/.test(wf),
  "#113: merge-gap fires on push to every non-main branch (branches-ignore: main)",
);

// #1436: the decision moved out of the `run:` block and into a script with a
// suite, because inside YAML "no pull request" and "could not read the pull
// requests" were the same empty string, and the second one exited 0.
//
// These two assertions used to grep the YAML for `exit 1` and for the literal
// `MERGED|CLOSED` regex. That pins the RENDERING rather than the rule (L103): the
// strings could be present while the guard did nothing, and the same guard written
// differently would fail the check while behaving correctly. They now assert the
// wiring here and the BEHAVIOUR through the real decision function, with the full
// set of cases in scripts/test-merge-gap.ts.
assert(
  /scripts\/check-merge-gap\.ts/.test(wf),
  "#113: the workflow runs the merge-gap check (whose decision has its own suite)",
);
assert(
  !mergeGapVerdict({ ok: true, states: ["MERGED"] }, "b").ok,
  "#113: the guard really fails when the branch's PR is merged, so a push there strands",
);
assert(
  mergeGapVerdict({ ok: true, states: ["MERGED", "OPEN"] }, "b").ok,
  "#113: and really allows an open PR on the branch, which is a live route to main",
);
assert(
  !mergeGapVerdict({ ok: false, reason: "gh down" }, "b").ok,
  "#1436: and fails rather than passing when it could not read the pull requests at all",
);

// Cheap-only: it must NOT invoke the full pipeline (no build/test), or it would
// reintroduce the #602 double-run on every PR-branch push.
assert(
  !/cf:build|pnpm test|tsc --noEmit/.test(wf),
  "#602/#113: the backstop stays a lightweight API check, not the full pipeline",
);

// Needs PR read access for `gh pr list`.
assert(
  /permissions:[\s\S]*pull-requests:\s*read/.test(wf),
  "the workflow grants pull-requests: read for gh pr list",
);

finish();
