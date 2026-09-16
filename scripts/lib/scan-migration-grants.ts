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
//     tell one from a mistake. `scanDefinerExecuteGrants` below judges the one
//     case where there is no such ambiguity, a SECURITY DEFINER function, and
//     asks the opposite question: whether the file takes EXECUTE back.
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

// =========================================================================
// A SECURITY DEFINER function must take EXECUTE back (#2391)
// =========================================================================
//
// WHAT THIS ANSWERS. For every `create [or replace] function ... security
// definer` in ONE migration: does that same file revoke EXECUTE on it from
// `public`, `anon` AND `authenticated`?
//
// WHY ALL THREE, which is the part a naive check gets wrong. A SECURITY DEFINER
// function runs with its OWNER's rights, so it bypasses the RLS every other
// client read is held to, and TWO separate grants hand it to a client side role:
//
//   - Postgres gives EXECUTE to PUBLIC on every function it creates, and anon
//     inherits whatever PUBLIC holds.
//   - migration 0121's `alter default privileges ... grant execute on functions
//     to anon, authenticated, service_role` gives each of those roles a DIRECT
//     grant at creation time, which is deliberate (see that file's header) and
//     rests on each new function's own revoke running afterwards.
//
// `REVOKE ... FROM PUBLIC` does not remove a grant made directly to a role
// (L541), so the PUBLIC only revoke that READS like the fix leaves anon and
// authenticated holding EXECUTE, and anon reaches `/rest/v1/rpc/<function>` with
// the publishable key that ships in the client bundle. Naming all three is the
// form every one of the seventeen existing sites already uses, and it is the
// only form that actually closes it. Roles may be named across SEVERAL revoke
// statements: what is required is that their union covers the three.
//
// `revoke all` counts, because ALL carries EXECUTE with it (0092 writes it that
// way). A privilege list naming neither reads as no revoke at all.
//
// WHAT THIS DOES NOT ANSWER:
//
//   - It matches a revoke to a definition by function NAME, never by resolving
//     the argument types. A revoke names types (`timestamptz`) and a create
//     names parameters with names, modes and defaults (`p_until timestamp with
//     time zone default null`), and the two spell the same type differently, so
//     a resolver here would fail correct migrations. The one thing the name
//     cannot see, a file defining two overloads of one name, is covered by
//     COUNTING instead: N definitions of a name need N revoke statements naming
//     it, and the surplus definitions are reported.
//   - It requires the revoke in the SAME file, which is the established pattern
//     and what makes a migration reviewable on its own. A revoke arriving in a
//     later migration leaves the function callable in between.
//   - It says nothing about a SECURITY INVOKER function, which runs as the
//     caller and is held to RLS like any other read.
//   - A blanket `revoke execute on all functions in schema public` is not read
//     as covering anything: nothing in the corpus writes one, and judging it
//     would mean reasoning about apply order across the whole directory.
//   - Like every scan here it is a TEXT SCAN. It cannot read a database, and a
//     grant or revoke made by hand is invisible to it.

/** The roles a SECURITY DEFINER function's own migration must revoke EXECUTE from. */
export const EXECUTE_REVOKE_ROLES = ["public", "anon", "authenticated"] as const;

/** Why one definition was reported. Each is a different repair. */
export type DefinerGrantReason = "no-revoke" | "roles-short" | "overload-unrevoked";

/** A SECURITY DEFINER function its own migration leaves callable. */
export interface DefinerGrantFinding {
  file: string;
  /** 1-indexed line of the `create function` that defines it. */
  line: number;
  functionName: string;
  reason: DefinerGrantReason;
  /**
   * Roles still holding EXECUTE. Empty for `overload-unrevoked`, where the NAME
   * is fully revoked and a second definition of it is not.
   */
  missing: string[];
}

export interface DefinerGrantScan {
  findings: DefinerGrantFinding[];
  /** SECURITY DEFINER definitions examined. Zero means the scan read nothing. */
  definersChecked: number;
}

/** Opt-out for a definer function that genuinely must stay callable by a client role. */
const EXECUTE_OPT_OUT = /(?:--|\/\/)\s*anon-execute-ok:\s*[A-Za-z]/;
/** The hatch WRITTEN, with or without the reason it is required to carry. */
const EXECUTE_OPT_OUT_BARE = /(?:--|\/\/)\s*anon-execute-ok:/;

/** Blank out `$tag$ ... $tag$` bodies so nothing inside one is read as a statement. */
function stripDollarBodies(sql: string): string {
  return sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ");
}

/** One `create ... function` that carries SECURITY DEFINER. */
interface DefinerDefinition {
  name: string;
  /** 1-indexed line of the `create` keyword. */
  line: number;
}

