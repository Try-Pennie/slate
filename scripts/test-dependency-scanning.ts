// Dependency vulnerability scanning (#1026). The 2026-07-23 production-readiness
// audit found nothing watched the dependency tree: no dependabot config, no CI
// audit step. That is exactly how the Next.js advisory lag (#1025) went unnoticed.
// This guard pins the two watchers so they can't be silently removed:
//   1. .github/dependabot.yml covers BOTH the npm and github-actions ecosystems,
//      so a new advisory (or a stale pinned Action) raises an update PR.
//   2. ci.yml runs `pnpm audit --prod --audit-level=high`, so a NEW high advisory
//      in a production dependency fails the build loudly. Known, unremediated
//      advisories are allow-listed in package.json pnpm.auditConfig (tracked in
//      #1057); the gate still fires on anything new.
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
