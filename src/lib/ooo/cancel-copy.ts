import { DateTime } from "luxon";
import type { OooStatus } from "@/lib/db/types";

/**
 * The two acts the agent's ONE time off control performs (#2406).
 *
 * Until this shipped, both asked the same two words ("Cancel this?" then
 * "Yes, cancel"), and they are not the same act:
 *
 * - WITHDRAW takes back a PENDING request nobody has acted on. Nothing was ever
 *   written to a calendar for it.
 * - CANCEL undoes an APPROVED one. `cancelOoo` runs `undoPostApproval`, which
 *   deletes the manager's calendar event, the agent's own event, the busy block
 *   and the cal.com override, then stops the coverage sweep, and the agent is
 *   bookable for those days again from the next availability recompute. The
 *   manager who approved it is told afterwards.
 *
 * Every word either act is named by lives here, once, so the row control, the
 * confirmation, the outcome banner and the Slack messages for the same event
 * cannot drift into naming the same act two ways (L41). The builders are pure
 * and hold every sentence, so this module is where the wording can be read
 * before it ships, and `scripts/test-ooo-cancel-copy.ts` is where it is pinned.
 */

export type CancelAct = "withdraw" | "cancel";

/** The act a request in this state is ABOUT to receive (L180). */
export function cancelActForStatus(status: OooStatus): CancelAct {
  return status === "approved" ? "cancel" : "withdraw";
}

/**
 * The act a call has ALREADY performed.
 *
 * Driven by what the call did, never by the request's status (L680): by the time
 * anything writes the outcome message the row reads `cancelled` whichever act
 * produced it, so the stored status can no longer tell the two apart.
 */
export function cancelActPerformed(wasApproved: boolean): CancelAct {
  return wasApproved ? "cancel" : "withdraw";
}

/** What the server action redirects with, so the banner can name the act back. */
export type CancelOutcomeKind = "withdrawn" | "cancelled";

type CancelActWords = {
  /** The control on the request row that arms the confirm. */
  control: string;
  /** The control that performs it. */
  confirmControl: string;
  /** While it is in flight. */
  confirmPending: string;
  /**
   * The way out of the confirm, deliberately SHARED and deliberately not either
   * act's own verb: a confirm offering "Cancel" to back out of cancelling is the
   * confusion this module exists to end.
   */
  dismiss: string;
  outcomeKind: CancelOutcomeKind;
  /** The heading on the banner the agent lands on. */
  outcomeHeading: string;
  /** The sentence under it. */
  outcomeMessage: string;
  /** How the agent's own Slack message names it. */
  pastParticiple: string;
  /** How the manager's Slack message names it. */
  managerVerb: string;
};

export const CANCEL_ACT_WORDS: Record<CancelAct, CancelActWords> = {
  withdraw: {
    control: "Withdraw",
    confirmControl: "Yes, withdraw",
    confirmPending: "Withdrawing",
    dismiss: "Keep it",
    outcomeKind: "withdrawn",
    outcomeHeading: "Request withdrawn",
    outcomeMessage: "Your time off request was withdrawn.",
    pastParticiple: "withdrawn",
    managerVerb: "withdrew",
  },
  cancel: {
    control: "Cancel",
    confirmControl: "Yes, cancel",
    confirmPending: "Cancelling",
    dismiss: "Keep it",
    outcomeKind: "cancelled",
    outcomeHeading: "Time off cancelled",
    outcomeMessage: "Your approved time off was cancelled.",
    pastParticiple: "cancelled",
    managerVerb: "cancelled",
  },
};

const ACTS: CancelAct[] = ["withdraw", "cancel"];

/**
 * The act an outcome kind came from, so the banner derives its heading from the
 * same table the action redirected with rather than keeping a second copy of the
 * mapping that has to stay in step (L70). A kind belonging to another outcome
 * (a fresh request, an edit) is not one of these and answers null.
 */
export function cancelActForOutcomeKind(
  kind: string | null | undefined,
): CancelAct | null {
  return ACTS.find((act) => CANCEL_ACT_WORDS[act].outcomeKind === kind) ?? null;
}

/**
 * How many of the agent's own days the window covers, counted in the request's
 * OWN zone. This is what the confirmation is derived from, so it reads correctly
 * for a two hour appointment and for a week at Thanksgiving (L180).
 *
 * An unreadable bound answers 1 rather than NaN: the sentence is about to be put
 * in front of somebody, and "these NaN days" is worse than under-describing a
 * window whose dates the row is already showing.
 */
export function oooDayCount(
  startIso: string,
  endIso: string,
  tzId: string,
): number {
  const zone = DateTime.fromISO(startIso, { zone: tzId }).isValid
    ? tzId
    : "Etc/UTC";
  const start = DateTime.fromISO(startIso, { zone }).startOf("day");
  const end = DateTime.fromISO(endIso, { zone }).startOf("day");
  if (!start.isValid || !end.isValid) return 1;
  const days = Math.round(end.diff(start, "days").days) + 1;
  return Number.isFinite(days) && days > 1 ? days : 1;
}

/**
 * The destructive confirmation, in two parts: the question names the act and
 * how much of the agent's time it is about, and the consequence says what
 * becomes of it.
 *
 * The question does NOT repeat the request's when line. The row carries that
 * line at the same moment, a column to the left, and the confirm replaces only
 * the controls beside it (L605). What the row does not state is the SIZE of what
 * is about to go, which is the thing that differs between the two requests
 * somebody is most likely to confuse.
 *
 * The consequences are the whole point of the split. The approved one names the
 * calendar, because clearing it is what the act does and is the fact an agent
 * pressing this by mistake needed. The pending one says nothing about a calendar
 * at all, because a pending request has never had an event, a busy block or an
 * override behind it, and inventing a reassurance about one would be a claim
 * nothing measured.
 */
export function cancelConfirmCopy(
  act: CancelAct,
  dayCount: number,
): { question: string; consequence: string } {
  const span = dayCount > 1 ? `these ${dayCount} days` : null;
  if (act === "cancel") {
    return {
      question: span ? `Cancel the time off for ${span}?` : "Cancel this time off?",
      consequence: span
        ? "Your calendar clears and you can be booked on those days again."
        : "Your calendar clears and you can be booked then again.",
    };
  }
  return {
    question: span ? `Withdraw the request for ${span}?` : "Withdraw this request?",
    consequence: "It stops waiting for approval.",
  };
}

/** The agent's own Slack message about what just happened to their request. */
export function cancelAgentDm(act: CancelAct, whenLine: string): string {
  return `Your time off request for ${whenLine} was ${CANCEL_ACT_WORDS[act].pastParticiple}.`;
}

/** The manager's Slack message about the same event. */
export function cancelManagerDm(
  act: CancelAct,
  agentName: string,
  whenLine: string,
): string {
  return `${agentName} ${CANCEL_ACT_WORDS[act].managerVerb} their time off request for ${whenLine}.`;
}
