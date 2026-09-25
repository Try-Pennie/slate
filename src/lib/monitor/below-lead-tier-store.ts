import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import type { UpcomingBooking } from "@/lib/monitor/below-lead-tier";

/**
 * The reads behind the below-tier booking check (#2593), kept out of the monitor
 * route so the column lists are in one testable place (#2369 is what an inline
 * column list that names a missing column costs: a check that never once ran).
 *
 * Both THROW on a read error, through `selectAllPages` and `inIdChunks`. A short
 * booking list would clear pages for bookings that are still wrong, and read as a
 * quiet roster.
 */

/**
 * Every upcoming active booking in the given (real) buckets.
 *
 * Test-ness is a property of the BUCKET (#396), so the caller passes the real
 * bucket ids rather than this filtering a `bookings.is_test` that does not exist.
 * `prefill` and `referrer_origin` (#2728) are read for the host page, because a test made in a REAL bucket is
 * recognised by where it was made from (`isTestSourceBooking`, #2737), and that
 * exclusion is the check's own, not this read's.
 * Sixty uuids ride in the URL comfortably (200 measured safe, #1321). Every page,
 * because at cutover the upcoming set is in the low thousands.
 */
export async function loadUpcomingBookingsInBuckets(
  db: ReturnType<typeof supabaseAdmin>,
  bucketIds: string[],
  nowIso: string,
): Promise<UpcomingBooking[]> {
  if (bucketIds.length === 0) return [];
  return selectAllPages<UpcomingBooking>("monitor below lead tier bookings", (from, to) =>
    db
      .from("bookings")
      .select("id, bucket_id, starts_at, salesforce_id, external_id, agent_name, agent_email, prefill, referrer_origin")
      .in("bucket_id", bucketIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("starts_at", nowIso)
      .order("id")
      .range(from, to) as unknown as PromiseLike<{
      data: unknown[] | null;
      error?: { message: string } | null;
    }>,
  );
}

/**
 * `catchall_applied` per booking, from the routing decision that booked it.
 *
 * Asked only about the bookings being paged about, so it is a handful of ids. A
 * booking made without a routing decision (a direct booking API call, an admin
 * booking) has no row and is simply absent: the page says it is not recorded.
 */
export async function loadCatchallByBooking(
  db: ReturnType<typeof supabaseAdmin>,
  bookingIds: string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (bookingIds.length === 0) return out;
  const pages = await inIdChunks("monitor below lead tier catch-all", bookingIds, (batch) =>
    selectAllPages<{ booking_id: string; catchall_applied: boolean }>(
      "monitor below lead tier catch-all",
      (from, to) =>
        db
          .from("routing_decisions")
          .select("booking_id, catchall_applied")
          .in("booking_id", batch)
          .range(from, to) as unknown as PromiseLike<{
          data: unknown[] | null;
          error?: { message: string } | null;
        }>,
    ),
  );
  for (const rows of pages) {
    for (const r of rows) out.set(r.booking_id, out.get(r.booking_id) === true || r.catchall_applied);
  }
  return out;
}
