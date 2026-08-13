// #1436: no CI check may report green having parsed nothing.
//
// #1433 found three defects in ONE gate: a failing command hidden behind a pipe,
// zero parsed rows treated as success, and the CLI's own upgrade notice parsed as
// data. That gate had already been rewritten once (#766) for passing green in nine
// seconds having verified nothing. Nobody had asked whether its siblings shared the
// pattern, and two of them did (L30).
//
// A check that can pass while checking nothing is worse than no check, because it
// is believed. So this suite scans every `run:` block in the workflows and the git
// hooks for the two shapes a scanner CAN see, and each finding must be either fixed
// or annotated with which way it fails.
//
// The boundary, stated so this is never read as broader coverage than it has: the
// THIRD #1433 defect was a loosely anchored pattern (the CLI's upgrade notice
// matched a migration row). No scanner can see that, because whether a regex is
// anchored tightly enough depends on what the tool actually prints. That one is a
// human reading the parse, and the two parses in this repo that earn it live in
// modules with their own suites (scripts/lib/migration-drift.ts,
// scripts/lib/main-push-guard.ts) precisely so a person can.
//
// Run: node --experimental-strip-types scripts/test-workflow-parse-safety.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  joinContinuations,
  pipesIntoParser,
  runBlocks,
  scanParseSafety,
  setsPipefail,
} from "./lib/scan-workflow-parse-safety.ts";

const ROOT = join(import.meta.dirname, "..");

// --- the real surface ------------------------------------------------------
{
  const workflowDir = join(ROOT, ".github", "workflows");
  const workflows = readdirSync(workflowDir).filter((f) => f.endsWith(".yml"));
  assert(workflows.length >= 5, `found ${workflows.length} workflows to scan`);

  const findings = workflows.flatMap((f) =>
    scanParseSafety(`.github/workflows/${f}`, readFileSync(join(workflowDir, f), "utf8")),
  );

  // The hooks are shell start to finish, so the whole file is the script.
  const hooks = ["pre-push", "lib/isolate-pushed-tree.sh"];
  for (const hook of hooks) {
    let source: string;
    try {
      source = readFileSync(join(ROOT, ".githooks", hook), "utf8");
    } catch {
      continue;
    }
    findings.push(...scanParseSafety(`.githooks/${hook}`, source, { wholeFile: true }));
  }

  eq(
    findings.map((f) => `${f.rule}: ${f.message}`),
    [],
    "no CI shell block can report green having parsed nothing, or swallow a read without saying so",
  );
}

// --- runBlocks: the extraction itself ------------------------------------
// If this stopped finding blocks the whole guard would go quiet while looking
// healthy, which is the exact defect it exists to catch, so the count is asserted
// against the real files rather than only against fixtures.
{
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const blocks = runBlocks("ci.yml", ci);
  assert(blocks.length >= 8, `ci.yml really yields run blocks (${blocks.length} found)`);
  assert(
    blocks.some((b) => b.script.includes("check-migration-drift.ts")),
    "and the drift gate's block is among them, so the scan reaches the check #1433 rewrote",
  );

  const literal = runBlocks(
    "x.yml",
    ["      - name: One liner", "        run: pnpm test", "      - name: Next"].join("\n"),
  );
  eq(literal.length, 1, "a single line `run:` is a block too");
  eq(literal[0]?.script, "pnpm test", "and its script is the inline command");

  const folded = runBlocks(
    "x.yml",
    ["        run: |", "          set -e", "          echo hi", "      - name: Next"].join("\n"),
  );
  eq(folded.length, 1, "a `run: |` block is captured");
  assert(folded[0]!.script.includes("echo hi"), "with its whole body");
  assert(!folded[0]!.script.includes("name: Next"), "and stops at the next key rather than running on");
}

// --- pipesIntoParser: a pipe into a decision, and nothing else ----------
{
  assert(pipesIntoParser("supabase migration list | tee /tmp/x"), "a pipe into tee is a parse");
  assert(pipesIntoParser('gh pr list --json state | jq -r ".[].state"'), "a pipe into jq is a parse");
  assert(pipesIntoParser("cat f | grep -q OPEN"), "a pipe into grep is a parse");
  // The two shapes that look like a pipe and are not, because a false positive
  // here would make the guard something people annotate around.
  assert(!pipesIntoParser("a || b"), "a logical or is not a pipe");
  assert(!pipesIntoParser("cmd 2>&1"), "a redirect is not a pipe");
  assert(!pipesIntoParser("echo x | node script.ts"), "a pipe into a program that is not a parser is not flagged");
  assert(!pipesIntoParser("# grep | jq in a comment"), "a pipe inside a comment is not code");
}

