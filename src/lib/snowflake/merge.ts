/**
 * MERGE-by-id SQL construction for the Snowflake export lane (#1097).
 *
 * Ported from the Bidspoke exporter (sightings-export.ts). Every mirror table is
 * upserted by primary key: WHEN MATCHED refreshes the current snapshot (so a
 * mutable row re-exports after an upstream change), WHEN NOT MATCHED inserts.
 * The export role has UPDATE + INSERT but no DELETE, so this can never destroy a
 * warehouse row (see docs/snowflake-setup.sql).
 *
 * JSONB columns map to Snowflake VARIANT. Snowflake VALUES lists only allow
 * constants, so a variant value travels as an escaped JSON string in the VALUES
 * list and gets PARSE_JSON applied in the USING projection.
 */

import { escapeSqlLiteral } from "./client";

export type ColType = "varchar" | "number" | "boolean" | "timestamp_tz" | "timestamp_ntz" | "variant";

export interface ColSpec {
  name: string;
  type: ColType;
}

export function buildMergeSql(tableName: string, cols: ColSpec[], rows: Array<Record<string, unknown>>): string {
  const colList = cols.map((c) => c.name).join(", ");
  const sourceColList = cols.map((c) => `s.${c.name}`).join(", ");
  // UPDATE clause covers every column except id (the join key). Lets us
  // re-export rows when columns are added or values are corrected upstream.
  const updateSet = cols
    .filter((c) => c.name !== "id")
    .map((c) => `${c.name} = s.${c.name}`)
    .join(", ");
  const valuesList = rows
    .map((r) => "(" + cols.map((c) => formatValue(r[c.name], c.type)).join(", ") + ")")
    .join(", ");
  const tupleAlias = "(" + cols.map((c) => c.name).join(", ") + ")";
  // Variant columns travel as escaped JSON strings (VALUES only allows
  // constants) and get PARSE_JSON applied in this projection.
  const projection = cols
    .map((c) => (c.type === "variant" ? `PARSE_JSON(${c.name}) AS ${c.name}` : c.name))
    .join(", ");

  return `
MERGE INTO ${tableName} t
USING (
  SELECT ${projection} FROM (VALUES ${valuesList}) AS s${tupleAlias}
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET ${updateSet}
WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${sourceColList})
`.trim();
}

export function formatValue(v: unknown, type: ColType): string {
  if (v === null || v === undefined || v === "") return "NULL";
  switch (type) {
    case "varchar":
      return `'${escapeSqlLiteral(coerceString(v))}'`;
    case "number":
      return Number.isFinite(Number(v)) ? String(Number(v)) : "NULL";
    case "boolean":
      return v === true || v === "true" || v === 1 || v === "1" ? "TRUE" : "FALSE";
    case "timestamp_tz":
      return `'${escapeSqlLiteral(coerceString(v))}'::TIMESTAMP_TZ`;
    case "timestamp_ntz":
      return `'${escapeSqlLiteral(coerceString(v))}'::TIMESTAMP_NTZ`;
    case "variant":
      return `'${escapeSqlLiteral(JSON.stringify(v))}'`;
  }
}

function coerceString(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}
