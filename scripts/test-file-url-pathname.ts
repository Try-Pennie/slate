// Repo invariant (#3041): no code takes a file system path from a file URL's
// `.pathname`, which stays percent encoded.
// Run: node --experimental-strip-types scripts/test-file-url-pathname.ts
//
// `new URL("..", import.meta.url).pathname` breaks every read built from it once
// the checkout sits under a folder with a space or a curly apostrophe, and the
// pre push gate (a temp worktree under /var/folders) and CI (a plain checkout
// path) can never see that. So the rule is held here, over the whole tree, and
// the fix is `fileURLToPath(new URL(..., import.meta.url))` or
// `import.meta.dirname`. The rule and its blind spots are in
// `scripts/lib/scan-file-url-pathname.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanFileUrlPathname } from "./lib/scan-file-url-pathname.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const lines = (src: string, name = "x.ts") => scanFileUrlPathname(src, name).map((f) => f.line).join(",");

// --- the rule, on fixtures ----------------------------------------------------
{
  // THE POSITIVE CONTROLS: the shapes #3041 shipped.
  eq(lines('const ROOT = new URL("..", import.meta.url).pathname;'), "1", "the repo root shape is caught");
  eq(lines('const self = new URL(import.meta.url).pathname;'), "1", "the module's own URL is caught");
  eq(
    lines('const p = new URL(\n  "../src/x.ts",\n  import.meta.url,\n).pathname;'),
    "1",
    "a call split across lines is caught",
  );
  eq(
    lines('const here = new URL(".", import.meta.url).pathname;', "vitest.config.mjs"),
    "1",
    "a plain JavaScript config is caught",
  );
  eq(
    lines('const u = new URL("..", import.meta.url);\nconst a = 1;\nreadFileSync(u.pathname);'),
    "3",
    "a file URL bound to a name and read later is caught where it is read",
  );
  eq(lines('import { pathToFileURL } from "node:url";\nconst p = pathToFileURL(x).pathname;'), "2", "pathToFileURL encodes too");
  eq(lines("const s = `${new URL(\"x\", import.meta.url).pathname}`;"), "1", "inside a template substitution, which is code, is caught");

  // THE NEGATIVE CONTROLS: the decoding forms, and things that only LOOK alike.
  eq(lines('const ROOT = fileURLToPath(new URL("..", import.meta.url));'), "", "fileURLToPath passes");
  eq(lines('const ROOT = import.meta.dirname;'), "", "import.meta.dirname passes");
  eq(lines('readFileSync(new URL("../x", import.meta.url), "utf8");'), "", "handing the URL object itself to fs passes");
  eq(lines('const p = new URL(req.url).pathname;'), "", "a request URL is a URL path, not a file path, and passes");
  eq(lines('const p = new URL("/a", "https://x.local").pathname;'), "", "a URL with a non file base passes");
  eq(
    lines("const fixture = 'const r = new URL(\"..\", import.meta.url).pathname;';\n// new URL(\"..\", import.meta.url).pathname"),
    "",
    "the shape NAMED in a string or a comment is not a finding",
  );
}

// --- the real tree --------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".open-next", ".claude", ".wrangler", "coverage"]);
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(join(dir, entry.name)));
    } else if (CODE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT).map((f) => ({ rel: relative(ROOT, f), src: readFileSync(f, "utf8") }));
const relSet = new Set(files.map((f) => f.rel));

// The walk has to have reached the places the class lived, or a clean result means nothing (L98).
for (const must of [
  "scripts/check-workflow-settings.ts",
  "scripts/__fixtures__/vitest-tripwire/vitest.config.mjs",
  "worker/index.ts",
  "vitest.config.ts",
  "src/lib/log.ts",
]) {
  assert(relSet.has(must), `the scan read ${must}`);
}
assert(files.length > 500, `the scan read the whole tree (${files.length} files)`);

// A positive control on the REAL tree: put the #3041 shape back into the settings
// guard, in memory only, and the scan must blame that file.
{
  const real = files.find((f) => f.rel === "scripts/check-workflow-settings.ts");
  const base = real?.src ?? "";
  const reverted = base + '\nconst repoRootAgain = new URL("..", import.meta.url).pathname;\n';
  const plantedLine = reverted.split("\n").length - 1;
  assert(real !== undefined, "the settings guard is in the tree to plant into");
  assert(
    scanFileUrlPathname(reverted, "check-workflow-settings.ts").some((f) => f.line === plantedLine),
    "the shape put back into the real settings guard is caught, on the line it was planted",
  );
}

const findings = files.flatMap((f) => scanFileUrlPathname(f.src, f.rel).map((x) => `${f.rel}:${x.line} ${x.text}`));
assert(
  findings.length === 0,
  findings.length === 0
    ? "no code takes a path from a file URL's .pathname"
    : `a path is taken from a percent encoded file URL; use fileURLToPath(new URL(..., import.meta.url)) or import.meta.dirname:\n  ${findings.join("\n  ")}`,
);

finish();
