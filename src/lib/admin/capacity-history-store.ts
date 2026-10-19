/**
 * The database side of Team capacity history (#3940): the cursor, the calls already saved, the
 * tick's one write, and a past day read back for the page. The rules are capacity-history.ts.
 *
 * Every read throws on failure rather than answering empty: an empty record of saved calls would
 * pack the day from nothing and save calls twice, and an empty past day would draw a team with
 * nobody in it.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { selectAllPages } from "@/lib/supabase/paginate";
import { historyAdvisor, historyKey, type HistoryRow } from "./capacity-history";
import type { TeamCapacityAdvisor } from "./team-capacity";

/** Where the org's last tick stopped, or null before the first. */
export async function readHistoryCursor(orgId: string): Promise<number | null> {
  const row = unwrap(
    await supabaseAdmin().from("capacity_history_cursor").select("recorded_through").eq("org_id", orgId).maybeSingle(),
    "capacity history cursor",
  ) as { recorded_through: string } | null;
  if (row === null) return null;
  const ms = Date.parse(row.recorded_through);
  if (!Number.isFinite(ms)) throw new Error(`capacity history cursor is unreadable: "${row.recorded_through}"`);
  return ms;
}

type SavedRow = Pick<HistoryRow, "user_id" | "day" | "open_times">;

/** The calls already saved on these days for the org's advisors, by `historyKey`. */
export async function readSavedCalls(orgId: string, days: string[]): Promise<Map<string, string[]>> {
  const db = supabaseAdmin();
  // At most three days a tick, each one row per advisor, so this is a few hundred rows; it pages
  // anyway because the table grows for good.
  const rows = await selectAllPages<SavedRow>("capacity history saved calls", ["user_id", "day"], () =>
    db
      .from("capacity_history")
      .select("user_id, day, open_times, users!inner(org_id)")
      .eq("users.org_id", orgId)
      .in("day", days),
  );
  return new Map(rows.map((r) => [historyKey(r.user_id, r.day), r.open_times]));
}

/** One tick's rows and the cursor, in one transaction. Returns the rows written. */
export async function writeHistory(orgId: string, rows: HistoryRow[], throughMs: number): Promise<number> {
  const written = unwrap(
    await supabaseAdmin().rpc("record_capacity_history", {
      p_org: orgId,
      p_rows: rows,
      p_through: new Date(throughMs).toISOString(),
    }),
    "record capacity history",
  );
  if (typeof written !== "number") throw new Error("record_capacity_history returned no row count");
  return written;
}

/** A past office day as it was saved, one advisor each, ordered by name like a coming day. */
export async function loadCapacityHistoryDay(orgId: string, day: string): Promise<TeamCapacityAdvisor[]> {
  const db = supabaseAdmin();
  const rows = await selectAllPages<HistoryRow & { users: { name: string | null; email: string } }>(
    "capacity history day",
    ["user_id", "day"],
    () =>
      db
        .from("capacity_history")
        .select("user_id, day, timezone, capacity, open_times, is_out, no_shift, unsynced, shift_start, shift_end, time_off, users!inner(name, email, org_id)")
        .eq("users.org_id", orgId)
        .eq("day", day),
  );
  return rows
    .map(({ users, ...row }) => historyAdvisor({ ...row, name: users.name, email: users.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
