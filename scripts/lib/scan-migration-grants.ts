// Static scan of supabase/migrations for the table level GRANTs a replay needs
// (#2271). Driven by scripts/test-migration-grants.ts.
//
// WHAT THIS ANSWERS. For every table the migrations create and do not later
// drop: is there anything in the directory that would give anon, authenticated
// and service_role SELECT on it when these files are replayed into an EMPTY
// database? Three things can supply that, and which one applies depends on
// ORDER, which is the whole reason this is not a grep:
//
//   - a blanket `grant ... on all tables in schema public` in a migration at or
//     AFTER the one that creates the table. `on all tables` reaches only the
//     tables that exist at the moment it runs, so an earlier one does nothing
//     for a later table.
//   - an `alter default privileges ... grant ... on tables` in a migration
//     STRICTLY BEFORE the one that creates the table. Default privileges apply
//     at creation time, so one set afterwards never reaches it.
//   - an explicit `grant ... on <table>` at or after the create.
//
// It also refuses a blanket `grant ... on all functions in schema public` whose
// grantees include anon or authenticated. Seventeen statements across
// migrations 0024 to 0108 deliberately revoke EXECUTE from those roles on
// SECURITY DEFINER functions that bypass RLS, and one blanket grant running
// after them undoes every one. The hand fix that unblocked the #2261 branch
// contained exactly that statement, so it is the likeliest thing for somebody
// to paste in later.
//
// WHAT THIS DOES NOT ANSWER, stated here rather than left to be assumed:
//
//   - It is a TEXT SCAN, not an executor. It cannot know what privileges a
//     database actually holds, cannot see a grant made by hand or by Supabase's
//     own default privileges, and is not evidence that a replay works. Only a
//     replay into an empty database is that.
//   - It cannot tell whether the role named in `alter default privileges for
//     role <x>` is the role that will really create the later tables. That is a
//     property of whoever runs the migration, and nothing in this repo records
//     it. 0121 covers both candidates for that reason.
//   - It says nothing about RLS (scripts/test-migrations.ts owns that), about
//     policies, or about whether a grant is too WIDE. A narrowing of the
//     privilege model would have to bring its own guard.
//   - It does not judge grants on individual functions, only blanket ones: a
//     deliberate per function grant can be legitimate and this has no way to
//     tell one from a mistake.
//   - A table created by dynamic SQL whose name is computed is invisible to it,
//     as it is to every other migration scan here.

import { parseCreatedTables, parseDroppedTables } from "./parse-migration-constraints.ts";

/** One migration file, in apply order by `version`. */
export interface MigrationSource {
  version: string;
  sql: string;
}

/** A live table nothing in the directory grants on, and which roles are short. */
export interface UngrantedTable {
  table: string;
  createdIn: string;
  missing: string[];
}

/** A blanket function grant that would undo the deliberate revokes. */
export interface ForbiddenFunctionGrant {
  version: string;
  grantees: string[];
}

export interface GrantScan {
  ungranted: UngrantedTable[];
  forbiddenFunctionGrants: ForbiddenFunctionGrant[];
  /** How many live tables were judged. Zero means the scan read nothing. */
  tablesChecked: number;
}

/** The roles PostgREST serves Slate through, and which production holds. */
export const REQUIRED_ROLES = ["anon", "authenticated", "service_role"] as const;

/**
 * Normalize one migration for matching: drop comments, lowercase, collapse
 * whitespace, and stitch SQL string concatenation back together so a statement
 * assembled as `'a ' || 'b'` inside a DO block reads as one statement. Comments
 * go FIRST and for a load bearing reason: without it a `-- grant ... on all
 * tables ...` line in a header would satisfy this guard while granting nothing,
 * which is the failure this file exists to make impossible.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/'\s*\|\|\s*'/g, "");
}

const DEFAULT_PRIV_RE =
  /alter default privileges\b[^;]*?\bin schema public\s+grant\s+([a-z, ]+?)\s+on\s+(tables|sequences|functions|routines)\s+to\s+([a-z_, ]+)/g;
const BLANKET_RE =
  /grant\s+([a-z, ]+?)\s+on\s+all\s+(tables|sequences|functions|routines)\s+in\s+schema\s+public\s+to\s+([a-z_, ]+)/g;
const EXPLICIT_RE =
  /grant\s+([a-z, ]+?)\s+on\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+to\s+([a-z_, ]+)/g;

function names(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does this privilege list carry the SELECT a REST read needs? */
function grantsSelect(privileges: string): boolean {
  const p = names(privileges);
  return p.includes("all") || p.includes("select");
}

