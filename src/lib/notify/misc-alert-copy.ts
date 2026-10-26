import { CLIENT_ERROR_KEY_PREFIX } from "@/lib/api/client-error-scrub";
import type { BlockedResource } from "@/lib/csp";
import type { GoogleMismatchReason } from "@/lib/auth/google-identity";
import { durationText } from "@/lib/notify/error-text";

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

/**
 * Activation refused: another lane was loading one of the agent's calendars at the
 * same moment (#2705).
 *
 * Its own message for the reason `bookableTimedOutAlert` has one: nothing was
 * measured about the calendar and nothing is wrong with it. The gate stood down
 * rather than write over a pass that was already refreshing it, so the sync lane
 * holds no error to read and the retry is the whole remedy.
 */
export function bookableContendedAlert(email: string, contended: number): string {
  const which = contended === 1 ? "one of their calendars" : `${contended} of their calendars`;
  return (
    `Blocked making ${email} bookable because Slate was already refreshing ${which} in ` +
    `another job at the same moment, so this attempt stood down rather than read it twice. ` +
    `Nothing is wrong with the account. The agent was NOT added to the booking pool yet: ` +
    `the hourly roster sync retries on its own, and nothing needs doing unless it keeps happening.`
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

/** A booking went to an agent who does not match the bucket. */
export function misrouteAlert(bookingId: string, bucketCode: string, agentId: string): string {
  return `Routing check: booking ${bookingId} in bucket ${bucketCode} went to agent ${agentId}, who does not match the bucket criteria, and no fallback was applied. This looks like a routing bug; the booking was allowed through. Inspect routing_decisions for this booking.`;
}

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
    // Not opened with "Slate": it now leads the whole alert (#2788), and Slack
    // already names the sender, so the fact worth having comes first.
    return `Reports from pages Slate does not serve (it could not count how many); latest:`;
  }
  const n = c.count === 1 ? "1 report" : `${c.count} reports`;
  return `${n} from pages Slate does not serve in the last ${c.windowMinutes} minutes; latest:`;
}

/** An unexpected server fault, reported without the raw error body. */
export function internalErrorAlert(context: string, detail: string): string {
  return `Unexpected server error on ${context} (${detail}). The caller got a generic 500. Full detail is in the Worker logs at level error.`;
}

/**
 * A browser reported an error from a page Slate serves, or from a path it does
 * not (#2788).
 *
 * Its own sentence because nothing returned a 500 here: the beacon answers 204,
 * and what the person saw was whatever their browser drew. `internalErrorAlert`
 * would send the reader looking for a route that failed, which did not happen
 * (L11). This names the page, which is where to look, and says plainly that the
 * report came from the page and not from the server.
 *
 * `surface` is the fixed vocabulary from `clientErrorSurface`, never request text.
 * For `other` the detail leads, because it opens with the count sentence
 * (`unrecognisedPageReports`, #2755) and the size of the storm is the fact that
 * decides whether anybody looks.
 */
export function browserErrorAlert(surface: string, detail: string): string {
  const notServer = "It came from the page itself, not from the server, so look at the page's code rather than a route.";
  if (surface === "other") {
    return `${detail}. A browser sent these itself; no page Slate serves is involved. Full detail is in the Worker logs at level error.`;
  }
  const where = surface === "root" ? "the home page (/)" : `a page under /${surface}`;
  return `A browser reported an error on ${where} (${detail}). ${notServer} Full detail is in the Worker logs at level error.`;
}

/** Where a surface from `clientErrorSurface` is, in words: one phrasing for every
 *  page level alert that names one. */
function surfacePlace(surface: string): string {
  if (surface === "root") return "the home page (/)";
  if (surface === "other") return "a page Slate does not serve";
  return `a page under /${surface}`;
}

/**
 * A burst of OPAQUE cross origin script errors on one page (#3323).
 *
 * A single one never pages: it is the browser's sanitised stand in for an error
 * thrown by a script from another site (an extension, a translator, an app's built
 * in browser), with the message, file and position all withheld, so nobody can act
 * on it. This is sent only once `threshold` different addresses have reported one
 * inside the window, which one lead's browser cannot do however often it reloads.
 *
 * It says what was counted and no more (L11): browsers at different addresses, not
 * people, and the threshold "or more" when the figure could not be read back, since
 * the burst itself was decided inside the increment. It carries no error text,
 * because there is none: the one phrase the browser sends is the same every time
 * and says nothing, so no error is passed in at all.
 */
