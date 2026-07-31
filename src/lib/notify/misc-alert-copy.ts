/**
 * The remaining alert wording, lifted out of its send sites (#1153).
 *
 * One module rather than one per caller: these are single alerts scattered across
 * unrelated files, and the point is that the preview can call every one of them.
 * Each sentence exists exactly once, here (L41).
 */

/** Activation refused: the agent's calendar is definitively unreachable. */
export function bookableBlockedAlert(email: string): string {
  return `Blocked making ${email} bookable because their Google calendar is unreachable (account gone from the Workspace, or delegation broken). The agent was NOT added to the booking pool; fix the calendar and retry.`;
}

/** Activation refused: the calendar could not be verified (transient). */
export function bookableUnverifiedAlert(email: string): string {
  return `Could NOT verify ${email}'s Google calendar (a transient error persisted through one retry). The agent was NOT added to the booking pool; this is likely a temporary Google issue, so retry shortly.`;
}

/** Push-watch renewal is healthy again. */
export function watchLapseRecovery(): string {
  return "Calendar watch renewal has recovered. Every agent calendar is renewing its " +
      "Google push channel again, so external changes reach the availability cache " +
      "immediately rather than waiting on the backup cron. The earlier warning is " +
      "cleared and no action is needed.";
}

/** What stops being honored while a given retention lane is not deleting. */
export function retentionLaneStake(lane: string): string {
  if (lane === "prune-bookings-pii") return "consumer contact data past the 24 month window is not being redacted";
  if (lane === "prune-webhook-payloads") return "webhook payloads past the 90 day window are keeping full attendee PII";
  return "routing decisions past the 12 month window are not being pruned";
}

/**
 * The gate's reason when the warehouse credential is absent entirely, as opposed
 * to present but behind. Shared with retention-gate.ts so the two cannot drift:
 * they need different remedies, and a reader mid-incident must not be sent to
 * chase a lagging export lane that was never configured (L11).
 */
export const MIRROR_NOT_CONFIGURED = "mirror not configured";

/**
 * A retention lane ran but destroyed nothing, because the mirror is not
 * confirmed current. Lives here so `pnpm preview:alerts` renders the sentence
 * that actually ships rather than a copy of it (L41).
 */
export function retentionSkippedText(lane: string, reason: string): string {
  const remedy =
    reason === MIRROR_NOT_CONFIGURED
      ? `Retention stays stopped until the warehouse credential is set: see the Snowflake settings in DEPLOY.md.`
      : `Retention stays stopped until the export lane catches up: check the snowflake-export lane and ` +
        `/api/admin/snowflake-check.`;
  return (
    `The ${lane} retention lane ran but did nothing because the Snowflake mirror is not ` +
        `confirmed current (${reason}), so ${retentionLaneStake(lane)}. ${remedy}`
  );
}

/** A retention lane is past its gate and deleting again. */
export function retentionResumedText(lane: string): string {
  return (
    `The ${lane} retention lane is deleting again. The Snowflake mirror is confirmed current, so aged ` +
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
  return `The daily OOO-approvals email (${approvals} ${approvals === 1 ? "approval" : "approvals"}) failed to send to ${recipients} ${recipients === 1 ? "recipient" : "recipients"}: ${reason}`;
}

/** A Slate booking overlaps an event booked outside Slate. */
export function externalDoubleBookAlert(email: string, overlaps: number, ids: string): string {
  return `Possible external double-book for ${email}. ${overlaps} active Slate booking(s) overlap a Google event booked outside Slate (booking ids: ${ids}). Check the agent's calendar and reschedule one side.`;
}

/** A booking went to an agent who does not match the bucket. */
export function misrouteAlert(bookingId: string, bucketCode: string, agentId: string): string {
  return `Routing check: booking ${bookingId} in bucket ${bucketCode} went to agent ${agentId}, who does not match the bucket criteria, and no fallback was applied. This looks like a routing bug; the booking was allowed through. Inspect routing_decisions for this booking.`;
}

/** An unexpected server fault, reported without the raw error body. */
export function internalErrorAlert(context: string, detail: string): string {
  return `Unexpected server error on ${context} (${detail}). The caller got a generic 500. Full detail is in the Worker logs at level error.`;
}

/**
 * A privileged action happened but its audit-trail row was not written (#1049).
 *
 * Names the action, because the blast radius is the question the reader has: the
 * mutation itself already committed, so this is about a gap in the record of who
 * did what, not about a failed operation. `reason` is already shortened by
 * shortFailureReason / shortErrorReason at the call site; the full text is in the
 * Worker log.
 */
export function auditWriteFailedAlert(action: string, reason: string): string {
  return (
    `The audit trail did NOT record a "${action}" action (${reason}). ` +
    `The action itself went through, so this is a gap in the record of who did ` +
    `what, not a failed change. Further audit writes are likely failing too. ` +
    `Check the audit_log table's schema and grants; full detail is in the Worker ` +
    `logs at level error.`
  );
}

/** A caller sent a reason code we do not recognise (informational). */
export function unknownReasonCodeNotice(rawCode: string): string {
  return (
    `Automated reassign API received an unknown reason code (\`${rawCode}\`); ` +
    `recorded owner_reassignment instead. Check the caller's reason mapping.`
  );
}
