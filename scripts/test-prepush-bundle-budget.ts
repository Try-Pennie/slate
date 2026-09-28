// The pre-push gate weighs the client bundle against a record COMMITTED in the repo (#2571, #2676).
//
// #2571 put the weighing inside the gate, because the gate builds in an isolated
// worktree and the global guard reads the checkout's (always older) build. It
// judged against a record kept OUTSIDE the repo, in ~/.claude/state, which only
// moved on an explicit acceptance. So every change that grew the bundle inside the
// 3% or 10 KB margin left the record where it was, and the next change was judged
// against a total main had long since outgrown. On 2026-09-24 the record sat 11 KB
// behind main and a branch that changed no client module reported +2.7% (#2676):
// a baseline defending a stale capture (L84), a threshold answering a superseded
// question (L428). That record was also per machine and was moved by pushes of
// branches that never merged.
//
// The rule now, pinned below:
//
// 1. The record lives in the repo (.githooks/bundle-budget.txt), and the pushed
//    commit's record must equal what that commit actually builds to, within a
//    small noise band. A push that moves the bundle past the band without moving
//    the record is REFUSED, and the refusal prints the exact command to re-record.
//    So the PR that spends (or saves) the margin moves the record itself, and a
//    stale record is caught on the very next push rather than accumulating.
// 2. Growth is judged against the record committed at the MERGE BASE with main,
//    which is what main weighed when this branch left it. No second build is
//    needed, and no other branch or machine can move it.
// 3. Growth past BOTH 3% and 10 KB over that baseline is still refused unless
//    ACCEPT_BUNDLE_GROWTH=1, which is what caught Luxon joining the embed.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-prepush-bundle-budget.ts
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  BUNDLE_CHUNKS_DIR,
  BUNDLE_RECORD_PATH,
  MARGIN_ABS_BYTES,
  MARGIN_PCT,
  NOISE_BAND_BYTES,
  formatBundleRecord,
  judgeBundleWeight,
  parseBundleRecord,
  weighChunks,
} from "./lib/bundle-budget.ts";

const ROOT = join(import.meta.dirname, "..");
const HOOK_PATH = join(ROOT, ".githooks", "pre-push");
const hook = readFileSync(HOOK_PATH, "utf8");
const CLI = join(ROOT, "scripts", "bundle-budget.ts");

// --- the constants the rule rests on ------------------------------------------
//
// The noise band is set from measurement, not taste (L172): three from-scratch
// builds of f3f67791 on 2026-09-28, one of them with a server only change, gave
// 451,745 / 451,748 / 451,746 bytes, a spread of 3 bytes. 1 KB is several hundred
// times that, and a tenth of the 10 KB margin, so sub band drift across several
// PRs is bounded to a small fraction of the margin before a push re-records it.
eq(NOISE_BAND_BYTES, 1024, "the noise band is 1 KB, measured against a 3 byte build to build spread");
eq(MARGIN_PCT, 3, "the growth margin keeps the global guard's 3%");
eq(MARGIN_ABS_BYTES, 10240, "the growth margin keeps the global guard's 10 KB");
eq(BUNDLE_RECORD_PATH, ".githooks/bundle-budget.txt", "the record lives beside the hook that reads it");
eq(BUNDLE_CHUNKS_DIR, ".open-next/assets/_next/static/chunks", "the chunks weighed are the ones the Worker serves");

// --- the record's shape ---------------------------------------------------------
{
  eq(parseBundleRecord(formatBundleRecord(451748)), 451748, "a formatted record reads back to its total");
  eq(parseBundleRecord("# a comment\ntotal: 12\n"), 12, "a bare total line reads");
  eq(parseBundleRecord("# nothing here\n"), null, "a record with no total line is unreadable, never zero");
  eq(parseBundleRecord("total: twelve\n"), null, "a non numeric total is unreadable");
  eq(parseBundleRecord("total: -5\n"), null, "a negative total is unreadable");
  eq(parseBundleRecord("total: 1\ntotal: 2\n"), null, "two totals are ambiguous, so unreadable");
  assert(/pnpm bundle:record/.test(formatBundleRecord(1)), "the record file itself says how it is moved");
}

