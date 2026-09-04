// Relative value import so this module runs under `node --experimental-strip-types`
// in tests (a "@/" value import is not erased).
import { coveragePanelWhere } from "../booking/coverage-panel-copy.ts";

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

/** Time-off orchestration incident: oooCalcomAlert. */
export function oooCalcomAlert(requestId: string, outcome: string): string {
  return `The Cal.com availability override for request ${requestId} failed (${outcome}).`;
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
