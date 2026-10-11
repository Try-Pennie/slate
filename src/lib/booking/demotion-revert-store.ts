/**
 * The database side of moving a rerouted call back (#3615). The decisions live in
 * `demotion-revert.ts`; this only reads and writes, and every read fails loud (`unwrap`), so a
 * failed read is never mistaken for "this call was never moved" (L184).
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { demotionMoveFromRow, type DemotionMoveRecord, type DemotionMoveRow } from "@/lib/booking/demotion-revert";

/** The demotion moves of one booking, scoped to the org through the sweep that made them. */
export async function loadDemotionMoves(bookingId: string, orgId: string): Promise<DemotionMoveRecord[]> {
  const rows = unwrap(
    // cap-safe: one booking's sweep items, a handful at most (one per sweep that ever held it).
    await supabaseAdmin()
      .from("bulk_reassign_items")
      .select(
        "id, booking_id, status, target_user_id, updated_at, reverted_at, reverted_by, bulk_reassign_jobs!inner(id, org_id, out_user_id, demotion_marked_at, demotion_change)",
      )
      .eq("booking_id", bookingId)
      .eq("bulk_reassign_jobs.org_id", orgId)
      .not("bulk_reassign_jobs.demotion_marked_at", "is", null),
    "demotion moves for a booking",
  ) as DemotionMoveRow[] | null;
  return (rows ?? []).map(demotionMoveFromRow).filter((m): m is DemotionMoveRecord => m !== null);
}

/**
 * Record the undo on the sweep item, as a compare-and-swap on it not being recorded yet: true
 * only for the call that recorded it, so two presses at once write one record and one audit row.
 */
export async function markDemotionMoveReverted(itemId: string, byUserId: string): Promise<boolean> {
  const rows = unwrap(
    await supabaseAdmin()
      .from("bulk_reassign_items")
      .update({ reverted_at: new Date().toISOString(), reverted_by: byUserId })
      .eq("id", itemId)
      .is("reverted_at", null)
      .select("id"),
    "record a moved back demotion reroute",
  ) as { id: string }[] | null;
  return (rows ?? []).length === 1;
}
