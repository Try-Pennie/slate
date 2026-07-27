/**
 * Row-count reconciliation for the Snowflake mirror (#1101).
 *
 * Counts every mirrored table in Supabase and in Snowflake and flags drift, so a
 * silently-lagging or broken export lane surfaces instead of a quietly stale
 * warehouse. Also the hard precondition the future deletion phase (#1102) must
 * pass before it deletes anything.
 *
 * A POSITIVE CONTROL guards the class of bug this exists to catch (see
 * feedback-run-a-positive-control): before trusting a Snowflake COUNT of 0, we
 * confirm a row we KNOW is present (the oldest booking, long past export) is
 * found in Snowflake. If even that read comes back empty, the count query is
 * reading the wrong place and a "0 drift" cannot be believed, so we alert.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { readSnowflakeConfig } from "./config";
import { escapeSqlLiteral, executeStatement, type SnowflakeConfig } from "./client";
import { MIRROR_TABLES } from "./export-core";

// Normal lag tolerance: the export runs every 10 min, so Supabase can legitimately
// be a little ahead of Snowflake. Alert only when the gap exceeds the larger of a
// flat floor and a small fraction of the table, so a genuinely stuck lane shows
// but ordinary between-tick lag does not.
export const DRIFT_TOLERANCE_ROWS = 25;
export const DRIFT_TOLERANCE_PCT = 0.02;

export function reconThreshold(supabaseRows: number): number {
  return Math.max(DRIFT_TOLERANCE_ROWS, Math.ceil(supabaseRows * DRIFT_TOLERANCE_PCT));
}

export interface TableRecon {
  table: string;
  supabase: number;
  snowflake: number;
  /** Supabase minus Snowflake: positive = Snowflake is behind. */
  drift: number;
}

export interface ControlCheck {
  table: string;
  id: string;
  foundInSnowflake: boolean;
}

export interface ReconOutcome {
  skipped?: true;
  ok: boolean;
  tables: TableRecon[];
  control: ControlCheck | null;
  reasons: string[];
}

/** Pure decision: given per-table counts and the control, what (if anything) is
 *  wrong. Node/vitest-testable without any IO. */
export function evaluateRecon(tables: TableRecon[], control: ControlCheck | null): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (control && !control.foundInSnowflake) {
    reasons.push(
      `positive control failed: ${control.table} row ${control.id} is in Supabase but not found in Snowflake, so the count reads cannot be trusted (a zero may be a broken query, not an empty table)`,
    );
  }
  for (const t of tables) {
    if (t.snowflake > t.supabase) {
      // Impossible without a delete in Snowflake or a delete in Supabase the
      // mirror has not yet seen: worth a look either way.
      reasons.push(`${t.table}: Snowflake has MORE rows than Supabase (${t.snowflake} vs ${t.supabase})`);
    } else if (t.drift > reconThreshold(t.supabase)) {
      reasons.push(`${t.table}: Snowflake is behind by ${t.drift} rows (${t.snowflake}/${t.supabase})`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

type ReconRead = { count: number | null; data: unknown; error: { message: string } | null };
interface ReconBuilder extends PromiseLike<ReconRead> {
  select(cols: string, opts?: { count: "exact"; head: true }): ReconBuilder;
  order(col: string, opts: { ascending: boolean }): ReconBuilder;
  limit(n: number): ReconBuilder;
  maybeSingle(): PromiseLike<ReconRead>;
}
interface ReconDb {
  from(table: string): ReconBuilder;
}

async function countSupabase(db: ReconDb, table: string): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`reconcile count ${table}: ${error.message}`);
  return count ?? 0;
}

async function countSnowflake(config: SnowflakeConfig, table: string): Promise<number> {
  // `table` comes from MIRROR_TABLES (a fixed in-repo allowlist), never user
  // input, so interpolating it into the statement is safe.
  const res = await executeStatement(config, `SELECT COUNT(*) AS c FROM ${table}`);
  return Number(res.data?.[0]?.[0] ?? 0);
}

async function positiveControl(config: SnowflakeConfig, db: ReconDb): Promise<ControlCheck | null> {
  const { data, error } = await db
    .from("bookings")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`reconcile control read: ${error.message}`);
  if (!data) return null; // no bookings yet: nothing to control against
  const id = (data as { id: string }).id;
  const res = await executeStatement(config, `SELECT COUNT(*) AS c FROM bookings WHERE id = '${escapeSqlLiteral(id)}'`);
  return { table: "bookings", id, foundInSnowflake: Number(res.data?.[0]?.[0] ?? 0) > 0 };
}

export async function reconcileSnowflakeMirror(): Promise<ReconOutcome> {
  const config = readSnowflakeConfig();
  if (!config) return { skipped: true, ok: true, tables: [], control: null, reasons: [] };

  const db = supabaseAdmin() as unknown as ReconDb;
  const tables: TableRecon[] = [];
  for (const spec of MIRROR_TABLES) {
    const supabase = await countSupabase(db, spec.table);
    const snowflake = await countSnowflake(config, spec.table);
    tables.push({ table: spec.table, supabase, snowflake, drift: supabase - snowflake });
  }
  const control = await positiveControl(config, db);
  const { ok, reasons } = evaluateRecon(tables, control);
  log.info("snowflake-reconcile", {
    msg: ok ? "in sync" : "drift",
    tables: tables.length,
    reasons: reasons.length,
    control: control ? String(control.foundInSnowflake) : "none",
  });
  return { ok, tables, control, reasons };
}
