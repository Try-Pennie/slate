/**
 * Reads of `supabase_migrations` over the REST API, which can never work (#2261).
 *
 * PostgREST exposes the `public` schema ONLY, so
 * `supabase_migrations.schema_migrations` is unreachable from the API on every
 * Supabase project: a direct read answers **406**, whatever the key. Migration
 * 0072 records this in its own header and ships `applied_migration_versions()`
 * as the read path, a SECURITY DEFINER function in `public` granted to the
 * secret key server client alone. The app's drift monitor uses it.
 *
 * The load test seed did not, and nothing noticed for as long as nobody ran it:
 * the seed shipped on 2026-09-11 and the first real execution, on a real branch,
 * died on its own migration check before writing a row. A refusal that cannot
 * succeed is indistinguishable from a branch with a bad schema, which is the one
 * thing that check exists to tell apart.
 *
 * So this is a guard on the CLASS rather than a fix to the one site (L30). It
 * scans for the schema name reaching a REST path or an `accept-profile` header,
 * and names the RPC in its message, because the reader of a red run here is
 * somebody who has just written the read that looks obviously correct.
 */
import { hasOptOut } from "./opt-out.ts";

export interface MigrationSchemaRead {
  file: string;
  line: number;
  text: string;
}

/** The RPC every caller should use instead. */
export const MIGRATIONS_RPC = "applied_migration_versions";

/**
 * Lines that reach `supabase_migrations` through the REST API.
 *
 * A mention in a COMMENT is not a read, and this file and its test both have to
 * name the schema to talk about it at all (the same problem the dash lint has),
 * so a line whose code part does not carry the schema is not flagged.
 */
export function migrationSchemaReads(files: { name: string; source: string }[]): MigrationSchemaRead[] {
  const out: MigrationSchemaRead[] = [];
  for (const f of files) {
    const lines = f.source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Strip a trailing line comment before judging, so the prose beside a read
      // cannot both trigger and excuse it.
      const code = line.replace(/\/\/.*$/, "");
      if (!code.includes("supabase_migrations")) continue;
      // A REST read is the schema inside a request path or an accept-profile
      // header. A SQL string handed to a migration or to the MCP tool is neither
      // and is perfectly able to reach the schema.
      const restShaped =
        /accept-profile/i.test(code) || /\$\{BASE\}|\/rest\/v1|fetch\(/.test(code) || code.includes("?select=");
      if (!restShaped) continue;
      if (hasOptOut(lines, i, "migrations-read-ok:")) continue;
      out.push({ file: f.name, line: i + 1, text: line.trim() });
    }
  }
  return out;
}
