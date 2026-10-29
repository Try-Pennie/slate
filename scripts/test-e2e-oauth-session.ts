// #4379: the browser checks' local stack gives every session the OAuth `amr` production's
// sessions carry, and production gets no such thing.
//
// Slate refuses any session whose verified `amr` is not OAuth alone. The local sign in is
// a magic link, so e2e/supabase.config.toml registers a custom access token hook that
// rewrites that claim (e2e/oauth-session-hook.sql). Running the suite with it switched
// off was measured on 2026-10-29: the admin sign in and impersonation specs failed, which
// is the gate refusing a real magic link session. This holds the pieces together as text:
//   - the config registers the hook, enabled, naming the function the SQL file defines;
//   - e2e/run.ts copies that file into the stack's migrations under a version after every
//     real migration, so it runs last;
//   - no real migration defines the function, so production never has it.
//
// Run: node --experimental-strip-types scripts/test-e2e-oauth-session.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const config = readFileSync(join(ROOT, "e2e", "supabase.config.toml"), "utf8");
const hookSql = readFileSync(join(ROOT, "e2e", "oauth-session-hook.sql"), "utf8");
const run = readFileSync(join(ROOT, "e2e", "run.ts"), "utf8");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const block = config.match(/^\[auth\.hook\.custom_access_token\]\s*\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)?.[1] ?? "";
assert(/^\s*enabled\s*=\s*true\s*$/m.test(block), "the e2e stack registers the custom access token hook, enabled");
const fn = block.match(/uri\s*=\s*"pg-functions:\/\/postgres\/public\/([a-z0-9_]+)"/)?.[1];
eq(fn, "e2e_oauth_session_claims", "naming the hook function");
assert(new RegExp(`create or replace function public\\.${fn}\\(event jsonb\\)`).test(hookSql), "which the e2e SQL file defines");
assert(/'method', 'oauth'/.test(hookSql), "and which sets the OAuth method");

const version = run.match(/E2E_OAUTH_HOOK_FILE = "(\d{4})_[a-z0-9_]+\.sql"/)?.[1];
assert(Boolean(version), "e2e/run.ts copies the hook file under a NNNN_name.sql version");
assert(/cpSync\(join\(ROOT, "e2e", "oauth-session-hook\.sql"\)/.test(run), "e2e/run.ts copies e2e/oauth-session-hook.sql into the stack");
const real = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f));
const highest = real.map((f) => f.slice(0, 4)).sort().at(-1) ?? "";
assert(Boolean(version) && version! > highest, `the hook file's version (${version}) sorts after every real migration (${highest})`);

// The local stack restates users_outside_email_is_coordinator for its own staff domain.
// Everything but the domain comparison must be the real migration's, or the browser
// checks run against a rule production does not have.
{
  const checkOf = (sql: string): string | null => {
    const m = sql.match(/add constraint users_outside_email_is_coordinator\s+check \(([\s\S]*?)\);/);
    if (!m) return null;
    return m[1]!.replace(/\s+/g, " ").replace(/(= 'trypennie\.com'|in \('trypennie\.com', 'slate-e2e\.test'\))/, "<company domain>").trim();
  };
  const migration = real.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).find((t) => checkOf(t) !== null) ?? "";
  const shipped = checkOf(migration);
  assert(shipped !== null && /deactivated_at is not null/.test(shipped), "the real CHECK binds only rows that can sign in");
  eq(checkOf(hookSql), shipped, "the e2e restatement is the real CHECK with only the company domain changed");
}

const leaks = real.filter((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes("e2e_oauth_session_claims"));
eq(leaks, [], "no real migration defines the e2e hook, so production never has it");
assert(!/custom_access_token\]\s*\n\s*enabled\s*=\s*true/.test(readFileSync(join(ROOT, "supabase", "config.toml"), "utf8")), "the developer stack's config registers no such hook either");

finish();