/** Roles a grantee list reaches. `public` reaches every role there is. */
function grantees(list: string): string[] {
  const g = names(list);
  return g.includes("public") ? [...REQUIRED_ROLES] : g;
}

export interface ParsedGrants {
  /** roles reached by `on all tables in schema public` in this file */
  blanketTables: Set<string>;
  /** roles reached by `alter default privileges ... on tables` in this file */
  defaultTables: Set<string>;
  /** table -> roles reached by an explicit grant in this file */
  explicitTables: Map<string, Set<string>>;
  /** blanket function/routine grants, with their grantees */
  blanketFunctions: string[][];
}

/**
 * Pull the grants out of ONE migration. Statements are consumed in order of
 * specificity (default privileges, then blanket, then explicit) and removed
 * from the text as they are read, so `grant execute on functions to ...` inside
 * a default privileges statement can never be mistaken for a grant on a table
 * called "functions".
 */
export function parseGrants(sql: string): ParsedGrants {
  let text = normalizeSql(sql);
  const out: ParsedGrants = {
    blanketTables: new Set(),
    defaultTables: new Set(),
    explicitTables: new Map(),
    blanketFunctions: [],
  };

  for (const m of text.matchAll(DEFAULT_PRIV_RE)) {
    const [, privileges, target, to] = m;
    if (target === "tables" && grantsSelect(privileges!)) {
      for (const r of grantees(to!)) out.defaultTables.add(r);
    }
  }
  text = text.replace(DEFAULT_PRIV_RE, " ");

  for (const m of text.matchAll(BLANKET_RE)) {
    const [, privileges, target, to] = m;
    if (target === "tables") {
      if (grantsSelect(privileges!)) for (const r of grantees(to!)) out.blanketTables.add(r);
    } else if (target === "functions" || target === "routines") {
      out.blanketFunctions.push(grantees(to!));
    }
  }
  text = text.replace(BLANKET_RE, " ");

  for (const m of text.matchAll(EXPLICIT_RE)) {
    const [, privileges, table, to] = m;
    if (!grantsSelect(privileges!)) continue;
    const set = out.explicitTables.get(table!) ?? new Set<string>();
    for (const r of grantees(to!)) set.add(r);
    out.explicitTables.set(table!, set);
  }

  return out;
}

/**
 * Judge a whole migration directory. `files` must be in apply order; the scan
 * uses each file's position, not its name, to decide what ran before what.
 */
export function scanMigrationGrants(files: MigrationSource[]): GrantScan {
  const parsed = files.map((f) => ({ ...f, grants: parseGrants(f.sql) }));

  // Which file last created each table, and whether a later one dropped it.
  const createdAt = new Map<string, number>();
  const droppedAt = new Map<string, number>();
  files.forEach((f, i) => {
    const text = normalizeSql(f.sql);
    for (const t of parseCreatedTables(text)) createdAt.set(t, i);
    for (const t of parseDroppedTables(text)) droppedAt.set(t, i);
  });

  const ungranted: UngrantedTable[] = [];
  let tablesChecked = 0;

  for (const [table, createIndex] of [...createdAt].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dropIndex = droppedAt.get(table);
    if (dropIndex !== undefined && dropIndex > createIndex) continue; // gone by the end
    tablesChecked++;

    const covered = new Set<string>();
    parsed.forEach((f, i) => {
      if (i >= createIndex) {
        for (const r of f.grants.blanketTables) covered.add(r);
        for (const r of f.grants.explicitTables.get(table) ?? []) covered.add(r);
      }
      if (i < createIndex) {
        for (const r of f.grants.defaultTables) covered.add(r);
      }
    });

    const missing = REQUIRED_ROLES.filter((r) => !covered.has(r));
    if (missing.length > 0) {
      ungranted.push({ table, createdIn: files[createIndex]!.version, missing: [...missing] });
    }
  }

  const forbiddenFunctionGrants: ForbiddenFunctionGrant[] = [];
  for (const f of parsed) {
    for (const g of f.grants.blanketFunctions) {
      const bad = g.filter((r) => r === "anon" || r === "authenticated");
      if (bad.length > 0) forbiddenFunctionGrants.push({ version: f.version, grantees: g });
    }
  }

  return { ungranted, forbiddenFunctionGrants, tablesChecked };
}
