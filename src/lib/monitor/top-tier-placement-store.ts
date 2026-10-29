/**
 * The reads behind the top tier placement check, kept out of `top-tier-placement.ts`
 * so that module stays node testable with no `@/` imports.
 *
 * EVERY READ THROWS ON ERROR (`selectAllPages`, `unwrap`): an empty list from a failed
 * read would read as a day with no cascades, and the monitor lane records a thrown
 * step as failing instead.
 *
 * `routing_decisions.requested_code` is the code the lead's link carried and
 * `bucket_code` is where the booking landed, so a cascade is "requested in a top tier,
 * booked in a lower one". Only rows that produced a booking are read, and the smoke
 * canary is excluded through the bucket's own `is_test` (#1258).
 *
 * VOLUME. A day's top tier cascades: 1 in 59 top tier bookings on 2026-10-28. Paged
 * anyway, because `routing_decisions` is a growth table and a busy day must not be
 * silently cut at one page.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { unwrap } from "@/lib/db/result";
import {
  CASCADE_CODES_BELOW,
  TOP_TIER_CODES,
  TOP_TIER_PLACEMENT_LOOKBACK_HOURS,
  type PlacementAdvisor,
  type PlacementRow,
} from "@/lib/monitor/top-tier-placement";

/** Every booked top tier cascade made inside the lookback. */
export async function loadTopTierCascades(nowMs: number): Promise<PlacementRow[]> {
  const since = new Date(nowMs - TOP_TIER_PLACEMENT_LOOKBACK_HOURS * 3600_000).toISOString();
  const db = supabaseAdmin();
  const read = (tier: keyof typeof TOP_TIER_CODES) =>
    selectAllPages<PlacementRow & { id: string }>(
      `top tier placements (${tier})`,
      "id",
      () =>
        db
          .from("routing_decisions")
          .select("id, booking_id, requested_code, bucket_code, chosen_user_id, buckets!inner(is_test)")
          .eq("buckets.is_test", false)
          .eq("outcome", "booked")
          .in("requested_code", TOP_TIER_CODES[tier])
          .in("bucket_code", CASCADE_CODES_BELOW[tier])
          .gte("created_at", since) as unknown as PageableQuery,
    );
  const [ultra, veryHigh] = await Promise.all([read("ultra_high"), read("very_high")]);
  return [...ultra, ...veryHigh].map((r) => ({
    booking_id: r.booking_id,
    requested_code: r.requested_code,
    bucket_code: r.bucket_code,
    chosen_user_id: r.chosen_user_id,
  }));
}

/** The advisors the routing chose, with the teams they carry now. */
export async function loadPlacementAdvisors(ids: string[]): Promise<PlacementAdvisor[]> {
  const db = supabaseAdmin();
  const chunks = await inIdChunks("top tier placement advisors", ids, async (chunk) =>
    unwrap(await db.from("users").select("id, name, email, attributes").in("id", chunk), "top tier placement advisors"),
  );
  return chunks.flat() as PlacementAdvisor[];
}