// The committed record is readable and is the file the hook names.
{
  const path = join(ROOT, BUNDLE_RECORD_PATH);
  const total = existsSync(path) ? parseBundleRecord(readFileSync(path, "utf8")) : null;
  assert(total !== null && total > 100_000, `the committed record carries a real total (${total})`);
}

// --- the decision ----------------------------------------------------------------
type J = Parameters<typeof judgeBundleWeight>[0];
const base = (over: Partial<J>): J => ({
  measured: 451_748,
  committed: 451_748,
  committedReadable: true,
  base: 451_748,
  baseSha: "abc1234",
  accept: false,
  ...over,
});

{
  // THE ISSUE'S CASE: grown inside the margin and the record did not move. This is
  // what used to print "The record stays at 443,452" and pass.
  const v = judgeBundleWeight(base({ measured: 451_748, committed: 443_452, base: 443_452 }));
  eq(v.kind, "record-behind-build", "grown inside the margin with the record unmoved is its own verdict");
  assert(v.refuse, "a push inside the margin that does not move the record is REFUSED, so the next push never pays for it");
  const text = v.lines.join("\n");
  assert(/pnpm bundle:record 451748/.test(text), "the refusal prints the exact command, with the measured total, to re-record");
  assert(/443,452/.test(text) && /451,748/.test(text), "the refusal names both the record and the measured total");
  assert(/\.githooks\/bundle-budget\.txt/.test(text), "the refusal names the file to commit");

  // The same push with the record moved passes, and reports the growth over main.
  const moved = judgeBundleWeight(base({ measured: 451_748, committed: 451_748, base: 443_452 }));
  eq(moved.kind, "within-margin", "the same growth with the record moved in the same push passes");
  assert(!moved.refuse, "moving the record is what lets it through");
  assert(/\+8,296/.test(moved.lines.join("\n")), "the pass states the growth over the merge base in bytes");
}

{
  // A saving that is not recorded is refused too: otherwise later growth spends it
  // without anyone seeing, which is the same drift in the other direction.
  const v = judgeBundleWeight(base({ measured: 440_000, committed: 451_748, base: 451_748 }));
  eq(v.kind, "record-ahead-of-build", "shrunk past the band with the record unmoved is its own verdict");
  assert(v.refuse, "an unrecorded saving is refused, so the saving is kept rather than silently respent");
  assert(/pnpm bundle:record 440000/.test(v.lines.join("\n")), "and it prints the command with the smaller total");
}

{
  // Build to build noise inside the band never asks anyone to re-record.
  for (const d of [3, -3, NOISE_BAND_BYTES, -NOISE_BAND_BYTES]) {
    const v = judgeBundleWeight(base({ measured: 451_748 + d, committed: 451_748, base: 451_748 }));
    assert(!v.refuse, `a difference of ${d} bytes from the record is noise and passes`);
  }
  const over = judgeBundleWeight(base({ measured: 451_748 + NOISE_BAND_BYTES + 1, committed: 451_748, base: 451_748 }));
  assert(over.refuse, "one byte past the band is a change the record must carry");
}

{
  // Past both margins over the merge base: the Luxon catch, unchanged.
  const grown = 451_748 + 20_000;
  const v = judgeBundleWeight(base({ measured: grown, committed: grown, base: 451_748 }));
  eq(v.kind, "grew-past-margin", "growth past both margins over main is refused even with the record moved");
  assert(v.refuse, "recording a big growth is not the same as accepting it");
  assert(/ACCEPT_BUNDLE_GROWTH=1/.test(v.lines.join("\n")), "the refusal names the acceptance override");

  const ok = judgeBundleWeight(base({ measured: grown, committed: grown, base: 451_748, accept: true }));
  eq(ok.kind, "accepted-growth", "ACCEPT_BUNDLE_GROWTH=1 lets deliberate growth through");
  assert(!ok.refuse, "accepted growth passes");

  // Accepting growth does not excuse an unmoved record: the record rule comes first.
  const unmoved = judgeBundleWeight(base({ measured: grown, committed: 451_748, base: 451_748, accept: true }));
  eq(unmoved.kind, "record-behind-build", "accepting growth still requires the record to carry it");
  assert(unmoved.refuse, "so ACCEPT_BUNDLE_GROWTH=1 cannot leave the next push holding the bill");

  // Growth past ONE margin only is not past both.
  const pctOnly = judgeBundleWeight(base({ measured: 100_000 + 5_000, committed: 105_000, base: 100_000 }));
  assert(!pctOnly.refuse, "5% of a small bundle but under 10 KB passes (both margins must be exceeded)");
}

