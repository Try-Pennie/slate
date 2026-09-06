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

/**
 * Activation refused: the Google account has never been given Calendar (#1396).
 *
 * Its own message because the fix is a different person doing a different thing.
 * The gone copy tells the reader the account is missing from the Workspace or the
 * delegation is broken, which sends them to check credentials that are fine, and
 * the transient copy tells them to retry shortly, which can never work: nothing
 * changes until an admin gives the person Calendar.
 */
export function bookableNotProvisionedAlert(email: string): string {
  return `Blocked making ${email} bookable because their Google account has never been signed up for Google Calendar (Google refuses the account with notACalendarUser). This is not a credential problem and retrying will not fix it: a Workspace admin has to give them Calendar first. The agent was NOT added to the booking pool.`;
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

/**
 * What stops being honored while a given retention lane is not deleting.
 *
 * An explicit entry per lane, because the previous shape fell through to routing's
 * sentence for any lane it did not recognise. A new lane's skip alert would then
 * have claimed routing decisions were at stake, which is a message asserting
 * something its check never measured, and it would read as a deliberate choice
 * (L11, L113). The fallback now names the lane and claims nothing about what it
 * protects.
 */
export function retentionLaneStake(lane: string): string {
  if (lane === "prune-bookings-pii") return "consumer contact data past the 24 month window is not being redacted";
  if (lane === "prune-webhook-payloads") return "webhook payloads past the 90 day window are keeping full attendee PII";
  if (lane === "prune-routing") return "routing decisions past the 12 month window are not being pruned";
  if (lane === "prune-warehouse-pii") {
    return "consumer contact data past the 24 month window is not being cleared from the warehouse copy";
  }
  return `whatever the ${lane} lane protects is not being enforced`;
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
  // Two different situations, and they must not borrow each other's wording: an
  // absent credential is not a mirror that is "behind", and a reader mid-incident
  // sent to chase a lagging export lane that was never configured is being given a
  // remedy that cannot work (L11, L111).
  const unconfigured = reason === MIRROR_NOT_CONFIGURED;
  const cause = unconfigured
    ? "the Snowflake mirror is not configured here"
    : `the Snowflake mirror is not confirmed current (${reason})`;
  const remedy = unconfigured
    ? `Retention stays stopped until the warehouse credential is set: see the Snowflake settings in DEPLOY.md.`
    : `Retention stays stopped until the export lane catches up: check the snowflake-export lane and ` +
      `/api/admin/snowflake-check.`;
  return (
    `The ${lane} retention lane ran but did nothing because ${cause}, so ` +
        `${retentionLaneStake(lane)}. ${remedy}`
  );
}

/**
 * A retention lane is past its gate and deleting again.
 *
 * The REASON differs by lane and must not be borrowed, which reading the preview
 * is what caught (#1180). The three Supabase lanes are gated on the export lane
 * keeping up, so "the mirror is confirmed current" is what their run measured. The
 * warehouse lane has no export gate at all (it writes to the mirror rather than
 * relying on it), so its only gate is the credential existing, and claiming the
 * mirror was confirmed current would assert something nothing checked (L11).
 */
export function retentionResumedText(lane: string): string {
  const because =
    lane === "prune-warehouse-pii"
      ? "The warehouse credential is present"
      : "The Snowflake mirror is confirmed current";
  return (
    `The ${lane} retention lane is deleting again. ${because}, so aged ` +
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
/**
 * A page's error boundary caught something, so a person is looking at the error
 * screen right now (#1974).
 *
 * It does NOT reuse `internalErrorAlert`, and that is the point rather than
 * tidiness. That sentence ends "the caller got a generic 500", which is untrue
 * here: nothing returned a 500, a person was shown a screen. A message may claim
 * only what its check actually measured (L11), and the reader's next move
 * differs: a 500 is a route to look at, this is a PAGE somebody cannot use.
 *
 * It names the page, because that is the one thing the reader needs in order to
 * go and look, and it says the screen was shown, because that is what makes this
 * worth reading at all: somebody met it.
 */
export function boundaryCatchAlert(page: string, detail: string): string {
  return `A page under ${page} failed to render and showed its error screen (${detail}). Anyone on that page is seeing it. Full detail is in the Worker logs at level error.`;
}

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
 *
 * It claims nothing it did not measure (#1223). Two sentences were removed after
 * #1220, where the audit_log schema and grants were both correct and the CALLER
 * was wrong (an ooo_requests id passed into a column that references users):
 *
 *   - "Check the audit_log table's schema and grants" was canned remediation that
 *     sent the investigation to the two places that were fine (L36).
 *   - "Further audit writes are likely failing too" is not something this check
 *     can see: it fires on ONE write, and in #1220 role and settings writes
 *     recorded normally throughout (L11).
 *
 * `constraint` is the database's own verdict when the row was rejected by a
 * constraint (SQLSTATE 23503), which is the useful signal: it says which column
 * carried a value the table would not take, and it is the fact that a
 * length-budgeted `reason` would otherwise truncate away.
 */
export function auditWriteFailedAlert(action: string, reason: string, constraint?: string | null): string {
  const cause = constraint
    ? `the database rejected the row on ${constraint}, so a column carried an id that column does not accept`
    : reason;
  // Only a rejection HAS a rejected value to point at; promising one for a grant
  // break or a dropped connection would be the same overclaim in miniature.
  const where = constraint
    ? `The rejected value and the full error are in the Worker logs`
    : `The full error is in the Worker logs`;
  return (
    `The audit trail did NOT record a "${action}" action (${cause}). ` +
    `The action itself went through, so this is a gap in the record of who did ` +
    `what, not a failed change. ${where} at level error, tag=audit.`
  );
}

/** A caller sent a reason code we do not recognise (informational). */
export function unknownReasonCodeNotice(rawCode: string): string {
  return (
    `Automated reassign API received an unknown reason code (\`${rawCode}\`); ` +
    `recorded owner_reassignment instead. Check the caller's reason mapping.`
  );
}
