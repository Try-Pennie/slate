/**
 * The IO half of the top tier cascade count (#2843), kept out of
 * `top-tier-cascade.ts` so that module stays node-testable with no `@/` imports.
 *
 * EVERY READ THROWS ON ERROR (`unwrapCount`): `count ?? 0` would turn a failed
 * count into a healthy looking zero, and the caller reports the tick as unmeasured
 * instead, because an unreadable count is not a day with no cascades.
 *
 * `routing_decisions.requested_code` is the code the lead's link carried and
 * `bucket_code` is where the booking landed, so a cascade is "requested in a top
 * tier, booked in a lower one". Only rows that produced a booking are counted, and
 * the smoke canary is excluded through the bucket's own `is_test` (#1258).
 *
 * COST. Four server side counts per tick, no rows returned, on the invocation four
 * cron lanes share. If that budget needs trimming, a 24 hour count read every five
 * minutes to feed a notice that speaks once a day is an obvious one to slow down.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import {
  CASCADE_CODES_BELOW,
  TOP_TIER_CASCADE_WINDOW_HOURS,
  TOP_TIER_CODES,
  type TopTierCascadeWindow,
} from "@/lib/monitor/top-tier-cascade";

export async function readTopTierCascadeWindow(nowMs: number): Promise<TopTierCascadeWindow> {
  const since = new Date(nowMs - TOP_TIER_CASCADE_WINDOW_HOURS * 3600_000).toISOString();
  const db = supabaseAdmin();
  const booked = (requested: string[]) =>
    db
      .from("routing_decisions")
      .select("id, buckets!inner(is_test)", { count: "exact", head: true })
      .eq("buckets.is_test", false)
      .eq("outcome", "booked")
      .in("requested_code", requested)
      .gte("created_at", since);

  const [ultraBooked, ultraCascaded, veryHighBooked, veryHighCascaded] = await Promise.all([
    booked(TOP_TIER_CODES.ultra_high),
    booked(TOP_TIER_CODES.ultra_high).in("bucket_code", CASCADE_CODES_BELOW.ultra_high),
    booked(TOP_TIER_CODES.very_high),
    booked(TOP_TIER_CODES.very_high).in("bucket_code", CASCADE_CODES_BELOW.very_high),
  ]);

  return {
    ultraBooked: unwrapCount(ultraBooked, "routing_decisions ultra high booked"),
    ultraCascaded: unwrapCount(ultraCascaded, "routing_decisions ultra high cascaded"),
    veryHighBooked: unwrapCount(veryHighBooked, "routing_decisions very high booked"),
    veryHighCascaded: unwrapCount(veryHighCascaded, "routing_decisions very high cascaded"),
    windowHours: TOP_TIER_CASCADE_WINDOW_HOURS,
  };
}
