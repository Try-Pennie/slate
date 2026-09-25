// Repo invariant (#2712): no test suite writes into the repo tree.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-no-tree-writes.ts
//
// `pnpm test` runs the node suites concurrently, and many of them walk `scripts/`
// or `src/` reading every file they list. A suite that plants a file in that tree
// and removes it afterwards hands each concurrent walker a file it can list and
// then fail to open. `test-scripts-typecheck.ts` did exactly that with its
// positive control, and `test-unfailable-assertions.ts` died on ENOENT on
// unrelated PRs and once on main, where the failure skipped a deploy. Measured
// before the fix: 3 ENOENT in 5 rounds of running the two side by side.
//
// So every suite, node and vitest, is scanned for an fs write whose path is not
// PROVEN to be a temp directory (the rule and its blind spots are in
// `scripts/lib/scan-tree-writes.ts`). A write that genuinely must land in the
// repo carries `// tree-write-ok: <reason>`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scanTreeWrites } from "./lib/scan-tree-writes.ts";
import { discoverSuiteNames } from "./lib/suite-discovery.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// --- the rule, on fixtures ----------------------------------------------------
{
  const flagged = (src: string) => scanTreeWrites(src).map((w) => `${w.call}:${w.line}`);

  // THE POSITIVE CONTROL: the exact shape #2712 shipped, a control planted in
  // scripts/ through a const one hop away from the write.
  const planted = [
    'import { writeFileSync, rmSync } from "node:fs";',
    'import { join } from "node:path";',
    'const repoRoot = new URL("..", import.meta.url).pathname;',
    'const controlPath = join(repoRoot, "scripts", "typecheck-control.tmp.ts");',
    'writeFileSync(controlPath, "export const planted = nope;\\n");',
    "rmSync(controlPath, { force: true });",
  ].join("\n");
  eq(
    flagged(planted).join(","),
    "writeFileSync:5,rmSync:6",
    "a control planted in scripts/ is caught, write AND removal, through the const it was built in",
  );

  eq(
    flagged('import * as fs from "node:fs";\nfs.writeFileSync("src/x.ts", "");').join(","),
    "writeFileSync:2",
    "a namespace import and a bare literal path are caught",
  );
  eq(
    flagged('import fs from "fs";\nawait fs.promises.writeFile(process.cwd() + "/x", "");').join(","),
    "writeFile:2",
    "fs.promises through a default import is caught",
  );
  eq(
    flagged('import { writeFile as w } from "node:fs/promises";\nfunction put(p: string) { return w(p, ""); }').join(","),
    "writeFile:2",
    "an aliased import is caught, and a bare PARAMETER is not proof of anything",
  );

  // The safe shapes: a temp dir directly, through bindings, and via tmpdir().
  eq(
    flagged(
      [
        'import { mkdtempSync, writeFileSync, rmSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'const dir = mkdtempSync(join(tmpdir(), "x-"));',
        'const file = join(dir, "a.txt");',
        'writeFileSync(file, "");',
        "rmSync(dir, { recursive: true, force: true });",
        'writeFileSync(join(tmpdir(), "b"), "");',
      ].join("\n"),
    ).length,
    0,
    "paths derived from mkdtempSync or tmpdir(), through bindings, are proven temp",
  );

  eq(
    flagged(
      [
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'let p = mkdtempSync(join(tmpdir(), "x"));',
        'p = new URL("..", import.meta.url).pathname;',
        'writeFileSync(p, "");',
      ].join("\n"),
    ).join(","),
    "writeFileSync:6",
    "a name bound once to a temp dir and once to the repo is NOT proven temp",
  );

  eq(
    flagged(
      [
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        "function a() {",
        '  const path = mkdtempSync(join(tmpdir(), "a-"));',
        '  writeFileSync(path, "");',
        "}",
        "function b() {",
        '  const path = new URL("..", import.meta.url).pathname;',
        '  writeFileSync(path, "");',
        "}",
      ].join("\n"),
    ).join(","),
    "writeFileSync:10",
    "names resolve by SCOPE: a temp `path` in one function does not vouch for a repo `path` in another",
  );

  eq(
    flagged(
      [
        'import { mkdtempSync, symlinkSync, copyFileSync, renameSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'const dir = mkdtempSync(join(tmpdir(), "x-"));',
        'symlinkSync("/usr/bin/git", join(dir, "git"));',
        'copyFileSync(join(dir, "a"), "scripts/a.ts");',
        'renameSync("scripts/b.ts", join(dir, "b"));',
      ].join("\n"),
    ).join(","),
    "copyFileSync:6,renameSync:7",
    "a link or copy is judged by its DESTINATION, and a rename by both ends",
  );

  eq(
    flagged(
      [
        'import { mkdtempSync, rmSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        "let dir: string | undefined;",
        'dir = mkdtempSync(join(tmpdir(), "x-"));',
        "rmSync(dir);",
        "for (const d of dirs) rmSync(d);",
      ].join("\n"),
    ).join(","),
    "rmSync:7",
    "a `let` with no initialiser is judged by its assignments; a loop variable is not followed",
  );

  // Review finding 1 (#2725): a temp call must be the BASE of the path, not merely
  // somewhere inside it. Each of these names a temp directory and writes into the repo.
  eq(
    flagged(
      [
        'import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { basename, join, resolve } from "node:path";',
        'const repoRoot = new URL("..", import.meta.url).pathname;',
        'writeFileSync(join(repoRoot, "scripts", basename(mkdtempSync(join(tmpdir(), "x-")))), "");',
        'writeFileSync(join(repoRoot, tmpdir()), "");',
        'writeFileSync(resolve(tmpdir(), repoRoot, "x.ts"), "");',
        'writeFileSync(`${repoRoot}/${tmpdir()}`, "");',
        'mkdirSync(mkdtempSync(join(repoRoot, "scripts", "x-")));',
      ].join("\n"),
    ).join(","),
    "writeFileSync:5,writeFileSync:6,writeFileSync:7,writeFileSync:8,mkdirSync:9",
    "a temp call INSIDE a repo path is refused: under join after the repo root, re-anchored by resolve, " +
      "late in a template, and a mkdtemp whose prefix is in the tree",
  );
  eq(
    flagged(
      [
        'import { writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join, resolve } from "node:path";',
        'const dir = tmpdir();',
        'writeFileSync(resolve("/ignored", dir, "a", "b.txt"), "");',
        'writeFileSync(`${dir}/c.txt`, "");',
        'writeFileSync(dir + "/d.txt", "");',
      ].join("\n"),
    ).length,
    0,
    "a temp base stays accepted as resolve's anchor, a template head and a concatenation head",
  );

  // Review finding 2 (#2725): the temp call must be the REAL one, bound to
  // node:os / node:fs, never a local function that happens to share its name.
  eq(
    flagged(
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'function tmpdir() { return new URL("..", import.meta.url).pathname; }',
        "const mkdtempSync = (p: string) => p;",
        'writeFileSync(join(tmpdir(), "x.ts"), "");',
        'writeFileSync(join(mkdtempSync("scripts/"), "y.ts"), "");',
      ].join("\n"),
    ).join(","),
    "writeFileSync:5,writeFileSync:6",
    "a LOCAL function named tmpdir or mkdtempSync proves nothing",
  );
  eq(
    flagged(
      [
        'import * as fs from "node:fs";',
        'import os from "node:os";',
        'import * as path from "node:path";',
        'const d = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));',
        'fs.writeFileSync(path.join(d, "a"), "");',
      ].join("\n"),
    ).length,
    0,
    "the real calls are recognised through namespace and default imports too",
  );
  eq(
    flagged(
      [
        'import { writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'function join(...p: string[]) { return p.join("/"); }',
        'writeFileSync(join(tmpdir(), "x"), "");',
      ].join("\n"),
    ).join(","),
    "writeFileSync:4",
    "a LOCAL join is not path.join, so its first argument does not vouch for the result",
  );

  eq(
    flagged(
      [
        'import { writeFileSync } from "node:fs";',
        '// Text that NAMES a write is not one: writeFileSync(repoRoot, "x")',
        'const s = "writeFileSync(join(repoRoot, \'scripts\'))";',
        "function rm(p: string) { return p; }",
        'rm("scripts/x");',
      ].join("\n"),
    ).length,
    0,
    "a write named in a comment or string, or a local function called rm, is not a write",
  );

  eq(
    flagged(
      [
        'import { writeFileSync } from "node:fs";',
        "// tree-write-ok: regenerates the committed digest on purpose",
        'writeFileSync("scripts/digest.json", "");',
        "// tree-write-ok:",
        'writeFileSync("scripts/other.json", "");',
      ].join("\n"),
    ).join(","),
    "writeFileSync:5",
    "the opt-out silences a write only when it carries a reason",
  );
}

