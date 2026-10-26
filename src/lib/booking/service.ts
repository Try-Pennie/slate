import {
  startReroute,
  confirmReroute,
  releaseReroute,
  currentReroute,
  agentHeldFrom,
  RerouteRefusedError,
  type RerouteDeps,
  type RerouteOutcome,
  type RerouteProposal,
} from "@/lib/booking/reroute";
import { placeRerouteHold, releaseRerouteHold } from "@/lib/booking/reroute-hold-store";
import { rerouteHoldStoreDeps } from "@/lib/booking/reroute-hold-store-live";
import type { RerouteSwapRefusal } from "@/lib/db/reroute-hold-refusals";
import { readClaimedRerouteHold, rerouteReassignOutcome } from "@/lib/booking/reroute-wiring";
import { loadCurrentAgentPicture } from "@/lib/availability/service";
import { readLadderInputsLive } from "@/lib/availability/ladder-inputs-live";
import { reportWriteFailure } from "@/lib/db/result";
import { BOOKING_CONFIRM_WORST_CASE_MS } from "@/lib/booking/confirm-budget";
import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DEMO_BUCKET_CODE } from "@/lib/embed/public-test-bucket";
import { cancelDueDemoBookings, DEMO_AUTO_CANCEL_REASON } from "@/lib/booking/demo-auto-cancel";
import {
  leaseOutboxRow,
  saveOutboxStepsRow,
  markOutboxDeliveredRow,
  releaseOutboxLeaseRow,
  leaseReservationRow,
  releaseReservationLeaseRow,
} from "@/lib/booking/outbox-lease";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { settleDrainStuckAlert } from "@/lib/booking/drain-stuck-alert";
import {
  settleOwedReservationAlert,
  sweepExpiredReservations,
  type ExpiredReservation,
} from "@/lib/booking/reservation-retention";
import { selectAllPages } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { whereStillInPool } from "@/lib/bookable/left-pool";
import { gatedWriteApplied, gatedWriteRows } from "@/lib/booking/gated-write";
import { commitRescheduleArgs, readCommitReschedule } from "@/lib/booking/reschedule-commit";
import { appUrl } from "@/lib/env";
import {
  resolveBucketByCode,
  resolveBucketPool,
  roundRobinCandidates,
} from "@/lib/availability/service";
import {
  recomputeBucketSlotsForToday,
  readPoolInputsAfterBooking,
  refreshPoolOf,
  readSpliceInputsAfterBooking,
  spliceBookedTimeAfterBooking,
  getBucketSlotsWithFallback,
  refreshPoolsForAgents,
} from "@/lib/availability/slot-cache";
import {
  attendeeForLanding,
  knownContactFromBookings,
  type KnownContact,
  type KnownContactRow,
  type LandingAttendee,
  type LinkAttendee,
} from "@/lib/booking/known-lead";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { postConfirmRecomputeMode, postConfirmRefresh } from "@/lib/booking/post-confirm-recompute";
import { alertIfMisroute, recordRoutingDecision, routingDecisionRow } from "@/lib/routing/record";
import { judgeRefusedOfferLive } from "@/lib/booking/offer-race-live";
import {
  createEvent,
  createEventOnCalendar,
  deleteEvent,
  deleteEventOnCalendar,
  eventExists,
  freeBusy,
  freeBusyMany,
  isFree,
  updateEventTime,
  updateEventTimeOnCalendar,
  updateEventDescription,
  updateEventContact,
  getEventOnPrimary,
} from "@/lib/google/calendar";
import {
  insertOwnerAlert,
  loadLiveOwnerAlert,
  markOwnerAlertRemoved,
  recordOwnerAlertSkip,
  setOwnerAlertEventId,
} from "@/lib/booking/owner-alert-store";
import { loadAdvisorTimezone } from "@/lib/booking/owner-notice-store";
import { loadHandoffChannel, loadOwnerReassignNoticeOn } from "@/lib/handoffs/store";
import { postSlack } from "@/lib/notify/slack";
import {
  insertFailureLogFields,
  PAST_COMPLETION_BATCH_LIMIT,
  calendarIdsFromResult,
  freeAgentsFromBusy,
  busyIntervalsFromFreeBusy,
  chunkCalendarIds,
  type CalendarBusy,
  type ValidatedReason,
  type BookingActor,
  type BusyBlockInsert,
} from "@/lib/booking/core";
import {
  ACTIONABLE_ITEM_STATUSES,
  SKIPPED_ITEM_STATUSES,
  MOVED_ITEM_STATUSES,
  BULK_REASSIGN_LANE_LOCK,
  buildBulkReassignProgress,
  drainBulkReassign,
  drainOneJob,
  BookingMovedMidMoveError,
  type BulkReassignDeps,
  type BulkReassignDrainSummary,
  type BulkReassignProgress,
} from "@/lib/booking/bulk-reassign";
import {
  selectCoverageReassignTarget,
  type CoveragePlacement,
  type CoverageTargetDeps,
} from "@/lib/booking/coverage-target";
import { moveCoverageAcrossBuckets } from "@/lib/booking/coverage-cascade";
import { retryUnplaceableCoverage, type CoverageRetrySummary } from "@/lib/booking/coverage-retry";
import { coverageSweepActor, coverageSweepReason } from "@/lib/booking/coverage-sweep-actor";
import type { CoverageSweepCancelReport } from "@/lib/booking/coverage-sweep-cancel";
import { recordAudit } from "@/lib/audit";
import { acquireLease, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS } from "@/lib/google/sync-coalesce";
import { DEMOTION_SWEEP_REASON, type DemotionChange } from "@/lib/booking/demotion-plan";
import { MOVE_BACK_REASON_DETAIL, moveBackDemotionReroute, type MoveBackOutcome } from "@/lib/booking/demotion-revert";
import { loadDemotionMoves, markDemotionMoveReverted } from "@/lib/booking/demotion-revert-store";
import { reportDemotionSweepOutcome } from "@/lib/booking/demotion-outcome-report";
import {
  cancelCoverageSweepForRequest,
  claimBulkReassignItem,
  commitBulkReassignItemOutcome,
  coverageBookingIds,
  createBulkReassignJob,
  loadActionableBookingContext,
  loadBookingSnapshot,
  loadBulkReassignItems,
  loadBulkReassignJob,
  loadPendingBulkReassignItems,
  countPendingBulkReassignItems,
  loadRetryableUnplaceable,
  loadUserOrgId,
  markBulkReassignJobDoneIfDrained,
  reArmUnplaceableItems,
  type CoverageBookingRow,
  ACTIVE_BOOKING_STATUSES,
} from "@/lib/booking/bulk-reassign-store";
import { userIdsOnApprovedTimeOff } from "@/lib/ooo/approved-overlap";
import {
  reassignForContactOwner,
  type OwnerReassignGuardDeps,
} from "@/lib/booking/owner-reassign-guard";
import { handoffWriter } from "@/lib/handoffs/store";
import { recordHandoff, type RecordHandoffOutcome } from "@/lib/handoffs/record";
import {
  DuplicateCancelUnavailableError,
  duplicateHandoffDetail,
  parseDuplicateCancelResult,
  type DuplicateCancelResult,
} from "@/lib/booking/duplicate-cancel";
import type { ReassignAgent } from "@/lib/booking/reassign-agents";
import { mapWithConcurrency } from "@/lib/concurrency";
import * as orchestration from "@/lib/booking/orchestration";
import type {
  ActiveUpcomingBooking,
  ApiBookingInput,
  ApiBookingResult,
  ApiBookingPreview,
  BookingDeps,
  BookingResult,
  CreateBookingInput,
  ManageLookup,
  ReschedulePin,
  RescheduleClaim,
} from "@/lib/booking/orchestration";
import type { NamedWorld, PersonIdentity, PersonWorld } from "@/lib/booking/person-dedupe";
import type { EarlierLeadBookingRow } from "@/lib/booking/lead-id-from-bookings";
import { personStrongIds } from "@/lib/booking/person-dedupe";
import { readLeadXbcLive, readSubmissionLeadIdLive } from "@/lib/salesforce/lead-xbc";
import { timeSpentInThisRequest, type TimeSpent } from "@/lib/booking/time-spent";
import { callingNumberWithinDeadline, readCallingNumberLive } from "@/lib/salesforce/lead-calling-number";
import { bookingLeadId } from "@/lib/booking/lookup-identity";
import { toE164 } from "@/lib/phone";
import { escapeLike } from "@/lib/sql-like";
import { readPersonBookings, type PersonBookingRow } from "@/lib/booking/person-bookings-answer";
import { noEligibleAgentsAlert } from "@/lib/availability/bucket-coverage";
import { afterEnqueue, emitWebhook, suppressionByFormat, type WebhookSendScheduler } from "@/lib/webhooks/emit";
import { WEBHOOK_FORMATS } from "@/lib/webhooks/formats";
import { readCommitAnswer } from "@/lib/booking/commit-answer";
import { afterResponse, deferWebhookSend } from "@/lib/after-response";
import { pageAfterAnswer, type PageScheduler } from "@/lib/notify/post-commit-page";
import { DeadlineExceededError, findDeadlineExceeded, isDeadlineExceeded } from "@/lib/fetch-within-deadline";
import { GoogleBreakerOpenError } from "@/lib/google/breaker";
import { isDefinitiveFailure, reachabilityFromError } from "@/lib/google/reachability-classify";
import type { FailureKind } from "@/lib/google/sync-health";
import { sendThrottledAlert, sendThrottledInfo, resolveRecovered } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { strandedInviteAlert } from "@/lib/google/invite-move-copy";
import { isLoadtest } from "@/lib/loadtest-guard";
import {
  bookingEventInsertAlert,
  stalePhoneInviteAlert,
  phoneCorrectionUnsentAlert,
  busyBlockWriteThroughAlert,
  creationOrphanAlert,
  outboxDrainRecovery,
  outboxDrainStuckAlert,
  outboxAllHandedOffAlert,
  outboxHandoffRecovery,
  pendingDeletionAlert,
  pendingDeletionRecovery,
  refusedDeletionNotices,
  reassignIntentDroppedAlert,
  reconcileFreedAlert,
  reconcileRecreatedAlert,
  reschedulePinDroppedAlert,
  rescheduleLockOutageAlert,
  reservationRollbackAlert,
  verifyOutageAlert,
  dependencyTimeoutAlert,
  reservationCreatedOwedAlert,
  reservationCreatedOwedRecovery,
  reservationDrainRecovery,
  reservationDrainStuckAlert,
  verifyReadFailedAlert,
  type TimeoutReach,
} from "@/lib/booking/alert-copy";
// #1135: the one way an error reaches alert copy. A Postgres error message can be
// long and multi-line (a constraint body, a nested detail), and a page is read on
// a phone; the full text stays in the log line beside each of these alerts.
import { shortErrorReason, shortFailureReason } from "@/lib/notify/error-text";
import type {
  Booking,
  BookingEventInitiator,
  BookingStatus,
  BookingOutbox,
  BookingReservation,
  Bucket,
  EventType,
  RoutingTrace,
  User,
} from "@/lib/db/types";
import { processBookingOutbox, everyLeasedRowStoodDown, runOutboxSteps } from "@/lib/booking/outbox";
import { drainBackoffMs, DRAIN_GIVE_UP_AT, DRAIN_ALERT_AFTER } from "@/lib/booking/drain-backoff";

