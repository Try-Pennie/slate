import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { RecentOwnerAlert } from "@/lib/monitor/owner-alert-skips";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The IO half of the owner alert skip share (#2436): the owner alerts written since
 * `sinceIso`, at most `limit`, with only the two columns the judgement reads.
 *
 * `owner_alert_events` is a growth table, so the read is bounded (`.limit`); the
 * caller treats a read that fills it as truncated rather than as the whole week.
 * THROWS on a failed read (`unwrap`): an empty answer would read as a week with no
 * skips, which is the healthy answer at exactly the moment nothing was measured.
 */
export async function loadRecentOwnerAlerts(db: Db, sinceIso: string, limit: number): Promise<RecentOwnerAlert[]> {
  const rows = (unwrap(
    await db
      .from("owner_alert_events")
      .select("user_id, skip_reason")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(limit),
    "recent owner alerts",
  ) ?? []) as { user_id: string; skip_reason: string | null }[];
  return rows.map((r) => ({ userId: r.user_id, skipReason: r.skip_reason }));
}
