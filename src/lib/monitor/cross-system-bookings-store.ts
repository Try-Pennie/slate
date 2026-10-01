import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { unwrap } from "@/lib/db/result";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import type { SlateUpcomingBooking } from "@/lib/monitor/cross-system-bookings";

/**
 * The Slate half of the cross system double booking check (#2933): every upcoming
 * active booking in a real bucket, both kinds, since a call booked through an
 * advisor's own link is still a call the lead will be on.
 *
 * THROWS on a read error, through `unwrap` and `selectAllPages`. An empty list would
 * read as "nobody holds a Slate booking", which clears every outstanding page.
 * Test-ness is a property of the BUCKET (#396), so the real buckets are read first;
 * sixty ids at the design target ride in the URL comfortably.
 */
export async function loadSlateUpcomingBookings(
  db: ReturnType<typeof supabaseAdmin>,
  nowIso: string,
): Promise<SlateUpcomingBooking[]> {
  const buckets = (unwrap(
    // cap-safe: buckets is roster bounded (about sixty at the design target).
    await db.from("buckets").select("id").eq("is_test", false),
    "monitor cross system real buckets",
  ) ?? []) as { id: string }[];
  if (buckets.length === 0) throw new Error("monitor cross system: no real buckets read, so no booking can be judged");
  return selectAllPages<SlateUpcomingBooking>("monitor cross system bookings", (from, to) =>
    db
      // agent-link-ok: a lead on two calls is the defect whichever kind each is;
      // a call booked through an advisor's own link is still one the lead attends.
      .from("bookings")
      .select("id, starts_at, salesforce_id, external_id, agent_name, agent_email, attendee_email, prefill, referrer_origin")
      // in-chunk-ok: the real buckets are the routing matrix, sixty codes at the
      // design target, about 2,300 bytes of uuids against the 10,000 budget.
      .in("bucket_id", buckets.map((b) => b.id))
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("starts_at", nowIso)
      .order("id")
      .range(from, to) as unknown as PromiseLike<{
      data: unknown[] | null;
      error?: { message: string } | null;
    }>,
  );
}
