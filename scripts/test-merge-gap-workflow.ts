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

const ROOT = join(import.meta.dirname, "..");
const wf = readFileSync(join(ROOT, ".github", "workflows", "merge-gap.yml"), "utf8");

// Fires on push to non-main branches (the contexts the local hook misses). A
// merged/closed-PR branch push does not trigger ci.yml (push there is main-only),
// so this needs its own push trigger.
assert(
  /on:\s*\n\s+push:\s*\n\s+branches-ignore:\s*\n\s+-\s*main\b/.test(wf),
  "#113: merge-gap fires on push to every non-main branch (branches-ignore: main)",
);

// It must actually fail (non-zero) on the strand condition, not just log.
assert(/exit 1/.test(wf), "#113: the guard fails (exit 1) when the branch strands");

// It distinguishes merged/closed from an open PR (an open PR on the branch is fine).
assert(
  /MERGED\|CLOSED/.test(wf) && /\^OPEN\$/.test(wf),
  "#113: it blocks MERGED/CLOSED but allows an OPEN PR on the branch",
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
