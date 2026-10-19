/**
 * The words for a booking invite an advisor moved in Google Calendar (#3919): the
 * advisor's and manager's Slack DMs and the alerts channel posts. Pure builders, so
 * `pnpm preview:alerts` renders exactly what ships (L41) and no builder reads the
 * clock (#2497).
 *
 * Times are given in Eastern, labelled, because the alerts channel and the sales
 * side read Eastern, and the advisor roster spans seven zones (#1739): a labelled
 * zone is never misread, an unlabelled local one is. The lead is never named: the
 * advisor knows the call by its time, and contact data stays out of Slack posts.
 */
import { DateTime } from "luxon";
import { formatClockTime, formatLongDate } from "../date/parse.ts";
import { parseStampMs } from "../date/stamp.ts";

const ZONE = "America/New_York";

/** Everything a message about one changed invite can say. */
export interface InviteMoveFacts {
  bookingId: string;
  advisorName: string | null;
  advisorEmail: string;
  bookedStartsAt: string;
  bookedEndsAt: string;
  eventStartsAt: string;
  eventEndsAt: string;
  /** The booking's page in Admin. */
  bookingUrl: string;
}

/** Why a move was left where the advisor put it (decisions 4 and 5). */
export type LeftReason = "second-move" | "near-start";

function dt(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(ZONE);
}

/** "4:05pm ET on Monday, October 19". */
export function inviteWhen(iso: string): string {
  const d = dt(iso);
  return `${formatClockTime(d) ?? "an unreadable time"} ET on ${formatLongDate(d) ?? "an unreadable day"}`;
}

/** "4:05pm ET". */
function clock(iso: string): string {
  return `${formatClockTime(dt(iso)) ?? "an unreadable time"} ET`;
}

/** The moved time, with its day only when it is not the booked day. */
function movedTo(f: InviteMoveFacts): string {
  const a = dt(f.bookedStartsAt);
  const b = dt(f.eventStartsAt);
  return a.isValid && b.isValid && a.hasSame(b, "day") ? clock(f.eventStartsAt) : inviteWhen(f.eventStartsAt);
}

function who(f: InviteMoveFacts): string {
  return f.advisorName ? `${f.advisorName} (${f.advisorEmail})` : f.advisorEmail;
}

const SLATE_NOT_GOOGLE =
  "Call times change in Slate, not in Google Calendar, because the lead's reminders and the call itself follow Slate.";

function askManager(f: InviteMoveFacts): string {
  return `If you cannot make ${clock(f.bookedStartsAt)}, ask your manager to move the call or give it to another advisor.`;
}

/** Decision 3: the advisor, after their move was put back. */
export function advisorRevertedDm(f: InviteMoveFacts): string {
  return [
    `You moved your call at ${inviteWhen(f.bookedStartsAt)} to ${movedTo(f)} in Google Calendar. ` +
      `Slate has moved it back to ${clock(f.bookedStartsAt)}, and the lead has been sent the booked time.`,
    SLATE_NOT_GOOGLE,
    askManager(f),
  ].join("\n");
}

/** Decisions 4 and 5: the advisor, when their move was left where they put it. */
export function advisorLeftDm(f: InviteMoveFacts, reason: LeftReason, managerTold: boolean): string {
  // Sent after the manager's, so it says only what that DM measured: their manager
  // is named as told only when that DM was delivered, and nobody else is claimed.
  const told = managerTold ? " and told your manager" : "";
  const why =
    reason === "second-move"
      ? `You have moved this call before, so Slate has left it where you put it this time${told}.`
      : `It starts in less than 30 minutes, so Slate has left it where you put it${told}.`;
  return [
    `You moved your call at ${inviteWhen(f.bookedStartsAt)} to ${movedTo(f)} in Google Calendar. ${why} ` +
      `The lead was booked for ${clock(f.bookedStartsAt)}, and Slate keeps you busy at both times until it is sorted out.`,
    SLATE_NOT_GOOGLE,
    managerTold ? askManager(f) : `${askManager(f)} Please tell them about this move too.`,
  ].join("\n");
}

/** Decisions 4 and 5: the advisor's manager of record. */
export function managerLeftDm(f: InviteMoveFacts, reason: LeftReason): string {
  const name = f.advisorName ?? f.advisorEmail;
  const why =
    reason === "second-move"
      ? "for the second time"
      : "less than 30 minutes before it starts";
  return (
    `${name} moved their call at ${inviteWhen(f.bookedStartsAt)} to ${movedTo(f)} in Google Calendar ${why}, ` +
    `so Slate has not moved it back. The lead was booked for ${clock(f.bookedStartsAt)}. ` +
    `Please move the call in Slate, give it to another advisor, or ask ${name} to keep the booked time: ${f.bookingUrl}`
  );
}

/** Who a left move's messages reached, for the channel post to say. */
export interface LeftReach {
  advisor: boolean;
  /**
   * `none`: measured to have no manager of record. `unreachable`: one exists and the
   * DM failed. `unread`: the lookup itself failed, so whether one exists is unknown.
   */
  manager: "told" | "unreachable" | "none" | "unread";
}