{
  // No baseline on main: the merge base predates the record, or no merge base was found.
  const v = judgeBundleWeight(base({ base: null, baseSha: "abc1234" }));
  eq(v.kind, "no-base-record", "a merge base with no record is its own verdict");
  assert(!v.refuse, "the first commit to carry a record passes");
  assert(/abc1234/.test(v.lines.join("\n")) && /not judged/.test(v.lines.join("\n")),
    "and says growth against main was not judged, naming the merge base");

  const noSha = judgeBundleWeight(base({ base: null, baseSha: null }));
  eq(noSha.kind, "no-merge-base", "an unfindable merge base says so in its own words (L11)");
  assert(!noSha.refuse, "the record check still ran, so the push goes on");
}

{
  // A pushed commit with no record, or an unreadable one, is refused.
  const none = judgeBundleWeight(base({ committed: null, committedReadable: false }));
  eq(none.kind, "no-record", "a pushed tree with no record file is its own verdict");
  assert(none.refuse, "and is refused, since there is nothing to hold the next push to");
  assert(/pnpm bundle:record 451748/.test(none.lines.join("\n")), "with the command to write it");

  const bad = judgeBundleWeight(base({ committed: null, committedReadable: true }));
  eq(bad.kind, "record-unreadable", "a record file with no readable total is its own verdict");
  assert(bad.refuse, "and is refused rather than read as zero");
}

{
  // Every kind is produced by some case above, and no two refusals share a message.
  const all = [
    judgeBundleWeight(base({ measured: 451_748, committed: 443_452, base: 443_452 })),
    judgeBundleWeight(base({ measured: 440_000 })),
    judgeBundleWeight(base({})),
    judgeBundleWeight(base({ measured: 480_000, committed: 480_000 })),
    judgeBundleWeight(base({ measured: 480_000, committed: 480_000, accept: true })),
    judgeBundleWeight(base({ base: null })),
    judgeBundleWeight(base({ base: null, baseSha: null })),
    judgeBundleWeight(base({ committed: null, committedReadable: false })),
    judgeBundleWeight(base({ committed: null, committedReadable: true })),
    judgeBundleWeight(base({ measured: 440_000, committed: 440_000 })),
    judgeBundleWeight(base({ measured: 455_000, committed: 455_000 })),
  ];
  const kinds = new Set(all.map((v) => v.kind));
  for (const k of [
    "record-behind-build", "record-ahead-of-build", "unchanged", "grew-past-margin", "accepted-growth",
    "no-base-record", "no-merge-base", "no-record", "record-unreadable", "shrank", "within-margin",
  ]) {
    assert(kinds.has(k as never), `the verdict ${k} is reachable`);
  }
  const firstLines = all.filter((v) => v.refuse).map((v) => v.lines[0]);
  eq(new Set(firstLines).size, firstLines.length, "no two refusals open with the same sentence");
  for (const v of all) {
    const t = v.lines.join("\n");
    assert(!/[\u2014\u2013]/.test(t), `the ${v.kind} copy carries no dash as punctuation`);
    assert(!/undefined|NaN/.test(t), `the ${v.kind} copy renders no undefined or NaN`);
  }
}

