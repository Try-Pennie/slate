// #3099: the real database workflow runs when any of its inputs change (L88), runs
// every real database suite, and treats a missing Docker as the failure it is.
//
// .github/workflows/db-replay.yml is path gated so it does not bill a database run
// on every pull request. A gate written from where the code under test LIVES is the
// classic way such a job goes quiet: the replay also reads scripts/lib, a src/ file
// for the export's table list, package.json (node reads its "type" to load a .ts
// file) and its own workflow, and a change to any of those could break the run
// while the gate never fires. So the inputs are DERIVED here from the real import
// graph of every scripts/verify-*-sql.ts and of the alerter, and each one must be
// matched by the gate; a new import is covered by this failing and naming it,
// rather than by somebody remembering.
//
// Run: node --experimental-strip-types scripts/test-db-replay-workflow.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { walkImportGraph } from "./lib/scan-local-import-graph.ts";
import { parseWorkflowJobs, parseWorkflowTriggers, readTimeoutMinutes } from "./lib/scan-workflow-jobs.ts";
import { pathFilterMatches, readTriggerPaths, uncoveredInputs } from "./lib/workflow-path-filter.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = ".github/workflows/db-replay.yml";
const ALERTER = "scripts/notify-db-replay-failure.ts";
const source = readFileSync(join(ROOT, WORKFLOW), "utf8");

// --- the matcher, on known answers first (L1) ---------------------------------------
{
  assert(pathFilterMatches("supabase/migrations/**", "supabase/migrations/0001_init.sql"), "** matches a file below the directory");
  assert(pathFilterMatches("scripts/verify-*-sql.ts", "scripts/verify-migration-replay-sql.ts"), "* matches within one segment");
  assert(!pathFilterMatches("scripts/verify-*-sql.ts", "scripts/lib/verify-x-sql.ts"), "* does not cross a slash");
  assert(!pathFilterMatches("scripts/verify-*-sql.ts", "scripts/verify-x-live.ts"), "a literal tail is literal");
  assert(pathFilterMatches("package.json", "package.json"), "an exact path matches itself");
  assert(!pathFilterMatches("package.json", "src/package.json"), "and only itself");
  assert(pathFilterMatches(".github/workflows/db-replay.yml", ".github/workflows/db-replay.yml"), "a dot in a pattern is literal");
}
{
  const fixture = [
    "on:",
    "  pull_request:",
    "    paths:",
    '      - "supabase/migrations/**"',
    "      - scripts/verify-*-sql.ts # the suites",
    "  schedule:",
    '    - cron: "0 7 * * *"',
    "jobs:",
  ].join("\n");
  eq(readTriggerPaths(fixture, "pull_request"), ["supabase/migrations/**", "scripts/verify-*-sql.ts"], "the parser reads a paths list, quoted or not");
  eq(readTriggerPaths(fixture, "push"), null, "an event that is not there reads as null, not as an empty gate");
  eq(
    uncoveredInputs(["supabase/migrations/**"], ["supabase/migrations/0001_a.sql", "scripts/lib/throwaway-postgres.ts"]),
    ["scripts/lib/throwaway-postgres.ts"],
    "control: a gate missing scripts/lib names the helper every suite reads",
  );
}

// --- the inputs, derived ---------------------------------------------------------------
const suites = readdirSync(join(ROOT, "scripts")).filter((f) => /^verify-.*-sql\.ts$/.test(f)).map((f) => `scripts/${f}`).sort();
assert(suites.includes("scripts/verify-migration-replay-sql.ts"), `the replay is one of the real database suites (${suites.join(", ")})`);
assert(suites.length >= 4, `the suites were found (${suites.length})`);

const io = {
  readFile: (p: string) => readFileSync(p, "utf8"),
  exists: (p: string) => existsSync(p) && statSync(p).isFile(),
};
/**
 * What node actually loads: `--experimental-strip-types` erases a whole `import type`
 * statement before anything is resolved, so an edge reached only through one is not a
 * runtime edge. Every other import, a mixed `import { type A, b }` included, stays.
 */
const runtimeIo = (base: typeof io) => ({
  ...base,
  readFile: (p: string) => base.readFile(p).replace(/^[ \t]*import\s+type\b[\s\S]*?from\s*["'][^"']+["'];?/gm, ""),
});

/**
 * Packages and aliases anywhere in the RUNTIME import graph: the job installs nothing
 * and loads no alias hook, so any one of them fails the suite at load time, however
 * deep in the graph it sits.
 */
const runtimeForeign = (entry: string, base: typeof io): string[] =>
  walkImportGraph(join(ROOT, entry), { localRoots: [ROOT], io: runtimeIo(base) })
    .foreign.filter((e) => e.reason === "package" || e.reason === "alias" || e.reason === "unresolved")
    .map((e) => `${relative(ROOT, e.from)} -> ${e.specifier}`);

