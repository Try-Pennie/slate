/**
 * Export-aware retention gate (#1102, regated in #1139).
 *
 * Retention lanes used to delete on AGE alone. This gate makes a delete also
 * require that the rows are safely in the Snowflake mirror first, so we never
 * drop from Supabase something the warehouse does not yet have. Two guards:
 *
 *   - exportedThrough(table): the confirmed-export watermark. A row is safe to
 *     delete only if its watermark column value is at or before this. The export
 *     lane advances this ONLY after a confirmed terminal MERGE (#1099), so it is
 *     a trustworthy "already archived" line. Null = nothing exported yet = delete
 *     nothing.
 *   - mirrorReadyForDeletion(): the whole lane is gated on the export lane
 *     keeping up, so a delete never runs while the mirror is unconfigured or
 *     lagging.
 *
 * WHAT CHANGED IN #1139. This gate used to be a full Supabase-vs-Snowflake row
 * count (`reconcileSnowflakeMirror`), which flags only "Snowflake is behind".
 * That comparison goes structurally negative the moment retention deletes or
 * redacts anything in Supabase, so the gate would have become a rubber stamp
 * exactly when deletion began. It now reads an export-lag signal computed
 * entirely in Supabase (export-lag.ts), which is immune to both pruning and
 * redaction. The row-count reconciliation still runs on its own 6-hourly lane as
 * an independent drift monitor; it is simply no longer the gate.
 *
 * Three things fall out of the gate no longer touching the warehouse: the three
 * daily lanes stop making ~21 avoidable Snowflake round trips and 3 warehouse
 * resumes a day, and none of them holds its 60s lock waiting on a cold-warehouse
 * poll that could outlast it.
 *
 * Scope note (#1102): this covers the true hard-delete of routing_decisions.
 * In-place redactions (bookings PII, webhook payload blanking) are NOT gated
 * here: redacting a row in Supabase would re-export and overwrite the
 * full-fidelity Snowflake copy, so those need the export lane to SKIP redacted
 * rows first. That is folded into the erasure work (#1103); see #1118.
 */

import { readSnowflakeConfig } from "./config";
import { measureExportLag } from "./export-lag";
import { evaluateExportLag } from "./export-lag-core";
import { MIRROR_NOT_CONFIGURED } from "@/lib/notify/misc-alert-copy";

/** The cursor read lives with the lag measurement that shares it; re-exported
 *  here because the three retention lanes read it through this module. */
export { exportedThrough } from "./export-lag";

export interface DeletionGate {
  ready: boolean;
  reason: string | null;
}

/**
 * A delete may proceed only when the mirror is configured AND the export lane
 * is currently keeping up. Never delete from Supabase while the warehouse copy
 * is uncertain.
 *
 * Throws rather than returning not-ready if the measurement itself fails. Both
 * outcomes stop the delete, but a throw also fails the lane loudly (a 500 plus
 * a withheld heartbeat that goes stale and pages), where a quiet not-ready would
 * only look like an ordinary lagging mirror.
 */
export async function mirrorReadyForDeletion(): Promise<DeletionGate> {
  if (!readSnowflakeConfig()) return { ready: false, reason: MIRROR_NOT_CONFIGURED };
  const { ready, reasons } = evaluateExportLag(await measureExportLag());
  return ready ? { ready: true, reason: null } : { ready: false, reason: reasons.join("; ") };
}
