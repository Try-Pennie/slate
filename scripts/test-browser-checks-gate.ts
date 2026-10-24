// The browser leg (#3079, #3100): its gate decides from the diff, its input list
// covers every file the run reads, and it can never be handed a production secret.
//
// THE GATE. The leg is part of the `ci` fan-in, so it starts on every pull request
// and its first step decides whether to build (scripts/lib/browser-checks-gate.ts).
// Both directions are pinned here: a change touching an input RUNS, a change
// touching none SKIPS, and a diff that cannot be read runs rather than skipping on
// a guess (L42).
//
// THE INPUTS (L88). A gate narrower than the run's real inputs skips the check on
// exactly the change that breaks it, and says nothing. The inputs are enumerated
// from the tree by what the run actually reads, never from where the suite lives:
//
//   - everything `next build` compiles or serves: `src/`, `public/`, and every
//     TypeScript file the root tsconfig includes (the build typechecks the whole
//     program, so a root `*.d.ts` can break it);
//   - the root configuration the build and the install read;
//   - the schema the local stack is built from (`supabase/migrations/`);
//   - the suite (`e2e/`), the workflow, and the gate's own code;
//   - the settled designs its design test draws (`docs/design/`) and the copied design
//     match score that scores them (`scripts/design-score/`, #3954).
//
// Each must match a pattern in BROWSER_INPUT_PATTERNS. A control removes `src/**`
// and requires the check to notice (L1).
//
// NO SECRETS (L2). The run is safe because nothing in it can reach a real system,
// and the cheapest way to keep that true is that the leg is never given anything
// that could: any `secrets.` reference in the browser job fails here.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-browser-checks-gate.ts
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { sourceFiles } from "./lib/source-files.ts";
import {
  BROWSER_INPUT_PATTERNS,
  decideBrowserGate,
  globMatches,
  isBrowserInput,
} from "./lib/browser-checks-gate.ts";

const ROOT = join(import.meta.dirname, "..");

// --- the matcher, on fixtures -----------------------------------------------------

assert(globMatches("src/**", "src/app/admin/page.tsx"), "** crosses directories");
assert(globMatches("*.ts", "next.config.ts"), "a root * matches a root file");
assert(!globMatches("*.ts", "src/lib/env.ts"), "a root * does not cross into a directory");
assert(!globMatches("src/**", "scripts/test-x.ts"), "a prefix pattern does not match another tree");

// --- the decision, both directions ------------------------------------------------

{
  const page = decideBrowserGate({ eventName: "pull_request", changedFiles: ["docs/x.md", "src/components/Booker.tsx"] });
  eq(page.action, "run", "a pull request touching a component runs the browser checks");
  eq(page.touched, ["src/components/Booker.tsx"], "and names the input that made it run");
  const docs = decideBrowserGate({ eventName: "pull_request", changedFiles: ["docs/x.md", "scripts/test-y.ts"] });
  eq(docs.action, "skip", "a pull request touching nothing the run reads skips, so it does not wait six minutes");
  assert(/None of the 2 changed files/.test(docs.reason), "and the skip says why, with the count it judged");
  eq(decideBrowserGate({ eventName: "pull_request", changedFiles: null }).action, "run", "an unreadable diff runs rather than skipping on a guess");
  eq(decideBrowserGate({ eventName: "pull_request", changedFiles: [] }).action, "run", "an empty diff is not believable, so it runs");
  eq(decideBrowserGate({ eventName: "push", changedFiles: ["docs/x.md"] }).action, "run", "nothing off a pull request is skipped by the diff");
  for (const f of ["supabase/migrations/0200_x.sql", "e2e/tests/10-auth.spec.ts", "package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml", "public/widget.js", "middleware.ts"]) {
    assert(isBrowserInput(f), `${f} is a browser input`);
  }
  for (const f of ["docs/adr/0011-browser-checks-before-merge.md", "scripts/test-x.ts", "worker/index.ts", ".github/workflows/coverage.yml"]) {
    assert(!isBrowserInput(f), `${f} is not a browser input`);
  }
}

// --- the input list against the real tree ------------------------------------------

