// #3082: the before_user_created hook that refuses an account outside the
// Workspace domain, held together across the three places it lives.
//
// The hook is a Postgres function (0159, replaced by 0212 for #4379), it is REGISTERED somewhere
// else (supabase/config.toml for the local stack, the dashboard for the hosted
// project), and the domain it refuses against is the same fixed value the app's
// own gate reads (GOOGLE_HOSTED_DOMAIN in wrangler.jsonc). Each piece reads as
// correct on its own while the three disagree:
//
//   - a config.toml URI naming a function nothing defines makes the LOCAL stack
//     refuse every signup, so somebody turns the hook off to get unblocked;
//   - a function whose EXECUTE was never taken back from anon and authenticated
//     is callable over PostgREST, and one never granted to supabase_auth_admin
//     cannot be called by GoTrue at all;
//   - a domain literal that drifts from the app's would refuse the real staff, or
//     admit somebody the app then signs out after their account already exists.
//
// This reads the files. It cannot prove GoTrue honours the hook; that is
// `pnpm verify:auth-domain-hook`, which runs the real auth server against
// every migration replayed in Docker, proving each provider and roster case (#4379).
//
// Run: node --experimental-strip-types scripts/test-auth-domain-hook.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { checkAuthDomainHook, findAuthHookMigration } from "./lib/auth-domain-hook-wiring.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
// Found by what it DEFINES, never by number or name: the number moves whenever another
// migration merges first, and #4379 replaced 0159's function in a migration named for its
// own change. The last migration defining the hook is the one production runs, and the
// Docker proof (verify-auth-domain-hook.ts) finds it the same way.
const found = findAuthHookMigration(
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") })),
);
const HOOK_FILE = "file" in found ? found.file : null;

const config = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
const wrangler = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
const migration = HOOK_FILE ? readFileSync(join(MIGRATIONS, HOOK_FILE), "utf8") : "";

assert(Boolean(HOOK_FILE), `a migration defines the auth domain gate hook, and the last such is the one checked (${"refusal" in found ? found.refusal : HOOK_FILE})`);

// --- the finder: the LAST definition is the one that ships ---------------------
{
  const defines = "create or replace function public.before_user_created_domain_gate(event jsonb)\nreturns jsonb";
  const none = findAuthHookMigration([
    { name: "0157_x.sql", sql: "select 1;" },
    { name: "0158_y.sql", sql: "-- names before_user_created_domain_gate in a comment only" },
  ]);
  assert("refusal" in none && /no migration/.test(none.refusal), "no migration defining the hook is a named refusal");
  // #4379: 0212 replaced 0159's function under the same name, so two definitions is
  // the ordinary shape now, and the later one is what production runs.
  const two = findAuthHookMigration([
    { name: "0212_coordinator_microsoft_sign_in.sql", sql: defines },
    { name: "0159_auth_domain_gate_hook.sql", sql: defines },
    { name: "0160_other.sql", sql: "select 1;" },
  ]);
  eq("file" in two ? two.file : null, "0212_coordinator_microsoft_sign_in.sql", "the latest definition is found, whatever the file order");
  eq("file" in two ? two.earlier : null, ["0159_auth_domain_gate_hook.sql"], "and the earlier definitions are named, not lost");
  const one = findAuthHookMigration([
    { name: "0158_y.sql", sql: "select 1;" },
    { name: "0159_auth_domain_gate_hook.sql", sql: defines },
  ]);
  eq("file" in one ? one.file : null, "0159_auth_domain_gate_hook.sql", "one defining migration is found whatever its number");
}

// --- #4379: the shipped hook is the Microsoft aware one ------------------------
{
  eq(HOOK_FILE, "0212_coordinator_microsoft_sign_in.sql", "the hook production runs is 0212's, which knows the azure provider");
  assert(/security definer/i.test(migration) && /\bstable\b/i.test(migration), "it is SECURITY DEFINER and STABLE, since it reads public.users");
  assert(/from public\.users u/.test(migration), "it reads the users table schema qualified, under the pinned search_path");
  // The staff decision comes before the table is read, so a fault reading the table can
  // never lock staff out (#4379, plan step 1).
  const body = migration.slice(migration.indexOf("create or replace function public.before_user_created_domain_gate"));
  const staffAt = body.indexOf("email_domain = 'trypennie.com'");
  const tableAt = body.indexOf("from public.users");
  assert(staffAt > 0 && tableAt > staffAt, "the trypennie.com decision is made before any table read");
}

// --- the real tree ---------------------------------------------------------
{
  const problems = checkAuthDomainHook({ config, migration, wrangler });
  eq(problems, [], "config.toml, the migration and wrangler.jsonc agree on the hook");
}

// --- positive controls: each way the three can disagree must be caught ------
// A check that finds nothing on a clean tree and nothing on a broken one reads
// the same (L1, L98), so each defect is planted over the REAL files.
{
  const off = config.replace(
    /(\[auth\.hook\.before_user_created\][^[]*?enabled\s*=\s*)true/,
    "$1false",
  );
  assert(off !== config, "control: the hook's enabled line was found to turn off");
  assert(
    checkAuthDomainHook({ config: off, migration, wrangler }).some((p) => /not enabled/.test(p)),
    "control: a hook switched off in config.toml is reported",
  );

  const wrongName = config.replace(/before_user_created_domain_gate"/, 'before_user_created_typo"');
  assert(wrongName !== config, "control: the hook URI was found to rename");
  assert(
    checkAuthDomainHook({ config: wrongName, migration, wrangler }).some((p) => /no migration defines/.test(p)),
    "control: a config.toml URI naming a function nothing defines is reported",
  );

  const stillCallable = migration.replace(/revoke execute[^;]*;/, "");
  assert(stillCallable !== migration, "control: the revoke was found to remove");
  assert(
    checkAuthDomainHook({ config, migration: stillCallable, wrangler }).some((p) => /revoke/.test(p)),
    "control: a hook still executable by the web roles is reported",
  );

  const ungranted = migration.replace(/grant execute[^;]*to supabase_auth_admin;/, "");
  assert(ungranted !== migration, "control: the grant was found to remove");
  assert(
    checkAuthDomainHook({ config, migration: ungranted, wrangler }).some((p) => /supabase_auth_admin/.test(p)),
    "control: a hook the auth server cannot execute is reported",
  );

  const unpinned = migration.replace(/set search_path = pg_catalog\n/, "");
  assert(unpinned !== migration, "control: the search_path pin was found to remove");
  assert(
    checkAuthDomainHook({ config, migration: unpinned, wrangler }).some((p) => /search_path/.test(p)),
    "control: a hook with no pinned search_path is reported",
  );

  // The hook's own comparison, not the CHECK beside it in the same file (#4379).
  const drifted = migration.replace(/email_domain = 'trypennie\.com'/, "email_domain = 'pennie.com'");
  assert(drifted !== migration, "control: the domain literal was found to change");
  assert(
    checkAuthDomainHook({ config, migration: drifted, wrangler }).some((p) => /GOOGLE_HOSTED_DOMAIN/.test(p)),
    "control: a hook domain that differs from GOOGLE_HOSTED_DOMAIN is reported",
  );
}

finish();
