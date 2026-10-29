// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (a "@/" value import is not erased).
import { coveragePanelWhere } from "../booking/coverage-panel-copy.ts";
import { formatWhenLine } from "./core.ts";

/**
 * The words the time-off orchestration's alerts say (#1153).
 *
 * Lifted out of the send sites so the alert preview can render them (L41: one
 * place per sentence). All INCIDENTS: each describes one approval or one message
 * that already failed, with no healthy state to announce later.
 */

/** Time-off orchestration incident: oooManagerCalendarAlert. */
export function oooManagerCalendarAlert(requestId: string, reason: string): string {
  return `The OOO calendar for request ${requestId} was not accessible (${reason}); the event landed on the main OOO calendar instead.`;
}

/** Time-off orchestration incident: oooCalendarCreateBothFailedAlert. */
export function oooCalendarCreateBothFailedAlert(requestId: string, reason: string): string {
  return `Creating the OOO calendar event for request ${requestId} failed on both the manager and main calendars: ${reason}`;
}

/** Time-off orchestration incident: oooCalendarCreateAlert. */
export function oooCalendarCreateAlert(requestId: string, reason: string): string {
  return `Creating the OOO calendar event for request ${requestId} failed: ${reason}`;
}

/** Time-off orchestration incident: oooAgentCalendarAlert. */
export function oooAgentCalendarAlert(requestId: string, reason: string): string {
  return `Creating the agent calendar OOO event for request ${requestId} failed: ${reason}`;
}

/**
 * Time-off orchestration condition: the approval fell back to a Slate written
 * busy block because the agent's calendar event could not be created.
 *
 * The old wording ended "Availability is blocked correctly; flagging the
 * fallback", which asserted an ongoing truth the message could never take back:
 * in #1464 it was true for 31 seconds and false forever after, and it was the
 * reader's last word on that time off. It now says what happened, what it rests
 * on, and that the monitor lane is watching it, and the all-clear arrives when
 * nothing is relying on that block any more (#1470).
 */
export function oooBusyBlockFallbackAlert(requestId: string): string {
  return (
    `The time off for request ${requestId} is blocked by a Slate written busy block ` +
    `alone: the event on the agent's own calendar could not be created. Those hours ` +
    `are blocked for now, but the protection rests on that one cached row. Retry the ` +
    `calendar updates on the request. The monitor lane checks every 5 minutes and will ` +
    `page if the window stops being blocked, and clear this when nothing is relying on ` +
    `the fallback.`
  );
}

/**
 * Time-off orchestration incident (#3365): a narrowed request's calendar event could
 * not be moved to the narrower window. The event and Slate's held block both stay on
 * the earlier, wider window, which is the safe direction, and re-approving the
 * request retries the move.
 */
export function oooNarrowCalendarAlert(
  requestId: string,
  which: "agent" | "manager",
  reason: string,
): string {
  const whose = which === "agent" ? "the agent's own calendar" : "the manager's OOO calendar";
  return (
    `Time off request ${requestId} was shortened, but its event on ${whose} could not be ` +
    `moved to match (${reason}). It still shows the earlier, wider window` +
    (which === "agent" ? ", and Slate keeps blocking that window too" : "") +
    `. Re-approving the request retries the move.`
  );
}

/**
 * Time-off orchestration incident (#3365): a narrowed request's held busy block could
 * not be narrowed, so Slate keeps blocking the earlier, wider window. Over-blocking is
 * the safe direction; re-approving the request retries it.
 */
export function oooNarrowHoldAlert(requestId: string): string {
  return (
    `Time off request ${requestId} was shortened, but Slate's busy block for it could not ` +
    `be narrowed, so the hours removed from it are still blocked. Re-approving the request ` +
    `retries it.`
  );
}

/** Time-off orchestration incident: oooCalcomAlert. */
export function oooCalcomAlert(requestId: string, outcome: string): string {
  return `The Cal.com availability override for request ${requestId} failed (${outcome}).`;
}

/**
 * #2890: a time off was cancelled or changed while cal.com was retired, so its
 * cal.com block was left in place, and the record that lets putting cal.com back
 * take it out could not be written. Says what that leaves and what to do.
 */
export function oooCalcomStaleUnrecordedAlert(requestId: string, agentEmail: string, reason: string): string {
  return (
    `Time off request ${requestId} for ${agentEmail} was cancelled or changed while cal.com was ` +
    `retired, and the block cal.com still holds for its old dates could not be recorded (${reason}). ` +
    `If cal.com is put back, that block will not be taken out on its own: check ${agentEmail}'s ` +
    `cal.com schedule for every date of time off cancelled or changed while it was retired and ` +
    `remove any block Slate no longer holds, or they cannot be booked there on those days.`
  );
}

/** Time-off orchestration incident: oooAgentDmAlert. */
export function oooAgentDmAlert(email: string, requestId: string): string {
  return `The approval DM to ${email} for request ${requestId} could not be delivered.`;
}

/** Time-off orchestration incident: oooUndoManagerAlert. */
export function oooUndoManagerAlert(requestId: string, reason: string): string {
  return `Removing the manager OOO event for request ${requestId} failed: ${reason}`;
}

