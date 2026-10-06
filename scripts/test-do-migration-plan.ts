// #3352: a pull request that changes a Durable Object class is planned with its hand
// deploy, never discovered after merge.
//
// Cloudflare refuses to upload a release with a pending Durable Object migration as a
// version, so the gradual deploy cannot ship it (`EXIT.classChange`), and until somebody
// ships it by hand every later merge's deploy stops the same way. Dan, 2026-10-06: plan
// these at PR time. The check fails a pull request that adds a top level `migrations`
// entry to wrangler.jsonc unless it carries the `deploy/hand` label, which says the merge
// is planned together with `pnpm cf:deploy:verified`.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-do-migration-plan.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationTagsOf, doMigrationVerdict, HAND_DEPLOY_LABEL } from "./lib/do-migration-plan.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const REAL = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");

const config = (top: string[], loadtest: string[] = top) =>
  `{
  // a comment, as the real file carries
  "name": "slate",
  "migrations": [${top.map((t) => `{ "tag": "${t}", "new_sqlite_classes": ["C${t}"] },`).join("\n")}],
  "env": { "loadtest": { "migrations": [${loadtest.map((t) => `{ "tag": "${t}" }`).join(", ")}] } },
}`;

// --- reading the tags -----------------------------------------------------------------
{
  eq(migrationTagsOf(config(["v1", "v2"])), ["v1", "v2"], "the top level tags are read, comments and trailing commas allowed");
  eq(migrationTagsOf(config([])), [], "no migrations is an empty list");
  eq(migrationTagsOf("{ not json"), null, "a file that does not parse is unreadable, never no migrations");
  eq(migrationTagsOf('{ "migrations": [{ "new_sqlite_classes": ["X"] }] }'), null, "an entry with no tag is unreadable");
  // Positive control on the real file: the two classes Slate ships are found, so a
  // reader that found nothing anywhere could not pass as one that found nothing new. A
  // prefix, not the whole list: the next class change adds v3, and this must not be
  // what that pull request has to edit to go green (L373).
  const real = migrationTagsOf(REAL);
  assert(real !== null && real[0] === "v1" && real[1] === "v2", `the real wrangler.jsonc lists BurstLimiter's v1 and ConfirmLine's v2 first (got ${JSON.stringify(real)})`);
}

// --- the verdict ------------------------------------------------------------------------
{
  const same = doMigrationVerdict({ base: config(["v1", "v2"]), head: config(["v1", "v2"]), labels: [] });
  assert(same.ok, `no new migration passes with no label (got ${same.message})`);

  const added = doMigrationVerdict({ base: config(["v1", "v2"]), head: config(["v1", "v2", "v3"]), labels: [] });
  assert(!added.ok, "a new migration with no label is refused");
  assert(
    added.message.includes("v3") && added.message.includes(HAND_DEPLOY_LABEL) && added.message.includes("pnpm cf:deploy:verified"),
    `naming the tag, the label and the hand deploy (got ${added.message})`,
  );

  const planned = doMigrationVerdict({ base: config(["v1", "v2"]), head: config(["v1", "v2", "v3"]), labels: ["changelog/none", HAND_DEPLOY_LABEL] });
  assert(planned.ok && planned.message.includes("v3") && planned.message.includes("pnpm cf:deploy:verified"), `with the label it passes, still saying what to run (got ${planned.message})`);

  // A tag Cloudflare has applied is never applied again, so editing its entry (a class
  // added to v2) silently never takes effect, and removing one rewrites history. Both
  // are refused whatever the labels say: the change belongs in a new tag.
  const edited = doMigrationVerdict({
    base: config(["v1", "v2"]),
    head: config(["v1", "v2"]).replace('"new_sqlite_classes": ["Cv2"]', '"new_sqlite_classes": ["Cv2", "Extra"]'),
    labels: [HAND_DEPLOY_LABEL],
  });
  assert(!edited.ok && /v2/.test(edited.message) && /new tag/.test(edited.message), `an edited applied migration is refused even with the label (got ${edited.message})`);
  const removed = doMigrationVerdict({ base: config(["v1", "v2"]), head: config(["v1"]), labels: [HAND_DEPLOY_LABEL] });
  assert(!removed.ok && /removes/.test(removed.message) && /v2/.test(removed.message), `a removed migration is refused (got ${removed.message})`);

  // Only the production Worker deploys gradually; the load test Worker deploys whole.
  const loadtestOnly = doMigrationVerdict({ base: config(["v1"], ["v1"]), head: config(["v1"], ["v1", "v9"]), labels: [] });
  assert(loadtestOnly.ok, `a migration added only to env.loadtest is not a production class change (got ${loadtestOnly.message})`);

  // Fail closed: a file that cannot be read cannot rule a class change out (L42).
  const unreadableHead = doMigrationVerdict({ base: config(["v1"]), head: "{ broken", labels: [] });
  assert(!unreadableHead.ok && /could not be read/.test(unreadableHead.message), `an unreadable head is refused by name (got ${unreadableHead.message})`);
  const unreadableBase = doMigrationVerdict({ base: null, head: config(["v1"]), labels: [] });
  assert(!unreadableBase.ok && /base/.test(unreadableBase.message), `an unreadable base is refused by name (got ${unreadableBase.message})`);
}

