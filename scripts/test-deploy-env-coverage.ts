// Deploy-runbook coverage guard (#643): DEPLOY.md is the disaster-recovery
// runbook, so every environment variable the app actually reads at runtime — and
// every key in .env.example — MUST be documented there, or a rebuild-from-scratch
// deploy ships with a silently-missing secret (no calendar access, no Salesforce
// sync, no Slack alerts, broken OOO). This scans the server code + .env.example
// for env var names and asserts each appears in DEPLOY.md.
//
// #1200 added the OTHER direction, which is what makes this the two-way check
// #120 asked for. A `wrangler secret put NAME` line naming a value nothing reads
// is not harmless: the operator running the runbook under pressure sets it,
// believes that feature is now configured, and has no way to discover the name
// was renamed or the feature deleted. The runbook has to describe the app that
// exists, in both directions.
// Run: node --experimental-strip-types scripts/test-deploy-env-coverage.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, fail, finish } from "./lib/harness.ts";

// Directories whose runtime code reads env vars (worker + app server code).
const CODE_DIRS = ["src", "worker"];

// Not deployment secrets: framework-provided or test/load-only toggles. These
// legitimately never appear in the DR runbook. The loadtest flags are documented
// where they are actually used, in scripts/loadtest/RUNBOOK.md: putting a soak-only
// knob in the deploy runbook would imply production reads it, and production must
// never set any of them (SLATE_LOADTEST replaces every Google call with a stub).
const IGNORE = new Set([
  "NODE_ENV",
  "SLATE_LOADTEST",
  "SLATE_LOADTEST_FAULT_PCT",
  "SLATE_LOADTEST_FAULT_TARGETS",
]);

// How the code reads a named env var. `process.env[dynamic]` is intentionally
// excluded (no static name); the csvEnv/requireEnv/present wrappers pass the
// literal name as a string arg, so those are matched explicitly.
const PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /requireEnv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
  /present\([^,]+,\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
  /csvEnv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    // Skip test files: they may reference env vars in mocks that aren't real
    // production config.
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const names = new Set<string>();

// 1. Every env var the server code reads by a static name.
for (const dir of CODE_DIRS) {
  let files: string[] = [];
  try {
    files = walk(dir);
  } catch {
    continue;
  }
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) names.add(m[1]);
    }
  }
}

// 2. Every uncommented key in .env.example (the documented runtime surface). The
// commented "Tooling / CI only" block starts each example with `#`, so those are
// naturally skipped — they are not read by the app at runtime.
for (const line of readFileSync(".env.example", "utf8").split("\n")) {
  const m = /^([A-Z][A-Z0-9_]+)=/.exec(line);
  if (m) names.add(m[1]);
}

const deploy = readFileSync("DEPLOY.md", "utf8");
const required = [...names].filter((n) => !IGNORE.has(n)).sort();

for (const name of required) {
  if (!deploy.includes(name)) {
    fail(`DEPLOY.md does not document env var ${name} (read by the app / in .env.example)`);
  }
}

// --- The reverse direction (#1200): no runbook step sets a secret nothing reads.
//
// Matched on the `wrangler secret put` COMMAND LINES rather than anywhere in the
// prose, so a name mentioned in an explanatory sentence is not mistaken for a
// step the operator is told to run. A commented-out line counts: it is still an
// instruction, just a conditional one (BOOKING_API_KEY_2, set only when rotating).
const SECRET_PUT_LINE = /^\s*(?:#\s*)?wrangler secret put ([A-Z][A-Z0-9_]+)/gm;

function documentedSecrets(doc: string): string[] {
  return [...doc.matchAll(SECRET_PUT_LINE)].map((m) => m[1]);
}

const documented = documentedSecrets(deploy);
// Sanity check on the parse: a regex that stopped matching would leave the loop
// below iterating nothing and reading as full coverage (L1).
assert(
  documented.length >= 20,
  `parsed DEPLOY.md's wrangler secret put steps (found ${documented.length}, expected at least 20)`,
);

const readByApp = new Set(required);
for (const name of documented) {
  if (!readByApp.has(name)) {
    fail(
      `DEPLOY.md tells the operator to set ${name}, but nothing in src/, worker/ or ` +
        `.env.example reads it. Either the app stopped reading it (delete the step) or ` +
        `it was renamed (update the step)`,
    );
  }
}

// Positive control: the check must catch an orphan. Without this, a parse that
// silently returned nothing would leave the loop above passing vacuously, which
// is the exact failure mode this guard exists to prevent.
const orphaned = documentedSecrets(
  "```bash\nwrangler secret put SUPABASE_SECRET_KEY\nwrangler secret put REMOVED_LEGACY_KEY\n```",
);
assert(
  orphaned.includes("REMOVED_LEGACY_KEY"),
  "positive control: the parse SEES a secret-put step for a name the app does not read",
);
assert(
  !readByApp.has("REMOVED_LEGACY_KEY"),
  "positive control: REMOVED_LEGACY_KEY is genuinely unread, so the check above would fail on it",
);
assert(
  documentedSecrets("Set it with `wrangler secret put SOMETHING` when you rotate.").length === 0,
  "positive control: a secret named in prose is not counted as a step the operator must run",
);

finish();