const CACHE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// A reschedule finishes in seconds; this TTL only governs reclaiming a lock
// orphaned by a torn-down Worker, so keep it comfortably above the slowest run.
const RESCHEDULE_LOCK_TTL_MS = 2 * 60 * 1000;
// Extra buffer past lease expiry before the GC sweep treats a pin as abandoned
// (#439) — well clear of any in-flight retry that's about to take over the lease.
const ABANDONED_PIN_GRACE_MS = 2 * 60 * 1000;
// #518 reassign-intent lease. Pinned well above any real createEvent+swap+
// delete-old wall-clock so the sweep (which only fires past lease + grace, ~4 min
// total) can never mistake a slow-but-alive reassign for an abandoned one.
const REASSIGN_INTENT_LEASE_MS = 2 * 60 * 1000;
// Lease held while a drain processes one outbox row; only governs reclaiming a
// row orphaned by a torn-down Worker, so keep it above the slowest single-row run.
const OUTBOX_DRAIN_LIMIT = 50;
// Reservation drain bounds (#429 P4). Crash-during-create is rare, so a small cap
// with a multi-tick backlog is fine; bounds Worker CPU. Retention deletes abandoned
// pending reservations older than the TTL, except one whose booking committed with
// booking.created still owed (#3847), which it keeps and pages about. The lease
// length lives with the lease (RESERVATION_LEASE_TTL_MS in outbox-lease.ts), which
// derives the release from it.
const RESERVATION_DRAIN_LIMIT = 15;
const RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;
// #3847: a kept owed reservation pages once a day. The drain's own stuck page
// already speaks hourly while it is still retrying the row; this is the one that
// still speaks after the drain gives up on it (DRAIN_GIVE_UP_AT), without becoming
// a second hourly page about the same booking.
const RESERVATION_OWED_ALERT_KEY = "reservation_created_owed";
const RESERVATION_OWED_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * How old a pending reservation must be before the drain takes it (#3466).
 *
 * A lead's confirm writes its reservation and then goes on completing it, and the
 * row used to be drainable the moment it existed, so the every minute drain could
 * lease and complete, or roll back, a reservation the confirm that wrote it was
 * still working on. The two writers are each idempotent, but nothing coordinated
 * them, least of all on a lost race, where the confirm rolls its reservation back
 * and reserves again for the next advisor.
 *
 * Every reservation is written inside a booking request's budget
 * (`withinBookingRequest`), so a confirm is done with it within
 * `BOOKING_CONFIRM_WORST_CASE_MS` of starting. That worst case counts only time
 * spent WAITING on calls, though: the design leaves the rest of the booker's 20
 * seconds for computation no budget can see, and the drain compares a Worker's
 * clock against Postgres's `created_at`. Twice the worst case clears both, and still
 * sits under one tick of the drain, so a reservation a crash really left behind is
 * resumed on the next tick but one. Pinned by service-reservation-drain-read.test.ts.
 */
export const RESERVATION_DRAIN_MIN_AGE_MS = 2 * BOOKING_CONFIRM_WORST_CASE_MS;
// Throttle the "drain rows are stuck" Slack alert (#445) so a persistently-
// failing row alerts at most twice an hour, not every tick.
const DRAIN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// #1048: a tick where EVERY leased row stood down charges no attempt to any row, so
// it can never reach the attempt-cap alert. Five consecutive ticks on a lane that
// runs every minute: long enough that one genuine overlap with the inline path stays
// quiet, short enough that a drain delivering nothing is named within minutes. The
// window comfortably exceeds the lane's interval so consecutive ticks land in one
// window rather than each looking like the first.
const OUTBOX_HANDOFF_STREAK_KEY = "outbox_all_handed_off";
const OUTBOX_HANDOFF_STREAK_WINDOW_S = 15 * 60;
const OUTBOX_HANDOFF_ALERT_AFTER = 5;

const VERIFY_READ_ALERT_KEY = "verify_on_book_calendars_read";
const VERIFY_READ_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// Fires when a booking/reschedule FAILS because no candidate could be verified
// (a likely verify-on-book outage), as opposed to a genuinely full slot (#319).
const VERIFY_OUTAGE_ALERT_KEY = "verify_on_book_outage";
const VERIFY_OUTAGE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// Fires when a live booking hits a bucket with NO eligible agents — the reactive
// half of the routing dead-zone monitor (#327); the proactive hourly sweep is in
// availability/service.ts.
const NO_ELIGIBLE_AGENTS_ALERT_KEY = "no_eligible_agents";
const NO_ELIGIBLE_AGENTS_COOLDOWN_MS = 60 * 60 * 1000;

// Fires when a reschedule fails CLOSED because the per-booking lock claim hit an
// unexpected DB error (not a real conflict) (#479). Before #479 this reached
// internalErrorResponse (a generic 500 that alerts per route); now it maps to a
// typed 503 earlier, so the outage alert must live here or it would be dropped.
const RESCHEDULE_LOCK_OUTAGE_ALERT_KEY = "reschedule_lock_outage";
const RESCHEDULE_LOCK_OUTAGE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// Google caps a freeBusy query at 20 calendar `items`. The constant moved into
// `core.ts` with #2412, when the single agent reader started chunking too: two
// copies of one platform limit drift, and the reader that never chunked answered
// `tooManyCalendarsRequested` as free time. Re-exported here because callers
// (the availability truth probe) already import it from this module.
export { FREEBUSY_MAX_ITEMS } from "@/lib/booking/core";
// Max simultaneous freeBusy calls (Cloudflare's simultaneous-connection ceiling,
// same bound the completion-sweep webhook fan-out uses).
const VERIFY_CONCURRENCY = 6;

/**
 * #3313: a read refused because a deadline ran out is not a read that failed.
 *
 * PostgREST never throws, so a Supabase call cut short by the confirm's budget
 * comes back as an `error` like any other, and the calendar lookups below answer
 * every error with `readFailed`, which verify on book scores as an unverified
 * agent and pages as "likely a Google/DB outage". With no time left, nothing a
 * fallback asks can answer either, so the deadline itself is thrown, and the
 * booking path classifies it as the dependency timeout it is
 * (`timeoutAsRetryable`). Any other error is left to the caller's own path.
 */
function throwIfDeadline(error: unknown): void {
  if (!error) return;
  const found = findDeadlineExceeded(error);
  if (!found) return;
  const deadline = new DeadlineExceededError(found.label, found.timeoutMs, found.budget);
  deadline.cause = error;
  throw deadline;
}

/**
 * Calendar ids whose busy blocks an agent, looked up by their email (#314).
 * Reports `readFailed` so verify-on-book can tell a real DB error apart from a
 * genuine empty: on an error we must NOT silently fall back to checking only the
 * primary calendar (it could miss a conflict on a secondary one and double-book).
 * A deadline is thrown instead (`throwIfDeadline`, #3313).
 */
export async function calendarIdsForEmail(
  email: string,
): Promise<{ readFailed: boolean; ids: string[] }> {
  const db = supabaseAdmin();
  const userRes = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  throwIfDeadline(userRes.error);
  if (userRes.error) return { readFailed: true, ids: [] };
  if (!userRes.data) return { readFailed: false, ids: [] };
  const calsRes = await db
    .from("agent_calendars")
    .select("calendar_id")
    .eq("user_id", (userRes.data as { id: string }).id);
  throwIfDeadline(calsRes.error);
  return calendarIdsFromResult(calsRes);
}

/**
 * Batched cousin of `calendarIdsForEmail` for the verify-on-book wave: resolves
 * EVERY candidate's concrete calendar ids in two `.in()` queries (one users, one
 * agent_calendars) instead of two per agent. Returns each email's calendar ids
 * (their primary calendar id IS their email; secondaries come from
 * agent_calendars), plus the set of emails whose read FAILED — those route to the
 * accurate per-agent fallback rather than being assumed free (#314). A query
 * error fails the whole wave's reads (the caller falls back per agent).
 *
 * Note: the bulk freeBusy is read as ONE identity, so calendar ids must be
 * CONCRETE (the agent's email / real calendar id) — never the literal "primary",
 * which would resolve to the impersonator's own calendar.
 */
export async function calendarsForEmails(
  emails: string[],
  /**
   * #3495: each email's advisor id, when the caller already holds them (a confirm read
   * its advisors by id a moment ago). With every one given, the advisors are not read
   * again by email; with any missing, they all are, so no id is guessed.
   */
  ids?: ReadonlyMap<string, string>,
): Promise<{ byEmail: Map<string, string[]>; readFailed: Set<string> }> {
  const byEmail = new Map<string, string[]>();
  const readFailed = new Set<string>();
  if (emails.length === 0) return { byEmail, readFailed };

  const db = supabaseAdmin();
  let userRows: { id: string; email: string }[];
  if (ids && emails.every((e) => ids.has(e))) {
    userRows = emails.map((e) => ({ id: ids.get(e)!, email: e }));
  } else {
    const usersRes = await db
      .from("users")
      .select("id, email")
      .in("email", emails);
    throwIfDeadline(usersRes.error);
    if (usersRes.error) {
      // Can't map any agent to their calendars, so fall back per agent for all.
      for (const e of emails) readFailed.add(e);
      return { byEmail, readFailed };
    }
    userRows = (usersRes.data ?? []) as { id: string; email: string }[];
  }
  const idByEmail = new Map(userRows.map((r) => [r.email, r.id]));

  const calsRes = await db
    .from("agent_calendars")
    .select("user_id, calendar_id")
    .in(
      "user_id",
      userRows.map((r) => r.id),
    );
  throwIfDeadline(calsRes.error);
  if (calsRes.error) {
    for (const e of emails) readFailed.add(e);
    return { byEmail, readFailed };
  }
  const calsByUser = new Map<string, string[]>();
  for (const row of (calsRes.data ?? []) as {
    user_id: string;
    calendar_id: string;
  }[]) {
    const list = calsByUser.get(row.user_id) ?? [];
    list.push(row.calendar_id);
    calsByUser.set(row.user_id, list);
  }

  for (const email of emails) {
    const userId = idByEmail.get(email);
    const cals = userId ? calsByUser.get(userId) : undefined;
    // Clean empty (pre-first-sync) or unknown user → the email IS the primary
    // calendar id, which the bulk query can read cross-identity.
    byEmail.set(email, cals && cals.length ? cals : [email]);
  }
  return { byEmail, readFailed };
}

/**
 * #3845: one agent's own calendar read, where a read that FAILED OUTRIGHT (Google
 * answering the call with a 5xx, a refused token, a network error) is `null`, "could
 * not tell", exactly like a calendar Google answered with an error inside its 200.
 *
 * Both callers already handle `null` (the booker scores the agent unverified and
 * re-routes; the reschedule guard re-routes), but a throw escaped them: on the booker
 * it took every other candidate in the wave with it and the lead got a 500, where the
 * design is a re-route or a retriable 503. The load run's fault pass was the first
 * thing to reach it, once it faulted the bulk wave that hands agents to this read.
 *
 * Two failures still propagate, because each has its own classification further up
 * and an unverified agent would hide it: a deadline (#3313, the dependency timeout)
 * and the open breaker (#3134, already the retriable outage for the whole confirm).
 *
 * The reschedule guard's read; the booker's goes through `readAgentCalendar`, which
 * also says when Google refused the agent (#3700). Here a refusal is `null` too: the
 * guard re-routes on it, which is what an advisor Google refuses needs.
 */
async function unlessReadFailed<T>(email: string, read: () => Promise<T | null>): Promise<T | null> {
  const outcome = await readAgentCalendar(email, read);
  return outcome.refused ? null : outcome.value;
}

/**
 * #3700: one agent's own calendar read, telling a read Google REFUSED apart from one
 * that could not tell.
 *
 * A refusal is a definitive failure (`isDefinitiveFailure`, so both a gone account and
 * `403 notACalendarUser`): the account was archived or removed from the Workspace, its
 * delegation revoked, or it was never given Calendar. No retry fixes that, so the
 * booker leaves the agent out of the wave and books the next free one, and a wave with
 * nobody else is the ordinary no availability refusal. Scored `unverified`, as #3845
 * left it, it was the retriable outage: the lead was told to try again for a slot no
 * retry can fix, and a pool of one archived advisor paged as a Google outage. The sync
 * lane already pages the account itself (`last_failure_kind`); this line is what says
 * a confirm met it.
 *
 * Anything else that fails the read is `{ value: null }`, could not tell, as before.
 */
type AgentRead<T> = { refused: false; value: T | null } | { refused: true; failure: FailureKind };

async function readAgentCalendar<T>(email: string, read: () => Promise<T | null>): Promise<AgentRead<T>> {
  try {
    return { refused: false, value: await read() };
  } catch (err) {
    if (findDeadlineExceeded(err) || err instanceof GoogleBreakerOpenError) throw err;
    const failure = reachabilityFromError(err);
    if (isDefinitiveFailure(failure)) {
      log.warn(
        "booking",
        { msg: "Google refused the agent's calendar read, so they cannot take the time", email, failure },
        err,
      );
      return { refused: true, failure };
    }
    log.error("booking", { msg: "agent calendar read failed, reporting it could not tell rather than free", email }, err);
    return { refused: false, value: null };
  }
}

/** Outcome of a single agent verify: confirmed free, confirmed busy, or (when a
 *  calendar couldn't be read) unverifiable (#319). `unverified` is never treated
 *  as free (no double-book) and lets the caller flag a likely outage. `refused` is
 *  Google refusing the agent outright (#3700, `readAgentCalendar`): never free, and
 *  never an outage either, so the wave moves on to the next advisor. */
type AgentVerdict = "free" | "busy" | "unverified" | "refused";

/**
 * Direct per agent verify (impersonates the agent, checks all their calendars):
 * the accurate fallback for the bulk verifier when a calendar couldn't be read in
 * the cross-identity batch (#314) or the bulk call failed wholesale. A
 * calendar-read failure yields `unverified` (skip + alert) instead of being
 * conflated with `busy`, so a verify-on-book outage is distinguishable from a
 * genuinely full slot (#319). A read Google refuses outright (a definitive
 * failure, #3700) yields `refused` instead: no retry fixes it, so it is not an
 * outage, and the agent simply cannot take the time.
 */
async function checkAgentFree(
  email: string,
  startIso: string,
  endIso: string,
  ignore?: { start: string; end: string },
): Promise<AgentVerdict> {
  const { readFailed, ids } = await calendarIdsForEmail(email);
  if (readFailed) {
    await sendThrottledAlert(
      VERIFY_READ_ALERT_KEY,
      VERIFY_READ_ALERT_COOLDOWN_MS,
      verifyReadFailedAlert("book", email),
    ).catch(logAlertSendFailure(VERIFY_READ_ALERT_KEY));
    return "unverified";
  }
  // #2412: `null` is Google's per calendar failure inside a 200 response (an
  // `errors[]` entry, or a requested calendar the reply never mentions). It is
  // NOT a yes. This is the fallback the bulk wave hands an agent to precisely
  // because it could not read one of their calendars, so answering "free" here
  // would book the lead over whatever that calendar held.
  const read = await readAgentCalendar(email, () => isFree(email, startIso, endIso, ids.length ? ids : ["primary"], ignore));
  if (read.refused) return "refused";
  if (read.value === null) return "unverified";
  return read.value ? "free" : "busy";
}

/**
 * Verifies a set of agents ONE AT A TIME against their own calendars, and folds
 * the verdicts into the free / unverified sets `verifyFree` answers with.
 *
 * This is the fallback half of verify on book, split out so there is one place
 * that turns an `AgentVerdict` into those sets (#2412). `unverified` must never
 * land in `free`: it is the answer for an agent whose calendars could not be
 * read, and the booker surfaces it as a retriable outage rather than assigning
 * the slot. A `refused` agent (#3700) lands in neither set, exactly like a busy
 * one: they cannot take the time. It is reported in `refused` too, so the wave's
 * caller can tell a wave Google refused ENTIRELY (`wholeWaveRefused`) from a full one.
 */
export async function verifyAgentsDirectly(
  emails: string[],
  startIso: string,
  endIso: string,
): Promise<{ free: Set<string>; unverified: Set<string>; refused: Set<string> }> {
  const free = new Set<string>();
  const unverified = new Set<string>();
  const refused = new Set<string>();
  if (emails.length === 0) return { free, unverified, refused };
  const verdicts = await mapWithConcurrency(emails, VERIFY_CONCURRENCY, (email) =>
    checkAgentFree(email, startIso, endIso),
  );
  emails.forEach((email, i) => {
    if (verdicts[i] === "free") free.add(email);
    else if (verdicts[i] === "unverified") unverified.add(email);
    else if (verdicts[i] === "refused") refused.add(email);
  });
  return { free, unverified, refused };
}

/**
 * #3700: did Google refuse EVERY advisor in a wave of two or more?
 *
 * One refused advisor is an offboarded account, and leaving them out is right. Every
 * advisor in a wave refused at once is far likelier to be Slate's own credential: the
 * shared classifier calls any 400, 401, 403 or 404 a definitive failure, so delegation
 * revoked, a bad service account key or a clock skewed `invalid_grant` on the mint
 * refuses everybody alike. Read as refusals, that outage would answer every lead "pick
 * another time", walk the ladder down, and page nobody, so the caller scores the whole
 * wave unverified instead: the retriable outage, which pages as `verify_on_book_outage`.
 * A wave of exactly one refused advisor stays a refusal, because that is the archived
 * one person pool this issue is about, and one advisor cannot tell the two apart.
 */
function wholeWaveRefused(waveSize: number, refused: number): boolean {
  return waveSize >= 2 && refused === waveSize;
}

/**
 * Live busy intervals (epoch-ms) across ALL of one agent's calendars over the
 * window — the in-place reschedule guard's read (#536). Resolves the agent's
 * calendars the same way the per-agent verify does; on a calendar-read failure it
 * alerts and returns `null` so the guard re-routes rather than risk keeping an
 * agent on an unverifiable slot (the same SAFE default the old `isFree` path had).
 *
 * Exported so it can be driven beside `verifyAgentsDirectly` (#2412): the two are
 * the reschedule and the booking halves of ONE question, they read the same
 * Google reply, and a per calendar error inside a 200 has to mean the same thing
 * to both. It reaches the orchestration as `busyIntervalsForAgent`.
 */
export async function agentBusyIntervals(
  email: string,
  fromIso: string,
  toIso: string,
): Promise<{ start: number; end: number }[] | null> {
  const { readFailed, ids } = await calendarIdsForEmail(email);
  if (readFailed) {
    await sendThrottledAlert(
      VERIFY_READ_ALERT_KEY,
      VERIFY_READ_ALERT_COOLDOWN_MS,
      verifyReadFailedAlert("reschedule", email),
    ).catch(logAlertSendFailure(VERIFY_READ_ALERT_KEY));
    return null;
  }
  const busy = await unlessReadFailed(email, () => freeBusy(email, fromIso, toIso, ids.length ? ids : ["primary"]));
  // #2412: null here is a calendar Google would not report on (an `errors[]`
  // entry inside its 200, or a calendar missing from the reply). The guard
  // re-routes on it, which is the whole point: an unread calendar must not keep
  // an agent on a slot nothing verified.
  if (busy === null) return null;
  // #1171: an unreadable interval yields null ("could not tell"), which the
  // caller already re-routes on, rather than a NaN interval that can never
  // overlap and so presents as free time.
  return busyIntervalsFromFreeBusy(busy);
}

export {
  SlotUnavailableError,
  RaceLostRefusalError,
  LostRaceOutOfTimeError,
  ExistingCallError,
  ExistingCallCheckUnavailableError,
  RescheduleConflictError,
  ContactRefusedError,
  AttendeeEmailRefusedError,
  VerifyUnavailableError,
  RescheduleLockUnavailableError,
  NoEligibleAgentsError,
  DailyCapExceededError,
  UnknownBucketError,
  OutsideCallingWindowError,
  BookingNotFoundError,
  BookingNotCancellableError,
  AgentNotAvailableError,
  ReassignAcrossWorldsError,
  BookingNotChangeableError,
} from "@/lib/booking/orchestration";
import { log } from "@/lib/log";
import { REBOOK_COLUMNS, loadRebookRow, type RebookLookup } from "@/lib/booking/book-link";
import { pageRaceBoundHitAfterResponse } from "@/lib/booking/race-bound-page";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { resolveAdvisorName, type AdvisorNameReader } from "@/lib/booking/advisor-name";
import { resolveBookingAdvisorPhoto } from "@/lib/booking/advisor-photo";
import { loadPhotoRecords, loadUserSignInPhoto } from "@/lib/advisor-photos/store";
import { makeConfirmQueue, isolateLine } from "@/lib/booking/confirm-queue";
import { makeCommitCostLog } from "@/lib/booking/commit-cost";
import { confirmLineFor, lineGroupOfLive, settleLineGrouping } from "@/lib/booking/confirm-line-live";
import type { ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import { timeStage } from "@/lib/booking/confirm-profile";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";
export type { BookingResult, CreateBookingInput };
export type { ExistingCall } from "@/lib/booking/orchestration";
export type { BookingActor } from "@/lib/booking/core";

/**
 * The one busy_blocks INSERT path, for a single write-through block or a whole
 * reconcile batch (#762).
 *
 * The booking/cancel itself already succeeded when this runs, so a cache write
 * failure must not fail the request, but it cannot stay silent either (#34): a
 * missed insert lets the embed keep offering a booked slot until sync mirrors the
 * Google event (~1 min). Retry once, then log + throttled Slack alert.
 *
 * `deferPage` (#3266) is set on a lead's request only: the page is then sent after
 * the response, so the lead's answer never waits on it. Today only the reconcile
 * sweep, a cron drain, inserts blocks, and there it is sent inline.
 */
export async function insertBusyBlocksWithRetry(blocks: BusyBlockInsert[], deferPage?: PageScheduler): Promise<void> {
  if (blocks.length === 0) return;

  // #770: the sweep re-creates blocks for bookings that looked block-less a moment
  // ago, and a booking's own move_busy_block can land in that gap. Under the
  // UNIQUE (booking_id) index a plain insert would then 23505 and take the whole
  // batch down with it, so defer to the winner: the row already exists and is
  // correct, and re-creating it is exactly what we no longer want to do.
  const write = () =>
    supabaseAdmin()
      .from("busy_blocks")
      .upsert(blocks, { onConflict: "booking_id", ignoreDuplicates: true });

  let { error } = await write();
  if (error) {
    ({ error } = await write());
  }
  if (!error) return;

  const ids = blocks.map((b) => b.booking_id).join(", ");
  const what = blocks.length === 1 ? `booking ${ids}` : `${blocks.length} bookings (${ids})`;
  log.error("booking", { msg: "busy_blocks insert failed", what }, error);
  const reason = shortFailureReason(error.message) ?? "no detail";
  await pageAfterAnswer(deferPage, "busy-block-page", () =>
    sendThrottledAlert(
      "busy_block_write_through",
      CACHE_ALERT_COOLDOWN_MS,
      busyBlockWriteThroughAlert("insert", what, reason),
    ).catch(logAlertSendFailure("busy_block_write_through")),
  );
}

/**
 * An agent's OTHER active bookings in a window (#536), as epoch ms, excluding the
 * booking being moved. The in-place reschedule and reassign guards count these
 * against the event type's daily cap.
 *
 * Fails loud (#1152). This used to return [] on a read error, annotated as the
 * safe default that made the guard re-route. It was not: `busyIntervalsForAgent`
 * returns NULL for "could not tell" and the guard re-routes on that, but [] here
 * is a real answer meaning "no other bookings that day", which is under every cap.
 * A read blip therefore waved a booking past a cap it may well have exceeded. An
 * unknown count must stay unknown, so the caller aborts (before any Google event
 * is created) rather than granting a silent exemption.
 */
export async function agentActiveBookingStartsMs(
  userId: string,
  fromIso: string,
  toIso: string,
  excludeBookingId: string,
): Promise<number[]> {
  const data = unwrap(
    await supabaseAdmin()
      // cap-safe: one agent's active bookings within the reschedule window (the daily cap count).
      .from("bookings")
      .select("starts_at")
      .eq("assigned_user_id", userId)
      .in("status", ["confirmed", "rescheduled"])
      .gte("starts_at", fromIso)
      .lt("starts_at", toIso)
      .neq("id", excludeBookingId),
    "agentActiveBookingStartsMs",
  );
  return ((data as { starts_at: string }[] | null) ?? []).map((r) => Date.parse(r.starts_at));
}

/**
 * Every ACTIVE booking that could belong to this person (#357), for every identity
 * signal the caller supplied, in ONE request (#3476).
 *
 * It used to send one request per signal: each strong id against `external_id` and
 * again against `salesforce_id`, the email and the phone, so a typical confirm sent
 * four and a 100 confirm crowd about 400, and request count is what queues a crowd in
 * the API layer (#3492). `find_active_bookings_for_person` (migration 0175) answers
 * them all with the same rules, proved against the old reads signal by signal in a
 * real Postgres (scripts/verify-person-bookings-sql.ts): each strong id against BOTH
 * id columns (#2663), the email case insensitively with its LIKE metacharacters
 * escaped (#620), the phone exactly as E.164, active statuses, at most 20 rows per
 * signal. The values travel as parameters, never as filter text.
 *
 * **It throws on a failed read (#1641).** Empty here is not "no failure", it is the
 * specific answer "this lead has no call booked", and that is the one answer that
 * lets a SECOND booking be created for somebody who already has one: the dedupe gate
 * passes, the round robin assigns an agent, a calendar invite goes out, and the
 * webhooks fire. So an answer that cannot be read is refused too (`readPersonBookings`).
 *
 * Which bookings MATCH is decided downstream by `findPersonMatch`; this only decides
 * which rows are fetched, and the ids are the same set the grader uses
 * (`personStrongIds`), so the fetch and the grade cannot disagree.
 *
 * **Scoped to ONE world (#2660).** Only bookings whose bucket's `is_test` equals the
 * world the caller is in. A test booking (the canary's, or a partner's on the public
 * test bucket) and a real booking are never the same person's calls: without this a
 * tester who typed a real lead's id was shown that lead's name, number and a Cancel on
 * their real call, and a test booking under an address refused the real lead who owns
 * it. The canary's cross bucket dedupe (SMOKE against SMOKE2, both test) still sees
 * both, because both are in the test world.
 */
export async function findActiveBookingsForPerson(
  identity: PersonIdentity,
  world: PersonWorld,
): Promise<Booking[]> {
  const ids = personStrongIds(identity);
  const email = identity.email?.trim() || null;
  const phone = toE164(identity.phone) ?? null;
  if (ids.length === 0 && !email && !phone) return [];
  const rows = await activeBookingsBySignals(
    { ids, emailLike: email ? escapeLike(email) : null, phone },
    "bucketCode" in world ? { bucket: world.bucketCode } : world.isTest ? "test" : "real",
    "person booking lookup",
  );
  // The world did its work in the read; the callers grade a Booking (#2660).
  return rows.map(({ isTest: _world, ...booking }) => booking as unknown as Booking);
}

/**
 * How many earlier bookings the advisor link Lead id read takes (#3739). Bounded,
 * so the read can never come back as a truncated page read as the whole set; a
 * lead with more than this many bookings under one email and phone is answered
 * from the newest, and a conflict among those still saves none.
 */
const EARLIER_LEAD_BOOKING_ROWS = 20;

/**
 * Earlier bookings, in ANY status, that hold BOTH this email (case insensitively,
 * escaped, #620) and this phone (as E.164) and carry a lead id, in one world
 * (#2660): the read behind an advisor link booking's Lead id when its link carried
 * none (#3739). Any status, because the bookings that carry the id are usually
 * calls that already happened (completed) or were moved (cancelled): the only
 * advisor link booking without an id when this was built had a cancelled and a
 * completed one.
 *
 * Not served by an index: the person lookup indexes (0043) are partial on active
 * rows. Measured 2026-10-21 at 25ms over 13,446 bookings, and it runs only on an
 * advisor link confirm with no id on the link (3 advisor link bookings so far), so
 * an index waits until that volume or the table justifies one. THROWS on a failed
 * read; the confirm then books with no id.
 */
export async function earlierLeadBookings(
  contact: { email: string; phone: string },
  world: NamedWorld,
): Promise<EarlierLeadBookingRow[]> {
  const email = contact.email.trim();
  const phone = toE164(contact.phone);
  if (!email || !phone) return [];
  const rows = unwrap(
    await supabaseAdmin()
      .from("bookings")
      .select("id, created_at, salesforce_id, external_id, attendee_email, attendee_phone, assigned_user_id, buckets!inner(is_test)")
      .eq("buckets.is_test", world.isTest)
      .ilike("attendee_email", escapeLike(email))
      .eq("attendee_phone", phone)
      .or("salesforce_id.not.is.null,external_id.not.is.null")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(EARLIER_LEAD_BOOKING_ROWS),
    "advisor link earlier bookings",
  ) as (EarlierLeadBookingRow & { buckets?: unknown })[] | null;
  return (rows ?? []).map(({ buckets: _world, ...row }) => row);
}

/**
 * The one read behind the person check and the lookup API (#3476): every signal at
 * once, in the named world, refused rather than guessed when it fails or cannot be read.
 */
async function activeBookingsBySignals(
  signals: { ids: readonly string[]; emailLike: string | null; phone: string | null },
  /** A named world, or the world of the bucket with this code (#3489). */
  world: "real" | "test" | "both" | { bucket: string },
  context: string,
): Promise<PersonBookingRow[]> {
  const data = unwrap(
    await supabaseAdmin().rpc("find_active_bookings_for_person", {
      p_ids: [...signals.ids],
      p_email_like: signals.emailLike,
      p_phone: signals.phone,
      ...(typeof world === "string" ? { p_world: world } : { p_world: "bucket" as const, p_bucket_code: world.bucket }),
    }),
    context,
  );
  return readPersonBookings(data);
}

/**
 * The active booking holding an idempotency key, at most one by the partial unique
 * index. Active only, matching that index, so a cancelled booking never blocks (or
 * gets returned for) a fresh rebook of the same slot. One query behind both readers:
 * the probe that fails open and the read back that throws (#3495).
 */
function activeBookingByIdempotencyKey(key: string) {
  return supabaseAdmin()
    .from("bookings")
    .select("*")
    .eq("idempotency_key", key)
    .in("status", ["confirmed", "rescheduled"])
    .maybeSingle();
}

/**
 * The most active bookings one instant can hold and still be read whole (#3257).
 * The bookings unique index allows one active booking per advisor per start, so
 * this is a roster bound (100 to 200 advisors by design) with room to spare.
 */
const SEATED_AT_LIMIT = 500;

/**
 * Every active booking that starts at `startIso`, in any bucket and either world
 * (#3257). Read once by a confirm whose verdict settles its slot, so a waiting
 * confirm from a lead who already holds the time is not told it is taken. Both
 * worlds and every bucket on purpose: a lead re-tiered into this pool still holds
 * the time in their old one (#1465), and a match here only makes that confirm run
 * its own person check, which is world scoped as always (#2660).
 *
 * Served by `bookings_starts_at_id_idx`. THROWS on a read error, and on a full
 * page, which would mean the list may be missing the very booking it is read to
 * find; the caller then settles nothing rather than refusing anybody on it.
 */
export async function findActiveBookingsStartingAt(startIso: string): Promise<Booking[]> {
  const rows = unwrap(
    await supabaseAdmin()
      .from("bookings")
      .select("*")
      .eq("starts_at", startIso)
      .in("status", ["confirmed", "rescheduled"])
      .limit(SEATED_AT_LIMIT),
    "bookings seated at an instant",
  ) as Booking[] | null;
  const seated = rows ?? [];
  if (seated.length >= SEATED_AT_LIMIT) {
    throw new Error(`bookings seated at an instant: ${seated.length} rows reached the ${SEATED_AT_LIMIT} row bound, so the list may be incomplete`);
  }
  return seated;
}

/**
 * Every ACTIVE booking whose `external_id` OR `salesforce_id` is any of `ids`, for the
 * lookup API (#2657), in ONE request through the same function as the person check
 * (#3476), with each id matched against both columns as a plain value, never as filter
 * text. Deliberately in BOTH worlds: a key holder asked for one person's bookings by a
 * strong id, and a partner's key reading its own test booking is the whole point, so
 * each row says which world it is in (#2660).
 *
 * It throws on a failed read for the reason given above (#1641): a failed read here
 * would arrive at the caller as "this lead has no call", which is the answer the
 * booking confirmed page renders as not found.
 */
export async function findActiveBookingsByStrongIds(
  ids: readonly string[],
): Promise<orchestration.BookingWithWorld[]> {
  if (ids.length === 0) return [];
  const rows = await activeBookingsBySignals({ ids, emailLike: null, phone: null }, "both", "strong id booking lookup");
  return rows.map((row) => row as unknown as orchestration.BookingWithWorld);
}

/**
 * The rows the reconcile-missing sweep (#431) scans: active bookings whose slot is
 * still in the future and that have an assigned agent (a null-agent booking can't
 * own a per-user busy_block).
 *
 * Ordered created_at DESC because a missed write-through INSERT happens at create
 * time, so the freshest bookings are the likeliest to be missing a block, and are
 * scanned first within the `limit` cap. `offset` rotates the window across ticks
 * (#512) so an older upcoming booking beyond the first page is still eventually
 * healed, not starved forever.
 *
 * But newest-first ran straight into the create path's own block write (#778), so
 * bookings younger than the grace window are held back here rather than fetched and
 * then skipped: excluding them in SQL is what keeps them from eating the sweep's
 * per-tick row budget. See RECONCILE_MISSING_GRACE_MS.
 *
 * #3304: bookings whose agent has LEFT the pool are held back the same way, in SQL
 * and for the same reason. Leaving deletes the agent's busy_blocks, write throughs
 * included, and the pool exit backstop deletes them again every self heal tick, so
 * a block this sweep re-created for them was gone again within the same tick, and
 * all the sweep did was page about a missed write that never happened. They are
 * judged by `hasLeftPool`, the backstop's own rule, through its SQL form.
 *
 * That includes an agent who is merely not bookable, not only a departed one, and
 * one read does use such an agent's blocks: an advisor link booking's move times
 * (#2827, `bookingRescheduleTimes`) are computed from its own advisor's busy_blocks
 * whatever their pool state. It is still no reason to rebuild them here, because
 * the backstop deletes every block written for anybody `hasLeftPool` names on this
 * same tick, so the sweep could never keep one standing for that read; the move
 * itself re-checks the advisor's live calendar before it lands.
 */
export async function loadActiveUpcomingBookings(
  limit: number,
  offset = 0,
): Promise<ActiveUpcomingBooking[]> {
  const settledBefore = new Date(
    Date.now() - orchestration.RECONCILE_MISSING_GRACE_MS,
  ).toISOString();
  // Fail loud (#1152): a failed scan must NOT come back as an empty one. The row
  // count IS this sweep's verdict, and an under-cap count now clears the saturation
  // streak and posts an all-clear, so a zero born of a read error would announce
  // that a backlog had drained on the strength of a query that never ran. `unwrap`
  // hands the lane its "could not tell" marker instead, which pages nobody and
  // all-clears nobody.
  const data = unwrap(
    await whereStillInPool(
      supabaseAdmin()
        .from("bookings")
        // `!inner` is load bearing: it is what makes the user filters drop a
        // BOOKING. On a plain embed they would only empty the embedded user and
        // every booking would still come back. The constraint is named because
        // other tables (busy_blocks, reroute_holds, owner_alert_events) also link
        // bookings to users, and an embed PostgREST finds ambiguous is refused.
        .select("id, assigned_user_id, starts_at, ends_at, users!bookings_assigned_user_id_fkey!inner(id)")
        .in("status", ["confirmed", "rescheduled"])
        .gte("ends_at", new Date().toISOString())
        .not("assigned_user_id", "is", null)
        .lt("created_at", settledBefore),
      "users",
    )
      .order("created_at", { ascending: false })
      // `id` breaks created_at ties into a total order, so range paging (#512)
      // can't skip or double-scan a row at a page boundary.
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1),
    "loadActiveUpcomingBookings",
  );
  return ((data ?? []) as {
    id: string;
    assigned_user_id: string;
    starts_at: string;
    ends_at: string;
  }[]).map((r) => ({
    id: r.id,
    user_id: r.assigned_user_id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
  }));
}

/**
 * The reconcile-missing sweep's re-create (#3592), as ONE statement:
 * `recreate_missing_busy_blocks` (migration 0204) inserts a slate block for each of
 * `bookingIds` that is still active, upcoming, assigned, past the #778 grace and on an
 * advisor still in the pool, locking each booking row so a cancel cannot land between
 * the check and the insert, and returns the rows it inserted. The block's agent and
 * window come from the booking row itself. The grace cutoff is passed in so
 * `RECONCILE_MISSING_GRACE_MS` stays its one home.
 *
 * A refused call is retried once, exactly as the insert it replaces was (a repeat
 * cannot double insert: ON CONFLICT DO NOTHING). Refused twice, it pages the write
 * failure the old insert paged, then THROWS. The old insert returned after paging, and
 * the sweep went on to report every candidate as re-created and to page "a
 * write-through INSERT had been missed" about blocks that were never written; the self
 * heal lane reads the throw as "could not tell", and the next tick retries.
 */
async function recreateMissingBusyBlocks(
  bookingIds: string[],
): Promise<{ booking_id: string; user_id: string }[]> {
  if (bookingIds.length === 0) return [];
  const createdBefore = new Date(Date.now() - orchestration.RECONCILE_MISSING_GRACE_MS).toISOString();
  const call = () =>
    supabaseAdmin().rpc("recreate_missing_busy_blocks", {
      p_booking_ids: bookingIds,
      p_created_before: createdBefore,
    });
  let res = await call();
  if (res.error) res = await call();
  if (res.error) {
    const what = bookingIds.length === 1 ? `booking ${bookingIds[0]}` : `${bookingIds.length} bookings (${bookingIds.join(", ")})`;
    log.error("booking", { msg: "busy_blocks reconcile re-create failed", what }, res.error);
    const reason = shortFailureReason(res.error.message) ?? "no detail";
    await sendThrottledAlert(
      "busy_block_write_through",
      CACHE_ALERT_COOLDOWN_MS,
      busyBlockWriteThroughAlert("insert", what, reason),
    ).catch(logAlertSendFailure("busy_block_write_through"));
    throw new Error(`reconcile-missing: recreate_missing_busy_blocks failed: ${res.error.message}`);
  }
  return (res.data ?? []) as { booking_id: string; user_id: string }[];
}

/**
 * Claim the per-booking reschedule lease (#439, migration 0053). The booking_id
 * PK is the atomic arbiter: at most one in-flight reschedule per booking. The
 * discriminated outcome distinguishes a fresh win, a crash-resume (expired lease
 * + a written pin), a different-target abandon, a same-target no-op, and a
 * different-target conflict. Fails CLOSED on an unexpected DB error (throws a
 * retriable error), so a claim we can't trust never re-opens the concurrent
 * -duplicate window. Extracted from `realDeps` as a `db`-injected seam so the
 * expired-lease takeover CAS is unit-testable (#480 / AUD-050).
 */
export async function claimRescheduleLock(
  db: ReturnType<typeof supabaseAdmin>,
  bookingId: string,
  targetStartIso: string,
  now: number,
): Promise<RescheduleClaim> {
  const nowIso = new Date(now).toISOString();
  const leaseUntil = new Date(now + RESCHEDULE_LOCK_TTL_MS).toISOString();
  const { error } = await db.from("reschedule_locks").insert({
    booking_id: bookingId,
    target_starts_at: targetStartIso,
    claimed_at: nowIso,
    lease_until: leaseUntil,
  });
  if (!error) return { outcome: "won" };
  if (error.code !== "23505") {
    // Fail CLOSED on an unexpected DB error (user escalation decision): block
    // with a retriable error rather than proceed, so a claim we can't trust
    // never re-opens the concurrent-duplicate window. No lock is held yet (the
    // claim is before the wrapper's try/finally), so nothing to release.
    log.error("reschedule", { msg: "lock claim failed", booking_id: bookingId }, error);
    throw new orchestration.RescheduleLockUnavailableError();
  }
  // A lease already exists: load it (+ the booking) to decide.
  // error-ok: expired-lease takeover decision; a null lock (incl. a read error) returns { outcome: "won" } and the caller retries the claim.
  const { data: lock } = await db
    .from("reschedule_locks")
    .select(
      "target_starts_at, lease_until, pinned_user_id, pinned_agent_email, gcal_client_id, branch, reschedule_seq",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!lock) return { outcome: "won" }; // released between insert + read; retry as fresh
  // error-ok: idempotency check for an already-committed reschedule; a null (incl. a read error) proceeds to the lease-expiry decision, never a double move.
  const { data: bk } = await db
    .from("bookings")
    .select("starts_at")
    .eq("id", bookingId)
    .maybeSingle();
  if (bk && Date.parse(bk.starts_at) === Date.parse(targetStartIso)) {
    return { outcome: "idempotent" }; // already at target (a holder committed)
  }
  const expired = !lock.lease_until || Date.parse(lock.lease_until) <= now;
  const sameTarget = Date.parse(lock.target_starts_at) === Date.parse(targetStartIso);
  if (!expired) {
    return sameTarget ? { outcome: "idempotent" } : { outcome: "conflict" };
  }
  // Expired lease = a crashed holder. Take it over with a compare-and-swap on the
  // still-expired lease so only ONE concurrent claimant adopts the pin (#480 /
  // AUD-050): the WHERE re-checks lease_until is null OR <= now, and `.select()`
  // reports whether THIS statement won the row. Two racers that both read the
  // expired lease can't both re-lease: the first flips lease_until into the
  // future, the second's CAS then matches 0 rows.
  const { data: took, error: takeoverErr } = await db
    .from("reschedule_locks")
    .update({ claimed_at: nowIso, lease_until: leaseUntil })
    .eq("booking_id", bookingId)
    .or(`lease_until.is.null,lease_until.lte.${nowIso}`)
    .select("booking_id");
  if (takeoverErr) {
    // Fail CLOSED on an unexpected DB error, same rule as the claim insert: a
    // takeover we can't confirm must not proceed as a holder.
    log.error("reschedule", { msg: "lease takeover failed", booking_id: bookingId }, takeoverErr);
    throw new orchestration.RescheduleLockUnavailableError();
  }
  if (!took || took.length === 0) {
    // Lost the takeover race: another claimant re-leased first and its lease is
    // now live. Mirror the non-expired branch (same target = idempotent, since it
    // runs our exact move; different target = conflict). Never a holder outcome,
    // so the move fires once.
    return sameTarget ? { outcome: "idempotent" } : { outcome: "conflict" };
  }
  const hasPin =
    lock.gcal_client_id != null &&
    lock.pinned_user_id != null &&
    lock.pinned_agent_email != null &&
    lock.branch != null &&
    lock.reschedule_seq != null;
  if (!hasPin) return { outcome: "won" }; // crashed before any Google call -> fresh
  const pin: ReschedulePin = {
    reschedule_seq: lock.reschedule_seq!,
    branch: lock.branch as "in_place" | "reassign",
    pinned_user_id: lock.pinned_user_id!,
    pinned_agent_email: lock.pinned_agent_email!,
    gcal_client_id: lock.gcal_client_id!,
    target_starts_at: lock.target_starts_at,
  };
  return sameTarget ? { outcome: "resume", pin } : { outcome: "fresh-after-abandon", pin };
}

/**
 * #3924: the abandoned pin sweep's takeover of one row, a compare and swap on the
 * row still naming the pin's event and still past its lease plus the grace, which
 * is what the sweep's own read selected it by. A reschedule that adopted the pin
 * since, or another sweep, has re-leased it, so the WHERE matches nothing and the
 * sweep leaves the row to them. The token is the claim stamp, which is what the
 * release below matches on. Why the target moves to the booking's own time is on
 * `BookingDeps.takeOverAbandonedReschedulePin`. THROWS on a failed write, because a
 * takeover nobody can confirm must not go on to touch a lead's invite.
 */
export async function takeOverAbandonedPinLock(
  db: ReturnType<typeof supabaseAdmin>,
  pin: orchestration.AbandonedReschedulePin,
  graceMs: number,
  now: number,
): Promise<string | null> {
  if (!pin.gcal_client_id) return null;
  const claimedAt = new Date(now).toISOString();
  const { data, error } = await db
    .from("reschedule_locks")
    .update({
      claimed_at: claimedAt,
      lease_until: new Date(now + RESCHEDULE_LOCK_TTL_MS).toISOString(),
      ...(pin.booking_starts_at ? { target_starts_at: pin.booking_starts_at } : {}),
    })
    .eq("booking_id", pin.booking_id)
    .eq("gcal_client_id", pin.gcal_client_id)
    .lt("lease_until", new Date(now - graceMs).toISOString())
    .select("booking_id");
  if (error) throw new Error(`abandoned reschedule pin could not be taken over: ${error.message}`);
  return (data ?? []).length > 0 ? claimedAt : null;
}

/**
 * #3924: free a row the sweep took over, and only while its claim stamp is still
 * the sweep's: past the sweep's own lease a reschedule may have taken it over, and
 * that holder's lock is not the sweep's to delete. A refused delete is logged; the
 * lease runs out on its own and the next sweep finds the invite already in step.
 */
export async function releaseAbandonedPinLock(
  db: ReturnType<typeof supabaseAdmin>,
  bookingId: string,
  claimedAt: string,
): Promise<void> {
  const { error } = await db
    .from("reschedule_locks")
    .delete()
    .eq("booking_id", bookingId)
    .eq("claimed_at", claimedAt);
  if (error) log.error("reschedule", { msg: "abandoned pin lock release failed", booking_id: bookingId }, error);
}

/**
 * One agent's working-hours schedule (#527): timezone + shift rules from
 * availability_schedules + availability_rules, mirroring loadMembersAvailability's
 * nested select. A schedule-less agent (or a transient read error) falls back to
 * America/New_York + no rules, so the in-place reschedule guard treats them as
 * off-shift and re-routes (the SAFE default; consistent with
 * assembleMemberAvailability's default). Shared by the standalone `agentWorkingHours`
 * dep and the folded `loadBookingContext` read (#538) so the query lives in one place.
 */
async function fetchAgentWorkingHours(
  userId: string,
): Promise<{ timezone: string; rules: { weekday: number; start_minute: number; end_minute: number }[] }> {
  const fallback = { timezone: "America/New_York", rules: [] };
  // error-ok: a read failure falls back to ET + no rules, so the guard treats the agent as off-shift and re-routes (safe default, documented above).
  // availability_rules is embedded via the rules.schedule_id FK; the DB
  // Relationships (#354) type the nested rows, so no `unknown` cast is needed.
  const { data } = await supabaseAdmin()
    .from("availability_schedules")
    .select("timezone, availability_rules(weekday, start_minute, end_minute)")
    .eq("user_id", userId)
    .limit(1);
  const row = data?.[0];
  if (!row) return fallback;
  return {
    timezone: row.timezone,
    rules: (row.availability_rules ?? []).map((r) => ({
      weekday: r.weekday,
      start_minute: r.start_minute,
      end_minute: r.end_minute,
    })),
  };
}

/**
 * Binds the booking orchestration to real IO. This is the ONLY place the
 * booking flow touches Supabase, Google Calendar, or webhooks; the logic lives
 * in `orchestration.ts` and is exercised by `scripts/test-booking-orchestration.ts`.
 */
/**
 * Build the live deps. `deferSend` (#884) is passed ONLY by the user-facing
 * entry points (create confirm, cancel, reschedule, reassign), so `fire()` hands
 * their webhook's outbound POST to Next after() and the response isn't blocked on
 * the Regal/Cadence round-trip. The cron drains call `realDeps()` with no
 * scheduler and send inline, so their bounded fan-out still caps simultaneous
 * connections. Default is inline: a new caller that forgets to opt in stays on
 * today's safe (if slower) behavior rather than silently deferring.
 */
/**
 * The REAL dependency wiring, exported so it can be driven directly (#2482).
 *
 * Every orchestration test injects fakes, which is right for the orchestration and
 * leaves the wiring itself, the half that actually talks to Postgres, covered by
 * nothing. That is where a write discarding its result lives, so that is what has
 * to be tested: `scripts/../service-deps.test.ts` hands it a client that refuses
 * and asserts the writes that must not carry on regardless really refuse.
 */
/**
 * #3221: the line confirms for one slot take turns in, one per isolate. Module
 * state on purpose: every request this isolate serves has to find the same line,
 * and `realDeps` is built per request.
 */
const ISOLATE_CONFIRM_QUEUE = makeConfirmQueue<orchestration.SlotSettlement>();
/** #3325: the isolate's line behind the async interface, the shared line's fallback. */
const ISOLATE_LINE = isolateLine(ISOLATE_CONFIRM_QUEUE);
/**
 * #3338: what this isolate's recent commit chains cost, so a confirm never starts a
 * reservation, an event and an insert its budget cannot finish. Module state for the
 * same reason as the line: every request this isolate serves reads the same record.
 */
const ISOLATE_COMMIT_COSTS = makeCommitCostLog();

/**
 * Whether a refused database call was Postgres ANSWERING (#3495): a SQLSTATE or
 * PostgREST's own PGRST code, refused before or inside the statement, so a one
 * transaction function wrote nothing. Anything else may have committed and is read
 * back. The client gives a failed fetch an EMPTY code today, but a SQLSTATE is also
 * five capitals, exactly like a system error's own code (EPIPE, EPERM), so one
 * passed through would read a commit whose answer was lost as one that never
 * happened. So the class is held to the ones Postgres defines: two characters starting
 * with a digit, or F0, HV, P0 and XX. Three are answers that do NOT say nothing was
 * written: 08, the connection failing, 57P, the server shutting down, and 40003,
 * statement completion unknown, can each arrive for a transaction whose COMMIT was
 * never confirmed, so they are read back. A deadline is never an answer, however it
 * arrives.
 */
function postgresAnswered(error: { code?: string; message: string }): boolean {
  if (isDeadlineExceeded(error) || typeof error.code !== "string") return false;
  if (/^PGRST\d+$/.test(error.code)) return true;
  return /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(error.code) && !/^(?:08|57P|40003$)/.test(error.code);
}

/**
 * A booking's busy block that did not move: logged and paged, never failing the
 * booking, which has already happened. One copy (#3495), for the separate move and
 * for the one inside a fresh booking's save.
 *
 * The log line is written at once; the page goes after the lead's answer when
 * `deferPage` is set (#3266), since the booking is made and nothing in the answer
 * reads it. On a cron drain it is sent inline.
 */
async function reportBusyBlockMoveFailure(
  bookingId: string,
  reason: string,
  deferPage: PageScheduler | undefined,
  err?: unknown,
): Promise<void> {
  log.error("booking", { msg: "busy_blocks move failed", booking_id: bookingId }, err ?? new Error(reason));
  await pageAfterAnswer(deferPage, "busy-block-page", () =>
    sendThrottledAlert(
      "busy_block_write_through",
      CACHE_ALERT_COOLDOWN_MS,
      busyBlockWriteThroughAlert("move", bookingId, shortFailureReason(reason) ?? "no detail"),
    ).catch(logAlertSendFailure("busy_block_write_through")),
  );
}

/**
 * `lineFacts`, when given, receives which confirm line served this request's turn
 * (#3325), for the route's `confirm answered` line.
 */
export function realDeps(deferSend?: WebhookSendScheduler, lineFacts?: ConfirmLineFacts): BookingDeps {
  // #3266: the pages a booking raises after it committed go after the response on
  // the same requests that defer their webhook send, the ones a lead is waiting on.
  // The cron drains pass no scheduler and send them inline (`pageAfterAnswer`).
  const deferPage: PageScheduler | undefined = deferSend ? afterResponse : undefined;
  return {
    deferSend,
    deferPage,
    resolveBucketByCode,
    // #2638: the lead's XBC for a booker confirm whose link carried none. Throws
    // on a failed read, which the confirm answers with a retriable 503.
    readLeadXbc: readLeadXbcLive,
    readSubmissionLead: readSubmissionLeadIdLive,
    // #1334: the calling number, for an invite description rebuilt after the lead
    // corrects their number. Throws on a refused read; the caller omits the line.
    readCallingNumber: readCallingNumberLive,
    roundRobinCandidates,
    // #3489: the whole ladder's candidate inputs in one request (migration 0176), read
    // strictly: a failed or unreadable answer throws, never reads as an empty ladder.
    // Shared with the monitor lane's served versus confirm check (#3381).
    readLadderInputs: readLadderInputsLive,
    // The org's opening hours (#1295). Throws on an unreadable week rather than
    // degrading, so a narrowing can never be silently re-opened by a failed read.
    businessHours: loadBusinessHours,
    // Live busy intervals for the in-place reschedule guard (#536): checks ALL the
    // agent's calendars; a read failure returns null -> the guard re-routes. The
    // guard runs the SAME isBookableSlotForAgent predicate the booker does, so a
    // reschedule can't keep an agent on a slot the booker would never offer.
    busyIntervalsForAgent: agentBusyIntervals,
    // The agent's OTHER active bookings in a window (#536), epoch-ms, excluding the
    // booking being moved — the in-place guard counts these for the daily cap.
    agentActiveBookingStartsMs,
    // Working-hours schedule for one agent (#527), used by the reassign path's
    // target-agent daily-cap check. The reschedule in-place guard now reads this
    // from the folded context load (#538); the shared helper keeps both on one query.
    agentWorkingHours: (userId) => fetchAgentWorkingHours(userId),
    // Batched verify-on-book (#167): read the whole candidate wave's free/busy
    // in ONE cross-identity freeBusy call (chunked at Google's 20-calendar cap,
    // chunks fired with bounded concurrency) instead of one serial Google call
    // per candidate. An agent is free only if EVERY one of their calendars read
    // cleanly and none overlaps; any unread/errored calendar — or a wholesale
    // bulk failure — routes that agent to the accurate direct per-agent check,
    // so accuracy is never traded for speed.
    verifyFree: async (emails, startIso, endIso, ids) => {
      const free = new Set<string>();
      const unverified = new Set<string>();
      if (emails.length === 0) return { free, unverified };

      const { byEmail, readFailed } = await calendarsForEmails(emails, ids);
      const bulkAgents = emails
        .filter((e) => !readFailed.has(e))
        .map((e) => ({ email: e, calendarIds: byEmail.get(e) ?? [e] }));
      const fallback = new Set<string>(readFailed);

      // Read as one candidate's identity: domain free/busy is cross-visible.
      const readBulk = async (wave: typeof bulkAgents) => {
        const subject = wave[0].email;
        const allCalIds = [...new Set(wave.flatMap((a) => a.calendarIds))];
        const maps = await mapWithConcurrency(
          chunkCalendarIds(allCalIds),
          VERIFY_CONCURRENCY,
          (chunk) => freeBusyMany(subject, startIso, endIso, chunk),
        );
        const busyByCalendar = new Map<string, CalendarBusy>();
        for (const m of maps) for (const [k, v] of m) busyByCalendar.set(k, v);
        const res = freeAgentsFromBusy(wave, busyByCalendar, Date.parse(startIso), Date.parse(endIso));
        for (const e of res.free) free.add(e);
        for (const e of res.needsFallback) fallback.add(e);
      };

      // #3700: the bulk read retries ONCE, as the next advisor, when Google refused the
      // subject itself. The whole call is made AS the subject, so a subject Google
      // refuses outright (archived in the Workspace, `403 notACalendarUser`; or a
      // token mint refused for a deleted account) fails every calendar in it, and one
      // offboarded advisor at the top of the round robin sent the whole wave to the
      // slower per agent reads. Which advisor is refused is not known before asking
      // (the booking path reads no sync health), so the refusal itself picks the next
      // subject. The refused one goes to their own per agent read, which meets the same
      // refusal and leaves them out of the wave (`readAgentCalendar`), rather than being
      // read through somebody else, where an archived calendar could read as empty.
      // Only once: two refused subjects in a row is more likely Slate's own credential
      // than two offboarded advisors, and walking the whole wave would put a Google
      // round trip per advisor on the lead's confirm. A transient failure is not
      // retried at all: a second subject would meet the same outage.
      let bulkWave = bulkAgents;
      let retried = false;
      while (bulkWave.length > 0) {
        try {
          await readBulk(bulkWave);
          break;
        } catch (err) {
          // #3313: a deadline is not a bulk failure. The confirm's budget is spent
          // (or this call's own limit is), so the per agent reads would meet the
          // same deadline and score every candidate unverified, paging a Google
          // or database outage about Slate's own clock. It goes up as itself.
          if (isDeadlineExceeded(err)) throw err;
          const failure = reachabilityFromError(err);
          if (!retried && bulkWave.length > 1 && isDefinitiveFailure(failure)) {
            retried = true;
            log.warn(
              "booking",
              { msg: "verify-on-book bulk freeBusy refused its subject, asking again as the next advisor", email: bulkWave[0].email, failure },
              err,
            );
            fallback.add(bulkWave[0].email);
            bulkWave = bulkWave.slice(1);
            continue;
          }
          // Total bulk failure (e.g. the subject's delegated token couldn't be
          // minted): verify everyone directly per agent rather than fail.
          log.error("booking", { msg: "verify-on-book bulk freeBusy failed, falling back to per-agent" }, err);
          for (const a of bulkWave) fallback.add(a.email);
          break;
        }
      }

      if (fallback.size > 0) {
        const direct = await verifyAgentsDirectly([...fallback], startIso, endIso);
        for (const e of direct.free) free.add(e);
        for (const e of direct.unverified) unverified.add(e);
        // #3700: a wave Google refused entirely is an outage, never a full slot. This
        // also covers the bulk read's stop after two refused subjects: those advisors
        // land here with everyone else, and are judged with them.
        if (wholeWaveRefused(emails.length, direct.refused.size)) {
          log.error("booking", {
            msg: "Google refused every advisor in the wave, likely Slate's own credential, answering the retriable outage",
            count: direct.refused.size,
          });
          for (const e of direct.refused) unverified.add(e);
        }
      }

      return { free, unverified };
    },
    createEvent,
    deleteEvent,
    eventExists,
    // #2371: the advisor only alert's own calendar primitives. They go through the
    // arbitrary-calendar helpers, not the booking ones, because this event has no
    // attendees and must never send anybody an invitation or a cancellation.
    createOwnerAlertEvent: createEventOnCalendar,
    deleteOwnerAlertEvent: deleteEventOnCalendar,
    moveOwnerAlertEvent: updateEventTimeOnCalendar,
    loadLiveOwnerAlert: (bookingId) => loadLiveOwnerAlert(supabaseAdmin(), bookingId),
    insertOwnerAlert: (row) => insertOwnerAlert(supabaseAdmin(), row),
    setOwnerAlertEventId: (id, gcalEventId) =>
      setOwnerAlertEventId(supabaseAdmin(), id, gcalEventId),
    recordOwnerAlertSkip: (id, reason) => recordOwnerAlertSkip(supabaseAdmin(), id, reason),
    markOwnerAlertRemoved: (id, skipReason) =>
      markOwnerAlertRemoved(supabaseAdmin(), id, new Date().toISOString(), skipReason),
    // #2372. The channel read is the SAME one the monitor lane's handoff delivery
    // uses, deliberately: two readers of `handoff_channel` would drift, and a sales
    // notice landing somewhere the handoff notices do not is the drift nobody sees.
    loadHandoffChannel: () => loadHandoffChannel(supabaseAdmin()),
    ownerReassignNoticeOn: () => loadOwnerReassignNoticeOn(supabaseAdmin()),
    // postSlack never throws; an unconfigured bot, a refused channel or a timeout
    // all come back as not-ok with a reason, which the step classifies.
    postHandoffNotice: (channel, text) => postSlack({ channel, text }),
    advisorTimezone: (userId) => loadAdvisorTimezone(supabaseAdmin(), userId),
    pageRaceBoundHit: pageRaceBoundHitAfterResponse,
    // #3325: the shared line when its switch is on and its binding answers, else
    // the isolate's own line, exactly as before.
    confirmQueue: confirmLineFor(
      ISOLATE_LINE,
      (served) => {
        if (lineFacts) lineFacts.line = served;
      },
      // #3354: the load test's trace for this confirm, so the object logs its calls.
      lineFacts?.lineTrace ?? null,
    ),
    // #3325: sibling codes that walk the same pools share one line. #3460: from the
    // grouping this server holds, which `settleLineGrouping` made fresh where it could
    // before the orchestration builds the key; the facts record where it came from.
    lineGroupOf: (code) => lineGroupOfLive(code, lineFacts),
    commitCosts: ISOLATE_COMMIT_COSTS,
    // #3354: the points of the wait before the confirm's profile, when the route
    // keeps marks (the load test only); absent, nothing is stamped.
    mark: lineFacts?.marks ? (point) => lineFacts.marks?.mark(point) : undefined,
    // #3300: the request's stage profile, opened by the route's `answerTimed`, so
    // the confirm's stages and ladder rungs reach its `confirm answered` line.
    profile: lineFacts?.profile,
    // #3401: a time change learns its lead off the booking it loads, for the line.
    noteLeadId: lineFacts
      ? (leadId) => {
          lineFacts.leadId = leadId;
        }
      : undefined,
    enqueueEventDeletion: async (calendarEmail, gcalEventId, bookingId) => {
      // THROWS (#2482). This row IS the record that a Google event still has to be
      // deleted, and nothing else holds that fact: a refused upsert leaves the event
      // on the advisor's calendar for ever, blocking a slot for a booking that no
      // longer exists, with the caller having already moved on. An intent must be
      // durably recorded before the effect is relied on, so a write that did not
      // land has to be loud (L33).
      const { error } = await supabaseAdmin()
        .from("pending_event_deletions")
        .upsert(
          { calendar_email: calendarEmail, gcal_event_id: gcalEventId, booking_id: bookingId },
          { onConflict: "calendar_email,gcal_event_id", ignoreDuplicates: true },
        );
      if (error) {
        throw new Error(
          `pending event deletion could not be enqueued for booking ${bookingId}: ${error.message}`,
        );
      }
    },
    loadPendingEventDeletions: async (limit) => {
      // Fail loud (#1152): NOT best-effort any more. The drain's deleted+failed
      // count is its saturation verdict, and an under-cap count now clears the
      // streak and posts "the failed calendar event deletion drain has caught up".
      // A read error that degraded to an empty queue would send exactly that
      // all-clear about a queue nobody managed to look at. Throwing gives the lane
      // its "could not tell" marker, which neither pages nor all-clears.
      const data = unwrap(
        await supabaseAdmin()
          .from("pending_event_deletions")
          .select("*")
          .lt("attempts", orchestration.PENDING_DELETION_GIVE_UP_AT)
          // #3215: least recently touched first. Every pass touches each row it
          // loads and keeps (a failed delete, or one a pending reservation holds),
          // so the queue rotates and no set of kept rows can occupy every page.
          // Ordering by attempts first would let held rows, which never gain an
          // attempt, sit in front of every row that has ever failed once.
          .order("updated_at", { ascending: true })
          .limit(limit),
        "loadPendingEventDeletions",
      );
      return (data ?? []) as orchestration.PendingEventDeletion[];
    },
    // #1630: one refused calendar's other queued deletions, read by the drain so they
    // settle in the same pass. THROWS: the drain logs a refused read and leaves the
    // rows for a later pass, so an empty answer is never mistaken for "no more rows".
    loadPendingEventDeletionsForCalendar: async (calendarEmail, limit) => {
      const data = unwrap(
        await supabaseAdmin()
          .from("pending_event_deletions")
          .select("*")
          .eq("calendar_email", calendarEmail)
          .lt("attempts", orchestration.PENDING_DELETION_GIVE_UP_AT)
          .order("updated_at", { ascending: true })
          .limit(limit),
        "loadPendingEventDeletionsForCalendar",
      );
      return (data ?? []) as orchestration.PendingEventDeletion[];
    },
    // #1630: who owns each refused calendar, and where a departed owner's calls sit
    // now. Both THROW on a failed read, which the drain's describer turns into an
    // explicit unknown: an empty answer would read as nobody having left, or as no
    // call having moved.
    loadCalendarOwners: async (emails) =>
      (unwrap(
        await supabaseAdmin().from("users").select("id, email, name, deactivated_at").in("email", [...emails]),
        "calendar owners of refused deletions",
      ) ?? []) as Pick<User, "id" | "email" | "name" | "deactivated_at">[],
    loadBookingAssignees: async (bookingIds) =>
      (unwrap(
        await supabaseAdmin().from("bookings").select("id, assigned_user_id, status").in("id", [...bookingIds]),
        "bookings behind refused deletions",
      ) ?? []) as Pick<Booking, "id" | "assigned_user_id" | "status">[],
    loadCreationOrphans: async (limit) => {
      // error-ok: best-effort creation-orphan alert worklist; a read error skips
      // this tick and the deletion lane retries next tick.
      const { data } = await supabaseAdmin()
        .from("pending_event_deletions")
        .select("*")
        .is("booking_id", null)
        // #3215: least recently touched first, like the drain, so the held rows it
        // skips (and the drain touches each pass) cannot fill every page.
        .order("updated_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as orchestration.PendingEventDeletion[];
    },
    // #3215 (L744): who holds an event a deletion was queued for. Both THROW on a
    // failed read, because an empty answer here is permission to delete a
    // confirmed booking's calendar hold. Asked as a FILTERED existence question:
    // the statuses are in the query, so every row it can return is a holder and
    // `limit(1)` can never page a live holder out of view.
    liveBookingHoldingEvent: async (gcalEventId, statuses) =>
      ((unwrap(
        await supabaseAdmin()
          .from("bookings")
          .select("id")
          .eq("gcal_event_id", gcalEventId)
          .in("status", [...statuses])
          .limit(1),
        "live booking holding a queued event",
      ) ?? []) as { id: string }[])[0]?.id ?? null,
    // #3217: a standing reschedule lock and a reassign intent pin their event the
    // same way a pending reservation does, since a resume of either derives the
    // same id. Three filtered existence questions, each THROWING on a failed read.
    pendingWritePinsEvent: async (gcalEventId) => {
      const db = supabaseAdmin();
      const [reservations, locks, intents] = await Promise.all([
        db.from("booking_reservations").select("id").eq("gcal_client_id", gcalEventId).eq("status", "pending").limit(1),
        db.from("reschedule_locks").select("booking_id").eq("gcal_client_id", gcalEventId).limit(1),
        db.from("reassign_intents").select("booking_id").eq("gcal_client_id", gcalEventId).limit(1),
      ]);
      return (
        (unwrap(reservations, "reservation pinning a queued event") ?? []).length > 0 ||
        (unwrap(locks, "reschedule lock pinning a queued event") ?? []).length > 0 ||
        (unwrap(intents, "reassign intent pinning a queued event") ?? []).length > 0
      );
    },
    removePendingEventDeletion: async (id) => {
      // write-ok: a refused delete leaves the row, so the drain retries a deletion Google has already accepted, which is idempotent. It can never drop a deletion that has not happened.
      await supabaseAdmin().from("pending_event_deletions").delete().eq("id", id);
    },
    bumpPendingEventDeletion: async (id, attempts, error) => {
      // write-ok, and REPORTED (#2482): a refused update leaves the attempt count and the
      // recorded error, so the drain retries the deletion and the give up threshold
      // arrives late. The row that says the event still needs deleting is untouched.
      reportWriteFailure(
        await supabaseAdmin()
        .from("pending_event_deletions")
        .update({ attempts, last_error: error })
        .eq("id", id),
        "pending event deletion attempt counter",
      );
    },
    updateEventTime,
    updateEventDescription,
    updateEventContact,
    // #1334: what an invite says now, so a phone correction edits one line of it.
    readEventDescription: async (email, eventId) => {
      const event = await getEventOnPrimary(email, eventId);
      return event === null ? null : (event.description ?? "");
    },
    emitWebhook,
    appBaseUrl: appUrl,
    newManageToken: () => nanoid(24),
    // #3495: minted before the save, since the webhook built for it names the booking.
    newBookingId: () => crypto.randomUUID(),
    // Keyless (anonymous) bookings synthesize a unique key so they still get the
    // reservation-backed crash-safe create (#666). "anon_" prefix + nanoid can
    // never contain a "|", so it can't collide with a derived contact key.
    newIdempotencyKey: () => `anon_${nanoid(24)}`,
    // A booking changed the bucket's availability: recompute its precomputed
    // row so the booked slot disappears. Not awaited, so the confirm isn't
    // blocked on the recompute; the recompute lane's freshness sweep is the
    // backstop if this best-effort call is missed.
    //
    // On the USER-FACING paths (the ones that pass `deferSend`), under
    // afterResponse rather than a floating `void` (#2345). The recompute is a whole
    // pool compute, seconds of CPU on the load test Worker, and as a float it
    // STARTED inside the confirm, sharing the isolate's one thread with the work a
    // lead is waiting on, ran on past the response, and was reported by nothing:
    // the load run's per job line named only the tally. On Workers a promise still
    // pending at the response is not guaranteed to run at all (#191, #503). A
    // failure is logged by afterResponse under the job's own name.
    //
    // #3258: and it refreshes the booked code's POOL, sharing one compute with the
    // pool's other bookings inside a ten second window (`refreshPoolOf`).
    // The three arm load run measured the per booking compute as the code half of
    // the confirm slowdown, crowding the Worker that answers the next confirms.
    //
    // The cron drains (no `deferSend`) keep the float, as #503 decided: there,
    // waitUntil would hold the shared minute invocation open for the recompute,
    // a lane budget regression, and the recompute lane backstops a dropped one.
    //
    // #3258: under load test only, `SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE` can turn
    // the user facing recompute off, or into its reads alone, so a load run can
    // measure what it costs the confirms beside it. Production always reads `on`
    // (`postConfirmRecomputeMode`). The cron drains' float is not switched: the
    // question is the cost a booking's own refresh puts on the next confirms.
    //
    // #3324: a CREATE passes the booked advisor and window, and the refresh becomes
    // a splice of that window into every pool the advisor serves: no whole pool
    // compute after the booking at all, and the advisor's other pools stop offering
    // the time within seconds rather than at the lane's next pass. The fence is
    // stamped HERE, synchronously, after the busy block's write returned, so it is
    // never earlier than the block a later compute reads. A reschedule or reassign
    // also passes the window it LEFT (#3334), spliced back into every pool the old
    // advisor serves under the same fence, stamped after the busy block's move. The
    // cancel step passes no window and keeps the coalesced pool refresh.
    invalidateSlots: (bucketCode, booked) => {
      if (deferSend) {
        const target = booked ? { ...booked, fenceAtMs: Date.now() } : null;
        const refresh = postConfirmRefresh(postConfirmRecomputeMode(), bucketCode, {
          recompute: (code) =>
            target ? spliceBookedTimeAfterBooking(code, target) : refreshPoolOf(code, "booking"),
          // The reads of the same work the on arm does, so the arms stay comparable.
          readsOnly: (code) =>
            target ? readSpliceInputsAfterBooking(code, target) : readPoolInputsAfterBooking(code),
        });
        if (refresh) afterResponse(refresh.context, refresh.work);
      } else {
        void recomputeBucketSlotsForToday(bucketCode, "booking-code").catch((err) =>
          // Best-effort freshness nudge; the recompute lane reconverges this bucket
          // regardless. Logged so a lane that is failing EVERY time is findable.
          log.warn("booking", { msg: "post-confirm recompute failed", bucket: bucketCode }, err),
        );
      }
      return Promise.resolve();
    },
    // #504: the routing decision log, injected so the orchestration's calls are
    // test-observable. Best-effort in the impl (never throws), matching the prior
    // module-function behavior.
    recordRoutingDecision,
    // #3797: a time refused at the free check judged a lost race or a stale offer.
    judgeRefusedOffer: judgeRefusedOfferLive,
    resolveBucketPool,
    // #827: the tier the availability cache currently displays for a bucket, so a
    // fresh confirm can measure display-vs-booked tier divergence. `from` matches
    // the availability route's default (now). A hidden test bucket resolves to
    // null here (authorizedForTest defaults false), keeping smoke bookings out of
    // the measure. Best-effort: any failure returns null and skips the measure.
    displayedTier: async (bucketCode) => {
      try {
        const res = await getBucketSlotsWithFallback(
          bucketCode,
          new Date().toISOString(),
        );
        return res?.routing.booked_tier ?? null;
      } catch {
        return null;
      }
    },

    // #3477: refuses a failed read rather than answering null. The live confirm calls
    // this (the advisor it is about to book), not only the drain, and a null here was
    // read as `agent.name` and answered the lead 500 INTERNAL on load run 37587811697,
    // when the read had hit its deadline. Thrown, a deadline reaches the confirm as the
    // retryable dependency error it is, and the drain still retries on its own throw.
    getUser: async (userId) =>
      unwrap(
        await supabaseAdmin().from("users").select("*").eq("id", userId).single(),
        "advisor read",
      ) as User,

    loadEmails: async (userIds) => {
      const m = new Map<string, string>();
      if (userIds.length === 0) return m;
      // error-ok: best-effort agent email map for notifications; a read error yields an empty map and the notify step is retried by the drain.
      const { data } = await supabaseAdmin()
        .from("users")
        .select("id, email")
        .in("id", userIds);
      for (const row of (data ?? []) as { id: string; email: string | null }[]) {
        if (row.email) m.set(row.id, row.email);
      }
      return m;
    },

    // #1341: one field, one write. `unwrap`-style: a failed update THROWS rather
    // than resolving, because the lead is told their number is saved off the back
    // of this call, and a swallowed error would make that a lie (L12).
    updateBookingPhone: async (bookingId, phone) => {
      const { error } = await supabaseAdmin()
        .from("bookings")
        .update({ attendee_phone: phone })
        .eq("id", bookingId);
      if (error) throw new Error(`booking phone update failed: ${error.message}`);
    },

    // #2164: the lead's own details, in ONE write. Same rule as the phone update
    // above: a failed update THROWS rather than resolving, because the lead is
    // told their details are saved off the back of this call and a swallowed
    // error would make that a lie (L12).
    updateBookingContact: async (bookingId, patch) => {
      const { error } = await supabaseAdmin().from("bookings").update(patch).eq("id", bookingId);
      if (error) throw new Error(`booking contact update failed: ${error.message}`);
    },

    findBookingByIdempotencyKey: async (key) => {
      // error-ok: idempotency probe on the crash-safe create path; a null (incl. a read error) re-drives the unique-key-guarded insert, so it can never double-book.
      const { data } = await activeBookingByIdempotencyKey(key);
      return (data as Booking | null) ?? null;
    },

    // #3495: the read back after a save whose answer was lost. A failed read THROWS,
    // so the confirm can tell "not there" from "could not tell" and say so.
    readBookingByIdempotencyKey: async (key) => {
      return (unwrap(await activeBookingByIdempotencyKey(key), "booking read back by idempotency key") as Booking | null) ?? null;
    },

    // #3847: a reservation resume's lookup, in ANY status, newest first, so a booking
    // cancelled or completed since it committed settles its reservation instead of
    // being made again. THROWS on a failed read. At most one row per key is active
    // and an active one is always the newest, since the active key index refuses a
    // second insert while it stands.
    findLatestBookingByIdempotencyKey: async (key) => {
      const rows = unwrap(
        await supabaseAdmin()
          .from("bookings")
          .select("*")
          .eq("idempotency_key", key)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1),
        "latest booking by idempotency key",
      );
      return ((rows ?? []) as Booking[])[0] ?? null;
    },

    // #3495: a fresh booking's save after its calendar event, in ONE call. The booking,
    // its busy block, its webhook deliveries, its routing record and the reservation's
    // delete are one transaction (`commit_fresh_booking`, migration 0174); a clash on
    // any guard is answered as a conflict with nothing written, which is how the hold
    // trigger's 23P01 (#3251) and the two slot guards (#2274) still reach the next
    // advisor branch. What follows the writes is each step's own, as it was when they
    // were separate calls: the busy block's failure alert, the routing record's log
    // and misroute alert, the webhook's first send.
    commitFreshBooking: async ({ booking, reservationId, webhook, routing }) => {
      const { data, error } = await supabaseAdmin().rpc("commit_fresh_booking", {
        p_booking: booking,
        p_reservation_id: reservationId,
        p_webhook:
          "unbuilt" in webhook
            ? { unbuilt: webhook.unbuilt }
            : {
                event: "booking.created",
                payload: webhook.payload,
                dedupe_key: webhook.dedupeKey,
                suppression: suppressionByFormat("booking.created", webhook.payload, webhook.suppressed),
              },
        p_routing: routing ? routingDecisionRow(routing) : null,
      });
      if (error) {
        const answered = postgresAnswered(error);
        // #1047: what identifies the ATTEMPT, the slot and the advisor, never the
        // attendee (contact data does not go in logs, docs/pii.md).
        log.error(
          "booking",
          { msg: answered ? "booking commit refused" : "booking commit got no answer", ...insertFailureLogFields(booking) },
          error,
        );
        if (answered) throw new orchestration.CommitRefusedError({ code: error.code, message: error.message });
        // No answer at all (a deadline, a dropped connection): it may have committed,
        // and the caller reads the booking back. The error rides along as the cause, so
        // a deadline in it still reaches the route as the retryable outage (#3215).
        throw new Error(`the booking commit got no answer: ${error.message}`, { cause: error });
      }
      // An answer that cannot be read throws too, and the caller reads the booking back.
      const answer = readCommitAnswer(data, Object.keys(WEBHOOK_FORMATS));
      if (answer.status === "conflict") {
        return { kind: "conflict", winner: answer.winner as unknown as Booking | null };
      }
      const failed = answer.failed;
      if (failed.busy !== undefined) await reportBusyBlockMoveFailure(booking.id, failed.busy, deferPage);
      if (failed.routing !== undefined) {
        log.error("routing", { msg: "routing_decisions insert failed", booking_id: booking.id }, new Error(failed.routing));
      }
      // Whether or not its record stored, as recordRoutingDecision always did: a lost
      // record must never also silence a misroute page.
      // #3266: after the lead's answer on their request. alertIfMisroute catches its
      // own failed send; the catch here also covers anything thrown before it sends,
      // so a failure is an error line by its key rather than afterResponse's warning.
      if (routing) {
        const misrouteKey = `misroute:${routing.bucketCode}`;
        await pageAfterAnswer(deferPage, "misroute-page", () =>
          alertIfMisroute(routing).catch(logAlertSendFailure(misrouteKey)),
        );
      }
      // An unbuilt webhook failed its step, so the reader has already refused any
      // deliveries beside it (`readCommitAnswer`); the check here is the type's.
      if (answer.enqueue && !("unbuilt" in webhook)) {
        await afterEnqueue(booking.org_id, "booking.created", answer.enqueue, webhook.suppressed, deferSend);
      }
      return {
        kind: "committed",
        booking: answer.booking as unknown as Booking,
        failed: {
          ...(failed.busy !== undefined ? { busy: failed.busy } : {}),
          ...(failed.webhook !== undefined ? { webhook: failed.webhook } : {}),
          ...(failed.routing !== undefined ? { routing: failed.routing } : {}),
        },
        reservationDeleted: answer.reservationDeleted,
      };
    },

    // The booking/cancel itself already succeeded when these run, so a cache
    // write failure must not fail the request - but it cannot stay silent
    // either (#34): a missed insert lets the embed keep offering a booked
    // slot until sync mirrors the Google event (~1 min); a missed delete
    // leaves phantom busy forever (slate rows have no gcal event to reconcile
    // against). Retry once, then log + throttled Slack alert.
    // #762: one write for the whole reconcile-missing batch (up to RECONCILE_LIMIT
    // rows) instead of a serial round-trip per row. Conflict-safe: these are
    // slate-sourced rows with a null gcal_event_id, and the only unique index on
    // busy_blocks is (user_id, gcal_event_id), so no row in the batch can collide
    // and abort the others.
    insertBusyBlocks: async (blocks) => {
      await insertBusyBlocksWithRetry(blocks, deferPage);
    },

    moveBusyBlock: async (userId, startIso, endIso, bookingId) => {
      // Atomic delete-by-booking + insert in one SQL function (#429 P3). Same
      // write-through posture as insert/delete: a failure must not fail the
      // booking change (the move already happened) — log + throttled alert.
      const { error } = await supabaseAdmin().rpc("move_busy_block", {
        p_booking_id: bookingId,
        p_user_id: userId,
        p_starts_at: startIso,
        p_ends_at: endIso,
      });
      if (error) await reportBusyBlockMoveFailure(bookingId, error.message, deferPage, error);
    },

    reassignSwap: async ({
      bookingId,
      userId,
      agentName,
      agentEmail,
      gcalEventId,
      gcalClientId,
      routingTrace,
      reroute,
      expect,
    }) => {
      // #3249: a reroute move takes the bucket aware form (migration 0166), which
      // consumes the claimed hold in the same transaction. Its seven extra
      // arguments are ALL OR NONE (the overloads are told apart by name), and its
      // refusal word comes back rather than raising. #1677: so does a reassign that
      // carries the state it was decided on, through the sixteen argument form
      // (migration 0196); with no bucket that form is the plain reassign below.
      if (reroute || expect) return rerouteSwap({
        bookingId, userId, agentName, agentEmail, gcalEventId, gcalClientId,
        routingTrace, bucketId: reroute?.bucketId ?? null, requestedBucketId: reroute?.requestedBucketId ?? null,
        requestedTier: reroute?.requestedTier ?? null, bookedTier: reroute?.bookedTier ?? null,
        rungsDropped: reroute?.rungsDropped ?? null, holdId: reroute?.holdId ?? null,
        expect: expect ?? null,
      });
      // Atomic swap-and-return-previous (#449). Unlike the best-effort cache
      // writes, this IS the durable anchor of the reassign, so a failure must
      // surface (the caller cleans up the event it created and reports failure).
      // The reassignment audit record is appended server-side under the row lock
      // (#519) so concurrent reassigns accumulate full history; p_routing_trace
      // only seeds the row's trace when it has none yet.
      // #759: p_gcal_client_id makes the swap stamp the intent (replaced event +
      // swapped_at) in the SAME transaction, so no crash window remains between the
      // committed swap and that record.
      const { data, error } = await supabaseAdmin().rpc("reassign_booking_swap", {
        p_booking_id: bookingId,
        p_user_id: userId,
        p_agent_name: agentName,
        p_agent_email: agentEmail,
        p_gcal_event_id: gcalEventId,
        p_routing_trace: routingTrace,
        p_gcal_client_id: gcalClientId,
      });
      if (error) {
        // #3249: the target is held for another booking's bucket correction. Its own
        // error, so the admin reassign says so and when it ends (the coverage sweep
        // retries it on its next tick, as it does any failed move).
        const held = agentHeldFrom(error);
        if (held) throw held;
        throw new Error(`reassign_booking_swap failed for booking ${bookingId}: ${error.message}`);
      }
      const row = ((data ?? []) as {
        prev_gcal_event_id: string | null;
        prev_agent_email: string | null;
        updated: boolean;
      }[])[0];
      return {
        prevGcalEventId: row?.prev_gcal_event_id ?? null,
        prevAgentEmail: row?.prev_agent_email ?? null,
        updated: row?.updated ?? false,
      };
    },

    deleteBusyBlocksForBooking: async (bookingId) => {
      const del = () =>
        supabaseAdmin().from("busy_blocks").delete().eq("booking_id", bookingId);
      let { error } = await del();
      if (error) {
        ({ error } = await del());
      }
      if (error) {
        log.error("booking", { msg: "busy_blocks write-through delete failed", booking_id: bookingId }, error);
        await sendThrottledAlert(
          "busy_block_write_through",
          CACHE_ALERT_COOLDOWN_MS,
          busyBlockWriteThroughAlert("delete", bookingId, shortFailureReason(error.message) ?? "no detail"),
        ).catch(logAlertSendFailure("busy_block_write_through"));
      }
    },

    deleteGcalMirrorBlock: async (userId, gcalEventId) => {
      // #586: clear a stray source=gcal mirror of a Slate booking's own event. Scoped
      // to source=gcal + this exact gcal_event_id, so it can never touch the booking's
      // source=slate write-through block (which carries a null gcal_event_id). A single
      // retry on transient failure; a leftover mirror self-heals on the next full
      // resync (purgeVanished) and via the sync's slate-id delete, so no alert.
      const del = () =>
        supabaseAdmin()
          .from("busy_blocks")
          .delete()
          .eq("user_id", userId)
          .eq("source", "gcal")
          .eq("gcal_event_id", gcalEventId);
      let { error } = await del();
      if (error) ({ error } = await del());
      if (error) {
        log.error("booking", { msg: "busy_blocks gcal-mirror delete failed", gcal_event_id: gcalEventId }, error);
      }
    },

    loadReconcilableBusyBlocks: async (limit, offset = 0) => {
      // Only upcoming slate rows: a past block can't block a bookable future
      // slot, and gcal mirrors are never freed by the reconcile sweep (#428).
      // Scoping to ends_at >= now keeps the scan bounded by concurrent future
      // bookings instead of the whole table. `offset` rotates the scan window
      // across ticks (#512) so blocks past the first page are eventually covered.
      // Fail loud (#1152): the freed count is this sweep's saturation verdict, and
      // an under-cap count now clears the streak and posts "the backlog that
      // triggered the earlier page has cleared". A read error that degraded to an
      // empty scan would send that all-clear about rows nobody read. Throwing gives
      // the lane its "could not tell" marker, which neither pages nor all-clears.
      // It also matches the in-flight read below, which has thrown since #784.
      const data = unwrap(
        await supabaseAdmin()
          .from("busy_blocks")
          .select("id, user_id, booking_id, source, ooo_request_id")
          .eq("source", "slate")
          .gte("ends_at", new Date().toISOString())
          .order("ends_at", { ascending: true })
          // `id` breaks ends_at ties into a total order, so range paging (#512) can't
          // skip or double-scan a row at a page boundary.
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
        "loadReconcilableBusyBlocks",
      );
      return (data ?? []) as {
        id: string;
        user_id: string;
        booking_id: string | null;
        source: "slate" | "gcal";
        ooo_request_id: string | null;
      }[];
    },

    loadApprovedOooRequestIds: async (requestIds) => {
      if (requestIds.length === 0) return new Set<string>();
      // Fail loud (#1464): an unreadable answer here would leave every owned block
      // looking unowned, and the sweep would DELETE the only thing blocking approved
      // time off. Throwing gives the lane its "could not tell" marker instead.
      // cap-safe: bounded by the ids passed in, which come from one capped page.
      const data = unwrap(
        await supabaseAdmin()
          .from("ooo_requests")
          .select("id")
          .in("id", requestIds)
          .eq("status", "approved"),
        "loadApprovedOooRequestIds",
      );
      return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    },

    loadBookingStatuses: async (bookingIds) => {
      const map = new Map<string, BookingStatus>();
      if (bookingIds.length === 0) return map;
      const { data, error } = await supabaseAdmin()
        .from("bookings")
        .select("id, status")
        .in("id", bookingIds);
      if (error) {
        // Fail safe: an empty map would mark every booking "missing" and free
        // its slot. Throw so the sweep aborts this tick rather than over-delete.
        throw new Error(`reconcile: loadBookingStatuses failed: ${error.message}`);
      }
      for (const r of (data ?? []) as { id: string; status: BookingStatus }[]) {
        map.set(r.id, r.status);
      }
      return map;
    },

    // #784: bookings whose cancel is still being delivered. Their busy_block delete
    // is a `pending` outbox step that simply has not run yet, so the block is in
    // flight, not stuck, and freeing + reporting it slandered a healthy cancel path.
    loadInflightCancelBookingIds: async (bookingIds) => {
      if (bookingIds.length === 0) return new Set<string>();
      const { data, error } = await supabaseAdmin()
        // cap-safe: bounded by the reconcile sweep's page of booking ids (.in over one page of rows).
        .from("booking_outbox")
        .select("booking_id")
        .eq("action", "cancel")
        .eq("status", "pending")
        .in("booking_id", bookingIds);
      if (error) {
        // Fail safe toward NOT sweeping: an empty set on a read blip would make
        // every in-flight cancel look stuck again, which is the exact false-alert
        // this guard exists to stop. Throw so the sweep aborts this tick; the next
        // tick retries, and an unfreed slot merely stays busy a minute longer.
        throw new Error(`reconcile: loadInflightCancelBookingIds failed: ${error.message}`);
      }
      return new Set(
        ((data ?? []) as { booking_id: string | null }[])
          .map((r) => r.booking_id)
          .filter((id): id is string => id !== null),
      );
    },

    // #4165: a booking cancelled inside the grace, whose outbox row may not exist yet.
    loadJustCancelledBookingIds: async (bookingIds) => {
      if (bookingIds.length === 0) return new Set<string>();
      // `updated_at` and not the booking_events row: the `set_updated_at` trigger
      // stamps it in the very statement that flips the status, so a booking can never
      // read cancelled without it, whereas the cancelled event is written by an outbox
      // step AFTER the outbox insert, which is the gap this exists to cover. A later
      // edit to a cancelled row only moves the stamp forward, which only waits longer.
      const cancelledSince = new Date(
        Date.now() - orchestration.RECONCILE_CANCELLED_GRACE_MS,
      ).toISOString();
      // Fail loud like the in-flight read: an empty set born of a read error would
      // free a cancel still on its way and page about it, the false alert this guards.
      const data = unwrap(
        await supabaseAdmin()
          .from("bookings")
          // cap-safe: bounded by the reconcile sweep's page of booking ids (.in over one page of rows).
          .select("id")
          .in("id", bookingIds)
          .eq("status", "cancelled")
          .gt("updated_at", cancelledSince),
        "loadJustCancelledBookingIds",
      );
      return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    },

    // #4165: the cancel finishing between the sweep's two reads deletes its own block,
    // so a candidate is not proof of a row. This answers with the rows the statement
    // removed (`.select("id")`), and every count and alert is built from those.
    deleteBusyBlocksByIds: async (ids) => {
      if (ids.length === 0) return [];
      // A refused delete removed nothing, so it THROWS (#4165): the lane reads that as
      // "could not tell", which neither pages nor all-clears, and the next tick re-finds
      // and retries these rows. Logging it and carrying on reported every candidate as
      // freed, a page about a delete that never ran.
      const data = unwrap(
        await supabaseAdmin()
          .from("busy_blocks")
          .delete()
          .in("id", ids)
          .select("id"),
        "deleteBusyBlocksByIds",
      );
      return ((data ?? []) as { id: string }[]).map((r) => r.id);
    },

    loadActiveUpcomingBookings,

    loadBusyBlockBookingIds: async (bookingIds) => {
      if (bookingIds.length === 0) return new Set<string>();
      const { data, error } = await supabaseAdmin()
        // cap-safe: bounded by the reconcile sweep's page of booking ids (.in over one page of rows).
        .from("busy_blocks")
        .select("booking_id")
        .eq("source", "slate")
        .in("booking_id", bookingIds);
      if (error) {
        // Fail safe: an empty result would make EVERY booking look like it's
        // missing a block and trigger a re-insert for all of them. A duplicate
        // insert is benign (busy-over-free), but throwing aborts this tick so a
        // transient read blip can't mass-insert; the next tick retries.
        throw new Error(`reconcile-missing: loadBusyBlockBookingIds failed: ${error.message}`);
      }
      return new Set(
        ((data ?? []) as { booking_id: string | null }[])
          .map((r) => r.booking_id)
          .filter((id): id is string => !!id),
      );
    },

    recreateMissingBusyBlocks,

    // --- Outbox (#429 P2) ---
    enqueueOutbox: async (row) => {
      // #2373: `unwrap` so a REFUSED insert throws with the database's own reason
      // rather than falling through to the generic "returned no row" below, which
      // said the same thing for a statement that ran and one that never did.
      const data = unwrap(
        await supabaseAdmin()
          .from("booking_outbox")
          .insert({
            booking_id: row.booking_id,
            action: row.action,
            steps: row.steps,
            payload: row.payload,
          })
          .select("id")
          .single(),
        "booking_outbox",
      );
      if (!data) throw new Error("enqueueOutbox: insert returned no row");
      return (data as { id: string }).id;
    },

    loadDrainableOutbox: async (limit) => {
      const nowIso = new Date().toISOString();
      // Drainable = pending, lease free/expired, retry time reached (#445:
      // next_attempt_at null/past), and under the give-up cap (a row past the cap
      // stays pending + diagnosable but is no longer retried).
      //
      // THROWS on a failed read (#3846), like `loadDrainableReservations` (#3844).
      // It used to log and return [], which is what an empty outbox returns, so a
      // read failing on every tick drained nothing and paged nothing while booking
      // side effects waited. The outbox lane catches the throw and counts it toward
      // `outbox_drain_failing`.
      const rows = unwrap(
        await supabaseAdmin()
          .from("booking_outbox")
          .select("*")
          .eq("status", "pending")
          .lt("attempts", DRAIN_GIVE_UP_AT)
          .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
          .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
          .order("created_at", { ascending: true })
          .limit(limit),
        "drainable outbox",
      );
      return (rows ?? []) as BookingOutbox[];
    },

    // #1048: the lease and the three writes it guards live in one db-injected
    // module so the compare and swap on the token is unit-tested rather than being
    // the one part of the fix nothing can see (scripts/test-outbox-lease.ts).
    leaseOutbox: (id) => leaseOutboxRow(supabaseAdmin(), id, Date.now()),
    saveOutboxSteps: (id, steps, lease) =>
      saveOutboxStepsRow(supabaseAdmin(), id, steps, lease, Date.now()),
    markOutboxDelivered: (id, lease) =>
      markOutboxDeliveredRow(supabaseAdmin(), id, lease, Date.now()),
    releaseOutboxLease: (id, lease) => releaseOutboxLeaseRow(supabaseAdmin(), id, lease),

    bumpOutboxAttempt: async (id, attempts, lastError) => {
      // write-ok, and REPORTED (#2482): a refused update leaves the attempt count and the
      // next attempt time unchanged, so the row is retried sooner than the backoff asked
      // for and the dead letter threshold is reached late. The work is not lost, only the
      // bookkeeping about how hard it has been tried.
      reportWriteFailure(
        await supabaseAdmin()
        .from("booking_outbox")
        .update({
          attempts,
          last_error: lastError,
          next_attempt_at: new Date(Date.now() + drainBackoffMs(attempts)).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id),
        "booking outbox attempt counter",
      );
    },

    // --- Create reservations (#429 P4) ---
    insertReservation: async (row) => {
      const db = supabaseAdmin();
      const { data, error } = await db
        .from("booking_reservations")
        .insert(row)
        .select("*")
        .single();
      if (!error && data) return data as BookingReservation;
      // UNIQUE(idempotency_key) violation: another create won the race. Its row
      // is committed (the unique check waits on the in-flight insert), so load +
      // adopt it — both creates converge on ONE pinned agent + client id.
      // error-ok: reads the row that won the idempotent insert race; a null result (incl. a read error) falls through to the throw below.
      const { data: winner } = await db
        .from("booking_reservations")
        .select("*")
        .eq("idempotency_key", row.idempotency_key)
        .single();
      if (winner) return winner as BookingReservation;
      throw new Error(`insertReservation failed: ${error?.message ?? "no row returned"}`);
    },

    loadReservationByKey: async (idempotencyKey) => {
      // error-ok: reservation probe on the crash-safe create path; a null (incl. a read error) re-drives the unique-key-guarded insert.
      const { data } = await supabaseAdmin()
        .from("booking_reservations")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      return data ? (data as BookingReservation) : null;
    },

    deleteReservation: async (id) => {
      // #3859: a lost attempt's rollback deletes the row and then reserves again under
      // the SAME key, whose insert adopts any row still holding it. A refused delete
      // discarded here let that insert adopt the lost reservation, pinned to the advisor
      // just taken, so it throws. The rows it returns say whether one was removed:
      // none means no row had that id, which a holder of the same key removing it
      // first can cause, and is the caller's to judge (`dropLostReservation`).
      const { data, error } = await supabaseAdmin()
        .from("booking_reservations")
        .delete()
        .eq("id", id)
        .select("id");
      if (error) throw new Error(`reservation ${id} could not be deleted: ${error.message}`);
      return data && data.length > 0 ? "deleted" : "gone";
    },

    repinReservationEvent: async (id, fromClientId, toClientId) => {
      // THROWS (#3217): the repoint must land before the fresh event is written,
      // or the drain cannot see that the reservation pins it. Guarded on the id it
      // still names and on pending, so a row another holder moved is never touched.
      const { data, error } = await supabaseAdmin()
        .from("booking_reservations")
        .update({ gcal_client_id: toClientId })
        .eq("id", id)
        .eq("gcal_client_id", fromClientId)
        .eq("status", "pending")
        .select("id");
      if (error) throw new Error(`reservation ${id} could not be repinned: ${error.message}`);
      if (!data || data.length === 0) {
        throw new Error(`reservation ${id} no longer names ${fromClientId}, so it was not repinned`);
      }
    },

    loadDrainableReservations: async (limit) => {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      // Same drainability gate as the outbox (#445): pending, lease free, retry
      // time reached, under the give-up cap. And old enough that no live confirm
      // can still be completing it (#3466, `RESERVATION_DRAIN_MIN_AGE_MS`).
      //
      // THROWS on a failed read. It used to log and return [], which is what an
      // empty drain returns, so a read failing on every tick reached neither the
      // stuck alert nor the lane's failing streak. The outbox lane catches the throw
      // and counts it toward `reservation_drain_failing`.
      const rows = unwrap(
        await supabaseAdmin()
          .from("booking_reservations")
          .select("*")
          .eq("status", "pending")
          .lt("attempts", DRAIN_GIVE_UP_AT)
          .lt("created_at", new Date(now - RESERVATION_DRAIN_MIN_AGE_MS).toISOString())
          .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
          .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
          .order("created_at", { ascending: true })
          .limit(limit),
        "drainable reservations",
      );
      return (rows ?? []) as BookingReservation[];
    },

    // #3169: the claim and the release share the outbox lease's compare and swap
    // (`outbox-lease.ts`), so the release frees only the lease this holder took.
    // #2373 still holds: a refused claim throws rather than reading as busy.
    leaseReservation: (id) =>
      leaseReservationRow(supabaseAdmin(), id, Date.now()),

    releaseReservationLease: (id, lease) => releaseReservationLeaseRow(supabaseAdmin(), id, lease),

    bumpReservationAttempt: async (id, attempts, lastError) => {
      // write-ok, and REPORTED (#2482): a refused update leaves the attempt count where
      // it was, so the drain retries this reservation and the count that decides when to
      // give up advances late. It never loses the reservation itself.
      reportWriteFailure(
        await supabaseAdmin()
        .from("booking_reservations")
        .update({
          attempts,
          last_error: lastError,
          next_attempt_at: new Date(Date.now() + drainBackoffMs(attempts)).toISOString(),
        })
        .eq("id", id),
        "booking reservation attempt counter",
      );
    },

    deleteExpiredReservations: async (olderThanIso, limit) => {
      const db = supabaseAdmin();
      // #3126: every part THROWS on failure. This sweep is the only retention a
      // pending reservation (the whole attendee record) has, and the drain's catch
      // logs a failed cleanup only if something reaches it; discarding the result
      // here made a refused delete read as a clean pass for ever.
      //
      // #3847: and it never deletes a reservation whose booking committed while its
      // booking.created is still owed. The decision, and why every candidate is read
      // rather than a batch, is in `reservation-retention.ts`.
      return sweepExpiredReservations(
        {
          // The candidates are leftovers (a crash, an unrun rollback, an owed send),
          // so the set is small; paged anyway so a backlog is judged whole.
          listExpired: (cutoff) =>
            selectAllPages<ExpiredReservation>("expired reservations", "id", () =>
              db
                .from("booking_reservations")
                .select("id, idempotency_key")
                .eq("status", "pending")
                .lt("created_at", cutoff),
            ),
          // Committed means what the drain's resume reads it as
          // (`activeBookingByIdempotencyKey`): an ACTIVE booking on the key. The
          // active unique index allows one per key, so a chunk returns at most one
          // row per key and the limit never truncates it.
          committedKeys: async (keys) => {
            const found = await inIdChunks("committed reservation keys", keys, async (chunk) =>
              unwrap(
                await db
                  .from("bookings")
                  .select("idempotency_key")
                  .in("idempotency_key", chunk)
                  .in("status", ACTIVE_BOOKING_STATUSES)
                  .limit(chunk.length),
                "committed reservation keys",
              ) as { idempotency_key: string }[] | null,
            );
            return new Set(found.flatMap((rows) => (rows ?? []).map((r) => r.idempotency_key)));
          },
          // Spares a reservation a drain has leased since the sweep read it: that
          // drain may be committing it right now.
          deleteIds: async (ids) => {
            const nowIso = new Date().toISOString();
            const { error, count } = await db
              .from("booking_reservations")
              .delete({ count: "exact" })
              // in-chunk-ok: at most RESERVATION_DRAIN_LIMIT (15) ids, sliced to the sweep's limit before this call, about 560 bytes against the 10,000 budget.
              .in("id", ids)
              .or(`lease_until.is.null,lease_until.lt.${nowIso}`);
            if (error) throw new Error(`expired reservation delete failed: ${error.message}`);
            return count ?? 0;
          },
        },
        olderThanIso,
        limit,
      );
    },

    commitReschedule: async (bookingId, patch, guard, outbox) => {
      // #3265: the gated move (#615: only while the booking is still active AND its
      // assignee + event id are unchanged since we read them) and its outbox work, in
      // ONE transaction (migration 0171). The id of the outbox row it wrote means the
      // move applied; null means the guard matched nothing. A refused call throws as a
      // write failure rather than reading as a lost race (#2373).
      return readCommitReschedule(
        await supabaseAdmin().rpc("commit_reschedule", commitRescheduleArgs(bookingId, patch, guard, outbox)),
      );
    },

    claimCancellation: async (bookingId, replacedBy) => {
      // Atomic flip active->cancelled (#413). Gating on the row still being in an
      // active status (not just "not cancelled") means a concurrent cancel OR a
      // complete-cron tick that already terminated it touches 0 rows (#618); a
      // completed booking can never regress to cancelled. `.select` returns the
      // row only when THIS call made the transition.
      // #2373: the headline case. A refused statement used to be indistinguishable
      // from having lost the claim, and the cancel route reported that as
      // `{ ok: true }`, so the lead read "Your call is cancelled" while the
      // booking, the invite and the advisor's slot all stood.
      // #3672: a cross bucket move names the booking that replaced this one in the
      // SAME statement, so the cancel and its successor land together or not at all.
      return gatedWriteApplied(
        "cancel_claim",
        await supabaseAdmin()
          .from("bookings")
          .update({ status: "cancelled", ...(replacedBy ? { replaced_by_booking_id: replacedBy } : {}) })
          .eq("id", bookingId)
          .in("status", ["confirmed", "rescheduled"])
          .select("id"),
      );
    },

    completeBookingsIfDue: async (bookingIds) => {
      if (bookingIds.length === 0) return [];
      // One batched UPDATE for the whole sweep (#164). Gating on the row still
      // being completable means an overlapping complete-cron tick that already
      // transitioned some of them touches 0 of those (#163); `.select` returns
      // only the rows this UPDATE actually changed.
      // #2373: an empty list here means an overlapping tick already completed them.
      // A refused statement used to say the same thing, which the drain reads as a
      // stall it can do nothing about rather than as a fault somebody should hear.
      const rows = gatedWriteRows<{ id: string }>(
        "complete_due",
        await supabaseAdmin()
          .from("bookings")
          .update({ status: "completed" })
          .in("id", bookingIds)
          .in("status", ["confirmed", "rescheduled"])
          .select("id"),
      );
      return (rows ?? []).map((r) => r.id);
    },

    // Per-booking reschedule lease (#439). Bound to the live client; the full
    // state machine (incl. the expired-lease takeover CAS) lives in the
    // db-injected `claimRescheduleLock` seam so it is unit-testable.
    claimReschedule: (bookingId, targetStartIso) =>
      claimRescheduleLock(supabaseAdmin(), bookingId, targetStartIso, Date.now()),

    writeReschedulePin: async (bookingId, pin) => {
      // THROWS (#2482). The pin is what makes a reschedule deterministic across a
      // crash: the retry re-reads it and lands on the SAME agent and the same event
      // id. A refused write leaves no pin, so the retry is free to pick somebody
      // else, which is the one thing the pin exists to prevent, and the caller
      // carried on as though it had been recorded.
      const { error } = await supabaseAdmin()
        .from("reschedule_locks")
        .update({
          pinned_user_id: pin.pinned_user_id,
          pinned_agent_email: pin.pinned_agent_email,
          gcal_client_id: pin.gcal_client_id,
          branch: pin.branch,
          reschedule_seq: pin.reschedule_seq,
          target_starts_at: pin.target_starts_at,
        })
        .eq("booking_id", bookingId);
      if (error) {
        throw new Error(
          `reschedule pin could not be written for booking ${bookingId}: ${error.message}`,
        );
      }
    },

    readReschedulePin: async (bookingId) => {
      // error-ok: resume-pin lookup; an incomplete or absent pin (incl. a read error) returns null and the flow starts fresh.
      const { data } = await supabaseAdmin()
        .from("reschedule_locks")
        .select(
          "pinned_user_id, pinned_agent_email, gcal_client_id, branch, reschedule_seq, target_starts_at",
        )
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (
        !data ||
        data.gcal_client_id == null ||
        data.pinned_user_id == null ||
        data.pinned_agent_email == null ||
        data.branch == null ||
        data.reschedule_seq == null
      ) {
        return null;
      }
      return {
        reschedule_seq: data.reschedule_seq,
        branch: data.branch as "in_place" | "reassign",
        pinned_user_id: data.pinned_user_id,
        pinned_agent_email: data.pinned_agent_email,
        gcal_client_id: data.gcal_client_id,
        target_starts_at: data.target_starts_at,
      };
    },

    releaseReschedule: async (bookingId) => {
      // write-ok: the lock expires on its TTL regardless, so a refused delete costs a wait and never frees a newer holder.
      await supabaseAdmin().from("reschedule_locks").delete().eq("booking_id", bookingId);
    },

    releaseRescheduleIfTarget: async (bookingId, targetStartIso) => {
      // #480: a single atomic conditional delete instead of read-then-delete. The
      // WHERE clause pins BOTH the booking and the target, so a concurrent
      // different-target holder that re-pinned into the old read->delete window has
      // its fresh lease left untouched (its target no longer matches ours).
      // write-ok: the lock expires on its TTL regardless, and the WHERE pins both the booking and the target so it can only ever free our own.
      await supabaseAdmin()
        .from("reschedule_locks")
        .delete()
        .eq("booking_id", bookingId)
        .eq("target_starts_at", targetStartIso);
    },

    loadAbandonedReschedulePins: async (graceMs) => {
      const db = supabaseAdmin();
      const cutoff = new Date(Date.now() - graceMs).toISOString();
      // error-ok: best-effort sweep of abandoned reschedule leases; a read error yields no work this tick and the sweep retries.
      const { data: rows } = await db
        .from("reschedule_locks")
        .select("booking_id, pinned_agent_email, gcal_client_id, branch, target_starts_at")
        .lt("lease_until", cutoff)
        .not("gcal_client_id", "is", null);
      const locks = rows ?? [];
      if (locks.length === 0) return [];
      const ids = locks.map((r) => r.booking_id);
      // starts_at rides along so the sweep can tell a LOST reschedule (the booking
      // never reached the target time) from one that committed and only failed to
      // release its lock (#757).
      // error-ok: joins live bookings onto the swept locks; a read error leaves booking fields null and the sweep retries next tick.
      const { data: bks } = await db
        .from("bookings")
        .select("id, gcal_event_id, starts_at")
        .in("id", ids);
      const liveById = new Map((bks ?? []).map((b) => [b.id, b]));
      return locks.map((r) => ({
        booking_id: r.booking_id,
        pinned_agent_email: r.pinned_agent_email ?? "",
        gcal_client_id: r.gcal_client_id,
        branch: r.branch,
        booking_gcal_event_id: liveById.get(r.booking_id)?.gcal_event_id ?? null,
        target_starts_at: r.target_starts_at,
        booking_starts_at: liveById.get(r.booking_id)?.starts_at ?? null,
      }));
    },
    // #3924: the sweep's own claim on each row, and its release by that claim.
    takeOverAbandonedReschedulePin: (pin, graceMs) =>
      takeOverAbandonedPinLock(supabaseAdmin(), pin, graceMs, Date.now()),
    releaseAbandonedReschedulePin: (bookingId, token) =>
      releaseAbandonedPinLock(supabaseAdmin(), bookingId, token),
    readBookingInviteState: async (bookingId) =>
      unwrap(
        await supabaseAdmin()
          .from("bookings")
          .select("status, starts_at, ends_at, gcal_event_id, agent_email, timezone")
          .eq("id", bookingId)
          .maybeSingle(),
        "abandoned pin booking",
      ),
    // A load run writes no invite, and its stub answers every read at the current
    // time, which would read as an invite moved somewhere Slate never wrote. So under
    // the flag there is no invite to judge, as the moved invite handler stands down.
    readEventOnPrimary: async (email, eventId) => (isLoadtest() ? null : getEventOnPrimary(email, eventId)),

    // #518 reassign-intent state. UPSERT on (booking_id, gcal_client_id): a
    // same-target retry (identical deterministic id, #449) refreshes the lease
    // instead of failing on the unique constraint, so idempotent retry holds.
    writeReassignIntent: async ({ bookingId, pinnedAgentEmail, gcalClientId }) => {
      const leaseUntil = new Date(Date.now() + REASSIGN_INTENT_LEASE_MS).toISOString();
      const { error } = await supabaseAdmin()
        .from("reassign_intents")
        .upsert(
          {
            booking_id: bookingId,
            pinned_agent_email: pinnedAgentEmail,
            gcal_client_id: gcalClientId,
            lease_until: leaseUntil,
          },
          { onConflict: "booking_id,gcal_client_id" },
        );
      if (error) throw new Error(`reassign_intents upsert failed: ${error.message}`);
    },
    deleteReassignIntent: async (bookingId, gcalClientId) => {
      // write-ok: a refused delete leaves the intent, which the next reassign reads and supersedes. The upsert that RECORDS an intent throws; only its cleanup is tolerated.
      await supabaseAdmin()
        .from("reassign_intents")
        .delete()
        .eq("booking_id", bookingId)
        .eq("gcal_client_id", gcalClientId);
    },
    loadAbandonedReassignIntents: async (graceMs) => {
      const db = supabaseAdmin();
      const cutoff = new Date(Date.now() - graceMs).toISOString();
      // error-ok: best-effort sweep of abandoned reassign leases; a read error yields no work this tick and the sweep retries.
      const { data: rows } = await db
        // cap-safe: abandoned reassign leases past the grace window, at most the in flight reassign count.
        .from("reassign_intents")
        .select(
          "booking_id, pinned_agent_email, gcal_client_id, prev_agent_email, prev_gcal_event_id, swapped_at",
        )
        .lt("lease_until", cutoff);
      const intents = rows ?? [];
      if (intents.length === 0) return [];
      const ids = intents.map((r) => r.booking_id);
      // error-ok: joins live bookings onto the swept intents; a read error leaves event ids null and the sweep retries.
      const { data: bks } = await db.from("bookings").select("id, gcal_event_id").in("id", ids);
      const liveById = new Map((bks ?? []).map((b) => [b.id, b.gcal_event_id]));
      return intents.map((r) => ({
        booking_id: r.booking_id,
        pinned_agent_email: r.pinned_agent_email,
        gcal_client_id: r.gcal_client_id,
        prev_agent_email: r.prev_agent_email ?? null,
        prev_gcal_event_id: r.prev_gcal_event_id ?? null,
        // #758: only a COMMITTED swap stamps this, so null still reads as "never
        // adopted" and keeps the fail-loud alert for a genuinely-lost reassign.
        swapped_at: r.swapped_at ?? null,
        booking_gcal_event_id: liveById.get(r.booking_id) ?? null,
      }));
    },

    // Append-only reschedule/cancel/reassign history (#326/#300). A failed
    // insert must NOT fail the booking change (the move already happened) — log
    // + throttled alert, like the busy_blocks write-through (#34). The reason is
    // analytics, not a safety guard, so losing it to a rare DB error is OK.
    insertBookingEvent: async (row) => {
      // Return the new row id for use as the webhook dedupe key (#436). A failed
      // insert returns null: the webhook then falls back to no-dedup so it still
      // fires (at-least-once) rather than being keyed to a missing row.
      const { data, error } = await supabaseAdmin()
        .from("booking_events")
        .insert(row)
        .select("id")
        .single();
      if (error) {
        log.error("booking", { msg: "booking_events insert failed", booking_id: row.booking_id, action: row.action }, error);
        await sendThrottledAlert(
          "booking_event_insert",
          CACHE_ALERT_COOLDOWN_MS,
          bookingEventInsertAlert(String(row.booking_id), String(row.action), shortFailureReason(error.message) ?? "no detail"),
        ).catch(logAlertSendFailure("booking_event_insert"));
        return null;
      }
      return (data as { id: string }).id;
    },

    hasBookingEvent: async (bookingId, action, toStartsIso, rescheduleSeq) => {
      let q = supabaseAdmin()
        .from("booking_events")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("action", action);
      q = toStartsIso === null ? q.is("to_starts_at", null) : q.eq("to_starts_at", toStartsIso);
      if (rescheduleSeq != null) q = q.eq("reschedule_seq", rescheduleSeq);
      // error-ok: idempotency probe for a recorded reschedule/cancel event; a null (incl. a read error) treats it as not-yet-recorded and the step re-runs (idempotent).
      const { data } = await q.limit(1).maybeSingle();
      return data != null;
    },

    getBookingEventId: async (bookingId, action, toStartsIso, rescheduleSeq) => {
      let q = supabaseAdmin()
        .from("booking_events")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("action", action);
      q = toStartsIso === null ? q.is("to_starts_at", null) : q.eq("to_starts_at", toStartsIso);
      if (rescheduleSeq != null) q = q.eq("reschedule_seq", rescheduleSeq);
      // error-ok: booking_events id probe; a null (incl. a read error) returns null and the caller re-derives the id.
      const { data } = await q.limit(1).maybeSingle();
      return data ? (data as { id: string }).id : null;
    },

    loadBookingContext: async (token, ctxOpts) => {
      const db = supabaseAdmin();
      // error-ok: manage-link lookup; a null (incl. a transient read error) renders as not-found for the manage page rather than throwing.
      const { data: booking } = await db
        .from("bookings")
        .select("*")
        .eq("manage_token", token)
        .maybeSingle();
      if (!booking) return null;

      const b = booking as Booking;
      // #538: when the reschedule path opts in and the booking has an assigned
      // agent, batch the working-hours read into THIS wave (alongside bucket +
      // event type) so the in-place guard adds no extra round-trip.
      const wantWorkingHours = Boolean(ctxOpts?.withWorkingHours && b.assigned_user_id);
      const [{ data: bucket }, { data: eventType }, agentWorkingHours] = await Promise.all([
        db.from("buckets").select("*").eq("id", b.bucket_id).single(),
        db.from("event_types").select("*").eq("id", b.event_type_id).single(),
        wantWorkingHours ? fetchAgentWorkingHours(b.assigned_user_id!) : Promise.resolve(undefined),
      ]);
      return {
        booking: b,
        bucket: bucket as Bucket,
        eventType: eventType as EventType,
        ...(agentWorkingHours ? { agentWorkingHours } : {}),
      };
    },

    // #392 cross-person list: one parameterized, offset-paginated scan (every
    // filter via .eq/.gte/.lte/.gt, ordered + .range — never an interpolated
    // .or() string), plus a single .in() buckets join for each row's bucketCode.
    queryBookings: async (filter) => {
      let q = supabaseAdmin().from("bookings").select("*");
      if (filter.status) q = q.eq("status", filter.status);
      if (filter.afterStart) q = q.gte("starts_at", filter.afterStart);
      if (filter.beforeEnd) q = q.lte("starts_at", filter.beforeEnd);
      if (filter.updatedSince) q = q.gt("updated_at", filter.updatedSince);
      if (filter.bucketId) q = q.eq("bucket_id", filter.bucketId);
      if (filter.assignedUserId) q = q.eq("assigned_user_id", filter.assignedUserId);
      // #1675: NOT null-tolerant, despite the opt-out that used to sit here
      // calling this an admin read. Its only consumer is `listBookings`, the
      // machine booking API's list endpoint, and an integrator pages it: an
      // empty page with a null cursor is the answer "that is everything", so a
      // failed page advances the caller's watermark past bookings nobody read
      // and they are never asked for again. This is the read side of what #1641
      // closed on the write side.
      const rows = (unwrap(
        await q
          .order(filter.orderBy, { ascending: true })
          .order("id", { ascending: true })
          .range(filter.offset, filter.offset + filter.limit - 1),
        "queryBookings rows",
      ) ?? []) as Booking[];
      const bucketIds = [...new Set(rows.map((b) => b.bucket_id))];
      // The bucket join is NOT null-tolerant like the row read above it (#1641).
      // Its only job is to turn each row's bucket_id into the code the caller
      // renders, and an empty result is consumed as a real answer: every listed
      // booking comes back with `bucketCode: null`, which the booking API
      // documents as "the routing trace does not record it". So a failed join
      // makes a healthy list of bookings look like a list of bookings nobody can
      // say the team for.
      const buckets = bucketIds.length
        ? ((unwrap(
            await supabaseAdmin().from("buckets").select("*").in("id", bucketIds),
            "queryBookings bucket join",
          ) ?? []) as Bucket[])
        : [];
      return { rows, buckets };
    },

    findActiveBookingsForPerson,
    findActiveBookingsStartingAt,
    findActiveBookingsByStrongIds,
    earlierLeadBookings,

    loadBookingById: async (bookingId) => {
      const db = supabaseAdmin();
      // error-ok: single booking lookup by id; a null (incl. a read error) returns null so the caller handles not-found.
      const { data: booking } = await db
        .from("bookings")
        .select("*")
        .eq("id", bookingId)
        .maybeSingle();
      if (!booking) return null;

      const b = booking as Booking;
      const [{ data: bucket }, { data: eventType }] = await Promise.all([
        db.from("buckets").select("*").eq("id", b.bucket_id).single(),
        db.from("event_types").select("*").eq("id", b.event_type_id).single(),
      ]);
      return {
        booking: b,
        bucket: bucket as Bucket,
        eventType: eventType as EventType,
      };
    },

    // One implementation, tested with a hand written fake in
    // scripts/test-advisor-name.ts: every failure resolves to null so the
    // surfaces render no name rather than a wrong one (L75).
    loadAgentDisplayName: (userId) =>
      resolveAdvisorName(supabaseAdmin() as unknown as AdvisorNameReader, userId),

    getAgentByEmail: async (email) => {
      // error-ok: agent lookup by email; a null (incl. a read error) returns null and the caller handles the missing agent.
      const { data } = await supabaseAdmin()
        .from("users")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      return (data as User | null) ?? null;
    },

    loadPastBookingIdsToComplete: async () => {
      const db = supabaseAdmin();
      const nowIso = new Date().toISOString();
      // error-ok: best-effort sweep of past bookings to mark complete; a read error yields none this tick and the completion lane retries.
      const { data: rows } = await db
        .from("bookings")
        .select("id")
        .in("status", ["confirmed", "rescheduled"])
        .lt("ends_at", nowIso)
        .limit(PAST_COMPLETION_BATCH_LIMIT);
      return ((rows ?? []) as { id: string }[]).map((r) => r.id);
    },
  };
}

/**
 * Throttled alerting around a booking attempt, for the two failure modes that
 * are silent outages rather than ordinary "slot taken": verify-on-book couldn't
 * reach Google/DB for ANY candidate (#319), or the bucket has NO eligible agents
 * to route to (#327). Re-throws so the caller still maps the error to a response.
 * Best-effort: a failed alert never masks the original error.
 */
/**
 * Which throttled alert (if any) a booking failure warrants — pure so the
 * error→alert mapping is unit-tested without IO. Returns null for ordinary
 * failures (e.g. a genuinely taken slot) that aren't a silent outage.
 */
export function bookingFailureAlert(
  err: unknown,
  /** #3511: where the confirm's time went, read from its own profile. */
  spent: TimeSpent | null = null,
  /** #3663: how far the request had got, which the booking API's timeout path knows. */
  reach: TimeoutReach = "booking",
): { key: string; cooldownMs: number; message: string } | null {
  // #3837: a retry that found its reservation's lease held by the drain or another
  // retry. Answered retryable like the outage, but nothing is down, so no page.
  if (err instanceof orchestration.ReservationHeldError) return null;
  // #3102: the same incident as the verify outage from the lead's side, so the
  // same key and cooldown, with words that name what did not answer.
  if (err instanceof orchestration.DependencyTimeoutError) {
    return {
      key: VERIFY_OUTAGE_ALERT_KEY,
      cooldownMs: VERIFY_OUTAGE_ALERT_COOLDOWN_MS,
      message: dependencyTimeoutAlert({ ...err, spent, reach }),
    };
  }
  // #3859: a refused rollback delete stopped the confirm. The lead's side is the
  // same retryable outage, so the same key, in words naming what refused.
  if (err instanceof orchestration.ReservationRollbackError) {
    return {
      key: VERIFY_OUTAGE_ALERT_KEY,
      cooldownMs: VERIFY_OUTAGE_ALERT_COOLDOWN_MS,
      message: reservationRollbackAlert(),
    };
  }
  if (err instanceof orchestration.VerifyUnavailableError) {
    return {
      key: VERIFY_OUTAGE_ALERT_KEY,
      cooldownMs: VERIFY_OUTAGE_ALERT_COOLDOWN_MS,
      message: verifyOutageAlert(),
    };
  }
  if (err instanceof orchestration.RescheduleLockUnavailableError) {
    return {
      key: RESCHEDULE_LOCK_OUTAGE_ALERT_KEY,
      cooldownMs: RESCHEDULE_LOCK_OUTAGE_ALERT_COOLDOWN_MS,
      message: rescheduleLockOutageAlert(),
    };
  }
  if (err instanceof orchestration.NoEligibleAgentsError) {
    // A test bucket routing to no eligible agent is expected during the smoke
    // test; the booking still fails, but it must not page ops as a real outage (#465).
    if (err.isTest) return null;
    return {
      // Per-bucket key so a second dead bucket isn't suppressed by the first's throttle.
      key: `${NO_ELIGIBLE_AGENTS_ALERT_KEY}:${err.bucketCode ?? "unknown"}`,
      cooldownMs: NO_ELIGIBLE_AGENTS_COOLDOWN_MS,
      message: noEligibleAgentsAlert(err.bucketCode),
    };
  }
  return null;
}

async function alertOnBookingFailure<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (caught) {
    // #3102: a dependency that did not answer becomes the retryable outage here,
    // before the alert is chosen, so it pages as one and every route answers 503.
    const err = orchestration.timeoutAsRetryable(caught);
    if (err !== caught) {
      log.warn("booking", { msg: "a dependency timed out on the booking path; answering retryable" }, caught);
    }
    await pageBookingFailure(err);
    throw err;
  }
}

/**
 * Page about a booking failure that warrants it (`bookingFailureAlert` decides),
 * once the response has gone. Exported for the booking routes, which answer a
 * deadline that struck BEFORE the service was reached (#3102) and must page about
 * it the same way. Never throws, and never holds the answer: a send that fails is
 * logged.
 *
 * Two options, both from the booking API's timeout path (#3663). `reach` is how far
 * the request had got, so a dry run or a request whose body was never read is not
 * worded as a lead waiting on a reservation. `isTestTraffic` says whether it was the
 * canary's or a test bucket's, which may read the bucket, so it is asked after the
 * response with the page, and a check that throws counts as real and pages.
 */
export async function pageBookingFailure(
  err: unknown,
  opts: { reach?: TimeoutReach; isTestTraffic?: () => Promise<boolean> } = {},
): Promise<void> {
  // #3511: read NOW, while the confirm's request is still open, since the page
  // itself is deferred past the response, where the request is closed.
  const spec = bookingFailureAlert(err, timeSpentInThisRequest(), opts.reach);
  if (!spec) return;
  const isTestTraffic = opts.isTestTraffic;
  // #3416: after the response, never in front of it. Nothing in the answer reads
  // the page, and the page reads `alert_state` (and on its first send claims and
  // stamps it): a burst whose confirms time out waiting in line made every one of
  // them ask Supabase before its own 503, on the database the burst was already
  // queueing on (load run 37547143303). Deferred work runs outside any call budget
  // (`afterResponse`), so a budget the timeout spent cannot fail the page's own
  // read, which is what the cleanup allowance used to be for here (#3102), and
  // `after()` keeps it alive past the response as #3145 does for the limiter pages.
  afterResponse("booking-failure-page", async () => {
    if (isTestTraffic && (await isTestTraffic().catch(() => false))) {
      log.info("booking", { msg: "test traffic hit a booking outage; not paged", key: spec.key });
      return;
    }
    // alert-text-ok: `spec.message` is the alert's own copy, built by
    // bookingFailureAlert from the pure builders in booking/alert-copy.ts. The
    // name ends in `.message` and is not an error; the widened #2418 scan reads
    // arguments as well as templates, so it reaches this shape now.
    // alert-key: verify_on_book_outage
    // alert-key: reschedule_lock_outage
    // alert-key: no_eligible_agents:*
    await sendThrottledAlert(spec.key, spec.cooldownMs, spec.message).catch(logAlertSendFailure(spec.key));
  });
}

/**
 * Decide the observability breadcrumb for a reschedule (#543). The pure booking
 * layer surfaces WHY the in-place agent was declined; this turns it into a log
 * line. A routine reassign (declined in-place, succeeded elsewhere) is INFO — a
 * normal outcome, not a problem; an outright failure is WARN. Returns null when
 * there's nothing to say (the in-place agent was kept, or no candidate existed).
 */
export function rescheduleLogLine(input: {
  ok: boolean;
  bookingId: string | undefined;
  initiator: string;
  declineReason: orchestration.RescheduleDeclineReason | null | undefined;
  errorName?: string;
}): { level: "info" | "warn"; message: string } | null {
  if (input.ok) {
    if (!input.declineReason) return null;
    return {
      level: "info",
      message: `reschedule reassigned: booking=${input.bookingId ?? "?"} initiator=${input.initiator} in_place_declined=${input.declineReason}`,
    };
  }
  return {
    level: "warn",
    message: `reschedule failed: booking=${input.bookingId ?? "?"} initiator=${input.initiator} in_place_declined=${input.declineReason ?? "n/a"} error=${input.errorName ?? "unknown"}`,
  };
}

/** Emit the #543 success breadcrumb (INFO) when a reschedule reassigned away from
 *  the declined in-place agent. No-op when the agent was kept (declineReason null). */
function logRescheduleSuccess(
  bookingId: string,
  initiator: string,
  declineReason: orchestration.RescheduleDeclineReason | undefined,
): void {
  const line = rescheduleLogLine({ ok: true, bookingId, initiator, declineReason });
  if (line) log.info("reschedule", { msg: line.message });
}

/** Emit the #543 failure breadcrumb (WARN) ONLY for a reschedule-reroute failure
 *  (the error carries the reschedule tag). A create/dedupe/not-found failure on the
 *  same call path is left alone so it isn't mislabeled as a reschedule failure. */
function logRescheduleFailure(err: unknown, initiator: string): void {
  const ctx = orchestration.rescheduleFailureContext(err);
  if (ctx.bookingId === undefined) return;
  const line = rescheduleLogLine({
    ok: false,
    bookingId: ctx.bookingId,
    initiator,
    declineReason: ctx.inPlaceDeclineReason,
    errorName: err instanceof Error ? err.name : String(err),
  });
  if (line) log[line.level === "warn" ? "warn" : "info"]("reschedule", { msg: line.message });
}

/**
 * Run a reschedule through the booking layer and emit the #543 breadcrumb. Shared
 * by the customer + admin entry points so the log decision lives in exactly one
 * place. Logging is here (the realDeps/IO layer), never in the pure layer.
 */
async function rescheduleWithLog(
  token: string,
  newStartIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  actor?: BookingActor,
  contact?: { name?: string; firstName?: string; email?: string; phone?: string },
  leadZone?: string | null,
  lineFacts?: ConfirmLineFacts,
): Promise<BookingResult> {
  try {
    // #3401: the whole move as one stage of the request's profile; a reroute's
    // ladder rungs are timed inside it.
    const res = await timeStage(lineFacts?.profile, "reschedule", () =>
      orchestration.rescheduleBooking(
        token, newStartIso, reason, initiator, realDeps(deferWebhookSend, lineFacts), Date.now(), actor, contact,
        // #4031: a correction the move did not carry, and could not tell either.
        { leadZone, onCorrectionUntold: pagePhoneCorrectionUnsent },
      ),
    );
    logRescheduleSuccess(res.booking.id, initiator, res.rescheduleDecline);
    return res;
  } catch (err) {
    logRescheduleFailure(err, initiator);
    throw err;
  }
}

/**
 * #3460: before a confirm keys its line, wait within the bound for a fresh pool grouping
 * where its server holds none, so a burst on sibling codes joins ONE ladder line rather
 * than splitting by code. Charged to the confirm's profile as its own stage. A named
 * advisor's link keys on the advisor and needs no grouping, so it waits for nothing.
 */
function lineGroupingBeforeKey(input: { agentLinkUserId?: string }, lineFacts?: ConfirmLineFacts): Promise<void> {
  if (input.agentLinkUserId !== undefined) return Promise.resolve();
  return timeStage(lineFacts?.profile, "line-grouping", () => settleLineGrouping(lineFacts));
}

export function createBooking(input: CreateBookingInput, lineFacts?: ConfirmLineFacts): Promise<BookingResult> {
  return alertOnBookingFailure(async () => {
    await lineGroupingBeforeKey(input, lineFacts);
    return orchestration.createBooking(input, realDeps(deferWebhookSend, lineFacts));
  });
}

/**
 * Best-effort "you already have another call booked" lookup for the confirmation
 * screen (#626). Never throws: the booking is already made and committed by the
 * time this runs, so a lookup failure must not turn a successful booking into a
 * failed one for the lead.
 *
 * It LOGS the failure rather than swallowing it in silence (#1641). Returning
 * null here is indistinguishable from "there is no other booking", which is the
 * ordinary and overwhelmingly common answer, so without the log a broken read is
 * a completely silent loss of the warning. It is also why this cannot serve as
 * the backstop for a failed existing-call check: same query, same table, so it is
 * blind in exactly that failure.
 */
export async function findDuplicateBookingWarning(input: {
  excludeBookingId: string;
  salesforceId: string | null;
  attendee: { email?: string; phone?: string };
  /** The world the booking was just made in (#2660). */
  isTest: boolean;
}): Promise<orchestration.DuplicateWarning | null> {
  try {
    return await orchestration.findDuplicateWarning(input, realDeps());
  } catch (err) {
    log.error(
      "booking",
      { msg: "duplicate-warning lookup failed; no warning shown", booking_id: input.excludeBookingId },
      err,
    );
    return null;
  }
}

/**
 * A lead corrects the number their advisor will call (#1341).
 *
 * The orchestration does the deciding and returns whether the advisor's invite
 * was left showing the old number; the page is dispatched here, alongside every
 * other booking alert, so the domain stays node-testable.
 *
 * The stale invite is an INCIDENT, not a condition: no later run re-reads that
 * event, so there is no healthy state to observe and an all-clear would be a
 * claim nothing measured. It is throttled per booking, because a lead retyping
 * the same number must not repage.
 */
/**
 * The call this lead already has, asked at the BOOKER'S LANDING (#2166).
 *
 * `/booking/{salesforceId}` carries the id in the path, which is the same strong
 * match the confirm recognises them by, so they are known from the first render and
 * the notice does not have to wait for a picked time and a filled form.
 *
 * IT NEVER THROWS, and that is the one difference from the confirm path's use of
 * the same grader. There, a read it could not make must refuse, because the harm is
 * creating a second call for somebody who already has one. Here the harm of not
 * knowing is that the lead is shown the ordinary picker, and the confirm still
 * refuses at the end of it: the gate is unmoved, so failing open costs a notice
 * arriving late rather than a duplicate booking.
 */
export async function existingCallForLanding(
  identity: {
    salesforceId?: string | null;
    externalId?: string | null;
  },
  /** The world of the bucket being landed on (#2660). */
  world: PersonWorld,
): Promise<orchestration.ExistingCall | null> {
  try {
    return await orchestration.findExistingCallForIdentity(
      {
        externalId: identity.externalId ?? null,
        salesforceId: identity.salesforceId ?? null,
        email: null,
        phone: null,
      },
      realDeps(),
      world,
    );
  } catch (err) {
    log.warn("booking", { msg: "landing existing-call check failed, showing the picker" }, err);
    return null;
  }
}

/**
 * How many of this person's bookings the details prefill reads.
 *
 * Small on purpose: it exists to look past a row whose contact columns retention
 * has already cleared (#1071) or which a direct API caller made with no name, not
 * to walk a history. Bounded, so the read can never come back as a truncated page
 * read as the whole set.
 */
const KNOWN_CONTACT_ROWS = 5;

/**
 * What this person's own bookings hold, newest first per field, in one world: the
 * ONE read behind the landing prefill (#2208) and Marcia's contact fill (#3541), so
 * the two cannot key a lead's details two ways. `salesforceIds` are spellings of ONE
 * lead (Marcia passes its 15 and 18 character forms, the landing page the one it
 * was given), never a list of leads. THROWS on a failed read; each caller decides
 * what a failure means for it.
 */
export async function readKnownContact(salesforceIds: readonly string[], world: NamedWorld, context: string): Promise<KnownContact | null> {
  const ids = [...new Set(salesforceIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (ids.length === 0) return null;
  const rows = unwrap(
    await supabaseAdmin()
      .from("bookings")
      .select(
        "id, created_at, attendee_name, attendee_first_name, attendee_email, attendee_phone, buckets!inner(is_test)",
      )
      .eq("buckets.is_test", world.isTest)
      // in-chunk-ok: the spellings of one lead's id, two at most, never a paged list.
      .in("salesforce_id", ids)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(KNOWN_CONTACT_ROWS),
    context,
  ) as KnownContactRow[] | null;
  return knownContactFromBookings(rows ?? []);
}

/**
 * What Slate already holds about the lead a landing link identifies (#2208).
 *
 * The same id `existingCallForLanding` recognises them by, asked of the same table
 * WITHOUT the active-status filter, because the lead this exists for is precisely
 * the one with no active call. The order is declared in the query and decided
 * again in `knownContactFromBookings`, which is what actually answers.
 *
 * IT NEVER THROWS, for the reason the existing-call check above never throws: a
 * read it could not make leaves the lead with the empty form they get today, and
 * nothing downstream reads that emptiness as a fact about them. The failure is
 * LOGGED rather than swallowed, so a lookup that has stopped working is visible
 * instead of looking like a roster nobody has any details for.
 */
export async function knownContactForLanding(
  identity: {
    salesforceId?: string | null;
  },
  /** The world of the bucket being landed on (#2660): a tester who pastes a real
   *  lead's id into a test link is never handed that lead's name and number. */
  world: NamedWorld,
): Promise<KnownContact | null> {
  const salesforceId = identity.salesforceId?.trim();
  if (!salesforceId) return null;
  try {
    return await readKnownContact([salesforceId], world, "landing known-contact lookup");
  } catch (err) {
    log.warn(
      "booking",
      { msg: "landing contact lookup failed, showing an empty details form" },
      err,
    );
    return null;
  }
}

/**
 * What the booker's details form starts with, for BOTH landing routes (#2208).
 *
 * One implementation, deliberately. `/booking/{id}` and `/book?external_id=` build
 * the same `attendee` prop out of the same query string and grade the same
 * identity, so two copies of this would be two answers to one question and the
 * drift would be silent (L613): one route would go on asking a recognised lead to
 * retype their own number while the other did not.
 *
 * The record is only read when the link left something out, so a landing page that
 * carries all three costs nothing.
 */
export async function landingAttendee(
  identity: { salesforceId?: string | null },
  link: LinkAttendee,
  /** The world of the bucket being landed on (#2660). */
  world: NamedWorld,
): Promise<LandingAttendee> {
  const complete = link.name.trim() && link.email.trim() && link.phone.trim();
  if (complete) return attendeeForLanding(link, null);
  return attendeeForLanding(link, await knownContactForLanding(identity, world));
}

/**
 * The booking a "Book a new time" link names by its manage token (#2982), for the
 * rebook page under the manage path. ONE row by token, only the columns a rebook
 * needs, under a deadline. Every failure is `failed` (the page then draws the
 * bucket's booker without prefill) and is logged with neither the token nor
 * anything about the lead; a token naming nothing usable is `absent`.
 */
export function rebookRowForToken(token: string): Promise<RebookLookup> {
  return loadRebookRow(token, {
    readByToken: async (t) => {
      const { data, error } = await supabaseAdmin()
        .from("bookings")
        .select(REBOOK_COLUMNS)
        .eq("manage_token", t)
        .maybeSingle();
      // Checked at runtime by `parseRebookRow`, never cast.
      return { data, error };
    },
    // The error's CODE only, never its message or the Error itself: a PostgREST or
    // fetch failure can quote the request, whose filter is the token.
    warn: (msg, err) => {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : null;
      const kind = err instanceof Error ? err.name : err === null ? null : typeof err;
      log.warn("rebook", { msg, code, kind });
    },
  });
}

/** The lead's own details on a booking (#2164), for a caller that is not moving it. */
export async function updateBookingContact(
  token: string,
  contact: { name?: string; firstName?: string; email?: string; phone?: string },
): Promise<orchestration.UpdateContactResult> {
  return orchestration.updateBookingContact(token, contact, realDeps());
}

export async function updateBookingPhone(
  token: string,
  phone: string,
): Promise<orchestration.UpdatePhoneResult> {
  // #1512: a lead's own request, so the correction's webhook POST goes after the
  // response, as every other lead facing send does (#884).
  const res = await orchestration.updateBookingPhone(token, phone, realDeps(deferWebhookSend));
  if (res.staleInvite) {
    // alert-key: stale_phone_invite:*
    await sendThrottledAlert(
      `stale_phone_invite:${res.staleInvite.bookingId}`,
      orchestration.STALE_PHONE_INVITE_COOLDOWN_MS,
      stalePhoneInviteAlert(res.staleInvite.agentEmail, res.staleInvite.bookingId),
    ).catch(logAlertSendFailure(`stale_phone_invite:${res.staleInvite.bookingId}`));
  }
  if (res.downstreamUntold) await pagePhoneCorrectionUnsent(res.downstreamUntold.bookingId);
  return res;
}

/**
 * #1512: the number is saved and the event telling Regal was never recorded, so
 * nothing retries it. An incident, like the stale invite. Shared by the manage
 * page's correction and a move's uncarried one (#4031), so both page alike.
 */
async function pagePhoneCorrectionUnsent(bookingId: string): Promise<void> {
  // alert-key: phone_correction_unsent:*
  await sendThrottledAlert(
    `phone_correction_unsent:${bookingId}`,
    orchestration.PHONE_CORRECTION_UNSENT_COOLDOWN_MS,
    phoneCorrectionUnsentAlert(bookingId),
  ).catch(logAlertSendFailure(`phone_correction_unsent:${bookingId}`));
}

/**
 * Direct booking API entry (#357): "one active appointment per person" — create,
 * dedupe, auto-reschedule, or ask-to-confirm. Wraps the orchestration in the same
 * verify-outage alerting as createBooking (the create/reschedule paths it dispatches
 * to both verify-on-book).
 */
export function bookViaApi(input: ApiBookingInput, lineFacts?: ConfirmLineFacts): Promise<ApiBookingResult> {
  return alertOnBookingFailure(async () => {
    await lineGroupingBeforeKey(input, lineFacts);
    try {
      const res = await orchestration.bookViaApi(input, realDeps(deferWebhookSend, lineFacts));
      // Only a "rescheduled" outcome can carry a decline reason (#543).
      if (res.outcome === "rescheduled") {
        logRescheduleSuccess(res.booking.id, "system", res.rescheduleDecline);
      }
      return res;
    } catch (err) {
      logRescheduleFailure(err, "system");
      throw err;
    }
  });
}

/**
 * Dry run (#380): preview what an API booking would do without side effects.
 * NOT wrapped in the outage alerting — a dry run is a test, not a real lead, so
 * a dead-bucket preview shouldn't page anyone (the route still returns its code).
 */
export function previewBooking(input: ApiBookingInput): Promise<ApiBookingPreview> {
  return orchestration.previewBooking(input, realDeps());
}

/** The bookable-check result plus best-effort nearest-time hints (#541/#1017). */
export interface BookableCheckResult extends orchestration.BookableResult {
  alternatives: { before: string | null; after: string | null };
}

/**
 * Validate-only bookable check (#541/#1017). Runs the real routing (no writes,
 * no lead identity) via orchestration.checkBookable, then attaches nearest
 * before/after slot HINTS from the availability cache. The hints are best-effort:
 * a cache miss or read error yields null hints and never fails the check itself.
 *
 * #2846: the hints come from exactly the list the booker serves this lead
 * (`getBucketSlotsWithFallback`: the display cascade, the offered open day window,
 * and on a rung below a top tier lead's own tier only the advisors without Low).
 * Reading a rung's whole cached list instead suggested times only a Low carrier
 * is free for, which the booking cascade then refuses.
 */
export async function checkBookable(input: {
  bucketCode: string;
  startIso: string;
  allowTestBuckets?: boolean;
}): Promise<BookableCheckResult> {
  const core = await orchestration.checkBookable(input, realDeps());
  // A disallowed test bucket already threw above, so no leak here.
  let alternatives = { before: null as string | null, after: null as string | null };
  try {
    const served = await getBucketSlotsWithFallback(
      input.bucketCode,
      new Date().toISOString(),
      input.allowTestBuckets ?? false,
    );
    if (served) alternatives = orchestration.nearestSlots(served.slots, input.startIso);
  } catch {
    // Hints are best-effort; a cache read failure must not fail the check.
  }
  return { ...core, alternatives };
}

/** Default reason stamped on an API cancel when the bot supplies none (#386). */
const API_CANCEL_REASON: ValidatedReason = { code: "api_cancellation", detail: null };

/** Lookup API (#386): a person's active bookings by strong id, each id matching
 *  either id column (#2657). */
export function lookupPersonBookings(identity: {
  externalId: string;
  salesforceId: string | null;
}): Promise<orchestration.ApiBookingView[]> {
  return orchestration.lookupPersonBookings(identity, realDeps());
}

/** Lookup API (#386): one booking by id (any status, or asserted `status`). */
export function getPersonBookingById(input: {
  bookingId: string;
  identity: { externalId: string | null; salesforceId: string | null };
  status: BookingStatus | null;
}): Promise<orchestration.ApiBookingView> {
  return orchestration.getPersonBookingById(input, realDeps());
}

/** Cancel API (#386): cancel one owned booking by id. */
export function cancelDirectBooking(input: {
  bookingId: string;
  identity: { externalId: string | null; salesforceId: string | null };
  reason: ValidatedReason | null;
}): Promise<orchestration.ApiBookingView> {
  return orchestration.cancelDirectBooking(
    { bookingId: input.bookingId, identity: input.identity, reason: input.reason ?? API_CANCEL_REASON },
    realDeps(deferWebhookSend),
  );
}

/** #392 list (key-authed): cross-person filtered, paginated bookings. */
export function listBookings(query: import("@/lib/booking/api-request").ListQuery) {
  return orchestration.listBookings(query, realDeps());
}

export function rescheduleBooking(
  token: string,
  newStartIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  /** The lead's own details, when they typed them on the way here (#2164). */
  contact?: { name?: string; firstName?: string; email?: string; phone?: string },
  /** #2310: the zone the lead is viewing the new time in; absent means the
   *  booking's own zone is judged instead. */
  leadZone?: string | null,
  /** #3401: the route's `confirm answered` facts: the profile, and the lead it names. */
  lineFacts?: ConfirmLineFacts,
): Promise<BookingResult> {
  return alertOnBookingFailure(() =>
    rescheduleWithLog(token, newStartIso, reason, initiator, undefined, contact, leadZone, lineFacts),
  );
}

export async function cancelBooking(
  token: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
): Promise<orchestration.CancelOutcome> {
  // `claimed` is true when THIS call made the transition; false when it lost the
  // claim to a concurrent cancel or completion, which is idempotent and fine (only
  // the direct API maps it to 404, #398).
  //
  // #2373: the flag used to be DISCARDED here, and that was only safe while false
  // meant one thing. It no longer does: a write that never ran throws
  // BookingWriteFailedError instead, so false is now exactly "somebody else got
  // there first" and is worth reporting rather than swallowing.
  //
  // #2658: and WHICH booking, on both outcomes, so the manage cancel route can
  // answer the embedded booker with the call it just gave up.
  return orchestration.cancelBookingWithDetail(token, reason, initiator, realDeps(deferWebhookSend));
}

/**
 * The live reads and the one write the owner guard needs (#2370).
 *
 * Every read here THROWS on a real error, which is the whole difference between
 * this and the deps beside it: `realDeps().getAgentByEmail` deliberately swallows a
 * read error to null so the booking paths that use it answer "no such agent", and
 * on THIS path that null would be reported as "Slate has no advisor with that
 * address" and recorded as a refusal against a read that never ran. The swallowing
 * variant is left exactly as it is: its callers (the booking flow and
 * `orchestration.reassignBooking`) turn a null into the 404 they have always
 * answered, and changing it would change the admin and coverage paths too.
 */
function realOwnerGuardDeps(): OwnerReassignGuardDeps {
  return {
    loadBooking: async (bookingId) => {
      const row = unwrap(
        await supabaseAdmin()
          .from("bookings")
          // cap-safe: one booking by primary key.
          .select("id, status, starts_at, ends_at, assigned_user_id")
          .eq("id", bookingId)
          .maybeSingle(),
        "owner reassign booking",
      ) as {
        id: string;
        status: string;
        starts_at: string;
        ends_at: string;
        assigned_user_id: string | null;
      } | null;
      return row
        ? {
            id: row.id,
            status: row.status,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            assignedUserId: row.assigned_user_id,
          }
        : null;
    },
    findOwner: async (email) => {
      const row = unwrap(
        await supabaseAdmin()
          .from("users")
          // cap-safe: at most one user per address.
          .select("id, email, bookable, deactivated_at")
          .eq("email", email)
          .maybeSingle(),
        "owner reassign owner",
      ) as {
        id: string;
        email: string | null;
        bookable: boolean;
        deactivated_at: string | null;
      } | null;
      return row
        ? { id: row.id, email: row.email, bookable: row.bookable, deactivatedAt: row.deactivated_at }
        : null;
    },
    // The same read coverage selection uses (#1236), not a second one: it already
    // throws on a read error and already treats overlap as half open, so leave that
    // merely abutting the call does not count.
    hasApprovedTimeOff: async (userId, startsAt, endsAt) =>
      (await userIdsOnApprovedTimeOff([userId], startsAt, endsAt)).has(userId),
    handoffWriter: handoffWriter(supabaseAdmin()),
  };
}

/**
 * The MACHINE contact-owner reassign (#9), and the only path that runs the owner
 * guard (#2370): Slate refuses, and records who is waiting on what, when the owner
 * is not in Slate, cannot take bookings, or has approved time off over the call.
 * A step of that check it could not complete throws instead, so the route answers
 * 503 and the caller retries rather than reading an outage as a refusal.
 */
export function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  overrideCap = false,
) {
  return reassignForContactOwner({ bookingId, ownerEmail: agentEmail }, realOwnerGuardDeps(), () =>
    orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(deferWebhookSend), { overrideCap }),
  );
}

/** Resolve a booking's manage token by id, so admin actions can reuse the
 *  token-based reschedule/cancel flow (#326 admin screen). */
async function manageTokenForBooking(bookingId: string): Promise<string | null> {
  // error-ok: manage-token lookup for an email link; a null (incl. a read error) returns null and the caller omits the link.
  const { data } = await supabaseAdmin()
    .from("bookings")
    .select("manage_token")
    .eq("id", bookingId)
    .maybeSingle();
  return (data as { manage_token: string } | null)?.manage_token ?? null;
}

/**
 * Admin reschedule by booking id (#326): a staff member acts on a booking from
 * the admin screen. Reuses the customer reschedule flow (verify-on-book, history,
 * webhook) but stamps initiator='admin'. The route is requireAdmin-gated.
 */
export async function adminRescheduleBooking(
  bookingId: string,
  newStartIso: string,
  reason: ValidatedReason,
  actor: BookingActor,
  /** #3401: the route's `confirm answered` facts: the profile, and the lead it names. */
  lineFacts?: ConfirmLineFacts,
): Promise<BookingResult> {
  const token = await timeStage(lineFacts?.profile, "load-token", () => manageTokenForBooking(bookingId));
  if (!token) throw new Error("Booking not found");
  return alertOnBookingFailure(() =>
    rescheduleWithLog(token, newStartIso, reason, "admin", actor, undefined, undefined, lineFacts),
  );
}

/** Admin cancel by booking id (#326), initiator='admin'. requireManager-gated.
 *  `actor` records WHICH staff user cancelled (#549). */
export async function adminCancelBooking(
  bookingId: string,
  reason: ValidatedReason,
  actor: BookingActor,
): Promise<void> {
  const token = await manageTokenForBooking(bookingId);
  if (!token) throw new Error("Booking not found");
  await orchestration.cancelBooking(token, reason, "admin", realDeps(deferWebhookSend), actor);
}

/**
 * Active agents for the manager reassign picker (#546): non-deactivated real
 * advisors in the org (no test agent, no placeholder, #4201), minimal fields only
 * (never the full user row to the client).
 * The picker filters/sorts these with `rankReassignAgents`.
 */
export async function listActiveAgents(orgId: string): Promise<ReassignAgent[]> {
  // error-ok: candidate agents for reassignment; a read error yields an empty list so the reassignment is retried, never run against a wrong pool.
  const { data } = await realAdvisorsOnly(
    supabaseAdmin().from("users").select("id, name, email, bookable").eq("org_id", orgId).is("deactivated_at", null),
  );
  return (data as ReassignAgent[] | null) ?? [];
}

/**
 * Manager reassign by booking id (#546): force a booking onto a chosen agent from
 * the admin screen. Records initiator='admin' + the acting staff user (#549), and
 * allows targets OUTSIDE the bookable pool (coverage/escalation) — the manager
 * picks deliberately and the UI flags out-of-pool agents. `overrideCap` is set
 * only on the manager's second (two-step) confirm. requireBookingActor-gated.
 */
export function adminReassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  actor: BookingActor,
  overrideCap = false,
  /** #1677: commit only if the booking is still in this state; the coverage sweep's. */
  expect?: orchestration.ReassignExpectation,
): Promise<BookingResult & { overCap: boolean }> {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(deferWebhookSend), {
    overrideCap,
    actor,
    initiator: "admin",
    allowNonBookable: true,
    ...(expect ? { expect } : {}),
  });
}