// --- the weigher -----------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "bundle-budget-test-"));
try {
  const tree = join(scratch, "tree");
  const chunks = join(tree, BUNDLE_CHUNKS_DIR);
  mkdirSync(join(chunks, "app"), { recursive: true });
  // Random content, so the gzipped total is large enough (about 30 KB) for the
  // margin cases below to be about real growth rather than a few hundred bytes.
  const a = randomBytes(30_000).toString("base64");
  const b = "export const b = 1;".repeat(50);
  writeFileSync(join(chunks, "one.js"), a);
  writeFileSync(join(chunks, "app", "two.js"), b);
  writeFileSync(join(chunks, "three.css"), "body{}".repeat(100));
  const expected = gzipSync(a, { level: 9 }).length + gzipSync(b, { level: 9 }).length;
  const w = weighChunks(tree);
  assert(w.ok, "a tree with chunks is weighed");
  if (w.ok) {
    eq(w.total, expected, "the total is the summed level 9 gzip of every .js chunk, nested ones included");
    eq(w.chunks, 2, "only .js files count");
  }

  const empty = join(scratch, "empty");
  mkdirSync(empty);
  const none = weighChunks(empty);
  assert(!none.ok, "a tree with no chunk directory is not weighed");
  if (!none.ok) assert(/\.open-next\/assets\/_next\/static\/chunks/.test(none.why), "and says which directory it looked for");

  const noJs = join(scratch, "nojs");
  mkdirSync(join(noJs, BUNDLE_CHUNKS_DIR), { recursive: true });
  const nothing = weighChunks(noJs);
  assert(!nothing.ok, "a chunk directory holding no .js is not weighed as zero (L98)");

  // --- the CLI, end to end: exit codes are the contract with the hook -----------
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { encoding: "utf8" });

  mkdirSync(join(tree, ".githooks"), { recursive: true });
  const baseFile = join(scratch, "base.txt");
  writeFileSync(baseFile, formatBundleRecord(expected));

  // Record unmoved after growth: exit 2 and the command.
  writeFileSync(join(tree, BUNDLE_RECORD_PATH), formatBundleRecord(expected - 5_000));
  writeFileSync(baseFile, formatBundleRecord(expected - 5_000));
  const stale = run(["judge", "--tree", tree, "--base-file", baseFile, "--base-sha", "abc1234"]);
  eq(stale.status, 2, "the CLI exits 2 when the record did not move with the bundle");
  assert(stale.stdout.includes(`pnpm bundle:record ${expected}`), "and prints the exact re-record command");

  // Record moved: exit 0.
  writeFileSync(join(tree, BUNDLE_RECORD_PATH), formatBundleRecord(expected));
  const good = run(["judge", "--tree", tree, "--base-file", baseFile, "--base-sha", "abc1234"]);
  eq(good.status, 0, `the CLI exits 0 once the record carries the bundle (${good.stdout}${good.stderr})`);

  // A missing base file with a sha: the merge base predates the record, exit 0.
  const nob = run(["judge", "--tree", tree, "--base-file", join(scratch, "absent.txt"), "--base-sha", "abc1234"]);
  eq(nob.status, 0, "a merge base with no record passes");
  assert(/not judged/.test(nob.stdout), "and says growth was not judged");

  // Growth past the margin: exit 2, and --accept lets it through.
  assert(expected > 25_000, `the fixture weighs enough for a real margin case (${expected})`);
  writeFileSync(baseFile, formatBundleRecord(expected - 20_000));
  eq(run(["judge", "--tree", tree, "--base-file", baseFile, "--base-sha", "abc"]).status, 2,
    "growth past both margins exits 2");
  eq(run(["judge", "--tree", tree, "--base-file", baseFile, "--base-sha", "abc", "--accept"]).status, 0,
    "and --accept passes it");

  // A tree the build left no chunks in is a refusal, not a pass: in the gate the
  // build has just succeeded, so no chunks means the build shape changed.
  const unweighed = run(["judge", "--tree", empty, "--base-file", baseFile, "--base-sha", "abc"]);
  eq(unweighed.status, 3, "a tree with no chunks exits 3, its own code");
  assert(/not weighed/.test(unweighed.stdout + unweighed.stderr), "and says the bundle was not weighed");

  eq(run(["judge"]).status, 3, "missing arguments exit 3");
  eq(run(["nonsense"]).status, 3, "an unknown subcommand exits 3");

  // record writes a file the judge reads back, and refuses a non number.
  const target = join(scratch, "rec", "bundle-budget.txt");
  const rec = run(["record", "123456", "--file", target]);
  eq(rec.status, 0, "record writes the total");
  eq(parseBundleRecord(readFileSync(target, "utf8")), 123456, "and the file reads back to it");
  eq(run(["record", "12kb", "--file", target]).status, 3, "record refuses a total that is not a whole number");
  eq(parseBundleRecord(readFileSync(target, "utf8")), 123456, "and leaves the file as it was");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- the hook: the step's shape ----------------------------------------------------

/** Every assertion about the step, over some hook text, so the positive controls
 *  below can re-run them against text where the answer is known to be wrong. */