/** Time-off orchestration incident: oooUndoAgentAlert. */
export function oooUndoAgentAlert(requestId: string, reason: string): string {
  return `Removing the agent calendar OOO event for request ${requestId} failed: ${reason}`;
}

/**
 * Time-off orchestration incident (#3660): an undo could not READ a calendar back
 * for an event the approval holds no id for. The approval's create was never
 * confirmed (a timeout among the ways), so the event may have landed anyway, and
 * nobody looked. It names the calendar owner
 * so the reader knows whose calendar to open, and says "may", because the read that
 * would have settled it is the thing that failed (L11).
 */
export interface UncheckedCalendar {
  whose: "manager" | "agent";
  /** Why it could not be checked, short and human. */
  reason: string;
}

export function oooUndoUnrecordedAlert(requestId: string, unchecked: UncheckedCalendar[]): string {
  const places = unchecked.map(
    (u) => `${u.whose === "manager" ? "the manager OOO calendar" : "the agent's own calendar"} (${u.reason})`,
  );
  const many = unchecked.length > 1;
  return (
    `${many ? "OOO events" : "An OOO event"} for request ${requestId} may still be on ${places.join(" and on ")}: ` +
    `${many ? "their creates were" : "its create was"} never confirmed, so Slate holds no id for ` +
    `${many ? "them" : "it"}, and ${many ? "those calendars" : "that calendar"} could not be checked. ` +
    `Look there and delete any event for this request that is present.`
  );
}

/**
 * Time-off orchestration incident: oooCoverageStopAlert (#1665).
 *
 * The time off was cancelled or narrowed and the coverage sweep behind it could not
 * be stopped, so customers may still be handed to another advisor for a reason that
 * no longer exists. Nothing retries this: the request is already closed, so the only
 * route back is a person opening the panel that moves them.
 *
 * Its own key rather than sharing `ooo_undo`, because the two say different things
 * to do and a shared key lets one throttle away the other (L11).
 */
export function oooCoverageStopAlert(requestId: string, reason: string): string {
  return (
    `The coverage sweep for time off request ${requestId} could not be stopped after the ` +
    `request was closed (${reason}). Its remaining appointments may still move to other ` +
    `advisors. Stop them from ${coveragePanelWhere()}.`
  );
}

/**
 * One approved time off whose calendar event no longer covers it (#3360). `coverage`
 * is the judge's own verdict (`event-coverage.ts`), so the DMs that describe the
 * disagreement (`mismatch-notice-copy.ts`) can never name a different one than the
 * one measured. The alerts channel page names the open hours of a shortened event only.
 */
export interface OooEventMismatch {
  requestId: string;
  startsAt: string;
  endsAt: string;
  displayTzId: string;
  displayTzLabel: string | null;
  coverage:
    | { kind: "uncovered"; spans: { startMs: number; endMs: number }[] }
    /**
     * `unmeasured` is the tail of the window too far ahead for Slate's copy of the
     * calendar to answer (#3655), or null when the whole window was checked. The
     * sentence then names only the part that was checked (L11).
     */
    | { kind: "not-blocking"; unmeasured: { startMs: number; endMs: number } | null };
}

/**
 * The hours a shortened event leaves open, in the request's zone, joined with "and".
 * Shared by the alerts channel page and the agent's and manager's DMs
 * (`mismatch-notice-copy.ts`), so both name the same hours the same way.
 */
export function openSpansText(
  spans: { startMs: number; endMs: number }[],
  tzId: string,
  tzLabel: string | undefined,
): string {
  return spans
    .map((s) => formatWhenLine(new Date(s.startMs).toISOString(), new Date(s.endMs).toISOString(), tzId, tzLabel))
    .join(" and ");
}

/**
 * One request's block on the page: the approved window, then the link alone on the
 * last line, in Dan's layout (2026-10-29). Only a shortened event says how the
 * calendar differs (the hours it leaves open); a missing or partly checked one does
 * not, because Dan cut that sentence. `reason` is the request's own escalation
 * sentence when the requests on one page reached it differently, and follows the
 * open hours.
 */
function mismatchBlock(f: OooEventMismatch, appBaseUrl: string, reason: string | null): string {
  const label = f.displayTzLabel ?? undefined;
  const approved = formatWhenLine(f.startsAt, f.endsAt, f.displayTzId, label);
  // Dan (2026-10-29): a shortened event alone keeps one line, naming the hours it
  // leaves open, with no full stop. A missing or partly checked one says nothing more.
  const open =
    f.coverage.kind === "uncovered" ? `Calendar leaves ${openSpansText(f.coverage.spans, f.displayTzId, label)} open` : null;
  return [
    `Approved: ${approved}`,
    ...(open === null ? [] : [open]),
    ...(reason === null ? [] : [reason]),
    `${appBaseUrl}/admin/ooo?request=${f.requestId}`,
  ].join("\n");
}