export function opaqueScriptErrorBurstAlert(c: {
  surface: string;
  addresses: number | null;
  threshold: number;
  windowMinutes: number;
}): string {
  const many = c.addresses === null ? `${c.threshold} or more` : `${c.addresses}`;
  return (
    `Browsers at ${many} different addresses reported a script error with no detail on ${surfacePlace(c.surface)} ` +
    `in the last ${c.windowMinutes} minutes. A browser hides the detail when the script that failed came from ` +
    `another site, such as an extension, a translator or an app's built in browser, so the page's own code is ` +
    `probably not the cause, but this many at once can mean the page is failing for a whole group of leads. ` +
    `The log lines under tag=client-errors name the browser each report came from: open the page in that ` +
    `browser and try to book.`
  );
}

/**
 * A browser refused something on a Slate page under the ENFORCED content security
 * policy (#2575, Dan 2026-10-02: a throttled page).
 *
 * Every input is already reduced to a fixed vocabulary or a parsed origin
 * (`cspViolationPage`), because the report is posted by whoever likes to a public
 * endpoint: no URL path, no query string and no manage token can reach this, and
 * the full redacted report is in the log line beside it.
 *
 * It names both explanations rather than guessing between them (L11): the report
 * cannot say whether the policy is missing something Slate's page needs or the
 * policy just stopped something it exists to stop.
 */
export function cspViolationAlert(v: {
  directive: string;
  surface: string;
  blocked: BlockedResource;
  /**
   * Whether the report named a source script: under `script-src` the script that tried
   * it, elsewhere only the script running when the browser refused it (#4071). Only the
   * fact, never the URL: the report is a stranger's text, and the redacted URL is in the
   * log line.
   */
  sourceNamed?: boolean;
}): string {
  const what = describeBlocked(v.blocked, v.directive);
  const where = surfacePlace(v.surface);
  const rule = v.directive === "other" ? "under a rule Slate's policy does not name" : `under its ${v.directive} rule`;
  return (
    `A browser refused ${what} on ${where}, because the enforced content security policy does not allow it (${rule}). ` +
    `${refusalConsequence(v.directive, v.blocked, v.sourceNamed === true)} Either the policy is missing something the page needs, ` +
    "or it stopped something that should never have run. Every report is in the Worker logs under tag=csp-report."
  );
}

/**
 * What the refusal did to the page, which depends on what was refused.
 *
 * A refused file or address is one resource the browser blocked, and that is all the
 * report says: it never measured whether the page looked or worked any differently
 * without it, so the sentence claims no more (#3699, L11; it said "part of that page did
 * not load", about a Google logo an add-on had injected). A
 * refused `eval` or `inline` is different, and what it means depends on the rule:
 * under `script-src` some code was stopped from running, and under `style-src` some
 * styling was not applied. Anything else, the Trusted Types keywords included, gets
 * a neutral sentence, because no code was necessarily stopped. On 2026-10-04 the old
 * sentence told the alert channel part of the manage page had not loaded, about an
 * eval measured to come from code that page does not ship.
 *
 * It points at `source=` only when the report named one: a refusal can come from a
 * browser's own features or an extension, and many reports carry none, where
 * sending somebody to the field finds nothing. Under `script-src` the source is the
 * script that tried it. Elsewhere it is only the script that was RUNNING when the browser
 * refused the thing, never proof of what asked for it, because Chrome credits a load to
 * whatever script is on the stack when it fires (#4071, #4063, L799), so the pointer says
 * exactly that and no more (L11).
 */
function refusalConsequence(directive: string, b: BlockedResource, sourceNamed: boolean): string {
  if (b.kind !== "keyword") return "The browser blocked that one resource for whoever had it open.";
  const codeOrStyle = b.keyword === "eval" || b.keyword === "inline";
  const scripted = codeOrStyle && directive === "script-src";
  const pointer = !sourceNamed
    ? ""
    : scripted
      ? " source= on the log line names the script that tried it."
      : " source= on the log line names the script that was running when the browser refused it, not necessarily what asked for it.";
  if (scripted) return `Some code on that page was stopped from running for whoever had it open.${pointer}`;
  if (codeOrStyle && directive === "style-src") {
    return `Some of that page's styling was not applied for whoever had it open.${pointer}`;
  }
  return `Something on that page was refused for whoever had it open.${pointer}`;
}

