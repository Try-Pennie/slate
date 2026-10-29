// #3099: every migration replayed into an EMPTY Supabase Postgres, then the
// database asked who can read and write what.
//
// Production is built by applying these files one at a time, each on top of a
// database that already held the last. A migration that leans on state production
// happens to have (a role, a grant, a row, an object a hand fix created) applies
// cleanly there and fails on a fresh one, and nothing noticed: the 157 files had
// been replayed from empty once, on a preview branch on 2026-09-02, which is also
// how #2271 found that a replay produced the right schema and a dead API.
//
// So this starts the supabase/postgres image, which carries the platform's roles
// and, the part that matters, its DEFAULT GRANTS: every table `postgres` creates in
// `public` is granted to anon and authenticated the moment it exists (L714). A
// plain postgres image has no such grants, so every refusal measured on it would be
// a missing GRANT and the checks below would pass on exactly the mistake they exist
// to catch; the precondition step refuses to judge anything on an image without them.
//
// The files are applied as `postgres`, one transaction each, with the history row
// `supabase db push` writes, so migration 0071 and its successors find the table
// they read. Then:
//   - the history reads back every version, through the server's own function;
//   - every public table has RLS on, and the only policy a browser role can use is
//     the one allowlisted in scripts/lib/migration-replay.ts;
//   - as anon AND authenticated, an insert into every public table is refused;
//   - a signed in user reads their own row and nobody else's, anon reads none, and
//     the user can neither update nor delete it;
//   - no SECURITY DEFINER function in public is executable by a browser role;
//   - service_role, the credential the Snowflake export lane reads with, can read
//     every mirrored table (MIRROR_TABLES, the export's own list) and its cursor;
//   - pet_reader, the one external export login (0134), reads pet_export.closed_days
//     and nothing in public.
//
// It writes nothing outside that container, which it removes on the way out. Not
// named test-*.ts: it needs Docker, which the offline suite does not have. No Docker
// is exit 2 and says UNMEASURED, never a pass (L98, L411); in CI that is a failure.
//
// Run: pnpm verify:migration-replay-sql
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import {
  CLI_HISTORY_TABLE_SQL,
  browserWriteRefused,
  classifyWriteOutcome,
  judgeBrowserPolicies,
  judgeGrantExemptions,
  judgeDefaultGrants,
  migrationPlan,
  replayMigrations,
} from "./lib/migration-replay.ts";
import { MIRROR_TABLES } from "../src/lib/snowflake/export-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
// Overridable only so a planted control can be replayed from a scratch copy.
const DIR = process.env.MIGRATION_REPLAY_DIR || join(ROOT, "supabase", "migrations");
// The image the Supabase CLI runs for `major_version = 17` (supabase/config.toml).
// Pinned, so a new platform image is a diff rather than a surprise on a nightly run.
const IMAGE = process.env.MIGRATION_REPLAY_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-migration-replay-${process.pid}`;

const plan = migrationPlan(readdirSync(DIR));
if (!plan.ok) {
  console.error(`FAIL: ${plan.error}`);
  process.exit(1);
}

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError } = pg;

/** One row per line, columns split on `|`, as psql -tA prints them. */
const rows = (text: string): string[][] => (text === "" ? [] : text.split("\n").map((l) => l.split("|")));

try {
  // --- the precondition: the platform's default grants are really here -------------
  const acl = rows(sql(`
    select pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text, defaclobjtype::text, defaclacl::text
    from pg_default_acl;
  `)).map(([owner, schema, type, a]) => ({ owner: owner ?? "", schema: schema ?? "", type: type ?? "", acl: a ?? "" }));
  const missingGrants = judgeDefaultGrants(acl);
  if (missingGrants.length > 0) {
    // Not a failed check: nothing was measured, so it says UNMEASURED and exits 2
    // like a missing Docker (L411). The workflow fails on any non-zero exit.
    for (const m of missingGrants) console.error(`UNMEASURED: ${m} (image ${IMAGE})`);
    console.error("UNMEASURED: nothing below could tell RLS from a missing grant on this image, so nothing was proved.");
    pg.stop();
    process.exit(2);
  }
  eq(missingGrants, [], `${IMAGE} carries the platform's default grants to anon, authenticated and service_role`);

  // --- the replay ------------------------------------------------------------------
  sql(CLI_HISTORY_TABLE_SQL);
  const started = Date.now();
  const applied = replayMigrations(
    plan.files,
    (file) => readFileSync(join(DIR, file), "utf8"),
    (batch) => void sql(batch, undefined, { singleTransaction: true }),
  );
  eq(applied, plan.files.length,
    `every migration applied to an empty database (${Math.round((Date.now() - started) / 1000)}s)`);

  const recorded = sql("select array_to_string(applied_migration_versions(), ',');", "service_role").split(",");
  const unrecorded = plan.files.map((f) => f.version).filter((v) => !recorded.includes(v));
  eq(unrecorded, [], `the history reads back all ${plan.files.length} versions, through the function the deploy lag monitor calls`);

  // --- RLS: on everywhere, and only the allowlisted browser policy -------------------
  const tables = sql(`
    select relname from pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by 1;
  `).split("\n").filter(Boolean);
  assert(tables.length >= 40, `the replay produced the public tables (${tables.length})`);
  eq(
    sql(`select coalesce(string_agg(relname, ', ' order by relname), '') from pg_class
         where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity;`),
    "",
    "every public table has row level security enabled",
  );
  // The precondition, measured on the replayed tables rather than on the ACL alone:
  // each browser role holds INSERT on every table except the named exemptions, so a
  // refused insert below is RLS refusing it rather than a missing grant.
  for (const role of ["anon", "authenticated"]) {
    const ungranted = sql(`select relname from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')
        and not has_table_privilege('${role}', oid, 'insert') order by 1;`).split("\n").filter(Boolean);
    const exemptions = judgeGrantExemptions(ungranted);
    eq(exemptions.unexplained, [], `${role} holds INSERT on every public table outside BROWSER_GRANT_EXEMPT, so RLS is what refuses it`);
    eq(exemptions.stale, [], `every table in BROWSER_GRANT_EXEMPT really has its ${role} grant revoked`);
  }

  const policies = rows(sql("select tablename, policyname, cmd, roles::text from pg_policies where schemaname = 'public';"))
    .map(([table, policy, cmd, roles]) => ({ table: table ?? "", policy: policy ?? "", cmd: cmd ?? "", roles: roles ?? "" }));
  const judged = judgeBrowserPolicies(policies);
  eq(judged.unexpected, [], "no policy a browser role can use exists beyond the allowlist");
  eq(judged.missing, [], "and the allowlisted self read is present");

  // --- as anon and authenticated, every insert is refused ----------------------------
  for (const role of ["anon", "authenticated"]) {
    const through: string[] = [];
    for (const t of tables) {
      const outcome = classifyWriteOutcome(sqlError(`insert into public.${t} default values;`, role));
      if (!browserWriteRefused(t, outcome)) through.push(`${t} (${outcome})`);
    }
    eq(through, [], `as ${role}, an insert into each of the ${tables.length} public tables is refused, by RLS on every table holding the grant`);
  }

  // --- the one browser read, both directions -----------------------------------------
  const ORG = "00000000-0000-0000-0000-0000000000aa";
  const A = { id: "00000000-0000-0000-0000-00000000000a", auth: "00000000-0000-0000-0000-0000000000a1" };
  const B = { id: "00000000-0000-0000-0000-00000000000b", auth: "00000000-0000-0000-0000-0000000000b1" };
  sql(`
    insert into auth.users (id, email) values ('${A.auth}', 'a@trypennie.com'), ('${B.auth}', 'b@trypennie.com');
    insert into organizations (id, name) values ('${ORG}', 'Replay org');
    insert into users (id, org_id, email, auth_user_id) values
      ('${A.id}', '${ORG}', 'a@trypennie.com', '${A.auth}'),
      ('${B.id}', '${ORG}', 'b@trypennie.com', '${B.auth}');
  `);
  const as = (sub: string | null, text: string) =>
    sql(`${sub ? `set request.jwt.claim.sub = '${sub}';` : ""}\n${text}`, sub ? "authenticated" : "anon");
  eq(as(null, "select count(*) from users;"), "0", "anon reads no user rows");
  eq(as(A.auth, "select string_agg(email, ',') from users;"), "a@trypennie.com", "a signed in user reads their own row and only that one");
  eq(as(B.auth, "select string_agg(email, ',') from users;"), "b@trypennie.com", "and the other user reads theirs, so the policy is keyed on who is asking");
  eq(sql("select count(*) from users;", "authenticated"), "0", "authenticated with no subject reads nothing");
  as(A.auth, "update users set email = 'changed@trypennie.com' where id = '" + A.id + "'; delete from users where id = '" + A.id + "';");
  eq(sql(`select email from users where id = '${A.id}';`), "a@trypennie.com", "a signed in user can neither update nor delete their own row");

  // --- no SECURITY DEFINER function a browser role can call --------------------------
  eq(
    sql(`select coalesce(string_agg(distinct proname, ', '), '') from pg_proc
         where pronamespace = 'public'::regnamespace and prosecdef
           and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'));`),
    "",
    "no SECURITY DEFINER function in public is executable by anon or authenticated (each bypasses RLS)",
  );

  // --- the export credentials ----------------------------------------------------------
  const mirror = [...MIRROR_TABLES.map((t) => t.table), "export_cursor"];
  assert(MIRROR_TABLES.length >= 6, `the export's own table list was read (${MIRROR_TABLES.length} tables)`);
  const unreadable = mirror.filter((t) => sqlError(`select count(*) from public.${t};`, "service_role") !== null);
  eq(unreadable, [], `service_role, which the Snowflake export reads with, reads every mirrored table and the cursor (${mirror.join(", ")})`);

  // pet_reader is a login with no password in a migration; the replay drives it by
  // granting this throwaway database's postgres the right to SET ROLE to it.
  sql("grant pet_reader to postgres;");
  eq(sqlError("select count(*) from pet_export.closed_days;", "pet_reader"), null, "pet_reader reads pet_export.closed_days");
  const petErr = sqlError("select count(*) from public.business_hours_exceptions;", "pet_reader");
  assert(petErr !== null && /permission denied/.test(petErr),
    `pet_reader cannot read the table behind its view (got ${petErr?.trim() ?? "a result"})`);
  eq(
    sql(`select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v')
         and (has_table_privilege('pet_reader', oid, 'select') or has_table_privilege('pet_reader', oid, 'insert'));`),
    "0",
    "pet_reader holds no privilege on any public table",
  );
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
