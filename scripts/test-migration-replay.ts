// #3099: the decisions `pnpm verify:migration-replay-sql` makes, pinned offline.
//
// The replay itself needs Docker and runs in .github/workflows/db-replay.yml. What
// can be wrong WITHOUT a database is decided here: which files are replayed and in
// what order, what each batch records in the CLI's history table, whether the
// platform's default grants are really present (without them every RLS check
// passes on a missing GRANT instead of on RLS, L714), how a refused write is told
// from one that got past RLS, and which browser policies are allowed to exist.
//
// Run: node --experimental-strip-types scripts/test-migration-replay.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_GRANT_EXEMPT,
  BROWSER_POLICY_ALLOWLIST,
  browserWriteRefused,
  classifyWriteOutcome,
  judgeGrantExemptions,
  missingCalls,
  judgeBrowserPolicies,
  judgeDefaultGrants,
  migrationBatch,
  migrationPlan,
} from "./lib/migration-replay.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the plan: every NNNN_*.sql file, in order, nothing else ------------------------
{
  const plan = migrationPlan(["0002_b.sql", "applied-content.lock", "0001_a.sql", "0010_c.sql"]);
  assert(plan.ok, "a well formed directory plans");
  if (plan.ok) {
    eq(plan.files.map((f) => f.file), ["0001_a.sql", "0002_b.sql", "0010_c.sql"], "sorted by version, the lock file left out");
    eq(plan.files.map((f) => f.version), ["0001", "0002", "0010"], "the version is the four digit prefix, as db push records it");
    eq(plan.files[0]?.name, "a", "the name is what follows the prefix");
  }
}
{
  const plan = migrationPlan(["0001_a.sql", "0001_b.sql"]);
  assert(!plan.ok && /0001/.test(plan.error), "two files sharing a version are refused by name, not replayed in an arbitrary order");
}
{
  const plan = migrationPlan(["0001_a.sql", "20260901120000_mcp_apply.sql"]);
  assert(!plan.ok && /20260901120000_mcp_apply\.sql/.test(plan.error),
    "a .sql file that is not NNNN_name is refused, never silently skipped (a skipped migration is the defect this exists to catch)");
}
{
  const plan = migrationPlan(["applied-content.lock"]);
  assert(!plan.ok, "a directory with no migrations is refused: replaying nothing is never a pass (L98)");
}
// The real directory plans, so the offline suite fails the day a file name breaks it.
{
  const dir = join(import.meta.dirname, "..", "supabase", "migrations");
  const plan = migrationPlan(readdirSync(dir));
  assert(plan.ok, `the real migrations directory plans (${plan.ok ? plan.files.length : plan.error})`);
  if (plan.ok) assert(plan.files.length >= 157, `and holds every migration (${plan.files.length})`);
}

// --- each batch records itself, inside its own transaction ---------------------------
{
  const batch = migrationBatch({ file: "0071_x.sql", version: "0071", name: "x" }, "create table t(id int); -- trailing comment");
  assert(batch.startsWith("create table t(id int);"), "the migration text goes first, verbatim");
  assert(/\n\s*insert into supabase_migrations\.schema_migrations \(version, name\) values \('0071', 'x'\);/.test(batch),
    "then the history row db push would write, on its own line so a trailing comment cannot swallow it");
  const quoted = migrationBatch({ file: "0001_o'brien.sql", version: "0001", name: "o'brien" }, "select 1;");
  assert(quoted.includes("'o''brien'"), "a quote in a file name is escaped rather than breaking the batch");
}

// --- the platform's default grants are the precondition -----------------------------
{
  const real = [
    { owner: "postgres", schema: "public", type: "r", acl: "{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}" },
    { owner: "postgres", schema: "public", type: "f", acl: "{postgres=X/postgres,anon=X/postgres}" },
  ];
  eq(judgeDefaultGrants(real), [], "the supabase/postgres image's default ACL satisfies the precondition");
  const plain = [{ owner: "postgres", schema: "public", type: "f", acl: "{postgres=X/postgres}" }];
  const missing = judgeDefaultGrants(plain);
  assert(missing.length === 3 && missing.every((m) => /default/.test(m)),
    `a plain postgres image is refused for anon, authenticated and service_role (got ${JSON.stringify(missing)})`);
  const selectOnly = [{ owner: "postgres", schema: "public", type: "r", acl: "{anon=r/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}" }];
  assert(judgeDefaultGrants(selectOnly).some((m) => /anon/.test(m)),
    "anon holding SELECT alone is refused: the write checks need the INSERT the platform really grants");
}

// --- a write is refused, or it is a finding -------------------------------------------
{
  eq(classifyWriteOutcome(null), "written", "no error means the row was written");
  eq(classifyWriteOutcome('ERROR:  new row violates row-level security policy for table "users"'), "refused-by-rls", "RLS refusal");
  eq(classifyWriteOutcome("ERROR:  permission denied for table advisor_photos"), "refused-by-grant", "a revoked grant is a refusal too");
  eq(classifyWriteOutcome('ERROR:  null value in column "email" of relation "users" violates not-null constraint'), "got-past-rls",
    "a constraint error means RLS let the row through to the constraints, which is a finding");
  eq(classifyWriteOutcome(""), "got-past-rls", "an empty error text is not read as a refusal");
}

