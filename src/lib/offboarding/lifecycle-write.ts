/**
 * What a deactivation and a reactivation WRITE, in one place (#1324, #2386).
 *
 * ## The rule
 *
 * Leaving the pool sets `deactivated_at` AND clears `bookable`, in ONE statement.
 * Two statements can fail independently and leave the row half changed, out of the
 * pool by one column and in it by the other.
 *
 * Routing already requires `deactivated_at is null`, so this is not a routing fix
 * on the day somebody leaves. It matters for two other reasons:
 *
 *   - every COUNT of the bookable pool is right without each reader remembering to
 *     filter on both columns, a workaround #1297's coverage readout already carried;
 *   - re-entry to the pool goes through the ACTIVATION GATE. The calendar
 *     reachability probe and the pool entry bootstrap (`applyBookableByUserId`,
 *     `onboardIntoPool`) live only on the `bookable` FLIP, so a row that never
 *     stopped being bookable can be reactivated straight back into routing with no
 *     probe, no bootstrap and an empty availability cache. Dan's rule, 2026-09-14:
 *     no agent is bookable until every one of their calendars READS.
 *
 * Reactivation therefore writes `bookable: false` as well, which is NOT the same as
 * "does not restore it": it actively CLEARS a flag left behind by a write that
 * predates this rule. Clearing rather than refusing, because refusing would leave an
 * admin pressing the only control the page offers against a row nothing short of SQL
 * could repair (L111), and the harm is fully prevented either way. The caller says so
 * out loud when it had to clear one, so the repair is not silent.
 *
 * ## Why this module exists rather than the field being written twice
 *
 * It already WAS written twice. #1324 fixed the offboarding path; the Salesforce
 * reap kept its own `update({ deactivated_at })` for another six weeks and left every
 * leaver it processed carrying the flag. Sharing the patch alone would repeat that
 * (L370: sharing a rule's data while copying the code that applies it is not
 * consolidation), so the reap's whole write lives here too, and
 * `scripts/test-deactivation-write.ts` fails the build on a third copy appearing
 * anywhere in `src/` (L613).
 *
 * The two callers' QUERIES legitimately differ and stay with their callers: the
 * lifecycle service writes one row as a compare and swap and reads it back, the reap
 * writes a batch of ids. What may not differ is which columns a departure moves.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";

/** The columns a departure moves. `stampIso` is when they left. */
export function deactivationPatch(stampIso: string): {
  deactivated_at: string;
  bookable: false;
} {
  return { deactivated_at: stampIso, bookable: false };
}

/** The columns a return moves. See the header for why `bookable` is here. */
export function reactivationPatch(): { deactivated_at: null; bookable: false } {
  return { deactivated_at: null, bookable: false };
}

/**
 * Depart a batch of users by id, for the hourly Salesforce reap.
 *
 * FAILS LOUD. The reap used to discard this statement's result, so a refused
 * deactivation reported `deactivated: N` and the lane reported a clean hour while
 * the leaver stayed in the roster (L12, L98). The run is idempotent and the reap
 * re-selects its candidates every hour, so throwing costs one retry and never a
 * lost departure.
 *
 * The `deactivated_at is null` filter is a compare and swap over the batch, matching
 * the single row write in `service.ts`: the candidate read and this write are two
 * statements, and somebody deactivated in the gap must keep the stamp that records
 * when they actually left rather than having it rewritten by this run.
 *
 * It deliberately does NOT revoke sessions or enqueue a coverage sweep. Those are
 * #2459 and #1678, which route the reap through the full lifecycle path and own the
 * per user cost that brings to a cron lane; this is only the write.
 */
export async function deactivateUsersByIds(
  userIds: string[],
  stampIso: string,
): Promise<void> {
  if (!userIds.length) return;
  const { error } = await supabaseAdmin()
    .from("users")
    .update(deactivationPatch(stampIso))
    .in("id", userIds)
    .is("deactivated_at", null);
  if (error) {
    throw new Error(
      `reap deactivation failed for ${userIds.length} user(s): ${error.message}`,
    );
  }
}
