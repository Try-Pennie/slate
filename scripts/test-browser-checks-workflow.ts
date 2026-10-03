// The browser checks workflow (#3079, #3100): its path gate covers every input the
// run reads, and it can never be handed a production secret.
//
// THE PATH GATE (L88). A pull_request `paths:` filter decides whether the run
// happens at all, so a gate narrower than the run's real inputs skips the check on
// exactly the change that breaks it, and says nothing. The inputs are enumerated
// here from `git ls-files`, by what the run actually reads, never from where the
// suite's own code lives:
//
//   - everything `next build` compiles or serves: `src/`, `public/`, and every
//     tracked TypeScript file the root tsconfig includes (the build typechecks the
//     whole program, so a root `*.d.ts` can break it);
//   - the root configuration the build and the install read;
//   - the schema the local stack is built from (`supabase/migrations/`);
//   - the suite itself (`e2e/`) and the workflow file.
//
// Every one of those files must be matched by a pattern in the gate. A control
// removes `src/**` and requires the check to notice, so a matcher that matched
// everything could not pass (L1).
//
// NO SECRETS (L2). The run is safe because nothing in it can reach a real system,
// and the cheapest way to keep that true is that the job is never given anything
// that could: any `secrets.` reference in the file fails here.
//
// Run: node --experimental-strip-types scripts/test-browser-checks-workflow.ts
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/source-files.ts";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = ".github/workflows/browser-checks.yml";
const text = readFileSync(join(ROOT, WORKFLOW), "utf8");

/** The `paths:` list under `pull_request:`, read line by line. */
function readPathGate(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s+paths:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const m = line.match(/^\s+-\s+"([^"]+)"\s*$/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** GitHub's filter glob, for the two wildcards this gate uses. */
function globMatches(pattern: string, file: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(file);
}

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
  return tracked.filter((f) => {
    if (/^(src|public|e2e|supabase\/migrations)\//.test(f)) return true;
    if (f === WORKFLOW) return true;
    if (ROOT_CONFIG.has(f)) return true;
    // The tsconfig program: every TypeScript file outside the excluded trees.
    if (/\.(ts|tsx|mts)$/.test(f) && !/^(scripts|worker|node_modules)\//.test(f) && !f.startsWith(".")) {
      return true;
    }
    return false;
  });
}

function unmatched(inputs: string[], gate: string[]): string[] {
  return inputs.filter((f) => !gate.some((p) => globMatches(p, f)));
}

// --- the matcher, on fixtures -----------------------------------------------------

assert(globMatches("src/**", "src/app/admin/page.tsx"), "** crosses directories");
assert(globMatches("*.ts", "next.config.ts"), "a root * matches a root file");
assert(!globMatches("*.ts", "src/lib/env.ts"), "a root * does not cross into a directory");
assert(!globMatches("src/**", "scripts/test-x.ts"), "a prefix pattern does not match another tree");

// --- the real gate against the real tree ---------------------------------------------

const gate = readPathGate(text);
assert(gate.length > 0, `the workflow declares a path gate (read ${gate.length} patterns)`);
// The shared enumeration, which refuses a listing too short to believe (#2421).
const tracked = sourceFiles({ paths: ["."], match: /./ });
const inputs = browserRunInputs(tracked);
assert(inputs.length > 100, `the run's inputs were enumerated from the tree (${inputs.length} files)`);
for (const must of ["src/middleware.ts", "e2e/run.ts", "next.config.ts", "pnpm-lock.yaml", "cloudflare-env.d.ts"]) {
  assert(inputs.includes(must), `${must} is counted as an input`);
}
const missed = unmatched(inputs, gate);
assert(missed.length === 0, `every input the run reads is in the path gate (missed: ${missed.slice(0, 10).join(", ")})`);

// Positive control: a gate without src/** must be caught, naming a src file.
const narrowed = unmatched(inputs, gate.filter((p) => p !== "src/**"));
assert(
  narrowed.some((f) => f.startsWith("src/")),
  "a gate missing src/** is caught, so the check is not satisfied by any gate at all",
);

// --- what the job is and is not given -----------------------------------------------

assert(!/secrets\./.test(text), "the job references no secret, so it has nothing that could reach a real system");
assert(/timeout-minutes:\s*\d+/.test(text), "the job has an explicit timeout (L313)");
assert(/run:\s*pnpm test:e2e/.test(text), "the job runs the suite through its runner, which owns the isolation");
assert(/supabase\/setup-cli@[0-9a-f]{40}/.test(text), "the Supabase CLI action is pinned by SHA");
assert(/version:\s*\d+\.\d+\.\d+/.test(text), "the Supabase CLI version is pinned exactly");
assert(!/\bpush:/.test(text.split("\njobs:")[0]), "it does not run on push, so a merge to main pays for nothing twice");

finish();
