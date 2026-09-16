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
// SCOPE. `scripts/` AND `src/`. It began as `scripts/` only, because that is where
// the bug shipped and where `tsc` looks least, and `src/` was left out on the
// argument that its query shapes (embedded selects, foreign-table hints, aliases)
// would fight the guard. Widening it was named there as a deliberate act, and #2369
// is what made it one: the SAME defect had shipped in `src/` FIVE times and every
// one of them was found by hand.
//
//   src/lib/handoffs/store.ts        select("id, is_test, ...")  on bookings (#2367)
//   src/lib/snowflake/erasure-trail  select("id,is_test")        on bookings (#1196)
//   src/app/api/cron/monitor/route   eq("is_test", false)        on bookings
//
// plus a stale declaration (`webhook_deliveries.payload_erased` existed in the
// database from migration 0088 and was missing from the hand written type), which is
// the same fault read from the other end. `bookings` has no `is_test` column at all:
// migration 0051 put it on `users` and `buckets`.
//
// The prediction about `src/`'s shapes was RIGHT, and measuring it is what turned it
// into a fix rather than a reason to stay out: the embedded resource shape
// (`select("id, availability_rules(weekday, start_minute)")`) produced two false
// findings, because splitting on commas leaves the group's INNER columns looking like
// bare columns of the outer table. So an embedded group is now stripped, with its
// identifier, before the list is split (L361: strip the excluded element from inside
// the container rather than judging the container by how it starts). With that, the
// whole of `src/` is clean.

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
/**
 * The source with every WHOLE LINE comment blanked, character for character, so
 * offsets and line numbers are unchanged.
 *
 * A comment that has to NAME a column in order to explain it is not a query, and the
 * scanner cannot tell the two apart: the line documenting why
 * `bookings` is no longer filtered on a column it does not have was itself reported
 * as that very defect. The same shape as the repo's style hook, which flags the line
 * banning a character as if it used it.
 *
 * Only whole line comments. A trailing comment on a line that also carries code is
 * left alone, because telling a `//` inside a string literal from one that starts a
 * comment needs a tokenizer, and blanking the wrong half of such a line would hide
 * real code from the scan. That limit is stated rather than assumed away.
 */
export function withoutWholeLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) return line;
      return " ".repeat(line.length);
    })
    .join("\n");
}

/**
 * A select list with every embedded resource group removed, identifier and all.
 *
 * `"id, availability_rules(weekday, start_minute)"` becomes `"id, "`. Splitting the
 * raw string on commas instead leaves `weekday` and ` start_minute` looking like bare
 * columns of the OUTER table, which is exactly how widening this guard to `src/`
 * first produced two findings nobody could act on. Nested groups are handled by
 * dropping balanced parentheses, so `a(b(c))` goes entirely.
 */
export function withoutEmbeddedGroups(selectList: string): string {
  let out = "";
  let i = 0;
  while (i < selectList.length) {
    const ch = selectList[i];
    if (ch !== "(") {
      out += ch;
      i++;
      continue;
    }
    // Drop the group, and the identifier (with any alias or hint) it belongs to.
    let depth = 0;
    while (i < selectList.length) {
      if (selectList[i] === "(") depth++;
      else if (selectList[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    out = out.replace(/[A-Za-z0-9_:!.\-> ]*$/, "");
  }
  return out;
}

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
  file_source: string,
  tables: Map<string, string>,
  fields: Map<string, Set<string>>,
): ColumnFinding[] {
  const findings: ColumnFinding[] = [];
  const source = withoutWholeLineComments(file_source);
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
      for (const entry of withoutEmbeddedGroups(sm[1]).split(",")) {
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
