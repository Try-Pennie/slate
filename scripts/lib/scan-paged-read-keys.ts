// The scan behind scripts/test-paged-read-keys.ts (#3273).
//
// `selectAllPages` orders every paged read by the key its caller names and cuts
// pages with OFFSET. That partitions the result only when the key is UNIQUE: page
// on a column two rows share and Postgres may return those two in either order on
// each request, repeating one and skipping the other, which is the very defect the
// key exists to close. Nothing at the call site can tell a unique key from a
// plausible one, so this reads the schema the migrations declare and requires
// every caller's key to cover one of the table's unique column sets.
//
// What counts as unique, deliberately narrow so a green run means something:
//   - a column declared `primary key`, or a table `primary key (a, b)`, which are
//     NOT NULL by definition;
//   - a `unique` column or a table `unique (a, b)` constraint, from `create table`
//     or `alter table ... add`, and a `create unique index ... on t (a, b)` with NO
//     `where` (a partial index says nothing about the rows it leaves out) over plain
//     columns, ONLY when every column in it is NOT NULL, or the constraint says
//     `nulls not distinct`. Postgres treats NULLs as distinct in a unique
//     constraint, so a nullable column holds any number of NULL rows, and those
//     can swap between page requests like any other tie.
// Nullability is followed through `not null` on the column, a serial type or an
// identity column (NOT NULL implicitly), `alter column ... set not null` and `drop
// not null`, and a column added by `alter table ... add [column]` is read like one
// in `create table`. An index column's modifiers (`asc`, `desc`,
// `collate`, `nulls first|last`, an operator class) are not part of its name. The
// word `unique` inside a string or a parenthesised expression (a default, a check)
// is not a constraint. A constraint later dropped is not tracked; every key in use
// today is a primary key, which no migration drops.

import { pagedCallSpans } from "./scan-paged-calls.ts";

export type UniqueSets = Map<string, string[][]>;

interface Declared {
  cols: string[];
  /** A primary key, or `nulls not distinct`: unique whatever the columns' nullability. */
  unconditional: boolean;
}

interface TableFacts {
  notNull: Map<string, boolean>;
  declared: Declared[];
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const tableName = (raw: string) => raw.replace(/^public\./, "").replace(/"/g, "").toLowerCase();
const ident = (raw: string) => raw.replace(/"/g, "").toLowerCase();

/** A column list `(a, b)` as names, or null when any item is not a plain column. */
function columnList(list: string): string[] | null {
  const out: string[] = [];
  for (const item of topLevelItems(list)) {
    const t = item.trim();
    if (t === "" || t.includes("(")) return null; // an expression, not a column
    // The first token is the column; what follows (asc, desc, collate "C",
    // nulls first|last, an operator class) qualifies it and is not part of it.
    const m = /^("[^"]+"|[\w$]+)/.exec(t);
    if (!m) return null;
    out.push(ident(m[1]));
  }
  return out.length > 0 ? out : null;
}

/** Split on the commas at the top level of parentheses and string literals. */
function topLevelItems(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of body) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0 && !quote) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The text with string literals and parenthesised groups blanked, so a word
 *  inside a default, a check or a type modifier cannot read as a constraint. */
function bareWords(text: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
      out += " ";
      continue;
    }
    if (c === "'") {
      quote = c;
      out += " ";
      continue;
    }
    if (c === "(") depth++;
    if (depth > 0) out += " ";
    else out += c;
    if (c === ")") depth--;
  }
  return out;
}

function factsFor(all: Map<string, TableFacts>, raw: string): TableFacts {
  const t = tableName(raw);
  let f = all.get(t);
  if (!f) {
    f = { notNull: new Map(), declared: [] };
    all.set(t, f);
  }
  return f;
}

