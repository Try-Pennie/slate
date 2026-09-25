import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import type { RecentBooking } from "@/lib/monitor/offsite-origin";

/**
 * The read behind the off site origin check (#2715), kept out of the monitor route
 * so the column list is in one testable place.
 *
 * Every ACTIVE booking created since `sinceIso` in the given (real) buckets, every
 * page. THROWS on a read error through `selectAllPages`: a short list would read as
 * "nothing came from off site", which is the answer this check exists to give.
 * Cancelled bookings are left out, because the page's whole remedy is cancelling.
 */
export async function loadRecentBookingsInBuckets(
  db: ReturnType<typeof supabaseAdmin>,
  bucketIds: string[],
  sinceIso: string,
): Promise<RecentBooking[]> {
  if (bucketIds.length === 0) return [];
  return selectAllPages<RecentBooking>("monitor offsite origin bookings", (from, to) =>
    db
      .from("bookings")
      .select("id, bucket_id, starts_at, agent_name, agent_email, prefill, referrer_origin")
      // in-chunk-ok: the real buckets are the routing matrix, sixty codes at the
      // design target, about 2,300 bytes of uuids against the 10,000 budget.
      .in("bucket_id", bucketIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("created_at", sinceIso)
      .order("id")
      .range(from, to) as unknown as PromiseLike<{
      data: unknown[] | null;
      error?: { message: string } | null;
    }>,
  );
}
