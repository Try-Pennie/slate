// Scan supabase query chains for column names that no declared table type holds.
//
// The class this exists for shipped to main on 2026-09-02: the cal.com parity
// sweep filtered `buckets` on an `active` column that does not exist. PostgREST
// answers 42703, `unwrap` turns that into a throw, and the sweep could never have
// run at all. NOTHING caught it. `tsc` cannot: the column is a string argument to
// a query builder, so the type system never sees it. The unit suite cannot: no
// offline test reaches a real database. It was found by running the query by hand.
//
// A column name is the one part of a query that is checked by nothing else, and
// getting it wrong is never a partial failure, it is a query that cannot execute.
// So it is worth a static guard, and the mapping to check it against is already in
// the repo: `schema.ts` maps each table to its row interface, and `types.ts`
// declares that interface's fields.
//
// SCOPE. `scripts/` only. That is where the bug shipped, where `tsc` looks least
// (the tree is excluded from the app's program, see the typecheck guard), and
// where a wrong column takes down a command nobody runs until the day it matters.
// `src/` is deliberately out of scope for now: it carries far more query shapes
// (embedded selects, foreign-table hints, aliases) and a guard that fights those
// would be turned off rather than fixed. Widening it is a deliberate act.

export interface ColumnFinding {
  file: string;
  line: number;
  table: string;
  column: string;
  where: string;
}

/** Filters whose FIRST argument is a column name. `select` is handled separately
 *  because its argument is a list. */
const COLUMN_FIRST_ARG = [
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in",
  "contains", "containedBy", "order", "not",
];

/**
 * table name -> row interface name, read from the `Database` type.
 * Both `t: Table<Row>;` and the multi-line `t: Table<\n  Row,\n  [...]>` form.
 */
export function tableTypeMap(schemaSource: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^\s{6}([a-z_][a-z0-9_]*):\s*Table<\s*\n?\s*([A-Za-z][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaSource)) !== null) map.set(m[1], m[2]);
  return map;
}

/** interface name -> its declared field names. */
export function interfaceFields(typesSource: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /export interface ([A-Za-z][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(typesSource)) !== null) {
    const fields = new Set<string>();
    for (const fm of m[2].matchAll(/^\s{2}([a-z_][a-zA-Z0-9_]*)\??\s*:/gm)) fields.add(fm[1]);
    out.set(m[1], fields);
  }
  return out;
}

/**
 * Whether a `.select(...)` entry is a plain column this guard can judge.
 *
 * Everything else is waved through rather than guessed at: `*`, an embedded
 * resource (`bucket:buckets(id)`), a rename, a foreign-table hint, an aggregate,
 * or a JSON path. A guard that judged those would produce findings nobody can act
 * on, and the response to that is to switch the guard off (L36).
 */
function judgeableSelectEntry(entry: string): string | null {
  const t = entry.trim();
  if (!t) return null;
  if (/[*(){}:!\->]/.test(t)) return null;
  if (!/^[a-z_][a-z0-9_]*$/.test(t)) return null;
  return t;
}

/**
 * Findings for one file.
 *
 * A chain is read from `.from("table")` to the end of its statement. A builder
 * reassigned across statements (`let q = db.from(...); q = q.eq(...)`) is NOT
 * followed, and that is stated rather than silently true: those filters are
 * invisible to this guard.
 */
export function scanDbColumns(
  file: string,
  source: string,
  tables: Map<string, string>,
  fields: Map<string, Set<string>>,
): ColumnFinding[] {
  const findings: ColumnFinding[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;

  for (const m of source.matchAll(/\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g)) {
    const table = m[1];
    const typeName = tables.get(table);
    // A table this repo does not declare (a view, a table added to the database
    // and not to the types) is skipped rather than accused: the guard would
    // otherwise report every column of it as unknown.
    if (!typeName) continue;
    const known = fields.get(typeName);
    if (!known || known.size === 0) continue;

    // The chain ends at the earliest of the statement's end or the NEXT `.from(`.
    // Stopping only at `;` was wrong in a way that produced confident nonsense: an
    // array of builders (`Promise.all([db.from("a")..., db.from("b")...])`) carries
    // no semicolon until after the last one, so every table in the array inherited
    // every other's filters and one real column was reported as missing from six
    // tables at once.
    const start = m.index! + m[0].length;
    const semi = source.indexOf(";", start);
    const nextFrom = source.slice(start).search(/\.from\(\s*["'`]/);
    const ends = [
      semi === -1 ? source.length : semi,
      nextFrom === -1 ? source.length : start + nextFrom,
    ];
    const chain = source.slice(start, Math.min(...ends));

    for (const sm of chain.matchAll(/\.select\(\s*["'`]([^"'`]*)["'`]/g)) {
      for (const entry of sm[1].split(",")) {
        const col = judgeableSelectEntry(entry);
        if (col && !known.has(col)) {
          findings.push({
            file,
            line: lineOf(start + sm.index!),
            table,
            column: col,
            where: "select",
          });
        }
      }
    }
    for (const fm of chain.matchAll(/\.([a-zA-Z]+)\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g)) {
      if (!COLUMN_FIRST_ARG.includes(fm[1])) continue;
      if (!known.has(fm[2])) {
        findings.push({
          file,
          line: lineOf(start + fm.index!),
          table,
          column: fm[2],
          where: fm[1],
        });
      }
    }
  }
  return findings;
}