/**
 * The bucket aware reassign_booking_swap (#3247, migration 0166), used for a reroute
 * MOVE (a claimed hold) and a KEEP (no hold, the current agent). Throws on a failed
 * call; a refusal comes back as its word, and the caller names it (L11).
 */
async function rerouteSwap(args: {
  bookingId: string;
  userId: string;
  agentName: string | null;
  agentEmail: string;
  gcalEventId: string;
  gcalClientId: string | null;
  routingTrace: RoutingTrace | null;
  /** Null with every bucket argument below is the plain reassign, for a call that only
   *  carries `expect` (#1677). */
  bucketId: string | null;
  requestedBucketId: string | null;
  requestedTier: string | null;
  bookedTier: string | null;
  rungsDropped: number | null;
  holdId: string | null;
  /** #1677: the state the reassign was decided on, checked under the swap's row lock by
   *  the sixteen argument form (migration 0196). Absent, the fourteen argument form. */
  expect?: { assignedUserId: string; startsAt: string } | null;
}): Promise<{ prevGcalEventId: string | null; prevAgentEmail: string | null; updated: boolean; refused: RerouteSwapRefusal | null }> {
  // The two forms are told apart by their argument NAMES, so the expectation is sent as
  // both arguments or neither.
  const expected = args.expect
    ? { p_expected_user_id: args.expect.assignedUserId, p_expected_starts_at: args.expect.startsAt }
    : {};
  const { data, error } = await supabaseAdmin().rpc("reassign_booking_swap", {
    ...expected,
    p_booking_id: args.bookingId,
    p_user_id: args.userId,
    p_agent_name: args.agentName,
    p_agent_email: args.agentEmail,
    p_gcal_event_id: args.gcalEventId,
    p_routing_trace: args.routingTrace,
    p_gcal_client_id: args.gcalClientId,
    p_bucket_id: args.bucketId,
    p_requested_bucket_id: args.requestedBucketId,
    p_requested_tier: args.requestedTier,
    p_booked_tier: args.bookedTier,
    p_rungs_dropped: args.rungsDropped,
    p_hold_id: args.holdId,
    p_result: null,
  });
  if (error) {
    const held = agentHeldFrom(error);
    if (held) throw held;
    throw new Error(`reassign_booking_swap (reroute) failed for booking ${args.bookingId}: ${error.message}`);
  }
  const row = ((data ?? []) as {
    prev_gcal_event_id: string | null;
    prev_agent_email: string | null;
    updated: boolean;
    refused?: RerouteSwapRefusal | null;
  }[])[0];
  if (!row) throw new Error(`reassign_booking_swap (reroute) returned no row for booking ${args.bookingId}`);
  return {
    prevGcalEventId: row.prev_gcal_event_id ?? null,
    prevAgentEmail: row.prev_agent_email ?? null,
    updated: row.updated,
    refused: row.refused ?? null,
  };
}

