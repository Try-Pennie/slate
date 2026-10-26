import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import type { RoutingRecord, UpcomingBooking } from "@/lib/monitor/below-lead-tier";

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
  return selectAllPages<UpcomingBooking>("monitor below lead tier bookings", "id", () =>
    db
      .from("bookings")
      .select("id, bucket_id, starts_at, salesforce_id, external_id, agent_name, agent_email, prefill, referrer_origin")
      .in("bucket_id", bucketIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      // #2073: a booking through an agent's own link was booked with the agent the
      // lead already has, not routed below their tier.
      .eq("kind", "routed")
      .gte("starts_at", nowIso) as unknown as PageableQuery,
  );
}

/**
 * What the routing record says about each booking: whether the catch-all chose
 * the pool, the code the lead's link ARRIVED with (`requested_code`, #1908), and
 * whether confirm dropped down the tier ladder and how far (`tier_fallback`,
 * `rungs_dropped`), which is what tells a designed drop from a fault (2026-10-02).
 *
 * The arrival code is what answers #2594: a lead who arrived on 422 and whom
 * Salesforce scores 512 today was re-scored AFTER the link was made, while one
 * who arrived on 512 and sits in a lower pool was routed below its own code.
 * Those send somebody to two different places, so the page must not guess.
 *
 * Asked only about the bookings being paged about, so it is a handful of ids. A
 * booking made without a routing decision (a direct booking API call, an admin
 * booking) has no row and is simply absent: the page says it is not recorded.
 * When a booking has several decisions, BOTH facts come from the NEWEST one,
 * since that is the one that placed the call where it sits. Taking the flag from
 * any older decision would blame the catch-all for a call a later decision routed
 * properly, and pair it with an arrival code it never saw. Newest is judged on
 * created_at and then id, so a tie resolves the same way whatever order the rows
 * arrive in, and the paged read is ordered on the same pair so Postgres cannot
 * skip or repeat a row between pages.
 */
export async function loadRoutingContextByBooking(
  db: ReturnType<typeof supabaseAdmin>,
  bookingIds: string[],
): Promise<Map<string, RoutingRecord>> {
  const out = new Map<string, RoutingRecord>();
  if (bookingIds.length === 0) return out;
  const pages = await inIdChunks("monitor below lead tier routing", bookingIds, (batch) =>
    selectAllPages<{
      id: string;
      booking_id: string;
      catchall_applied: boolean;
      requested_code: string | null;
      tier_fallback: boolean;
      rungs_dropped: number;
      created_at: string;
    }>("monitor below lead tier routing", "id", () =>
      db
        .from("routing_decisions")
        .select("id, booking_id, catchall_applied, requested_code, tier_fallback, rungs_dropped, created_at")
        .in("booking_id", batch) as unknown as PageableQuery,
    ),
  );
  const newest = new Map<string, { createdAt: string; id: string }>();
  for (const rows of pages) {
    for (const r of rows) {
      const prev = newest.get(r.booking_id);
      const isNewer =
        prev === undefined ||
        r.created_at > prev.createdAt ||
        (r.created_at === prev.createdAt && r.id > prev.id);
      if (!isNewer) continue;
      newest.set(r.booking_id, { createdAt: r.created_at, id: r.id });
      out.set(r.booking_id, {
        catchall: r.catchall_applied,
        requestedCode: r.requested_code,
        tierFallback: r.tier_fallback,
        rungsDropped: r.rungs_dropped,
      });
    }
  }
  return out;
}
