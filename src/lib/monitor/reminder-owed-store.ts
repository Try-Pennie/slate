import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { ReminderEmailRow, ReminderSendStatus } from "@/lib/db/types";
import type { OwedBooking, OwedEmail } from "./reminder-owed.ts";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The reads behind the owed reminder email check (#4300), kept out of
 * `reminder-owed.ts` so every branch of the judgement is driven with no database.
 *
 * Its own reads rather than the lane's (`booking-reminders/route.ts`): a monitor that
 * read through the lane's worklist would inherit any filter that hid a booking from it,
 * which is one of the faults it exists to see (L721). Both THROW on a failed read, so the
 * check is unreadable rather than finding nobody owed.
 */

/** Every stored email, switched off ones included. `reminder_emails` is a handful of rows. */
export async function loadOwedEmails(db: Db): Promise<OwedEmail[]> {
  // cap-safe: reminder_emails is a handful of admin made rows (SAFE_TABLES).
  const rows = unwrap(
    await db
      .from("reminder_emails")
      .select("id, slug, name, minutes_before, late_booking, enabled, effective_from, placeholder_sends"),
    "monitor reminder owed emails",
  ) as Pick<
    ReminderEmailRow,
    "id" | "slug" | "name" | "minutes_before" | "late_booking" | "enabled" | "effective_from" | "placeholder_sends"
  >[];
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    minutesBefore: r.minutes_before,
    lateBooking: r.late_booking,
    enabled: r.enabled,
    effectiveFromIso: r.effective_from,
    placeholderSends: r.placeholder_sends,
  }));
}

interface OwedRow {
  id: string;
  starts_at: string;
  created_at: string;
  updated_at: string;
  status: string;
  kind: string;
  attendee_email: string | null;
  agent_email: string | null;
  reminder_sent_for: string | null;
  reminder_sent_at: string | null;
  hour_reminder_sent_for: string | null;
  booking_reminder_sends:
    | { reminder_email_id: string; sent_for: string; status: ReminderSendStatus; sent_at: string | null; claimed_at: string | null }[]
    | null;
}

/**
 * Live calls in REAL buckets starting after `nowIso` and at or before `windowEndIso`
 * (at most the 48 hour cap), each with its send rows and the three legacy columns.
 * Expected volume: about 95 bookings a day, so about 100 rows at the 24 hour lead and
 * 200 at the cap, one page. Paged all the same (#2500): a capped page would leave the
 * calls past it unjudged and read as owed nothing.
 *
 * Test buckets are left out through the bucket's own flag, joined inner, so the smoke
 * canary's bookings and the test bucket drills never page (#396, #2760).
 *
 * Every kind of call, routed or booked through an advisor's own link or placed on the
 * placeholder: each one is owed its reminders, so this is a read of real CALLS, not of
 * routed demand.
 */
export async function loadOwedBookings(db: Db, nowIso: string, windowEndIso: string): Promise<OwedBooking[]> {
  const rows = await selectAllPages<OwedRow>("monitor reminder owed bookings", "id", () =>
    db
      // agent-link-ok: every call is owed its reminder emails, whatever brought it in.
      .from("bookings")
      .select(
        "id, starts_at, created_at, updated_at, status, kind, attendee_email, agent_email, reminder_sent_for, reminder_sent_at, hour_reminder_sent_for, buckets!inner(is_test), booking_reminder_sends(reminder_email_id, sent_for, status, sent_at, claimed_at)",
      )
      .in("status", ["confirmed", "rescheduled"])
      .gt("starts_at", nowIso)
      .lte("starts_at", windowEndIso)
      .eq("buckets.is_test", false),
  );
  return rows.map((r) => ({
    id: r.id,
    startsAtIso: r.starts_at,
    createdAtIso: r.created_at,
    updatedAtIso: r.updated_at,
    status: r.status,
    attendeeEmail: r.attendee_email,
    agentEmail: r.agent_email,
    onPlaceholder: r.kind === "staff_placed",
    reminderSentForIso: r.reminder_sent_for,
    reminderSentAtIso: r.reminder_sent_at,
    hourReminderSentForIso: r.hour_reminder_sent_for,
    sends: (r.booking_reminder_sends ?? []).map((s) => ({
      emailId: s.reminder_email_id,
      sentForIso: s.sent_for,
      status: s.status,
      sentAtIso: s.sent_at,
      claimedAtIso: s.claimed_at,
    })),
  }));
}
