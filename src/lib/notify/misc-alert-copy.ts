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

/**
 * Activation refused: the calendar answered, and Slate could not READ it (#2302).
 *
 * Its own message because the reader's next move is different again. The three
 * above are all "we could not reach the account". This one is an account we did
 * reach whose events we could not load into the availability cache, so the fix is
 * to look at what the calendar sync lane said about it rather than at the
 * credentials or at the Workspace.
 *
 * Says the count, because "1 of 1" and "1 of 4" send the reader to different
 * places: the second means one particular calendar is broken while the account
 * is plainly fine.
 */
export function bookableUnhydratedAlert(email: string, hydrated: number, calendars: number): string {
  const what =
    calendars === 0
      ? "Google returned no calendar for them at all"
      : hydrated === 0
        ? calendars === 1
          ? "their calendar could not be loaded"
          : `none of their ${calendars} calendars could be loaded`
        : `only ${hydrated} of their ${calendars} calendars could be loaded`;
  return (
    `Blocked making ${email} bookable because ${what}, so Slate cannot see what is ` +
    `already booked on their time. The agent was NOT added to the booking pool, ` +
    `deliberately: in it they would be offered as free for every hour their working ` +
    `hours allow. Check the calendar sync lane's recent errors for this account. ` +
    `The hourly roster sync retries this on its own.`
  );
}

/**
 * Activation refused: the gate ran out of its own budget (#2317).
 *
 * Its own message for the same reason `bookableUnhydratedAlert` is not
 * `bookableBlockedAlert`: what the reader should DO is different. Nothing here
 * says a calendar is broken, so sending them to the sync lane would be sending
 * them to read errors that were never recorded (L11). The seconds are rendered
 * from the budget rather than spelled out, so a change to the constant cannot
 * leave the message claiming a window nobody enforces.
 */
export function bookableTimedOutAlert(email: string, budgetMs: number): string {
  const seconds = Math.round(budgetMs / 1000);
  return (
    `Blocked making ${email} bookable because reading their Google calendar took longer than ` +
    `the ${seconds} seconds one activation is allowed, so it was stopped part way and nobody ` +
    `has measured whether their calendar is readable. The agent was NOT added to the booking ` +
    `pool. This is usually Google being slow rather than anything wrong with the account: the ` +
    `hourly roster sync retries on its own, and nothing needs doing unless it keeps happening.`
  );
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
export function boundaryCatchAlert(
  page: string,
  detail: string,
  count: { count: number | null; measured: boolean; windowMinutes: number },
): string {
  return `A page under ${page} failed to render and showed its error screen (${detail}). ${boundaryScope(count)} Full detail is in the Worker logs at level error.`;
}

/**
 * How widely it is happening, which is the fact that decides whether the reader
 * gets up (#1974).
 *
 * Three sentences because there are three different things to say, and each says
 * only what was measured (L11). A number is the reason this alert is worth
 * reading at all: one catch on one load is a stale bundle or somebody's
 * extension, and the same page failing eleven times in half an hour is a page
 * nobody can use.
 *
 * The unmeasured case does NOT fall back to a number or to the wording of either
 * other case. It pages, because the counter failing open is what keeps a hiccup
 * from muting this alert, and it says the count is missing so the reader knows
 * the scope is still an open question rather than a small one.
 */
function boundaryScope(c: { count: number | null; measured: boolean; windowMinutes: number }): string {
  if (!c.measured) {
    return `Slate could not count how often this is happening, so treat the scope as unknown and look at the page.`;
  }
  if (c.count !== null && c.count > 1) {
    return `${c.count} loads of it have shown the error screen in the last ${c.windowMinutes} minutes, so this is the page rather than one person's browser.`;
  }
  // The alert is only sent on a REPEAT, so the fact of more than one is known
  // even when the figure itself could not be read back. Saying "more than once"
  // claims exactly that and no more, rather than borrowing the single-catch
  // wording, which would understate a break the reader has to act on (L11).
  return `It has shown that screen more than once in the last ${c.windowMinutes} minutes, so this is the page rather than one person's browser. Slate could not read the exact figure.`;
}

/**
 * How many browser reports came from pages Slate does not serve (#2755), the
 * lead of the detail on a `client_error:other` report.
 *
 * Every such page shares ONE key, so a storm of invented paths arrives as one
 * alert per cooldown. That line has to carry the size, or forty forged reports
 * read exactly like one stray one. It says only what was counted (L11): the
 * figure, or that there is none.
 */
export function unrecognisedPageReports(c: { count: number | null; measured: boolean; windowMinutes: number }): string {
  if (!c.measured || c.count === null) {
    return `Slate could not count the reports from pages it does not serve; latest:`;
  }
  const n = c.count === 1 ? "1 report" : `${c.count} reports`;
  return `${n} from pages Slate does not serve in the last ${c.windowMinutes} minutes; latest:`;
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

/**
 * An embedding host named the wrong origin for itself (#2641). Info, not a page:
 * bookings still complete inside the embed, but on that host the booking box keeps
 * its fallback height and the host's success redirect never fires, so it is worth
 * fixing today and not worth waking anybody for.
 */
/**
 * A partner's page threw while on a TEST bucket (#2660). Info, not a page: the
 * booking the error stopped was a test one, the page is the partner's to fix, and
 * every report is in the log. Names the page and the bucket, never the error,
 * because anybody can post to this route and whatever it forwards reaches Slack.
 */
export function testBucketClientErrorInfo(page: string, bucketCode: string): string {
  return (
    `A page under ${page} reported a client error while on the ${bucketCode} test bucket. ` +
    `That is a partner testing the embed, not a lead who could not book, so nobody is paged. ` +
    `Every report is logged: tag=client-errors msg="client error on a test bucket".`
  );
}

export function embedOriginMismatchAlert(declared: string, framedBy: string): string {
  return (
    `A page embedding the booker at ${framedBy} tells it to report to ${declared}. ` +
    `The browser drops every message sent to the wrong address, so on that page the ` +
    `booking box does not resize and the host never hears that a booking was made. ` +
    `The host should pass its own address as parentOrigin (window.location.origin). ` +
    `Every report is logged: tag=client-errors msg="embed origin mismatch".`
  );
}

/**
 * A change to whether Slate can route to an agent was written, and the trait
 * telling Regal was never recorded (#2085).
 *
 * The delivery row is what the retry sweep and the dead letter alerting stand on,
 * so a trait whose row was never written has neither: nothing retries it and
 * nothing else will ever say so. The flip itself stands, which is why this is an
 * incident about one agent rather than a refusal. The remedy is the backfill,
 * which posts every agent's current value and is safe to run again.
 */
export function bookableTraitUnrecordedAlert(email: string, slateBookable: boolean): string {
  return (
    `Regal was not told that ${email} is now ${slateBookable ? "bookable" : "not bookable"} in Slate: ` +
    `the change was saved, and recording the update for Regal failed, so nothing will retry it. ` +
    `Run pnpm backfill:bookable-trait to send every agent's current state. ` +
    `Diagnose via tag=bookable-trait in the Worker logs.`
  );
}
