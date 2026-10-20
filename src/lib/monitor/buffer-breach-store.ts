import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { unwrap } from "@/lib/db/result";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import {
  bookingsForBufferCheck,
  type BufferBookingRow,
  type BufferedBooking,
} from "@/lib/monitor/buffer-breach";

/**
 * The reads behind the buffer breach check (#3040), kept out of the monitor route so
 * the column lists sit in one place.
 *
 * Every read THROWS on an error, through `unwrap` and `selectAllPages`. A short or
 * empty list would read as "no advisor holds two calls too close", which is the
 * all clear this check must only ever post off a real measurement.
 *
 * Three plain reads rather than an embedded select: event types and buckets are
 * roster bounded and small, and joining them in code makes a booking whose event
 * type was not returned a loud failure rather than a silently null buffer.
 */
export async function loadBookingsForBufferCheck(
  db: ReturnType<typeof supabaseAdmin>,
  fromIso: string,
  untilIso: string,
): Promise<{ bookings: BufferedBooking[]; unassigned: number }> {
  const eventTypes = (unwrap(
    // cap-safe: event_types is roster bounded (one per bucket at most, about sixty).
    await db.from("event_types").select("id, buffer_before_min, buffer_after_min"),
    "buffer breach event types",
  ) ?? []) as { id: string; buffer_before_min: number; buffer_after_min: number }[];
  const buckets = (unwrap(
    // cap-safe: buckets is roster bounded (about sixty at the design target).
    await db.from("buckets").select("id, is_test"),
    "buffer breach buckets",
  ) ?? []) as { id: string; is_test: boolean }[];
  const rows = await selectAllPages<BufferBookingRow>("monitor buffer breach bookings", "id", () =>
    db
      // agent-link-ok: an advisor's calls need their buffers whichever way the lead
      // booked; a call through the advisor's own link takes the same time.
      .from("bookings")
      .select("id, assigned_user_id, agent_name, starts_at, ends_at, event_type_id, bucket_id, allow_double_book")
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("starts_at", fromIso)
      .lt("starts_at", untilIso) as unknown as PageableQuery,
  );
  return bookingsForBufferCheck(rows, eventTypes, buckets);
}
