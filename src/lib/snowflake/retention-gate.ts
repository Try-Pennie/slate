/**
 * Export-aware retention gate (#1102).
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
 *   - mirrorReadyForDeletion(): the whole lane is gated on a passing
 *     reconciliation (#1101), so a delete never runs while the mirror is
 *     unconfigured or out of sync.
 *
 * Scope note (#1102): this covers the true hard-delete of routing_decisions.
 * In-place redactions (bookings PII, webhook payload blanking) are NOT gated
 * here: redacting a row in Supabase would re-export and overwrite the
 * full-fidelity Snowflake copy, so those need the export lane to SKIP redacted
 * rows first. That is folded into the erasure work (#1103); see #1118.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { reconcileSnowflakeMirror } from "./reconcile";

export async function exportedThrough(tableKey: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("export_cursor")
    .select("last_ts")
    .eq("key", tableKey)
    .maybeSingle();
  if (error) throw new Error(`retention-gate cursor ${tableKey}: ${error.message}`);
  return data?.last_ts ?? null;
}

export interface DeletionGate {
  ready: boolean;
  reason: string | null;
}

/**
 * A delete may proceed only when the mirror is configured AND currently in sync.
 * Never delete from Supabase while the warehouse copy is uncertain.
 */
export async function mirrorReadyForDeletion(): Promise<DeletionGate> {
  const recon = await reconcileSnowflakeMirror();
  if (recon.skipped) return { ready: false, reason: "mirror not configured" };
  if (!recon.ok) return { ready: false, reason: recon.reasons.join("; ") };
  return { ready: true, reason: null };
}
