import { selectAllPages } from "@/lib/supabase/paginate";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseStampMs } from "@/lib/date/stamp";

/**
 * Which of `userIds` have APPROVED time off overlapping [startIso, endIso) (#1236).
 *
 * This exists because coverage selection cannot trust the calendar for it. Its
 * search (Reroute's, #3308) sees approved leave only as the calendar shows it: the
 * event `runPostApproval` writes, or the slate-source busy block it falls back to
 * when Google refuses, and either can lag the approval or be missing outright.
 * `ooo_requests` is the only signal that does not depend on Google having accepted
 * anything, which is what makes it the right one to gate a placement on.
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
  const rows = await selectAllPages<{ user_id: string }>("coverage-approved-time-off", "id", () =>
    supabaseAdmin()
      // cap-safe: read every page via selectAllPages, which orders and pages it. `ooo_requests`
      // is a growth table and correctly NOT in SAFE_TABLES: one agent accumulates
      // requests over time, so a roster-sized `in` filter is not by itself a bound.
      .from("ooo_requests")
      .select("user_id")
      .in("user_id", userIds)
      .eq("status", "approved")
      .lt("starts_at", endIso)
      .gt("ends_at", startIso),
  );
  return new Set(rows.map((r) => r.user_id));
}

/**
 * Approved time off overlapping [startIso, endIso), per agent, as absolute
 * intervals (#1582): the availability grid judges each HOUR of a fortnight, so
 * it needs the whole interval, not the point-in-time set above. Same table,
 * same half-open overlap convention, one home for both readers.
 *
 * THROWS on a read error, like its sibling: the grid renders an unreadable
 * leave read as "could not check", because rendering it as fully staffed is
 * the exact defect (#1582) this read exists to fix, on the day it matters.
 *
 * A row whose stored bound cannot be parsed is scored as away for the WHOLE
 * range rather than dropped: the query itself proved the leave overlaps the
 * range, so dropping the row would fail toward overstating staffing (both
 * columns are our own NOT NULL timestamptz, so this is belt and braces).
 */
export async function approvedTimeOffIntervals(
  startIso: string,
  endIso: string,
): Promise<Map<string, { startMs: number; endMs: number }[]>> {
  const rangeStartMs = parseStampMs(startIso);
  const rangeEndMs = parseStampMs(endIso);
  if (rangeStartMs === null || rangeEndMs === null) {
    // The bounds are constructed by the caller, so this is a caller bug, and
    // querying with garbage bounds already returned garbage above it.
    throw new Error(`approvedTimeOffIntervals: unreadable range ${startIso}..${endIso}`);
  }
  const rows = await selectAllPages<{ user_id: string; starts_at: string; ends_at: string }>(
    "grid-approved-time-off",
    "id",
    () =>
      supabaseAdmin()
        // cap-safe: read every page via selectAllPages, which orders and pages it; ooo_requests
        // is a growth table, deliberately not in SAFE_TABLES.
        .from("ooo_requests")
        .select("user_id, starts_at, ends_at")
        .eq("status", "approved")
        .lt("starts_at", endIso)
        .gt("ends_at", startIso),
  );
  const byUser = new Map<string, { startMs: number; endMs: number }[]>();
  for (const r of rows) {
    const startMs = parseStampMs(r.starts_at) ?? rangeStartMs;
    const endMs = parseStampMs(r.ends_at) ?? rangeEndMs;
    const list = byUser.get(r.user_id) ?? [];
    list.push({ startMs, endMs });
    byUser.set(r.user_id, list);
  }
  return byUser;
}
