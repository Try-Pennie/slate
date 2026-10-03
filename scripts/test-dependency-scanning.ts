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

// --- 2. CI audit step ----------------------------------------------------
const ci = read(".github", "workflows", "ci.yml");
// A prod-scoped audit that fails on high+; matches regardless of flag order.
const hasAudit =
  /pnpm audit\b[^\n]*--prod\b/.test(ci) &&
  /pnpm audit\b[^\n]*--audit-level[= ]high\b/.test(ci);
assert(
  hasAudit,
  "ci.yml runs `pnpm audit --prod --audit-level=high` (new high advisories fail loudly)",
);

// #3093: the build and deploy toolchain is audited too. `--prod` leaves out
// wrangler and the OpenNext adapter, which build the shipped bundle and run with
// the Cloudflare deploy token, so a full tree audit at critical sits beside it.
const FULL_TREE = /pnpm audit\b(?![^\n]*--prod\b)[^\n]*--audit-level[= ]critical\b/;
assert(FULL_TREE.test(ci), "ci.yml also runs a full tree `pnpm audit --audit-level=critical` (devDependencies included)");
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
assert(/^\s*schedule:\s*$/m.test(daily) && /cron:\s*["']/.test(daily), "it runs on a schedule");
assert(/pnpm audit --prod --audit-level=high/.test(daily), "it runs the production audit at high");
assert(FULL_TREE.test(daily), "and the full tree audit at critical");
assert(/pnpm audit --prod --audit-level=moderate/.test(daily), "and reports production moderates");
{
  const alertStep = daily.split(/^ {6}- /m).find((s) => /notify-dependency-audit\.ts/.test(s)) ?? "";
  assert(alertStep.length > 0, "it runs the dependency audit alerter");
  assert(/if:\s*always\(\)/.test(alertStep), "whatever the audits exited with");
  assert(/PROD_AUDIT:\s*\$\{\{\s*steps\.prod\.outcome\s*\}\}/.test(alertStep), "handing it the production audit's outcome");
  assert(/FULL_AUDIT:\s*\$\{\{\s*steps\.full\.outcome\s*\}\}/.test(alertStep), "and the full tree audit's");
  assert(/SLACK_BOT_TOKEN:\s*\$\{\{\s*secrets\.SLACK_BOT_TOKEN\s*\}\}/.test(alertStep), "with the Slack token");
}
{
  // Each audit's step must not end the job before the other runs, or a production
  // finding would hide the toolchain's and the alert would say it never ran.
  const fullStep = daily.split(/^ {6}- /m).find((s) => /id:\s*full\b/.test(s)) ?? "";
  assert(/if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/.test(fullStep), "the full tree audit runs even when the production one failed");
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