/**
 * The live deps behind `reroute.ts` (#3249). The search is phase 2's
 * `findRerouteTarget` over the booking path's own reads; the move is the existing
 * admin reassign with the reroute carried into its swap, so there is one reassign
 * path, not two.
 */
function realRerouteDeps(actor: BookingActor): RerouteDeps {
  const base = realDeps(deferWebhookSend);
  // #3307: a manager is waiting, so the pool refresh after a hold runs after the answer.
  const holds = rerouteHoldStoreDeps("reroute", "after-response");
  return {
    loadBookingById: base.loadBookingById,
    resolveBucketByCode: base.resolveBucketByCode,
    findTarget: (booking, requested, excludeUserIds) =>
      orchestration.findRerouteTarget(
        {
          resolveBucketByCode: base.resolveBucketByCode,
          roundRobinCandidates: base.roundRobinCandidates,
          loadEmails: base.loadEmails,
          verifyFree: base.verifyFree,
          loadCurrentAgentPicture,
          now: () => Date.now(),
        },
        booking,
        requested,
        { excludeUserIds },
      ),
    placeHold: (args) => placeRerouteHold(args, holds),
    releaseHold: (bookingId) => releaseRerouteHold(bookingId, holds),
    // #1643: the no row refusal and the over cap outcome below live in
    // reroute-wiring.ts, where a node suite drives them.
    claimHold: async (orgId, bookingId, holdId) =>
      readClaimedRerouteHold(
        unwrap(
          await supabaseAdmin().rpc("claim_reroute_hold", { p_org_id: orgId, p_booking_id: bookingId, p_hold_id: holdId }),
          "claim_reroute_hold",
        ),
        bookingId,
      ),
    verifyFree: base.verifyFree,
    agentById: async (id) =>
      unwrap(await supabaseAdmin().from("users").select("id, name, email").eq("id", id).maybeSingle(), "reroute advisor") as
        | { id: string; name: string | null; email: string | null }
        | null,
    bucketById: async (id) =>
      unwrap(await supabaseAdmin().from("buckets").select("*").eq("id", id).maybeSingle(), "reroute bucket") as Bucket | null,
    reassign: (bookingId, agentEmail, reason, reroute) =>
      rerouteReassignOutcome(() =>
        orchestration.reassignBooking(bookingId, agentEmail, reason, base, {
          actor,
          initiator: "admin",
          allowNonBookable: true,
          reroute,
        }),
      ),
    onReleaseFailed: (bookingId, err) => {
      log.error("reroute", { msg: "could not release a reroute hold after a failed confirm; it stays until its lease ends", booking_id: bookingId }, err);
    },
    keepSwap: async (args) => {
      const out = await rerouteSwap({ ...args, gcalClientId: null, routingTrace: null });
      return { refused: out.refused, updated: out.updated };
    },
    insertBookingEvent: async (row) => {
      await base.insertBookingEvent(row);
    },
    currentAdvisorUnavailable: (booking, kept) =>
      orchestration.currentAgentUnavailableIn({ loadCurrentAgentPicture, now: () => Date.now() }, booking, kept),
    readLiveHold: async (bookingId) => {
      const row = unwrap(
        await supabaseAdmin()
          // cap-safe: booking_id is unique on reroute_holds, so at most one row.
          .from("reroute_holds")
          .select("id, agent_user_id, target_bucket_id, requested_bucket_id, rungs_dropped, expires_at")
          .eq("booking_id", bookingId)
          .is("consumed_at", null)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle(),
        "reroute live hold",
      ) as {
        id: string;
        agent_user_id: string;
        target_bucket_id: string;
        requested_bucket_id: string;
        rungs_dropped: number;
        expires_at: string;
      } | null;
      return row
        ? {
            holdId: row.id,
            agentUserId: row.agent_user_id,
            targetBucketId: row.target_bucket_id,
            requestedBucketId: row.requested_bucket_id,
            rungsDropped: row.rungs_dropped,
            expiresAt: row.expires_at,
          }
        : null;
    },
    now: () => Date.now(),
  };
}

