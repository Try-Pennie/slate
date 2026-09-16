import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import type { OwnerAlertEvent } from "@/lib/db/types";

/**
 * The database half of the advisor only "previously pitched" alert (#2371).
 *
 * `owner_alert_events` is a GROWTH table (not on the capped read guard's SAFE_TABLES:
 * a row per owner reassign, forever), so every read here is bounded. The only read is
 * the live row for one booking, which the partial unique index makes a single row by
 * construction.
 *
 * Every read `unwrap`s. An empty answer here is not harmless: it reads as "this
 * booking has no alert", which makes the create step write a SECOND one and makes
 * every removal step decide there is nothing to take off a calendar (#277, #1641).
 */

type Db = ReturnType<typeof supabaseAdmin>;

const COLUMNS = "id, booking_id, user_id, gcal_event_id, calendar_id, created_at, removed_at, skip_reason";

/** The booking's live alert, or null when it has none. */
export async function loadLiveOwnerAlert(
  db: Db,
  bookingId: string,
): Promise<OwnerAlertEvent | null> {
  return (
    (unwrap(
      await db
        .from("owner_alert_events")
        .select(COLUMNS)
        .eq("booking_id", bookingId)
        .is("removed_at", null)
        .maybeSingle(),
      "live owner alert",
    ) as OwnerAlertEvent | null) ?? null
  );
}

/**
 * Write the row BEFORE the calendar event. Returns the row so the caller can carry its
 * id into the Google call and stamp the event id back onto it.
 */
export async function insertOwnerAlert(
  db: Db,
  row: { booking_id: string; user_id: string; calendar_id: string },
): Promise<OwnerAlertEvent> {
  const inserted = unwrap(
    await db.from("owner_alert_events").insert(row).select(COLUMNS).single(),
    "insert owner alert",
  ) as OwnerAlertEvent | null;
  if (!inserted) throw new Error("owner alert insert returned no row");
  return inserted;
}

/** Stamp the event Google created (or already held) onto the row. */
export async function setOwnerAlertEventId(
  db: Db,
  id: string,
  gcalEventId: string,
): Promise<void> {
  const { error } = await db
    .from("owner_alert_events")
    .update({ gcal_event_id: gcalEventId })
    .eq("id", id);
  if (error) throw new Error(`owner alert event id write failed: ${error.message}`);
}

/**
 * Record that Google was refused definitively, so nothing retries and nothing pages.
 * The reason is the failure KIND (`gone` / `not-provisioned`), never a raw error body:
 * the two send different people to do different things.
 */
export async function recordOwnerAlertSkip(
  db: Db,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await db
    .from("owner_alert_events")
    .update({ skip_reason: reason })
    .eq("id", id);
  if (error) throw new Error(`owner alert skip write failed: ${error.message}`);
}

/**
 * Close the row once the event is off the calendar. Guarded on the row still being
 * live, so two racing removals close it once and the partial unique index stays the
 * only thing deciding what "live" means.
 */
export async function markOwnerAlertRemoved(
  db: Db,
  id: string,
  atIso: string,
  skipReason?: string | null,
): Promise<void> {
  const patch: Record<string, string | null> = { removed_at: atIso };
  if (skipReason) patch.skip_reason = skipReason;
  const { error } = await db
    .from("owner_alert_events")
    .update(patch)
    .eq("id", id)
    .is("removed_at", null);
  if (error) throw new Error(`owner alert removal write failed: ${error.message}`);
}
