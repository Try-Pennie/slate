// Scan logic for the #354 embed-relationship invariant, kept beside the guard
// (scripts/test-db-embed-relationships.ts) so it is unit-testable.
//
// A PostgREST nested select (an "embed") like `.select("*, event_types(*)")`
// only type-checks when the hand-written Database (src/lib/db/schema.ts) declares
// a `Relationships` entry connecting the two tables. Without it the embedded row
// collapses to a SelectQueryError and the call site is forced back to an
// `as unknown as` cast (the #354 fragility). This scanner asserts every embed in
// src/ is backed by a declared relationship, so the pattern stays safe to reuse.

/** One embed found in a `.select(...)`: the querying table and the nested relation. */
export type Embed = { table: string; relation: string; file?: string };

/** One relationship declared on a table in schema.ts (on the FK-holder table). */
export type Declared = { table: string; referencedRelation: string };

/**
 * Embeds in a source file: for each `.select("...")` string, every `relation(` it
 * nests, paired with the nearest preceding `.from("<table>")`. Handles the
 * single-line and the multi-line `.select(\n  "...",\n)` forms. Plain column lists
 * (no `identifier(`) yield nothing; a write's `.select()` for a returning row is
 * likewise ignored unless it nests a relation.
 */
export function findEmbeds(src: string, file?: string): Embed[] {
  const out: Embed[] = [];
  // First string-literal argument of each `.select(` (eats a leading newline/indent).
  const selectRe = /\.select\(\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of src.matchAll(selectRe)) {
    const content = m[1];
    // A nested relation is an identifier immediately followed by `(`, optionally
    // carrying PostgREST's join hint (`buckets!inner(...)`, `buckets!left(...)`).
    // The hint is not a table, so the identifier BEFORE it is the embedded relation;
    // reading "inner" as the relation would make the embed impossible to cover.
    const relNames = [...content.matchAll(/\b([a-z_][a-z0-9_]*)(?:!(?:inner|left))?\s*\(/gi)].map(
      (r) => r[1],
    );
    if (relNames.length === 0) continue;
    // Walk back to the nearest `.from("<table>")` that opened this chain.
    const before = src.slice(0, m.index);
    const fromMatch = [...before.matchAll(/\.from\(\s*"([^"]+)"/g)].pop();
    const table = fromMatch?.[1] ?? "";
    for (const relation of relNames) out.push({ table, relation, file });
  }
  return out;
}

/**
 * Relationships declared in schema.ts: every `<table>: Table<Row, [ {...} ]>` block,
 * flattened to (FK-holder table, referencedRelation) pairs. A table declared with no
 * relationships tuple (`Table<Row>`) contributes nothing.
 */
export function findDeclaredRelationships(schemaSrc: string): Declared[] {
  const out: Declared[] = [];
  const tableRe = /(\w+):\s*Table<\s*\w+\s*,\s*\[([\s\S]*?)\]\s*>/g;
  for (const m of schemaSrc.matchAll(tableRe)) {
    const table = m[1];
    for (const r of m[2].matchAll(/referencedRelation:\s*"(\w+)"/g)) {
      out.push({ table, referencedRelation: r[1] });
    }
  }
  return out;
}

/**
 * An embed is covered when a declared relationship connects its two tables in
 * EITHER direction: forward (the querying table holds the FK to the embedded
 * relation) or reverse (the embedded relation holds the FK back to the querying
 * table, e.g. availability_schedules embedding its availability_rules).
 */
export function isEmbedCovered(embed: Embed, declared: Declared[]): boolean {
  return declared.some(
    (d) =>
      (d.table === embed.table && d.referencedRelation === embed.relation) ||
      (d.table === embed.relation && d.referencedRelation === embed.table),
  );
}