/**
 * Why the alerts channel is hearing about one request (#3372): whether the message to
 * the agent arrived, and what happened on the manager step. The agent is told first
 * and their manager second; this page goes out only once neither has acted, or once
 * there was nobody else who could be told. Each combination is its own sentence
 * (L11), because they send the reader to fix different things: the calendar, the
 * roster, or Slack.
 */
export interface OooEventMismatchEscalation {
  agent: "told" | "unreachable";
  manager: "told" | "none" | "unreachable";
}

function escalationSentence(agentName: string, e: OooEventMismatchEscalation): string {
  if (e.agent === "told") {
    switch (e.manager) {
      case "told":
        return `${agentName} and their manager were both told on Slack and neither has fixed it.`;
      case "none":
        return (
          `${agentName} was told on Slack and has not fixed it, and has no manager of record ` +
          `who can act on time off, so nobody else was told.`
        );
      case "unreachable":
        return (
          `${agentName} was told on Slack and has not fixed it, and the message to their ` +
          `manager could not be delivered.`
        );
    }
  }
  switch (e.manager) {
    case "told":
      return (
        `The Slack message to ${agentName} could not be delivered, and their manager was told ` +
        `and has not fixed it.`
      );
    case "none":
      return (
        `The Slack message to ${agentName} could not be delivered, and they have no manager of ` +
        `record who can act on time off, so nobody else was told.`
      );
    case "unreachable":
      return `Neither the Slack message to ${agentName} nor the one to their manager could be delivered.`;
  }
}

const sameReason = (a: OooEventMismatchEscalation, b: OooEventMismatchEscalation) =>
  a.agent === b.agent && a.manager === b.manager;

/**
 * Condition (#3360): an agent's Google Calendar and their approved time off
 * disagree, and the agent and their manager have not fixed it (#3372).
 *
 * It deliberately does not say which one is wrong. On 2026-10-06 the edit in
 * Google was the true one (the agent was working that morning) and the request was
 * stale, so a page insisting the event be put back would have told somebody to
 * reverse a real schedule. It says what Slate does meanwhile (holds the approved
 * window, so nobody rushes to protect it), and offers both repairs.
 */
export function oooEventMismatchAlert(
  agentName: string,
  found: OooEventMismatch[],
  appBaseUrl: string,
  /**
   * Why each request reached the alerts channel: one reason for every request, or one
   * per request in `found`'s order. When the requests differ, each request's block
   * carries its own on a line of its own, and the opening sentence states none of
   * them, so no request is described by
   * another's history.
   */
  escalation: OooEventMismatchEscalation | OooEventMismatchEscalation[],
): string {
  const one = found.length === 1;
  const reasons = Array.isArray(escalation) ? escalation : found.map(() => escalation);
  if (reasons.length !== found.length) {
    throw new Error(`time off mismatch page: ${reasons.length} reasons for ${found.length} requests`);
  }
  const shared = reasons.every((r) => sameReason(r, reasons[0]!)) ? reasons[0]! : null;
  const why = shared
    ? escalationSentence(agentName, shared)
    : `Each request reached this channel for its own reason, given on its line.`;
  // Dan's wording (2026-10-29), word for word: pinned by
  // scripts/test-ooo-mismatch-notice-copy.ts.
  return [
    `${agentName}'s Google Calendar no longer matches ` +
      `${one ? "an approved time off" : `${found.length} approved time off requests`}. ` +
      `${why} Slate is still blocking the originally approved window, so no lead can be ` +
      `booked into it.`,
    `Action required: Make the two agree: if those hours are being worked, change the ` +
      `request in My time off (it goes back to the manager to approve); if they are not, ` +
      `put the calendar event back to the approved times.`,
    ...found.map((f, i) =>
      mismatchBlock(f, appBaseUrl, shared ? null : escalationSentence(agentName, reasons[i]!)),
    ),
  ].join("\n\n");
}

/**
 * What the monitor lane measured when it ended an agent's page. Two different facts,
 * so two different sentences (L11): a comparison that found every window agreeing,
 * and an agent with nothing approved ahead, where nothing was compared at all. An
 * agent with any window the lane did not compare (unreadable, out of the pool, no
 * calendar event) is never cleared, so there is no third kind.
 */
export type OooEventMismatchCleared =
  | { kind: "agreed"; compared: number }
  | { kind: "nothing-ahead" };

/**
 * The all-clear. Claims only what the monitor lane measured, and says what that was
 * (L440): how many approved windows it compared and found matching, or that no
 * approved time off is left ahead for the agent at all.
 */
export function oooEventMismatchRecovery(
  agentName: string,
  measured: OooEventMismatchCleared,
): string {
  if (measured.kind === "nothing-ahead") {
    return (
      `${agentName} has no approved time off still ahead (the request was changed, ` +
      `cancelled or has passed), so their Google Calendar has nothing left to disagree ` +
      `with. No action is needed.`
    );
  }
  const windows =
    measured.compared === 1
      ? "the one approved window still ahead was"
      : `the ${measured.compared} approved windows still ahead were`;
  return (
    `${agentName}'s Google Calendar agrees with their approved time off again: ` +
    `${windows} compared with the calendar and match. No action is needed.`
  );
}
