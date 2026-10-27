// The load run re-run rule (#3103): a push to main that changes the confirm path or a
// cron lane opens (or is recorded on) one "load run due" issue, through
// .github/workflows/loadtest-due.yml.
//
// The rule is only as good as its path list, and a path list rots silently: rename a
// directory and the trigger matches nothing, add a cron lane under a new directory and
// it is exempt (L96). So this pins, offline:
//
//   - the workflow's `paths:` block is EXACTLY `LOADTEST_DUE_PATHS`, so the list read
//     here is the list GitHub reads;
//   - every route `CRON_ROUTES` dispatches, and the confirm route and service, sit under
//     one of those paths (derived from the routes, not a second list);
//   - every entry matches at least one real file, so a rename fails here rather than
//     quietly disarming the trigger;
//   - the matcher itself refuses a path outside the list (a matcher that said yes to
//     everything would pass every check above).
//
// Run: node --experimental-strip-types scripts/test-loadtest-due-paths.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { LOADTEST_DUE_PATHS, isLoadtestDuePath } from "./lib/loadtest-due-paths.ts";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const workflowPath = join(root, ".github/workflows/loadtest-due.yml");

assert(existsSync(workflowPath), "the re-run nag workflow exists");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

/** The quoted entries of the first `paths:` block, in order. */
function workflowPaths(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s+paths:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const m = /^\s+-\s+"([^"]+)"\s*$/.exec(line);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

const listed = workflowPaths(workflow);
assert(listed.length > 0, "the workflow declares a paths filter");
assert(
  JSON.stringify(listed) === JSON.stringify([...LOADTEST_DUE_PATHS]),
  `the workflow's paths are exactly LOADTEST_DUE_PATHS (workflow: ${JSON.stringify(listed)})`,
);
assert(/^on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/m.test(workflow), "it fires on a push to main");
assert(/timeout-minutes:\s*\d+/.test(workflow), "its job carries an explicit timeout (L313)");
assert(/issues:\s*write/.test(workflow), "it may write issues and nothing broader is needed");
assert(!/secrets\.(?!GITHUB_TOKEN)/.test(workflow), "it needs no repo secret beyond the per run token");

// Every pattern is a directory prefix (`dir/**`) or one exact file, which is all the
// matcher understands; anything else would be read differently here and by GitHub.
for (const p of LOADTEST_DUE_PATHS) {
  assert(/^[A-Za-z0-9_.\-/[\]]+(\/\*\*)?$/.test(p) && !p.slice(0, -3).includes("*"), `"${p}" is a dir/** prefix or an exact file`);
}

// Every cron route, derived from what the Worker dispatches.
const routes = Object.values(CRON_ROUTES).flatMap((r) => (Array.isArray(r) ? r : [r]));
assert(routes.length > 0, "CRON_ROUTES dispatches at least one route");
for (const route of routes) {
  const file = `src/app${route}/route.ts`;
  assert(existsSync(join(root, file)), `${route} has a route file at ${file}`);
  assert(isLoadtestDuePath(file), `a change to the ${route} lane is a load run due`);
}
for (const file of ["src/app/api/bookings/route.ts", "src/lib/booking/service.ts", "worker/index.ts", "wrangler.jsonc"]) {
  assert(existsSync(join(root, file)), `${file} exists`);
  assert(isLoadtestDuePath(file), `a change to ${file} is a load run due`);
}

// Each entry matches a real file.
function anyFileUnder(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (statSync(dir).isFile()) return true;
  return readdirSync(dir).some((n) => anyFileUnder(join(dir, n)));
}
for (const p of LOADTEST_DUE_PATHS) {
  const target = join(root, p.endsWith("/**") ? p.slice(0, -3) : p);
  assert(anyFileUnder(target), `"${p}" matches at least one file in the tree`);
}

// The matcher refuses what is outside the list, both by prefix and by a near miss.
assert(!isLoadtestDuePath("docs/cloudflare-platform-notes.md"), "a docs change is not a load run due");
assert(!isLoadtestDuePath("src/app/admin/page.tsx"), "an admin page change is not a load run due");
assert(!isLoadtestDuePath("src/lib/bookingx/a.ts"), "a sibling directory sharing a prefix does not match");
assert(!isLoadtestDuePath("scripts/loadtest/RUNBOOK.md"), "recording a run does not ask for another run");

finish();
