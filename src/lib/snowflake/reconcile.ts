/**
 * Row-count reconciliation for the Snowflake mirror (#1101).
 *
 * Counts every mirrored table in Supabase and in Snowflake and flags drift, so a
 * silently-lagging or broken export lane surfaces instead of a quietly stale
 * warehouse.
 *
 * NOT the deletion gate any more (#1139). It was, and it could not stay: this
 * comparison flags only "Snowflake is behind", which goes structurally negative
 * the moment retention deletes or redacts anything in Supabase, so as a gate it
 * would have become a rubber stamp exactly when deletion began. The gate now
 * reads an export-lag signal computed entirely in Supabase (export-lag.ts). This
 * lane keeps running every 6h as an INDEPENDENT drift monitor, which is the job
 * it is actually good at: it is the only thing that asks the warehouse whether
 * it still holds what we think it holds.
 *
 * A POSITIVE CONTROL guards the class of bug this exists to catch (see
 * feedback-run-a-positive-control): before trusting a Snowflake COUNT of 0, we
 * confirm a row we KNOW is present (the oldest row, long past export) is found
 * in Snowflake. If even that read comes back empty, the count query is reading
 * the wrong place and a "0 drift" cannot be believed, so we alert. Probed on
 * `bookings` and, since #1139, on `routing_decisions`, the table retention
 * actually hard-deletes from.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { readSnowflakeConfig } from "./config";
import { escapeSqlLiteral, executeStatement, type SnowflakeConfig } from "./client";
import { MIRROR_TABLES } from "./export-core";
import { applySkipRedacted } from "./skip-redacted";

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
  controls: ControlCheck[];
  reasons: string[];
}

/** Pure decision: given per-table counts and the controls, what (if anything) is
 *  wrong. Node/vitest-testable without any IO. */
export function evaluateRecon(tables: TableRecon[], controls: ControlCheck[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const control of controls) {
    if (control.foundInSnowflake) continue;
    reasons.push(
      `positive control failed: ${control.table} row ${control.id} is in Supabase but not found in Snowflake, so the count reads cannot be trusted (a zero may be a broken query, not an empty table)`,
    );
  }
  for (const t of tables) {
    // Only "Snowflake is BEHIND" is a fault (the mirror is losing/lagging rows).
    // "Snowflake ahead" (more rows than Supabase) is EXPECTED once export-gated
    // retention (#1102) prunes aged rows from Supabase while the warehouse keeps
    // the full history, so it is deliberately NOT flagged.
    if (t.drift > reconThreshold(t.supabase)) {
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
  is(col: string, val: null): ReconBuilder;
  eq(col: string, val: boolean): ReconBuilder;
  maybeSingle(): PromiseLike<ReconRead>;
}
interface ReconDb {
  from(table: string): ReconBuilder;
}

async function countSupabase(db: ReconDb, table: string): Promise<number> {
  // #1118: count with the SAME skip predicate the export fetch uses, so a
  // redacted-in-place row (excluded from export) is excluded here too. Without
  // this, an erased-before-export row (in Supabase, never in Snowflake) reads as
  // permanent "Snowflake is behind" drift and freezes the retention lane.
  const q = applySkipRedacted(table, db.from(table).select("*", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) throw new Error(`reconcile count ${table}: ${error.message}`);
  return count ?? 0;
}

async function countSnowflake(config: SnowflakeConfig, table: string): Promise<number> {
  // `table` comes from MIRROR_TABLES (a fixed in-repo allowlist), never user
  // input, so interpolating it into the statement is safe.
  const res = await executeStatement(config, `SELECT COUNT(*) AS c FROM ${table}`);
  return Number(res.data?.[0]?.[0] ?? 0);
}

/**
 * The tables a positive control probes.
 *
 * `bookings` is the busiest mirror. `routing_decisions` was added in #1139
 * because it is the one table retention actually HARD-DELETES from, and it had
 * no control at all: a broken count query against it would have read as zero
 * drift, which is precisely the false-negative a control exists to catch.
 */
const CONTROL_TABLES: { table: string; orderBy: string }[] = [
  { table: "bookings", orderBy: "created_at" },
  { table: "routing_decisions", orderBy: "created_at" },
];

async function positiveControl(
  config: SnowflakeConfig,
  db: ReconDb,
  table: string,
  orderBy: string,
): Promise<ControlCheck | null> {
  // #1102: apply the SAME skip predicate the count read uses (reconcile.ts
  // countSupabase). Without it, the control picks the oldest row whether or not
  // it was redacted in place, and a booking erased BEFORE its first export exists in
  // Supabase and never in Snowflake. If such a row is ever the oldest, the control
  // fails on every tick, `mirrorReadyForDeletion` is never ready again, and all
  // three retention lanes freeze permanently. That is the #1118 class the count read
  // was already patched for; the control was missed.
  // cap-safe: limit(1) + maybeSingle, a single-row read.
  const { data, error } = await applySkipRedacted(table, db.from(table).select("id"))
    .order(orderBy, { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`reconcile control read ${table}: ${error.message}`);
  if (!data) return null; // no rows yet: nothing to control against
  const id = (data as { id: string }).id;
  // `table` comes from CONTROL_TABLES (a fixed in-repo allowlist), never user
  // input, so interpolating it into the statement is safe.
  const res = await executeStatement(config, `SELECT COUNT(*) AS c FROM ${table} WHERE id = '${escapeSqlLiteral(id)}'`);
  return { table, id, foundInSnowflake: Number(res.data?.[0]?.[0] ?? 0) > 0 };
}

export async function reconcileSnowflakeMirror(): Promise<ReconOutcome> {
  const config = readSnowflakeConfig();
  if (!config) return { skipped: true, ok: true, tables: [], controls: [], reasons: [] };

  const db = supabaseAdmin() as unknown as ReconDb;
  const tables: TableRecon[] = [];
  for (const spec of MIRROR_TABLES) {
    const supabase = await countSupabase(db, spec.table);
    const snowflake = await countSnowflake(config, spec.table);
    tables.push({ table: spec.table, supabase, snowflake, drift: supabase - snowflake });
  }
  const controls: ControlCheck[] = [];
  for (const c of CONTROL_TABLES) {
    const check = await positiveControl(config, db, c.table, c.orderBy);
    if (check) controls.push(check);
  }
  const { ok, reasons } = evaluateRecon(tables, controls);
  log.info("snowflake-reconcile", {
    msg: ok ? "in sync" : "drift",
    tables: tables.length,
    reasons: reasons.length,
    controls: controls.length,
    controls_failed: controls.filter((c) => !c.foundInSnowflake).length,
  });
  return { ok, tables, controls, reasons };
}