/**
 * Find who should take a booking in a corrected bucket, holding them when new (#3249).
 * `excludeCurrent` is "look for a different advisor" (#3596): leave the booking's current
 * advisor out of the search so a keep becomes a move to the next eligible advisor.
 */
export function adminStartReroute(
  bookingId: string,
  bucketCode: string,
  actor: BookingActor,
  excludeCurrent = false,
): Promise<RerouteProposal> {
  return startReroute(realRerouteDeps(actor), { bookingId, bucketCode, actor, excludeCurrent });
}

/** Confirm a reroute: a move with its hold, or a keep into `bucketCode` (#3249). */
export function adminConfirmReroute(
  bookingId: string,
  input: { holdId: string | null; bucketCode: string | null; requestedBucketCode: string | null; note: string | null },
  actor: BookingActor,
): Promise<RerouteOutcome> {
  return confirmReroute(realRerouteDeps(actor), { bookingId, ...input, actor });
}

/** Let a booking's held advisor go (Cancel, or the admin walking away). */
export function adminReleaseReroute(bookingId: string, actor: BookingActor): Promise<{ released: boolean }> {
  return releaseReroute(realRerouteDeps(actor), bookingId);
}

/** The booking's live hold, so a reload restores the confirm panel and its countdown. */
export function adminCurrentReroute(bookingId: string, actor: BookingActor): Promise<RerouteProposal | null> {
  return currentReroute(realRerouteDeps(actor), bookingId);
}