/** Every tracked file the browser run reads. */
function browserRunInputs(tracked: string[]): string[] {
  const ROOT_CONFIG = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "postcss.config.mjs",
    "next.config.ts",
    "eslint.config.mjs",
  ]);
  const RUN_WIRING = new Set([
    ".github/workflows/ci.yml",
    "scripts/browser-checks-gate.ts",
    "scripts/lib/browser-checks-gate.ts",
    "scripts/lib/migration-drift-gate.ts",
  ]);
  return tracked.filter((f) => {
    if (/^(src|public|e2e|supabase\/migrations)\//.test(f)) return true;
    // The design test draws each settled design and scores it with the copied score (#3954).
    if (/^(docs\/design|scripts\/design-score)\//.test(f)) return true;
    if (RUN_WIRING.has(f) || ROOT_CONFIG.has(f)) return true;
    // The tsconfig program: every TypeScript file outside the excluded trees.
    if (/\.(ts|tsx|mts)$/.test(f) && !/^(scripts|worker|node_modules)\//.test(f) && !f.startsWith(".")) {
      return true;
    }
    return false;
  });
}

const unmatched = (inputs: string[], patterns: readonly string[]) =>
  inputs.filter((f) => !patterns.some((p) => globMatches(p, f)));

/**
 * The files under `scripts/` that the suite IMPORTS (#3694: `e2e/env.ts` reads the
 * live settings rule from `scripts/lib/live-env-files.ts`). Read from the import
 * statements themselves, so a new one cannot be missed by a hand kept list.
 */
function scriptsImportedByE2e(tracked: string[]): string[] {
  const found = new Set<string>();
  for (const f of tracked) {
    if (!/^e2e\/.*\.(ts|mts|mjs)$/.test(f)) continue;
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const resolved = posix.normalize(posix.join(posix.dirname(f), m[1]));
      if (resolved.startsWith("scripts/")) found.add(resolved);
    }
  }
  return [...found];
}

// The shared enumeration, which refuses a listing too short to believe (#2421).
const tracked = sourceFiles({ paths: ["."], match: /./ });
const e2eScriptImports = scriptsImportedByE2e(tracked);
assert(
  e2eScriptImports.includes("scripts/lib/live-env-files.ts"),
  `the import scan finds the suite's known import from scripts (found: ${e2eScriptImports.join(", ")})`,
);
const inputs = [...new Set([...browserRunInputs(tracked), ...e2eScriptImports])];
assert(inputs.length > 100, `the run's inputs were enumerated from the tree (${inputs.length} files)`);
for (const must of ["src/middleware.ts", "e2e/run.ts", "next.config.ts", "pnpm-lock.yaml", "cloudflare-env.d.ts", ".github/workflows/ci.yml", "docs/design/team-capacity.html", "docs/design/team-capacity.checks.js", "scripts/design-score/capture-web.mjs"]) {
  assert(inputs.includes(must), `${must} is counted as an input`);
}
const missed = unmatched(inputs, BROWSER_INPUT_PATTERNS);
assert(missed.length === 0, `every input the run reads is in the gate's list (missed: ${missed.slice(0, 10).join(", ")})`);
const narrowed = unmatched(inputs, BROWSER_INPUT_PATTERNS.filter((p) => p !== "src/**"));
assert(narrowed.some((f) => f.startsWith("src/")), "a list missing src/** is caught, so the check is not satisfied by any list at all");

// --- what the leg is and is not given ----------------------------------------------

const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const start = ci.search(/^ {2}browser:\s*$/m);
assert(start >= 0, "ci.yml has a `browser` job");
const rest = ci.slice(start + 1);
const next = rest.search(/^ {2}[\w-]+:\s*$/m);
const job = next >= 0 ? rest.slice(0, next) : rest;
assert(job.includes("pnpm test:e2e"), "the extracted block is the real browser job");
assert(!/secrets\./.test(job), "the browser job references no secret, so it has nothing that could reach a real system");
assert(/timeout-minutes:\s*\d+/.test(job), "the browser job has an explicit timeout (L313)");
assert(/supabase\/setup-cli@[0-9a-f]{40}/.test(job), "the Supabase CLI action is pinned by SHA");
assert(/version:\s*\d+\.\d+\.\d+/.test(job), "the Supabase CLI version is pinned exactly");

finish();