/**
 * The SECURITY DEFINER definitions in one file, in definition order. The body is
 * skipped by its `$tag$` delimiters so a nested `create function` inside one is
 * not read as a header; a definition with no dollar-quoted body falls back to
 * the next `;`, so it is judged rather than silently dropped.
 */
function parseDefinerDefinitions(sql: string): DefinerDefinition[] {
  const out: DefinerDefinition[] = [];
  const lineOf = (offset: number): number => sql.slice(0, offset).split("\n").length;

  const createRe = /\bcreate\s+(?:or\s+replace\s+)?function\s+([\w".]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const rawName = m[1].replace(/"/g, "");
    const name = (
      rawName.includes(".") ? rawName.slice(rawName.indexOf(".") + 1) : rawName
    ).toLowerCase();

    const opener = /\bas\s+(\$\w*\$)/i.exec(sql.slice(m.index));
    let headerEnd: number;
    if (opener) {
      headerEnd = m.index + opener.index;
      const bodyStart = m.index + opener.index + opener[0].length;
      const bodyEnd = sql.indexOf(opener[1], bodyStart);
      createRe.lastIndex = bodyEnd === -1 ? sql.length : bodyEnd;
    } else {
      const semi = sql.indexOf(";", m.index);
      headerEnd = semi === -1 ? sql.length : semi;
      createRe.lastIndex = headerEnd;
    }

    if (!/\bsecurity\s+definer\b/i.test(sql.slice(m.index, headerEnd))) continue;
    out.push({ name, line: lineOf(m.index) });
  }
  return out;
}

const REVOKE_RE =
  /revoke\s+([a-z, ]+?)\s+on\s+(?:function|routine)\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s*from\s+([a-z_, ]+)/g;

/** Does this privilege list carry the EXECUTE a client side RPC call needs? */
function revokesExecute(privileges: string): boolean {
  const p = names(privileges);
  return p.includes("all") || p.includes("execute");
}

/** Every EXECUTE-bearing revoke in one file, grouped by the function it names. */
function parseFunctionRevokes(sql: string): Map<string, Set<string>[]> {
  const out = new Map<string, Set<string>[]>();
  const text = normalizeSql(stripDollarBodies(sql));
  for (const m of text.matchAll(REVOKE_RE)) {
    const [, privileges, fn, from] = m;
    if (!revokesExecute(privileges!)) continue;
    const list = out.get(fn!) ?? [];
    list.push(new Set(names(from!)));
    out.set(fn!, list);
  }
  return out;
}

/** True when `anon-execute-ok:` with a reason sits on the line or in the block above it. */
function hasExecuteOptOut(lines: string[], index: number): boolean {
  const here = lines[index] ?? "";
  if (EXECUTE_OPT_OUT.test(here)) return true;
  if (EXECUTE_OPT_OUT_BARE.test(here)) return false; // written, carrying no reason
  for (let i = index - 1; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (t === "") continue;
    if (!t.startsWith("--") && !t.startsWith("//")) return false;
    if (EXECUTE_OPT_OUT.test(t)) return true;
    if (EXECUTE_OPT_OUT_BARE.test(t)) return false;
  }
  return false;
}

/**
 * Scans ONE migration for SECURITY DEFINER functions it leaves callable by a
 * client side role. `file` is used only for the finding's label.
 */
export function scanDefinerExecuteGrants(sql: string, file: string): DefinerGrantScan {
  const lines = sql.split("\n");
  const definitions = parseDefinerDefinitions(sql);
  const revokes = parseFunctionRevokes(sql);
  const findings: DefinerGrantFinding[] = [];

  // How many definitions of this name have been seen, so a second overload can
  // be told from the first.
  const seen = new Map<string, number>();

  for (const def of definitions) {
    const ordinal = seen.get(def.name) ?? 0;
    seen.set(def.name, ordinal + 1);
    if (hasExecuteOptOut(lines, def.line - 1)) continue;

    const statements = revokes.get(def.name) ?? [];
    const covered = new Set<string>();
    for (const s of statements) for (const r of s) covered.add(r);
    const missing = EXECUTE_REVOKE_ROLES.filter((r) => !covered.has(r));

    if (missing.length > 0) {
      findings.push({
        file,
        line: def.line,
        functionName: def.name,
        reason: covered.size === 0 ? "no-revoke" : "roles-short",
        missing: [...missing],
      });
      continue;
    }

    // Fully revoked by name. One revoke statement names one signature, so an
    // Nth definition of the name needs an Nth statement.
    if (ordinal >= statements.length) {
      findings.push({
        file,
        line: def.line,
        functionName: def.name,
        reason: "overload-unrevoked",
        missing: [],
      });
    }
  }

  return { findings, definersChecked: definitions.length };
}
