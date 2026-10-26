import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
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
  return selectAllPages<OooCoverageBooking>("monitor ooo coverage bookings", "id", () =>
    db
      // agent-link-ok: a call booked through an agent's own link is still a call
      // somebody has to take during their absence, so it needs covering like any
      // other (#2073).
      .from("bookings")
      .select("id, assigned_user_id, starts_at, ends_at, buckets!inner(is_test)")
      .eq("buckets.is_test", false)
      .in("assigned_user_id", userIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      // `ends_at`, NOT `starts_at`. The straddler begins before the absence and runs
      // into it, so flooring on the start is the exact miss this check exists to
      // catch, and a prefilter that repeats it would hide it again (#1237).
      .gte("ends_at", nowIso) as unknown as PageableQuery,
  );
}

/**
 * Which of those bookings already carry a coverage sweep row, in whatever number of
 * requests that takes (#2388).
 *
 * Any status counts: a row means #1242 owns the outcome, so the coverage check says
 * nothing about that booking.
 *
 * Lifted out of the monitor route alongside its sibling above, because it carried
 * the defect that sibling's own lifting was meant to make visible. It put EVERY
 * booking id into one `.in("booking_id", ...)` filter, over a list read with
 * `selectAllPages` precisely because it is expected to exceed a page. PostgREST puts
 * an `in` filter in the QUERY STRING, so past roughly 266 uuids the request is
 * REFUSED at the transport rather than truncated, and the whole check then throws on
 * every five minute tick, silently, for exactly the agents it exists to protect.
 * Measured on 2026-08-31, 24 agents with approved time off holding fifteen upcoming
 * calls each is 360 ids, already past that point.
 *
 * It answers a SET, because every caller asks whether one booking is in it and a
 * union is the only shape that survives being assembled from several requests.
 *
 * It throws on a read error, through `selectAllPages` and `inIdChunks`: an empty
 * or short answer here means "no sweep has touched these", which reads as a real
 * coverage gap and pages about a sweep that is working.
 */
export async function loadSnapshottedBookingIds(
  db: ReturnType<typeof supabaseAdmin>,
  bookingIds: string[],
): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  const pages = await inIdChunks("monitor ooo coverage snapshotted", bookingIds, (batch) =>
    selectAllPages<{ booking_id: string }>("monitor ooo coverage snapshotted", "id", () =>
      db
        .from("bulk_reassign_items")
        .select("id, booking_id")
        .in("booking_id", batch),
    ),
  );
  return new Set(pages.flat().map((r) => r.booking_id));
}
