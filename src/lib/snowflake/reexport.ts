/**
 * Re-export specific rows to the warehouse by id (#1102).
 *
 * The gap this fills. #1132 made the retention lanes refuse to destroy a row the
 * warehouse cannot confirm, which is the safe direction, but it gave those rows
 * nowhere to go. The incremental export cursor is strictly forward
 * (`export.ts` keyset fetch), so a row the lane skipped is never revisited, and
 * the resumable backfill lane from #1100 does not exist: that issue is closed, yet
 * there is no `snowflake-backfill` route, no `CRON_ROUTES` entry, and nothing in
 * the codebase passes the `keyPrefix` the backfill was supposed to use. So a single
 * missed row would have made the refusal permanent, and the alert unactionable.
 *
 * This is the narrow, honest version of that missing capability: MERGE an explicit
 * set of ids, ignoring the cursor entirely. The MERGE is keyed by id and idempotent
 * (`buildMergeSql`), so re-sending a row the warehouse already has is harmless.
 *
 * It deliberately does NOT advance any cursor. This is a repair, not a lane: the
 * cursor describes how far the incremental sweep has reached, and moving it here
 * would skip rows that were never exported.
 *
 * One row is never re-exported: one that has been redacted in place. Re-MERGEing a
 * blanked row would overwrite the warehouse's full-fidelity copy, which is the exact
 * clobber #1118 exists to prevent. Such a row also drops out of the retention lanes'
 * candidate reads on its own, so skipping it here loops nothing.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { executeStatement } from "./client";
import { readSnowflakeConfig } from "./config";
import { MIRROR_TABLES } from "./export-core";
import { buildMergeSql } from "./merge";
import { applySkipRedacted } from "./skip-redacted";
import { MAX_VERIFY_BATCH } from "./verify-archived";
import { log } from "@/lib/log";

/**
 * MERGE the named rows into the warehouse. Returns how many rows were actually
 * sent, which can be fewer than `ids` when a row has since been redacted or
 * deleted. Throws on a real failure: a repair that silently did nothing would
 * leave the caller believing the row is recoverable when it is not.
 */
export async function reexportByIds(table: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  if (ids.length > MAX_VERIFY_BATCH) {
    throw new Error(`reexportByIds: ${ids.length} ids exceeds the ${MAX_VERIFY_BATCH} batch bound`);
  }
  const spec = MIRROR_TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`reexportByIds: ${table} is not a mirrored table`);

  const config = readSnowflakeConfig();
  if (!config) throw new Error(`reexportByIds ${table}: mirror not configured`);

  // cap-safe: bounded by an explicit id list, itself capped at MAX_VERIFY_BATCH.
  const { data, error } = await applySkipRedacted(
    table,
    supabaseAdmin()
      .from(table)
      .select(spec.cols.map((c) => c.name).join(","))
      .in("id", ids),
  );
  if (error) throw new Error(`reexportByIds ${table} read: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return 0;

  await executeStatement(config, buildMergeSql(spec.table, spec.cols, rows));
  return rows.length;
}

/**
 * Best-effort repair used by the retention lanes: re-send the rows the warehouse
 * could not confirm, so the next run can verify and destroy them instead of
 * refusing forever.
 *
 * Swallows its own failure ON PURPOSE, and logs it. The caller is already about to
 * alert (or has already left the rows in place), so a failed repair must not mask
 * that signal or turn a correct refusal into a different error. The rows stay
 * un-destroyed either way, which is the safe direction.
 */
export async function repairUnverified(table: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const sent = await reexportByIds(table, ids);
    log.warn("snowflake-repair", { msg: "re-exported unverified rows", table, requested: ids.length, sent });
    return sent;
  } catch (err) {
    log.error(
      "snowflake-repair",
      { msg: "re-export failed; rows stay un-destroyed", table, requested: ids.length },
      err instanceof Error ? err : undefined,
    );
    return 0;
  }
}
