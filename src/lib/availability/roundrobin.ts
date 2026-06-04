/**
 * Least-recently-booked round-robin ordering (pure).
 *
 * Replaces the old mutable `rr_last_assigned_user_id` pointer: instead of
 * rotating after a stored pointer (racy under concurrency, and skewed by
 * reschedules), we order candidates by when each was last booked and pick the
 * one booked longest ago. An agent with no prior booking sorts first (most
 * "stale"). Ties break deterministically by id so concurrent callers see the
 * same order. The caller supplies each candidate's last-booked timestamp
 * (newest active booking's `created_at`, in ms); missing/null means never booked.
 */
export function orderByLeastRecentlyBooked(
  candidateIds: string[],
  lastBookedAtMs: Record<string, number | null>,
): string[] {
  return [...candidateIds].sort((a, b) => {
    const ta = lastBookedAtMs[a] ?? Number.NEGATIVE_INFINITY;
    const tb = lastBookedAtMs[b] ?? Number.NEGATIVE_INFINITY;
    // NaN-safe: only subtract when the two differ; equal (incl. both -Infinity)
    // falls through to the deterministic id tiebreak.
    if (ta !== tb) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
