/**
 * The IO half of the export-lag deletion gate (#1139): read, per mirrored table,
 * how far the export cursor has fallen behind the newest exportable row.
 *
 * Every read here is Supabase-only and deliberately so. See export-lag-core.ts
 * for why this replaced the Supabase-vs-Snowflake row-count reconciliation as
 * the gate, and for what this signal does and does not prove.
 *
 * Two invariants this file has to hold, both of which are shipped-bug classes:
 *
 *   - It applies the SAME skip-redacted predicate the export fetch uses. A row
 *     redacted in place is deliberately never exported, and redaction bumps
 *     updated_at, so counting it would make the cursor permanently unable to
 *     reach the newest row: the gate would read as lagging forever and ALL
 *     retention would stop silently. That is the #1118 freeze.
 *   - Every read fails loud. A count that errors returns null, and the
 *     `count ?? 0` everyone writes turns that into a healthy-looking zero
 *     backlog (#1165). `unwrapCount`/`unwrap` throw instead, and the caller
 *     refuses the delete.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { MIRROR_TABLES } from "./export-core";
import { applySkipRedacted } from "./skip-redacted";
import type { TableLag } from "./export-lag-core";

/** The minimal PostgREST surface these reads need. */
type LagRead = { count: number | null; data: unknown; error: { message: string } | null };
interface LagBuilder extends PromiseLike<LagRead> {
  select(cols: string, opts?: { count: "exact"; head: true }): LagBuilder;
  is(col: string, val: null): LagBuilder;
  eq(col: string, val: boolean | string): LagBuilder;
  gt(col: string, val: string): LagBuilder;
  order(col: string, opts: { ascending: boolean }): LagBuilder;
  limit(n: number): LagBuilder;
  maybeSingle(): PromiseLike<LagRead>;
}
interface LagDb {
  from(table: string): LagBuilder;
}

/**
 * The confirmed-export watermark for one cursor key, or null when nothing has
 * been exported yet. The export lane advances this ONLY after a confirmed
 * terminal MERGE (#1099), so it is a trustworthy "already archived" line.
 *
 * Lives here rather than in retention-gate.ts because both the gate and this
 * measurement need it, and one implementation beats two. retention-gate.ts
 * re-exports it for the three cron lanes that read it directly.
 */
export async function exportedThrough(tableKey: string): Promise<string | null> {
  // cap-safe: key is the primary key, so this returns at most one row.
  const { data, error } = await supabaseAdmin()
    .from("export_cursor")
    .select("last_ts")
    .eq("key", tableKey)
    .maybeSingle();
  if (error) throw new Error(`retention-gate cursor ${tableKey}: ${error.message}`);
  return data?.last_ts ?? null;
}

/** Newest exportable watermark in `table`, or null when it holds no such row. */
async function newestWatermark(db: LagDb, table: string, watermark: string): Promise<string | null> {
  // cap-safe: limit(1) + maybeSingle, a single-row read.
  const res = await applySkipRedacted(table, db.from(table).select(watermark))
    .order(watermark, { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = unwrap(res as { data: unknown; error: { message: string } | null }, `export-lag newest ${table}`);
  const value = (row as Record<string, unknown> | null)?.[watermark];
  return value == null ? null : String(value);
}

/** Rows past the cursor still awaiting export. Diagnostic only. */
async function backlogPastCursor(
  db: LagDb,
  table: string,
  watermark: string,
  cursorTs: string | null,
): Promise<number> {
  // cap-safe: head:true is a server-side count, no rows returned.
  let q = applySkipRedacted(table, db.from(table).select("*", { count: "exact", head: true }));
  // Strict `>`: the cursor is a composite (watermark, id) keyset, so a row AT
  // the cursor timestamp may or may not have been exported. Undercounting by
  // the rows sharing that exact timestamp is the safe direction for a
  // diagnostic, and the lag reading is what actually gates.
  if (cursorTs !== null) q = q.gt(watermark, cursorTs);
  return unwrapCount(await q, `export-lag backlog ${table}`);
}

/**
 * Measure the export lag for every mirrored table.
 *
 * Throws if any read fails: an unmeasured mirror must never present as a
 * healthy one, because the caller's next move is to delete data.
 */
export async function measureExportLag(): Promise<TableLag[]> {
  const db = supabaseAdmin() as unknown as LagDb;
  const rows: TableLag[] = [];

  for (const spec of MIRROR_TABLES) {
    const cursorTs = await exportedThrough(spec.table);
    const newestTs = await newestWatermark(db, spec.table, spec.watermark);
    const backlog = await backlogPastCursor(db, spec.table, spec.watermark, cursorTs);
    rows.push({ table: spec.table, cursorTs, newestTs, backlog, lagMs: lagBetween(cursorTs, newestTs) });
  }

  return rows;
}

/**
 * How far `newestTs` sits past `cursorTs`, in ms.
 *
 * Three non-obvious cases, each of which has to land on the fail-safe side:
 *   - no rows at all: 0, because an empty table cannot be behind and must not
 *     freeze the other lanes;
 *   - rows but no cursor: Infinity, because NOTHING is in the warehouse yet;
 *   - a timestamp that will not parse: NaN, which the evaluator treats as a
 *     fault. Routed through parseStampMs rather than Date.parse precisely so a
 *     bad value cannot silently compare false against the bound and read as
 *     healthy (#1169/#1171).
 */
export function lagBetween(cursorTs: string | null, newestTs: string | null): number {
  if (newestTs === null) return 0;
  if (cursorTs === null) return Number.POSITIVE_INFINITY;
  const newest = parseStampMs(newestTs);
  const cursor = parseStampMs(cursorTs);
  if (newest === null || cursor === null) return Number.NaN;
  return Math.max(0, newest - cursor);
}
