// #3026: the readable advisor link names, proved in a REAL Postgres.
//
// Everything the name promises is decided inside the database (migration 0155):
// how a name is derived from an email, the numbered variant when a name is taken,
// that two concurrent inserts never collide, that a deleted user keeps the name
// reserved, and that no name can ever look like a #2073 token. None of that can be
// shown by the offline suite, which has no database, and a mocked client agrees
// with whatever it is told (L52). So this starts a throwaway Postgres in Docker,
// lays down the slice of the schema the migration reads, applies the migration
// file VERBATIM, and drives it.
//
// It writes nothing outside that container, which it removes on the way out. It is
// deliberately not named test-*.ts: that glob is the offline unit suite, and this
// needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: pnpm verify:agent-link-names
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = readFileSync(join(ROOT, "supabase", "migrations", "0155_agent_link_names.sql"), "utf8");
const IMAGE = process.env.AGENT_LINK_NAMES_PG_IMAGE ?? "postgres:17-alpine";
const NAME = `slate-agent-link-names-${process.pid}`;

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** One statement batch through psql, ON_ERROR_STOP, tuples only. Throws on an error. */
function sql(text: string): string {
  return docker(
    ["exec", "-i", NAME, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX", "-f", "-"],
    text,
  ).trim();
}

/** Run a statement expected to FAIL, returning the error text (or null if it succeeded). */
function sqlError(text: string): string | null {
  try {
    sql(text);
    return null;
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

/** A SQL string literal. */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function nameOf(email: string): string {
  return sql(`select n.name from agent_link_names n join users u on u.id = n.user_id where u.email = ${lit(email)};`);
}

function insertUser(email: string): void {
  sql(`
    with a as (insert into auth.users (id) values (gen_random_uuid()) returning id)
    insert into users (id, org_id, email) select a.id, (select id from organizations), ${lit(email)} from a;
  `);
}

try {
  docker(["version", "--format", "{{.Server.Version}}"]);
} catch {
  console.error("UNMEASURED: Docker is not available here, so nothing was proved.");
  process.exit(2);
}

// A container that cannot start (the image cannot be pulled, the name is taken)
// proved nothing about the migration, so it is the same UNMEASURED exit as no
// Docker at all, never the failed check exit.
try {
  docker(["run", "-d", "--rm", "--name", NAME, "-e", "POSTGRES_PASSWORD=x", IMAGE]);
} catch (err) {
  const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
  console.error(`UNMEASURED: the ${IMAGE} container could not start (${why}), so nothing was proved.`);
  process.exit(2);
}

try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      sql("select 1;");
      ready = true;
    } catch {
      execFileSync("sleep", ["1"]);
    }
  }
  if (!ready) throw new Error("the throwaway Postgres never accepted a connection");

  // The slice of the schema 0155 reads, shaped as 0001 declares it, plus the two
  // API roles its REVOKEs name.
  sql(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table organizations (id uuid primary key default gen_random_uuid());
    insert into organizations default values;
    create table users (
      id uuid primary key references auth.users(id) on delete cascade,
      org_id uuid not null references organizations(id) on delete cascade,
      email text not null unique,
      created_at timestamptz not null default now()
    );
  `);

  // Users who exist BEFORE the migration, so the backfill is what names them. The
  // second shares a username across the two email domains, and is created later.
  insertUser("rdaboub@trypennie.com");
  sql("select pg_sleep(0.01);");
  insertUser("rdaboub@halo-lab.com");
  insertUser("jsmith@trypennie.com");

  sql(MIGRATION);

  // --- the backfill -----------------------------------------------------------
  eq(nameOf("rdaboub@trypennie.com"), "rdaboub", "the backfill names a user by their email username");
  eq(nameOf("rdaboub@halo-lab.com"), "rdaboub2", "the same username on the other domain gets the next variant, oldest keeps the plain name");
  eq(nameOf("jsmith@trypennie.com"), "jsmith", "every existing user is named");
  eq(sql("select count(*) from agent_link_names;"), "3", "one name per existing user, nothing extra");

  // Idempotent: re-running the backfill adds nothing and changes nothing.
  sql("do $$ declare r record; begin for r in select id, email from users loop perform reserve_agent_link_name(r.id, r.email); end loop; end $$;");
  eq(sql("select count(*) from agent_link_names;"), "3", "re-running the reservation adds nothing");
  eq(nameOf("rdaboub@halo-lab.com"), "rdaboub2", "and keeps every existing name");

  // --- the trigger on a new user -------------------------------------------------
  insertUser("NewHire@trypennie.com");
  eq(nameOf("NewHire@trypennie.com"), "newhire", "a new user is named on insert, lowercased");
  insertUser("rdaboub@other.example");
  eq(nameOf("rdaboub@other.example"), "rdaboub3", "the lowest free variant, after rdaboub and rdaboub2");
  insertUser("o'neil+tag.@trypennie.com");
  eq(nameOf("o'neil+tag.@trypennie.com"), "oneiltag", "characters outside the shape are dropped and punctuation trimmed");
  insertUser("+++@trypennie.com");
  eq(nameOf("+++@trypennie.com"), "advisor", "a username with nothing usable becomes advisor");
  const hex = "ab".repeat(32);
  insertUser(`${hex}@trypennie.com`);
  const hexName = nameOf(`${hex}@trypennie.com`);
  assert(!/^[0-9a-f]{64}$/.test(hexName), `a token shaped username is never a token shaped name (got ${hexName.length} characters)`);

  // --- the shape CHECK, both directions -------------------------------------------
  for (const [bad, why] of [
    [hex, "64 hex characters, a #2073 token"],
    [".", "a dot alone, a path segment"],
    ["..", "two dots, a parent path"],
    ["Upper", "upper case"],
    ["a/b", "a slash"],
    ["-lead", "leading punctuation"],
    ["a".repeat(73), "longer than 72"],
  ] as const) {
    assert(
      /violates check constraint/.test(sqlError(`insert into agent_link_names (name) values ('${bad}');`) ?? ""),
      `the CHECK refuses a name with ${why}`,
    );
  }
  // Positive control: the same insert path accepts a well formed name, so the
  // refusals above are the CHECK and not a broken statement.
  eq(sqlError("insert into agent_link_names (name) values ('a.b_c-d9');"), null, "positive control: a well formed unowned name is accepted");

  // --- an email change does not move the name -------------------------------------
  sql("update users set email = 'renamed@trypennie.com' where email = 'jsmith@trypennie.com';");
  eq(nameOf("renamed@trypennie.com"), "jsmith", "an email change leaves the name as it was");

  // --- a name is never released or reused ------------------------------------------
  const newhireId = sql("select id from users where email = 'NewHire@trypennie.com';");
  sql(`delete from users where id = '${newhireId}';`);
  eq(sql("select coalesce(user_id::text, 'null') from agent_link_names where name = 'newhire';"), "null", "deleting a user keeps their name, booking nobody");
  insertUser("newhire@halo-lab.com");
  eq(nameOf("newhire@halo-lab.com"), "newhire2", "a later hire with a departed user's username gets a variant, never the old name");

  assert(/never released \(#3026\)/.test(sqlError("delete from agent_link_names where name = 'newhire';") ?? ""), "a name cannot be deleted");
  assert(/never released \(#3026\)/.test(sqlError("truncate agent_link_names;") ?? ""), "the names cannot be truncated");
  assert(/never renamed \(#3026\)/.test(sqlError("update agent_link_names set name = 'other' where name = 'jsmith';") ?? ""), "a name cannot be renamed");
  const someoneElse = sql("select id from users where email = 'rdaboub@trypennie.com';");
  assert(
    /never moves to another user \(#3026\)/.test(sqlError(`update agent_link_names set user_id = '${someoneElse}' where name = 'newhire';`) ?? ""),
    "a reserved name cannot be handed to another user",
  );
  eq(sql("select count(*) from agent_link_names where name = 'newhire';"), "1", "the refused writes left the name in place");

  // --- two concurrent inserts of one username ----------------------------------------
  // Each session holds its transaction open, so the second insert of the same name
  // has to wait on the first and then move to the next variant.
  const racer = (email: string) =>
    new Promise<number>((resolve) => {
      const p = spawn("docker", ["exec", "-i", NAME, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX", "-f", "-"]);
      p.stdin.end(`begin;
        with a as (insert into auth.users (id) values (gen_random_uuid()) returning id)
        insert into users (id, org_id, email) select a.id, (select id from organizations), '${email}' from a;
        select pg_sleep(1);
        commit;`);
      p.on("close", (code) => resolve(code ?? 1));
    });
  const codes = await Promise.all([racer("racer@trypennie.com"), racer("racer@halo-lab.com")]);
  eq(codes, [0, 0], "both concurrent inserts committed, neither was refused");
  eq(
    sql("select string_agg(name, ',' order by name) from agent_link_names where name like 'racer%';"),
    "racer,racer2",
    "concurrent users with one username get the name and its first variant",
  );

  // --- RLS ------------------------------------------------------------------------
  eq(sql("select relrowsecurity from pg_class where relname = 'agent_link_names';"), "t", "RLS is on");
} finally {
  try {
    docker(["rm", "-f", NAME]);
  } catch {
    // Already gone.
  }
}

finish();
