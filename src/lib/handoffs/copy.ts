import { DateTime } from "luxon";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";
import { describeGap } from "@/lib/monitor/health";
import { shortFailureReason } from "@/lib/notify/error-text";
import { readDuplicateDetail, readOwnerDetail, type HandoffKind } from "@/lib/handoffs/kinds";

/**
 * The words a booking handoff says (#2367), as pure builders.
 *
 * Two audiences, deliberately written for separately:
 *
 *  - the HANDOFF NOTICE goes to the handoff channel, read by the sales side. It says
 *    what Slate measured about one booking and where to act on it. It names the
 *    lead, because a person has to find the call, and links the ADMIN booking page.
 *    It never carries a manage link or a manage token: those are the lead's own key
 *    to their call, and a channel is not the lead.
 *  - the two ALERTS go to the alerts channel, read by whoever keeps Slate running,
 *    and say that handoffs are not reaching the sales side.
 *
 * A duplicate notice states only what was measured. It never says where the other
 * call probably is: Slate cannot see another system's calls, and a guess stated in a
 * notice is read as a fact by the person acting on it (L11, L192).
 *
 * Held as builders so `pnpm preview:alerts` renders the text that ships rather than
 * a second copy of it (L41).
 */

/** The zone call times are given in: the sales side works Eastern. */
const SALES_ZONE = "America/New_York";

/** "Wednesday, September 16 at 11:00am Eastern", or null for an unreadable instant. */
function callTime(iso: string): string | null {
  const dt = DateTime.fromISO(iso, { zone: SALES_ZONE });
  const day = formatLongDate(dt);
  const time = formatClockTime(dt);
  return day && time ? `${day} at ${time} Eastern` : null;
}

/** The booking fields a notice reads. */
export interface HandoffNoticeBooking {
  startsAt: string;
  agentName: string | null;
  agentEmail: string | null;
  attendeeName: string | null;
}

const nonEmpty = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

/**
 * The notice for one handoff. `detail` is the stored jsonb, read through the per
 * kind readers, so a row whose detail this code cannot read still produces a
 * truthful notice that says less rather than one that guesses.
 */
export function formatHandoffNotice(
  handoff: { kind: HandoffKind; detail: unknown },
  booking: HandoffNoticeBooking,
  bookingUrl: string,
): string {
  // A redacted booking has no name left, and "the call for " with a blank is worse
  // than saying it is a lead.
  const lead = nonEmpty(booking.attendeeName);
  const advisor = nonEmpty(booking.agentName) ?? nonEmpty(booking.agentEmail);
  const when = callTime(booking.startsAt) ?? "a time Slate could not read";

  if (handoff.kind === "owner-reassign-refused") {
    const detail = readOwnerDetail(handoff.detail);
    const whose = lead ? `${lead}'s call` : "A lead's call";
    const staysWith = advisor ? `stays with ${advisor}` : "stays with no advisor assigned";
    const because = detail ? ownerRefusalClause(detail.refusal, detail.requestedOwnerEmail) : null;
    return (
      `A call was not moved to the lead's owner. ${whose} on ${when} ${staysWith}` +
      `${because ? `, because ${because}` : ""}. ` +
      `If the owner should take it, reassign it by hand: ${bookingUrl}`
    );
  }

  const detail = readDuplicateDetail(handoff.detail);
  const who = lead ?? "A lead";
  const withWhom = advisor ? ` with ${advisor}` : "";
  const sentences = [
    `A double booking needs cancelling by hand. ${who} has a call${withWhom} on ${when}, and Slate did not cancel it.`,
  ];
  if (detail) {
    sentences.push(duplicateFindingSentence(detail.finding));
    if (detail.weakerMatch) {
      sentences.push(
        `It does hold a later call matching only their ${detail.weakerMatch === "phone-only" ? "phone number" : "email address"}.`,
      );
    }
    const later = detail.laterBookingStartsAt ? callTime(detail.laterBookingStartsAt) : null;
    if (later) sentences.push(`The later booking was reported to start ${later}.`);
  }
  sentences.push(`Check the lead's calls and cancel the one they no longer need: ${bookingUrl}`);
  return sentences.join(" ");
}

function duplicateFindingSentence(finding: "no-other-call" | "named-is-newest" | "identity-conflict"): string {
  switch (finding) {
    case "no-other-call":
      return (
        "Slate holds no other upcoming call for this lead under their Salesforce id, " +
        "or under their email and phone together, so it could not confirm this call is the duplicate."
      );
    case "named-is-newest":
      return (
        "Every other upcoming call Slate holds for this lead was booked before this one, " +
        "and Slate only cancels the earlier of two calls."
      );
    case "identity-conflict":
      return (
        "Slate holds another upcoming call with the same email and phone, but the two carry " +
        "different Salesforce ids, so it did not treat them as the same person."
      );
  }
}

function ownerRefusalClause(
  refusal: "owner-not-found" | "owner-not-bookable" | "owner-on-time-off",
  email: string,
): string {
  switch (refusal) {
    case "owner-not-found":
      return `Slate has no advisor account for ${email}`;
    case "owner-not-bookable":
      return `${email} is not taking bookings in Slate`;
    case "owner-on-time-off":
      return `${email} has approved time off during the call`;
  }
}

const handoffs = (n: number) => `${n} booking handoff${n === 1 ? "" : "s"}`;

/**
 * The page when handoffs are open and no handoff channel is set. Names the count and
 * the wait, then the one place that fixes it.
 */
export function formatHandoffChannelUnsetAlert(input: {
  waiting: number;
  oldestWaitMs: number;
  settingsUrl: string;
}): string {
  const one = input.waiting === 1;
  return (
    `${handoffs(input.waiting)} ${one ? "is" : "are"} waiting for the sales team and no handoff ` +
    `channel is set, so nobody has been told about ${one ? "it" : "them"}. ` +
    `${one ? "It has" : "The oldest has"} waited ${describeGap(input.oldestWaitMs)}. ` +
    `Set the handoff channel on the alert settings page: ${input.settingsUrl}`
  );
}

export function formatHandoffChannelUnsetRecovery(): string {
  return "No booking handoff is waiting on a handoff channel any more: one is set, or nothing is waiting.";
}

/**
 * The page when a handoff has gone unposted past the threshold. `lastError` is the
 * short reason stored on the row; it is shortened again here so a row written by
 * anything else still cannot put a raw body in front of the reader.
 */
export function formatHandoffUndeliveredAlert(input: {
  count: number;
  oldestWaitMs: number;
  thresholdMs: number;
  lastError: string | null;
  settingsUrl: string;
}): string {
  const one = input.count === 1;
  const reason = shortFailureReason(input.lastError);
  return (
    `${handoffs(input.count)} ${one ? "has" : "have"} waited more than ` +
    `${describeGap(input.thresholdMs)} without reaching the handoff channel, so the sales team ` +
    `has not been told. ${one ? "It has" : "The oldest has"} waited ${describeGap(input.oldestWaitMs)}. ` +
    (reason ? `The last attempt to post failed with ${reason}. ` : "") +
    `Slate keeps retrying. Check that the handoff channel on the alert settings page ` +
    `is right and that the Slate app is in it: ${input.settingsUrl}`
  );
}

export function formatHandoffUndeliveredRecovery(): string {
  return "Every open booking handoff has now reached the handoff channel, so the sales team has been told.";
}
