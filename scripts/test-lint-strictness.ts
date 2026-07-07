// Regression lock for #697: `pnpm lint` must fail on ANY warning.
//
// eslint.config.mjs sets no-unused-vars to "warn", and eslint exits 0 on
// warnings by default. PR #696 cleared the repo to zero warnings; without
// --max-warnings=0 the pre-push gate and CI stay green while new warnings pile
// back up (exactly how the ~30 we just cleared accumulated). This guard keeps
// the flag on the lint script so that can't silently regress, and confirms the
// pre-push hook and CI both run lint through `pnpm lint` (inheriting the flag).
// Run: node --experimental-strip-types scripts/test-lint-strictness.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};
const lintScript = pkg.scripts.lint ?? "";

// The flag must be present and set to exactly 0 (any --max-warnings=N with N>0
// would silently allow warnings back in).
assert(
  /--max-warnings(=|\s+)0(\s|$)/.test(lintScript),
  `lint script sets --max-warnings to 0 (got: "${lintScript}")`,
);

// Both gates must route through `pnpm lint` so they inherit the flag rather
// than calling a bare `eslint` that ignores it.
const hook = read(".githooks/pre-push");
assert(
  /(^|\n)\s*pnpm\s+lint(\s|$)/.test(hook),
  "pre-push hook runs `pnpm lint`",
);
const ci = read(".github/workflows/ci.yml");
assert(/pnpm\s+lint(\s|$)/.test(ci), "CI workflow runs `pnpm lint`");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
