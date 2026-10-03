// Dependency vulnerability scanning (#1026). The 2026-07-23 production-readiness
// audit found nothing watched the dependency tree: no dependabot config, no CI
// audit step. That is exactly how the Next.js advisory lag (#1025) went unnoticed.
// This guard pins the two watchers so they can't be silently removed:
//   1. .github/dependabot.yml covers BOTH the npm and github-actions ecosystems,
//      so a new advisory (or a stale pinned Action) raises an update PR.
//   2. ci.yml runs `pnpm audit --prod --audit-level=high`, so a NEW high advisory
//      in a production dependency fails the build loudly. The allowlist in
//      package.json pnpm.auditConfig.ignoreGhsas is EMPTY as of #1057 (the bump
//      took sharp, the only prod-scope advisory, out of the tree), so the gate is
//      green on its own merit rather than by suppression. The assertion below is
//      about the allowlist's SHAPE, not its length: an empty list and a populated
//      one both pass, because an entry is legitimate when it carries a reason and
//      an issue that removes it. What it refuses is a non-array, which is how a
//      wildcard would quietly suppress everything.
// Run: node --experimental-strip-types scripts/test-dependency-scanning.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

// --- 1. dependabot config ------------------------------------------------
let dependabot = "";
try {
  dependabot = read(".github", "dependabot.yml");
} catch {
  /* asserted below */
}
assert(dependabot.trim().length > 0, ".github/dependabot.yml exists");
assert(
  /package-ecosystem:\s*["']?npm["']?/.test(dependabot),
  "dependabot watches the npm ecosystem (app dependencies)",
);
assert(
  /package-ecosystem:\s*["']?github-actions["']?/.test(dependabot),
  "dependabot watches the github-actions ecosystem (pinned Actions)",
);

// #3175: every update entry waits out a cooldown before proposing a release, so a
// hijacked version is not offered for a merge in its first days. Judged PER ENTRY,
// with comments stripped, since one entry carrying it says nothing about the other.
/** The `- package-ecosystem:` entries of a dependabot config, comment lines removed. */
function dependabotEntries(yaml: string): string[] {
  const code = yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  return code.split(/^(?=\s*- package-ecosystem:)/m).filter((e) => /package-ecosystem:/.test(e));
}
const COOLDOWN = /^\s+cooldown:\s*\n\s+default-days:\s*([1-9]\d*)\s*$/m;
{
  const entries = dependabotEntries(dependabot);
  assert(entries.length >= 2, `dependabot's update entries were read (${entries.length})`);
  for (const e of entries) {
    const eco = /package-ecosystem:\s*["']?([\w-]+)/.exec(e)?.[1] ?? "?";
    assert(COOLDOWN.test(e), `the ${eco} entry waits out a cooldown of at least a day before proposing a release`);
  }
  const one = "  - package-ecosystem: npm\n    cooldown:\n      default-days: 3\n  - package-ecosystem: github-actions\n";
  assert(!dependabotEntries(one).every((e) => COOLDOWN.test(e)), "control: an entry without a cooldown is caught beside one with it");
  assert(
    !dependabotEntries("  - package-ecosystem: npm\n    # cooldown:\n    #   default-days: 3\n").every((e) => COOLDOWN.test(e)),
    "control: a commented out cooldown is not one",
  );
}

// Every check below reads STEPS with comments stripped, and only what a step RUNS.
// Both workflows quote the audit commands in their comments, so a check over the
// raw text passes with the step deleted (L135); the controls further down plant
// exactly that.

/** The steps of a workflow (six space `- ` items), comment lines removed. */
function steps(yaml: string): string[] {
  const code = yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  return code.split(/^(?= {6}- )/m).filter((st) => /^ {6}- /.test(st));
}

/** What a step runs: its `run:` line, or the lines of its `run: |` block. */
function runOf(step: string): string {
  const lines = step.split("\n");
  const at = lines.findIndex((l) => /^\s*(- )?run:/.test(l));
  if (at < 0) return "";
  const first = lines[at]!.replace(/^\s*(- )?run:\s*/, "");
  if (first !== "|" && first !== ">") return first;
  const indent = lines[at]!.match(/^\s*/)![0].length;
  const block: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && l.match(/^\s*/)![0].length <= indent) break;
    block.push(l);
  }
  return block.join("\n");
}

const stepWithId = (yaml: string, id: string) =>
  steps(yaml).find((st) => new RegExp(`^\\s*id:\\s*${id}\\s*$`, "m").test(st)) ?? "";
const anyStepRuns = (yaml: string, re: RegExp) => steps(yaml).some((st) => re.test(runOf(st)));

// A prod-scoped audit that fails on high+, and the full tree one at critical.
const PROD_HIGH = /^\s*pnpm audit\b(?=[^\n]*--prod\b)[^\n]*--audit-level[= ]high\b/m;
const FULL_TREE = /^\s*pnpm audit\b(?![^\n]*--prod\b)[^\n]*--audit-level[= ]critical\b/m;
const PROD_MODERATE = /^\s*[^\n]*pnpm audit --prod --audit-level=moderate\b/m;

// --- 2. CI audit steps ---------------------------------------------------
const ci = read(".github", "workflows", "ci.yml");
assert(
  anyStepRuns(ci, PROD_HIGH),
  "ci.yml runs `pnpm audit --prod --audit-level=high` in a step (new high advisories fail loudly)",
);
// #3093: the build and deploy toolchain is audited too. `--prod` leaves out
// wrangler and the OpenNext adapter, which build the shipped bundle and run with
// the Cloudflare deploy token, so a full tree audit at critical sits beside it.
assert(anyStepRuns(ci, FULL_TREE), "ci.yml also runs a full tree `pnpm audit --audit-level=critical` in a step");
assert(!FULL_TREE.test("pnpm audit --prod --audit-level=critical"), "a --prod audit does not satisfy the full tree check");

// --- 2b. the daily audit (#3092) -----------------------------------------
// The CI audit only runs when somebody pushes, so an advisory published against an
// unchanged tree went unseen. A scheduled workflow runs both audits every day and
// a person is told: the alerter runs whatever the audits exited with.
let daily = "";
try {
  daily = read(".github", "workflows", "dependency-audit.yml");
} catch {
  /* asserted below */
}
assert(daily.trim().length > 0, ".github/workflows/dependency-audit.yml exists");

/** Every requirement on the daily workflow, so a planted copy is judged identically. */
function dailyFindings(yaml: string): string[] {
  const missing: string[] = [];
  const code = yaml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  if (!(/^\s*schedule:\s*$/m.test(code) && /cron:\s*["']/.test(code))) missing.push("a schedule");
  if (!PROD_HIGH.test(runOf(stepWithId(yaml, "prod")))) missing.push("the production audit as step `prod`");
  const full = stepWithId(yaml, "full");
  if (!FULL_TREE.test(runOf(full))) missing.push("the full tree audit as step `full`");
  // A production finding must not end the job before the toolchain is audited.
  if (!/^\s*if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s*$/m.test(full)) missing.push("`full` running after a red `prod`");
  if (!anyStepRuns(yaml, PROD_MODERATE)) missing.push("the moderate report");
  const alert = steps(yaml).find((st) => /^node [^\n]*scripts\/notify-dependency-audit\.ts\s*$/.test(runOf(st).trim())) ?? "";
  if (!alert) missing.push("the alerter");
  // Not always(): a superseded run is cancelled, and would then report an audit it
  // never finished (L36, L671).
  if (!/^\s*if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s*$/m.test(alert) || /always\(\)/.test(alert)) missing.push("the alerter running on !cancelled(), not always()");
  if (!/PROD_AUDIT:\s*\$\{\{\s*steps\.prod\.outcome\s*\}\}/.test(alert)) missing.push("PROD_AUDIT from steps.prod");
  if (!/FULL_AUDIT:\s*\$\{\{\s*steps\.full\.outcome\s*\}\}/.test(alert)) missing.push("FULL_AUDIT from steps.full");
  if (!/SLACK_BOT_TOKEN:\s*\$\{\{\s*secrets\.SLACK_BOT_TOKEN\s*\}\}/.test(alert)) missing.push("the Slack token");
  return missing;
}

{
  const missing = dailyFindings(daily);
  assert(
    missing.length === 0,
    `the daily audit runs on a schedule, both audits as steps, the moderate report, and the alerter whatever they exited with (missing: ${missing.join(", ") || "nothing"})`,
  );
}

// --- positive controls: a deleted step is noticed though comments quote it -------
{
  /** The real file with the step carrying `id: <id>` removed, comments untouched. */
  const without = (yaml: string, id: string): string => {
    const raw = yaml.split("\n");
    const idAt = raw.findIndex((l) => new RegExp(`^\\s*id:\\s*${id}\\s*$`).test(l));
    let from = idAt;
    while (from > 0 && !/^ {6}- /.test(raw[from]!)) from--;
    let to = idAt + 1;
    while (to < raw.length && !/^ {6}- /.test(raw[to]!) && !/^ {0,4}\S/.test(raw[to]!)) to++;
    return idAt < 0 ? yaml : [...raw.slice(0, from), ...raw.slice(to)].join("\n");
  };
  const noFull = without(daily, "full");
  assert(noFull !== daily && /pnpm audit --audit-level=critical/.test(noFull), "control: `full` deleted, its command still quoted in the header");
  assert(dailyFindings(noFull).some((m) => /full tree audit/.test(m)), "control: the missing full tree audit is caught");
  const noProd = without(daily, "prod");
  assert(noProd !== daily && /pnpm audit --prod --audit-level=high/.test(noProd), "control: `prod` deleted, its command still quoted");
  assert(dailyFindings(noProd).some((m) => /production audit/.test(m)), "control: the missing production audit is caught");

  const ciLines = ci.split("\n");
  const at = ciLines.findIndex((l) => /- name: Audit the whole tree, build and deploy toolchain included/.test(l));
  assert(at > 0, "control: ci.yml's full tree audit step is there to delete");
  let to = at + 1;
  while (to < ciLines.length && !/^ {6}- /.test(ciLines[to]!)) to++;
  const ciNoFull = [...ciLines.slice(0, at), ...ciLines.slice(to)].join("\n") + "\n      # pnpm audit --audit-level=critical\n";
  assert(!anyStepRuns(ciNoFull, FULL_TREE), "control: ci.yml with the step deleted and the command in a comment is caught");
}

// --- 3. allowlist is a real array, not a wildcard ------------------------
// The allowlist is legitimate (known advisories tracked in #1057) but must stay
// an explicit, auditable list so it can't quietly suppress everything.
const pkg = JSON.parse(read("package.json")) as {
  pnpm?: { auditConfig?: { ignoreGhsas?: unknown; ignoreCves?: unknown } };
};
const ignore = pkg.pnpm?.auditConfig?.ignoreGhsas;
if (ignore !== undefined) {
  assert(Array.isArray(ignore), "pnpm.auditConfig.ignoreGhsas is an explicit array");
}

finish();
