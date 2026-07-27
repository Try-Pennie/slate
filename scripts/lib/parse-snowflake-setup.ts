// Parser for the mirror-table DDL in docs/snowflake-setup.sql (#1116).
//
// The warehouse schema lives in that file, not in a migration, so nothing in the
// build has ever compared it against the column list the export lane actually
// sends (MIRROR_TABLES in src/lib/snowflake/export-core.ts). That was tolerable
// while every MERGE column came from the source row; it stopped being tolerable
// once the MERGE started writing `exported_at` unconditionally, because a mirror
// table missing that column now fails every export.
//
// So the guard derives the expectation from the DDL rather than restating it
// (L41): parse the CREATE TABLE blocks and compare. Lives here, apart from the
// test file, so the parser is itself unit-testable and so the runner's
// `scripts/test-*.ts` glob does not pick it up as a suite.

export interface ParsedColumn {
  name: string;
  /** The declared Snowflake type, upper-cased (VARCHAR, TIMESTAMP_NTZ, ...). */
  type: string;
}

/**
 * Extract every `CREATE TABLE IF NOT EXISTS <name> ( ... )` block, keyed by
 * table name. Handles the file's actual shape: one column per line, an optional
 * trailing comma, inline column constraints (`PRIMARY KEY`), `--` comment lines,
 * and a trailing `CLUSTER BY (...)` after the closing paren.
 */
export function parseSnowflakeTables(sql: string): Map<string, ParsedColumn[]> {
  const tables = new Map<string, ParsedColumn[]>();
  const blockRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)\s*\(([\s\S]*?)\n\)/g;

  for (const m of sql.matchAll(blockRe)) {
    const table = m[1].replace(/"/g, "").split(".").pop()!;
    tables.set(table, parseColumnBlock(m[2]));
  }
  return tables;
}

function parseColumnBlock(body: string): ParsedColumn[] {
  const cols: ParsedColumn[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (line === "" || line.startsWith("--")) continue;
    // A table-level constraint is not a column.
    if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CONSTRAINT|CHECK)\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    cols.push({ name: parts[0], type: parts[1].toUpperCase() });
  }
  return cols;
}

/** One thing wrong with one mirror table. */
export interface MirrorSchemaProblem {
  table: string;
  problem: string;
}

export interface MirrorTableExpectation {
  table: string;
  cols: Array<{ name: string }>;
}

/**
 * Compare the export lane's column lists against the parsed DDL. Returns one
 * problem per divergence; an empty array means the mirror DDL can accept every
 * MERGE the lane builds.
 */
export function findMirrorSchemaProblems(
  expected: MirrorTableExpectation[],
  declared: Map<string, ParsedColumn[]>,
  loadStampCol: string,
  loadStampType: string,
): MirrorSchemaProblem[] {
  const problems: MirrorSchemaProblem[] = [];

  for (const spec of expected) {
    const cols = declared.get(spec.table);
    if (!cols) {
      problems.push({ table: spec.table, problem: "no CREATE TABLE block in docs/snowflake-setup.sql" });
      continue;
    }
    const byName = new Map(cols.map((c) => [c.name, c]));

    for (const c of spec.cols) {
      if (!byName.has(c.name)) {
        problems.push({ table: spec.table, problem: `exported column ${c.name} is not declared` });
      }
    }

    const stamp = byName.get(loadStampCol);
    if (!stamp) {
      // The MERGE writes this column on every branch, so a table without it
      // rejects every export, not just some.
      problems.push({ table: spec.table, problem: `missing the ${loadStampCol} load stamp the MERGE always writes` });
    } else if (stamp.type !== loadStampType) {
      problems.push({
        table: spec.table,
        problem: `${loadStampCol} is ${stamp.type}, expected ${loadStampType}`,
      });
    }

    if (spec.cols.some((c) => c.name === loadStampCol)) {
      problems.push({
        table: spec.table,
        problem: `${loadStampCol} must not be an exported source column; the warehouse stamps it`,
      });
    }
  }

  return problems;
}
