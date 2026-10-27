/**
 * The reads behind the unserved placeholder call check (#4206), kept out of the monitor
 * route so the column lists and the bounds are in one place.
 *
 * Every read THROWS on an error, through `selectAllPages`, `unwrap` or `inIdChunks`: an
 * empty list here would read as "no placeholder calls" or "no calls to the customer",
 * and the second is the very finding the check exists to make.
 */
import type { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import type { BookingStatus } from "@/lib/db/types";
import type { PlaceholderBookingRow, PlaceholderCallRow } from "@/lib/monitor/placeholder-calls";

type Db = ReturnType<typeof supabaseAdmin>;

const BOOKING_COLUMNS = "id, kind, status, starts_at, ends_at, salesforce_id, agent_name";

/** Every status a call is still owed in: a completed booking was due a call too. */
const OWED_STATUSES: BookingStatus[] = ["confirmed", "rescheduled", "completed"];

/**
 * Placeholder calls in the given (real) buckets whose start falls in the window. The
 * caller passes only the real buckets, which is how a test bucket's placeholder call
 * (the test bucket drill) is left out, as every booking monitor leaves them out.
 */
export async function loadPlaceholderCallCandidates(
  db: Db,
  realBucketIds: string[],
  sinceIso: string,
  untilIso: string,
): Promise<PlaceholderBookingRow[]> {
  if (realBucketIds.length === 0) return [];
  return selectAllPages<PlaceholderBookingRow>("monitor placeholder call candidates", "id", () =>
    db
      // agent-link-ok: about real CALLS on the placeholder (kind staff_placed), never routed
      // demand; a routed filter here would leave out every booking this check exists for.
      .from("bookings")
      .select(BOOKING_COLUMNS)
      // in-chunk-ok: the real buckets are the routing matrix, sixty codes at the
      // design target, about 2,300 bytes of uuids against the 10,000 budget.
      .in("bucket_id", realBucketIds)
      .eq("kind", "staff_placed")
      .in("status", OWED_STATUSES)
      .gte("starts_at", sinceIso)
      .lte("starts_at", untilIso) as unknown as PageableQuery,
  );
}

/** The bookings behind the open pages, by primary key. A booking that is gone is simply absent. */
export async function loadPlaceholderBookingsById(db: Db, ids: string[]): Promise<PlaceholderBookingRow[]> {
  const chunks = await inIdChunks("monitor placeholder call open pages", ids, async (chunk) =>
    unwrap(
      // agent-link-ok: the bookings behind open pages, by id, whatever kind a move left
      // them as: a call moved onto a real advisor is how one of its endings is told.
      await db.from("bookings").select(BOOKING_COLUMNS).in("id", chunk),
      "monitor placeholder call open pages",
    ) as PlaceholderBookingRow[],
  );
  return chunks.flat();
}

/** Regal calls to these Leads started at or after `sinceIso`, every page of each chunk. */
export async function loadPlaceholderCalls(db: Db, leadKeys: string[], sinceIso: string): Promise<PlaceholderCallRow[]> {
  const chunks = await inIdChunks("monitor placeholder calls", leadKeys, (chunk) =>
    selectAllPages<PlaceholderCallRow & { id: string }>("monitor placeholder calls", "id", () =>
      db
        .from("regal_call_outcomes")
        .select("id, lead_key, started_at, is_ai_agent")
        .in("lead_key", chunk)
        .gte("started_at", sinceIso) as unknown as PageableQuery,
    ),
  );
  return chunks.flat();
}

/**
 * The newest arrival in the call feed, anybody's: the check's positive control on the
 * feed. One indexed row. Null when the feed holds nothing; an unreadable stamp throws,
 * because a guessed one would either silence the check or let it judge a dead feed.
 */
export async function loadCallFeedNewestReceivedMs(db: Db): Promise<number | null> {
  const row = unwrap(
    await db.from("regal_call_outcomes").select("received_at").order("received_at", { ascending: false }).limit(1).maybeSingle(),
    "monitor placeholder call feed newest",
  ) as { received_at: string } | null;
  if (row === null) return null;
  const ms = parseStampMs(row.received_at);
  if (ms === null) throw new Error("regal_call_outcomes newest received_at is unreadable");
  return ms;
}