function judge(text: string): { failures: string[] } {
  const failures: string[] = [];
  const demand = (cond: boolean, why: string) => {
    if (!cond) failures.push(why);
  };

  // The pushed tree's own CLI does the judging, so the rule and the record come
  // from the revision being judged (L398).
  const callAt = text.search(/(?:NODE_NO_WARNINGS=1 )?node --experimental-strip-types "\$tree\/scripts\/bundle-budget\.ts" judge --tree "\$tree"/);
  demand(callAt >= 0, "the hook runs the pushed tree's scripts/bundle-budget.ts judge against the isolated tree");

  const waitAt = text.indexOf('if ! wait "$build_pid"; then');
  demand(waitAt >= 0, "the build is still waited on");
  demand(callAt > waitAt, "the weighing runs AFTER the build's wait, since it needs the finished build");
  const lastExit = text.lastIndexOf("\nexit 0");
  demand(lastExit > callAt, "the weighing runs BEFORE the hook's final exit, while the isolated tree still exists");
  const removals = [...text.matchAll(/git worktree remove/g)].map((m) => m.index ?? -1);
  demand(removals.length === 1, `the tree is removed in exactly one place (found ${removals.length})`);
  const cleanupAt = text.indexOf("cleanup() {");
  const trapAt = text.indexOf("trap cleanup EXIT");
  demand(
    cleanupAt >= 0 && trapAt > cleanupAt && removals.every((r) => r > cleanupAt && r < trapAt),
    "the one removal is inside cleanup(), which runs on EXIT, so nothing removes the tree before it is weighed",
  );

  // The baseline is main's committed record at the merge base.
  demand(
    /base_sha="\$\(git -C "\$root" merge-base "\$pushed_sha" origin\/main[^\n]*\)"/.test(text),
    "the baseline commit is the merge base of the pushed commit with origin/main",
  );
  demand(
    /git -C "\$root" show "\$base_sha:\.githooks\/bundle-budget\.txt"/.test(text),
    "the baseline is the record committed at that merge base, read with git show",
  );
  demand(
    /--base-file "\$base_file" --base-sha "\$base_sha"/.test(text),
    "the baseline file and its commit are handed to the judge",
  );

  // Nothing machine local is the budget any more.
  const step = callAt >= 0 ? text.slice(text.indexOf("bundle_budget_check() {"), text.indexOf("\nbundle_budget_check\n")) : "";
  demand(step.length > 0, "the step is a bundle_budget_check function");
  demand(!/--state-dir|BUNDLE_BUDGET_STATE_DIR|\.claude\/state/.test(step),
    "the step reads no machine local record, which is what drifted (#2676)");
  demand(!/bundle-budget\.py/.test(step), "the step does not depend on a measurer outside the repo");

  // Overrides.
  demand(/\[ "\$\{ACCEPT_BUNDLE_GROWTH:-\}" = "1" \] && accept="--accept"/.test(text),
    "ACCEPT_BUNDLE_GROWTH=1 passes --accept to the judge");
  const skipBranch = text.match(/if \[ "\$\{SKIP_BUNDLE_BUDGET_CHECK:-\}" = "1" \]; then\n([\s\S]*?)\n\s*fi\n/);
  demand(/echo "[^"]*not weighed[^"]*"[^\n]*>&2/.test(skipBranch?.[1] ?? ""),
    "SKIP_BUNDLE_BUDGET_CHECK=1 prints that the bundle was not weighed (a skip that prints nothing is a pass)");
  demand(/return 0/.test(skipBranch?.[1] ?? ""), "the skip stands down with return 0");

  // Verdicts.
  const verdict = callAt >= 0 ? text.slice(callAt) : "";
  // Each case arm's body, up to its own `;;`, so one arm can never answer for another.
  const arm = (label: string) => {
    const m = verdict.match(new RegExp(`\\n\\s*${label}\\)\\n((?:(?!;;)[\\s\\S])*);;`));
    return m?.[1] ?? "";
  };
  demand(/return 0/.test(arm("0")) && !/exit/.test(arm("0")), "a judge exit of 0 passes");
  demand(/exit 1/.test(arm("2")), "a judge exit of 2 (refused by the rule) fails the push");
  demand(/exit 1/.test(arm("\\*")),
    "any other judge exit fails the push too: the build has just run, so an unweighable tree is a defect, not a machine property");
  demand(/printf '%s\\n' "\$out"/.test(arm("2")) && /printf '%s\\n' "\$out"/.test(arm("\\*")),
    "both refusals print the judge's own lines rather than paraphrasing them");
  demand(/SKIP_BUNDLE_BUDGET_CHECK=1 git push/.test(verdict), "the refusal prints the skip hint");

  // set -e capture (L612).
  demand(/rc=0\n\s*out="\$\((?:NODE_NO_WARNINGS=1 )?node --experimental-strip-types "\$tree\/scripts\/bundle-budget\.ts"[\s\S]{0,300}?\)" \|\| rc=\$\?/.test(text),
    "the judge's exit status is captured with `|| rc=$?`, so a non-zero exit reaches the case statement under set -e");

  demand(!/bundle-budget\.ts" judge[^\n]*&$/m.test(text), "the weighing is not backgrounded");
  const stepHeader = text.indexOf("# --- 2b. Bundle weight");
  demand(stepHeader >= 0 && stepHeader < callAt && /critical path/.test(text.slice(stepHeader, callAt)),
    "the step's comment says it sits on the critical path after the build");

  return { failures };
}

{
  const { failures } = judge(hook);
  for (const f of failures) assert(false, f);
  assert(failures.length === 0, `the pre-push hook weighs the bundle as #2676 requires (${failures.length} gaps)`);
}

// --- positive controls: the checks above can fail (L1) ---------------------------
{
  const stripped = hook.replace(/"\$tree\/scripts\/bundle-budget\.ts" judge/g, '"$tree/scripts/removed.ts" judge');
  assert(judge(stripped).failures.length > 0, "a hook with no judge call fails");

  const stepStart = hook.indexOf("bundle_budget_check() {");
  const stepEnd = hook.indexOf("\nbundle_budget_check\n");
  const waitAt = hook.indexOf('if ! wait "$build_pid"; then');
  if (stepStart >= 0 && stepEnd > stepStart && waitAt >= 0 && waitAt < stepStart) {
    const step = hook.slice(stepStart, stepEnd + "\nbundle_budget_check\n".length);
    const without = hook.slice(0, stepStart) + hook.slice(stepEnd + "\nbundle_budget_check\n".length);
    const moved = without.slice(0, waitAt) + step + without.slice(waitAt);
    assert(judge(moved).failures.some((f) => /AFTER the build's wait/.test(f)),
      "a hook that weighs before the build is waited on fails the ordering check");
  } else {
    assert(false, "the step is shaped as a bundle_budget_check function called after the wait, so the ordering control can be built");
  }

  const machineRecord = hook.replace(/(bundle_budget_check\(\) \{\n)/, '$1  local state_dir="$HOME/.claude/state/bundle-budget"\n');
  assert(judge(machineRecord).failures.some((f) => /machine local record/.test(f)),
    "a hook that reads the machine local record again fails");

  const tipBase = hook.replace(/merge-base "\$pushed_sha" origin\/main/, 'rev-parse origin/main');
  assert(judge(tipBase).failures.some((f) => /merge base/.test(f)),
    "a hook that judges against main's tip rather than the merge base fails");

  const passOnRefusal = hook.replace(/(\n\s*2\)\n(?:(?!;;)[\s\S])*?)exit 1/, "$1return 0");
  assert(judge(passOnRefusal).failures.some((f) => /exit of 2/.test(f)), "a hook that lets a judge exit of 2 through fails");

  const passOnCrash = hook.replace(/(\n\s*\*\)\n(?:(?!;;)[\s\S])*?)exit 1/, "$1return 0");
  assert(judge(passOnCrash).failures.some((f) => /any other judge exit/.test(f)),
    "a hook that lets an unweighable tree through as a pass fails");

  const semicolonCapture =hook.replace(/\)" \|\| rc=\$\?/, ')"; rc=$?');
  assert(judge(semicolonCapture).failures.some((f) => /rc=\$\?/.test(f)),
    "a hook capturing the exit with `; rc=$?` (dead under set -e) fails");

  const silentSkip = hook.replace(
    /(if \[ "\$\{SKIP_BUNDLE_BUDGET_CHECK:-\}" = "1" \]; then\n)[\s\S]*?\n(\s*)fi\n/,
    "$1    return 0\n$2fi\n",
  );
  assert(judge(silentSkip).failures.some((f) => /not weighed/.test(f)), "a hook whose skip prints nothing fails");
}

finish();
