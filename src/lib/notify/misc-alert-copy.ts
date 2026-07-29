/**
 * The remaining alert wording, lifted out of its send sites (#1153).
 *
 * One module rather than one per caller: these are single alerts scattered across
 * unrelated files, and the point is that the preview can call every one of them.
 * Each sentence exists exactly once, here (L41).
 */

/** Activation refused: the agent's calendar is definitively unreachable. */
export function bookableBlockedAlert(email: string): string {
  return `Slate: blocked making ${email} bookable because their Google calendar is unreachable (account gone from the Workspace, or delegation broken). The agent was NOT added to the booking pool; fix the calendar and retry.`;
}

/** Activation refused: the calendar could not be verified (transient). */
export function bookableUnverifiedAlert(email: string): string {
  return `Slate: could NOT verify ${email}'s Google calendar (a transient error persisted through one retry). The agent was NOT added to the booking pool; this is likely a temporary Google issue, so retry shortly.`;
}

/** Push-watch renewal is healthy again. */
export function watchLapseRecovery(): string {
  return "Slate: calendar watch renewal has recovered. Every agent calendar is renewing its " +
      "Google push channel again, so external changes reach the availability cache " +
      "immediately rather than waiting on the backup cron. The earlier warning is " +
      "cleared and no action is needed.";
}

/** A retention lane is past its gate and deleting again. */
export function retentionResumedText(lane: string): string {
  return (
    `Slate: the ${lane} retention lane is deleting again. The Snowflake mirror is usable, so aged ` +
        `data is being cleared on schedule and the retention window is being honored once more. ` +
        `No action is needed.`
  );
}

/** The daily time-off approvals email did not send. */
export function oooApprovalsDigestAlert(
  approvals: number,
  recipients: number,
  reason: string,
): string {
  return `Slate: the daily OOO-approvals email (${approvals} ${approvals === 1 ? "approval" : "approvals"}) failed to send to ${recipients} ${recipients === 1 ? "recipient" : "recipients"}: ${reason}`;
}

/** A Slate booking overlaps an event booked outside Slate. */
export function externalDoubleBookAlert(email: string, overlaps: number, ids: string): string {
  return `Slate: possible external double-book for ${email}. ${overlaps} active Slate booking(s) overlap a Google event booked outside Slate (booking ids: ${ids}). Check the agent's calendar and reschedule one side.`;
}

/** A booking went to an agent who does not match the bucket. */
export function misrouteAlert(bookingId: string, bucketCode: string, agentId: string): string {
  return `Slate routing check: booking ${bookingId} in bucket ${bucketCode} went to agent ${agentId}, who does not match the bucket criteria, and no fallback was applied. This looks like a routing bug; the booking was allowed through. Inspect routing_decisions for this booking.`;
}

/** An unexpected server fault, reported without the raw error body. */
export function internalErrorAlert(context: string, detail: string): string {
  return `Slate: unexpected server error on ${context} (${detail}). The caller got a generic 500. Full detail is in the Worker logs at level error.`;
}

/** A caller sent a reason code we do not recognise (informational). */
export function unknownReasonCodeNotice(rawCode: string): string {
  return (
    `Automated reassign API received an unknown reason code (\`${rawCode}\`); ` +
    `recorded owner_reassignment instead. Check the caller's reason mapping.`
  );
}
