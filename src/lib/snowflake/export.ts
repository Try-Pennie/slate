/**
 * DB + Snowflake wiring for the export lane (#1099).
 *
 * The resumable-watermark loop is in export-core.ts (pure, node-tested). This
 * module builds the real ExportDeps (Supabase reads through `unwrap` so a read
 * error throws rather than silently mirroring an empty set, and MERGE writes
 * through the Snowflake client, which only resolves on a terminal response) and
 * runs every mirrored table under a shared wall-time deadline.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { readSnowflakeConfig } from "./config";
import { executeStatement, type SnowflakeConfig } from "./client";
import { buildMergeSql } from "./merge";
import { applySkipRedacted } from "./skip-redacted";
import {
  DEFAULT_BATCH,
  MIRROR_TABLES,
  WALL_TIME_BUDGET_MS,
  exportTable,
  type CursorPos,
  type ExportDeps,
  type ExportTableResult,
  type Row,
  type TableSpec,
} from "./export-core";

// Minimal structural view of the PostgREST builder for dynamic-table access:
// the generated client's `.from()` only accepts a literal table name, but the
// export iterates table names at runtime. One cast, kept honest by unwrap on
// every read and an explicit error check on the write.
type PgRead = { data: unknown; error: { message: string } | null };
interface PgBuilder extends PromiseLike<PgRead> {
  select(cols: string): PgBuilder;
  order(col: string, opts: { ascending: boolean }): PgBuilder;
  limit(n: number): PgBuilder;
  or(filter: string): PgBuilder;
  eq(col: string, val: string | boolean): PgBuilder;
  is(col: string, val: null): PgBuilder;
  maybeSingle(): PromiseLike<PgRead>;
  upsert(row: Record<string, unknown>, opts: { onConflict: string }): PromiseLike<{ error: { message: string } | null }>;
}
interface PgClient {
  from(table: string): PgBuilder;
}

export function makeExportDeps(config: SnowflakeConfig, db: PgClient): ExportDeps {
  return {
    async loadCursor(key) {
      const data = unwrap(
        await db.from("export_cursor").select("last_ts,last_id").eq("key", key).maybeSingle(),
        `snowflake-export cursor ${key}`,
      ) as CursorPos | null;
      return data ? { last_ts: data.last_ts, last_id: data.last_id } : null;
    },

    async fetchBatch(spec, cursor, limit) {
      const cols = spec.cols.map((c) => c.name).join(",");
      let q = db
        .from(spec.table)
        .select(cols)
        .order(spec.watermark, { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      // Keyset page after the last exported (watermark, id): strictly greater by
      // watermark, or equal watermark with a greater id, so a batch boundary that
      // splits rows sharing a timestamp neither skips nor re-reads them.
      if (cursor?.last_ts != null && cursor.last_id != null) {
        q = q.or(
          `${spec.watermark}.gt.${cursor.last_ts},and(${spec.watermark}.eq.${cursor.last_ts},id.gt.${cursor.last_id})`,
        );
      }
      // #1118: exclude rows redacted in place, AND-ed with the keyset above (a
      // separate chained filter, never folded into the .or(), which would ignore
      // the cursor). Freezes Snowflake at the last full-fidelity version.
      q = applySkipRedacted(spec.table, q);
      return unwrap(await q, `snowflake-export fetch ${spec.table}`) as Row[];
    },

    async mergeBatch(spec, rows) {
      // executeStatement polls a 202 to a terminal state and throws on any
      // non-terminal/failed response, so this resolves only on a confirmed write.
      await executeStatement(config, buildMergeSql(spec.table, spec.cols, rows));
    },

    async saveCursor(key, lastTs, lastId) {
      const { error } = await db
        .from("export_cursor")
        .upsert({ key, last_ts: lastTs, last_id: lastId, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw new Error(`snowflake-export cursor save ${key}: ${error.message}`);
    },

    now: () => Date.now(),
  };
}

export interface RunExportOpts {
  deadline?: number;
  batch?: number;
  /** Cursor-scope prefix (the #1100 backfill lane passes its own). */
  keyPrefix?: string;
  tables?: TableSpec[];
  /** The lane lock's fence (#3120), asked before each MERGE. */
  stillHeld?: () => Promise<boolean>;
}

export async function runSnowflakeExport(
  opts: RunExportOpts = {},
): Promise<{ skipped: "not-configured" } | { exported: number; results: ExportTableResult[] }> {
  const config = readSnowflakeConfig();
  if (!config) {
    log.info("snowflake-export", { msg: "skipped: not configured" });
    return { skipped: "not-configured" };
  }

  const deps = makeExportDeps(config, supabaseAdmin() as unknown as PgClient);
  const deadline = opts.deadline ?? Date.now() + WALL_TIME_BUDGET_MS;
  const batch = opts.batch ?? DEFAULT_BATCH;
  const tables = opts.tables ?? MIRROR_TABLES;

  const results: ExportTableResult[] = [];
  const errors: string[] = [];
  for (const spec of tables) {
    if (Date.now() >= deadline) break;
    try {
      const result = await exportTable(spec, deps, {
        limit: batch,
        deadline,
        keyPrefix: opts.keyPrefix,
        stillHeld: opts.stillHeld,
      });
      results.push(result);
      // Another run owns the lane now (#3120): leave every remaining table to it.
      if (result.leaseLost) break;
    } catch (e) {
      // One table's failure must not skip the rest: it re-exports next tick with
      // its cursor unadvanced. Collect and re-throw at the end so the lane fails
      // loud (500 + alert) rather than reporting a clean run.
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${spec.table}: ${message}`);
      log.error("snowflake-export", { msg: "table failed", table: spec.table }, e instanceof Error ? e : undefined);
    }
  }

  const exported = results.reduce((sum, r) => sum + r.exported, 0);
  log.info("snowflake-export", { msg: "cycle", exported, tables: results.length, failed: errors.length });
  if (errors.length > 0) {
    throw new Error(`Snowflake export had ${errors.length} table failure(s): ${errors.join("; ")}`);
  }
  return { exported, results };
}
