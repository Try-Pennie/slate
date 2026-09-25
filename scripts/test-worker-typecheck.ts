// Repo invariant (#1050): the Cloudflare Worker entry is typechecked for the classes
// that break at runtime.
//
// `worker/index.ts` is what `wrangler.jsonc` points `main` at, so it IS the production
// entry point, and it was excluded from every typecheck: bundled by esbuild, which
// strips types without checking them. An undefined identifier there throws on the
// first request the Worker serves, and nothing in the repo would have said so. That is
// the same gap #1504 closed for the scripts tree, on the one file where every single
// request and every cron tick passes through.
//
// It reuses the scripts guard's scan and its BREAKING_CODES, deliberately: one list of
// what "breaks at runtime" means, not two that drift.
//
// TS2578 (an unused @ts-expect-error) is OUT of scope, and this is the interesting
// part. The entry imports `../.open-next/worker.js`, which does not exist until
// `opennextjs-cloudflare build` has run. That import carries an @ts-expect-error, so
// the import error is silent either way, but the DIRECTIVE flips between used and
// unused depending on whether somebody has built recently. A check whose verdict
// depends on that is not a check: it would pass locally and fail in CI, or the reverse,
// and the response to a check that disagrees with itself is to stop reading it.
//
// Run: node --experimental-strip-types scripts/test-worker-typecheck.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BREAKING_CODES, breakingErrors } from "./lib/scan-scripts-typecheck.ts";
import { typecheckWithControl, unreadConfigFiles } from "./lib/typecheck-program.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const CONFIG = "tsconfig.worker.json";
const CONTROL_SOURCE = "export const planted = thisNameIsNotDefinedAnywhere;\n";

/** Typechecked exactly once: the verdict and the planted control come from the
 *  same run, so the control vouches for the run that produced the verdict (L70). */
let tscRuns = 0;

const readSource = (file: string): string[] => {
  try {
    return readFileSync(join(repoRoot, file), "utf8").split("\n");
  } catch {
    return [];
  }
};

// --- one run, carrying its own control ------------------------------------------
// A run that never looked at worker/ and a clean worker/ produce the same empty
// error list (L1, L98). So the run carries a real undefined identifier and must
// report it, as the class it claims to watch, AND must have read every file the
// config names.
//
// The control is planted in a temp directory, never in worker/ (#2712): a file
// written into the repo tree and removed again is one every concurrent suite
// walking that tree can list and then fail to open.
const run = typecheckWithControl(repoRoot, CONFIG, CONTROL_SOURCE);
tscRuns++;
const found = breakingErrors(run.output, (file) =>
  file === run.controlFile ? CONTROL_SOURCE.split("\n") : readSource(file),
);
const control = found.filter((e) => e.file === run.controlFile);
const breaking = found.filter((e) => e.file !== run.controlFile);

assert(
  control.length > 0 && control.every((e) => e.code === "TS2304"),
  control.length === 0
    ? "the planted undefined name was NOT caught, so this run's verdict below means nothing"
    : control.every((e) => e.code === "TS2304")
      ? "this run was PROVEN to report the class it watches: it caught the planted undefined name"
      : `the control was found but not as TS2304 (got ${control.map((e) => e.code).join(", ")}), so the class this guard watches is not the class being reported`,
);

const entry = join(repoRoot, "worker", "index.ts");
assert(
  run.configFiles.includes(entry),
  `${CONFIG} names the Worker entry, worker/index.ts (${run.configFiles.length} files)`,
);
const unread = unreadConfigFiles(run.configFiles, run.readFiles);
assert(
  unread.length === 0,
  unread.length === 0
    ? `the run read every one of the ${run.configFiles.length} files ${CONFIG} names`
    : `the run never read ${unread.length} file(s) ${CONFIG} names: ${unread.join(", ")}`,
);

// --- the verdict --------------------------------------------------------------
assert(
  breaking.length === 0,
  breaking.length === 0
    ? `worker/ carries no ${BREAKING_CODES.join(" or ")} (the classes that throw at runtime)`
    : `worker/ has runtime-breaking errors:\n${breaking
        .map((e) => `  ${e.file}:${e.line} ${e.code} ${e.message}`)
        .join("\n")}`,
);

// The out-of-scope class is asserted as out of scope rather than left implicit, so
// nobody reads this guard as covering more than it does.
assert(
  !BREAKING_CODES.includes("TS2578" as (typeof BREAKING_CODES)[number]),
  "TS2578 is deliberately not a breaking class: its verdict depends on whether .open-next exists",
);

// --- the config actually points at the Worker's own runtime -------------------
{
  // Without the Workers types, `ExecutionContext` is an undefined name and the guard
  // reports the platform's own globals as defects, which is how a guard gets muted.
  const cfg = readFileSync(join(repoRoot, CONFIG), "utf8");
  assert(cfg.includes("@cloudflare/workers-types"), `${CONFIG} uses the Workers runtime types`);
  assert(/"include":\s*\[\s*"worker\/\*\*\/\*\.ts"/.test(cfg), `${CONFIG} includes the worker tree`);

  // And the file wrangler actually loads is in scope. A config that typechecked only
  // the two small helpers beside it would pass while the entry point stayed unchecked.
  const wrangler = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  const main = wrangler.match(/"main":\s*"([^"]+)"/)?.[1] ?? "";
  assert(main.startsWith("worker/"), `wrangler's main is inside the checked tree (${main})`);
}

eq(tscRuns, 1, "the worker tree is typechecked once, and the control rides in that same run");

finish();
