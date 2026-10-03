// The pure half of scripts/test-auth-domain-hook.ts (#3082): does supabase/config.toml
// register a before_user_created hook that the migration defines, executable by the
// auth server and nobody else, refusing against the same domain the app's own gate
// reads? Returns one sentence per disagreement, empty when the three agree.

/**
 * The migration that defines the hook, found by NAME among the files in
 * supabase/migrations, never by number: the number moves whenever another migration
 * merges first. Zero or several is a refusal naming what it saw, never a guess.
 */
export function findAuthHookMigration(files: string[]): { file: string } | { refusal: string } {
  const matches = files.filter((f) => /^\d{4}_auth_domain_gate_hook\.sql$/.test(f)).sort();
  if (matches.length === 1) return { file: matches[0] };
  if (matches.length === 0) {
    return { refusal: "no migration named NNNN_auth_domain_gate_hook.sql is in supabase/migrations" };
  }
  return {
    refusal: `${matches.length} migrations are named for the auth domain gate hook (${matches.join(", ")}), so which one ships is ambiguous`,
  };
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
  if (!/^\s*set search_path = pg_catalog\s*$/im.test(input.migration)) {
    problems.push(`${qualified} does not pin its search_path (#1126)`);
  }

  const domain = hostedDomain(input.wrangler);
  const literal = input.migration.match(/email_domain = '([^']+)'/);
  if (!domain) {
    problems.push("wrangler.jsonc sets no GOOGLE_HOSTED_DOMAIN to compare the hook against");
  } else if (!literal || literal[1].toLowerCase() !== domain) {
    problems.push(
      `the hook refuses against ${literal ? literal[1] : "no domain"}, while GOOGLE_HOSTED_DOMAIN in wrangler.jsonc is ${domain}`,
    );
  }
  return problems;
}
