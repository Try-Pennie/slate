/**
 * The one launch sweep for booking invites already out of step (#3919, decision 9).
 *
 * Before #3919 nothing noticed an advisor moving a Slate booking's invite, so on the
 * day it ships some upcoming invites already disagree with their bookings (#3919
 * measured one). Dan's decision: report every one of them to the alerts channel for
 * a person to handle, and revert NONE; only moves made after launch are put back.
 *
 * So this reads each upcoming booking's invite live, and for each out of step one:
 *  - records it (`report_launch`), so a later change to the same invite (the lead
 *    accepting it) is read as the standing move it is, never as a first move to
 *    put back;
 *  - writes the moved time as busy (decision 6), which the sync would otherwise only
 *    do on the invite's next change or the calendar's next full resync;
 *  - and posts ONE message listing them all.
 *
 * It has no seam that could move an invite, by construction. Bookings the handler
 * already recorded are skipped, so running it after the handler has acted on one
 * neither reports it twice nor counts it as pre launch. It is run by hand once,
 * through `pnpm sweep:moved-invites` (`scripts/sweep-moved-invites.ts`), which
 * prints what it found and changes nothing unless given `--apply`.
 */
import type { GoogleEvent } from "./calendar.ts";
import { eventWindow } from "./sync-core.ts";
import { judgeInvite } from "./invite-moves.ts";
import type { FreshBooking, NewInviteChange } from "./invite-move-notice.ts";
import { inviteLaunchSweepAlert, type InviteMoveFacts } from "./invite-move-copy.ts";

export const INVITE_LAUNCH_SWEEP_KEY = "booking_invite_launch_sweep";

export interface SweepBooking extends FreshBooking {
  advisorEmail: string | null;
  advisorName: string | null;
}

export interface InviteSweepDeps {
  nowMs: number;
  appBaseUrl: string;
  /** False for a dry run: read and report to the caller, write and post nothing. */
  apply: boolean;
  /** Every active booking that has not ended and has an invite. Throws on failure. */
  loadUpcoming(): Promise<SweepBooking[]>;
  /** Which of these bookings already have a recorded change. Throws on failure. */
  bookingsWithChanges(bookingIds: string[]): Promise<Set<string>>;
  /** The invite now, or null when gone. Throws when unreadable. */
  readEvent(email: string, eventId: string): Promise<GoogleEvent | null>;
  recordChange(row: NewInviteChange): Promise<string | null>;
  /** Write the moved time as the sync would mirror it. */
  writeMirror(m: { userId: string; eventId: string; startsAt: string; endsAt: string }): Promise<void>;
  post(key: string, text: string): Promise<void>;
  /** How many invites to read at once. */
  concurrency?: number;
}

export interface SweepFinding extends InviteMoveFacts {
  step: "moved" | "resized";
  userId: string;
  eventId: string;
  /** Google's `updated` stamp when read, the record's key. */
  eventUpdated: string | null;
}

export interface SweepResult {
  checked: number;
  found: SweepFinding[];
  /** Invites Google could not answer for: not judged, and listed so a person can. */
  unreadable: string[];
  /** Bookings whose invite is gone from the calendar: out of scope here, but counted. */
  gone: string[];
  alreadyRecorded: number;
  /** With `apply`: what this run recorded, blocked and posted. Empty on a dry run. */
  reported: SweepFinding[];
  /** With `apply`: findings another run recorded between this one's read and its write. */
  recordedElsewhere: number;
}

export async function sweepOutOfStepInvites(deps: InviteSweepDeps): Promise<SweepResult> {
  const upcoming = (await deps.loadUpcoming()).filter(
    (b) => b.gcalEventId !== null && b.assignedUserId !== null && b.advisorEmail !== null,
  );
  const recorded = await deps.bookingsWithChanges(upcoming.map((b) => b.id));
  const todo = upcoming.filter((b) => !recorded.has(b.id));
  const result: SweepResult = {
    checked: 0,
    found: [],
    unreadable: [],
    gone: [],
    alreadyRecorded: upcoming.length - todo.length,
    reported: [],
    recordedElsewhere: 0,
  };
  const width = Math.max(1, deps.concurrency ?? 5);
  for (let i = 0; i < todo.length; i += width) {
    await Promise.all(
      todo.slice(i, i + width).map(async (b) => {
        let event: GoogleEvent | null;
        try {
          event = await deps.readEvent(b.advisorEmail!, b.gcalEventId!);
        } catch {
          result.unreadable.push(b.id);
          return;
        }
        result.checked++;
        if (!event) {
          result.gone.push(b.id);
          return;
        }
        const step = judgeInvite(event, b);
        if (step !== "moved" && step !== "resized") return;
        const win = eventWindow(event)!;
        result.found.push({
          step,
          userId: b.assignedUserId!,
          eventId: b.gcalEventId!,
          bookingId: b.id,
          advisorName: b.advisorName,
          advisorEmail: b.advisorEmail!,
          bookedStartsAt: b.startsAt,
          bookedEndsAt: b.endsAt,
          eventStartsAt: win.start,
          eventEndsAt: win.end,
          bookingUrl: `${deps.appBaseUrl}/admin/bookings/${b.id}`,
          eventUpdated: event.updated ?? null,
        });
      }),
    );
  }
  // Stable order for the message: by booked start, then booking.
  result.found.sort((a, b) => a.bookedStartsAt.localeCompare(b.bookedStartsAt) || a.bookingId.localeCompare(b.bookingId));
  if (!deps.apply || result.found.length === 0) return result;

  // Only what THIS run recorded is blocked and reported. A null means another run
  // (the live handler acting on a fresh change, or an earlier sweep) recorded it
  // first, and that run owns what happens to it.
  const reported: SweepFinding[] = [];
  for (const f of result.found) {
    const id = await deps.recordChange({
      bookingId: f.bookingId,
      userId: f.userId,
      gcalEventId: f.eventId,
      kind: f.step,
      // A pre launch move is the booking's first, so a later move is its second and
      // is escalated rather than put back (decision 4).
      moveNumber: f.step === "moved" ? 1 : null,
      action: "report_launch",
      bookedStartsAt: f.bookedStartsAt,
      bookedEndsAt: f.bookedEndsAt,
      eventStartsAt: f.eventStartsAt,
      eventEndsAt: f.eventEndsAt,
      eventUpdated: f.eventUpdated ?? `unstamped:${f.eventStartsAt}:${f.eventEndsAt}`,
    });
    if (id === null) {
      result.recordedElsewhere++;
      continue;
    }
    await deps.writeMirror({ userId: f.userId, eventId: f.eventId, startsAt: f.eventStartsAt, endsAt: f.eventEndsAt });
    reported.push(f);
  }
  result.reported = reported;
  if (reported.length === 0) return result;
  // alert-key: booking_invite_launch_sweep
  await deps.post(INVITE_LAUNCH_SWEEP_KEY, inviteLaunchSweepAlert(reported));
  return result;
}
