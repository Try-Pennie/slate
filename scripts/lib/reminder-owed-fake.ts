// A hand written fake for the owed reminder email check (#4300): builders for the
// stored emails and the bookings it reads, and a deps object whose reads can be made to
// fail and whose pages and clears are recorded. Shared by scripts/test-reminder-owed.ts.
import type { OwedBooking, OwedEmail, ReminderOwedDeps } from "../../src/lib/monitor/reminder-owed.ts";
import type { StoredSend } from "../../src/lib/booking/reminder-legacy.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** A Tuesday mid morning, Eastern. */
export const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
export const iso = (ms: number) => new Date(ms).toISOString();

export function email(over: Partial<OwedEmail> = {}): OwedEmail {
  return {
    id: "email-hour",
    slug: "hour",
    name: "1 hour reminder",
    minutesBefore: 60,
    lateBooking: "skip",
    enabled: true,
    effectiveFromIso: iso(NOW - 30 * 24 * HOUR),
    placeholderSends: true,
    ...over,
  };
}

export const DAY_EMAIL = email({ id: "email-day", slug: "day", name: "24 hour reminder", minutesBefore: 1440, lateBooking: "send_now" });
export const HOUR_EMAIL = email();

/**
 * A live booking made days ago whose call starts `startsInMs` from NOW. Its 24 hour
 * email is on record in the legacy columns, sent a day before the call, so a test about
 * the 1 hour email is not also a test about a forgotten 24 hour one.
 */
export function booking(startsInMs: number, over: Partial<OwedBooking> = {}): OwedBooking {
  const created = iso(NOW - 5 * 24 * HOUR);
  return {
    reminderSentForIso: iso(NOW + startsInMs),
    reminderSentAtIso: iso(NOW + startsInMs - 24 * HOUR),
    id: "bk-1",
    startsAtIso: iso(NOW + startsInMs),
    createdAtIso: created,
    updatedAtIso: created,
    status: "confirmed",
    attendeeEmail: "lead@example.com",
    agentEmail: "advisor@trypennie.com",
    onPlaceholder: false,
    sends: [],
    hourReminderSentForIso: null,
    ...over,
  };
}

/** A stored send row about this booking's start. */
export function send(b: OwedBooking, e: OwedEmail, status: StoredSend["status"], at: { sentAtMs?: number; claimedAtMs?: number } = {}): StoredSend {
  return {
    emailId: e.id,
    sentForIso: b.startsAtIso,
    status,
    sentAtIso: at.sentAtMs === undefined ? null : iso(at.sentAtMs),
    claimedAtIso: at.claimedAtMs === undefined ? null : iso(at.claimedAtMs),
  };
}

export interface OwedSpy {
  paged: { key: string; text: string; subjects: readonly string[] | undefined }[];
  resolved: { key: string; text: string }[];
  windowEnds: string[];
}

export function owedDeps(
  emails: OwedEmail[],
  bookings: OwedBooking[],
  over: Partial<ReminderOwedDeps> & { firing?: string[] } = {},
): { deps: ReminderOwedDeps; spy: OwedSpy } {
  const spy: OwedSpy = { paged: [], resolved: [], windowEnds: [] };
  const { firing = [], ...rest } = over;
  const deps: ReminderOwedDeps = {
    nowMs: NOW,
    cooldownMs: 24 * HOUR,
    loadEmails: async () => emails,
    loadBookings: async (endIso) => {
      spy.windowEnds.push(endIso);
      return bookings;
    },
    loadFiringSlugs: async () => firing,
    notify: async (key, _ms, text, repeat) => {
      spy.paged.push({ key, text, subjects: repeat?.subjects });
    },
    resolve: async (key, text) => {
      spy.resolved.push({ key, text });
      return true;
    },
    ...rest,
  };
  return { deps, spy };
}
