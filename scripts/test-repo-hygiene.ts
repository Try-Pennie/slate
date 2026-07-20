// Repo hygiene invariants enforced in CI. Today: the repo-root reports/
// directory (browser-verification evidence: screenshots + axe JSON) must be
// gitignored so a `git add -A` can't sweep local artifacts onto main (#583; a
// prior slip did exactly that). The guard also asserts the tracked screenshot
// store under .claude/ is NOT ignored, so an over-broad pattern can't silently
// orphan committed evidence.
// Run: node --experimental-strip-types scripts/test-repo-hygiene.ts
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { assert, finish } from "./lib/harness.ts";

/** True if git would ignore `path` (check-ignore exits 0 on a match). Runs with
 *  the pre-push hook's GIT_* vars stripped (#853): an inherited GIT_DIR would
 *  make check-ignore resolve against the wrong tree, not this repo. */
function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { env: scrubbedGitEnv() });
    return true;
  } catch {
    return false;
  }
}

// Root reports/ artifacts must be ignored.
assert(
  isIgnored("reports/some-screenshot.png"),
  "repo-root reports/ is gitignored (verification evidence stays local) (#583)",
);
assert(
  isIgnored("reports/axe/home.json"),
  "nested files under repo-root reports/ are gitignored (#583)",
);

// The tracked orchestration screenshot store must NOT be ignored. This guards
// against an unanchored `reports/` pattern that would match it too.
assert(
  !isIgnored(".claude/orchestration-slate-brand-redesign/reports/screens/book-dark-desktop.png"),
  "tracked .claude orchestration reports store stays committable (#583)",
);

// Live-credential diagnostics (Google DWD, Salesforce) must NOT be named
// scripts/test-*.mjs: `pnpm test` globs scripts/test-*.ts, so the ONLY thing
// keeping these hand-run scripts out of CI is the .mjs extension. A plausible
// ".mjs -> .ts" cleanup would fire real credential calls in every CI run
// (secrets-in-logs risk). Force the diag- prefix so the hazard can't reappear
// (#609 / AUD-033).
const mjsTests = readdirSync(import.meta.dirname).filter((f) => /^test-.*\.mjs$/.test(f));
assert(
  mjsTests.length === 0,
  `no scripts/test-*.mjs live-credential diagnostics (use the diag- prefix instead); found: ${mjsTests.join(", ") || "none"}`,
);

finish();
