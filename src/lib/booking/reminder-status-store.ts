import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { ReminderSendStatus } from "@/lib/db/types";
import { log } from "@/lib/log";
import { readReminderEmailStatus, type ReminderStatusDeps, type ReminderStatusReading } from "./reminder-status.ts";

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The live reads behind each reminder email's status (#4300). Both throw on a failed
 * read, which `readReminderEmailStatus` turns into an explicit unknown.
 *
 * Volume: about 95 bookings a day and two emails today, so about two rows per booking
 * per email, and the rows about calls from 24 hours ago to the 48 hour cap ahead are a
 * few hundred: one page, paged all the same because `booking_reminder_sends` is a
 * growth table (#35, #166).
 */
export function reminderStatusDeps(db: Db, nowMs: number): ReminderStatusDeps {
  return {
    nowMs,
    loadSends: async (sinceIso) => {
      const rows = await selectAllPages<{
        booking_id: string;
        reminder_email_id: string;
        sent_for: string;
        status: ReminderSendStatus;
        reason: string | null;
        claimed_at: string | null;
        sent_at: string | null;
      }>("reminder email status sends", ["booking_id", "reminder_email_id", "sent_for"], () =>
        db
          .from("booking_reminder_sends")
          .select("booking_id, reminder_email_id, sent_for, status, reason, claimed_at, sent_at")
          .gte("sent_for", sinceIso),
      );
      return rows.map((r) => ({
        emailId: r.reminder_email_id,
        sentForIso: r.sent_for,
        status: r.status,
        reason: r.reason,
        claimedAtIso: r.claimed_at,
        sentAtIso: r.sent_at,
      }));
    },
    loadLastSent: async (emailIds) => {
      // One single row read per email: a handful of emails, each answered by its newest send.
      const answers = await Promise.all(
        emailIds.map(async (id) => {
          const row = unwrap(
            await db
              .from("booking_reminder_sends")
              .select("sent_at")
              .eq("reminder_email_id", id)
              .eq("status", "sent")
              .order("sent_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
            "reminder email last send",
          ) as { sent_at: string | null } | null;
          return [id, row?.sent_at ?? null] as const;
        }),
      );
      return Object.fromEntries(answers);
    },
  };
}

/**
 * Every listed email's status, read live, for the reminder emails page, as of now. The
 * clock is read here, at the IO edge, so the page renders without one (the pure count
 * takes it as an argument). Never throws: a failed read is `unreadable`, logged here so
 * the page's error state has its cause.
 */
export async function loadReminderEmailStatus(db: Db, emailIds: readonly string[]): Promise<ReminderStatusReading> {
  const reading = await readReminderEmailStatus(emailIds, reminderStatusDeps(db, Date.now()));
  if (reading.status === "unreadable") {
    log.error("reminder-emails", { msg: "reminder email status unreadable", emails: emailIds.length }, new Error(reading.error));
  }
  return reading;
}