// --- joinContinuations: a read written across two lines is still one read --
// The blind spot the first version of this scanner had, and the worst instance in
// the repo was exactly this shape: a `gh api ... \` whose `|| echo '[]'` sat on the
// continuation line, so a line-at-a-time scan saw a fragment with no `$(` in it.
{
  const folded = joinContinuations([
    'concls="$(gh api /x \\',
    "  --jq '.[]' || echo '[]')\"",
    "echo done",
  ]);
  assert(
    folded.some((l) => l.includes("$(gh api") && l.includes("|| echo")),
    "a continued command substitution folds into one line the scanner can judge",
  );
  eq(folded.length, 3, "and the array keeps its length, so reported offsets stay meaningful");
  assert(
    folded[0]!.includes("gh api"),
    "the folded statement lands on its FIRST line, so a comment above it is still adjacent",
  );
  eq(folded[2], "echo done", "a line that is not part of the continuation is untouched");
}

// --- setsPipefail --------------------------------------------------------
{
  assert(setsPipefail("set -euo pipefail"), "the combined form counts");
  assert(setsPipefail("set -o pipefail"), "the standalone form counts");
  assert(!setsPipefail("set -eu"), "errexit alone is NOT pipefail: a pipeline still reports the parser");
}

// --- positive controls, or this whole file could be a no-op (L1) --------
{
  const unsafePipe = [
    "      - name: Bad",
    "        run: |",
    "          set -eu",
    '          gh pr list --json state | jq -r ".[].state" > out',
    "          grep -q OPEN out",
  ].join("\n");
  const piped = scanParseSafety("x.yml", unsafePipe);
  eq(piped.length, 1, "a pipe into a parser with no pipefail IS caught");
  eq(piped[0]?.rule, "pipefail", "and is reported as the pipefail rule");

  const safePipe = unsafePipe.replace("set -eu", "set -euo pipefail");
  eq(scanParseSafety("x.yml", safePipe), [], "and adding pipefail clears it");

  const swallowed = [
    "      - name: Bad",
    "        run: |",
    "          set -euo pipefail",
    "          states=\"$(gh pr list --json state --jq '.[].state' || echo '')\"",
    '          if grep -q OPEN <<<"$states"; then exit 0; fi',
  ].join("\n");
  const swallow = scanParseSafety("x.yml", swallowed);
  eq(swallow.length, 1, "a read whose failure becomes a value IS caught");
  eq(swallow[0]?.rule, "swallowed-read", "and is reported as the swallowed-read rule");
  assert(
    /reports green/.test(swallow[0]!.message),
    "with a message saying what the defect DOES, not just that a pattern matched",
  );

  // `|| true` is the same defect wearing different clothes.
  const orTrue = [
    "        run: |",
    "          set -euo pipefail",
    '          count="$(gh api /x --jq length || true)"',
  ].join("\n");
  eq(scanParseSafety("x.yml", orTrue).length, 1, "`|| true` is caught too");

  // And the annotation really clears it, or the controls above would pass on a
  // scanner that rejects everything.
  const annotated = [
    "        run: |",
    "          set -euo pipefail",
    "          # parse-ok: a detached HEAD legitimately has no branch, and the caller skips",
    "          branch=\"$(git symbolic-ref --short HEAD || echo '')\"",
  ].join("\n");
  eq(scanParseSafety("x.yml", annotated), [], "an annotated swallowed read is accepted");

  const sameLine = [
    "        run: |",
    "          set -euo pipefail",
    "          branch=\"$(git symbolic-ref --short HEAD || echo '')\"  # parse-ok: no branch is fine",
  ].join("\n");
  eq(scanParseSafety("x.yml", sameLine), [], "the annotation also works on the line itself");

  // A blank line between the comment and the code breaks the association, so an
  // annotation cannot drift away from what it excuses.
  const detached = [
    "        run: |",
    "          # parse-ok: this excuse belongs to nothing",
    "",
    "          x=\"$(cmd || echo '')\"",
  ].join("\n");
  eq(
    scanParseSafety("x.yml", detached).length,
    1,
    "an annotation separated from its line does not excuse it",
  );
}

finish();
