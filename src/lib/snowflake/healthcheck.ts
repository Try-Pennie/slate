/**
 * Snowflake connectivity smoke check (#1110).
 *
 * Signs a real key-pair JWT with the Worker's SNOWFLAKE_PRIVATE_KEY and runs a
 * trivial query, so we can confirm end to end that the account identifier, host,
 * key-pair, and grants all line up, the one thing only a live call can prove.
 * Fails loud (returns a not-ok result and logs) rather than throwing, so a caller
 * can render or alert on it.
 *
 * It also probes the live mirror schema for the `exported_at` load stamp (#1116).
 * The mirror tables were created with CREATE TABLE IF NOT EXISTS, so the DDL in
 * docs/snowflake-setup.sql is not proof of what the warehouse actually has: a
 * table provisioned before the column was added would still be missing it. Since
 * the MERGE now writes that column on every branch, such a table fails 100% of
 * its exports, and only a live call can tell us. So the check reports it here
 * rather than leaving it to be discovered by a broken export lane.
 */

import { executeStatement } from "./client";
import { readSnowflakeConfig } from "./config";
import { LOAD_STAMP_COL, MIRROR_TABLES } from "./export-core";
import { log } from "@/lib/log";

export interface SnowflakeHealth {
  ok: boolean;
  /** False when SNOWFLAKE_PRIVATE_KEY is unset (mirror not provisioned yet). */
  configured: boolean;
  /** The role the login resolved to (expected: SLATE_ROLE). */
  role?: string;
  /** The warehouse the login resolved to (expected: SLATE_WH). */
  warehouse?: string;
  error?: string;
  elapsedMs?: number;
  /** Mirror tables whose live DDL lacks the `exported_at` load stamp the MERGE
   *  always writes. Non-empty means the export lane cannot write those tables. */
  missingLoadStamp?: string[];
}

export async function runSnowflakeHealthcheck(): Promise<SnowflakeHealth> {
  const config = readSnowflakeConfig();
  if (!config) {
    return { ok: false, configured: false, error: "SNOWFLAKE_PRIVATE_KEY not set" };
  }

  const start = Date.now();
  try {
    const res = await executeStatement(config, "SELECT CURRENT_ROLE() AS role, CURRENT_WAREHOUSE() AS warehouse");
    const row = res.data?.[0];
    const role = row?.[0] != null ? String(row[0]) : undefined;
    const warehouse = row?.[1] != null ? String(row[1]) : undefined;

    const missingLoadStamp = await findTablesMissingLoadStamp(config);
    const elapsedMs = Date.now() - start;

    if (missingLoadStamp.length > 0) {
      const error =
        `mirror tables missing the ${LOAD_STAMP_COL} column, so every export of them fails: ` +
        missingLoadStamp.join(", ");
      log.error("snowflake-check", { msg: "mirror schema incomplete", tables: missingLoadStamp.join(","), ms: elapsedMs });
      return { ok: false, configured: true, role, warehouse, elapsedMs, error, missingLoadStamp };
    }

    log.info("snowflake-check", { msg: "ok", role: role ?? null, warehouse: warehouse ?? null, ms: elapsedMs });
    return { ok: true, configured: true, role, warehouse, elapsedMs, missingLoadStamp };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error("snowflake-check", { msg: "failed", ms: Date.now() - start }, e instanceof Error ? e : undefined);
    return { ok: false, configured: true, error, elapsedMs: Date.now() - start };
  }
}

/**
 * Which mirror tables the live warehouse does NOT declare the load stamp on.
 * Snowflake upper-cases unquoted identifiers, so both sides are compared
 * upper-cased. The schema and column travel as bindings rather than being
 * interpolated into the statement. A probe that returns nothing yields "all
 * missing", never "all fine": an empty result here is a failure signal, not an
 * absence of problems.
 */
async function findTablesMissingLoadStamp(
  config: Parameters<typeof executeStatement>[0],
): Promise<string[]> {
  const res = await executeStatement(
    config,
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = ?",
    [config.schema.toUpperCase(), LOAD_STAMP_COL.toUpperCase()],
  );
  const stamped = new Set((res.data ?? []).map((r) => String(r[0]).toUpperCase()));
  return MIRROR_TABLES.filter((t) => !stamped.has(t.table.toUpperCase())).map((t) => t.table);
}
