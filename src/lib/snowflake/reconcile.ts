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
 *
 * This file is the IO half. The decision, including the wording of each reason and
 * which of the two causes of drift the lag reading names (#1230), is in
 * reconcile-core.ts.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { readSnowflakeConfig } from "./config";
import { escapeSqlLiteral, executeStatement, type SnowflakeConfig } from "./client";
import { shortErrorReason } from "@/lib/notify/error-text";
import { MIRROR_TABLES } from "./export-core";
import { applySkipRedacted } from "./skip-redacted";
import { measureExportLag } from "./export-lag";
import { type TableLag } from "./export-lag-core";
import { evaluateRecon, type ControlCheck, type ReconOutcome, type TableRecon } from "./reconcile-core";

// The pure decision (thresholds, the reason wording, the cause the lag reading
// names) lives in reconcile-core.ts so the alert preview can render the real
// sentences without loading Supabase. Re-exported here because this module is the
// lane's public face.
export {
  DRIFT_TOLERANCE_ROWS,
  DRIFT_TOLERANCE_PCT,
  driftCause,
  evaluateRecon,
  reconThreshold,
  type ControlCheck,
  type ReconOutcome,
  type TableRecon,
} from "./reconcile-core";

type ReconRead = { count: number | null; data: unknown; error: { message: string } | null };
interface ReconBuilder extends PromiseLike<ReconRead> {
  select(cols: string, opts?: { count: "exact"; head: true }): ReconBuilder;
  order(col: string, opts: { ascending: boolean }): ReconBuilder;
  limit(n: number): ReconBuilder;
  is(col: string, val: null): ReconBuilder;
  eq(col: string, val: boolean): ReconBuilder;
  lt(col: string, val: string): ReconBuilder;
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

/**
 * Exportable rows strictly BEHIND the export cursor (#1231).
 *
 * The set the warehouse should already hold in full. Two details it must get
 * right, or the comparison it feeds is meaningless:
 *
 *   - the SAME skip predicate as the export fetch and the total count, so a
 *     redacted row (deliberately never exported) is not counted as missing;
 *   - STRICT `<`. The cursor is a composite (watermark, id) keyset, so rows AT the
 *     cursor timestamp may be mid-page. Excluding them undercounts by at most one
 *     page's worth of ties, which is the safe direction for a signal that pages.
 *
 * Fails loud: a count that errored and came back as 0 would say "nothing is behind
 * the cursor", which reads exactly like a healthy mirror (#1165).
 */
async function countBehindCursor(
  db: ReconDb,
  table: string,
  watermark: string,
  cursorTs: string,
): Promise<number> {
  // cap-safe: head:true is a server-side count, no rows returned.
  const q = applySkipRedacted(table, db.from(table).select("*", { count: "exact", head: true })).lt(
    watermark,
    cursorTs,
  );
  const { count, error } = await q;
  if (error) throw new Error(`reconcile behind-cursor count ${table}: ${error.message}`);
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

  // #1230: read the lane's own position FIRST, so the reason can name the cause it
  // measured. Supabase-only and cheap. Deliberately before the counts: any skew
  // between the two readings then understates how many rows look stranded, which
  // is the safe direction for the strongest claim this alert makes, and small skew
  // is absorbed by the drift tolerance either way.
  //
  // A failure here costs the DIAGNOSIS, never the page. measureExportLag throws by
  // design (an unmeasured mirror must not present as a healthy one for the delete
  // gate), so it is caught here and degrades to an explicit unknown cause: losing
  // a real drift alert because its explanation could not be read would be the
  // worse failure.
  let lags: TableLag[] = [];
  try {
    lags = await measureExportLag();
  } catch (err) {
    log.warn("snowflake-reconcile", {
      msg: "export lag unreadable, drift cause reported as unknown",
      error: shortErrorReason(err),
    });
  }

  const tables: TableRecon[] = [];
  for (const spec of MIRROR_TABLES) {
    const supabase = await countSupabase(db, spec.table);
    const snowflake = await countSnowflake(config, spec.table);
    const cursorTs = lags.find((l) => l.table === spec.table)?.cursorTs ?? null;
    const behindCursor = cursorTs === null ? null : await countBehindCursor(db, spec.table, spec.watermark, cursorTs);
    tables.push({ table: spec.table, supabase, snowflake, drift: supabase - snowflake, behindCursor });
  }
  const controls: ControlCheck[] = [];
  for (const c of CONTROL_TABLES) {
    const check = await positiveControl(config, db, c.table, c.orderBy);
    if (check) controls.push(check);
  }
  const { ok, reasons } = evaluateRecon(tables, controls, lags);
  log.info("snowflake-reconcile", {
    msg: ok ? "in sync" : "drift",
    tables: tables.length,
    lags_measured: lags.length,
    reasons: reasons.length,
    controls: controls.length,
    controls_failed: controls.filter((c) => !c.foundInSnowflake).length,
  });
  return { ok, tables, controls, reasons };
}