// Control first (L1): a package import planted one module deep, in the src/ file the
// replay reads the export's tables from, must be caught, and a type only import of a
// package must not.
{
  const target = join(ROOT, "src/lib/snowflake/export-core.ts");
  const overlay = (extra: string) => ({
    ...io,
    readFile: (p: string) => (p === target ? `${extra}\n${io.readFile(p)}` : io.readFile(p)),
  });
  const caught = runtimeForeign("scripts/verify-migration-replay-sql.ts", overlay('import { createClient } from "@supabase/supabase-js";'));
  assert(caught.some((e) => e.includes("export-core.ts -> @supabase/supabase-js")),
    `control: a runtime package import one module below the suite is caught (${JSON.stringify(caught)})`);
  const typeOnly = runtimeForeign("scripts/verify-migration-replay-sql.ts", overlay('import type { SupabaseClient } from "@supabase/supabase-js";'));
  eq(typeOnly, [], "control: a type only import, which node erases, is not a runtime edge");
}

const inputs = new Set<string>([WORKFLOW, "package.json"]);
for (const m of readdirSync(join(ROOT, "supabase", "migrations"))) inputs.add(`supabase/migrations/${m}`);
for (const entry of [...suites, ALERTER]) {
  // The gate covers the FULL graph, type only edges included: a type change there can
  // still change what the suite does, and running too often costs only minutes.
  const graph = walkImportGraph(join(ROOT, entry), { localRoots: [ROOT], io });
  for (const f of graph.files) inputs.add(relative(ROOT, f));
  eq(runtimeForeign(entry, io), [], `${entry} reaches no package and no alias anywhere in what node loads, since the job installs nothing`);
}
assert([...inputs].some((p) => p.startsWith("src/")), "the derived inputs reach src/ (the export's table list), which a gate written from scripts/ alone would miss");

for (const event of ["pull_request"]) {
  const paths = readTriggerPaths(source, event);
  assert(paths !== null && paths.length > 0, `${WORKFLOW} gates ${event} on paths (read ${JSON.stringify(paths)})`);
  eq(uncoveredInputs(paths ?? [], [...inputs].sort()), [], `every input the job reads is in the ${event} paths gate (L88)`);
}

// --- token scope: the job only reads the repo ---------------------------------------------
{
  const top = source.match(/^permissions:\s*\n((?: {2}.*\n)+)/m)?.[1] ?? "";
  const scopes = top.split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).filter(Boolean);
  eq(scopes, ["contents: read"], "the workflow's token is scoped to reading contents and nothing else");
  assert(!/^\s{4,}permissions:/m.test(source), "no job widens it again");
}

// --- triggers, timeout, the run itself -------------------------------------------------
const triggers = parseWorkflowTriggers(source);
assert(triggers.events.includes("schedule") && triggers.crons.length === 1, `it also runs nightly (${JSON.stringify(triggers.crons)})`);
assert(triggers.events.includes("workflow_dispatch"), "and on demand");

const jobs = parseWorkflowJobs(source);
eq(jobs.length, 1, "one job");
const job = jobs[0];
if (job) {
  const timeout = readTimeoutMinutes(job.body);
  assert(timeout !== null && timeout <= 20, `the job carries an explicit timeout (L313), got ${timeout}`);
  const runs = job.runs.join("\n");
  assert(/for f in scripts\/verify-\*-sql\.ts/.test(runs), "every suite runs by the glob, so a new one is covered by construction");
  assert(/node --experimental-strip-types "\$f"/.test(runs), "each suite runs on bare node");
  // Exit 2 is UNMEASURED (no Docker). Any non-zero must fail the job, so no
  // `|| true`, no `continue-on-error`, and no exit code treated as a skip.
  assert(!/\|\|\s*true/.test(runs) && !/continue-on-error/.test(job.body), "no suite failure is swallowed");
  assert(!/-eq 2|== *2|\$\? *-ne *2/.test(runs), "exit 2 (no Docker) is not singled out as a pass");
  assert(/if \[ "\$ran" -eq 0 \]/.test(runs), "running no suite at all fails rather than passing (L98)");
  // A cancelled nightly run (the job timeout, or anything superseding it) proved
  // nothing just as a failed one did, and `failure()` alone is false for it, so the
  // alert must fire on both.
  assert(
    new RegExp(`if: \\(failure\\(\\) \\|\\| cancelled\\(\\)\\) && github\\.event_name == 'schedule'[\\s\\S]*${ALERTER.replace(/\./g, "\\.")}`).test(job.body),
    "a failed or cancelled nightly run posts to Slack through the dependency free alerter",
  );
}

// --- nothing cancels the nightly run ---------------------------------------------------
//
// The group is keyed on the ref, and a scheduled run and a manual one both run on
// main, so cancel-in-progress: true would let a hand started run cancel the nightly
// one. Only a superseded PULL REQUEST run may be cancelled.
{
  const cancel = source.match(/^concurrency:\s*\n(?: {2}.*\n)*? {2}cancel-in-progress:\s*(.+)$/m)?.[1]?.trim();
  eq(cancel, "${{ github.event_name == 'pull_request' }}", "only a pull request run is cancelled by a newer one");
}

finish();