/**
 * Coverage move with NO human actor (#1241): the offboarding automation deactivated
 * the agent, so there is no person in the request to hold accountable and the move
 * is recorded as `initiator: "system"`, exactly like the machine contact-owner
 * reassign path above. Reached only for a job that recorded why it has no actor.
 *
 * `allowNonBookable` matches the admin path deliberately: the target came from
 * `selectCoverageReassignTarget` either way, and the two sweeps must not disagree
 * about who may cover.
 */
export function systemReassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  /** #1677: commit only if the booking is still in this state (`ReassignOptions.expect`). */
  expect?: orchestration.ReassignExpectation,
): Promise<BookingResult & { overCap: boolean }> {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(deferWebhookSend), {
    overrideCap: false,
    initiator: "system",
    allowNonBookable: true,
    ...(expect ? { expect } : {}),
  });
}

/**
 * The live coverage-target deps (#972, #3308): Reroute's own search, wired exactly as
 * `realRerouteDeps` wires it, so the sweep, Reroute and the booker answer "who can take
 * this call" by one rule (the round robin over the cached free advisors, then the live
 * verify). The current advisor's picture is never read: the sweep searches the booking
 * as unassigned (`selectCoverageReassignTarget`).
 */
function realCoverageTargetDeps(): CoverageTargetDeps {
  const base = realDeps();
  const searchDeps = {
    resolveBucketByCode: base.resolveBucketByCode,
    roundRobinCandidates: base.roundRobinCandidates,
    loadEmails: base.loadEmails,
    verifyFree: base.verifyFree,
    loadCurrentAgentPicture,
    now: () => Date.now(),
  };
  return {
    findTarget: (booking, requested, excludeUserIds) =>
      orchestration.findRerouteTarget(searchDeps, booking, requested, { excludeUserIds }),
    userIdsOnApprovedTimeOff,
    // #3485: the booker's own round robin at the fixed time with the buffers taken off, so
    // the reason a call is unplaceable can say when the gap was what blocked. A preview read
    // (no unfair ordering page), cache only.
    freeForBareCall: async (booking, requested, excludeUserIds) => {
      const bare = { ...requested.eventType, buffer_before_min: 0, buffer_after_min: 0 };
      const { candidates } = await base.roundRobinCandidates(
        requested.bucket,
        bare,
        Date.parse(booking.starts_at),
        true,
        undefined,
        false,
        { fixedTime: true, forBookingId: booking.id },
      );
      return candidates.filter((id) => !excludeUserIds.includes(id));
    },
  };
}

