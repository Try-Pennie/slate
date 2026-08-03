import { selectAllPages } from "@/lib/supabase/paginate";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Which of `userIds` have APPROVED time off overlapping [startIso, endIso) (#1236).
 *
 * This exists because coverage selection cannot answer the question from anything
 * it already reads. Freeness there is LIVE Google only, deliberately never
 * `busy_blocks`, so an agent on approved leave is excluded only as a side effect of
 * `runPostApproval` having successfully written an event to their calendar. That
 * write is best-effort by design: when it fails the OOO flow falls back to a
 * slate-source busy block, which availability can see and coverage selection
 * cannot. `ooo_requests` is the only signal that does not depend on Google having
 * accepted anything, which is what makes it the right one to gate a placement on.
 *
 * Overlap is half-open on both sides (`starts_at < endIso AND ends_at > startIso`),
 * so time off that merely abuts the booking does not exclude an agent: a window
 * ending exactly when the appointment starts leaves them free for it.
 *
 * THROWS on a read error, deliberately. The caller
 * (`selectCoverageReassignTarget`) turns that into a retry, because the one thing
 * that must never happen here is a booking placed on an agent whose absence we
 * could not check. An empty result on a failed read would be indistinguishable
 * from "nobody is away", which is the exact shape of #277 / #1152.
 */
export async function userIdsOnApprovedTimeOff(
  userIds: string[],
  startIso: string,
  endIso: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await selectAllPages<{ user_id: string }>("coverage-approved-time-off", (from, to) =>
    supabaseAdmin()
      // cap-safe: read every page via selectAllPages (.range below). `ooo_requests`
      // is a growth table and correctly NOT in SAFE_TABLES: one agent accumulates
      // requests over time, so a roster-sized `in` filter is not by itself a bound.
      .from("ooo_requests")
      .select("user_id")
      .in("user_id", userIds)
      .eq("status", "approved")
      .lt("starts_at", endIso)
      .gt("ends_at", startIso)
      .range(from, to),
  );
  return new Set(rows.map((r) => r.user_id));
}