// --- the real suites -------------------------------------------------------------
function vitestSuites(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...vitestSuites(p));
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// The node list comes from the runner's own discovery, so a suite the runner
// executes is a suite this reads (L41, L96).
const suites = [
  ...discoverSuiteNames(join(ROOT, "scripts")).map((f) => join(ROOT, "scripts", f)),
  ...vitestSuites(join(ROOT, "src")),
];
// This file's fixtures are writes into the tree by construction, so it is the
// one suite the sweep does not read (L673). They are strings, which the scan
// ignores anyway, but excluding it states the intent rather than relying on that.
const SELF = join(ROOT, "scripts", "test-no-tree-writes.ts");

const findings: string[] = [];
let scanned = 0;
for (const file of suites) {
  if (file === SELF) continue;
  scanned++;
  const rel = relative(ROOT, file);
  for (const w of scanTreeWrites(readFileSync(file, "utf8"), rel)) {
    findings.push(`  ${rel}:${w.line} ${w.call}(${w.target})`);
  }
}

// Zero suites scanned is a broken walk, never a clean tree (L98).
assert(
  scanned > 300 && suites.some((f) => f.endsWith(".test.tsx")),
  `scanned the real suites, node and vitest (${scanned} files)`,
);
assert(
  findings.length === 0,
  findings.length === 0
    ? `no test suite writes into the repo tree (${scanned} suites; every write targets a temp directory)`
    : "these suites write somewhere not proven to be a temp directory. Concurrent suites walking the tree " +
        "can list the file and fail to open it (#2712). Write under mkdtempSync(join(tmpdir(), ...)) instead, " +
        'or annotate with "// tree-write-ok: <why>":\n' +
        findings.join("\n"),
);

finish();
