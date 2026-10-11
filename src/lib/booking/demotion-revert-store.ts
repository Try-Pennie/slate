/**
 * The database side of moving a rerouted call back (#3615). The decisions live in
 * `demotion-revert.ts`; this only reads and writes, and every read fails loud (`unwrap`), so a
 * failed read is never mistaken for "this call was never moved" (L184).
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import {
  demotionMoveFromRow,
  demotionMoveView,
  latestDemotionMove,
  type DemotionMoveRecord,
  type DemotionMoveRow,
  type DemotionMoveView,
} from "@/lib/booking/demotion-revert";

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

/**
 * What the booking page shows about an automatic move of this call (#3615), or null when no
 * demotion sweep moved it. Throws on a read it could not make, so the page can say it could not
 * check rather than hiding the undo (L10).
 */
export async function loadDemotionMoveView(
  booking: { id: string; status: string; assigned_user_id: string | null; starts_at: string },
  orgId: string,
): Promise<DemotionMoveView | null> {
  const move = latestDemotionMove(await loadDemotionMoves(booking.id, orgId));
  if (!move) return null;
  const ids = [move.outUserId, move.toUserId, move.revertedBy].filter((x): x is string => typeof x === "string");
  const people = unwrap(
    // cap-safe: at most three users, by primary key.
    await supabaseAdmin().from("users").select("id, name, email, deactivated_at").in("id", ids),
    "demotion move people",
  ) as { id: string; name: string | null; email: string | null; deactivated_at: string | null }[] | null;
  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  return demotionMoveView({
    move,
    booking,
    original: byId.get(move.outUserId) ?? null,
    nowMs: Date.now(),
    nameOf: (uid) => (uid ? (byId.get(uid)?.name ?? byId.get(uid)?.email ?? "another advisor") : "someone"),
  });
}
