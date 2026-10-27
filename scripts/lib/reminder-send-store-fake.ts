// An in memory stand in for the reminder lane's two records of what was sent (#4298):
// the `booking_reminder_sends` rows moved by migration 0211's functions, and the legacy
// `bookings` columns the lane still writes for the day and hour emails until phase 6.
//
// It mirrors the SQL rules the lane relies on, so a lane test can run two ticks against
// one store and see what the database would have said: `claim_reminder_send` answers
// taken, superseded, gap or claimed by the same checks in the same order, and the other
// four functions move a row only from the status the SQL moves it from. The SQL itself is
// proved in a real Postgres by scripts/verify-reminder-emails-sql.ts; this is only the
// lane's view of it.
import type { ReminderClaimOutcome, ReminderSendStatus } from "../../src/lib/db/types.ts";
import type { StoredSend } from "../../src/lib/booking/reminder-send.ts";

export interface FakeSendRow {
  bookingId: string;
  emailId: string;
  sentForIso: string;
  status: ReminderSendStatus;
  reason: string | null;
  claimedAtMs: number | null;
  sentAtMs: number | null;
}

export interface FakeLegacyColumns {
  reminderSentFor: string | null;
  reminderSentAt: string | null;
  hourReminderSentFor: string | null;
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

export function reminderSendStoreFake(opts: {
  now: () => number;
  /** Each email's minutes before the call, which the superseded check compares. */
  minutesOf: (emailId: string) => number | undefined;
  gapMs: number;
}) {
  const rows: FakeSendRow[] = [];
  const legacy = new Map<string, FakeLegacyColumns>();

  const find = (bookingId: string, emailId: string, sentForIso: string) =>
    rows.find((r) => r.bookingId === bookingId && r.emailId === emailId && sameInstant(r.sentForIso, sentForIso));

  const legacyOf = (bookingId: string): FakeLegacyColumns => {
    let cols = legacy.get(bookingId);
    if (!cols) {
      cols = { reminderSentFor: null, reminderSentAt: null, hourReminderSentFor: null };
      legacy.set(bookingId, cols);
    }
    return cols;
  };

  return {
    rows,
    legacyOf,
    claim(bookingId: string, emailId: string, sentForIso: string): ReminderClaimOutcome {
      const own = find(bookingId, emailId, sentForIso);
      if (own && own.status !== "released") return "taken";
      const minutes = opts.minutesOf(emailId);
      if (minutes === undefined) throw new Error(`claim_reminder_send: no reminder email ${emailId}`);
      const others = rows.filter(
        (r) => r.bookingId === bookingId && r.emailId !== emailId && sameInstant(r.sentForIso, sentForIso),
      );
      const shorter = others.some((r) => {
        const m = opts.minutesOf(r.emailId);
        return m !== undefined && m < minutes && (r.status === "sent" || r.status === "claimed" || r.status === "legacy_claimed");
      });
      if (shorter) return "superseded";
      const now = opts.now();
      const inGap = others.some(
        (r) =>
          (r.status === "claimed" && r.claimedAtMs !== null && r.claimedAtMs > now - opts.gapMs) ||
          (r.status === "sent" && r.sentAtMs !== null && r.sentAtMs > now - opts.gapMs),
      );
      if (inGap) return "gap";
      if (own) {
        Object.assign(own, { status: "claimed", reason: null, claimedAtMs: now, sentAtMs: null });
      } else {
        rows.push({ bookingId, emailId, sentForIso, status: "claimed", reason: null, claimedAtMs: now, sentAtMs: null });
      }
      return "claimed";
    },
    mark(bookingId: string, emailId: string, sentForIso: string): boolean {
      const r = find(bookingId, emailId, sentForIso);
      if (!r || r.status !== "claimed") return false;
      Object.assign(r, { status: "sent", sentAtMs: opts.now() });
      return true;
    },
    release(bookingId: string, emailId: string, sentForIso: string): boolean {
      const r = find(bookingId, emailId, sentForIso);
      if (!r || r.status !== "claimed") return false;
      r.status = "released";
      return true;
    },
    fail(bookingId: string, emailId: string, sentForIso: string, reason: string): boolean {
      if (!reason.trim()) throw new Error("fail_reminder_send: a failure needs a reason");
      const r = find(bookingId, emailId, sentForIso);
      if (!r || r.status !== "claimed") return false;
      Object.assign(r, { status: "failed", reason });
      return true;
    },
    skip(bookingId: string, emailId: string, sentForIso: string, reason: string): boolean {
      if (!reason.trim()) throw new Error("skip_reminder_send: a skip needs a reason");
      const r = find(bookingId, emailId, sentForIso);
      if (r && r.status !== "released") return false;
      if (r) Object.assign(r, { status: "skipped", reason, claimedAtMs: opts.now(), sentAtMs: null });
      else rows.push({ bookingId, emailId, sentForIso, status: "skipped", reason, claimedAtMs: opts.now(), sentAtMs: null });
      return true;
    },
    /** The rows as the worklist embeds them for one booking. */
    sendsFor(bookingId: string): StoredSend[] {
      return rows
        .filter((r) => r.bookingId === bookingId)
        .map((r) => ({
          emailId: r.emailId,
          sentForIso: r.sentForIso,
          status: r.status,
          sentAtIso: r.sentAtMs === null ? null : new Date(r.sentAtMs).toISOString(),
          claimedAtIso: r.claimedAtMs === null ? null : new Date(r.claimedAtMs).toISOString(),
        }));
    },
    /** The legacy claim: a compare and swap on what the tick read, as the route's update. */
    legacyClaim(bookingId: string, slug: "day" | "hour", startsAtIso: string, seen: string | null): boolean {
      const cols = legacyOf(bookingId);
      if (slug === "day") {
        if (cols.reminderSentFor !== seen) return false;
        cols.reminderSentFor = startsAtIso;
        cols.reminderSentAt = null;
      } else {
        if (cols.hourReminderSentFor !== seen) return false;
        cols.hourReminderSentFor = startsAtIso;
      }
      return true;
    },
    legacyRelease(
      bookingId: string,
      slug: "day" | "hour",
      claimedForIso: string,
      restoreTo: string | null,
      restoreSentAt: string | null,
    ): boolean {
      const cols = legacyOf(bookingId);
      if (slug === "day") {
        if (cols.reminderSentFor !== claimedForIso) return false;
        cols.reminderSentFor = restoreTo;
        cols.reminderSentAt = restoreSentAt;
      } else {
        if (cols.hourReminderSentFor !== claimedForIso) return false;
        cols.hourReminderSentFor = restoreTo;
      }
      return true;
    },
    legacyMarkSent(bookingId: string, startsAtIso: string): void {
      const cols = legacyOf(bookingId);
      if (cols.reminderSentFor === startsAtIso) cols.reminderSentAt = new Date(opts.now()).toISOString();
    },
  };
}