// --- the workflow is wired to see a label change and the base -------------------------
function wiringProblems(yml: string): string[] {
  const out: string[] = [];
  // Whole names: "unlabeled" contains "labeled", so a substring test cannot see one missing.
  const types = (/types:\s*\[([^\]]*)\]/.exec(yml)?.[1] ?? "").split(",").map((t) => t.trim());
  for (const t of ["opened", "synchronize", "reopened", "labeled", "unlabeled"]) if (!types.includes(t)) out.push(`does not run on ${t}`);
  if (!/paths:\s*\n\s*- wrangler\.jsonc/.test(yml)) out.push("is not limited to pull requests that touch wrangler.jsonc");
  if (!/timeout-minutes:\s*\d+/.test(yml)) out.push("has no job timeout");
  if (!yml.includes("PR_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}")) out.push("is not handed the pull request's labels");
  // The base is the tested merge commit's first parent, which is the base it was built
  // on. The event's base.sha can be older, and a class change landing on main since
  // would then be blamed on this pull request.
  if (!/fetch-depth:\s*2/.test(yml)) out.push("does not fetch the merge commit's parents");
  if (!/BASE_SHA="\$\(git rev-parse HEAD\^1\)"/.test(yml)) out.push("does not compare against the merge commit's first parent");
  if (/pull_request\.base\.sha/.test(yml)) out.push("still reads the event's base.sha, which can be older than the base the merge was built on");
  if (!yml.includes("scripts/check-do-migration-planned.ts")) out.push("does not run the check");
  return out;
}
{
  const yml = readFileSync(join(ROOT, ".github/workflows/do-migration-plan.yml"), "utf8");
  eq(wiringProblems(yml), [], "the workflow is wired as the check needs");
  const controls: [string, string, RegExp][] = [
    ["no labeled trigger", yml.replace(/, labeled/, ""), /labeled/],
    ["labels not passed", yml.replace("PR_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}", ""), /labels/],
    ["no parents fetched", yml.replace(/fetch-depth:\s*2/, "fetch-depth: 1"), /parents/],
    ["the event's base", yml.replace('BASE_SHA="$(git rev-parse HEAD^1)"', 'BASE_SHA="${{ github.event.pull_request.base.sha }}"'), /first parent|older/],
  ];
  for (const [what, broken, says] of controls) {
    assert(broken !== yml, `control (${what}): the copy really was broken`);
    assert(wiringProblems(broken).some((p) => says.test(p)), `control (${what}): caught (got ${JSON.stringify(wiringProblems(broken))})`);
  }
}

finish();
