import type { supabaseAdmin } from "@/lib/supabase/admin";
import { isUniqueViolation, unwrap } from "@/lib/db/result";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import { bookingTestFlags } from "@/lib/booking/test-flag";
import type { HandoffWriter } from "@/lib/handoffs/record";
import type { HandoffBooking, HandoffResolution, OpenHandoff } from "@/lib/handoffs/check";
import type { BookingHandoffKind } from "@/lib/db/types";

/**
 * The database half of booking handoffs (#2367). Every read throws on a real error
 * rather than answering empty: an empty open list reads as "nothing is waiting" and
 * would clear both pages, and an empty booking list would leave every row unresolved
 * while looking like a clean read (#277, #1134).
 *
 * `booking_handoffs` is a GROWTH table (not on the capped read guard's SAFE_TABLES),
 * so every read here is bounded: the open read by an explicit limit, the booking read
 * by the primary keys the rows name.
 */

type Db = ReturnType<typeof supabaseAdmin>;

/** The writer `recordHandoff` needs. The partial unique index on open (booking_id, kind) is the dedupe. */
export function handoffWriter(db: Db): HandoffWriter {
  return {
    async insertOnce(row) {
      const { error } = await db
        .from("booking_handoffs")
        .insert({ booking_id: row.booking_id, kind: row.kind, detail: row.detail });
      if (!error) return { inserted: true };
      // An OPEN row for this booking and kind already exists: a retried caller losing
      // to its own first attempt, which it is always allowed to lose. Matched on the
      // SQLSTATE, never the message.
      if (isUniqueViolation(error)) return { inserted: false };
      throw new Error(`booking handoff write failed: ${error.message}`);
    },
  };
}

interface OpenRow {
  id: string;
  booking_id: string;
  kind: BookingHandoffKind;
  detail: unknown;
  created_at: string;
  notified_at: string | null;
  notify_attempts: number;
  last_notify_error: string | null;
}

export async function loadOpenHandoffs(db: Db, limit: number): Promise<OpenHandoff[]> {
  const rows = unwrap(
    await db
      .from("booking_handoffs")
      .select("id, booking_id, kind, detail, created_at, notified_at, notify_attempts, last_notify_error")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(limit),
    "open booking handoffs",
  ) as OpenRow[] | null;
  return (rows ?? []).map((r) => ({
    id: r.id,
    bookingId: r.booking_id,
    kind: r.kind,
    detail: r.detail,
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
    notifyAttempts: r.notify_attempts,
    lastNotifyError: r.last_notify_error,
  }));
}

interface BookingRow {
  id: string;
  bucket_id: string;
  status: string;
  starts_at: string;
  timezone: string;
  assigned_user_id: string | null;
  agent_name: string | null;
  agent_email: string | null;
  attendee_name: string | null;
}

export async function loadHandoffBookings(db: Db, ids: string[]): Promise<HandoffBooking[]> {
  const rows: BookingRow[] = [];
  // Chunked by the measured URL budget rather than trusting the open read's bound to
  // fit one filter: an in() list past it is refused at the transport (#1259).
  for (const chunk of chunkIdsByUrlBudget(ids)) {
    const page = unwrap(
      await db
        .from("bookings")
        // cap-safe: primary-key lookup of the bookings the open handoffs name, which the
        // open read already bounds.
        //
        // `bucket_id`, NOT `is_test`: `bookings` has no such column, and this read
        // asked for one until #2369. It is the BUCKET that marks the smoke canary
        // (#396), so the flag comes from `bookingTestFlags` below.
        .select(
          "id, bucket_id, status, starts_at, timezone, assigned_user_id, agent_name, agent_email, attendee_name",
        )
        .in("id", chunk),
      "booking handoff bookings",
    ) as BookingRow[] | null;
    rows.push(...(page ?? []));
  }
  // #2370: the smoke canary's own bookings are never spoken about in the sales
  // channel. Derived from the bucket, and a booking whose bucket did not come back
  // reports null rather than either default, because one of them suppresses a real
  // lead's handoff for ever and the other announces the canary's.
  const testFlags = await bookingTestFlags(db, rows);
  return rows.map((r) => ({
    id: r.id,
    isTest: testFlags.get(r.id) ?? null,
    status: r.status,
    startsAt: r.starts_at,
    timezone: r.timezone,
    assignedUserId: r.assigned_user_id,
    agentName: r.agent_name,
    agentEmail: r.agent_email,
    attendeeName: r.attendee_name,
  }));
}

/**
 * The handoff channel, or null when it is unset. A missing config row is unset too:
 * nobody has saved the settings form yet. A failed read THROWS, because "unset" pages
 * and "set" clears, and an unreadable setting is neither.
 */
export async function loadHandoffChannel(db: Db): Promise<string | null> {
  const row = unwrap(
    await db.from("monitor_alert_config").select("handoff_channel").eq("id", 1).maybeSingle(),
    "handoff channel",
  ) as { handoff_channel: string | null } | null;
  const channel = row?.handoff_channel;
  return channel && channel.trim() ? channel.trim() : null;
}

/** Mark open rows resolved. Guarded on `status = open`, so a row is resolved once. */
export async function resolveHandoffs(
  db: Db,
  ids: string[],
  reason: HandoffResolution,
  atIso: string,
): Promise<void> {
  const { error } = await db
    .from("booking_handoffs")
    .update({ status: "resolved", resolved_reason: reason, resolved_at: atIso })
    .in("id", ids)
    .eq("status", "open");
  if (error) throw new Error(`booking handoff resolve failed: ${error.message}`);
}

/** Stamp a delivered row, only if nothing has stamped it yet. */
export async function markHandoffNotified(db: Db, id: string, atIso: string): Promise<void> {
  const { error } = await db
    .from("booking_handoffs")
    .update({ notified_at: atIso, last_notify_error: null })
    .eq("id", id)
    .is("notified_at", null);
  if (error) throw new Error(`booking handoff stamp failed: ${error.message}`);
}

/** Record a failed post: the attempt count and a short reason, never a raw body. */
export async function recordHandoffNotifyFailure(
  db: Db,
  id: string,
  attempts: number,
  reason: string,
): Promise<void> {
  const { error } = await db
    .from("booking_handoffs")
    .update({ notify_attempts: attempts, last_notify_error: reason })
    .eq("id", id)
    .is("notified_at", null);
  if (error) throw new Error(`booking handoff failure write failed: ${error.message}`);
}
