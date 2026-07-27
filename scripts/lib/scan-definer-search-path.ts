// Static detector for the #1126 guard: a database function that PINS its
// search_path and then calls an extension-schema function UNQUALIFIED, so the
// call is unreachable and every invocation errors at runtime. See
// scripts/test-definer-search-path.ts for the why (#1125) and the fixtures that
// prove this actually catches the bad pattern.
//
// How it works. For each `create [or replace] function` in the SQL, the header
// (everything up to the `as $tag$` body opener) is parsed for a
// `set search_path = ...` clause. NO pin means the function resolves against the
// caller's path and is out of scope. With a pin, the body is scanned for calls to
// any name in EXTENSION_FUNCTIONS whose home schema is not on the effective path.
//
// The effective path is the pin plus `pg_catalog`, which Postgres always searches
// implicitly. That is exactly why the map below must NOT list a name that also
// exists as a built-in: `gen_random_uuid()` ships in pgcrypto AND in pg_catalog on
// PG 13+, and `sha256()` is built in on PG 11+, so an unqualified call to either
// resolves fine under `search_path = public` and flagging it would be a false
// positive. `gen_random_bytes()` is pgcrypto-only and IS listed.
//
// SECURITY DEFINER is not required to be flagged: the trap is the pinned path, so
// a SECURITY INVOKER function with a pin fails the same way.
//
// Like the sibling scan-capped-reads.ts / scan-src-capped-reads.ts this is a
// deliberate text scan, not a SQL parser: lightweight, dependency-free, with an
// escape hatch for the rare deployment-specific exception.

/** An unqualified call to an extension function the pinned path cannot reach. */
export interface DefinerSearchPathFinding {
  file: string;
  /** 1-indexed line of the offending call. */
  line: number;
  /** The function whose search_path is pinned. */
  functionName: string;
  /** The pinned schemas, as written (the implicit pg_catalog is not listed). */
  searchPath: string[];
  /** The extension function called without a schema qualifier. */
  calledFunction: string;
  /** The schema that function actually lives in. */
  homeSchema: string;
}

// Functions that live ONLY in a non-default schema on this Supabase project, by
// installed extension. Regenerate against prod with:
//
//   select e.extname, n.nspname as schema, p.proname
//   from pg_extension e
//   join pg_depend d on d.refobjid = e.oid and d.classid = 'pg_proc'::regclass
//   join pg_proc p on p.oid = d.objid
//   join pg_namespace n on n.oid = p.pronamespace
//   where n.nspname not in ('public', 'pg_catalog')
//   order by 1, 3;
//
// then DROP any name that also exists in pg_catalog (see the header note), and add
// the extension here when a new one is installed into a non-public schema.
const EXTENSION_FUNCTIONS: Record<string, string[]> = {
  // pgcrypto -> extensions. gen_random_uuid is deliberately absent (also built in).
  extensions: [
    "digest",
    "hmac",
    "crypt",
    "gen_salt",
    "gen_random_bytes",
    "encrypt",
    "decrypt",
    "encrypt_iv",
    "decrypt_iv",
    "pgp_sym_encrypt",
    "pgp_sym_encrypt_bytea",
    "pgp_sym_decrypt",
    "pgp_sym_decrypt_bytea",
    "pgp_pub_encrypt",
    "pgp_pub_encrypt_bytea",
    "pgp_pub_decrypt",
    "pgp_pub_decrypt_bytea",
    "pgp_key_id",
    "armor",
    "dearmor",
    // uuid-ossp -> extensions
    "uuid_generate_v1",
    "uuid_generate_v1mc",
    "uuid_generate_v3",
    "uuid_generate_v4",
    "uuid_generate_v5",
    "uuid_nil",
    "uuid_ns_dns",
    "uuid_ns_url",
    "uuid_ns_oid",
    "uuid_ns_x500",
    // pg_stat_statements -> extensions
    "pg_stat_statements",
    "pg_stat_statements_reset",
  ],
  // supabase_vault -> vault
  vault: ["create_secret", "update_secret"],
};

/** homeSchema for each guarded function name, flattened from the map above. */
const HOME_SCHEMA: Map<string, string> = new Map(
  Object.entries(EXTENSION_FUNCTIONS).flatMap(([schema, names]) =>
    names.map((n) => [n, schema] as [string, string]),
  ),
);

/** Opt-out for a call the pinned path genuinely can reach in this deployment. */
const OPT_OUT = /(?:--|\/\/)\s*search-path-ok:/i;

/**
 * Blanks out `--` line comments and `/* *\/` block comments so a mentioned-in-prose
 * call is not mistaken for a real one. Quote-aware: a `--` inside a string literal
 * is left alone. Returns one entry per input line, same length.
 */
function stripComments(lines: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    let kept = "";
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      const two = line.slice(i, i + 2);
      if (inBlock) {
        if (two === "*/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (!inString && two === "--") break;
      if (!inString && two === "/*") {
        inBlock = true;
        i++;
        continue;
      }
      if (line[i] === "'") inString = !inString;
      kept += line[i];
    }
    out.push(kept);
  }
  return out;
}

