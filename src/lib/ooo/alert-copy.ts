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
 * One approved time off whose calendar event no longer covers it (#3360), as the
 * page names it. `coverage` is the judge's own verdict (`event-coverage.ts`), so the
 * words can never describe a different disagreement than the one measured.
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

const NOT_BLOCKING_WHY = "(it was deleted, cancelled, marked free or moved)";

function mismatchLine(f: OooEventMismatch, appBaseUrl: string): string {
  const label = f.displayTzLabel ?? undefined;
  const approved = formatWhenLine(f.startsAt, f.endsAt, f.displayTzId, label);
  const calendar =
    f.coverage.kind === "not-blocking"
      ? f.coverage.unmeasured === null
        ? `The calendar shows no busy time off event inside that window ${NOT_BLOCKING_WHY}.`
        : `The calendar shows no busy time off event for ${formatWhenLine(
            f.startsAt,
            new Date(f.coverage.unmeasured.startMs).toISOString(),
            f.displayTzId,
            label,
          )} ${NOT_BLOCKING_WHY}; the rest of the window is too far ahead to check yet.`
      : `The calendar event leaves ${f.coverage.spans
          .map((s) =>
            formatWhenLine(
              new Date(s.startMs).toISOString(),
              new Date(s.endMs).toISOString(),
              f.displayTzId,
              label,
            ),
          )
          .join(" and ")} open.`;
  return `Approved: ${approved}. ${calendar} ${appBaseUrl}/admin/ooo?request=${f.requestId}`;
}

/**
 * Condition (#3360): an agent's Google Calendar and their approved time off
 * disagree.
 *
 * It deliberately does not say which one is wrong. On 2026-10-06 the edit in
 * Google was the true one (the agent was working that morning) and the request was
 * stale, so a page insisting the event be put back would have told somebody to
 * reverse a real schedule. It says what Slate does meanwhile (holds the approved
 * window, so nobody rushes to protect it), and offers both repairs.
 *
 * Who is told is #3372's job; this goes to the alerts channel until then.
 */
export function oooEventMismatchAlert(
  agentName: string,
  found: OooEventMismatch[],
  appBaseUrl: string,
): string {
  const one = found.length === 1;
  return (
    `${agentName}'s Google Calendar no longer matches ` +
    `${one ? "an approved time off" : `${found.length} approved time off requests`}, ` +
    `and only a person can say which is right. Slate is still blocking the whole approved ` +
    `window, so no lead can be booked into it meanwhile. Make the two agree: if those ` +
    `hours are being worked, change the request in My time off (it goes back to the ` +
    `manager to approve); if they are not, put the calendar event back to the approved ` +
    `times.\n` +
    found.map((f) => mismatchLine(f, appBaseUrl)).join("\n")
  );
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
