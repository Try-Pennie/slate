// Repo invariant (#820 / AUD-022): node-native test files must use the shared
// harness (scripts/lib/harness.ts), not re-declare their own assert/ok/fail
// helper or failure counter. This locks in the consolidation so the duplication
// can't creep back one new test file at a time.
// Run: node --experimental-strip-types scripts/test-harness-usage.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname;
const SELF = "test-harness-usage.ts";

// test-harness.ts unit-tests the harness itself via node:assert, so it does not
// import the harness's own assert; every other test file must use the harness.
const ALLOW = new Set(["test-harness.ts", SELF]);

// Written as name alternations so this guard does not match its own source. The
// arrow-helper pattern requires `=>` so a data variable like
// `const ok = validateReason(...)` is not mistaken for a helper.
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfunction (assert|ok|fail|check)\s*\(/, "a local function helper"],
  [/\bconst (assert|ok|fail|check)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]*?)?=>/, "a local arrow helper"],
  [/\blet (failures|failed)\s*=\s*0\b/, "a local failure counter"],
];

const files = readdirSync(HERE).filter((f) => /^test-.*\.ts$/.test(f) && !ALLOW.has(f));
assert(files.length > 50, `scanned the node test suite (${files.length} files)`);

for (const f of files) {
  const src = readFileSync(join(HERE, f), "utf8");
  for (const [re, what] of FORBIDDEN) {
    const m = src.match(re);
    assert(!m, `${f}: has ${what}; use scripts/lib/harness.ts instead${m ? ` [${m[0].trim()}]` : ""}`);
  }
}

finish();
