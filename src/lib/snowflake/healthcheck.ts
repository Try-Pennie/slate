/**
 * Snowflake connectivity smoke check (#1110).
 *
 * Signs a real key-pair JWT with the Worker's SNOWFLAKE_PRIVATE_KEY and runs a
 * trivial query, so we can confirm end to end that the account identifier, host,
 * key-pair, and grants all line up, the one thing only a live call can prove.
 * Fails loud (returns a not-ok result and logs) rather than throwing, so a caller
 * can render or alert on it. Reused by the Phase 5 reconciliation lane.
 */

import { executeStatement } from "./client";
import { readSnowflakeConfig } from "./config";
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
    const elapsedMs = Date.now() - start;
    log.info("snowflake-check", { msg: "ok", role: role ?? null, warehouse: warehouse ?? null, ms: elapsedMs });
    return { ok: true, configured: true, role, warehouse, elapsedMs };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error("snowflake-check", { msg: "failed", ms: Date.now() - start }, e instanceof Error ? e : undefined);
    return { ok: false, configured: true, error, elapsedMs: Date.now() - start };
  }
}
