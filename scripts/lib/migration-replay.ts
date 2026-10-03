// The decisions behind `pnpm verify:migration-replay-sql` (#3099), kept pure so
// scripts/test-migration-replay.ts can pin them with no database.
//
// The replay applies every migration to an EMPTY Supabase Postgres in Docker, the
// way `supabase db push` applies them to production, and then asks the database
// who can read and write what. Until this existed the 157 files had been replayed
// from empty once, on a preview branch on 2026-09-02, so a migration leaning on
// state production already holds could merge unnoticed.
//
// Imports nothing: the workflow runs this on bare node with no install.

export interface MigrationFile {
  file: string;
  /** The four digit prefix, which is what `db push` records as the version. */
  version: string;
  /** What follows the prefix, without `.sql`. */
  name: string;
}

export type MigrationPlan = { ok: true; files: MigrationFile[] } | { ok: false; error: string };

const MIGRATION_NAME = /^(\d{4})_(.+)\.sql$/;

/**
 * Every `NNNN_name.sql` in the directory, in version order. A `.sql` file of any
 * other shape is REFUSED rather than skipped, because a skipped migration is the
 * defect this exists to catch; non-SQL files (the applied content lock) are left out.
 */
export function migrationPlan(names: readonly string[]): MigrationPlan {
  const files: MigrationFile[] = [];
  const bad: string[] = [];
  for (const file of names) {
    if (!file.endsWith(".sql")) continue;
    const m = file.match(MIGRATION_NAME);
    if (!m) bad.push(file);
    else files.push({ file, version: m[1] as string, name: m[2] as string });
  }
  if (bad.length > 0) return { ok: false, error: `not named NNNN_name.sql, so not replayable in a known order: ${bad.join(", ")}` };
  if (files.length === 0) return { ok: false, error: "no migrations found, so there is nothing to replay" };
  files.sort((a, b) => a.version.localeCompare(b.version));
  const dupes = files.filter((f, i) => i > 0 && files[i - 1]?.version === f.version).map((f) => f.version);
  if (dupes.length > 0) return { ok: false, error: `more than one migration shares a version: ${[...new Set(dupes)].join(", ")}` };
  return { ok: true, files };
}

/** The history table as the Supabase CLI creates it before its first push. */
export const CLI_HISTORY_TABLE_SQL = `
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text not null primary key,
    statements text[],
    name text
  );
`;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * One migration as the batch the replay sends: the file verbatim, then the history
 * row `db push` writes for it. The row goes on its own line after a newline, so a
 * file ending in a `--` comment cannot swallow it. The caller runs the batch in a
 * single transaction, as `db push` does per file.
 */
export function migrationBatch(m: MigrationFile, text: string): string {
  return `${text}\n;\ninsert into supabase_migrations.schema_migrations (version, name) values (${lit(m.version)}, ${lit(m.name)});\n`;
}

export interface DefaultAclRow {
  owner: string;
  schema: string;
  /** `r` tables, `f` functions, `S` sequences. */
  type: string;
  acl: string;
}

/** The roles the platform grants on every new table, and the privileges it grants them. */
const PLATFORM_TABLE_GRANTEES = ["anon", "authenticated", "service_role"] as const;

/**
 * The precondition (L714): the platform's DEFAULT table grants to the API roles must
 * be present for tables `postgres` creates in `public`, or every refusal measured
 * afterwards is a missing GRANT rather than RLS doing its job, and the checks pass on
 * the very mistake they exist to catch. Returns what is missing; empty means present.
 * INSERT and SELECT are both required, since the checks drive both.
 */
export function judgeDefaultGrants(rows: readonly DefaultAclRow[]): string[] {
  const tables = rows.find((r) => r.owner === "postgres" && r.schema === "public" && r.type === "r");
  const entries = (tables?.acl ?? "").replace(/^\{|\}$/g, "").split(",");
  const missing: string[] = [];
  for (const role of PLATFORM_TABLE_GRANTEES) {
    const privs = entries.find((e) => e.startsWith(`${role}=`))?.split("=")[1]?.split("/")[0] ?? "";
    if (!privs.includes("a") || !privs.includes("r")) {
      missing.push(`${role} holds no default INSERT and SELECT on new public tables, so this image does not reproduce the platform's default grants`);
    }
  }
  return missing;
}

export type WriteOutcome = "refused-by-rls" | "refused-by-grant" | "got-past-rls" | "written";

