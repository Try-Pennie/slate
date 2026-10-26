import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, sortByStamp, type PageableQuery } from "@/lib/supabase/paginate";
import { unwrapCount } from "@/lib/db/result";
import {
  TIER_DROP_WINDOW_DAYS,
  countTierDrops,
  type TierDropCounts,
  type TierDropRow,
} from "@/lib/routing/tier-drop-counts";

const DAY_MS = 86_400_000;

export interface TierDropReport {
  counts: TierDropCounts;
  /** Every routed booking in the same population and window, so a count reads as a share. */
  booked: { week: number; month: number };
}

/**
 * The reads behind the tier drop panel on /admin/routing (2026-10-02).
 *
 * The drops and the totals beside them are ONE population (L629): routed bookings
 * in a real bucket, created inside the window, whatever their status since. A
 * drop that was later cancelled still happened at confirm. Test-ness is a
 * property of the bucket (#396), so both go through the same bucket join.
 *
 * THROWS on any read error, through `selectAllPages` and `unwrapCount`: a short
 * list would draw "no drops" off a read that failed, which is the answer this
 * panel exists to give (#1629).
 */
export async function loadTierDropReport(
  db: ReturnType<typeof supabaseAdmin>,
  orgId: string,
  nowMs: number,
): Promise<TierDropReport> {
  const since = (days: number) => new Date(nowMs - days * DAY_MS).toISOString();
  const routedSince = (days: number) =>
    db
      .from("bookings")
      .select("id, buckets!inner(is_test)", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("buckets.is_test", false)
      .eq("kind", "routed")
      .gte("created_at", since(days));

  const [rows, weekRes, monthRes] = await Promise.all([
    selectAllPages<TierDropRow>("admin tier drops", "id", () =>
      db
        .from("bookings")
        .select("id, created_at, routing_trace, buckets!inner(is_test)")
        .eq("org_id", orgId)
        .eq("buckets.is_test", false)
        .eq("kind", "routed")
        .eq("routing_trace->>tier_fallback", "true")
        .gte("created_at", since(TIER_DROP_WINDOW_DAYS.month)) as unknown as PageableQuery,
    ).then((r) => sortByStamp("admin tier drops", r, "created_at", "id", "desc")),
    routedSince(TIER_DROP_WINDOW_DAYS.week),
    routedSince(TIER_DROP_WINDOW_DAYS.month),
  ]);

  return {
    counts: countTierDrops(rows, nowMs),
    booked: {
      week: unwrapCount(weekRes, "admin tier drops routed bookings 7 days"),
      month: unwrapCount(monthRes, "admin tier drops routed bookings 30 days"),
    },
  };
}
