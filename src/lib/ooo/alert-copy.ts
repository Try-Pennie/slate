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

/** Time-off orchestration incident: oooBusyBlockFallbackAlert. */
export function oooBusyBlockFallbackAlert(requestId: string): string {
  return `Availability for request ${requestId} was blocked with a Slate-native busy block (the calendar-linked one couldn't be used because the agent calendar event wasn't created). Availability is blocked correctly; flagging the fallback.`;
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
