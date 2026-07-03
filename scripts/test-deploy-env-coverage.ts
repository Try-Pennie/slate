// Deploy-runbook coverage guard (#643): DEPLOY.md is the disaster-recovery
// runbook, so every environment variable the app actually reads at runtime — and
// every key in .env.example — MUST be documented there, or a rebuild-from-scratch
// deploy ships with a silently-missing secret (no calendar access, no Salesforce
// sync, no Slack alerts, broken OOO). This scans the server code + .env.example
// for env var names and asserts each appears in DEPLOY.md. A partial step toward
// the #120 two-way sync check.
// Run: node --experimental-strip-types scripts/test-deploy-env-coverage.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function fail(msg: string) {
  console.error("FAIL:", msg);
  failures++;
}

// Directories whose runtime code reads env vars (worker + app server code).
const CODE_DIRS = ["src", "worker"];

// Not deployment secrets: framework-provided or test/load-only toggles. These
// legitimately never appear in the DR runbook.
const IGNORE = new Set(["NODE_ENV", "SLATE_LOADTEST"]);

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

if (failures === 0) {
  console.log(`ok: DEPLOY.md documents all ${required.length} runtime env vars`);
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