/** A table level constraint (`[constraint x] primary key|unique [nulls not distinct] (...)`), or null. */
function tableConstraint(item: string): Declared | null {
  const m =
    /^(?:constraint\s+[\w"]+\s+)?(primary\s+key|unique(?:\s+nulls\s+(not\s+)?distinct)?)\s*\(([^)]*)\)/i.exec(
      item.trim(),
    );
  if (!m) return null;
  const list = columnList(m[3]);
  if (!list) return null;
  const pk = /^primary/i.test(m[1]);
  return { cols: list, unconditional: pk || Boolean(m[2]) };
}

/** A column definition: its name, whether it is NOT NULL, and any unique it declares. */
function columnDef(f: TableFacts, item: string): void {
  const t = item.trim();
  const m = /^("[^"]+"|[\w$]+)/.exec(t);
  if (!m) return;
  const name = ident(m[1]);
  if (/^(constraint|check|foreign|exclude|like)$/i.test(name)) return;
  const words = bareWords(t.slice(m[0].length));
  const pk = /\bprimary\s+key\b/i.test(words);
  // serial types and identity columns are NOT NULL without saying so.
  const implicitNotNull =
    /\b(?:small|big)?serial[248]?\b/i.test(words) || /\bgenerated\s+(?:always|by\s+default)\s+as\s+identity\b/i.test(words);
  if (pk || implicitNotNull || /\bnot\s+null\b/i.test(words)) f.notNull.set(name, true);
  else if (!f.notNull.has(name)) f.notNull.set(name, false);
  if (pk) f.declared.push({ cols: [name], unconditional: true });
  else if (/\bunique\b/i.test(words)) {
    f.declared.push({ cols: [name], unconditional: /\bunique\s+nulls\s+not\s+distinct\b/i.test(words) });
  }
}

/** Every unique column set the migrations declare, by table, that is proven unique. */
export function uniqueSetsFromMigrations(sources: string[]): UniqueSets {
  const all = new Map<string, TableFacts>();
  for (const raw of sources) {
    const sql = stripSqlComments(raw);
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi;
    for (const m of sql.matchAll(createRe)) {
      const f = factsFor(all, m[1]);
      let depth = 1;
      let i = (m.index as number) + m[0].length;
      const start = i;
      for (; i < sql.length && depth > 0; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") depth--;
      }
      for (const item of topLevelItems(sql.slice(start, i - 1))) {
        const c = tableConstraint(item);
        if (c) {
          f.declared.push(c);
          if (c.unconditional && /^\s*(?:constraint\s+[\w"]+\s+)?primary/i.test(item)) {
            for (const col of c.cols) f.notNull.set(col, true);
          }
        } else columnDef(f, item);
      }
    }
    const alterRe = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w."]+)\s+([^;]*);/gi;
    for (const m of sql.matchAll(alterRe)) {
      const f = factsFor(all, m[1]);
      for (const action of topLevelItems(m[2])) {
        const a = action.trim();
        const addCol = /^add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]*)$/i.exec(a);
        if (addCol) {
          columnDef(f, addCol[1]);
          continue;
        }
        const addCon = /^add\s+([\s\S]*)$/i.exec(a);
        if (addCon) {
          const c = tableConstraint(addCon[1]);
          if (c) {
            f.declared.push(c);
            if (/^\s*(?:constraint\s+[\w"]+\s+)?primary/i.test(addCon[1])) {
              for (const col of c.cols) f.notNull.set(col, true);
            }
          } else if (!/^\s*(?:constraint|primary|unique|check|foreign|exclude)\b/i.test(addCon[1])) {
            // ADD without the COLUMN keyword is a column add too.
            columnDef(f, addCon[1]);
          }
          continue;
        }
        const setNn = /^alter\s+(?:column\s+)?("[^"]+"|[\w$]+)\s+(set|drop)\s+not\s+null\b/i.exec(a);
        if (setNn) f.notNull.set(ident(setNn[1]), setNn[2].toLowerCase() === "set");
      }
    }
    const indexRe =
      /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[\w"]+\s+on\s+(?:only\s+)?([\w."]+)\s*(?:using\s+\w+\s*)?\(([^;]*)\)\s*([^;]*);/gi;
    for (const m of sql.matchAll(indexRe)) {
      // The column list is everything up to the parenthesis that closes it; an
      // expression item makes the whole index unusable here.
      const body = m[2];
      const tail = m[3];
      if (/\bwhere\b/i.test(tail) || /\bwhere\b/i.test(bareWords(body))) continue; // partial
      const list = columnList(body);
      if (!list) continue;
      factsFor(all, m[1]).declared.push({ cols: list, unconditional: /\bnulls\s+not\s+distinct\b/i.test(tail) });
    }
  }
  const sets: UniqueSets = new Map();
  for (const [t, f] of all) {
    const proven = f.declared
      .filter((d) => d.unconditional || d.cols.every((c) => f.notNull.get(c) === true))
      .map((d) => d.cols);
    if (proven.length > 0) sets.set(t, proven);
  }
  return sets;
}

export interface PagedReadKey {
  file: string;
  line: number;
  table: string | null;
  keys: string[] | null;
}

/** Every `selectAllPages` call in a file, with the table it reads and its key. */
export function pagedReadKeys(file: string, source: string): PagedReadKey[] {
  return pagedCallSpans(source).map(([s, e]) => {
    const call = source.slice(s, e);
    const table = /\.from\(\s*["'`]([\w]+)["'`]/.exec(call)?.[1] ?? null;
    const args = call.slice(call.indexOf("(") + 1);
    // Either quote is valid TypeScript, so the key is read with a pattern, never
    // JSON.parse, which throws on single quotes.
    const keyM = /^\s*(?:"[^"]*"|`[^`]*`|'[^']*')\s*,\s*("[^"]+"|'[^']+'|\[[^\]]*\])\s*,/.exec(args);
    let keys: string[] | null = null;
    if (keyM) {
      const found = [...keyM[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
      keys = found.length > 0 ? found : null;
    }
    return { file, line: source.slice(0, s).split("\n").length, table, keys };
  });
}

/** Null when the key covers one of the table's unique sets, else why it does not. */
export function judgePagedReadKey(read: PagedReadKey, sets: UniqueSets): string | null {
  if (read.table === null) return "names no table this scan can read";
  if (read.keys === null) return "passes no literal key this scan can read";
  const known = sets.get(read.table);
  if (!known || known.length === 0) return `table ${read.table} declares no unique column set in the migrations`;
  const keys = new Set(read.keys.map((k) => k.toLowerCase()));
  if (known.some((set) => set.every((c) => keys.has(c)))) return null;
  return `key [${read.keys.join(", ")}] covers none of ${read.table}'s unique sets: ${known
    .map((s) => `(${s.join(", ")})`)
    .join(" ")}`;
}
