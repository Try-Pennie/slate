import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";

/**
 * The upcoming calls still held by agents who have approved time off, for the OOO
 * coverage gap check (#1237).
 *
 * Lifted out of the monitor route by #2369 so it can be tested at all. It filtered
 * `bookings` on an `is_test` column that does not exist (migration 0051 put the flag
 * on `users` and `buckets`), so PostgREST answered 42703, `selectAllPages` threw, and
 * **this check has never once run**. Nothing said so: a column list is a string, the
 * whole read sat inline in a 2,000 line handler, and no test could reach it.
 *
 * Two things it must do, and the reason each is here rather than in the caller:
 *
 *  - **Every page.** An agent with a long absence can hold more than one page of
 *    upcoming bookings, and a truncated page under-reports the gap.
 *  - **Exclude the smoke canary through the BUCKET.** Test-ness is a property of the
 *    bucket (#396), which is why this is an inner join with an embedded filter rather
 *    than a column predicate, the same shape `countCustomerBookingsSince` uses. A
 *    monitor that counted the canary would be measuring Slate against itself for ever
 *    (#1291).
 *
 * It throws on a read error, through `selectAllPages`: a short list would under-report
 * the gap, which is the direction that leaves a lead stranded and says nothing.
 */
export interface OooCoverageBooking {
  id: string;
  assigned_user_id: string;
  starts_at: string;
  ends_at: string;
}

export async function loadOooCoverageBookings(
  db: ReturnType<typeof supabaseAdmin>,
  userIds: string[],
  nowIso: string,
): Promise<OooCoverageBooking[]> {
  if (userIds.length === 0) return [];
  return selectAllPages<OooCoverageBooking>("monitor ooo coverage bookings", (from, to) =>
    db
      .from("bookings")
      .select("id, assigned_user_id, starts_at, ends_at, buckets!inner(is_test)")
      .eq("buckets.is_test", false)
      .in("assigned_user_id", userIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      // `ends_at`, NOT `starts_at`. The straddler begins before the absence and runs
      // into it, so flooring on the start is the exact miss this check exists to
      // catch, and a prefilter that repeats it would hide it again (#1237).
      .gte("ends_at", nowIso)
      .range(from, to) as unknown as PromiseLike<{
      data: unknown[] | null;
      error?: { message: string } | null;
    }>,
  );
}