// --- browser policies: exactly the allowlist ------------------------------------------
{
  const real = [{ table: "users", policy: "self can read own user row", cmd: "SELECT", roles: "{public}" }];
  eq(judgeBrowserPolicies(real), { unexpected: [], missing: [] }, "production's one browser policy is the allowlist");
  const extra = [...real, { table: "bookings", policy: "anyone reads", cmd: "SELECT", roles: "{anon}" }];
  eq(judgeBrowserPolicies(extra).unexpected, ["bookings: anyone reads (SELECT for {anon})"], "a new policy a browser role can use is named");
  eq(judgeBrowserPolicies([]).missing, ["users: self can read own user row"], "and the self read going missing is named too");
  const serviceOnly = [...real, { table: "bookings", policy: "server", cmd: "ALL", roles: "{service_role}" }];
  eq(judgeBrowserPolicies(serviceOnly).unexpected, [], "a policy only service_role can use is not a browser policy");
  assert(BROWSER_POLICY_ALLOWLIST.every((p) => p.reason.length > 20), "every allowlisted policy carries its reason");
}

// --- the Docker run consults these judges, in the order that matters -------------------
//
// The replay itself is proved by running it (CI, and planted controls recorded in
// docs/verify-commands.md). What this pins offline is the wiring: the precondition
// is judged BEFORE any migration is applied, so an image without the default grants
// is refused rather than measured, and every judge above is actually called.
const JUDGES = [
  "migrationPlan",
  "migrationBatch",
  "judgeDefaultGrants",
  "classifyWriteOutcome",
  "browserWriteRefused",
  "judgeGrantExemptions",
  "judgeBrowserPolicies",
  "CLI_HISTORY_TABLE_SQL",
];
{
  // Control first (L1): a call deleted while its import stays must read as missing,
  // or this check is satisfied by the import line alone.
  const fixture = [
    'import { judgeBrowserPolicies, migrationBatch, CLI_HISTORY_TABLE_SQL } from "./lib/migration-replay.ts";',
    "sql(CLI_HISTORY_TABLE_SQL);",
    "sql(migrationBatch(m, text));",
  ].join("\n");
  eq(missingCalls(fixture, ["judgeBrowserPolicies", "migrationBatch", "CLI_HISTORY_TABLE_SQL"]), ["judgeBrowserPolicies"],
    "control: an imported judge that is never called is reported missing");
  const multiline = 'import {\n  judgeDefaultGrants,\n} from "./x.ts";\nconst a = 1;';
  eq(missingCalls(multiline, ["judgeDefaultGrants"]), ["judgeDefaultGrants"], "control: a multi line import does not count as a call either");
}
{
  const src = readFileSync(join(import.meta.dirname, "verify-migration-replay-sql.ts"), "utf8");
  eq(missingCalls(src, JUDGES), [], "the replay calls every judge this suite pins");
  const body = src.replace(/^import\b[\s\S]*?from\s*["'][^"']+["'];?/gm, "");
  const grants = body.search(/\bjudgeDefaultGrants\s*\(/);
  const firstBatch = body.search(/\bmigrationBatch\s*\(/);
  assert(grants > 0 && grants < firstBatch, "the default grants are judged before the first migration is sent");
  assert(/singleTransaction: true/.test(body), "each migration is applied as one transaction");
  assert(/\["anon", "authenticated"\]/.test(body), "the write refusal is driven as both browser roles");
  assert(/process\.exit\(2\)/.test(body), "an image without the default grants exits 2, UNMEASURED, rather than 1");
}

// --- grant exemptions: exactly the recorded list, and only RLS counts elsewhere ---------
{
  eq(judgeGrantExemptions(["advisor_photos"]), { unexplained: [], stale: [] }, "the one revoked table is the exempt list");
  eq(judgeGrantExemptions(["advisor_photos", "bookings"]).unexplained, ["bookings"], "a table losing its grant without a reason is named");
  eq(judgeGrantExemptions([]).stale, ["advisor_photos"], "an exemption whose revoke is gone is named as stale");
  assert(BROWSER_GRANT_EXEMPT.every((e) => e.reason.length > 20), "every exemption carries its reason");

  assert(browserWriteRefused("bookings", "refused-by-rls"), "on a granted table RLS refusing is a pass");
  assert(!browserWriteRefused("bookings", "refused-by-grant"), "on a granted table a permission denial is NOT counted as RLS");
  assert(!browserWriteRefused("bookings", "got-past-rls"), "and a row reaching the constraints fails");
  assert(browserWriteRefused("advisor_photos", "refused-by-grant"), "on an exempt table the revoke is the refusal");
  assert(!browserWriteRefused("advisor_photos", "written"), "and a write there still fails");
}

finish();