/**
 * Parses `set search_path = a, b` / `set search_path to ''` out of a function
 * header. Returns null when the header carries no pin (out of scope), else the
 * pinned schema list with quotes stripped and empty entries dropped.
 */
function parsePin(header: string): string[] | null {
  const m = /\bset\s+search_path\s*(?:=|\bto\b)\s*([^\n;]*)/i.exec(header);
  if (!m) return null;
  return m[1]
    .split(",")
    // A trailing volatility keyword (`stable`) can share the line, so keep only
    // the first token of each comma part.
    .map((part) => (part.trim().split(/\s+/)[0] ?? "").replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length > 0);
}

/** One parsed `create function` whose header pins search_path. */
interface ParsedFunction {
  functionName: string;
  searchPath: string[];
  /** 1-indexed line of the `create function` keyword. */
  defLine: number;
  /** 1-indexed line of the body's first line (just after the `$tag$` opener). */
  firstBodyLine: number;
  bodyLines: string[];
}

/**
 * Splits the SQL into its pinned-search_path function definitions. The single
 * parser behind both exports, so the guard and its own parse check can never
 * disagree about what the file contains. Functions with NO pin are dropped here.
 */
function parseFunctions(sql: string): ParsedFunction[] {
  const out: ParsedFunction[] = [];
  // Byte offset -> 1-indexed line.
  const lineOf = (offset: number): number => sql.slice(0, offset).split("\n").length;

  const createRe = /\bcreate\s+(?:or\s+replace\s+)?function\s+([\w".]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const rawName = m[1].replace(/"/g, "");
    const functionName = rawName.includes(".") ? rawName.slice(rawName.indexOf(".") + 1) : rawName;

    // Body opener: the first `as $tag$` after the header.
    const opener = /\bas\s+(\$\w*\$)/i.exec(sql.slice(m.index));
    if (!opener) continue;
    const headerEnd = m.index + opener.index;
    const bodyStart = m.index + opener.index + opener[0].length;
    const bodyEnd = sql.indexOf(opener[1], bodyStart);
    if (bodyEnd === -1) continue;
    // Don't rescan this body as the header of a later function.
    createRe.lastIndex = bodyEnd;

    const searchPath = parsePin(sql.slice(m.index, headerEnd));
    if (searchPath === null) continue; // unpinned: resolves against the caller's path

    out.push({
      functionName,
      searchPath,
      defLine: lineOf(m.index),
      firstBodyLine: lineOf(bodyStart),
      bodyLines: sql.slice(bodyStart, bodyEnd).split("\n"),
    });
  }
  return out;
}

/** A function definition the scanner parsed as carrying a pinned search_path. */
export interface PinnedFunction {
  functionName: string;
  searchPath: string[];
  /** 1-indexed line of the `create function` that defines it. */
  line: number;
}

/**
 * The pinned-search_path functions this file defines, in definition order. The
 * guard's test asserts against this so a header-parse regression (which would make
 * every scan trivially clean) fails loudly instead of reading as "no findings".
 */
export function listPinnedFunctions(sql: string): PinnedFunction[] {
  return parseFunctions(sql).map(({ functionName, searchPath, defLine }) => ({
    functionName,
    searchPath,
    line: defLine,
  }));
}

/**
 * Scans one SQL file for unqualified extension calls inside functions whose
 * search_path is pinned. `file` is used only for the finding's label.
 */
export function scanDefinerSearchPath(sql: string, file: string): DefinerSearchPathFinding[] {
  const findings: DefinerSearchPathFinding[] = [];

  for (const { functionName, searchPath, firstBodyLine, bodyLines } of parseFunctions(sql)) {
    // pg_catalog is always implicitly searched, so its built-ins stay reachable.
    const reachable = new Set([...searchPath, "pg_catalog"]);
    const scanLines = stripComments(bodyLines);

    for (let i = 0; i < scanLines.length; i++) {
      const line = scanLines[i];
      if (!line.trim()) continue;
      for (const [name, homeSchema] of HOME_SCHEMA) {
        if (reachable.has(homeSchema)) continue;
        // A call, not a mere mention: `name(`, not preceded by an identifier
        // char or a `.` (which would mean it is already schema-qualified).
        if (!new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(line)) continue;
        if (hasOptOut(bodyLines, i)) continue;
        findings.push({
          file,
          line: firstBodyLine + i,
          functionName,
          searchPath,
          calledFunction: name,
          homeSchema,
        });
      }
    }
  }
  return findings;
}

/** True when `search-path-ok:` sits on the line or in the comment block above it. */
function hasOptOut(rawLines: string[], index: number): boolean {
  if (OPT_OUT.test(rawLines[index])) return true;
  for (let i = index - 1; i >= 0; i--) {
    const t = rawLines[i].trim();
    if (t === "") continue;
    if (!t.startsWith("--") && !t.startsWith("//")) return false;
    if (OPT_OUT.test(t)) return true;
  }
  return false;
}