function describeBlocked(b: BlockedResource, directive: string): string {
  switch (b.kind) {
    case "keyword":
      switch (b.keyword) {
        case "inline":
          // Under style-src an inline refusal is a style block or attribute, not code.
          return directive === "style-src" ? "inline styling" : "inline code";
        case "eval":
          return "code built from a string (eval)";
        case "wasm-eval":
          return "WebAssembly compilation";
        default:
          return "a Trusted Types assignment";
      }
    case "scheme":
      return `a ${b.scheme}: address`;
    case "origin":
      return `something from ${b.origin}`;
    case "unreadable":
      return "something at an address it could not read";
  }
}

/**
 * The copy for anything raised through `reportInternalError`: a server fault, or
 * a browser report riding the same chokepoint under `client_error:<surface>`.
 *
 * Decided HERE, from the key, rather than by each caller, so a browser report
 * cannot reach Slack claiming a 500 whichever route raised it (#2788).
 */
export function unexpectedFaultAlert(context: string, detail: string): string {
  const prefix = `${CLIENT_ERROR_KEY_PREFIX}:`;
  return context.startsWith(prefix)
    ? browserErrorAlert(context.slice(prefix.length), detail)
    : internalErrorAlert(context, detail);
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

/**
 * A sign in refused because its Google account is not the one the Slate account
 * belongs to (#3526).
 *
 * An incident: the refusal has already happened and nothing was handed over, so
 * there is no state to clear. The reader's question is who the person was, and
 * only somebody at Pennie can answer it, so the copy names the two ordinary
 * answers and the action for each. Never an account id, which nobody reading this
 * can use, and never an error: nothing failed.
 */
export function googleAccountMismatchAlert(email: string, reason: GoogleMismatchReason): string {
  return `${GOOGLE_MISMATCH_BODY[reason](email)} ${GOOGLE_MISMATCH_DIAGNOSE}`;
}

/** Where the detail is, the same for every reason (refused at sign in or on a later request). */
const GOOGLE_MISMATCH_DIAGNOSE =
  `Diagnose via msg="refused a different google account" (tag=auth-callback or tag=auth) in the Worker logs.`;

/** What happened and what to do, per reason, since each sends the reader somewhere else (L11). */
const GOOGLE_MISMATCH_BODY: Record<GoogleMismatchReason, (email: string) => string> = {
  "several-accounts": (email) =>
    `A sign in as ${email} was refused because two Google accounts are attached to it, ` +
    `which is what happens when someone new signs in with that address on top of its owner's sign in. ` +
    `Nobody was let in. Find out who the second account belongs to before anyone links a new account.`,
  "no-account-id": (email) =>
    `A sign in as ${email} was refused because Supabase did not say which Google account it was. ` +
    `Nobody was let in. If this repeats for other people, sign in itself is broken.`,
  "different-account": (email) =>
    `Somebody signed in as ${email} with a different Google account from the one that Slate account belongs to, ` +
    `so they were refused and given nothing. ` +
    `If that person is coming back on a new Google account, an admin can let them in with ` +
    `Link a new Google account under Account status on their page in Slate. ` +
    `If the address now belongs to someone new, do not link it, because linking gives them the old account's role and bookings; ` +
    `ask whoever looks after Slate to set them up.`,
};

/** What one advisor's taken out of the pool note says (#3700). */
export interface RefusedAdvisorLeftPool {
  name: string | null;
  email: string;
  managerName: string | null;
  /**
   * How Google refused the calendar. Only the two definitive kinds reach here;
   * `not-provisioned` is what archiving an account or removing its licence answers.
   */
  failure: "gone" | "not-provisioned";
  /** How long the calendar had been refused before Slate acted. */
  refusedForMs: number;
  /**
   * Pools this advisor was the only bookable one in, so nobody bookable is left in
   * them. Null when that could not be checked; empty when every pool kept someone.
   */
  poolsLeftEmpty: string[] | null;
}

/** "A", "A and B", "A, B and C". */
function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A sustained period as a person would say it: "an hour", "2 hours", "45 minutes". */
function refusedPeriod(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/**
 * An advisor was taken out of the booking pool because Google refuses their
 * calendar (#3700).
 *
 * An incident: Slate has done something, and the note says what, why and what
 * brings them back. The ongoing state is already spoken for: the activation the
 * pending mark owes is retried hourly, and `agents_awaiting_activation` names
 * anybody still waiting past its grace.
 *
 * Leads come first in the consequence because that is what a manager reads it for,
 * and an emptied pool is said outright: the advisor is removed either way (a refused
 * calendar cannot take a call), but the reader has to know nobody is left.
 */
export function refusedAdvisorLeftPoolAlert(a: RefusedAdvisorLeftPool): string {
  const who = a.name ? `${a.name} (${a.email})` : a.email;
  const why =
    a.failure === "not-provisioned"
      ? "Google says the account has no Calendar, which is what archiving it or removing its licence does"
      : "Google refuses the account outright, which usually means it was deleted or its access was revoked";
  const pools =
    a.poolsLeftEmpty === null
      ? " Slate could not check whether this leaves a pool with nobody bookable; /admin/tiers shows it."
      : a.poolsLeftEmpty.length > 0
        ? ` They were the only bookable advisor in ${listInWords(a.poolsLeftEmpty)}, which now ${
            a.poolsLeftEmpty.length === 1 ? "has" : "have"
          } nobody bookable.`
        : "";
  const manager = a.managerName ? ` Their manager is ${a.managerName}.` : "";
  return (
    `${who} has been taken out of the booking pool, so leads are no longer offered their times. ` +
    `Their Google calendar has been refused for over ${refusedPeriod(a.refusedForMs)}: ${why}.` +
    pools +
    manager +
    ` If they have left Pennie, nothing needs doing. Otherwise a Workspace admin restores the account ` +
    `(un-archive it, or give back its Google licence), and once every calendar of theirs reads again ` +
    `Slate puts them back in the pool within about an hour.`
  );
}

/** A held back stretch as a person would say it. */
function heldFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * The Google Calendar breaker opened (#3134): Google stopped answering, so calls
 * are held back and one test call goes through per window.
 *
 * Says what the reader will see while it holds, since that is what they get asked
 * about: leads told to try again, and calendar sync not refreshing. `lastFailure`
 * is already short (`shortErrorReason`, or a status and the call's name).
 */
export function googleBreakerOpenAlert(
  failures: number,
  lastFailure: string | null,
  openMs: number,
  /**
   * #3784: a Supabase stall this isolate saw in the same minutes (`recentStall`), with
   * the colo its answers came from, or null. Then both services were failing from one
   * location, and the page suspects the location before either (L774).
   */
  supabaseStall: { ms: number; colo: string | null } | null = null,
): string {
  const seconds = Math.round(openMs / 1000);
  const last = lastFailure ? ` (the last: ${lastFailure})` : "";
  const opening = supabaseStall
    ? breakerLocationFirst(failures, last, supabaseStall)
    : `Google Calendar is not answering: ${failures} calls in a row failed${last}. `;
  return (
    opening +
    `Slate is holding Google calls back and trying one every ${seconds} seconds. Until one succeeds, ` +
    "bookings ask the lead to try again in a moment and calendar sync is paused. " +
    "An all-clear follows when Google answers. Diagnose via tag=google-breaker in the Worker logs."
  );
}

/**
 * #3784: Google failing while Supabase stalled from the same isolate in the same
 * minutes. Placement runs every fetch beside Oregon (#3730), so a degraded location
 * there fails both at once; the page says so before it names either service.
 */
function breakerLocationFirst(failures: number, last: string, stall: { ms: number; colo: string | null }): string {
  const from = stall.colo ? ` from ${stall.colo}` : "";
  const head =
    `Google Calendar calls are failing, ${failures} in a row${last}, and Supabase calls${from} stalled in the same minutes ` +
    `(one took ${durationText(stall.ms)}). Two unrelated services rarely fail together, so`;
  const health = "and only then look at either service's health";
  if (stall.colo) {
    return `${head} suspect the Cloudflare location these calls ran from (${stall.colo}) before either service. Check Supabase's edge logs, by request.cf.colo, for other slow requests from ${stall.colo}, ${health}. `;
  }
  return (
    `${head} suspect the Cloudflare location these calls ran from before either service. The confirm answered log lines name it ` +
    `as supabase_edge_colo; check Supabase's edge logs, by request.cf.colo, for other slow requests from there, ${health}. `
  );
}

/** The breaker closed: a test call to Google succeeded (#3134). */
export function googleBreakerClosedAlert(openForMs: number): string {
  return (
    `Google Calendar is answering again: a test call succeeded after Google calls were held back for ${heldFor(openForMs)}. ` +
    "Bookings and calendar sync are sending calls to Google again."
  );
}
