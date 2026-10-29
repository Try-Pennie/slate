// The pure half of scripts/test-auth-domain-hook.ts (#3082): does supabase/config.toml
// register a before_user_created hook that the migration defines, executable by the
// auth server and nobody else, refusing against the same domain the app's own gate
// reads? Returns one sentence per disagreement, empty when the three agree.

/** A migration's statement defining the hook function, whatever else the file holds. */
const DEFINES_HOOK = /create or replace function public\.before_user_created_domain_gate\(event jsonb\)/i;

/**
 * The migration whose definition of the hook production runs: the LAST one, by its
 * NNNN version, that defines it. Found by what a file DEFINES, never by its name or
 * number: the number moves whenever another migration merges first, and #4379 replaced
 * 0159's function in a migration named for its own change, which a name based finder
 * would have read as no hook at all. Every earlier definition is named alongside, so a
 * reader can see what it replaced. None at all is a refusal, never a guess.
 */
export function findAuthHookMigration(
  files: { name: string; sql: string }[],
): { file: string; earlier: string[] } | { refusal: string } {
  const defining = files
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f.name) && DEFINES_HOOK.test(f.sql))
    .map((f) => f.name)
    .sort();
  if (defining.length === 0) {
    return { refusal: "no migration in supabase/migrations defines public.before_user_created_domain_gate(event jsonb)" };
  }
  return { file: defining[defining.length - 1]!, earlier: defining.slice(0, -1) };
}

/** The `pg-functions://postgres/<schema>/<name>` URI the config registers, or null. */
function registeredHook(config: string): { enabled: boolean; schema: string; name: string } | null {
  const block = config.match(/^\[auth\.hook\.before_user_created\]\s*\n([\s\S]*?)(?=^\s*#?\s*\[|(?![\s\S]))/m);
  if (!block) return null;
  const body = block[1]
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const enabled = /^\s*enabled\s*=\s*true\s*$/m.test(body);
  const uri = body.match(/^\s*uri\s*=\s*"pg-functions:\/\/postgres\/([a-z_]+)\/([a-z0-9_]+)"\s*$/m);
  if (!uri) return { enabled, schema: "", name: "" };
  return { enabled, schema: uri[1], name: uri[2] };
}

/** GOOGLE_HOSTED_DOMAIN from the top level vars of wrangler.jsonc (the first occurrence). */
function hostedDomain(wrangler: string): string | null {
  const m = wrangler.match(/"GOOGLE_HOSTED_DOMAIN"\s*:\s*"([^"]*)"/);
  return m ? m[1].trim().toLowerCase() : null;
}

export function checkAuthDomainHook(input: { config: string; migration: string; wrangler: string }): string[] {
  const problems: string[] = [];
  const hook = registeredHook(input.config);
  if (!hook) {
    problems.push("supabase/config.toml has no uncommented [auth.hook.before_user_created] block");
    return problems;
  }
  if (!hook.enabled) problems.push("the before_user_created hook is not enabled in supabase/config.toml");
  if (!hook.name) {
    problems.push("the before_user_created hook has no pg-functions://postgres/<schema>/<name> uri");
    return problems;
  }

  const qualified = `${hook.schema}.${hook.name}`;
  const fn = new RegExp(`create or replace function ${hook.schema}\\.${hook.name}\\(event jsonb\\)`, "i");
  if (!fn.test(input.migration)) {
    problems.push(`config.toml registers ${qualified}, and no migration defines ${qualified}(event jsonb)`);
    return problems;
  }

  const sig = `${hook.schema}\\.${hook.name}\\(jsonb\\)`;
  if (!new RegExp(`grant execute on function ${sig} to supabase_auth_admin;`, "i").test(input.migration)) {
    problems.push(`${qualified} is never granted EXECUTE to supabase_auth_admin, so the auth server cannot call it`);
  }
  if (!new RegExp(`revoke execute on function ${sig} from public, anon, authenticated;`, "i").test(input.migration)) {
    problems.push(`${qualified} needs a revoke of EXECUTE from public, anon and authenticated, or PostgREST can call it`);
  }
  // The pin and the domain are read from the hook's OWN definition, from its create to
  // the end of its body, never from the whole file: since #4379 the file defining it
  // also defines another pinned function and a CHECK naming the domain, either of which
  // would otherwise answer for a hook that had lost its own.
  const start = input.migration.search(fn);
  const bodyEnd = input.migration.indexOf("$$;", input.migration.indexOf("$$", start) + 2);
  const definition = input.migration.slice(start, bodyEnd < 0 ? undefined : bodyEnd);
  if (!/^\s*set search_path = pg_catalog\s*$/im.test(definition)) {
    problems.push(`${qualified} does not pin its search_path (#1126)`);
  }

  const domain = hostedDomain(input.wrangler);
  const literal = definition.match(/email_domain = '([^']+)'/);
  if (!domain) {
    problems.push("wrangler.jsonc sets no GOOGLE_HOSTED_DOMAIN to compare the hook against");
  } else if (!literal || literal[1].toLowerCase() !== domain) {
    problems.push(
      `the hook refuses against ${literal ? literal[1] : "no domain"}, while GOOGLE_HOSTED_DOMAIN in wrangler.jsonc is ${domain}`,
    );
  }
  return problems;
}