/** Decisions 4 and 5: the alerts channel. */
export function inviteMoveLeftAlert(f: InviteMoveFacts, reason: LeftReason, reach: LeftReach): string {
  const why =
    reason === "second-move"
      ? "This is the second time this booking's invite was moved"
      : "The call starts in less than 30 minutes";
  const advisor = reach.advisor ? "The advisor was messaged" : "The advisor could not be messaged on Slack";
  const manager =
    reach.manager === "told"
      ? "and so was their manager."
      : reach.manager === "unreachable"
        ? "and their manager could not be messaged on Slack."
        : reach.manager === "unread"
          ? "and their manager could not be looked up, so was not messaged."
          : "and they have no manager of record in Slate.";
  return (
    `${who(f)} moved a booking's invite in Google Calendar from ${inviteWhen(f.bookedStartsAt)} to ${movedTo(f)}. ` +
    `${why}, so it was not moved back, and the advisor is blocked at both times. ${advisor}, ${manager} ` +
    `Somebody needs to move the call in Slate, give it to another advisor, or have the advisor put the invite back: ${f.bookingUrl}`
  );
}

/** A revert Google refused: the advisor's move stands. */
export type RevertRefusal = { kind: "gone" } | { kind: "refused"; reason: string };

export function inviteRevertRefusedAlert(f: InviteMoveFacts, refusal: RevertRefusal): string {
  const head = `${who(f)} moved a booking's invite in Google Calendar from ${inviteWhen(f.bookedStartsAt)} to ${movedTo(f)}`;
  if (refusal.kind === "gone") {
    return (
      `${head}, and when Slate went to move it back the invite was no longer on their calendar. ` +
      `The lead may have no invite for a call Slate still holds at the booked time. Look at the booking: ${f.bookingUrl}`
    );
  }
  return (
    `${head}, and Google refused to move it back (${refusal.reason}). The lead's invite may still say ` +
    `${movedTo(f)} while Slate holds ${clock(f.bookedStartsAt)}, and the advisor is blocked at both times. ` +
    `Have the advisor put the invite back, or move the call in Slate: ${f.bookingUrl}`
  );
}

/** A revert that worked, whose advisor could not be told about it. */
export function inviteRevertedAdvisorUntoldAlert(f: InviteMoveFacts): string {
  return (
    `${who(f)} moved a booking's invite in Google Calendar from ${inviteWhen(f.bookedStartsAt)} to ${movedTo(f)}. ` +
    `Slate moved it back and the lead was sent the booked time, but the advisor could not be messaged on Slack, ` +
    `so please tell them call times change in Slate, not in Google Calendar: ${f.bookingUrl}`
  );
}

/** Decision 1: an end only change, posted so its frequency can be seen. */
export function inviteResizedAlert(f: InviteMoveFacts): string {
  const ev = parseStampMs(f.eventEndsAt);
  const bk = parseStampMs(f.bookedEndsAt);
  const longer = ev !== null && bk !== null && ev > bk;
  return (
    `${who(f)} changed when a booking's invite ends in Google Calendar: booked ${inviteWhen(f.bookedStartsAt)} ` +
    `to ${clock(f.bookedEndsAt)}, the invite now ends at ${clock(f.eventEndsAt)}. The start is unchanged, so ` +
    `Slate left it${longer ? " and blocks the longer time" : ""}. Nothing needs doing; this is posted so we can ` +
    `see how often it happens: ${f.bookingUrl}`
  );
}

/**
 * An invite out of step with its booking that could not be checked (a read failed),
 * so it was neither put back nor anybody told. Both times stay blocked.
 */
export function inviteCheckFailedAlert(advisorEmail: string, bookingUrl: string, reason: string): string {
  return (
    `An invite ${advisorEmail} changed in Google Calendar could not be checked against its booking ` +
    `(${reason}), so it was not moved back and nobody was told. The advisor is blocked at both the booked ` +
    `time and the invite's, and the next change to the invite is checked again. Look at the booking, and at ` +
    `the Worker log under tag=invite-move: ${bookingUrl}`
  );
}

/** Decision 9: the one launch sweep's report. */
export function inviteLaunchSweepAlert(found: (InviteMoveFacts & { step: "moved" | "resized" })[]): string {
  const one = found.length === 1;
  const lines = found.map(
    (f) =>
      `${who(f)}: booked ${inviteWhen(f.bookedStartsAt)} to ${clock(f.bookedEndsAt)}, the invite says ` +
      `${f.step === "moved" ? movedTo(f) : `${clock(f.eventStartsAt)}`} to ${clock(f.eventEndsAt)}: ${f.bookingUrl}`,
  );
  return (
    `When Slate started watching for invites moved in Google Calendar, ${found.length} upcoming ` +
    `${one ? "booking's invite was" : "bookings' invites were"} already out of step with Slate. ` +
    (one
      ? "It was not moved back, and the advisor is blocked for both the booked time and the invite's. It needs "
      : "None were moved back, and each advisor is blocked for both the booked time and the invite's. Each needs ") +
    `a person to move the call in Slate, give it to another advisor, or have the advisor put the invite back.\n` +
    lines.join("\n")
  );
}
