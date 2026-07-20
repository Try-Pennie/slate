// Shared parser for the uniqueness constraints a set of migrations declares.
// Extracted from scripts/test-upsert-conflict-targets.ts (#770) so the singleton
// "one row per X" guard (#839) reads the migrations through the SAME lens.
//
// The one policy the parser must NOT bake in is how a PARTIAL unique index (one
// carrying a WHERE) counts, because the two guards disagree:
//   - #770 (upsert onConflict): a partial index CANNOT be inferred by
//     `ON CONFLICT (cols)` (Postgres 42P10), so it does NOT satisfy an upsert
//     target. That bug shipped once (migration 0022).
//   - #839 (singleton invariant): a partial unique index DOES enforce "at most
//     one row per X" over the rows it covers (e.g. ooo_requests' one active
//     request per window), so it DOES satisfy a singleton guard.
// The parser therefore keeps them in separate buckets and lets each caller pick.

/** Normalize a column list: strip quotes/whitespace, join on comma. */
export function normCols(cols: string): string {
  return cols
    .split(",")
    .map((c) => c.trim().replace(/"/g, ""))
    .filter(Boolean)
    .join(",");
}

export interface MigrationConstraints {
  /** table -> set of "col,col" covered by a NON-partial unique index, a
   *  table-level UNIQUE, or a column-level UNIQUE. Inferable by ON CONFLICT. */
  uniqueIndexes: Map<string, Set<string>>;
  /** table -> set of "col,col" covered by a PARTIAL (WHERE) unique index. Still
   *  enforces a singleton over the covered rows, but NOT ON CONFLICT-inferable. */
  partialUniqueIndexes: Map<string, Set<string>>;
  /** table -> the primary key's "col,col". */
  primaryKeys: Map<string, string>;
}

function add(map: Map<string, Set<string>>, table: string, cols: string): void {
  const set = map.get(table) ?? new Set<string>();
  set.add(cols);
  map.set(table, set);
}

/** Every table name a set of migrations declares via `create table`. Used by the
 *  #874 completeness check so a new table can't ship unclassified. */
export function parseDeclaredTables(sql: string): Set<string> {
  const tables = new Set<string>();
  for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/gi)) {
    tables.add(m[1]);
  }
  // Subtract tables a later migration drops: the NET declared set is what still
  // exists, so a dropped table is not required to carry RLS (#875) or a singleton
  // classification (#874). Migrations are append-only, so the concatenated SQL is
  // in apply order and a create-then-drop nets to gone (#290).
  for (const m of sql.matchAll(/drop table (?:if exists )?(?:public\.)?(\w+)/gi)) {
    tables.delete(m[1]);
  }
  return tables;
}

/** Parse the concatenated SQL of all migrations into the constraints it declares. */
export function parseMigrationConstraints(sql: string): MigrationConstraints {
  const uniqueIndexes = new Map<string, Set<string>>();
  const partialUniqueIndexes = new Map<string, Set<string>>();
  const primaryKeys = new Map<string, string>();

  // create [unique] index [if not exists] <name> on <table> (<cols>) [where ...];
  const indexRe =
    /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+(?:public\.)?(\w+)\s*\(([^)]+)\)([^;]*);/gi;
  for (const m of sql.matchAll(indexRe)) {
    const [, table, cols, tail] = m;
    // A WHERE makes it PARTIAL: still a singleton guard, but not ON CONFLICT-safe.
    if (/\bwhere\b/i.test(tail)) add(partialUniqueIndexes, table, normCols(cols));
    else add(uniqueIndexes, table, normCols(cols));
  }

  for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    const [, table, body] = m;

    // A table-level UNIQUE constraint is backed by a unique index and IS
    // ON CONFLICT-inferable, exactly like `create unique index`.
    for (const u of body.matchAll(/^\s*unique\s*\(([^)]+)\)/gim)) {
      add(uniqueIndexes, table, normCols(u[1]));
    }

    const tableLevel = body.match(/^\s*primary\s+key\s*\(([^)]+)\)/im);
    if (tableLevel) {
      primaryKeys.set(table, normCols(tableLevel[1]));
      continue;
    }
    // Column-level: `key text primary key`, `id uuid primary key default ...`,
    // and column-level UNIQUE: `email text not null unique`. Scan every line: a
    // column-level UNIQUE can sit AFTER the PK line (e.g. google_credentials'
    // `id ... primary key` then `user_id ... unique`), so do NOT stop at the PK.
    for (const line of body.split("\n")) {
      const pk = line.match(/^\s*(\w+)\s+[\w\s()]*?\bprimary\s+key\b/i);
      if (pk) {
        if (!primaryKeys.has(table)) primaryKeys.set(table, pk[1]);
        continue;
      }
      const uniqueCol = line.match(/^\s*(\w+)\s+[\w\s()]*?\bunique\b/i);
      if (uniqueCol) add(uniqueIndexes, table, uniqueCol[1]);
    }
  }

  return { uniqueIndexes, partialUniqueIndexes, primaryKeys };
}

/** True when `table(cols)` has a NON-partial unique index or PK (the constraint
 *  a supabase-js upsert `onConflict: "cols"` can actually infer, #770). */
export function hasUpsertTarget(c: MigrationConstraints, table: string, cols: string): boolean {
  const key = normCols(cols);
  return (c.uniqueIndexes.get(table)?.has(key) ?? false) || c.primaryKeys.get(table) === key;
}

/** True when `table(cols)` is guarded against duplicates by ANY unique constraint
 *  (partial or full) or the PK: the "at most one row per X" invariant (#839). */
export function hasSingletonGuard(c: MigrationConstraints, table: string, cols: string): boolean {
  const key = normCols(cols);
  return (
    hasUpsertTarget(c, table, key) ||
    (c.partialUniqueIndexes.get(table)?.has(key) ?? false)
  );
}
