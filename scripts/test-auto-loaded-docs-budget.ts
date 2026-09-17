// #2393: nothing measured the size of the files this repo loads into every
// session, so they grew one paragraph at a time from 51,740 characters on
// 2026-08-29 to 157,721 on 2026-09-17 and no contributor could see the total.
//
// The ceiling that binds was MEASURED rather than assumed, and the measurement
// is written out in scripts/lib/auto-loaded-docs.ts: there is no per file cut a
// rules file can reach (a probe was read in full at 400,105 characters and
// still uncut at 2,000,043), and the real limit is the 200,000 token request,
// which the memory payload is counted inside.
//
// Run: node --experimental-strip-types scripts/test-auto-loaded-docs-budget.ts
import { join } from "node:path";
import {
  BUDGET_CHARS,
  CHARS_PER_TOKEN,
  REQUEST_TOKEN_LIMIT,
  collectAutoLoadedDocs,
  describeVerdict,
  judgeBudget,
} from "./lib/auto-loaded-docs.ts";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

// --- The real measurement -----------------------------------------------------

const docs = collectAutoLoadedDocs(root, "CLAUDE.md");
const verdict = judgeBudget(docs);

// A walk that found nothing, or that stopped at the entry file, reports zero
// characters and would read exactly like a healthy tree (L98).
assert(docs.length >= 2, `the walk follows @imports out of CLAUDE.md (found ${docs.length} files)`);
assert(
  docs.some((d) => d.path.endsWith("/AGENTS.md")),
  "the walk reaches AGENTS.md, which CLAUDE.md imports on its first line",
);
assert(verdict.totalChars > 10_000, `the walk read real content (${verdict.totalChars} characters)`);

console.log(describeVerdict(verdict, root));
assert(
  verdict.withinBudget,
  `the auto loaded docs fit the ${BUDGET_CHARS} character budget (${verdict.totalChars} characters, about ${verdict.estimatedTokens} tokens, ${verdict.shareOfRequestPct}% of the ${REQUEST_TOKEN_LIMIT} token request)`,
);

// --- Positive controls, both directions ---------------------------------------
// A budget check that has never been seen to refuse anything is a number in a
// file, not a guard (L1).

{
  const planted = [
    { path: "/fake/CLAUDE.md", chars: 1_000 },
    { path: "/fake/AGENTS.md", chars: BUDGET_CHARS },
  ];
  const refused = judgeBudget(planted);
  assert(!refused.withinBudget, "a planted oversize set is REFUSED");
  assert(refused.overBy === 1_000, `the refusal says how far over it is (${refused.overBy})`);
  assert(
    describeVerdict(refused, "/fake").includes("Move a runbook section into docs/"),
    "the refusal names the remedy rather than only the number",
  );
}

{
  const small = [{ path: "/fake/CLAUDE.md", chars: 10 }];
  assert(judgeBudget(small).withinBudget, "a small set PASSES, so the judge is not hard wired to refuse");
}

// The import walk has to be proved too: a resolver that silently followed
// nothing would make any file look small enough.
{
  const tree: Record<string, string> = {
    "/t/CLAUDE.md": "@AGENTS.md\n@docs/extra.md\n",
    "/t/AGENTS.md": "x".repeat(50),
    "/t/docs/extra.md": "y".repeat(7),
  };
  const walked = collectAutoLoadedDocs("/t", "CLAUDE.md", (p) => tree[p] ?? null);
  assert(walked.length === 3, `the walk follows every @import (${walked.length} of 3)`);
  const expected = Object.values(tree).reduce((n, t) => n + t.length, 0);
  assert(
    judgeBudget(walked).totalChars === expected,
    `imported files are counted in the total (${judgeBudget(walked).totalChars} of ${expected})`,
  );
}

{
  // A cycle must not hang the guard, and a missing import must not be counted.
  const tree: Record<string, string> = {
    "/t/CLAUDE.md": "@AGENTS.md\n",
    "/t/AGENTS.md": "@CLAUDE.md\n@docs/gone.md\n",
  };
  const walked = collectAutoLoadedDocs("/t", "CLAUDE.md", (p) => tree[p] ?? null);
  assert(walked.length === 2, `a cycle is walked once (${walked.length} files)`);
}

assert(
  CHARS_PER_TOKEN > 3 && CHARS_PER_TOKEN < 5,
  `the measured exchange rate is prose shaped (${CHARS_PER_TOKEN} characters per token)`,
);

finish();