/**
 * What an INSERT as a browser role did. Postgres runs the RLS check BEFORE the
 * constraints, so a constraint error means the row got past RLS: that is a finding,
 * not a refusal. Anything not recognisably a refusal is read the same way, so an
 * error this does not know can never pass for one (L11).
 */
export function classifyWriteOutcome(error: string | null): WriteOutcome {
  if (error === null) return "written";
  if (/new row violates row-level security policy/.test(error)) return "refused-by-rls";
  if (/permission denied for (table|relation|schema)/.test(error)) return "refused-by-grant";
  return "got-past-rls";
}

export interface PolicyRow {
  table: string;
  policy: string;
  cmd: string;
  /** pg_policies.roles as text, for example `{public}` or `{anon,authenticated}`. */
  roles: string;
}

/**
 * The policies a browser role (anon or authenticated, or PUBLIC, which both belong
 * to) is allowed to have, each with the reason. Everything else in Slate is read by
 * the server through the secret key, which bypasses RLS, so any other policy a
 * browser role can use is a new way into the data and must be a decision made here.
 */
export const BROWSER_POLICY_ALLOWLIST: readonly { table: string; policy: string; cmd: string; reason: string }[] = [
  {
    table: "users",
    policy: "self can read own user row",
    cmd: "SELECT",
    reason: "A signed in user reads their own row through Supabase Auth (0001_init.sql); the replay drives it both ways.",
  },
];

const BROWSER_ROLES = /(^|[{,])(public|anon|authenticated)([,}]|$)/;

export function judgeBrowserPolicies(rows: readonly PolicyRow[]): { unexpected: string[]; missing: string[] } {
  const browser = rows.filter((r) => BROWSER_ROLES.test(r.roles));
  const allowed = (r: PolicyRow) =>
    BROWSER_POLICY_ALLOWLIST.some((a) => a.table === r.table && a.policy === r.policy && a.cmd === r.cmd);
  const unexpected = browser.filter((r) => !allowed(r)).map((r) => `${r.table}: ${r.policy} (${r.cmd} for ${r.roles})`);
  const missing = BROWSER_POLICY_ALLOWLIST.filter(
    (a) => !browser.some((r) => r.table === a.table && r.policy === a.policy && r.cmd === a.cmd),
  ).map((a) => `${a.table}: ${a.policy}`);
  return { unexpected, missing };
}

/**
 * The public tables whose browser grant a migration deliberately takes back, each
 * with its reason. Every OTHER table must still hold the platform's default INSERT
 * for anon and authenticated, so a refused insert there is RLS refusing it; on these
 * the refusal is the revoke, and RLS is not what is being measured.
 */
export const BROWSER_GRANT_EXEMPT: readonly { table: string; reason: string }[] = [
  {
    table: "advisor_photos",
    reason: "0156 revokes all from anon and authenticated, because default privileges would otherwise grant the image table to the browser roles (L124).",
  },
];

/**
 * The tables that lack the browser INSERT grant must be EXACTLY the exempt list,
 * in both directions: a table losing its grant without a recorded reason hides its
 * RLS behind a missing grant, and an exemption whose revoke is gone is stale.
 */
export function judgeGrantExemptions(ungranted: readonly string[]): { unexplained: string[]; stale: string[] } {
  const exempt = new Set(BROWSER_GRANT_EXEMPT.map((e) => e.table));
  return {
    unexplained: ungranted.filter((t) => !exempt.has(t)),
    stale: [...exempt].filter((t) => !ungranted.includes(t)),
  };
}

/**
 * Whether one browser insert was refused for the right reason. On a table holding
 * the grant only RLS counts: a "permission denied" there would mean the grant went
 * missing, which is not RLS working. On an exempt table the revoke is the refusal.
 */
export function browserWriteRefused(table: string, outcome: WriteOutcome): boolean {
  const exempt = BROWSER_GRANT_EXEMPT.some((e) => e.table === table);
  return exempt ? outcome === "refused-by-grant" || outcome === "refused-by-rls" : outcome === "refused-by-rls";
}

/**
 * Which of `names` the source never CALLS. Import declarations are blanked first, so
 * a name that is imported and no longer used reads as missing. A name followed by
 * `(` is a call; a constant counts when it is passed as an argument, `fn(NAME)`.
 */
export function missingCalls(src: string, names: readonly string[]): string[] {
  const body = src.replace(/^import\b[\s\S]*?from\s*["'][^"']+["'];?/gm, "");
  return names.filter((n) => !new RegExp(`\\b${n}\\s*\\(|\\(\\s*${n}\\s*[,)]`).test(body));
}