/**
 * A coverage move onto an advisor found on a LOWER rung of the tier ladder (#3485 Part 1):
 * the call moves into that rung's bucket through Reroute's own hold and bucket aware swap
 * (`moveCoverageAcrossBuckets`), recorded as the sweep's actor exactly as the plain move
 * beside it is, with the cap honoured.
 *
 * The hold lives only for the seconds the move takes, so placing and releasing it does not
 * refresh the advisor's pools: that refresh changes only the times the booker OFFERS (a
 * held advisor is refused at booking by the hold's own busy block and trigger, migrations
 * 0166 and 0167), it cost about four seconds a pool when awaited (#3307), and the drain
 * shares its invocation with the other every minute lanes. The move's own write through
 * and the every minute recompute bring the offer up to date.
 */
async function coverageMoveAcrossBuckets(
  bookingId: string,
  targetEmail: string,
  reason: ValidatedReason,
  sweepActor: ReturnType<typeof coverageSweepActor>,
  placement: CoveragePlacement,
  /** #1677: commit only if the booking is still in this state. */
  expect?: orchestration.ReassignExpectation,
): Promise<void> {
  const base = realDeps(deferWebhookSend);
  const ctx = await base.loadBookingById(bookingId);
  if (!ctx) throw new orchestration.BookingNotFoundError();
  const holds = { ...rerouteHoldStoreDeps("coverage", "inline"), refreshPools: async () => {} };
  const who =
    sweepActor.kind === "system"
      ? { initiator: "system" as const }
      : { initiator: "admin" as const, actor: { userId: sweepActor.userId, actingAsUserId: sweepActor.actingAsUserId } };
  await moveCoverageAcrossBuckets(
    {
      placeHold: (args) => placeRerouteHold(args, holds),
      claimHold: async (orgId, id, holdId) =>
        readClaimedRerouteHold(
          unwrap(
            await supabaseAdmin().rpc("claim_reroute_hold", { p_org_id: orgId, p_booking_id: id, p_hold_id: holdId }),
            "claim_reroute_hold",
          ),
          id,
        ),
      reassign: async (id, email, swap) => {
        await orchestration.reassignBooking(id, email, reason, base, {
          ...who,
          overrideCap: false,
          allowNonBookable: true,
          reroute: swap,
          ...(expect ? { expect } : {}),
        });
      },
      releaseHold: (id) => releaseRerouteHold(id, holds),
      onReleaseFailed: (id, err) => {
        log.error("bulk-reassign", { msg: "could not release a coverage move's hold after it failed; it stays until its lease ends", booking_id: id }, err);
      },
    },
    {
      booking: ctx.booking,
      agentUserId: placement.advisorUserId,
      agentEmail: targetEmail,
      from: ctx.bucket,
      to: placement.bucket,
      rungsDropped: placement.rungsDropped,
      createdBy: sweepActor.kind === "system" ? null : sweepActor.userId,
    },
  );
}

/** The live bulk-reassign engine deps (#973): the store reads/writes plus the
 *  per-item target selection (live-verified) and the reassign (adminReassignBooking,
 *  cap honored: the covering agent was picked under cap). */
function realBulkReassignDeps(): BulkReassignDeps {
  return {
    loadPendingItems: loadPendingBulkReassignItems,
    loadBooking: loadBookingSnapshot,
    selectTarget: async (snapshot) => {
      const ctx = await realDeps().loadBookingById(snapshot.id);
      if (!ctx) return { assignment: null, anyUnverified: false };
      return selectCoverageReassignTarget(
        { booking: ctx.booking, bucket: ctx.bucket, eventType: ctx.eventType },
        realCoverageTargetDeps(),
      );
    },
    reassign: async (bookingId, targetEmail, job, placement, expect) => {
      // Who the move is recorded as. Throws for a job that has neither an actor nor
      // a recorded reason for having none, which is the same refusal as before:
      // #1241 added the offboarding case, it did not widen the guard (see
      // coverage-sweep-actor.ts).
      const sweepActor = coverageSweepActor(job);
      // Why the move is recorded. Throws for a job with no reason code. Structural
      // only, never a re-check against the live option set (#346): see
      // coverage-sweep-actor.ts.
      const reason = coverageSweepReason(job);
      // Downstream signal (#975): a coverage move reuses adminReassignBooking, so
      // it emits the SAME booking.reassigned webhook every reassign already does
      // (#2368; it was booking.rescheduled until then, which told Regal a time
      // change had happened when none had). That event carries reassignReason
      // (here "coverage"), the advisor it moved from and the one it moved to, and
      // the unchanged start, plus the tier-fallback props. is_test bookings are
      // suppressed at the fire() chokepoint. No coverage-specific webhook is
      // warranted: the reason is what tells a Regal journey which move this is.
      //
      // Cap is NOT overridden: the covering agent was selected under their daily
      // cap. The manual force-override (#974) is the only path that overrides.
      //
      // A pick on a lower rung (#3485) moves across buckets through Reroute's hold and
      // swap; a pick in the call's own bucket is a plain reassign. Within each, system
      // and staff sweeps differ ONLY in who the move is recorded as: everything that
      // decides which bookings move, and where they land, is shared, so an offboarding
      // sweep and an admin's sweep can never cover an agent differently.
      //
      // #1677: every branch commits only if the booking is still where the selection saw
      // it (`expect`); a refusal for that reaches the engine as `BookingMovedMidMoveError`.
      try {
        if (placement) {
          await coverageMoveAcrossBuckets(bookingId, targetEmail, reason, sweepActor, placement, expect);
          return;
        }
        if (sweepActor.kind === "system") {
          await systemReassignBooking(bookingId, targetEmail, reason, expect);
          return;
        }
        const actor: BookingActor = {
          userId: sweepActor.userId,
          actingAsUserId: sweepActor.actingAsUserId,
        };
        await adminReassignBooking(bookingId, targetEmail, reason, actor, false, expect);
      } catch (err) {
        if (err instanceof RerouteRefusedError && err.code === "booking_moved") throw new BookingMovedMidMoveError();
        throw err;
      }
    },
    claimItem: claimBulkReassignItem,
    recordAudit,
    commitItemOutcome: commitBulkReassignItemOutcome,
    markJobDoneIfDrained: markBulkReassignJobDoneIfDrained,
    jobFinished: (job) =>
      reportDemotionSweepOutcome(job, {
        loadItemStatuses: loadBulkReassignItems,
        log: (fields) => log.info("bulk-reassign", fields),
      }),
  };
}

/**
 * Move a rerouted call back to the advisor a demotion sweep moved it off (#3615). The decisions
 * and their order live in `demotion-revert.ts`; this wires the reads, the standard admin reassign
 * (so the lead's invite, both calendars and Regal hear about it as about any reassign, with the
 * same `coverage` reason the move carried, Dan 2026-10-11) and the recorded undo.
 */
export function adminMoveBackDemotionReroute(
  bookingId: string,
  orgId: string,
  actor: BookingActor,
  overrideCap: boolean,
): Promise<MoveBackOutcome> {
  return moveBackDemotionReroute(
    {
      loadMoves: loadDemotionMoves,
      loadBooking: async (id, org) =>
        unwrap(
          await supabaseAdmin()
            .from("bookings")
            .select("status, assigned_user_id, starts_at")
            .eq("id", id)
            .eq("org_id", org)
            .maybeSingle(),
          "move back: booking",
        ) as { status: string; assigned_user_id: string | null; starts_at: string } | null,
      loadUser: async (id) =>
        unwrap(
          await supabaseAdmin().from("users").select("email, deactivated_at").eq("id", id).maybeSingle(),
          "move back: original advisor",
        ) as { email: string | null; deactivated_at: string | null } | null,
      reassign: async (id, toEmail, override) => {
        await adminReassignBooking(
          id,
          toEmail,
          { code: DEMOTION_SWEEP_REASON.code, detail: MOVE_BACK_REASON_DETAIL },
          actor,
          override,
        );
      },
      markReverted: markDemotionMoveReverted,
      recordAudit,
    },
    { bookingId, orgId, actor, overrideCap, nowMs: Date.now() },
  );
}

/**
 * Drain ONE sweep's pending items under the lane's own lease (#3615), for the reroute drill. The
 * decisions (wait while the lane holds the lease, accept the lane draining it, throw if nobody
 * did) live in `drainOneJob`. The sleep is injectable; the drill's endpoint uses the real one.
 */
