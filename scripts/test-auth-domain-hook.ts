// #3082: the before_user_created hook that refuses an account outside the
// Workspace domain, held together across the three places it lives.
//
// The hook is a Postgres function (migration 0158), it is REGISTERED somewhere
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
// `pnpm verify:auth-domain-hook`, which runs the real auth server against the
// migration in Docker and signs up both an outside and a Workspace address.
//
// Run: node --experimental-strip-types scripts/test-auth-domain-hook.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { checkAuthDomainHook } from "./lib/auth-domain-hook-wiring.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const HOOK_FILE = readdirSync(MIGRATIONS).find((f) => /_auth_domain_gate_hook\.sql$/.test(f));

const config = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
const wrangler = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
const migration = HOOK_FILE ? readFileSync(join(MIGRATIONS, HOOK_FILE), "utf8") : "";

assert(Boolean(HOOK_FILE), "a migration defines the auth domain gate hook");

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

  const drifted = migration.replace(/= 'trypennie\.com'/, "= 'pennie.com'");
  assert(drifted !== migration, "control: the domain literal was found to change");
  assert(
    checkAuthDomainHook({ config, migration: drifted, wrangler }).some((p) => /GOOGLE_HOSTED_DOMAIN/.test(p)),
    "control: a hook domain that differs from GOOGLE_HOSTED_DOMAIN is reported",
  );
}

finish();
