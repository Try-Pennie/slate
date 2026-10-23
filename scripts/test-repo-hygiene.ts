// Repo hygiene invariants enforced in CI. Today: the repo-root reports/
// directory (browser-verification evidence: screenshots + axe JSON) must be
// gitignored so a `git add -A` can't sweep local artifacts onto main (#583; a
// prior slip did exactly that). The guard also asserts the tracked screenshot
// store under .claude/ is NOT ignored, so an over-broad pattern can't silently
// orphan committed evidence. And (#3650) every secret-bearing file, and every
// copy of one (.bak, .orig, ~, " copy"), is gitignored, read from the one block
// of .gitignore that holds them.
// Run: node --experimental-strip-types scripts/test-repo-hygiene.ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// #3650 (L761): a pattern keeping a secret file out of git must also keep out its
// COPIES. A backup is the first thing anyone makes before editing `.dev.vars` or
// `.env.local`, and `.dev.vars.bak` carried every Worker secret past a rule that
// named only `.dev.vars`. Every secret pattern lives in ONE block of .gitignore and
// ends in `*`, so a copy made by appending to the name is ignored with it; this reads
// the block rather than a list of its own, so a line added there is held to the rule
// on the day it is added (L96).
const SECRET_BLOCK_START = "# >>> secret-bearing files";
const SECRET_BLOCK_END = "# <<< secret-bearing files";
const gitignore = readFileSync(join(import.meta.dirname, "..", ".gitignore"), "utf8").split("\n");
const start = gitignore.indexOf(SECRET_BLOCK_START);
const end = gitignore.indexOf(SECRET_BLOCK_END);
assert(start !== -1 && end > start, ".gitignore holds the secret-bearing files block between its two markers");
const secretLines = gitignore
  .slice(start + 1, end)
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));
const secretPatterns = secretLines.filter((l) => !l.startsWith("!"));
// A negation re-admits whatever it names, so a broad one (`!.env*`) would un-ignore
// the secrets and their copies while every sample below still passed. The template
// is the one exception, named exactly.
const negations = secretLines.filter((l) => l.startsWith("!"));
assert(
  negations.length === 1 && negations[0] === "!.env.example",
  `the secret block re-admits only !.env.example (found: ${negations.join(", ") || "none"})`,
);
assert(secretPatterns.length >= 6, `the secret block lists its patterns (found ${secretPatterns.length})`);
const COPY_SUFFIXES = [".bak", ".orig", "~", ".old", ".swp", " copy", " 2"];
for (const pattern of secretPatterns) {
  assert(pattern.endsWith("*"), `the secret pattern ${pattern} ends in * so its copies are ignored too`);
  // A real name the pattern is meant to catch: inner wildcards become a word, the
  // trailing one becomes nothing.
  const sample = pattern.replace(/\*$/, "").replace(/\*/g, "sample").replace(/^\//, "");
  for (const name of [sample, ...COPY_SUFFIXES.map((s) => sample + s)]) {
    assert(isIgnored(name), `${JSON.stringify(name)} is gitignored (from ${pattern})`);
    assert(isIgnored(`supabase/${name}`), `${JSON.stringify(`supabase/${name}`)} is gitignored (from ${pattern})`);
  }
}
// The files this repo actually keeps secrets in, named outright, so the block cannot
// pass by being emptied or by losing the line for one of them.
for (const real of [".dev.vars", ".env.local", ".env", ".cf-secrets.json"]) {
  for (const name of [real, ...COPY_SUFFIXES.map((s) => real + s)]) {
    assert(isIgnored(name), `${JSON.stringify(name)} is gitignored`);
  }
}
// The committed template stays committable.
assert(!isIgnored(".env.example"), ".env.example is not gitignored (it is the committed template)");

finish();
