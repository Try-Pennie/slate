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
/**
 * Apply a bucket's fallback: if the matched pool is non-empty use it; otherwise
 * route to the fallback agent when one is set AND eligible (the cal "default
 * route" analog). `fallbackEligible` must be the caller's verdict on whether the
 * fallback agent is currently routable (bookable and not deactivated) — a stored
 * `fallback_user_id` can point at an agent who has since been turned off or
 * offboarded, and we must never hand a booking to such an agent.
 * `fallbackApplied` records which branch was taken (for the routing trace).
 */
export function applyFallback(
  matched: string[],
  fallbackUserId: string | null,
  fallbackEligible: boolean,
): { ids: string[]; fallbackApplied: boolean } {
  if (matched.length > 0) return { ids: matched, fallbackApplied: false };
  if (fallbackUserId && fallbackEligible) return { ids: [fallbackUserId], fallbackApplied: true };
  return { ids: [], fallbackApplied: false };
}

/**
 * Reduce a bookings read into each agent's newest-active-booking timestamp (ms),
 * the input to orderByLeastRecentlyBooked. Pure; mirrors the Supabase result
 * shape so it's node-testable.
 *
 * This read is FAIRNESS-only — it decides the ORDER agents are offered, not who
 * is available. A booking must always go through (#277, user rule), so an
 * errored read does NOT throw: it returns an empty map (everyone treated as
 * never-booked → a valid, if not strictly fair, order) and flags `degraded` so
 * the caller can fire a "possibly unfair assignment" alert instead of failing
 * the booking.
 */
export function lastBookedFromResult(res: {
  data: { assigned_user_id: string | null; created_at: string }[] | null;
  error: unknown;
}): { lastBookedAtMs: Record<string, number | null>; degraded: boolean } {
  if (res.error) return { lastBookedAtMs: {}, degraded: true };
  const lastBookedAtMs: Record<string, number | null> = {};
  for (const r of res.data ?? []) {
    if (r.assigned_user_id == null) continue;
    const t = Date.parse(r.created_at);
    const prev = lastBookedAtMs[r.assigned_user_id];
    if (prev == null || t > prev) lastBookedAtMs[r.assigned_user_id] = t;
  }
  return { lastBookedAtMs, degraded: false };
}

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
