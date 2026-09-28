import { reportWriteFailure } from "@/lib/db/result";
import { nanoid } from "nanoid";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  leaseOutboxRow,
  saveOutboxStepsRow,
  markOutboxDeliveredRow,
  releaseOutboxLeaseRow,
} from "@/lib/booking/outbox-lease";
import { unwrap, isSlotClash, type DbResult } from "@/lib/db/result";
import { gatedWriteApplied, gatedWriteRows } from "@/lib/booking/gated-write";
import { appUrl } from "@/lib/env";
import {
  resolveBucketByCode,
  resolveRouting,
  roundRobinCandidates,
} from "@/lib/availability/service";
import {
  recomputeBucketSlotsForToday,
  getBucketSlotsWithFallback,
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
import { recordRoutingDecision } from "@/lib/routing/record";
import { touchedBucketCodes } from "@/lib/availability/precompute";
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
} from "@/lib/google/calendar";
import {
  insertOwnerAlert,
  loadLiveOwnerAlert,
  markOwnerAlertRemoved,
  recordOwnerAlertSkip,
  setOwnerAlertEventId,
} from "@/lib/booking/owner-alert-store";
import { loadAdvisorTimezone } from "@/lib/booking/owner-notice-store";
import { loadHandoffChannel } from "@/lib/handoffs/store";
import { postSlack } from "@/lib/notify/slack";
import {
  insertFailureLogFields,
  joinBookingContexts,
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
  buildBulkReassignProgress,
  drainBulkReassign,
  type BulkReassignDeps,
  type BulkReassignDrainSummary,
  type BulkReassignProgress,
} from "@/lib/booking/bulk-reassign";
import { selectCoverageReassignTarget, type CoverageTargetDeps } from "@/lib/booking/coverage-target";
import { coverageSweepActor } from "@/lib/booking/coverage-sweep-actor";
import type { CoverageSweepCancelReport } from "@/lib/booking/coverage-sweep-cancel";
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
  loadUserOrgId,
  markBulkReassignJobDoneIfDrained,
  type CoverageBookingRow,
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
  BookingContext,
  BookingDeps,
  BookingResult,
  CreateBookingInput,
  ReschedulePin,
  RescheduleClaim,
} from "@/lib/booking/orchestration";
import type { PersonIdentity, PersonWorld } from "@/lib/booking/person-dedupe";
import { personStrongIds } from "@/lib/booking/person-dedupe";
import { readLeadXbcLive } from "@/lib/salesforce/lead-xbc";
import { toE164 } from "@/lib/phone";
import { escapeLike } from "@/lib/sql-like";
import { noEligibleAgentsAlert } from "@/lib/availability/bucket-coverage";
import { emitWebhook, type WebhookSendScheduler } from "@/lib/webhooks/emit";
import { deferWebhookSend } from "@/lib/after-response";
import { sendThrottledAlert, resolveRecovered } from "@/lib/notify/dispatch";
import {
  bookingEventInsertAlert,
  stalePhoneInviteAlert,
  busyBlockWriteThroughAlert,
  creationOrphanAlert,
  outboxDrainRecovery,
  outboxDrainStuckAlert,
  outboxAllHandedOffAlert,
  outboxHandoffRecovery,
  pendingDeletionAlert,
  pendingDeletionRecovery,
  pendingDeletionRefusedAlert,
  reassignIntentDroppedAlert,
  reconcileFreedAlert,
  reconcileRecreatedAlert,
  reschedulePinDroppedAlert,
  rescheduleLockOutageAlert,
  verifyOutageAlert,
  reservationDrainRecovery,
  reservationDrainStuckAlert,
  verifyReadFailedAlert,
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
// Reservation lease + drain bounds (#429 P4). Crash-during-create is rare, so a
// small cap with a multi-tick backlog is fine; bounds Worker CPU. Retention
// deletes abandoned pending reservations older than the TTL.
const RESERVATION_LEASE_TTL_MS = 2 * 60 * 1000;
const RESERVATION_DRAIN_LIMIT = 15;
const RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;
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
 * Calendar ids whose busy blocks an agent, looked up by their email (#314).
 * Reports `readFailed` so verify-on-book can tell a real DB error apart from a
 * genuine empty: on an error we must NOT silently fall back to checking only the
 * primary calendar (it could miss a conflict on a secondary one and double-book).
 */
async function calendarIdsForEmail(
  email: string,
): Promise<{ readFailed: boolean; ids: string[] }> {
  const db = supabaseAdmin();
  const userRes = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (userRes.error) return { readFailed: true, ids: [] };
  if (!userRes.data) return { readFailed: false, ids: [] };
  const calsRes = await db
    .from("agent_calendars")
    .select("calendar_id")
    .eq("user_id", (userRes.data as { id: string }).id);
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
): Promise<{ byEmail: Map<string, string[]>; readFailed: Set<string> }> {
  const byEmail = new Map<string, string[]>();
  const readFailed = new Set<string>();
  if (emails.length === 0) return { byEmail, readFailed };

  const db = supabaseAdmin();
  const usersRes = await db
    .from("users")
    .select("id, email")
    .in("email", emails);
  if (usersRes.error) {
    // Can't map any agent to their calendars — fall back per agent for all.
    for (const e of emails) readFailed.add(e);
    return { byEmail, readFailed };
  }
  const userRows = (usersRes.data ?? []) as { id: string; email: string }[];
  const idByEmail = new Map(userRows.map((r) => [r.email, r.id]));

  const calsRes = await db
    .from("agent_calendars")
    .select("user_id, calendar_id")
    .in(
      "user_id",
      userRows.map((r) => r.id),
    );
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

/** Outcome of a single-agent verify: confirmed free, confirmed busy, or — when a
 *  calendar couldn't be read — unverifiable (#319). `unverified` is never treated
 *  as free (no double-book) and lets the caller flag a likely outage. */
type AgentVerdict = "free" | "busy" | "unverified";

/**
 * Direct per-agent verify (impersonates the agent, checks all their calendars) —
 * the accurate fallback for the bulk verifier when a calendar couldn't be read in
 * the cross-identity batch (#314) or the bulk call failed wholesale. A
 * calendar-read failure yields `unverified` (skip + alert) instead of being
 * conflated with `busy`, so a verify-on-book outage is distinguishable from a
 * genuinely full slot (#319).
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
    ).catch(() => {});
    return "unverified";
  }
  // #2412: `null` is Google's per calendar failure inside a 200 response (an
  // `errors[]` entry, or a requested calendar the reply never mentions). It is
  // NOT a yes. This is the fallback the bulk wave hands an agent to precisely
  // because it could not read one of their calendars, so answering "free" here
  // would book the lead over whatever that calendar held.
  const free = await isFree(email, startIso, endIso, ids.length ? ids : ["primary"], ignore);
  if (free === null) return "unverified";
  return free ? "free" : "busy";
}

/**
 * Verifies a set of agents ONE AT A TIME against their own calendars, and folds
 * the verdicts into the free / unverified sets `verifyFree` answers with.
 *
 * This is the fallback half of verify on book, split out so there is one place
 * that turns an `AgentVerdict` into those sets (#2412). `unverified` must never
 * land in `free`: it is the answer for an agent whose calendars could not be
 * read, and the booker surfaces it as a retriable outage rather than assigning
 * the slot.
 */
export async function verifyAgentsDirectly(
  emails: string[],
  startIso: string,
  endIso: string,
): Promise<{ free: Set<string>; unverified: Set<string> }> {
  const free = new Set<string>();
  const unverified = new Set<string>();
  if (emails.length === 0) return { free, unverified };
  const verdicts = await mapWithConcurrency(emails, VERIFY_CONCURRENCY, (email) =>
    checkAgentFree(email, startIso, endIso),
  );
  emails.forEach((email, i) => {
    if (verdicts[i] === "free") free.add(email);
    else if (verdicts[i] === "unverified") unverified.add(email);
  });
  return { free, unverified };
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
    ).catch(() => {});
    return null;
  }
  const busy = await freeBusy(email, fromIso, toIso, ids.length ? ids : ["primary"]);
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
  ExistingCallError,
  ExistingCallCheckUnavailableError,
  RescheduleConflictError,
  ContactRefusedError,
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
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { resolveAdvisorName, type AdvisorNameReader } from "@/lib/booking/advisor-name";
import { resolveAdvisorPhoto, type AdvisorPhotoReader } from "@/lib/booking/advisor-photo";
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
 */
export async function insertBusyBlocksWithRetry(blocks: BusyBlockInsert[]): Promise<void> {
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
  await sendThrottledAlert(
    "busy_block_write_through",
    CACHE_ALERT_COOLDOWN_MS,
    busyBlockWriteThroughAlert("insert", what, shortFailureReason(error.message) ?? "no detail"),
  ).catch(() => {});
}

/**
 * The rows the reconcile-missing sweep (#431) scans: active bookings whose slot is
 * still in the future and that have an assigned agent (a null-agent booking can't
 * own a per-user busy_block).
 *
 * Ordered created_at DESC because a missed write-through INSERT happens at create
 * time, so the freshest bookings are the likeliest to be missing a block - scan
 * those first within the `limit` cap. `offset` rotates the window across ticks
 * (#512) so an older upcoming booking beyond the first page is still eventually
 * healed, not starved forever.
 *
 * But newest-first ran straight into the create path's own block write (#778), so
 * bookings younger than the grace window are held back here rather than fetched and
 * then skipped: excluding them in SQL is what keeps them from eating the sweep's
 * per-tick row budget. See RECONCILE_MISSING_GRACE_MS.
 */
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
 * Every ACTIVE booking that could belong to this person (#357), fetched once per
 * identity signal the caller supplied and merged by booking id.
 *
 * **Each result is unwrapped on its own (#1641).** This used to read the wave as
 * `for (const r of results) ... (r.data ?? [])`, which turned a failed query into
 * an empty candidate list. Empty here is not "no failure", it is the specific
 * answer "this lead has no call booked", and that is the one answer that lets a
 * SECOND booking be created for somebody who already has one: the dedupe gate
 * passes, the round robin assigns an agent, a calendar invite goes out, and the
 * webhooks fire. It is the #277 / #1165 class on the path with a customer at the
 * end of it, so it fails loud and the callers decide what to do with the throw.
 *
 * The shape also hid it from every static guard: the result objects are never
 * given a name, so neither the original `const { data } =` scan nor the
 * result-object scan added in #1629 could reach them. That is the third shape
 * `scripts/lib/scan-swallowed-error-reads.ts` now covers.
 *
 * Which bookings MATCH is decided downstream by `findPersonMatch`; this only
 * decides which rows are fetched, and #1641 changed neither the four signals nor
 * their filters. Since #2663 each strong id is read against BOTH id columns, the
 * rule the lookup took in #2657, and the ids are the same set the grader uses
 * (`personStrongIds`), so the fetch and the grade cannot disagree.
 *
 * **Scoped to ONE world (#2660).** Every query joins the booking's bucket and
 * keeps only the rows whose `is_test` equals the world the caller is in, the
 * same `buckets!inner(is_test)` shape the reminders lane and the volume alarm
 * use. A test booking (the canary's, or a partner's on the public test bucket)
 * and a real booking are never the same person's calls: without this a tester
 * who typed a real lead's id was shown that lead's name, number and a Cancel on
 * their real call, and a test booking under an address refused the real lead
 * who owns it. The canary's cross bucket dedupe (SMOKE against SMOKE2, both
 * test) still sees both, because both are in the test world.
 */
export async function findActiveBookingsForPerson(
  identity: PersonIdentity,
  world: PersonWorld,
): Promise<Booking[]> {
  const active = ["confirmed", "rescheduled"] as const;
  const base = () =>
    supabaseAdmin()
      .from("bookings")
      .select("*, buckets!inner(is_test)")
      .eq("buckets.is_test", world.isTest)
      .in("status", active)
      .limit(20);
  const queries: PromiseLike<DbResult<unknown>>[] = [];
  // A strong id is one value that may sit in EITHER column (#2663): an embed
  // booking holds the lead id in salesforce_id with external_id null, so a
  // caller sending only externalId must read salesforce_id too, or the grader
  // never sees the row and a second call is booked. One plain equality read per
  // id per column, for the reason given on findActiveBookingsByStrongIds.
  for (const strongId of personStrongIds(identity)) {
    queries.push(base().eq("external_id", strongId));
    queries.push(base().eq("salesforce_id", strongId));
  }
  const email = identity.email?.trim();
  // Escape LIKE metacharacters (#620): an email's `_`/`%` must not act as an
  // ilike wildcard, or a `john_doe@` address would also fetch `johnXdoe@` and
  // an unordered limit(20) could crowd out the true row. Still case-insensitive
  // (matches the lowercased grader) and still served by the trigram index.
  if (email) queries.push(base().ilike("attendee_email", escapeLike(email)));
  const phone = toE164(identity.phone);
  if (phone) queries.push(base().eq("attendee_phone", phone));
  if (queries.length === 0) return [];

  const results = await Promise.all(queries);
  const byId = new Map<string, Booking>();
  for (const r of results) {
    const rows = unwrap(r, "person booking lookup") as Booking[] | null;
    for (const row of rows ?? []) byId.set(row.id, withoutJoinedBucket(row));
  }
  return [...byId.values()];
}

/** The joined bucket did its work in the world filter; the callers grade a
 *  Booking, so it does not ride along (#2660). */
function withoutJoinedBucket(row: Booking): Booking {
  const { buckets: _joined, ...booking } = row as Booking & { buckets?: unknown };
  return booking as Booking;
}

/**
 * Every ACTIVE booking whose `external_id` OR `salesforce_id` is any of `ids`,
 * for the lookup API (#2657). One equality read per id per column, merged by
 * booking id, rather than a single `.or(...)` filter: a lookup id is caller
 * supplied text, and PostgREST parses an `or` filter as an expression, so the
 * value would become part of the filter's syntax. An `.eq` sends it as a plain
 * value. The columns are the two the dedupe fetch above already reads, so the
 * same indexes serve it (`scripts/test-person-lookup-indexes.ts`).
 *
 * Each result is unwrapped on its own for the reason given above (#1641): a
 * failed read here would arrive at the caller as "this lead has no call", which
 * is the answer the booking confirmed page renders as not found. The wave is
 * written out here rather than shared with the function above on purpose: the
 * swallowed read guard sees an awaited query wave and its loop in one place, and
 * a helper taking the results as a parameter would put a future `r.data` revert
 * out of its reach (`scripts/test-swallowed-error-reads.ts` reverts both waves).
 */
export async function findActiveBookingsByStrongIds(
  ids: readonly string[],
): Promise<orchestration.BookingWithWorld[]> {
  if (ids.length === 0) return [];
  const active = ["confirmed", "rescheduled"] as const;
  // The bucket's flag rides along (#2660), so the lookup view can say whether a
  // booking is a test one without a second read. Deliberately NOT filtered by
  // world: a key holder asked for one person's bookings by a strong id, and a
  // partner's key reading its own test booking is the whole point.
  const base = () =>
    supabaseAdmin()
      .from("bookings")
      .select("*, buckets!inner(is_test)")
      .in("status", active)
      .limit(20);
  const queries: PromiseLike<DbResult<unknown>>[] = [];
  for (const id of ids) {
    queries.push(base().eq("external_id", id));
    queries.push(base().eq("salesforce_id", id));
  }
  const results = await Promise.all(queries);
  const byId = new Map<string, orchestration.BookingWithWorld>();
  for (const r of results) {
    const rows = unwrap(r, "strong id booking lookup") as Booking[] | null;
    for (const row of rows ?? []) byId.set(row.id, withWorld(row));
  }
  return [...byId.values()];
}

/** The joined bucket's flag lifted onto the row as `isTest` (#2660). */
function withWorld(row: Booking): orchestration.BookingWithWorld {
  const { buckets, ...booking } = row as Booking & { buckets?: { is_test?: boolean } | null };
  return { ...(booking as Booking), isTest: buckets?.is_test === true };
}

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
    await supabaseAdmin()
      .from("bookings")
      .select("id, assigned_user_id, starts_at, ends_at")
      .in("status", ["confirmed", "rescheduled"])
      .gte("ends_at", new Date().toISOString())
      .not("assigned_user_id", "is", null)
      .lt("created_at", settledBefore)
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
export function realDeps(deferSend?: WebhookSendScheduler): BookingDeps {
  return {
    deferSend,
    resolveBucketByCode,
    // #2638: the lead's XBC for a booker confirm whose link carried none. Throws
    // on a failed read, which the confirm answers with a retriable 503.
    readLeadXbc: readLeadXbcLive,
    roundRobinCandidates,
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
    verifyFree: async (emails, startIso, endIso) => {
      const free = new Set<string>();
      const unverified = new Set<string>();
      if (emails.length === 0) return { free, unverified };

      const { byEmail, readFailed } = await calendarsForEmails(emails);
      const bulkAgents = emails
        .filter((e) => !readFailed.has(e))
        .map((e) => ({ email: e, calendarIds: byEmail.get(e) ?? [e] }));
      const fallback = new Set<string>(readFailed);

      if (bulkAgents.length > 0) {
        try {
          // Read as one candidate's identity — domain free/busy is cross-visible.
          const subject = bulkAgents[0].email;
          const allCalIds = [
            ...new Set(bulkAgents.flatMap((a) => a.calendarIds)),
          ];
          const maps = await mapWithConcurrency(
            chunkCalendarIds(allCalIds),
            VERIFY_CONCURRENCY,
            (chunk) => freeBusyMany(subject, startIso, endIso, chunk),
          );
          const busyByCalendar = new Map<string, CalendarBusy>();
          for (const m of maps) for (const [k, v] of m) busyByCalendar.set(k, v);

          const res = freeAgentsFromBusy(
            bulkAgents,
            busyByCalendar,
            Date.parse(startIso),
            Date.parse(endIso),
          );
          for (const e of res.free) free.add(e);
          for (const e of res.needsFallback) fallback.add(e);
        } catch (err) {
          // Total bulk failure (e.g. the subject's delegated token couldn't be
          // minted) — verify everyone directly per agent rather than fail.
          log.error("booking", { msg: "verify-on-book bulk freeBusy failed, falling back to per-agent" }, err);
          for (const a of bulkAgents) fallback.add(a.email);
        }
      }

      if (fallback.size > 0) {
        const direct = await verifyAgentsDirectly([...fallback], startIso, endIso);
        for (const e of direct.free) free.add(e);
        for (const e of direct.unverified) unverified.add(e);
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
    // postSlack never throws; an unconfigured bot, a refused channel or a timeout
    // all come back as not-ok with a reason, which the step classifies.
    postHandoffNotice: (channel, text) => postSlack({ channel, text }),
    advisorTimezone: (userId) => loadAdvisorTimezone(supabaseAdmin(), userId),
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
          .order("attempts", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(limit),
        "loadPendingEventDeletions",
      );
      return (data ?? []) as orchestration.PendingEventDeletion[];
    },
    loadCreationOrphans: async (limit) => {
      // error-ok: best-effort creation-orphan alert worklist; a read error skips
      // this tick and the deletion lane retries next tick.
      const { data } = await supabaseAdmin()
        .from("pending_event_deletions")
        .select("*")
        .is("booking_id", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as orchestration.PendingEventDeletion[];
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
    emitWebhook,
    appBaseUrl: appUrl,
    newManageToken: () => nanoid(24),
    // Keyless (anonymous) bookings synthesize a unique key so they still get the
    // reservation-backed crash-safe create (#666). "anon_" prefix + nanoid can
    // never contain a "|", so it can't collide with a derived contact key.
    newIdempotencyKey: () => `anon_${nanoid(24)}`,
    // A booking changed the bucket's availability: recompute its precomputed
    // row so the booked slot disappears. Fire-and-forget so the confirm isn't
    // blocked on the recompute; the recompute lane's freshness sweep is the
    // backstop if this best-effort call is missed.
    invalidateSlots: (bucketCode) => {
      void recomputeBucketSlotsForToday(bucketCode).catch((err) =>
        // Best-effort freshness nudge; the recompute lane reconverges this bucket
        // regardless. Logged so a lane that is failing EVERY time is findable.
        log.warn("booking", { msg: "post-confirm recompute failed", bucket: bucketCode }, err),
      );
      return Promise.resolve();
    },
    // #504: the routing decision log, injected so the orchestration's calls are
    // test-observable. Best-effort in the impl (never throws), matching the prior
    // module-function behavior.
    recordRoutingDecision,
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

    getUser: async (userId) => {
      // error-ok: agent lookup inside the crash-safe create/drain step; a read error is recovered by the outbox retry, not silently lost.
      const { data } = await supabaseAdmin()
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();
      return data as User;
    },

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
      // Active only — matches the partial unique index, so a cancelled booking
      // never blocks (or gets returned for) a fresh rebook of the same slot.
      // error-ok: idempotency probe on the crash-safe create path; a null (incl. a read error) re-drives the unique-key-guarded insert, so it can never double-book.
      const { data } = await supabaseAdmin()
        .from("bookings")
        .select("*")
        .eq("idempotency_key", key)
        .in("status", ["confirmed", "rescheduled"])
        .maybeSingle();
      return (data as Booking | null) ?? null;
    },

    insertBooking: async (row) => {
      const { data, error } = await supabaseAdmin()
        .from("bookings")
        .insert(row)
        .select("*")
        .single();
      if (error || !data) {
        // The slot was taken by a racing confirm. TWO guards can say so and both
        // mean the same thing to a lead (#2274): `bookings_active_slot_uniq`
        // refuses a second booking at the same START (23505), and
        // `bookings_active_no_overlap` refuses one OVERLAPPING an existing booking
        // for that agent (23P01), which is the case uniqueness cannot see because
        // appointments are longer than the grid they are offered on. Either way
        // this caller lost a race it was allowed to lose, so it becomes a
        // SlotUnavailableError and the lead is offered another time. Reading only
        // one of them would answer a real race with a 500.
        const conflict = isSlotClash(error);
        // #1047: carry what identifies the ATTEMPT. There is no booking id yet (the
        // row was never written), so the joinable facts are the slot and the agent,
        // which is what ties this line to the confirm that produced it and to the
        // busy_blocks and calendar work around it. Never the attendee: contact data
        // does not go in logs (docs/pii.md).
        if (!conflict) {
          log.error(
            "booking",
            { msg: "insertBooking failed", ...insertFailureLogFields(row) },
            error,
          );
        }
        return { ok: false, conflict };
      }
      return { ok: true, booking: data as Booking };
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
      await insertBusyBlocksWithRetry(blocks);
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
      if (error) {
        log.error("booking", { msg: "busy_blocks move failed", booking_id: bookingId }, error);
        await sendThrottledAlert(
          "busy_block_write_through",
          CACHE_ALERT_COOLDOWN_MS,
          busyBlockWriteThroughAlert("move", bookingId, shortFailureReason(error.message) ?? "no detail"),
        ).catch(() => {});
      }
    },

    reassignSwap: async ({
      bookingId,
      userId,
      agentName,
      agentEmail,
      gcalEventId,
      gcalClientId,
      routingTrace,
    }) => {
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
        ).catch(() => {});
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

    deleteBusyBlocksByIds: async (ids) => {
      if (ids.length === 0) return;
      const { error } = await supabaseAdmin()
        .from("busy_blocks")
        .delete()
        .in("id", ids);
      if (error) {
        // Best-effort: the next tick re-finds and retries these rows.
        log.error("reconcile", { msg: "deleteBusyBlocksByIds failed" }, error);
      }
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
      const { data, error } = await supabaseAdmin()
        .from("booking_outbox")
        .select("*")
        .eq("status", "pending")
        .lt("attempts", DRAIN_GIVE_UP_AT)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        log.error("outbox", { msg: "loadDrainableOutbox failed" }, error);
        return [];
      }
      return (data ?? []) as BookingOutbox[];
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
      // write-ok: the reservation expires on its lease regardless, so a refused delete costs one slot until expiry and never releases a live hold.
      await supabaseAdmin().from("booking_reservations").delete().eq("id", id);
    },

    loadDrainableReservations: async (limit) => {
      const nowIso = new Date().toISOString();
      // Same drainability gate as the outbox (#445): pending, lease free, retry
      // time reached, under the give-up cap.
      const { data, error } = await supabaseAdmin()
        .from("booking_reservations")
        .select("*")
        .eq("status", "pending")
        .lt("attempts", DRAIN_GIVE_UP_AT)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) {
        log.error("reservations", { msg: "loadDrainable failed" }, error);
        return [];
      }
      return (data ?? []) as BookingReservation[];
    },

    leaseReservation: async (id) => {
      const now = Date.now();
      // #2373: false means another holder has the lease, which is the drain
      // coalescing correctly. A refused statement is not that, and pretending it
      // is leaves the reservation looking busy rather than unreachable.
      return gatedWriteApplied(
        "reservation_lease",
        await supabaseAdmin()
          .from("booking_reservations")
          .update({ lease_until: new Date(now + RESERVATION_LEASE_TTL_MS).toISOString() })
          .eq("id", id)
          .or(`lease_until.is.null,lease_until.lt.${new Date(now).toISOString()}`)
          .select("id"),
      );
    },

    releaseReservationLease: async (id) => {
      // write-ok: the lease expires on its own timeout, so a refused release costs the wait and never frees somebody else's lease.
      await supabaseAdmin()
        .from("booking_reservations")
        .update({ lease_until: null })
        .eq("id", id);
    },

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
      // error-ok: best-effort GC of expired reservations; a read error deletes nothing this tick and the sweep retries.
      const { data } = await db
        .from("booking_reservations")
        .select("id")
        .eq("status", "pending")
        .lt("created_at", olderThanIso)
        .limit(limit);
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
      if (ids.length) await db.from("booking_reservations").delete().in("id", ids);
    },

    commitReschedule: async (bookingId, patch, guard) => {
      // Gated commit (#615): apply the move only while the booking is still
      // active AND its assignee + event id are unchanged since we read them.
      // A concurrent cancel (status flip) or reassign (assignee + event id swap)
      // makes this touch 0 rows; `.select` returns a row only when THIS UPDATE
      // transitioned it. Same shape as claimCancellation / completeBookingsIfDue.
      const base = supabaseAdmin()
        .from("bookings")
        .update(patch)
        .eq("id", bookingId)
        .in("status", ["confirmed", "rescheduled"]);
      const withAssignee =
        guard.assignedUserId === null
          ? base.is("assigned_user_id", null)
          : base.eq("assigned_user_id", guard.assignedUserId);
      const gated =
        guard.gcalEventId === null
          ? withAssignee.is("gcal_event_id", null)
          : withAssignee.eq("gcal_event_id", guard.gcalEventId);
      // #2373: `false` here means the booking is no longer the one we started
      // moving. A statement Postgres REFUSED used to produce the same false, and
      // the caller turned that into a conflict telling the lead to refresh and
      // pick again, which is advice that cannot work when nothing ran.
      return gatedWriteApplied("reschedule_commit", await gated.select("id"));
    },

    claimCancellation: async (bookingId) => {
      // Atomic flip active->cancelled (#413). Gating on the row still being in an
      // active status (not just "not cancelled") means a concurrent cancel OR a
      // complete-cron tick that already terminated it touches 0 rows (#618); a
      // completed booking can never regress to cancelled. `.select` returns the
      // row only when THIS call made the transition.
      // #2373: the headline case. A refused statement used to be indistinguishable
      // from having lost the claim, and the cancel route reported that as
      // `{ ok: true }`, so the lead read "Your call is cancelled" while the
      // booking, the invite and the advisor's slot all stood.
      return gatedWriteApplied(
        "cancel_claim",
        await supabaseAdmin()
          .from("bookings")
          .update({ status: "cancelled" })
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
        ).catch(() => {});
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
    findActiveBookingsByStrongIds,

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

    loadPastBookingsToComplete: async () => {
      const db = supabaseAdmin();
      const nowIso = new Date().toISOString();
      // error-ok: best-effort sweep of past bookings to mark complete; a read error yields none this tick and the completion lane retries.
      const { data: rows } = await db
        .from("bookings")
        .select("*")
        .in("status", ["confirmed", "rescheduled"])
        .lt("ends_at", nowIso)
        .limit(PAST_COMPLETION_BATCH_LIMIT);

      const bookings = (rows ?? []) as Booking[];
      if (bookings.length === 0) return [];

      // Resolve buckets + event types with two `.in()` queries and join in
      // memory, instead of two lookups per booking (~400 round-trips) (#164).
      const bucketIds = [...new Set(bookings.map((b) => b.bucket_id))];
      const eventTypeIds = [...new Set(bookings.map((b) => b.event_type_id))];
      const [{ data: buckets }, { data: eventTypes }] = await Promise.all([
        db.from("buckets").select("*").in("id", bucketIds),
        db.from("event_types").select("*").in("id", eventTypeIds),
      ]);

      return joinBookingContexts(
        bookings,
        (buckets ?? []) as Bucket[],
        (eventTypes ?? []) as EventType[],
      );
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
): { key: string; cooldownMs: number; message: string } | null {
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
  } catch (err) {
    const spec = bookingFailureAlert(err);
    if (spec) {
      // alert-text-ok: `spec.message` is the alert's own copy, built by
      // bookingFailureAlert from the pure builders in booking/alert-copy.ts. The
      // name ends in `.message` and is not an error; the widened #2418 scan reads
      // arguments as well as templates, so it reaches this shape now.
      // alert-key: verify_on_book_outage
      // alert-key: reschedule_lock_outage
      // alert-key: no_eligible_agents:*
      await sendThrottledAlert(spec.key, spec.cooldownMs, spec.message).catch(() => {});
    }
    throw err;
  }
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
): Promise<BookingResult> {
  try {
    const res = await orchestration.rescheduleBooking(
      token, newStartIso, reason, initiator, realDeps(deferWebhookSend), Date.now(), actor, contact,
      { leadZone },
    );
    logRescheduleSuccess(res.booking.id, initiator, res.rescheduleDecline);
    return res;
  } catch (err) {
    logRescheduleFailure(err, initiator);
    throw err;
  }
}

export function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  return alertOnBookingFailure(() =>
    orchestration.createBooking(input, realDeps(deferWebhookSend)),
  );
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
  world: PersonWorld,
): Promise<KnownContact | null> {
  const salesforceId = identity.salesforceId?.trim();
  if (!salesforceId) return null;
  try {
    const rows = unwrap(
      await supabaseAdmin()
        .from("bookings")
        .select(
          "id, created_at, attendee_name, attendee_first_name, attendee_email, attendee_phone, buckets!inner(is_test)",
        )
        .eq("buckets.is_test", world.isTest)
        .eq("salesforce_id", salesforceId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(KNOWN_CONTACT_ROWS),
      "landing known-contact lookup",
    ) as KnownContactRow[] | null;
    return knownContactFromBookings(rows ?? []);
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
  world: PersonWorld,
): Promise<LandingAttendee> {
  const complete = link.name.trim() && link.email.trim() && link.phone.trim();
  if (complete) return attendeeForLanding(link, null);
  return attendeeForLanding(link, await knownContactForLanding(identity, world));
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
  const res = await orchestration.updateBookingPhone(token, phone, realDeps());
  if (res.staleInvite) {
    // alert-key: stale_phone_invite:*
    await sendThrottledAlert(
      `stale_phone_invite:${res.staleInvite.bookingId}`,
      orchestration.STALE_PHONE_INVITE_COOLDOWN_MS,
      stalePhoneInviteAlert(res.staleInvite.agentEmail, res.staleInvite.bookingId),
    ).catch(() => {});
  }
  return res;
}

/**
 * Direct booking API entry (#357): "one active appointment per person" — create,
 * dedupe, auto-reschedule, or ask-to-confirm. Wraps the orchestration in the same
 * verify-outage alerting as createBooking (the create/reschedule paths it dispatches
 * to both verify-on-book).
 */
export function bookViaApi(input: ApiBookingInput): Promise<ApiBookingResult> {
  return alertOnBookingFailure(async () => {
    try {
      const res = await orchestration.bookViaApi(input, realDeps(deferWebhookSend));
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
): Promise<BookingResult> {
  return alertOnBookingFailure(() =>
    rescheduleWithLog(token, newStartIso, reason, initiator, undefined, contact, leadZone),
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
): Promise<BookingResult> {
  const token = await manageTokenForBooking(bookingId);
  if (!token) throw new Error("Booking not found");
  return alertOnBookingFailure(() =>
    rescheduleWithLog(token, newStartIso, reason, "admin", actor),
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
 * Active agents for the manager reassign picker (#546): non-deactivated, non-test
 * users in the org, minimal fields only (never the full user row to the client).
 * The picker filters/sorts these with `rankReassignAgents`.
 */
export async function listActiveAgents(orgId: string): Promise<ReassignAgent[]> {
  // error-ok: candidate agents for reassignment; a read error yields an empty list so the reassignment is retried, never run against a wrong pool.
  const { data } = await supabaseAdmin()
    .from("users")
    .select("id, name, email, bookable")
    .eq("org_id", orgId)
    .eq("is_test", false)
    .is("deactivated_at", null);
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
): Promise<BookingResult & { overCap: boolean }> {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(deferWebhookSend), {
    overrideCap,
    actor,
    initiator: "admin",
    allowNonBookable: true,
  });
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
): Promise<BookingResult & { overCap: boolean }> {
  return orchestration.reassignBooking(bookingId, agentEmail, reason, realDeps(deferWebhookSend), {
    overrideCap: false,
    initiator: "system",
    allowNonBookable: true,
  });
}

/**
 * The live coverage-target deps (#972): the ordered eligible list from
 * `resolveRouting`, and the batched email / live verify-on-book / working-hours /
 * per-day booking-count reads reused verbatim from the booking path's `realDeps`
 * so the two can't drift. Freeness is verified live, never from the cache.
 */
function realCoverageTargetDeps(): CoverageTargetDeps {
  const base = realDeps();
  return {
    orderedEligibleIds: async (bucket) => (await resolveRouting(bucket.code))?.eligibleIds ?? [],
    loadEmails: base.loadEmails,
    verifyFree: base.verifyFree,
    agentWorkingHours: base.agentWorkingHours,
    agentActiveBookingStartsMs: base.agentActiveBookingStartsMs,
    userIdsOnApprovedTimeOff,
  };
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
    reassign: async (bookingId, targetEmail, job) => {
      // Who the move is recorded as. Throws for a job that has neither an actor nor
      // a recorded reason for having none, which is the same refusal as before:
      // #1241 added the offboarding case, it did not widen the guard (see
      // coverage-sweep-actor.ts).
      const sweepActor = coverageSweepActor(job);
      // The reason was validated when the job was enqueued (the bulk-reassign route).
      // Do NOT re-validate membership here (#346): a re-check against the live option
      // set, which loadReasonOptions degrades to coded defaults on a transient read
      // error, would fail a legitimate, already-approved reassign and burn its retries
      // (dropping a coverage move). Trust the stored code; structural guard only.
      const code = (job.reason_code ?? "").trim();
      if (!code) throw new Error("bulk-reassign job has no reason code");
      const reason: ValidatedReason = { code, detail: job.reason_detail ?? null };
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
      // The two branches differ ONLY in who the move is recorded as. Everything
      // that decides which bookings move, and where they land, is shared, so an
      // offboarding sweep and an admin's sweep can never cover an agent differently.
      if (sweepActor.kind === "system") {
        await systemReassignBooking(bookingId, targetEmail, reason);
        return;
      }
      const actor: BookingActor = {
        userId: sweepActor.userId,
        actingAsUserId: sweepActor.actingAsUserId,
      };
      await adminReassignBooking(bookingId, targetEmail, reason, actor, false);
    },
    claimItem: claimBulkReassignItem,
    commitItemOutcome: commitBulkReassignItemOutcome,
    markJobDoneIfDrained: markBulkReassignJobDoneIfDrained,
  };
}

/** Drain one bounded tick of the bulk-reassign engine (the cron lane). */
export function drainBulkReassignJobs(): Promise<BulkReassignDrainSummary> {
  return drainBulkReassign(realBulkReassignDeps());
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
  if (!input.actor && !input.offboardingDeactivatedAtIso && !input.redistributeMarkedAtIso) {
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
  const shown = [...ACTIONABLE_ITEM_STATUSES, ...SKIPPED_ITEM_STATUSES];
  const shownIds = items.filter((it) => shown.includes(it.status)).map((it) => it.booking_id);
  const ctx = await loadActionableBookingContext(shownIds);
  return buildBulkReassignProgress(job, items, ctx);
}

export function completePastBookings(): Promise<{
  completed: number;
  backlogRemains: boolean;
}> {
  return orchestration.completePastBookings(realDeps());
}

export function getBookingByToken(token: string): Promise<BookingContext | null> {
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

/** The advisor's Workspace photo (#2600), resolved live beside the name and for
 *  the same reason: a booking can be reassigned, so a stamped one would show a
 *  lead the face of somebody who is no longer taking their call. */
export function getBookingAdvisorPhoto(
  assignedUserId: string | null,
): Promise<string | null> {
  return resolveAdvisorPhoto(
    supabaseAdmin() as unknown as AdvisorPhotoReader,
    assignedUserId,
  );
}

const PENDING_DELETION_ALERT_KEY = "pending_event_deletions";
const PENDING_DELETION_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** #2577: rows the drain stopped retrying because Google refused the calendar for
 *  good. An INCIDENT (the retrying is over; there is no state to clear), on its own
 *  key because its remedy is a person fixing an account, not API health. */
const PENDING_DELETION_REFUSED_ALERT_KEY = "pending_event_deletions_refused";
const PENDING_DELETION_REFUSED_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** #401: drain the deletion retry queue and alert if any deletion is stuck. */
export async function processPendingEventDeletions(limit: number) {
  // all-clear-proof: src/lib/booking/selfheal-worklist-reads.test.ts - pins that a
  // failed worklist read aborts the tick and announces no recovery, for this sweep
  // and its two siblings below.
  const res = await orchestration.processPendingEventDeletions(realDeps(), limit);
  if (res.refused.length > 0) {
    // #2577: ended on this pass, never retried again, so the copy names who has to
    // fix each account. Kept apart from `stuck` below in both directions: a refused
    // row never feeds the stuck page, and never holds its recovery back.
    const refusedText = pendingDeletionRefusedAlert(
      res.refused.map((r) => ({
        calendarEmail: r.row.calendar_email,
        eventId: String(r.row.gcal_event_id),
        kind: r.kind,
      })),
    );
    await sendThrottledAlert(
      PENDING_DELETION_REFUSED_ALERT_KEY,
      PENDING_DELETION_REFUSED_ALERT_COOLDOWN_MS,
      refusedText,
    ).catch(() => {});
  }
  if (res.stuck.length > 0) {
    await sendThrottledAlert(
      PENDING_DELETION_ALERT_KEY,
      PENDING_DELETION_ALERT_COOLDOWN_MS,
      pendingDeletionAlert(res.stuck.length, orchestration.PENDING_DELETION_ALERT_AFTER, res.stuck.slice(0, 5).map((r) => String(r.gcal_event_id))),
    ).catch(() => {});
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
    ).catch(() => {});
  }
  return res;
}

const RECONCILE_ALERT_KEY = "reconcile_busy_blocks";
const RECONCILE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
/** Bound the recompute fan-out so one sweep can't blow the subrequest ceiling;
 *  any overflow buckets are caught by the recompute lane's freshness window. */
const RECONCILE_MAX_TOUCHED_BUCKETS = 25;

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

  // Map freed agents -> their buckets, dedupe, bound, recompute today's slots.
  // One batched lookup for the whole freed set (#762), not one per agent.
  const touched = await touchedBucketCodes(
    res.userIds,
    RECONCILE_MAX_TOUCHED_BUCKETS,
    "reconcile",
  );
  for (const code of touched) {
    await recomputeBucketSlotsForToday(code, true).catch((err) =>
      // Best-effort: the recompute lane owns convergence. Logged so a
      // persistently failing recompute is findable rather than invisible.
      log.warn("booking", {
        msg: "reconcile recompute failed",
        bucket: code,
        reason: shortErrorReason(err),
      }),
    );
  }

  const freedText = reconcileFreedAlert({
    freedCancelled: res.freedCancelled,
    freedOrphans: res.freedOrphans,
    agentCount: res.userIds.length,
  });
  await sendThrottledAlert(
    RECONCILE_ALERT_KEY,
    RECONCILE_ALERT_COOLDOWN_MS,
    freedText,
  ).catch(() => {});

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
  // recompute all of each affected agent's buckets (deduped + bounded), exactly
  // as the #428 sweep does for freed agents - not just the booking's own bucket.
  const touched = await touchedBucketCodes(
    res.userIds,
    RECONCILE_MAX_TOUCHED_BUCKETS,
    "reconcile-missing",
  );
  for (const code of touched) {
    await recomputeBucketSlotsForToday(code, true).catch((err) =>
      // Best-effort: the recompute lane owns convergence. Logged so a
      // persistently failing recompute is findable rather than invisible.
      log.warn("booking", {
        msg: "reconcile recompute failed",
        bucket: code,
        reason: shortErrorReason(err),
      }),
    );
  }

  await sendThrottledAlert(
    RECONCILE_MISSING_ALERT_KEY,
    RECONCILE_ALERT_COOLDOWN_MS,
    reconcileRecreatedAlert(res.recreated, res.bookingIds.slice(0, 10).map(String), res.bookingIds.length > 10),
  ).catch(() => {});

  return res;
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
      ).catch(() => {});
    }
  } else {
    await clearFailureStreak(OUTBOX_HANDOFF_STREAK_KEY);
  }

  if (result.stuck.length > 0) {
    const ids = result.stuck.map((r) => r.id).slice(0, 10).join(", ");
    await sendThrottledAlert(
      "outbox_drain_stuck",
      DRAIN_ALERT_COOLDOWN_MS,
      outboxDrainStuckAlert(result.stuck.length, DRAIN_ALERT_AFTER, ids),
    ).catch(() => {});
  } else if (!allHandedOff) {
    // #1151: a backing-off outbox is a CONDITION (the side effects of real
    // bookings are not completing), so say when it drains. Measured, not assumed:
    // a drain that threw never gets here, and neither does one that stood every
    // row down.
    await resolveRecovered([
      { key: "outbox_drain_stuck", text: outboxDrainRecovery() },
      { key: OUTBOX_HANDOFF_STREAK_KEY, text: outboxHandoffRecovery() },
    ]);
  }
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
  if (result.stuck.length > 0) {
    const ids = result.stuck.map((r) => r.id).slice(0, 10).join(", ");
    await sendThrottledAlert(
      "reservation_drain_stuck",
      DRAIN_ALERT_COOLDOWN_MS,
      reservationDrainStuckAlert(result.stuck.length, DRAIN_ALERT_AFTER, ids),
    ).catch(() => {});
  } else {
    // #1151: same CONDITION on the reservation side, same measured-only rule.
    await resolveRecovered([
      {
        key: "reservation_drain_stuck",
        text: reservationDrainRecovery(),
      },
    ]);
  }
  // Retention: delete up to a batch of pending reservations older than the TTL.
  const cutoff = new Date(Date.now() - RESERVATION_RETENTION_MS).toISOString();
  await deps
    .deleteExpiredReservations(cutoff, RESERVATION_DRAIN_LIMIT)
    // Best-effort retention trim; the next tick retries the same cutoff. Logged
    // so a cleanup that never succeeds does not grow the table in silence.
    .catch((err) =>
      log.warn("booking", {
        msg: "expired-reservation cleanup failed",
        reason: shortErrorReason(err),
      }),
    );
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
      reschedulePinDroppedAlert(result.dropped),
    ).catch(() => {});
  }
  return result;
}

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
    ).catch(() => {});
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
