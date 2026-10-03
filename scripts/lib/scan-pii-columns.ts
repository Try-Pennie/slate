// #3126: which live columns hold lead PII, read off the migrations rather than
// remembered, so docs/pii-retention.md section 1 can be checked against them.
//
// The inventory there was hand maintained and drifted: booking_reservations.payload
// held the whole attendee record and the manage token, and appeared nowhere. This
// module replays the migrations in apply order (create table, add column, drop
// column, drop table) to get the live columns, then picks the ones whose NAME has
// the shape of lead data. scripts/test-pii-inventory.ts does the comparison.
//
// THE LIMIT, stated so nobody reads more into a green run: this matches NAMES. A
// column holding contact data under an innocent name (rate_limits.key is one) is
// invisible to it, which is why the test carries a short list of those by hand.
// And a text scan of SQL is not a parser: it reads the shapes Slate's migrations
// are actually written in, and its positive controls are what say it still does.

export interface MigrationText {
  name: string;
  sql: string;
}

/** A column whose name has the shape of lead contact data or a copy of it. */
export const PII_SHAPED_COLUMN =
  /^attendee_|email|phone|prefill|reason_detail|^payload$|last_response/;

const IDENT = String.raw`(?:public\.)?"?(\w+)"?`;

/** Every live `table.column`, after replaying the migrations in name order. */
export function liveColumns(migrations: MigrationText[]): Set<string> {
  const live = new Set<string>();
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  for (const { sql: raw } of sorted) {
    const sql = raw.replace(/--.*$/gm, "");
    // Statements in source order, so a drop after an add in one file wins.
    for (const statement of sql.split(/;\s*(?:\n|$)/)) {
      const create = new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${IDENT}\s*\(([\s\S]*)\)\s*$`, "i").exec(statement.trim());
      if (create) {
        const table = create[1]!.toLowerCase();
        for (const line of splitTopLevel(create[2]!)) {
          const col = /^\s*"?(\w+)"?\s+\w/.exec(line)?.[1]?.toLowerCase();
          if (col && !/^(constraint|primary|unique|check|foreign|exclude)$/.test(col)) live.add(`${table}.${col}`);
        }
        continue;
      }
      const dropTable = new RegExp(String.raw`^\s*drop\s+table\s+(?:if\s+exists\s+)?${IDENT}`, "i").exec(statement);
      if (dropTable) {
        const table = dropTable[1]!.toLowerCase();
        for (const c of [...live]) if (c.startsWith(`${table}.`)) live.delete(c);
        continue;
      }
      const alter = new RegExp(String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}([\s\S]*)$`, "i").exec(statement);
      if (alter) {
        const table = alter[1]!.toLowerCase();
        for (const clause of splitTopLevel(alter[2]!)) {
          const add = /^\s*add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/i.exec(clause);
          if (add) live.add(`${table}.${add[1]!.toLowerCase()}`);
          const drop = /^\s*drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/i.exec(clause);
          if (drop) live.delete(`${table}.${drop[1]!.toLowerCase()}`);
        }
      }
    }
  }
  return live;
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** The live columns whose name has the shape of lead data. */
export function piiShapedColumns(migrations: MigrationText[]): string[] {
  return [...liveColumns(migrations)]
    .filter((c) => PII_SHAPED_COLUMN.test(c.split(".")[1]!))
    .sort();
}

/** Every `table.column` written in backticks inside a markdown section. */
export function columnsNamedIn(section: string): Set<string> {
  return new Set([...section.matchAll(/`(\w+)\.(\w+)`/g)].map((m) => `${m[1]}.${m[2]}`.toLowerCase()));
}
