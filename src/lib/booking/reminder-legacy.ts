import { parseStampMs } from "@/lib/date/stamp";
import type { SendRecord, SendStatus } from "./reminder-decision.ts";

/**
 * What a booking has been sent, as the reminder judge reads it (#4298): the
 * `booking_reminder_sends` rows the worklist embeds, PLUS records read off the three
 * legacy `bookings` columns the two original emails used before migration 0211.
 *
 * Until phase 6 retires those columns, two writers can record a send in them alone: the
 * old code, which ran between `supabase db push` and this deploy (and would run again on
 * a rollback), and nothing else. Migration 0211 copied what the columns held when it was
 * applied, but a 24 hour or 1 hour email the old code sent after that exists ONLY in the
 * columns. Reading them as records here is what keeps that lead from being sent the same
 * email twice, and from being sent a 24 hour email after their 1 hour one.
 *
 * The mapping is migration 0211's backfill, the same three rules:
 *   * `reminder_sent_for` with `reminder_sent_at`: the `day` email, `sent` at that time,
 *     so the two hour gap is measured from it as the old 1 hour rule did;
 *   * `reminder_sent_for` without a time: `day`, `legacy_claimed`, which starts no gap
 *     (an unknown send time held nothing back under the old rule either);
 *   * `hour_reminder_sent_for`: the `hour` email, `legacy_claimed`.
 *
 * ONE helper, used by the lane and by phase 5's owed email check, so the two can never
 * disagree about what counts as sent (L263). Stored rows and legacy records are simply
 * listed together: wherever both describe one key, either settles it, which is the
 * direction that sends nothing twice.
 */

/** One `booking_reminder_sends` row as the worklist embeds it. */
export interface StoredSend {
  emailId: string;
  sentForIso: string;
  status: SendStatus;
  sentAtIso: string | null;
  claimedAtIso: string | null;
}

/** What the helper needs of a booking: its embedded rows and the three legacy columns. */
export interface BookingSendSource {
  sends: readonly StoredSend[];
  /** `bookings.reminder_sent_for`: the start the 24 hour email went out about. */
  reminderSentForIso: string | null;
  /** `bookings.reminder_sent_at`: when it went, or null when unknown. */
  reminderSentAtIso: string | null;
  /** `bookings.hour_reminder_sent_for`: the start the 1 hour email went out about. */
  hourReminderSentForIso: string | null;
}

/** The slugs whose sends the legacy columns record, the two seeded emails. */
export const LEGACY_SLUGS = ["day", "hour"] as const;
export type LegacySlug = (typeof LEGACY_SLUGS)[number];

export function isLegacySlug(slug: string): slug is LegacySlug {
  return (LEGACY_SLUGS as readonly string[]).includes(slug);
}

/** A stamp, or null; an unreadable one is NaN so it matches no start. */
function stampOrNull(iso: string | null): number | null {
  return iso ? (parseStampMs(iso) ?? NaN) : null;
}

/** A time a record carries, or null when absent or unreadable (it then starts no gap). */
function timeOrNull(iso: string | null): number | null {
  return parseStampMs(iso);
}

/**
 * Every send record for this booking: the stored rows first, then one per legacy column
 * that is set and whose email is still stored (a legacy record for an email that no
 * longer exists has nothing to settle). `allEmails` is every stored email, switched off
 * ones included.
 */
export function sendRecordsForBooking(
  booking: BookingSendSource,
  allEmails: readonly { id: string; slug: string }[],
): SendRecord[] {
  const records: SendRecord[] = booking.sends.map((r) => ({
    emailId: r.emailId,
    sentForMs: stampOrNull(r.sentForIso) ?? NaN,
    status: r.status,
    sentAtMs: timeOrNull(r.sentAtIso),
    claimedAtMs: timeOrNull(r.claimedAtIso),
  }));
  const idOf = (slug: LegacySlug) => allEmails.find((e) => e.slug === slug)?.id;

  const dayId = idOf("day");
  const daySentFor = stampOrNull(booking.reminderSentForIso);
  if (dayId !== undefined && daySentFor !== null) {
    const sentAtMs = timeOrNull(booking.reminderSentAtIso);
    records.push(
      sentAtMs !== null
        ? { emailId: dayId, sentForMs: daySentFor, status: "sent", sentAtMs, claimedAtMs: null }
        : { emailId: dayId, sentForMs: daySentFor, status: "legacy_claimed", sentAtMs: null, claimedAtMs: null },
    );
  }

  const hourId = idOf("hour");
  const hourSentFor = stampOrNull(booking.hourReminderSentForIso);
  if (hourId !== undefined && hourSentFor !== null) {
    records.push({ emailId: hourId, sentForMs: hourSentFor, status: "legacy_claimed", sentAtMs: null, claimedAtMs: null });
  }
  return records;
}
