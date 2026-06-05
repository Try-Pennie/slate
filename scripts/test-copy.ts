// Copy guard: user-facing source must not contain em/en dashes or the
// unreleased platform name (see slate-copy-rules). Scans src/app, src/components,
// and src/lib/notify, ignoring code comments. Run via pnpm test (auto-discovered).
// Run: node --experimental-strip-types scripts/test-copy.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function fail(msg: string) {
  console.error("FAIL:", msg);
  failures++;
}

const TARGET_DIRS = ["src/app", "src/components", "src/lib/notify"];
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

if (failures === 0) {
  console.log(`ok: no forbidden dashes or names across ${files.length} user-facing files`);
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
