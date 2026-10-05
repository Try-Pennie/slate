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
//   - a column declared `primary key`, or a table `primary key (a, b)`;
//   - a table `unique (a, b)` constraint, or `alter table ... add primary key` /
//     `add constraint ... unique|primary key (...)`;
//   - a `create unique index ... on t (a, b)` with NO `where` (a partial index
//     says nothing about the rows it leaves out) and plain columns only.
// A constraint later dropped is not tracked; every key in use today is a primary
// key, which no migration drops.

import { pagedCallSpans } from "./scan-paged-calls.ts";

export type UniqueSets = Map<string, string[][]>;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const cols = (list: string) =>
  list.split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);

function add(sets: UniqueSets, table: string, set: string[]) {
  const t = table.replace(/^public\./, "").replace(/"/g, "").toLowerCase();
  const list = sets.get(t) ?? [];
  list.push(set);
  sets.set(t, list);
}

/** Split a create table body on its top level commas. */
function topLevelItems(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Every unique column set the migrations declare, by table. */
export function uniqueSetsFromMigrations(sources: string[]): UniqueSets {
  const sets: UniqueSets = new Map();
  for (const raw of sources) {
    const sql = stripSqlComments(raw);
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi;
    for (const m of sql.matchAll(createRe)) {
      const table = m[1];
      let depth = 1;
      let i = (m.index as number) + m[0].length;
      const start = i;
      for (; i < sql.length && depth > 0; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") depth--;
      }
      const body = sql.slice(start, i - 1);
      for (const item of topLevelItems(body)) {
        const t = item.trim();
        const tablePk = /^(?:constraint\s+\w+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(t);
        const tableUq = /^(?:constraint\s+\w+\s+)?unique\s*\(([^)]*)\)/i.exec(t);
        if (tablePk) add(sets, table, cols(tablePk[1]));
        else if (tableUq) add(sets, table, cols(tableUq[1]));
        else if (/\bprimary\s+key\b/i.test(t) || /\bunique\b(?!\s*\()/i.test(t)) {
          const name = /^"?(\w+)"?/.exec(t);
          if (name) add(sets, table, [name[1].toLowerCase()]);
        }
      }
    }
    const alterRe =
      /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w."]+)\s+add\s+(?:constraint\s+\w+\s+)?(?:primary\s+key|unique)\s*\(([^)]*)\)/gi;
    for (const m of sql.matchAll(alterRe)) add(sets, m[1], cols(m[2]));
    const indexRe =
      /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[\w"]+\s+on\s+(?:only\s+)?([\w."]+)\s*(?:using\s+\w+\s*)?\(([^;]*?)\)\s*(where\b)?[^;]*;/gi;
    for (const m of sql.matchAll(indexRe)) {
      if (m[3]) continue; // partial: not unique over the whole table
      if (/[()]/.test(m[2])) continue; // an expression index: not plain columns
      add(sets, m[1], cols(m[2]));
    }
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
    const keyM = /^\s*(?:"[^"]*"|`[^`]*`|'[^']*')\s*,\s*("[^"]+"|\[[^\]]*\])\s*,/.exec(args);
    let keys: string[] | null = null;
    if (keyM) {
      const parsed = JSON.parse(keyM[1]) as string | string[];
      keys = typeof parsed === "string" ? [parsed] : parsed;
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
