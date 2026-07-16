// Copy guard: user-facing source must not contain em/en dashes or the
// unreleased platform name (see slate-copy-rules). Scans src/app, src/components,
// src/lib/notify, and src/lib/webhooks (webhook payloads and labels are sent to
// Regal, so their strings are user-visible too, #174), ignoring code comments.
// Run via pnpm test (auto-discovered).
// Run: node --experimental-strip-types scripts/test-copy.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, fail, finish } from "./lib/harness.ts";

const TARGET_DIRS = ["src/app", "src/components", "src/lib/notify", "src/lib/webhooks"];
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /[—–]/, label: "an em/en dash" },
  { re: /cadence/i, label: "the unreleased platform name" },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Blank out comments so only code + JSX text + string literals are scanned. */
function stripComments(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    let s = line;
    if (inBlock) {
      const end = s.indexOf("*/");
      if (end === -1) return "";
      s = s.slice(end + 2);
      inBlock = false;
    }
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    const open = s.indexOf("/*");
    if (open !== -1) {
      inBlock = true;
      s = s.slice(0, open);
    }
    // Drop // line/trailing comments, but not the // in URLs (:// has no space).
    return s.replace(/(^|\s)\/\/.*$/, "$1");
  });
}

const files = TARGET_DIRS.flatMap((d) => {
  try {
    return walk(d);
  } catch {
    return [];
  }
});

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  stripComments(lines).forEach((text, i) => {
    for (const { re, label } of FORBIDDEN) {
      if (re.test(text)) {
        fail(`${file}:${i + 1} contains ${label}: ${lines[i].trim().slice(0, 80)}`);
      }
    }
  });
}

// Positive control: the guard runs its checks as side effects while scanning, so
// on a clean tree it can pass without ever having exercised the detector. These
// asserts prove it still flags what it exists to catch (a code-level dash and the
// codename) and still ignores comment-only hits, so it can't rot into a no-op.
// The dash is written as a \u escape so this detector file holds no literal dash
// for the style hook to trip on.
function flaggedOnce(line: string): boolean {
  const [code] = stripComments([line]);
  return FORBIDDEN.some(({ re }) => re.test(code));
}
assert(flaggedOnce('const s = "book \u2014 now";'), "detector flags a code-level em dash");
assert(flaggedOnce('const s = "book \u2013 now";'), "detector flags a code-level en dash");
assert(flaggedOnce('const s = "sent via Cadence";'), "detector flags the codename in code");
assert(
  !flaggedOnce("// exactly-once to Cadence \u2014 skip the resend"),
  "detector ignores a comment-only dash and codename",
);

// #174: src/lib/webhooks must be in the scan set (webhook copy reaches Regal).
assert(TARGET_DIRS.includes("src/lib/webhooks"), "scan set includes src/lib/webhooks (#174)");

finish();