export function drainBulkReassignJob(
  jobId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<"drained"> {
  return drainOneJob(
    {
      acquire: async () => {
        // lock-overlap: fenced, the lane's own lease. While the lane holds it this waits rather
        // than moving calls beside it, and the drain renews and stops on `stillHeld` (#3120).
        const lease = await acquireLease(BULK_REASSIGN_LANE_LOCK, CRON_LOCK_TTL_MS);
        return lease
          ? {
              release: async () => {
                await releaseLock(BULK_REASSIGN_LANE_LOCK, lease.token());
              },
              stillHeld: () => lease.stillHeld(),
            }
          : null;
      },
      drain: async (stillHeld) => {
        await drainBulkReassign(
          { ...realBulkReassignDeps(), loadPendingItems: (limit) => loadPendingBulkReassignItems(limit, jobId) },
          undefined,
          stillHeld,
        );
      },
      pendingCount: () => countPendingBulkReassignItems(jobId),
      sleep,
    },
    { attempts: 12, waitMs: 10_000 },
  );
}

/** Drain one bounded tick of the bulk-reassign engine (the cron lane). */
export function drainBulkReassignJobs(
  stillHeld?: () => Promise<boolean>,
): Promise<BulkReassignDrainSummary> {
  return drainBulkReassign(realBulkReassignDeps(), undefined, stillHeld);
}

/**
 * Re-arm stranded (unplaceable) coverage calls so the drain re-attempts them (#3485 part
 * C, the hourly retry lane). Wires the real store reads and writes into the pure retry.
 */
export function retryUnplaceableCoverageJobs(): Promise<CoverageRetrySummary> {
  return retryUnplaceableCoverage({
    loadRetryable: () => loadRetryableUnplaceable(new Date().toISOString()),
    reArm: (ids) => reArmUnplaceableItems(ids),
  });
}

/** How many of the out agent's active upcoming bookings a coverage sweep over
 *  [rangeStart, rangeEnd) would move (the #974 preview count). */
export function previewBulkReassign(
  outUserId: string,
  rangeStartIso: string,
  rangeEndIso: string | null,
): Promise<number> {
  return coverageBookingIds(outUserId, rangeStartIso, rangeEndIso).then((ids) => ids.length);
}

export interface StartBulkReassignInput {
  outUserId: string;
  rangeStartIso: string;
  rangeEndIso: string | null;
  reason: ValidatedReason;
  /** The staff user accountable for the moves, or null for a sweep the offboarding
   *  automation triggered, which has no person in the request at all (#1241). Null
   *  is only accepted alongside `offboardingDeactivatedAtIso`, which is the record
   *  of WHY there is nobody: an actor lost by accident must not read as a system
   *  action. */
  actor: BookingActor | null;
  /** The approved time off this sweep covers, when it came from one (#1237). Present makes
   *  the enqueue idempotent by database key on (request, window), so re-approving or retrying
   *  converges on ONE sweep rather than moving customers' bookings twice. Absent for an
   *  admin-initiated sweep, which has no request to key on. */
  oooRequestId?: string | null;
  /** The offboarding deactivation this sweep covers (#1241), when the lifecycle API
   *  triggered it. Makes the enqueue idempotent by database key on (agent,
   *  deactivation), so a retried or concurrent offboarding call converges on ONE
   *  sweep rather than moving customers' bookings twice. */
  offboardingDeactivatedAtIso?: string | null;
  /** The Twilio redistribute pool exit this sweep covers (#2115), when the hourly
   *  roster sync triggered it. Makes the enqueue idempotent by database key on
   *  (agent, mark), so a sync that crashed between the mark and the flip converges
   *  on ONE sweep rather than moving customers' bookings twice. */
  redistributeMarkedAtIso?: string | null;
  /** The Twilio tier/pool DEMOTION this sweep covers (#3582), when the hourly roster
   *  sync triggered it. Makes the enqueue idempotent by database key on (agent,
   *  demotion mark), so a crashed or re-run sync converges on ONE sweep. Unlike the
   *  keys above a demotion is PARTIAL, so it is paired with `snapshotBookings` (the
   *  filtered set) rather than the full coverage read. */
  demotionMarkedAtIso?: string | null;
  /** What the demotion changed (#3615), recorded on the job. See `CreateBulkReassignJobInput`. */
  demotionChange?: DemotionChange | null;
  /** The bookings this sweep should move, when the caller already knows them: the
   *  demotion case passes the FILTERED set (only the bookings the agent no longer
   *  serves). Absent means the full coverage read. */
  snapshotBookings?: () => Promise<CoverageBookingRow[]>;
}

/**
 * Start a coverage sweep for one out agent (#974). Resolves the job's org from
 * the out agent (verifying it exists), then snapshots its work. The accountable
 * actor maps onto created_by / acting_as_user_id.
 */
export async function startBulkReassign(
  input: StartBulkReassignInput,
): Promise<{ jobId: string; itemCount: number; snapshot: CoverageBookingRow[] }> {
  // A sweep moves customers' appointments, so it may only go unattributed when it
  // can say why. Refused here, at the one place every sweep is created, rather
  // than at the drain, where the job row already exists and the bookings are
  // already snapshotted.
  if (
    !input.actor &&
    !input.offboardingDeactivatedAtIso &&
    !input.redistributeMarkedAtIso &&
    !input.demotionMarkedAtIso
  ) {
    throw new Error("a coverage sweep with no accountable actor must record why it has none");
  }
  const orgId = await loadUserOrgId(input.outUserId);
  if (!orgId) throw new orchestration.AgentNotAvailableError();
  return createBulkReassignJob({
    orgId,
    outUserId: input.outUserId,
    rangeStartIso: input.rangeStartIso,
    rangeEndIso: input.rangeEndIso,
    reasonCode: input.reason.code,
    reasonDetail: input.reason.detail,
    createdBy: input.actor?.userId ?? null,
    actingAsUserId: input.actor?.actingAsUserId ?? null,
    oooRequestId: input.oooRequestId ?? null,
    offboardingDeactivatedAtIso: input.offboardingDeactivatedAtIso ?? null,
    redistributeMarkedAtIso: input.redistributeMarkedAtIso ?? null,
    demotionMarkedAtIso: input.demotionMarkedAtIso ?? null,
    demotionChange: input.demotionChange ?? null,
    snapshotBookings: input.snapshotBookings,
  });
}

/**
 * Stop every coverage sweep an approved time-off request produced (#1665), and
 * answer what that stopped and what had already moved.
 *
 * Throws on a write it could not make, deliberately: the caller pages and tells the
 * reader it could not be confirmed, and a stop reported as done while customers are
 * still being handed over is the one answer nobody can act on.
 */
export function stopCoverageSweepForRequest(
  oooRequestId: string,
): Promise<CoverageSweepCancelReport> {
  return cancelCoverageSweepForRequest(oooRequestId);
}

/** The job's status + per-status counts + the actionable list (#974), or null if
 *  the job id is unknown. Composition is the pure `buildBulkReassignProgress`. */
export async function getBulkReassignProgress(jobId: string): Promise<BulkReassignProgress | null> {
  const job = await loadBulkReassignJob(jobId);
  if (!job) return null;
  const items = await loadBulkReassignItems(jobId);
  // #2122: the SKIPPED bookings need their context too, or the panel lists them
  // with a blank name and no time. They are fetched in the same read rather than a
  // second one: the ids go into one lookup, and a skip is bounded by the same job.
  // #3615: a demotion sweep's moved calls are listed too, so they need the same context.
  const shown = [
    ...ACTIONABLE_ITEM_STATUSES,
    ...SKIPPED_ITEM_STATUSES,
    ...(job.demotion_marked_at ? MOVED_ITEM_STATUSES : []),
  ];
  const shownIds = items.filter((it) => shown.includes(it.status)).map((it) => it.booking_id);
  const ctx = await loadActionableBookingContext(shownIds);
  // #3615: for a demotion sweep, the advisor its calls left, so each moved row can say whether it
  // can still go back, by the booking page's own planner.
  const moveBack = job.demotion_marked_at
    ? {
        original: unwrap(
          await supabaseAdmin().from("users").select("email, deactivated_at").eq("id", job.out_user_id).maybeSingle(),
          "bulk reassign progress: original advisor",
        ) as { email: string | null; deactivated_at: string | null } | null,
        nowMs: Date.now(),
      }
    : undefined;
  return buildBulkReassignProgress(job, items, ctx, moveBack);
}

export function completePastBookings(): Promise<{
  completed: number;
  backlogRemains: boolean;
}> {
  return orchestration.completePastBookings(realDeps());
}

/**
 * Cancel the demo bookings that have run their 30 minutes (#3424), on the complete
 * lane. The rule and its failure handling live in `demo-auto-cancel.ts`; this is
 * the read and the cancel it is handed. The cancel is the ordinary one, initiated
 * by the system, so the calendar event and busy block go exactly as they would for
 * a visitor's own cancel.
 */
export function cancelDueDemoBookingsNow(nowMs: number = Date.now()) {
  return cancelDueDemoBookings(
    {
      listDue: async (cutoffIso, limit) => {
        const rows = unwrap(
          await supabaseAdmin()
            .from("bookings")
            .select("id, manage_token, buckets!inner(code)")
            .eq("buckets.code", DEMO_BUCKET_CODE)
            .in("status", ["confirmed", "rescheduled"])
            .lte("created_at", cutoffIso)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(limit),
          "demo auto cancel due",
        ) as { id: string; manage_token: string }[];
        return rows.map((r) => ({ id: r.id, manageToken: r.manage_token }));
      },
      cancel: async (token) => (await cancelBooking(token, DEMO_AUTO_CANCEL_REASON, "system")).claimed,
      reportFailure: (bookingId, err) => {
        log.error("complete", { msg: "demo auto cancel failed for a booking", booking_id: bookingId }, err);
      },
    },
    nowMs,
  );
}

/** The booking a manage token opens, followed past a cross bucket move (#3672). */
export function getBookingByToken(token: string): Promise<ManageLookup | null> {
  return orchestration.getBookingByToken(token, realDeps());
}

/** The lead's contact and add to calendar links for one booking (#2643), on this
 *  deployment's own base URL. */
export function bookingDetailExtras(b: Booking) {
  return orchestration.bookingDetailExtras(b, appUrl());
}

/** The manage page for one booking's token, on this deployment's own base URL. */
export function bookingManageUrl(token: string): string {
  return orchestration.manageUrlFor(appUrl(), token);
}

/** The ICS file for one booking (#2643), stamped with the moment it was made. */
export function bookingIcs(b: Booking, stampIso: string): string {
  return orchestration.bookingIcs(b, appUrl(), stampIso);
}

/**
 * The name of the advisor a booking is currently with, for the manage page
 * (#1338), or null when it cannot be resolved.
 *
 * Read LIVE from the assignee, never a copy captured when the booking was made:
 * coverage reassignment (#1219) and the bulk reassign path both move a booking to
 * a different agent, so a stamped name would promise a lead one person and send
 * another. Null means the page renders no name at all rather than substituting
 * anything (L75).
 */
export function getBookingAdvisorName(
  assignedUserId: string | null,
): Promise<string | null> {
  return resolveAdvisorName(
    supabaseAdmin() as unknown as AdvisorNameReader,
    assignedUserId,
  );
}

/** The advisor's photo (#2600, #3027), resolved live beside the name and for
 *  the same reason: a booking can be reassigned, so a stamped one would show a
 *  lead the face of somebody who is no longer taking their call. */
export function getBookingAdvisorPhoto(
  assignedUserId: string | null,
): Promise<string | null> {
  return resolveBookingAdvisorPhoto(
    { readUser: loadUserSignInPhoto, readRecords: loadPhotoRecords },
    assignedUserId,
  );
}

/**
 * The number a booking's call will come FROM (#1334), for the manage page: the
 * lead's Salesforce `AssignedRegalPhone__c`, or null on every way it can be
 * unknown (no lead id, an empty or unreadable field, a refused or slow read). The
 * page then says nothing about a number. Under a deadline, because a lead opening
 * their booking must never wait on Salesforce for a line of help text; a refused
 * or slow read is logged with its reason so "nobody had a number" and "Salesforce
 * was down" stay apart. The same helper bounds the phone correction.
 */
export function getBookingCallingNumber(
  booking: Pick<Booking, "id" | "salesforce_id" | "external_id">,
): Promise<string | null> {
  return callingNumberWithinDeadline(
    () => readCallingNumberLive(bookingLeadId(booking)),
    (err) =>
      log.warn("manage-page", {
        msg: "calling number unread, page shown without it",
        booking_id: booking.id,
        reason: shortErrorReason(err),
      }),
  );
}

const PENDING_DELETION_ALERT_KEY = "pending_event_deletions";
const PENDING_DELETION_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** #2577: rows the drain stopped retrying because Google refused the calendar for
 *  good. An INCIDENT (the retrying is over; there is no state to clear), on its own
 *  key because its remedy is a person fixing an account, not API health. */
const PENDING_DELETION_REFUSED_ALERT_KEY = "pending_event_deletions_refused";
const PENDING_DELETION_REFUSED_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** #1630: the same refusals for a calendar whose owner has LEFT. Info, never a
 *  page: no account needs fixing and nobody can act, so it is on the record and
 *  wakes nobody (L112, L36). Its own key, so a departure never throttles the page
 *  about an account that does need fixing, or the other way round. */
const PENDING_DELETION_DEPARTED_INFO_KEY = "pending_event_deletions_departed";
const PENDING_DELETION_DEPARTED_INFO_COOLDOWN_MS = 30 * 60 * 1000;

/** #401: drain the deletion retry queue and alert if any deletion is stuck. */
export async function processPendingEventDeletions(limit: number) {
  // all-clear-proof: src/lib/booking/selfheal-worklist-reads.test.ts - pins that a
  // failed worklist read aborts the tick and announces no recovery, for this sweep
  // and its two siblings below.
  const deps = realDeps();
  const res = await orchestration.processPendingEventDeletions(deps, limit);
  if (res.refused.length > 0) {
    // #2577: ended on this pass, never retried again, so the copy names who has to
    // fix each account. Kept apart from `stuck` below in both directions: a refused
    // row never feeds the stuck page, and never holds its recovery back.
    //
    // #1630: split by whether the calendar's owner has left. Google says the same
    // thing for a revoked licence as for one never granted, so a departure reads as
    // a provisioning request unless Slate says who left. An owner nobody could read
    // keeps the page, since departure is claimed only where it was read.
    const facts = await orchestration.describeRefusedDeletions(deps, res.refused);
    const notices = refusedDeletionNotices(facts.rows, facts.owners);
    if (notices.page) {
      await sendThrottledAlert(
        PENDING_DELETION_REFUSED_ALERT_KEY,
        PENDING_DELETION_REFUSED_ALERT_COOLDOWN_MS,
        notices.page,
      ).catch(logAlertSendFailure(PENDING_DELETION_REFUSED_ALERT_KEY));
    }
    if (notices.departed) {
      await sendThrottledInfo(
        PENDING_DELETION_DEPARTED_INFO_KEY,
        PENDING_DELETION_DEPARTED_INFO_COOLDOWN_MS,
        notices.departed,
      ).catch(logAlertSendFailure(PENDING_DELETION_DEPARTED_INFO_KEY));
    }
  }
  if (res.stuck.length > 0) {
    await sendThrottledAlert(
      PENDING_DELETION_ALERT_KEY,
      PENDING_DELETION_ALERT_COOLDOWN_MS,
      pendingDeletionAlert(res.stuck.length, orchestration.PENDING_DELETION_ALERT_AFTER, res.stuck.slice(0, 5).map((r) => String(r.gcal_event_id))),
    ).catch(logAlertSendFailure(PENDING_DELETION_ALERT_KEY));
  } else {
    // #1151: stuck deletions are a CONDITION (events keep firing reminders until
    // they drain), so say when the queue is clean. Hung off a sweep that RAN and
    // measured no stuck rows: a sweep that threw never reaches this line, so a
    // failed tick can never read as recovery.
    await resolveRecovered([
      {
        key: PENDING_DELETION_ALERT_KEY,
        text: pendingDeletionRecovery(),
      },
    ]);
  }
  return res;
}

const CREATION_ORPHAN_ALERT_KEY = "creation_orphan_events";
const CREATION_ORPHAN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * #830: alert EARLY (and distinctly from the deletion-retry alert) when a create
 * succeeded on Google but its booking never persisted, and the event STILL
 * exists, so it may be firing reminders to the customer for a booking Slate has
 * no record of. Verified-existing only, so an agent-deleted stray stays quiet.
 */
export async function checkCreationOrphans(limit: number) {
  const res = await orchestration.checkCreationOrphans(realDeps(), limit);
  if (res.confirmed.length > 0) {
    await sendThrottledAlert(
      CREATION_ORPHAN_ALERT_KEY,
      CREATION_ORPHAN_ALERT_COOLDOWN_MS,
      creationOrphanAlert(
        res.confirmed.length,
        res.confirmed.slice(0, 5).map((r) => String(r.gcal_event_id)),
      ),
    ).catch(logAlertSendFailure(CREATION_ORPHAN_ALERT_KEY));
  }
  return res;
}

const RECONCILE_ALERT_KEY = "reconcile_busy_blocks";
const RECONCILE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * #428 reconcile sweep: free busy_blocks whose booking is cancelled/missing so a
 * slot stuck busy after a crash self-heals, then recompute the affected buckets
 * (bounded) so the reopened slot shows in the embed promptly. Freeing anything
 * means a write-through delete was missed, so a throttled Slack note flags it
 * for visibility (not a page).
 */
export async function reconcileCancelledBusyBlocks(limit: number, offset = 0) {
  const res = await orchestration.reconcileCancelledBusyBlocks(realDeps(), limit, offset);
  if (res.freed === 0) return res;

  // Refresh the freed agents' pools: one batched bucket lookup (#762), then one
  // compute per POOL, at most MAX_TOUCHED_POOLS_PER_SWEEP of them (#2357). This
  // used to loop a whole pool compute per CODE, up to 25 with no time bound, which
  // is what ran this lane to its 180 s on the load test Worker. Never throws and
  // logs its own outcome; the recompute lane owns convergence of anything left.
  await refreshPoolsForAgents(res.userIds, "reconcile");

  const freedText = reconcileFreedAlert({
    freedCancelled: res.freedCancelled,
    freedOrphans: res.freedOrphans,
    agentCount: res.userIds.length,
    // #3585: name which bookings were freed (first 10), so a genuine missed write is
    // distinguishable from the cancel/reconcile race in the log.
    bookingIds: res.freedBookingIds.slice(0, 10).map(String),
    bookingIdsTruncated: res.freedBookingIds.length > 10,
  });
  await sendThrottledAlert(
    RECONCILE_ALERT_KEY,
    RECONCILE_ALERT_COOLDOWN_MS,
    freedText,
  ).catch(logAlertSendFailure(RECONCILE_ALERT_KEY));

  return res;
}

const RECONCILE_MISSING_ALERT_KEY = "reconcile_missing_busy_blocks";

/**
 * Reconcile-missing sweep (#431): re-create busy_blocks for active upcoming
 * bookings whose write-through INSERT was missed (the slot was showing free and
 * could be double-booked), then recompute those buckets so the slot flips busy
 * within ~1 min. Counterpart to reconcileCancelledBusyBlocks. Safe to run every
 * tick: the pure core only ever inserts (busy-over-free), never deletes.
 */
export async function reconcileMissingBusyBlocks(limit: number, offset = 0) {
  const res = await orchestration.reconcileMissingBusyBlocks(realDeps(), limit, offset);
  if (res.recreated === 0) return res;

  // A missing block made the agent look free in EVERY bucket they serve, so
  // refresh all of each affected agent's pools, exactly as the #428 sweep does for
  // freed agents, not just the booking's own bucket. Same shared, bounded refresh
  // (#2357).
  await refreshPoolsForAgents(res.userIds, "reconcile-missing");

  await sendThrottledAlert(
    RECONCILE_MISSING_ALERT_KEY,
    RECONCILE_ALERT_COOLDOWN_MS,
    reconcileRecreatedAlert(res.recreated, res.bookingIds.slice(0, 10).map(String), res.bookingIds.length > 10),
  ).catch(logAlertSendFailure(RECONCILE_MISSING_ALERT_KEY));

  return res;
}

/**
 * How many pending rows a durable drain holds at or past the stuck-alert threshold
 * (#3359), read from the table rather than from one tick's batch. A server side
 * count, so no rows (and no attendee payload) come back. THROWS on a failed read:
 * the caller treats that as unmeasured and clears nothing, where a 0 would announce
 * a recovery nobody measured (#1165).
 */
async function countStoredStuckRows(table: "booking_outbox" | "booking_reservations"): Promise<number> {
  try {
    return unwrapCount(
      await supabaseAdmin()
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("attempts", DRAIN_ALERT_AFTER),
      `${table} stuck rows`,
    );
  } catch (err) {
    log.warn("outbox", { msg: "stuck row count unreadable; the stuck all-clear waits for a tick that can read it", table }, err);
    throw err;
  }
}

/**
 * #429 P2 drain: resume any undelivered booking-outbox row, re-running only its
 * not-done steps idempotently. Driven by the dedicated /api/cron/outbox lane. A
 * no-op until producers (P3/P4) write rows and register handlers.
 */
export async function drainBookingOutbox() {
  const result = await processBookingOutbox(
    realDeps(),
    OUTBOX_DRAIN_LIMIT,
    orchestration.OUTBOX_HANDLERS,
  );
  // #1048: did this tick actually MEASURE delivery? A row that stood down (its lease
  // had moved on, or a gated write failed) is charged no failed attempt, deliberately,
  // so a tick where every leased row stood down learns nothing about whether side
  // effects are completing. Two consequences, and the second is the one that bites:
  // it needs its own alarm, because it can never reach the attempt-cap one; and it
  // must not send the all-clear, which would be a recovery notice off a signal that
  // measured nothing (#1152).
  const leased = result.processed - result.skipped;
  const allHandedOff = everyLeasedRowStoodDown(result);
  if (allHandedOff) {
    const page = await recordConsecutiveStreak(
      OUTBOX_HANDOFF_STREAK_KEY,
      OUTBOX_HANDOFF_STREAK_WINDOW_S,
      OUTBOX_HANDOFF_ALERT_AFTER,
    );
    if (page) {
      await sendThrottledAlert(
        OUTBOX_HANDOFF_STREAK_KEY,
        DRAIN_ALERT_COOLDOWN_MS,
        outboxAllHandedOffAlert(leased, OUTBOX_HANDOFF_ALERT_AFTER),
      ).catch(logAlertSendFailure(OUTBOX_HANDOFF_STREAK_KEY));
    }
  } else {
    await clearFailureStreak(OUTBOX_HANDOFF_STREAK_KEY);
  }

  // #1151: a backing-off outbox is a CONDITION (the side effects of real bookings
  // are not completing), so say when it drains. #3359: and say it from the STORED
  // rows. A backing-off row is not loaded on most ticks, so "this batch held nothing
  // stuck" is not "nothing is stuck", and clearing on it paged and all-cleared in
  // turn about a row that never moved. The hand-off streak is cleared beside it only
  // on a tick that did not stand every row down, which is what measures it.
  await settleDrainStuckAlert(
    result.stuck,
    { key: "outbox_drain_stuck", text: outboxDrainRecovery() },
    {
      countStoredStuck: () => countStoredStuckRows("booking_outbox"),
      page: (count, ids) =>
        sendThrottledAlert(
          "outbox_drain_stuck",
          DRAIN_ALERT_COOLDOWN_MS,
          outboxDrainStuckAlert(count, DRAIN_ALERT_AFTER, ids),
        ).catch(logAlertSendFailure("outbox_drain_stuck")),
      // alert-key: outbox_drain_stuck
      // alert-key: outbox_all_handed_off
      // all-clear-proof: scripts/test-drain-stuck-alert.ts - an unreadable store, or one still holding a stuck row, never announces recovery.
      resolve: (entries) => resolveRecovered(entries).then(() => undefined),
    },
    allHandedOff ? [] : [{ key: OUTBOX_HANDOFF_STREAK_KEY, text: outboxHandoffRecovery() }],
  );
  // #1048: a handed-off row means a run stood down because its lease had moved on
  // (or a gated write failed). Under normal operation this is zero, so a non-zero
  // count is worth a line: it says a holder overran the two minute lease while a
  // second one took the row, which is the only way to see that from outside.
  // Logged rather than alerted, because nothing is broken and nothing is lost: the
  // holder that owns the row finishes it.
  if (result.handedOff > 0) {
    log.warn("outbox", {
      msg: "rows handed off mid-run",
      handed_off: result.handedOff,
      processed: result.processed,
    });
  }
  // Return a PII-free summary: the full stuck rows carry attendee data in their
  // payload, and this flows into the cron HTTP response body.
  const { stuck, ...summary } = result;
  return { ...summary, stuck: stuck.length };
}

/**
 * #429 P4 (Phase C): resume create reservations whose booking crashed mid-create,
 * then sweep abandoned ones (delete-on-deliver keeps delivered rows from
 * lingering; this clears the rest, PII included). Driven by the /api/cron/outbox
 * lane next to the outbox drain.
 */
export async function drainBookingReservations() {
  const deps = realDeps();
  const result = await orchestration.processBookingReservations(
    deps,
    RESERVATION_DRAIN_LIMIT,
  );
  // #1151: same CONDITION on the reservation side, and #3359: the same stored-state
  // rule. This is the drain that alternated page and all-clear on 2026-10-06.
  await settleDrainStuckAlert(
    result.stuck,
    { key: "reservation_drain_stuck", text: reservationDrainRecovery() },
    {
      countStoredStuck: () => countStoredStuckRows("booking_reservations"),
      page: (count, ids) =>
        sendThrottledAlert(
          "reservation_drain_stuck",
          DRAIN_ALERT_COOLDOWN_MS,
          reservationDrainStuckAlert(count, DRAIN_ALERT_AFTER, ids),
        ).catch(logAlertSendFailure("reservation_drain_stuck")),
      // alert-key: reservation_drain_stuck
      // all-clear-proof: scripts/test-drain-stuck-alert.ts - an unreadable store, or one still holding a stuck row, never announces recovery.
      resolve: (entries) => resolveRecovered(entries).then(() => undefined),
    },
  );
  // Retention: delete up to a batch of pending reservations older than the TTL
  // whose booking never committed, and KEEP every one whose booking committed with
  // booking.created still owed (#3847): it is the only record Regal was never told.
  const cutoff = new Date(Date.now() - RESERVATION_RETENTION_MS).toISOString();
  const sweep = await deps
    .deleteExpiredReservations(cutoff, RESERVATION_DRAIN_LIMIT)
    // Best-effort retention trim; the next tick retries the same cutoff. Logged
    // so a cleanup that never succeeds does not grow the table in silence. A failed
    // sweep measured nothing, so it neither pages nor clears the owed alert below.
    .catch((err): null => {
      log.warn("booking", {
        msg: "expired-reservation cleanup failed",
        reason: shortErrorReason(err),
      });
      return null;
    });
  // #3847: a kept reservation pages once a day until somebody sends booking.created
  // or removes it by hand, and clears only off a sweep that read every candidate.
  // Both seams log a failed notice and go on: the drain and the sweep have already
  // run, so a notice that could not be sent must not turn the tick into a failure.
  // The alert's state is unchanged, so the next tick tries the notice again.
  await settleOwedReservationAlert(sweep, {
    page: (count, ids) =>
      sendThrottledAlert(
        RESERVATION_OWED_ALERT_KEY,
        RESERVATION_OWED_ALERT_COOLDOWN_MS,
        reservationCreatedOwedAlert(count, ids),
      ).catch(logAlertSendFailure(RESERVATION_OWED_ALERT_KEY)),
    // alert-key: reservation_created_owed
    // all-clear-proof: scripts/test-reservation-retention.ts - a failed sweep never announces recovery.
    resolve: () =>
      resolveRecovered([{ key: RESERVATION_OWED_ALERT_KEY, text: reservationCreatedOwedRecovery() }]).then(
        () => undefined,
        logAlertSendFailure(RESERVATION_OWED_ALERT_KEY),
      ),
  });
  // PII-free summary (stuck rows carry attendee payload -> cron response body).
  const { stuck, ...summary } = result;
  return { ...summary, stuck: stuck.length };
}

/**
 * GC abandoned reschedule lease-pins (#439, milestone #7) on the /api/cron/outbox
 * lane. Cleanup ONLY — enqueues a never-adopted reassign event for deletion and
 * frees the stale lock; it never completes or reassigns a booking.
 *
 * ALERTS on a genuinely-lost reschedule (`dropped > 0`), like the #518 reassign
 * sweep it sits beside: cleaning one up in silence let a crashed, never-retried
 * reschedule vanish while the booking quietly stayed at its original time (#757).
 * A pin whose booking DID reach its target is not counted, so a merely-unreleased
 * lock stays quiet.
 *
 * #3924: an in place pin's lead invite is put back by the sweep, which the dropped
 * alert counts, and one it could not put back is posted on its own, per booking,
 * because each needs a person to look at that booking.
 */
export async function sweepAbandonedReschedulePins() {
  const result = await orchestration.processAbandonedReschedulePins(
    realDeps(),
    ABANDONED_PIN_GRACE_MS,
  );
  if (result.dropped > 0) {
    await sendThrottledAlert(
      "reschedule_pin_dropped",
      DRAIN_ALERT_COOLDOWN_MS,
      reschedulePinDroppedAlert(result.dropped, result.invitesPutBack),
    ).catch(logAlertSendFailure("reschedule_pin_dropped"));
  }
  for (const s of result.strandedInvites) {
    // The target rides in the key, so a later crash of another move of the same
    // booking is its own post rather than a repeat the cooldown swallows.
    const key = `${RESCHEDULE_INVITE_STRANDED_KEY}:${s.bookingId}:${Date.parse(s.targetStartsAt)}`;
    log.error("reschedule", {
      msg: "a crashed reschedule's invite was not put back",
      booking_id: s.bookingId,
      reason: s.reason,
      detail: s.detail,
    });
    // alert-key: reschedule_invite_stranded:*
    await sendThrottledAlert(
      key,
      STRANDED_INVITE_COOLDOWN_MS,
      strandedInviteAlert({ ...s, bookingUrl: `${appUrl()}/admin/bookings/${s.bookingId}` }),
    ).catch(logAlertSendFailure(key));
  }
  return result;
}

/** #3924: the per booking report of an invite the abandoned pin sweep could not put back. */
export const RESCHEDULE_INVITE_STRANDED_KEY = "reschedule_invite_stranded";
/** A day: each key names one crashed move, so this only stops one being posted twice. */
const STRANDED_INVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * GC abandoned standalone-reassign create intents (#518) on the /api/cron/outbox
 * lane. Cleanup ONLY: deletes the orphaned event(s) and frees the stale intent;
 * it never completes/reassigns (resume is a verified trap, see
 * processAbandonedReassignIntents). ALERTS when it finds a genuinely-lost reassign
 * (`dropped > 0`): the machine contact-owner override caller has no human retry
 * loop, so a silently-dropped reassignment would otherwise vanish ("fail loud, not
 * silent"). The reschedule sweep beside it now does the same (#757).
 */
export async function sweepAbandonedReassignIntents() {
  const result = await orchestration.processAbandonedReassignIntents(
    realDeps(),
    ABANDONED_PIN_GRACE_MS,
  );
  if (result.dropped > 0) {
    await sendThrottledAlert(
      "reassign_intent_dropped",
      DRAIN_ALERT_COOLDOWN_MS,
      reassignIntentDroppedAlert(result.dropped),
    ).catch(logAlertSendFailure("reassign_intent_dropped"));
  }
  return result;
}

/**
 * Cancel a lead's earlier call as a duplicate, on Regal's word about which call it is
 * but never on Regal's word that it IS one (#2369, #2307 phase 3).
 *
 * The whole decision, and the cancel itself, are one database call. Nothing about
 * "does this lead really have another call" is decided here, because deciding in one
 * place and cancelling in another leaves a window in which the later call is itself
 * cancelled and the lead ends up with none (L157), and because every loader on this
 * side swallows a read error to null, which reads as "no other call" and would stop
 * Regal retrying a real duplicate (L215).
 *
 * What IS here is the three things the database cannot do:
 *
 *  - record the refusal as a handoff, so somebody on the sales side cancels the right
 *    call by hand. A failed WRITE throws, because answering "refused, and somebody has
 *    been told" when nobody has is the silence `booking_handoffs` exists to end;
 *  - run the cancel's outbox row inline, so the calendar event, the slot recompute and
 *    the cancelled webhook happen now rather than on the next drain tick;
 *  - turn a call it could not MAKE, or a reply it could not READ, into
 *    `DuplicateCancelUnavailableError` rather than into an outcome.
 *
 * The inline run is deliberately NOT allowed to fail the request. By the time it runs
 * the cancel has committed and the durable row exists, so a failure here is a delayed
 * side effect that the /api/cron/outbox drain completes; answering 503 would invite a
 * retry that can only ever be told `already-cancelled`.
 */
export interface DuplicateCancelOutcome {
  result: DuplicateCancelResult;
  /** Whether this call opened the handoff row or found one already open. Null when
   *  the outcome records none. */
  handoff: RecordHandoffOutcome | null;
  /** Whether the inline outbox run delivered every step. Null when there was nothing
   *  to run, or when the row could not be read back. */
  delivered: boolean | null;
}

export async function cancelDuplicateBooking(input: {
  bookingId: string;
  /** When the caller says the LATER booking starts, exactly as it sent it. Stored on
   *  the handoff unchanged: it is the one thing Slate knows only because Regal said
   *  so, and a value Slate made up would read in the notice as something measured. */
  laterBookingStartsAt: string | null;
  nowMs?: number;
}): Promise<DuplicateCancelOutcome> {
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();

  let raw: unknown;
  try {
    const { data, error } = await supabaseAdmin().rpc("cancel_duplicate_booking", {
      p_booking_id: input.bookingId,
      p_now: nowIso,
    });
    if (error) throw new Error(`cancel_duplicate_booking failed: ${error.message}`);
    raw = data;
  } catch (err) {
    throw new DuplicateCancelUnavailableError("rpc", err);
  }

  const result = parseDuplicateCancelResult(raw);
  if (!result) throw new DuplicateCancelUnavailableError("result");

  log.info("duplicate-cancel", {
    msg: "decided",
    booking_id: input.bookingId,
    outcome: result.outcome,
    candidates: result.candidateIds.length,
    weaker_match: result.weakerMatch ?? "none",
  });

  const detail = duplicateHandoffDetail({
    outcome: result.outcome,
    weakerMatch: result.weakerMatch,
    laterBookingStartsAt: input.laterBookingStartsAt,
  });
  let handoff: RecordHandoffOutcome | null = null;
  if (detail) {
    try {
      handoff = await recordHandoff(handoffWriter(supabaseAdmin()), {
        bookingId: input.bookingId,
        kind: "duplicate-unresolved",
        detail,
      });
    } catch (err) {
      throw new DuplicateCancelUnavailableError("handoff", err);
    }
  }

  let delivered: boolean | null = null;
  if (result.outcome === "cancelled" && result.outboxId) {
    delivered = await runDuplicateCancelOutboxInline(result.outboxId, input.bookingId);
  }

  return { result, handoff, delivered };
}

/**
 * Run the cancel outbox row the database function wrote, exactly as `cancelBooking`
 * runs its own: lease it first so a drain tick firing in the gap cannot run the same
 * steps alongside us, and release in `finally` so a crash leaves the lease to expire
 * and the drain to reclaim it.
 *
 * The row is READ BACK rather than reconstructed here. The steps and the payload were
 * written by the function, and building a second copy of them on this side would be
 * two statements of one shape that drift, with the drain and the inline run then
 * delivering different things (L41).
 *
 * Every failure returns rather than throwing: see the note on the caller.
 */
async function runDuplicateCancelOutboxInline(
  outboxId: string,
  bookingId: string,
): Promise<boolean | null> {
  try {
    // cap-safe: one outbox row by primary key.
    const row = unwrap(
      await supabaseAdmin().from("booking_outbox").select("*").eq("id", outboxId).maybeSingle(),
      "duplicate cancel outbox row",
    ) as BookingOutbox | null;
    if (!row) {
      log.warn("duplicate-cancel", {
        msg: "outbox row not readable; the drain will deliver it",
        booking_id: bookingId,
        outbox_id: outboxId,
      });
      return null;
    }
    const lease = await realDeps().leaseOutbox(outboxId);
    // #1048: a null lease means a drain tick already holds this row and is running
    // the very steps we would run, so the right thing is to leave it alone.
    if (!lease) return null;
    try {
      const run = await runOutboxSteps(realDeps(deferWebhookSend), row, orchestration.OUTBOX_HANDLERS, lease);
      return run.delivered;
    } finally {
      await realDeps().releaseOutboxLease(outboxId, lease);
    }
  } catch (err) {
    // The cancel has COMMITTED and the row is durable, so this is a delayed side
    // effect rather than a failed request: the drain finishes it. Loud in the logs,
    // never a 503, which would invite a retry that can only be told it already
    // happened.
    log.error(
      "duplicate-cancel",
      { msg: "inline outbox run failed; the drain will deliver it", booking_id: bookingId, outbox_id: outboxId },
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }
}
