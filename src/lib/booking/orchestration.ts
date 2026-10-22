// Relative (not "@/") for the VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { RerouteRefusedError, type RerouteSwapArgs } from "./reroute.ts";
import type { RerouteSwapRefusal } from "../db/reroute-hold-refusals.ts";
import { LADDER_READ_MAX_AGE_MS, type LadderInputs } from "../availability/ladder-inputs.ts";
import { toE164 } from "../phone.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  freeMembersAtExactWindow,
  isUnderDailyCap,
  isOrgOpen,
  isWithinWorkingHours,
  type BusinessHoursRules,
  type SlotRules,
  type WorkingRule,
  type UnbookableReason,
  type MemberAvailability,
} from "../availability/compute.ts";
import type { EligibleAgents } from "../availability/service.ts";
import { withoutOwnBooking } from "./reroute-hold.ts";
import {
  bookingWindow,
  bufferedWindow,
  busyBlockFor,
  bookingEventFrom,
  deterministicEventId,
  EventGone,
  EventCancelledOnReuse,
  eventDescription,
  withCallingNumberLine,
  withPhoneLine,
  eventSummary,
  eventLocation,
  idempotencyKeyFor,
  selectAgent,
  MAX_COMPLETION_DRAIN_BATCHES,
  PAST_COMPLETION_BATCH_LIMIT,
  type AssignResult,
  type BusyBlockInsert,
  type BookingActor,
  type BookingEventInsert,
  type ValidatedReason,
  type VerifyResult,
} from "./core.ts";
import {
  findPersonMatch,
  decidePersonBooking,
  type PersonIdentity,
  type NamedWorld,
  type PersonWorld,
  type PersonMatch,
  type MatchStrength,
  personStrongIds,
} from "./person-dedupe.ts";
import {
  leadIdFromEarlierBookings,
  withLeadIdFrom,
  type EarlierLeadBookingRow,
  type LeadIdFrom,
} from "./lead-id-from-bookings.ts";
import {
  bookingLeadId,
  bookingMatchesLookupIds,
  lookupStrongIds,
  type LookupIdentity,
} from "./lookup-identity.ts";
import {
  isOwnerAlertReassign,
  ownerAlertBody,
  ownerAlertWindow,
  type OwnerAlertEventBody,
} from "./owner-alert.ts";
import { formatOwnerReassignNotice } from "./owner-notice-copy.ts";
import { OWNER_NOTICE_STEP, OWNER_NOTICE_WITHHELD } from "./owner-notice-withheld.ts";
import { bookingDetailHref } from "./detail.ts";
import { partnerKeysFrom, type PartnerKeys } from "./partner-keys.ts";
import { bookingIdentityFrom } from "./booking-identity.ts";
import { SLACK_NOT_CONFIGURED } from "../notify/slack.ts";
import { isDefinitiveFailure, reachabilityFromError } from "../google/reachability-classify.ts";
import type { FailureKind } from "../google/sync-health.ts";
import { normalizeEmail } from "../auth/email.ts";
import type { CalendarOwnerForAlert, RefusedDeletionForAlert } from "./alert-copy.ts";
import type { RetentionSweep } from "./reservation-retention.ts";
import { encodeCursor, type ListQuery } from "./api-request.ts";
import { webhookDedupeKey } from "../webhooks/dedupe.ts";
import { runOutboxSteps, type OutboxHandlers } from "./outbox.ts";
import type { OutboxWriteOutcome } from "./outbox-lease.ts";
import { DRAIN_ALERT_AFTER } from "./drain-backoff.ts";
import { buildRoutingTraceExtras } from "../routing/explain.ts";
import {
  ladderStage,
  refusalTraceOf,
  rungCounts,
  rungOf,
  refusedLeadId,
  rungTraceFrom,
  traced,
  withRung,
  type RefusalStage,
  type RefusalTrace,
  type RungTrace,
} from "./refusal-trace.ts";
import type { OfferVerdict } from "./offer-race.ts";
import { calendarLinks, icsDocument, icsUrl, leadCalendarEvent, type CalendarLinks } from "./calendar-links.ts";
import type { RecordRoutingDecisionInput } from "../routing/record.ts";
import { rungExcludesLow, tierKeyOf, tierLadder } from "../routing/tiers.ts";
import { walkTierLadder, type RungOutcome } from "../routing/tier-fallback.ts";
import { tierFallbackAlert } from "../routing/tier-alert.ts";
import {
  MANAGE_PHONE_NOT_CHANGEABLE,
  MANAGE_PHONE_NOT_FOUND,
} from "./manage-copy.ts";
import { INVALID_EMAIL, storedFirstName, validateAttendee } from "../attendee.ts";
import { parseStampMs } from "../date/stamp.ts";
import type { GoogleEvent } from "../google/calendar.ts";
import type { StrandedInviteReason } from "../google/invite-move-copy.ts";
import { judgeAbandonedInvite } from "../google/invite-moves.ts";
import { leadCallingZone, withinLeadCallingWindow } from "./lead-calling-window.ts";
import { shortErrorReason } from "../notify/error-text.ts";
import { callingNumberWithinDeadline } from "../salesforce/lead-calling-number.ts";
import type { ScheduleTimer } from "../read-within-deadline.ts";
import { findDeadlineExceeded, type DeadlineFound } from "../fetch-within-deadline.ts";
import { GoogleBreakerOpenError } from "../google/breaker.ts";
import { isInvalidAttendeeEmailRefusal } from "../google/http-error.ts";
import { AttendeeEmailRefusedError } from "./attendee-email-refused.ts";
import { withinLostRaceCleanup, withinOwedCleanup } from "./cleanup-allowance.ts";
import { confirmLineWaitMs, type ClaimOutcome, type ClaimPlace, type ConfirmLine, type LeaderVerdict, type LineKey, type SharedSeat, type StartFrom } from "./confirm-queue.ts";
import { codeLineGroup } from "./line-key.ts";
import { budgetCovers, expectedCommitMs, type CommitCostLog } from "./commit-cost.ts";
import type { WaitPoint } from "./wait-marks.ts";
import { budgetLeftMs } from "../call-budget.ts";
import { log } from "@/lib/log";
import { readBookingSource } from "./booking-source.ts";
import type { AuditChannel } from "../audit-channel.ts";
import type { FullApiCaller } from "./api-callers.ts";
import { rescheduleTimesFrom, type RescheduleTimesFrom } from "./reschedule-times-url.ts";
import { readReferrerOrigin } from "../embed/referrer-origin.ts";
import {
  makeConfirmProfile,
  confirmProfileLine,
  ISOLATE_READY_AT_MS,
  timeStage,
  type ConfirmProfile,
  type ConfirmProfileReading,
} from "@/lib/booking/confirm-profile";
import { isLoadtest } from "@/lib/loadtest-guard";
import { sendThrottledAlert } from "../notify/dispatch.ts";
import { logAlertSendFailure } from "../notify/send-failure.ts";
import { pageAfterAnswer, type PageScheduler } from "../notify/post-commit-page.ts";
import {
  raceBoundHitPage,
  raceOutcomeForConfirm,
  raceOutcomeForMove,
  raceOutcomeForRefusal,
  type RaceTallyOutcome,
} from "../monitor/race-contention.ts";
import type { BookingEventPayload, BookingReasonMeta } from "@/lib/webhooks/types";
import { routingMetaFromTrace } from "@/lib/webhooks/types";
// Type-only (erased under --experimental-strip-types), so this never pulls the
// emit module's runtime deps into the node-tested domain code.
import type { WebhookSendScheduler } from "@/lib/webhooks/emit";
import { catchallRecord, resolveRequestedCode } from "@/lib/routing/catchall";
import {
  resolveRoutingCode,
  type LeadXbcReader,
  type RoutingCodeRecord,
  type SubmissionLeadReader,
} from "@/lib/routing/lead-code";
import type {
  Booking,
  BookingEventAction,
  BookingEventInitiator,
  BookingInsert,
  BookingStatus,
  BookingOutbox,
  BookingOutboxInsert,
  OutboxPayload,
  BookingReservation,
  BookingReservationInsert,
  Bucket,
  BusyBlock,
  EventType,
  OutboxStep,
  OwnerAlertEvent,
  PendingEventDeletion,
  ReservationPayload,
  RoutingTrace,
  User,
  WebhookEvent,
} from "@/lib/db/types";

export type { PendingEventDeletion, BookingInsert };

/**
 * Booking orchestration (create / reschedule / cancel / complete), split out
 * from the IO so it's unit-testable. Every side effect — DB, Google Calendar,
 * webhooks, clock/random — is reached through the injected `BookingDeps`, so
 * `scripts/test-booking-orchestration.ts` drives the full flow with in-memory
 * fakes. `service.ts` binds `BookingDeps` to the real Supabase/Google/webhook
 * implementations. This module imports NO IO on purpose.
 */

export class SlotUnavailableError extends Error {
  constructor() {
    super("That time is no longer available. Please pick another slot.");
    this.name = "SlotUnavailableError";
  }
}

/**
 * #2838: a confirm refused AFTER its insert lost the overlap race (#2274) and no
 * further advisor took it: none after the loser in the same rung (#2281), and
 * since #3338 none on any rung below it either. A SlotUnavailableError, so every
 * caller keeps answering the same 409 with the same sentence; the subclass exists
 * so the booker can count it apart from a time already taken at the free check,
 * which is the only way a refusal after a race reaches any counter at all (it
 * writes no booking and no routing decision).
 *
 * `lostRaces` is how many advisors this confirm lost in a row, across every rung it
 * walked. `boundHit` says the refusal came from `MAX_RACE_REASSIGNS`, not from
 * nobody after the loser being free: the rung was not asked about a further
 * advisor, so nothing may claim it had none.
 *
 * `ladderExhausted` (#3338) says every rung the ladder had left was asked and
 * nobody on it could take the time: the race was lost on the last rung with
 * nobody after the loser, the walk down found nobody, or the confirm was a named
 * link, whose one advisor is its whole ladder. Only then does the refusal settle
 * the confirms waiting behind it (`verdictForRefusal`). A bound hit, a check that
 * could not answer and an adopted pin all leave it false: they learnt nothing
 * about the rest of the ladder, so nothing may say it is full (L11).
 */
export class RaceLostRefusalError extends SlotUnavailableError {
  readonly lostRaces: number;
  readonly boundHit: boolean;
  readonly ladderExhausted: boolean;
  constructor(lostRaces: number, boundHit: boolean, ladderExhausted: boolean) {
    super();
    this.name = "RaceLostRefusalError";
    this.lostRaces = lostRaces;
    this.boundHit = boundHit;
    this.ladderExhausted = ladderExhausted;
  }
}

/**
 * #3489 step 3: a rung every advisor of which another confirm in this line has claimed,
 * met by a confirm that can walk past it (Dan, 2026-10-07: "Walk down straight away").
 * A SlotUnavailableError so the walk drops the rung as it drops a spent one, and never
 * the answer anybody is given: the walk remembers it, and a ladder spent only so ends in
 * `LadderSpentByClaimsError`, never a refusal.
 */
export class RungSpentByClaimsError extends SlotUnavailableError {
  constructor() {
    super();
    this.name = "RungSpentByClaimsError";
  }
}

/**
 * #3489 step 3: the walk reached the end of the ladder having skipped a rung only because
 * every advisor on it is claimed by a confirm still in flight. Not a refusal and not an
 * outage: the confirm PARKS in its line (`LineTurn.park`), which answers it when those
 * claims end, "taken" when they all booked, or a turn to read again when one did not.
 */
export class LadderSpentByClaimsError extends Error {
  /**
   * What the walk found, as the refusal it would have thrown had the rungs it skipped
   * been booked rather than claimed: the confirm refuses with exactly this when the line
   * says its walk stands (`LineTurn.spent`).
   */
  readonly refusal: unknown;
  /**
   * #3529: writes the routing decision row `refusal` would have written, set by the
   * confirm that knows its bucket. Parking writes none, since the confirm may yet book;
   * a walk that then stands calls this before it refuses, so the refusal is on record.
   */
  recordRefusal?: () => Promise<void>;
  constructor(refusal: unknown) {
    super("every rung this confirm could book is held by confirms still in flight");
    this.name = "LadderSpentByClaimsError";
    this.refusal = refusal;
  }
}

/**
 * Thrown when a reschedule loses a CONCURRENT race to a DIFFERENT target time —
 * another in-flight reschedule holds a fresh lease on this booking (#439). The
 * loser is told the booking moved under it instead of silently no-opping, so the
 * actor knows to refresh. Distinct from SlotUnavailableError; both map to 409.
 */
export class RescheduleConflictError extends Error {
  constructor() {
    super("This booking was just changed. Refresh and try again.");
    this.name = "RescheduleConflictError";
  }
}

/**
 * The durable per-booking reschedule pin (#439, migration 0053). Written to the
 * reschedule_locks row BEFORE the Google call, then read back verbatim on a
 * crash-resume so the retry reuses the SAME agent + branch + deterministic event
 * id (never recomputed — recomputing reopens the duplicate/oscillation windows).
 */
export interface ReschedulePin {
  reschedule_seq: number;
  branch: "in_place" | "reassign";
  pinned_user_id: string;
  pinned_agent_email: string;
  gcal_client_id: string;
  target_starts_at: string;
}

/**
 * Outcome of claiming the per-booking reschedule lease (#439). The lease is the
 * single arbiter of concurrency AND crash-resume: `won` = no holder (fresh
 * attempt); `resume`/`fresh-after-abandon` = a crashed holder's expired lease is
 * taken over (adopt the pin); `idempotent`/`noop` = a same-target no-op (the
 * booking already sits at the target or a same-target double-submit); `conflict`
 * = a different-target holder still holds a FRESH lease (throw, don't no-op).
 */
export type RescheduleClaim =
  | { outcome: "won" }
  | { outcome: "resume"; pin: ReschedulePin }
  | { outcome: "fresh-after-abandon"; pin: ReschedulePin }
  | { outcome: "noop" }
  | { outcome: "conflict" }
  | { outcome: "idempotent" };

/** A reschedule lease-pin past its lease (a crashed, never-retried holder), with
 *  the booking's CURRENT event id, for the abandoned-pin GC sweep (#439). */
export interface AbandonedReschedulePin {
  booking_id: string;
  pinned_agent_email: string;
  gcal_client_id: string | null;
  branch: "in_place" | "reassign" | null;
  booking_gcal_event_id: string | null;
  /** Where the crashed reschedule meant to move the booking. */
  target_starts_at: string;
  /** Where the booking ACTUALLY sits now, so the sweep can tell a lost reschedule
   *  from one that committed and merely failed to release its lock (#757). Null
   *  when the booking no longer exists. */
  booking_starts_at: string | null;
}

/** #3924: what the abandoned pin sweep reads of a booking before it touches its invite. */
export interface BookingInviteState {
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  gcal_event_id: string | null;
  agent_email: string | null;
  /** The lead's zone, which the put back writes the invite in. */
  timezone: string;
}

/**
 * #3924: an invite an abandoned in place reschedule left out of step with its
 * booking, which the sweep did not put back. Reported per booking by the caller.
 */
export interface StrandedInvite {
  bookingId: string;
  /** The advisor whose calendar holds the invite. */
  advisorEmail: string;
  /**
   * The booking's own time: read under the lock, or, when that read failed, the one
   * the sweep read before it. Null only when neither read found it.
   */
  bookedStartsAt: string | null;
  /** Where the crashed reschedule was moving it. */
  targetStartsAt: string;
  /** Where Google holds the invite now, or null when it was not read. */
  inviteStartsAt: string | null;
  /** Why it was not put back (`StrandedInviteReason`, beside the words that say it). */
  reason: StrandedInviteReason;
  /** The short reason a refusal or a failed read gave. */
  detail: string | null;
}

/** What one abandoned pin sweep did (#439, #757, #3924). */
export interface AbandonedPinSweep {
  /** Rows the sweep took over and cleaned up. A row somebody else holds now is not counted. */
  swept: number;
  enqueued: number;
  dropped: number;
  /** #3924: lead invites a crashed in place move had changed, moved back to the booked time. */
  invitesPutBack: number;
  /** #3924: such invites that could not be put back, each to be reported. */
  strandedInvites: StrandedInvite[];
}

/**
 * A crashed standalone-reassign create intent past its lease (#518), with the
 * booking's live event id, for the abandoned-reassign-intent GC sweep. Records
 * the NEW event (`gcal_client_id`, created before the swap) and, once the swap
 * has committed, the REPLACED old event (`prev_*`, so the sweep can finish the
 * interrupted delete-old). The sweep deletes whichever recorded event is NOT the
 * booking's live one.
 */
export interface AbandonedReassignIntent {
  booking_id: string;
  pinned_agent_email: string;
  gcal_client_id: string;
  prev_agent_email: string | null;
  prev_gcal_event_id: string | null;
  /** When the swap COMMITTED, or null if it never did (#758). The difference between
   *  a reassign that was LOST and one that succeeded and was later superseded. */
  swapped_at: string | null;
  booking_gcal_event_id: string | null;
}

/**
 * Thrown when a booking fails NOT because every candidate is genuinely busy, but
 * because we couldn't verify any of them (calendar/DB read errors — a likely
 * verify-on-book outage). Distinct from SlotUnavailableError so the caller can
 * alert and return a retryable response instead of a generic "no times" (#319).
 */
export class VerifyUnavailableError extends Error {
  constructor() {
    super("We hit a temporary issue confirming this time. Please try again in a moment.");
    this.name = "VerifyUnavailableError";
  }
}

/**
 * #3837: a lead's retry found the reservation its earlier confirm left, and another
 * holder (the reservation drain, or another retry of the same lead) holds that
 * reservation's lease, so this retry leaves it alone. Nothing was written.
 *
 * A subclass of `VerifyUnavailableError` so every booking route answers it as the
 * retryable 503 it is, with the sentence the booker already shows and the lead's rate
 * limit hit refunded: by the next try the holder has finished, and the retry finds
 * the booking by its key or a reservation free to resume. It is NOT the verify
 * outage and pages nobody (`bookingFailureAlert`): a lease held by another holder is
 * the coordination working, not anything being down. It is counted with the verify
 * outage refusals on the route, which it is rare enough not to move.
 */
export class ReservationHeldError extends VerifyUnavailableError {
  constructor() {
    super();
    this.name = "ReservationHeldError";
  }
}

/**
 * #3859: a lost attempt's reservation could not be deleted, because the database
 * refused the delete (`dropLostReservation`). The confirm stops there: its next
 * attempt would reserve under the same key and adopt this very row, still pinned to
 * the advisor who was just taken. The row stays pending for the reservation drain.
 *
 * A subclass of `VerifyUnavailableError` so every booking route answers it as the
 * retryable 503 it is and refunds the lead's rate limit hit, rather than the generic
 * 500 the bare error used to reach. Unlike `ReservationHeldError` something IS down,
 * so it pages, under the verify outage's key with words of its own
 * (`reservationRollbackAlert`). Its message is the sentence the lead is shown, so
 * what the database said is in `cause` and, for the drain's record, `detail`.
 */
export class ReservationRollbackError extends VerifyUnavailableError {
  readonly reservationId: string;
  readonly detail: string;
  constructor(reservationId: string, cause: unknown) {
    super();
    this.name = "ReservationRollbackError";
    this.reservationId = reservationId;
    this.cause = cause;
    this.detail = `the reservation's rollback delete was refused: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

/**
 * A dependency on the booking path did not answer inside its deadline (#3102):
 * Google or Supabase accepted the request and never replied.
 *
 * A subclass of `VerifyUnavailableError` on purpose, so it reaches every booking
 * route as the outage they already answer with a retryable 503 and the sentence
 * the booker already shows, refunds the lead's rate limit hit the same way, and
 * is counted under the same refusal. Before this it escaped as an unexpected
 * error, a generic 500 that told the lead nothing and paged nobody as an outage.
 * It carries WHAT did not answer, for the page.
 */
export class DependencyTimeoutError extends VerifyUnavailableError {
  /** The call that was in flight: the dependency somebody has to look at. */
  readonly dependency: string;
  readonly timeoutMs: number;
  /** The request's budget, when that is what cut the call short. */
  readonly budget: { label: string; totalMs: number } | null;
  /** #3338: what the work Slate did not start was measured to need, when that is
   *  why it was not started (`DeadlineFound.neededMs`). */
  readonly neededMs: number | undefined;
  constructor(found: DeadlineFound, cause: unknown) {
    super();
    this.name = "DependencyTimeoutError";
    this.dependency = found.label;
    this.timeoutMs = found.timeoutMs;
    this.budget = found.budget;
    this.neededMs = found.neededMs;
    this.cause = cause;
  }
}

/**
 * #3442: the retryable timeout a confirm answers after LOSING the overlap race with
 * nobody after it free on its rung and too little of its budget left to walk down
 * the ladder (#3338). Every route answers it exactly as the timeout it is (a 503,
 * the lead told to try again); it is named apart only so the routes can count it in
 * the race tally (`RACE_RETRY_BUDGET_OUTCOME`), where it was missing, so the daily
 * race whisper undercounted losers on exactly the days budgets ran tight.
 */
export class LostRaceOutOfTimeError extends DependencyTimeoutError {
  constructor(found: DeadlineFound) {
    super(found, null);
    this.name = "LostRaceOutOfTimeError";
  }
}

/**
 * The one place a deadline becomes the booking outage (#3102). Applied where the
 * booking entry points already decide what to page about, so every route that
 * calls them gets the 503 without learning what a deadline is. Anything else,
 * including an outage already classified, is returned untouched.
 */
export function timeoutAsRetryable(err: unknown): unknown {
  if (err instanceof VerifyUnavailableError) return err;
  // #3134: the Google breaker refusing a call is the same outage seen sooner, so
  // the lead gets the same retryable answer, and it can never become a booking.
  if (err instanceof GoogleBreakerOpenError) {
    const refused = new VerifyUnavailableError();
    refused.cause = err;
    return refused;
  }
  const found = findDeadlineExceeded(err);
  return found ? new DependencyTimeoutError(found, err) : err;
}

/**
 * Thrown when the per-booking reschedule lease can't be claimed because of an
 * unexpected DB error (NOT a genuine conflict). The claim fails CLOSED (a claim
 * we can't trust must never re-open the concurrent-duplicate window, #439), but
 * the fault is transient and safe to retry, so it maps to a retriable 503 (like
 * VerifyUnavailableError), not a generic 500 (#479). Routed through
 * `bookingFailureAlert` so the outage still pages ops: before #479 it reached
 * `internalErrorResponse` (which alerts per route), and mapping it to 503 earlier
 * would otherwise silently drop that alert.
 */
export class RescheduleLockUnavailableError extends Error {
  constructor() {
    super("Could not lock this booking for reschedule. Please try again.");
    this.name = "RescheduleLockUnavailableError";
  }
}

/**
 * Thrown when a bucket has ZERO eligible agents (an empty/misconfigured pool —
 * e.g. an XBC code the attribute sync hasn't populated), as opposed to every
 * agent being genuinely busy (SlotUnavailableError). Distinct so a machine caller
 * can stop retrying and escalate, instead of treating a config error as a
 * transiently-full slot (#358).
 */
export class NoEligibleAgentsError extends Error {
  /** The bucket that resolved to no eligible agents, for the alert (#327). */
  readonly bucketCode: string | null;
  /**
   * True when the dead bucket is a synthetic is_test bucket (the smoke test's).
   * The booking still fails as designed, but the reactive routing alert is
   * suppressed so test activity never looks like a real outage (#465).
   */
  readonly isTest: boolean;
  constructor(bucketCode: string | null = null, isTest = false) {
    super("No advisors are configured for this booking type.");
    this.name = "NoEligibleAgentsError";
    this.bucketCode = bucketCode;
    this.isTest = isTest;
  }
}

export class DailyCapExceededError extends Error {
  readonly agentEmail: string;
  readonly day: string;
  constructor(agentEmail: string, day: string) {
    super(`Agent ${agentEmail} is at their daily cap on ${day}`);
    this.name = "DailyCapExceededError";
    this.agentEmail = agentEmail;
    this.day = day;
  }
}

/**
 * Thrown when a call would START outside the lead's calling window, 08:00 to
 * 20:00 in the lead's own zone (#2310). Regal's quiet hours journey cancels such
 * a call and files a Rebook Request, so Slate refuses it rather than book a call
 * that will not be made.
 *
 * Its own class rather than a SlotUnavailableError: the time is not taken, it is
 * one this lead may not be called at, and a retry at the same time can never
 * succeed. The caller recovers by picking another time, which is why every route
 * answers it as a distinct refusal the lead can act on.
 *
 * Thrown BEFORE anything is written (no reservation, no event, no lease, no
 * contact correction), so a refusal leaves no half done change behind.
 */
export class OutsideCallingWindowError extends Error {
  /** The zone the start was judged in, after the fallback (`leadCallingZone`). */
  readonly zone: string;
  constructor(zone: string) {
    super(`That time is outside the lead's calling window in ${zone}.`);
    this.name = "OutsideCallingWindowError";
    this.zone = zone;
  }
}

/**
 * The fourth gate (#2310), called wherever a call's time is chosen or moved.
 * `zone` is the lead's zone as the caller knows it; `leadCallingZone` decides
 * what a missing or unreadable one is judged in, so this never waves one through.
 */
function assertWithinLeadCallingWindow(startIso: string, zone: string | null | undefined): void {
  if (!withinLeadCallingWindow(startIso, zone)) {
    throw new OutsideCallingWindowError(leadCallingZone(zone));
  }
}

/**
 * The two refusals a reschedule answers before anything about the new time: no
 * such booking, and a booking that is over. One helper so the calling-window
 * pre-check and the main path cannot word or order them differently (#2310).
 */
function assertReschedulable(ctx: BookingContext | null): asserts ctx is BookingContext {
  // Typed, so the route maps these to a clean 4xx. A plain Error here is an EXPECTED
  // refusal (a stale link on a call that already happened, an unknown token) dressed as
  // an unexpected fault, which fell through to the generic 500 that pages the on-call
  // (#3569, L35: classify errors once).
  if (!ctx) throw new BookingNotFoundError();
  if (ctx.booking.status === "cancelled" || ctx.booking.status === "completed") {
    throw new BookingNotChangeableError();
  }
}

/** Thrown when the bucket code resolves to no bucket/event type (#358). */
export class UnknownBucketError extends Error {
  constructor() {
    super("Unknown booking bucket");
    this.name = "UnknownBucketError";
  }
}

/**
 * The call this person already has, as much of it as they may be shown.
 *
 * Disclosure is graded exactly as the confirmation-screen warning is (#1340):
 * only a strong (salesforce / external id) or medium (email AND phone) match
 * carries the booking's details and its manage token. A weak one-signal match
 * (a shared household phone, a couple on one email) carries nothing, because
 * that call may belong to somebody else and the token can reschedule or cancel
 * it. The refusal itself is deliberately looser than the disclosure: ANY of the
 * three signals is enough to decline a second booking (Dan, 2026-08-07).
 */
export type ExistingCall =
  | {
      disclose: true;
      /** Start of the call they already have (ISO instant). */
      startsAt: string;
      /** The advisor it is with, or null when it cannot be resolved. NEVER a
       *  placeholder: naming the wrong person is worse than naming nobody
       *  (L75), and the assignee is read live because coverage reassignment and
       *  bulk reassign both move a booking to a different agent. */
      advisorName: string | null;
      /** Lets the lead move THIS call into the slot they just picked. */
      manageToken: string;
      /**
       * Where the times for moving THIS call come from (#2827). A call booked
       * through an advisor's own link can only move to a time that advisor can
       * take, so the booker's picker reads that advisor's times by the manage token
       * above rather than the page's own pool. Decided by `rescheduleTimesFrom`,
       * the predicate the manage page and the admin move use too.
       */
      rescheduleTimesFrom: RescheduleTimesFrom;
      /**
       * The number the advisor will ring, in full, or null when the booking
       * carries none (#2213).
       *
       * The whole number, the way the manage page has always shown it, so the two
       * surfaces say one sentence rather than two spellings of one. Dan settled
       * that on 2026-09-10, reversing the four digit version (#2207): anyone
       * holding the booking link can read this lead's number off the panel, which
       * is a smaller thing than the cancel the same link already grants.
       *
       * Null rather than an empty string, because "no number on this call" and "a
       * number we will call" are different screens with different controls, and
       * only one of them may be written (L11).
       */
      phone: string | null;
      /**
       * Whether the panel may offer to CANCEL this call (#2167).
       *
       * Strong matches only, which is narrower than disclosure on purpose. A
       * medium match is an email AND a phone both matching, which is enough to
       * NAME the call and enough to move it into a time this same person just
       * picked, and cancelling is the one action here that destroys something
       * without putting anything in its place. The id tiers are the ones where
       * the link itself is the identity.
       *
       * Decided on the server rather than by the panel reading a strength, so
       * there is one owner of the rule and the client cannot loosen it (#1340).
       */
      mayCancel: boolean;
    }
  | { disclose: false };

/**
 * Thrown instead of creating a second booking for someone who already has an
 * active call (#1337). Nothing is created: the lead is shown the call they have
 * and offered the choice of moving it into the slot they just picked.
 *
 * Only the public booker opts in (`refuseIfPersonHasCall`). The direct booking
 * API keeps its own richer decision (`bookViaApi` / `decidePersonBooking`), which
 * deliberately DOES create when a cross-bucket rebook must land in a new bucket
 * before the old one is cancelled (#364).
 */
/**
 * The lead's corrected details could not be accepted, so nothing moved (#2164).
 *
 * Its own type rather than a generic failure, because the message inside it is a
 * sentence about the value they typed ("Enter a valid email address") and the
 * route has to give it back to them against the right field rather than as a
 * reason the move failed.
 */
export class ContactRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactRefusedError";
  }
}

// #3359: the typed refusal of the lead's address. Its own module (#3373) so the
// bulk coverage sweep can recognise it without importing the booking layer.
export { AttendeeEmailRefusedError };

export class ExistingCallError extends Error {
  readonly existingCall: ExistingCall;
  constructor(existingCall: ExistingCall) {
    super("This person already has an active call booked.");
    this.name = "ExistingCallError";
    this.existingCall = existingCall;
  }
}

/**
 * Thrown when the one-call-per-person check could not be MADE (#1641): the
 * bookings read behind it failed, so nothing is known about what this lead
 * already has.
 *
 * It fails CLOSED, reversing the fail-open this path shipped with. The fail-open
 * reasoning was that refusing on a database hiccup costs the lead their call
 * while a duplicate only costs an advisor a reconciliation, and that the
 * confirmation screen's `findDuplicateWarning` would tell the lead about any
 * duplicate that slipped through. That backstop runs the SAME query on the SAME
 * table: when the read is what failed, it is blind too and swallows its own
 * failure, so on the one occasion the fail-open was chosen for, nobody is told
 * anything (L345). What actually shipped was a second calendar invite, a second
 * slot consumed, and `booking.created` fired twice into Regal.
 *
 * The cost of failing closed is bounded: this maps to a retriable 503 with the
 * rate-limit hit refunded, like `VerifyUnavailableError` and
 * `RescheduleLockUnavailableError`, so the lead is asked to try again rather
 * than turned away. And a failed `bookings` SELECT is not a hiccup off to one
 * side of the path: the next thing this request does is INSERT into that same
 * table.
 */
export class ExistingCallCheckUnavailableError extends Error {
  constructor() {
    super("We hit a temporary issue booking this time. Please try again in a moment.");
    this.name = "ExistingCallCheckUnavailableError";
  }
}

/** Thrown when a lookup/cancel can't resolve an owned booking by id (#386). */
export class BookingNotFoundError extends Error {
  constructor() {
    super("Booking not found");
    this.name = "BookingNotFoundError";
  }
}

/** Thrown when a customer tries to cancel a booking that's already past its
 *  terminal state (#618): a completed meeting can't be flipped back to
 *  cancelled. Maps to a friendly 4xx, not a 500. */
export class BookingNotCancellableError extends Error {
  constructor() {
    super("This meeting has already taken place, so it can no longer be cancelled.");
    this.name = "BookingNotCancellableError";
  }
}

/** Thrown when a reassign target agent can't be resolved or isn't bookable
 *  (#621). A caller-input problem (bad/stale agent), so 404, never retryable.
 *  Message is preserved verbatim: the admin route's 404 mapping and an
 *  orchestration test still match on it. */
export class AgentNotAvailableError extends Error {
  constructor() {
    super("Agent not found or not bookable");
    this.name = "AgentNotAvailableError";
  }
}

/**
 * Thrown when a reassign would move a booking across WORLDS (#2660): a test
 * booking onto a real agent, or a real booking onto a test agent.
 *
 * The first puts a stranger's test call on a real advisor's calendar, which is
 * the outcome the public test bucket exists to prevent; the second books a real
 * lead with a mailbox nobody answers. Every reassign path (the admin control,
 * the machine owner path, the coverage sweep) shares `reassignBooking`, so the
 * refusal is made there once. A genuine conflict rather than bad input: the
 * request was well formed and retrying it changes nothing.
 */
export class ReassignAcrossWorldsError extends Error {
  constructor() {
    super("A test booking can only move to a test agent, and a real booking to a real agent.");
    this.name = "ReassignAcrossWorldsError";
  }
}

/** Thrown when a booking is (or becomes, concurrently) terminal so it can no
 *  longer be reassigned/changed (#621). A genuine conflict → 409, distinct from
 *  a transient outage so a machine caller stops retrying rather than looping. */
export class BookingNotChangeableError extends Error {
  constructor() {
    super("This booking can no longer be changed");
    this.name = "BookingNotChangeableError";
  }
}

/** Delete a calendar event, and if the delete FAILS, enqueue it for the retry
 *  drain (#401) instead of silently dropping it. Never throws to the caller —
 *  the booking flow proceeds; the queue is the durable net.
 *
 *  Exported for its own test (#1049): reaching it through cancel/reschedule needs
 *  the whole BookingDeps surface, and the behaviour worth pinning is narrow:
 *  when BOTH the live delete and the queue write fail, the event is orphaned on
 *  the agent's calendar and that must leave a trace.
 *
 *  #2561 made `deleteEvent` throw a typed `GoogleHttpError`, so the failure here
 *  is CLASSIFIABLE through `reachabilityFromError`. It is deliberately not branched
 *  on: a definitive failure (an account that is gone, or was never given Calendar)
 *  still belongs in the queue, because the queue row is the only record that an
 *  event is orphaned on a calendar nobody can reach, and dropping it would trade a
 *  retry nobody can satisfy for a silence nobody can see. The drain
 *  (`processPendingEventDeletions`) is where the classification is read: it ends
 *  such a row on its first pass and pages with copy naming the person who has to
 *  fix the account (#2577). */
export async function deleteEventBestEffort(
  deps: BookingDeps,
  email: string,
  eventId: string,
  bookingId: string | null,
  opts?: { notifyAttendee?: boolean },
): Promise<void> {
  try {
    await deps.deleteEvent(email, eventId, opts);
  } catch {
    await enqueueEventDeletionUnlessHeld(deps, email, eventId, bookingId);
  }
}

/**
 * The live booking that now holds a Google event, or null (#3215, L744). An event
 * id is derived from the request, so the lead's retry of a failed confirm adopts
 * the very event that attempt asked to delete, and a deletion that does not ask
 * first removes the calendar hold of a confirmed booking. Live means any status
 * that keeps a slot busy, so only a cancelled booking lets its event go. THROWS
 * when the read fails.
 */
async function liveEventHolder(deps: BookingDeps, eventId: string): Promise<string | null> {
  return deps.liveBookingHoldingEvent(eventId, [...ACTIVE_BUSY_STATUSES]);
}

/**
 * Queue an event's deletion for the drain (#401), unless a live booking already
 * holds the event (#3215), when there is nothing to delete. An unreadable holder
 * still queues: the drain asks again before it deletes anything, so a failed read
 * can leave a queue row behind but never deletes a held event. Never throws: if
 * the queue write is lost too, the event is orphaned on the agent's calendar with
 * nothing left to find it, which is logged as the last line of defence.
 */
async function enqueueEventDeletionUnlessHeld(
  deps: BookingDeps,
  email: string,
  eventId: string,
  bookingId: string | null,
): Promise<void> {
  let holder: string | null = null;
  try {
    holder = await liveEventHolder(deps, eventId);
  } catch (err) {
    log.warn(
      "booking",
      { msg: "could not read who holds an event; queueing its deletion anyway", gcal_event_id: eventId },
      err,
    );
  }
  if (holder) {
    log.info("booking", {
      msg: "event deletion not queued: a live booking holds the event",
      booking_id: bookingId,
      holder_booking_id: holder,
      gcal_event_id: eventId,
    });
    return;
  }
  await deps
    .enqueueEventDeletion(email, eventId, bookingId)
    .catch((err) =>
      log.error(
        "booking",
        { msg: "event-deletion enqueue failed", booking_id: bookingId, gcal_event_id: eventId },
        err,
      ),
    );
}

/**
 * Undo a Google event a failed booking path wrote (#3215). Two things set it
 * apart from an ordinary delete:
 *
 *  - it runs under the request's cleanup allowance, because the failure it
 *    answers is often the confirm budget running out, and under that spent
 *    budget the delete and its queue write were both refused at 0ms;
 *  - it asks first whether a live booking holds the event, since a deterministic
 *    event id can already belong to a racing request with the same key. An
 *    unreadable answer does not delete live: it queues, and the drain asks again.
 */
export async function compensateEvent(
  deps: BookingDeps,
  email: string,
  eventId: string,
  bookingId: string | null,
): Promise<void> {
  await withinOwedCleanup(async () => {
    let holder: string | null;
    try {
      holder = await liveEventHolder(deps, eventId);
    } catch {
      await enqueueEventDeletionUnlessHeld(deps, email, eventId, bookingId);
      return;
    }
    if (holder) {
      log.info("booking", {
        msg: "compensation skipped: a live booking holds the event",
        booking_id: bookingId,
        holder_booking_id: holder,
        gcal_event_id: eventId,
      });
      return;
    }
    await deleteEventBestEffort(deps, email, eventId, bookingId);
  });
}

/**
 * Queue the deletion of an event a failed write made, rather than deleting it
 * live, when a retry of the same request derives the SAME id (#3215, #3217).
 * Google keeps a deleted event's id, so a live delete here hands the retry a
 * cancelled event to adopt. Queued, the drain holds it while the write is still
 * pinned, drops it once a booking holds the event, and deletes it only once
 * neither does. Under the cleanup allowance, because the commonest cause is the
 * confirm budget running out, which refuses this write at 0ms too.
 */
async function queueOwedEventDeletion(
  deps: BookingDeps,
  email: string,
  eventId: string,
  bookingId: string | null,
): Promise<void> {
  await withinOwedCleanup(() => enqueueEventDeletionUnlessHeld(deps, email, eventId, bookingId));
}

/**
 * What a reschedule answers when its event create fails (#3373): the error to
 * throw, after doing the cleanup that error is owed.
 *
 * Google refusing the lead's stored address is a refusal about the email, never a
 * fault: the typed error lets the routes say so instead of `reschedule_internal`.
 * Nothing is queued for it, because a 400 means Google wrote no event, so there is
 * nothing to delete and the booking is left exactly as it was. Every other failure
 * keeps the #3217 handling: the event may have landed even though the answer never
 * came back, so it is queued for the drain to judge, never deleted live.
 */
async function refusedOrQueued(
  deps: BookingDeps,
  err: unknown,
  email: string,
  eventId: string,
  bookingId: string,
): Promise<unknown> {
  if (isInvalidAttendeeEmailRefusal(err)) return new AttendeeEmailRefusedError(err);
  await queueOwedEventDeletion(deps, email, eventId, bookingId);
  return err;
}

/**
 * Point a reschedule's pin at the event id it is about to write (#3217), BEFORE
 * the write, the same crash-safety rule the first pin follows: a resume then lands
 * on that id, and the deletion drain holds the event while the pin stands. A no-op
 * when the pin already names it. Throws when the pin cannot be written, before
 * anything reaches Google.
 */
async function repin(
  deps: BookingDeps,
  bookingId: string,
  pin: ReschedulePin,
  eventId: string,
): Promise<ReschedulePin> {
  if (pin.gcal_client_id === eventId) return pin;
  const next = { ...pin, gcal_client_id: eventId };
  await deps.writeReschedulePin(bookingId, next);
  return next;
}

export interface CreateBookingInput {
  bucketCode: string;
  /**
   * The `xbc` exactly as it arrived from the lead's link, when the caller knows
   * it (#1908). It is NOT always `bucketCode`: a blank or unreadable one is
   * routed to the Low pool, and this is the only evidence of what the upstream
   * page actually sent.
   *
   * Recorded, never routed on. Routing uses `bucketCode`, which the caller has
   * already resolved through `resolveRequestedCode`, so a client that lies about
   * this corrupts a metric and cannot reach a pool it was not routed to.
   *
   * Undefined means the caller did not say, which is different from an empty
   * string meaning the lead arrived with no code at all.
   */
  requestedCode?: string;
  startIso: string;
  timezone: string;
  salesforceId?: string | null;
  /** `firstName` is the first name the lead answered in its own field (#2549):
   *  the public booker sends it, the direct booking API takes one name and does
   *  not. `name` stays the joined name every layer carries. */
  attendee: { name?: string; firstName?: string; email?: string; phone?: string };
  prefill: Record<string, string>;
  /** Optional caller-supplied key; falls back to a derived bucket+slot+attendee key. */
  idempotencyKey?: string;
  /** External caller's stable per-person id (direct booking API, #357). */
  externalId?: string | null;
  /**
   * The origin of the page that framed the booker, as the CLIENT sent it (#2728).
   * Untrusted: createBooking reduces it to a bare origin itself and drops anything
   * that is not one. Only the public booker sends it; every other caller leaves it
   * out and the booking records null.
   */
  referrerOrigin?: string | null;
  /**
   * #3495: the tier whose times the caller had on show when the lead confirmed, as
   * its availability answer named it (`shownTier`). The booker hands it back, and so
   * does the load test; the route's schema has already dropped anything that is not
   * a tier name. Recorded as `routing_trace.displayed_tier` in place of the cache read
   * (`deps.displayedTier`), which cost a database request per rung in a crowd and
   * could see another confirm's booking. Undefined means the caller did not say (a
   * partner call, or a page loaded before this), and the confirm reads it as before.
   */
  shownTier?: string;
  /**
   * #3797: the `computed_at` of the slot list the lead picked the time from, as the
   * availability answer named it (`slotsComputedAt`). Only ever used to judge whether
   * a time refused at the free check was a lost race; never routed on. Untrusted: an
   * unreadable one is judged `unknown`, which counts as a refusal did before.
   * Undefined when the caller did not say, and then nothing is judged.
   */
  servedComputedAt?: string;
  /** Allow booking a synthetic test bucket (#396). Set in exactly two places:
   *  the key authed direct booking API, only for a canary caller or for the
   *  public test bucket's code (#2669, `mayBookTestBuckets`); and the Booker's
   *  confirm (`/booking`), only when the code is the public test bucket (#2660)
   *  and the request carries a good test pass (#2666). Every other caller leaves
   *  it falsy, so a real lead can never book a test bucket and a hidden one is
   *  refused like an unknown code. */
  allowTestBuckets?: boolean;
  /**
   * Refuse, rather than create, when this person already has an active call
   * (#1337). Set ONLY by the public booker: the direct booking API owns its own
   * decision (`decidePersonBooking`), which deliberately creates in a new bucket
   * before cancelling the old one on a cross-bucket rebook (#364), and would
   * break if the create underneath it started declining.
   */
  refuseIfPersonHasCall?: boolean;
  /**
   * #2073: book THIS agent through their own named link, rather than routing. Set
   * only by the booker's confirm, after the link's token resolved to a bookable
   * agent. `bucketCode` is then the bucket the booking is stored in (the agent's
   * own, see `chooseAgentLinkBucket`), never one to route through: no tier
   * ladder, no other agent, no Salesforce code lookup, no routing decision logged.
   * It also switches OFF the one call per person rule whatever
   * `refuseIfPersonHasCall` says, because a later call with a lead who already has
   * one is the exception that rule exists to allow. Every availability gate and
   * verify on book still run, for this one agent.
   */
  agentLinkUserId?: string;
  /**
   * #2876: which key authed the direct booking API call, set ONLY by that route
   * from the key it matched, never from the request body. A call naming no page
   * then records `api-<caller>` as its source rather than `not-given`, which the
   * per page volume alarm would read as a booking any page could have sent.
   */
  apiCaller?: FullApiCaller;
  /**
   * #3543: the MCP channel that made the call (today only Marcia, through
   * `McpBookingGateway`), set ONLY by that channel's server code. The booking then
   * records `mcp-<channel>` as its source, never `not-given`.
   */
  mcpChannel?: AuditChannel;
}

export interface BookingResult {
  booking: Booking;
  manageUrl: string;
  /**
   * Why the in-place agent was declined and the booking reassigned to another
   * agent (#543). `undefined` = kept in place, no in-place candidate, or a
   * crash-resume (the decline was logged on the original attempt). Observability
   * only; the service layer turns this into a log breadcrumb.
   */
  rescheduleDecline?: RescheduleDeclineReason;
  /**
   * Which of the lead's own details this move also corrected (#2164), or null
   * when it corrected none and undefined when none were offered.
   *
   * Carried out so the screen can SAY what happened rather than leaving the lead
   * to hope: they typed a new email and phone on the way to moving the call, and
   * an action that quietly applies half of what somebody asked for is one they
   * cannot check (L608).
   */
  contactChanged?: ContactChange | null;
  /**
   * Whether the booking sits on a test bucket, read off the bucket the context
   * load joined (#2658). Set on the RESCHEDULE path, where the route answers the
   * embedded booker directly and the booker announces the moved call to its host
   * in the same shape as a fresh booking, `isTest` included. The create path does
   * not set it: its route already resolved the flag from the bucket code before
   * calling in (#2660).
   */
  isTest?: boolean;
  /**
   * #2838: true only when THIS call's own insert made the booking. Absent on an
   * idempotent replay, on a reservation whose booking already existed, and when a
   * same key racer won, all of which return a booking an earlier confirm made. A
   * crash resume that completes the insert here does set it: the crashed request
   * never returned, so nothing counted that booking before. The booker counts a
   * lost race only when this is set, so one race is never counted twice.
   */
  newlyInserted?: true;
  /**
   * #3267: the booking committed and the work after its save did not finish, so the
   * answer is the booking and the reservation drain finishes the rest
   * (`answerCommitted`). The route counts it in the tally beside `created`, and the
   * monitor lane pages on the share (`follow-up-drain-rate.ts`, #3267). Absent when all of
   * the work landed.
   */
  followUpLeftToDrain?: true;
}

/**
 * Why an in-place reschedule could not keep the current agent (#543): the slot
 * rules it failed (`UnbookableReason`) plus `calendar` for a failed live busy
 * read (the agent's calendar was unreadable, so we re-route to be safe).
 */
export type RescheduleDeclineReason = UnbookableReason | "calendar";

/**
 * Observability context attached to a thrown reschedule failure (#543) so the
 * service layer can log WHY the in-place agent was declined before the reroute
 * ultimately found nobody, without the pure layer doing IO. Read with
 * `rescheduleFailureContext`.
 */
export interface RescheduleFailureContext {
  bookingId?: string;
  inPlaceDeclineReason?: RescheduleDeclineReason;
}

function tagRescheduleFailure(err: unknown, ctx: RescheduleFailureContext): void {
  if (err instanceof Error) Object.assign(err, ctx);
}

/** Read the observability context off a reschedule failure (#543); empty if none. */
export function rescheduleFailureContext(err: unknown): RescheduleFailureContext {
  if (!(err instanceof Error)) return {};
  const e = err as Error & RescheduleFailureContext;
  return { bookingId: e.bookingId, inPlaceDeclineReason: e.inPlaceDeclineReason };
}

export interface CreateEventArgs {
  summary: string;
  description?: string;
  /** #3376: the lead's phone as stored (`eventLocation`); absent when there is none. */
  location?: string;
  start: string;
  end: string;
  timezone: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

/**
 * #3495: what a fresh booking's save hands `commit_fresh_booking` (migration 0174),
 * which writes the booking, its busy block, its webhook deliveries, its routing
 * record and the reservation's delete in ONE call, where they were six.
 */
export interface CommitFreshInput {
  /** The row built for the reservation, with the id this confirm minted (the
   *  webhook names it, and its dedupe key IS it) and the event it wrote or adopted. */
  booking: BookingInsert & { id: string };
  reservationId: string;
  /** `booking.created`, built by the builder fire() uses; the function takes the
   *  booking id and times from the row as stored. Or, when the bucket it is built
   *  from would not read, the reason: the save then commits without it and keeps
   *  the reservation, so the drain, which reads the bucket again, sends it. */
  webhook: { payload: BookingEventPayload; dedupeKey: string; suppressed: boolean } | { unbuilt: string };
  /** The routing record for a routed booking; null for an agent link one (#2073). */
  routing: RecordRoutingDecisionInput | null;
}

/**
 * What the save came to. `conflict`: a guard refused the insert (another booking at
 * the start, `bookings_active_slot_uniq`; one overlapping it,
 * `bookings_active_no_overlap`, #2274; an advisor held for a reroute, the 0166
 * trigger; the lead's own key), NOTHING was written, and `winner` is the active
 * booking holding the lead's key, or null when the slot went to somebody else.
 * `committed`: the booking, and each optional step that failed and why, none of
 * which undid it; the reservation is kept when the webhook step failed, so the drain
 * re-runs the side effects and the webhook is not lost.
 */
export type CommitFreshResult =
  | {
      kind: "committed";
      booking: Booking;
      failed: { busy?: string; webhook?: string; routing?: string };
      reservationDeleted: boolean;
    }
  | { kind: "conflict"; winner: Booking | null };

/**
 * #3495: Postgres refused the save call, answering with an error, so NOTHING was
 * written (the function is one transaction). Any OTHER failure of the call, a deadline,
 * a dropped connection, an answer that could not be read, may have COMMITTED, and the
 * confirm reads the booking back before telling a lead it failed.
 */
export class CommitRefusedError extends Error {
  readonly refusal: { code?: string; message: string };
  constructor(refusal: { code?: string; message: string }) {
    super(`the booking commit was refused: ${refusal.message}`);
    this.name = "CommitRefusedError";
    this.refusal = refusal;
  }
}

export type BookingUpdate = {
  starts_at?: string;
  ends_at?: string;
  assigned_user_id?: string | null;
  agent_name?: string | null;
  agent_email?: string | null;
  status?: Booking["status"];
  gcal_event_id?: string | null;
  allow_double_book?: boolean;
  routing_trace?: RoutingTrace | null;
  reschedule_seq?: number;
};

/** A booking row plus the WORLD its bucket is in (#2660), for a read that has
 *  no bucket beside it to ask. */
export type BookingWithWorld = Booking & { isTest: boolean };

export interface BookingContext {
  booking: Booking;
  bucket: Bucket;
  eventType: EventType;
  /**
   * The assigned agent's working-hours schedule, folded into the context load on
   * the reschedule path (#538) so the in-place guard's on-shift check adds no
   * extra round-trip. Present only when loaded with `{ withWorkingHours: true }`
   * AND the booking has an assigned agent; other callers (cancel, manage render)
   * leave it undefined.
   */
  agentWorkingHours?: { timezone: string; rules: WorkingRule[] };
}

/** A booked call as the slot refresh needs it: who holds it, and when (#3324). */
export type BookedWindow = { userId: string; startsAt: string; endsAt: string };

/** What deleting a reservation by its id came to (#3859): the row was removed, or no
 *  row had that id. A refused delete is neither; it throws. */
export type ReservationDeleteOutcome = "deleted" | "gone";

/** Every side effect the orchestration needs. `service.ts` wires the real ones. */
export interface BookingDeps {
  // availability / routing
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /**
   * One lead's `XBC__c` from Salesforce (#2638), for a booker confirm whose link
   * carried no code Slate can route. THROWS on a failed read, never answers null
   * for a query that did not run: a null routes the lead to the catch-all, which
   * is the misroute the read exists to prevent. See `src/lib/routing/lead-code.ts`.
   */
  readLeadXbc: LeadXbcReader;
  /**
   * The Lead a Salesforce Submission names (#3246), for a confirm whose link carried
   * no code and no Lead id but did carry the submission id. THROWS on a failed read.
   */
  readSubmissionLead: SubmissionLeadReader;
  /**
   * The number a lead's call will come FROM (#1334), from Salesforce Lead
   * `AssignedRegalPhone__c`: E.164, or null when not known. THROWS on a refused
   * read; its callers then say nothing about a number rather than fail the action.
   */
  readCallingNumber(leadId: string | null): Promise<string | null>;
  /**
   * The timer the calling number deadline runs on. Absent means the real clock;
   * tests inject one so a hung read is judged without waiting for real (L524).
   */
  deadlineTimer?: ScheduleTimer;
  /**
   * What an invite's description says NOW ("" when it has none), or null when the
   * event is gone (#1334). Throws when it cannot be read. Read so a correction can
   * edit one line rather than rebuild the whole description.
   */
  readEventDescription(agentEmail: string, eventId: string): Promise<string | null>;
  /** `preview` = a dry run (#380): route read-only, skipping the unfair-ordering
   *  alert so a preview never pages. */
  /**
   * The agents free for this instant, AND how many the bucket has at all (#1300).
   *
   * Both numbers, because zero free has two causes that need opposite handling and
   * are indistinguishable from the free list alone: the bucket has nobody in it (a
   * misconfiguration, which pages), or it has people and none of them is on shift
   * or free right now (an ordinary evening, which must not). The count is returned
   * rather than fetched separately because the implementation already loaded the
   * members in order to filter them.
   */
  roundRobinCandidates(
    bucket: Bucket,
    eventType: EventType,
    startMs: number,
    preview?: boolean,
    /**
     * #2073: narrow the read to this one agent, for a booking made through their
     * own named link. The same gates run (the org's hours, the agent's hours,
     * their calendar, the daily cap), for them alone; the pool size is then
     * theirs alone too. Undefined for every routed booking.
     */
    onlyUserId?: string,
    /**
     * #2842: drop every advisor who carries Low, on a rung below a top tier lead's
     * own tier (`rungExcludesLow`). The pool size is then the filtered pool's.
     */
    excludeLow?: boolean,
    /**
     * #3248: a reroute asks at a time that is already chosen. `fixedTime` judges
     * the exact window (never the advisor's offering grid) with no minimum notice;
     * `forBookingId` is the booking being rerouted, whose own hold excludes nobody.
     * Absent for every booker call.
     */
    opts?: RoundRobinOpts,
    /** #3797: `memberIds` is every advisor counted in `memberCount`, so a refusal can be
     *  judged a lost race against their busy time. Optional: a fake that leaves it out
     *  leaves every refusal unjudged, which counts it exactly as before. */
  ): Promise<{ candidates: string[]; memberCount: number; memberIds?: string[] }>;
  /**
   * #3489: everything the candidate read needs for every rung of `codes` (a ladder, top
   * first) in ONE request (`ladder_candidate_inputs`), for a slot at `startIso` whose
   * requested rung has `eventType`. A walk makes it once and judges each rung from it
   * (`RoundRobinOpts.inputs`) and takes each lower rung's bucket from it, rather than
   * reading every rung with seven to nine requests of its own and a bucket read. THROWS
   * on a failed or unreadable read, as the reads it replaces did.
   *
   * Optional: deps without it (the fakes, unless a suite opts in) walk the ladder with
   * the separate reads, exactly as before.
   */
  readLadderInputs?(codes: readonly string[], startIso: string, eventType: EventType): Promise<LadderInputs>;
  /**
   * The ORG's opening hours (#1295, gate 1). Used by the two paths in this module
   * that judge a slot themselves: the in-place reschedule guard, and `checkBookable`,
   * which has to answer `closed` rather than let a shut org read as a busy ladder.
   * The booker's own display gets them inside `roundRobinCandidates`'s implementation.
   *
   * THROWS on an unreadable week rather than degrading, deliberately: the whole
   * point of the gate is that a narrowing cannot be silently re-opened.
   */
  businessHours(): Promise<BusinessHoursRules>;
  // google calendar
  /**
   * The agent's working-hours schedule (#527): timezone + shift rules, read from
   * availability_schedules + availability_rules. Used by the in-place reschedule
   * branch to confirm the new time is on-shift before keeping the same agent —
   * `isFree` only proves the calendar is empty, not that the agent is working.
   * A schedule-less agent returns America/New_York + [] (matching the slot-compute
   * default), so the guard treats them as off-shift and re-routes.
   */
  agentWorkingHours(userId: string): Promise<{ timezone: string; rules: WorkingRule[] }>;
  /**
   * Live busy intervals for ONE agent across all their calendars (#536), epoch-ms,
   * over [fromIso, toIso). The in-place reschedule guard reads these so it can run
   * the SAME `isBookableSlotForAgent` predicate the booker does — buffers and all —
   * instead of a bare boolean free check. `null` means the calendar read failed
   * (an alert is raised by the impl); the guard treats that as not-bookable-in-place
   * and re-routes, exactly as the old `isFree` failure path did.
   */
  busyIntervalsForAgent(
    email: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ start: number; end: number }[] | null>;
  /**
   * Active (confirmed/rescheduled) booking start instants for ONE agent in
   * [fromIso, toIso), epoch-ms, EXCLUDING `excludeBookingId` (#536). The in-place
   * reschedule guard loads the agent's other bookings on the target local day to
   * enforce the daily cap — excluding the booking being moved so a same-day nudge
   * isn't counted against its own cap.
   */
  agentActiveBookingStartsMs(
    userId: string,
    fromIso: string,
    toIso: string,
    excludeBookingId: string,
  ): Promise<number[]>;
  /**
   * Batched verify-on-book free check: given a wave of candidate emails, return
   * the subset confirmed free for [startIso, endIso). The real impl reads the
   * whole wave's free/busy in bounded, batched Google calls instead of one
   * serial call per candidate (#167).
   */
  verifyFree(
    emails: string[],
    startIso: string,
    endIso: string,
    /** #3495: each email's advisor id, when the caller already holds them (email to id). */
    ids?: ReadonlyMap<string, string>,
  ): Promise<VerifyResult>;
  /**
   * Create (or 409-adopt) the event under `clientId`. Past a cancelled tombstone
   * it walks the id's fresh id chain (#3217) and returns the id it actually used,
   * calling `onFreshId` BEFORE each fresh id is inserted so a caller can record it
   * first (a reschedule pin, a reassign intent).
   */
  createEvent(
    email: string,
    args: CreateEventArgs,
    clientId?: string,
    opts?: { onFreshId?: (id: string) => Promise<void> },
  ): Promise<string>;
  deleteEvent(email: string, eventId: string, opts?: { notifyAttendee?: boolean }): Promise<void>;
  /** #830: whether an event still exists on Google (true), is gone (false), or
   *  cannot be verified (throws), used to avoid alerting on a false orphan. */
  eventExists(email: string, eventId: string): Promise<boolean>;
  // --- The advisor only "previously pitched" alert (#2371) -----------------
  // Its own calendar primitives rather than the booking ones above: the alert has
  // no attendees, no `sendUpdates` (there is nobody to tell), and is written to a
  // named calendar as that advisor's own identity.
  /** Create the alert event. Returns Google's id, reusing the existing event on a
   *  409 of our deterministic client id. */
  createOwnerAlertEvent(
    actorEmail: string,
    calendarId: string,
    body: OwnerAlertEventBody,
    clientId: string,
  ): Promise<string>;
  /** Take the alert event off the calendar. Tolerant of an already-gone event. */
  deleteOwnerAlertEvent(actorEmail: string, calendarId: string, eventId: string): Promise<void>;
  /** Move the alert event to a new window. Throws `EventGone` when it is not there. */
  moveOwnerAlertEvent(
    actorEmail: string,
    calendarId: string,
    eventId: string,
    startIso: string,
    endIso: string,
    timezone: string,
  ): Promise<void>;
  /** This booking's live alert row, or null. Throws on an unreadable row: an empty
   *  answer reads as "no alert", which writes a second one and skips every removal. */
  loadLiveOwnerAlert(bookingId: string): Promise<OwnerAlertEvent | null>;
  /** The durable record, written BEFORE the calendar event exists (L421). */
  insertOwnerAlert(row: {
    booking_id: string;
    user_id: string;
    calendar_id: string;
  }): Promise<OwnerAlertEvent>;
  /** Stamp the event Google created (or already held) onto the row. */
  setOwnerAlertEventId(id: string, gcalEventId: string): Promise<void>;
  /** Record a definitively refused calendar, so nothing retries and nothing pages. */
  recordOwnerAlertSkip(id: string, reason: string): Promise<void>;
  /** Close the row once its event is off the calendar. */
  markOwnerAlertRemoved(id: string, skipReason?: string | null): Promise<void>;
  // --- The owner reassign notice to the sales side (#2372) -----------------
  /**
   * The Slack channel the sales side reads (`monitor_alert_config.handoff_channel`,
   * #2367), or null when nobody has set one. THROWS on an unreadable setting: unset
   * means the notice is dropped and unreadable means the step retries, so an empty
   * answer standing in for a failed read would lose the notice silently.
   */
  loadHandoffChannel(): Promise<string | null>;
  /**
   * Whether an admin has the notice switched on (`owner_reassign_notice_on`,
   * migration 0188). THROWS on an unreadable setting, so the step retries rather
   * than guessing either way.
   */
  ownerReassignNoticeOn(): Promise<boolean>;
  /** Post one notice. Never throws; a refusal comes back as `ok: false`. */
  postHandoffNotice(channel: string, text: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * The zone this advisor keeps their week in, or null when Slate holds no
   * schedule for them. Never a default (see `loadAdvisorTimezone`).
   */
  advisorTimezone(userId: string): Promise<string | null>;
  /**
   * #2838: page a lead refused at the race reassign bound. Returns at once and
   * never throws: production (`pageRaceBoundHitAfterResponse`) sends it after the
   * response, so the lead's 409 never waits on Slack. A dependency rather than a
   * direct send so no suite driving that refusal can reach alert_state or Slack.
   */
  pageRaceBoundHit(page: { key: string; cooldownMs: number; text: string }): void;
  /**
   * #3221: the line confirms for one slot take turns in. Production hands every
   * request the shared line's client (#3325, `makeSharedConfirmLine`), which falls
   * back to the isolate's one line; a suite hands its own, so no two suites ever
   * share a turn. Every call is awaited: a shared line answers over the network.
   */
  confirmQueue: ConfirmLine<SlotSettlement>;
  /**
   * #3338: what this isolate's recent commit chains cost (`commit-cost.ts`), so a
   * confirm never starts a reservation, an event and an insert it cannot finish
   * inside its budget. One per isolate in production, like the line; a suite hands
   * its own, so no two suites share a measurement.
   */
  commitCosts: CommitCostLog;
  /**
   * #3325: the LADDER group a code's confirms share, from what this isolate already
   * holds, or null to keep the code's own line. Optional: a suite that does not set it
   * keys every line by code, which is what a cold isolate does.
   */
  lineGroupOf?: (code: string) => string | null;
  /**
   * #3354: stamp a point of the wait before the confirm's profile (`wait-marks.ts`),
   * so the request's `confirm answered` line can say where that wait went. Set by
   * the wiring under SLATE_LOADTEST only; absent, nothing reads the clock for it.
   */
  mark?: (point: WaitPoint) => void;
  /**
   * #3300: this request's stage profile, opened by the route's `answerTimed`, so a
   * slow or timed out confirm's `confirm answered` line says where its time went:
   * the confirm line, each stage, each ladder rung. Absent (a cron drain, a suite
   * that does not care), a confirm keeps a profile of its own that nothing reads
   * outside the load test.
   */
  profile?: ConfirmProfile;
  /**
   * #3401: told the Salesforce lead id (the 15 character key, or null) of the
   * booking a time change loads, so a time change that times out names its lead
   * on the route's `confirm answered` line as a new booking does. Absent, nothing
   * is told.
   */
  noteLeadId?: (leadId: string | null) => void;
  /**
   * #3257: every ACTIVE booking that starts at this instant, in any bucket and
   * either world. Read once by a confirm whose verdict settles its slot, so the
   * confirms waiting behind it can tell whether one of them already holds the
   * time. Bounded by the roster, since one advisor holds at most one active
   * booking per start; throws on a read error or a result too large to be whole.
   */
  findActiveBookingsStartingAt(startIso: string): Promise<Booking[]>;
  /** #401: record a Google event deletion that failed, for the retry drain. */
  enqueueEventDeletion(calendarEmail: string, gcalEventId: string, bookingId: string | null): Promise<void>;
  /** #401: load pending event deletions for the retry drain. */
  loadPendingEventDeletions(limit: number): Promise<PendingEventDeletion[]>;
  /**
   * #1630: one calendar's pending deletions (still under the give-up count), least
   * recently touched first. Read once Google has refused that calendar for good in
   * a pass, so its other rows settle in the same pass rather than each spending a
   * Google call on the same answer. THROWS on a failed read; the drain logs it and
   * leaves those rows for a later pass, which is the behaviour before #1630.
   */
  loadPendingEventDeletionsForCalendar(calendarEmail: string, limit: number): Promise<PendingEventDeletion[]>;
  /**
   * #1630: the users rows for these addresses (normalised, #1663), so a refused
   * calendar can be worded by whether its owner has left. THROWS on a failed read:
   * an empty answer would read as nobody having left, and the caller turns a throw
   * into an explicit unknown.
   */
  loadCalendarOwners(emails: readonly string[]): Promise<Pick<User, "id" | "email" | "name" | "deactivated_at">[]>;
  /**
   * #1630: who each of these bookings sits with now, and its status, so the
   * departure notice says a call was moved only where it was. THROWS on a failed
   * read, for the same reason.
   */
  loadBookingAssignees(bookingIds: readonly string[]): Promise<Pick<Booking, "id" | "assigned_user_id" | "status">[]>;
  /**
   * #3215 (L744): the id of a booking in one of `statuses` whose row names this
   * Google event id, or null when none does. An event id is derived from the
   * request, so a retry adopts the event a failed attempt queued for deletion, and
   * this is how a deletion learns the event now belongs to somebody. It must be a
   * FILTERED existence question, never a capped page of every row naming the
   * event: a live holder outside the page would read as no holder at all. THROWS
   * on a failed read, for the same reason.
   */
  liveBookingHoldingEvent(gcalEventId: string, statuses: readonly BookingStatus[]): Promise<string | null>;
  /**
   * Whether a write still in flight pins this event id, so a resume (the drain,
   * or the lead's retry) may yet adopt it: a PENDING create reservation (#3215), a
   * standing reschedule lock, or a reassign intent (#3217). THROWS on a failed
   * read, for the same reason.
   */
  pendingWritePinsEvent(gcalEventId: string): Promise<boolean>;
  /** #830: load creation-orphan rows (booking_id IS NULL) for the early alert. */
  loadCreationOrphans(limit: number): Promise<PendingEventDeletion[]>;
  /** #401: remove a successfully-deleted pending event deletion row. */
  removePendingEventDeletion(id: string): Promise<void>;
  /** #401: bump the attempt count and record the error for a failed deletion. */
  bumpPendingEventDeletion(id: string, attempts: number, error: string): Promise<void>;
  updateEventTime(email: string, eventId: string, startIso: string, endIso: string, timezone: string): Promise<void>;
  /**
   * #1341: rewrite the event body on the advisor's calendar. The invite is where
   * the advisor reads the number to dial, so a phone correction that only lands
   * in the database leaves them ringing the digits the lead just told us are
   * wrong. Separate from `updateEventTime` because the two patch different
   * fields and a phone correction must never touch the time.
   */
  updateEventDescription(email: string, eventId: string, description: string): Promise<void>;
  /** The lead's own details on the invite, in one PATCH (#2164). */
  updateEventContact(
    email: string,
    eventId: string,
    patch: { summary?: string; description?: string; location?: string; attendeeEmail?: string; attendeeName?: string },
  ): Promise<void>;
  // db
  getUser(userId: string): Promise<User>;
  /** Batched userId -> email resolver for a verify-on-book wave (skips emailless). */
  loadEmails(userIds: string[]): Promise<Map<string, string>>;
  /** The pre-save idempotency probe: fails OPEN to null on a read error, which the
   *  unique key index backs (a missed hit re-drives an insert the index refuses).
   *  ACTIVE bookings only: it answers "is this a replay", which a cancelled or
   *  completed booking is not. */
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  /** #3847: the newest booking on the key in ANY status, for a reservation resume,
   *  which must tell "committed and since cancelled or completed" from "never
   *  committed". THROWS on a failed read: the active index cannot stop the recreate
   *  a missed hit would cause. */
  findLatestBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  /**
   * #3495: the same read, THROWING on a read error, for the one caller to whom "not
   * there" and "could not tell" must differ: the read back after a save whose answer
   * was lost, where null tells the lead their booking failed.
   */
  readBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  /**
   * #1341: write a lead's corrected phone onto their booking. Scoped to the one
   * field on purpose, so a manage-token edit can never reach anything else on
   * the row. Throws on a write failure, because a save the lead is told landed
   * and which did not is the exact defect this control exists to avoid (L12).
   */
  updateBookingPhone(bookingId: string, phone: string): Promise<void>;
  /** The lead's own details on the booking row, in one write (#2164). */
  updateBookingContact(
    bookingId: string,
    patch: {
      attendee_name?: string;
      /** #2549: travels with `attendee_name`, and null clears a stale one. */
      attendee_first_name?: string | null;
      attendee_email?: string;
      attendee_phone?: string;
    },
  ): Promise<void>;
  /**
   * #3495: a fresh booking's save after its calendar event, in ONE call
   * (`commit_fresh_booking`). Throws `CommitRefusedError` when Postgres refused, which
   * wrote nothing; any other throw may have committed.
   */
  commitFreshBooking(input: CommitFreshInput): Promise<CommitFreshResult>;
  /** One write for many blocks (#762). The reconcile-missing sweep can re-create up
   *  to RECONCILE_LIMIT rows, and a write per row was that many serial round-trips
   *  on the shared every-minute invocation. The create/reschedule paths do NOT use
   *  this: they go through moveBusyBlock, which is idempotent per booking. */
  insertBusyBlocks(blocks: BusyBlockInsert[]): Promise<void>;
  /**
   * Atomically move a booking's slate busy_block to a new slot (#429 P3): delete
   * by booking_id + insert, in ONE statement, so a crash between can't leave the
   * slot momentarily free (re-opening the double-book window the reschedule path
   * closed). Used by reschedule/reassign in place of separate delete+insert.
   */
  moveBusyBlock(
    userId: string,
    startIso: string,
    endIso: string,
    bookingId: string,
  ): Promise<void>;
  /**
   * Atomic reassign swap (#449): under a row lock, set the booking to the new
   * agent + event + trace and RETURN the event being replaced (so the caller
   * deletes exactly that, never a stale one) — closing the concurrent-distinct-
   * reassign double-event race with last-write-wins. `updated` is false when the
   * booking is terminal (cancelled/completed), so the caller cleans up the event
   * it optimistically created.
   */
  /**
   * Atomic swap: moves the booking to the new agent/event AND stamps the intent row
   * with the event this swap replaced plus `swapped_at`, in ONE transaction (#759).
   * The stamp used to be a separate write right after this call, which a crash could
   * land in front of: that lost the old event id (orphan never cleaned) and left a
   * committed swap looking never-adopted, which the sweep alerts on as a lost
   * reassign (#758). Same transaction, so it commits with the swap or not at all.
   */
  reassignSwap(args: {
    bookingId: string;
    userId: string;
    agentName: string | null;
    agentEmail: string;
    gcalEventId: string;
    /** Which intent row to stamp. Passed explicitly rather than assumed equal to
     *  `gcalEventId` (it is today) so the stamp can never silently match zero rows. */
    gcalClientId: string;
    // The base trace, used ONLY to seed the row's trace when it has none yet.
    // When the row has a trace, the swap appends the reassignment record onto the
    // row's own current history server-side under the lock (#519), so this array
    // is NOT the authoritative source of the reassignments list.
    routingTrace: RoutingTrace;
    /** #3249: a reroute move. Present, the bucket aware swap runs and consumes the
     *  claimed hold in the same transaction; absent, the plain reassign. */
    reroute?: RerouteSwapArgs;
    /** #1677: the state the caller verified. Present, the swap refuses with
     *  `booking_moved` under its row lock when the booking no longer has it
     *  (migration 0196); absent, it checks nothing. */
    expect?: ReassignExpectation;
  }): Promise<{
    prevGcalEventId: string | null;
    prevAgentEmail: string | null;
    updated: boolean;
    /** Only the bucket aware form answers it: null on success, else why it wrote nothing. */
    refused?: RerouteSwapRefusal | null;
  }>;
  deleteBusyBlocksForBooking(bookingId: string): Promise<void>;
  /**
   * Delete any source=gcal busy_block mirroring this Slate-created event (#586).
   * A push-sync that raced the booking's create (before it committed) could have
   * cached the event as a source=gcal block; once the booking owns the event id,
   * that mirror is a stray duplicate. Keyed by (user_id, gcal_event_id); the
   * booking's own source=slate block has a null gcal_event_id, so it is untouched.
   */
  deleteGcalMirrorBlock(userId: string, gcalEventId: string): Promise<void>;
  /**
   * Reconcile sweep (#428): candidate busy_blocks to check for a stuck slot.
   * The real impl returns only upcoming `slate`-sourced rows (a past block can't
   * block a bookable future slot, and `gcal` mirrors are never freed here), so
   * the scan stays bounded by concurrent future bookings.
   */
  loadReconcilableBusyBlocks(
    limit: number,
    offset?: number,
  ): Promise<
    Pick<
      BusyBlock,
      "id" | "user_id" | "booking_id" | "source" | "ooo_request_id"
    >[]
  >;
  /**
   * Of these `ooo_requests` ids, the ones still APPROVED (#1464). A block owned by
   * a live approval is protecting that window and must survive the sweep; one whose
   * request was cancelled, rejected, or deleted is owned by nothing and is freed
   * exactly like any other orphan, so a missed OOO cancel still self-heals.
   */
  loadApprovedOooRequestIds(requestIds: string[]): Promise<Set<string>>;
  /** Status of each booking by id (absent from the map = the booking is gone). */
  loadBookingStatuses(bookingIds: string[]): Promise<Map<string, BookingStatus>>;
  /**
   * Of these bookings, the ones whose CANCEL is still being delivered (a `pending`
   * cancel row in the outbox). Their busy_block is queued for deletion by a step
   * that simply has not run yet, so they are mid-flight, not damaged (#784).
   */
  loadInflightCancelBookingIds(bookingIds: string[]): Promise<Set<string>>;
  /** Delete busy_blocks by id (the reconcile sweep's targeted cleanup). */
  deleteBusyBlocksByIds(ids: string[]): Promise<void>;
  /**
   * Reconcile-missing sweep (#431): active upcoming bookings whose busy_block
   * write-through may have been missed. Returns the agent + window + bucket
   * code needed to re-create the block and recompute the slot.
   */
  loadActiveUpcomingBookings(limit: number, offset?: number): Promise<ActiveUpcomingBooking[]>;
  /**
   * Which of `bookingIds` already have a slate busy_block. The reconcile-missing
   * sweep re-creates a block only for the ids NOT in this set.
   */
  loadBusyBlockBookingIds(bookingIds: string[]): Promise<Set<string>>;
  /**
   * Of `bookingIds`, which are STILL active (confirmed/rescheduled, upcoming, in
   * pool), re-read immediately before re-creating their blocks (#3585). A
   * cancellation landing between the booking read and the block read makes an active
   * booking look like a missed write-through; this closes that window. Same active
   * predicate as `loadActiveUpcomingBookings`, minus the create grace (which cannot
   * change in the interval).
   */
  loadStillActiveBookingIds(bookingIds: string[]): Promise<Set<string>>;
  // --- Outbox (#429 P2): durable intent + idempotent drain ---
  /** Write a durable mutation-intent row; returns its id. */
  enqueueOutbox(row: BookingOutboxInsert): Promise<string>;
  /** Undelivered rows whose lease is free or expired, for the drain. */
  loadDrainableOutbox(limit: number): Promise<BookingOutbox[]>;
  /** Gated claim of one row (set lease_until only if free/expired). Returns the
   *  lease TOKEN this call wrote, which every later write on the row is gated on,
   *  or null when somebody else holds it (#1048). */
  leaseOutbox(id: string): Promise<string | null>;
  /** Persist the row's steps array after a transition. A whole-array write, so it
   *  is gated on the caller's own lease: two live holders would otherwise overwrite
   *  each other's progress. Reports which of the three things happened. */
  saveOutboxSteps(
    id: string,
    steps: OutboxStep[],
    lease: string,
  ): Promise<OutboxWriteOutcome>;
  /** Flip the row to delivered once all its steps are done, gated on the lease. */
  markOutboxDelivered(id: string, lease: string): Promise<OutboxWriteOutcome>;
  /** Clear the lease so the row is reclaimable (run in a finally), gated on the
   *  token this holder wrote so it can never release a lease it has lost. */
  releaseOutboxLease(id: string, lease: string): Promise<void>;
  /** Record a failed drain pass (#445): bump attempts, store last_error, and set
   *  next_attempt_at to now + exponential backoff so the row isn't re-attempted
   *  until then. */
  bumpOutboxAttempt(id: string, attempts: number, lastError: string): Promise<void>;
  // --- Create reservations (#429 P4): intent-first crash-safe create ---
  /** Insert the reservation, OR — if another create with the same idempotency_key
   *  already won the UNIQUE race — return THAT existing reservation, so the loser
   *  adopts the winner's pinned agent + client id (never creating a 2nd event). */
  insertReservation(row: BookingReservationInsert): Promise<BookingReservation>;
  /** The reservation for an idempotency_key, or null (re-submit resume lookup). */
  loadReservationByKey(idempotencyKey: string): Promise<BookingReservation | null>;
  /** Delete a reservation (delete-on-deliver, once the booking is persisted, and the
   *  rollback of a lost attempt). THROWS when the database refuses the delete
   *  (#3859); answers `gone` when no row had that id, which a holder of the same
   *  reservation can have caused by removing it first. */
  deleteReservation(id: string): Promise<ReservationDeleteOutcome>;
  /**
   * #3217: point a PENDING reservation at the fresh event id its create is about
   * to write past a cancelled tombstone, BEFORE the write, so the deletion drain
   * holds that event and a resume adopts it. Guarded on the id it still names, so
   * it can never repoint a reservation another holder already moved or finished.
   * THROWS when the write fails or matches no row, which stops the insert.
   */
  repinReservationEvent(id: string, fromClientId: string, toClientId: string): Promise<void>;
  /** Pending reservations whose lease is free/expired, for the drain, and old
   *  enough that no live confirm can still be completing one (#3466). THROWS on a
   *  failed read: an empty list is what a quiet table returns, so it may never
   *  stand in for one that could not be read. */
  loadDrainableReservations(limit: number): Promise<BookingReservation[]>;
  /** Gated lease claim: the token if THIS call took it, null when another holder
   *  has it (drain vs inline guard). */
  leaseReservation(id: string): Promise<string | null>;
  /** Release only while the row still holds `lease` (#3169), so a drain that
   *  overran never frees the lease a newer holder took. */
  releaseReservationLease(id: string, lease: string): Promise<void>;
  /** Record a failed reservation-drain pass (#445): bump attempts, store
   *  last_error, set next_attempt_at to now + exponential backoff. */
  bumpReservationAttempt(id: string, attempts: number, lastError: string): Promise<void>;
  /** Retention: delete up to `limit` pending reservations older than the cutoff
   *  whose booking never committed, and KEEP those whose booking committed with
   *  booking.created still owed, answering their ids as `owed` (#3847). THROWS on
   *  any failed read or refused delete, deleting nothing it could not judge. */
  deleteExpiredReservations(olderThanIso: string, limit: number): Promise<RetentionSweep>;
  /**
   * Gated reschedule commit (#615). Applies the move ONLY while the booking is
   * still the one we started moving: status still active AND assignee + gcal
   * event id unchanged since we read them. Answers the id of the outbox row the
   * same transaction wrote when THIS call applied the move (#3265), or null when
   * the guard matched nothing. A concurrent cancel (flips status) or reassign
   * (swaps assignee + event id) answers null, so the reschedule can roll back
   * instead of resurrecting a cancelled booking or clobbering the reassign. A
   * refused call throws as a write failure and is never read as null (#2373).
   */
  commitReschedule(
    bookingId: string,
    patch: BookingUpdate,
    guard: { assignedUserId: string | null; gcalEventId: string | null },
    /**
     * #3265: the move's outbox work, written in the SAME transaction as the move
     * (migration 0171), so a committed reschedule always has a durable record of its
     * slot move and rescheduled webhook.
     */
    outbox: { steps: OutboxStep[]; payload: OutboxPayload },
  ): Promise<string | null>;
  /**
   * Atomic cancel claim (#413): conditionally flips a booking active->cancelled in
   * one statement, returning true only if THIS call made the transition. A second
   * concurrent cancel that already lost the claim gets false, so the non-idempotent
   * direct API can 404 it and the side effects (gcal delete, history, webhook) fire
   * exactly once. Same gated-update pattern as `completeBookingsIfDue`.
   */
  claimCancellation(bookingId: string): Promise<boolean>;
  /**
   * Batch-flips finished bookings to `completed`, returning the ids THIS call
   * actually transitioned. The update is gated on each row still being in a
   * completable status, so a row an overlapping cron tick already completed is
   * not counted twice (#163). One statement for the
   * whole batch instead of a round-trip per booking (#164).
   */
  completeBookingsIfDue(bookingIds: string[]): Promise<string[]>;
  /**
   * Claim the per-booking reschedule lease (#439, migration 0053). One lease per
   * booking: the discriminated outcome tells the caller whether it won a fresh
   * attempt, is resuming a crashed holder's pin, must conflict, or no-ops. See
   * `RescheduleClaim`. Fails CLOSED (throws a retriable error) on an unexpected
   * DB error, so a claim we can't trust never re-opens the concurrent window.
   */
  claimReschedule(bookingId: string, targetStartIso: string): Promise<RescheduleClaim>;
  /** Persist the pin onto the booking's lease row BEFORE the Google call, so a
   *  crash-resume reuses the same agent + branch + deterministic event id. */
  writeReschedulePin(bookingId: string, pin: ReschedulePin): Promise<void>;
  /** Read the current lease pin for a booking, or null. */
  readReschedulePin(bookingId: string): Promise<ReschedulePin | null>;
  /** Release the per-booking lease (keyed on booking_id alone now). */
  releaseReschedule(bookingId: string): Promise<void>;
  /** Atomically release the per-booking lease ONLY if its target still matches
   *  `targetStartIso`: a single conditional delete (booking_id AND target), so a
   *  concurrent different-target holder's fresh lease is never clobbered by
   *  Guard-1's commit-then-crash cleanup (#480, closes the read->delete window). */
  releaseRescheduleIfTarget(bookingId: string, targetStartIso: string): Promise<void>;
  /** Lease-pins past `lease_until + graceMs`, each with the booking's live
   *  gcal_event_id, for the abandoned-pin GC sweep (#439). */
  loadAbandonedReschedulePins(graceMs: number): Promise<AbandonedReschedulePin[]>;
  /**
   * #3924: take an abandoned pin's lock over for the sweep. A compare and swap on the
   * row still naming this pin's event and still past its lease plus `graceMs`, which
   * re-leases it, so a reschedule or the moved invite handler arriving meanwhile
   * finds it held, and of two sweeps only one acts. It also points the row's target
   * at the booking's own time, so a lead re-sending the abandoned move is answered
   * "just changed" rather than "done" while the sweep is undoing it. A token, or null
   * when somebody else holds the row now. THROWS on a failed write.
   */
  takeOverAbandonedReschedulePin(pin: AbandonedReschedulePin, graceMs: number): Promise<string | null>;
  /** #3924: free the lock the sweep took over, only while its token still holds it. Never throws. */
  releaseAbandonedReschedulePin(bookingId: string, token: string): Promise<void>;
  /** #3924: the booking's status, time and invite now, or null when it is gone. THROWS on a failed read. */
  readBookingInviteState(bookingId: string): Promise<BookingInviteState | null>;
  /** #3924: the invite now, on the advisor's primary calendar, or null when gone. THROWS when unreadable. */
  readEventOnPrimary(email: string, eventId: string): Promise<GoogleEvent | null>;
  /**
   * Record a crash-safe standalone-reassign intent (#518) BEFORE the Google
   * create, so a crash between the create and the swap is cleaned by the sweep.
   * Idempotent on (booking_id, gcal_client_id): a same-target retry (identical
   * deterministic id) refreshes the lease instead of failing, preserving #449's
   * idempotent-retry behavior.
   */
  writeReassignIntent(args: {
    bookingId: string;
    pinnedAgentEmail: string;
    gcalClientId: string;
  }): Promise<void>;
  /** Delete the reassign intent once the create+swap+delete-old completed (#518). */
  deleteReassignIntent(bookingId: string, gcalClientId: string): Promise<void>;
  /** Reassign intents past `lease_until + graceMs`, each with the booking's live
   *  gcal_event_id, for the abandoned-reassign-intent GC sweep (#518). */
  loadAbandonedReassignIntents(graceMs: number): Promise<AbandonedReassignIntent[]>;
  /** Append a reschedule/cancel/reassign history row (#326/#300). */
  /** Append a history row; returns the new row id (or null if the best-effort
   *  insert failed) so the caller can use it as the webhook dedupe key (#436). */
  insertBookingEvent(row: BookingEventInsert): Promise<string | null>;
  /**
   * Whether a history row already exists for this (booking, action, target).
   * Lets the no-op / re-cancel guards record a reason that a partially-failed
   * first attempt never persisted, without double-recording on a true duplicate
   * (#326). `toStartsIso` is null for cancel (one cancel per booking).
   */
  hasBookingEvent(
    bookingId: string,
    action: BookingEventAction,
    toStartsIso: string | null,
    rescheduleSeq?: number | null,
  ): Promise<boolean>;
  /** The id of an existing history row for (booking, action, target), or null.
   *  Lets the idempotent outbox notify step reuse the same webhook dedupe key on
   *  a drain re-run instead of inserting a duplicate history row (#429 P3).
   *  `rescheduleSeq` (#614) further scopes the match to one reschedule generation,
   *  so an oscillation back to a previously-used `toStartsIso` doesn't reuse the
   *  earlier reschedule's row (which would swallow its webhook). Omit for cancel/
   *  reassign, which don't collide on time. */
  getBookingEventId(
    bookingId: string,
    action: BookingEventAction,
    toStartsIso: string | null,
    rescheduleSeq?: number | null,
  ): Promise<string | null>;
  /**
   * `withWorkingHours` (#538) batches the assigned agent's working-hours read into
   * the same round-trip as bucket + event type, so the reschedule in-place guard
   * reads `ctx.agentWorkingHours` instead of a separate `agentWorkingHours` call.
   */
  loadBookingContext(
    token: string,
    opts?: { withWorkingHours?: boolean },
  ): Promise<BookingContext | null>;
  loadBookingById(bookingId: string): Promise<BookingContext | null>;
  /**
   * Active bookings that may belong to this person, for the direct booking API's
   * "one active appointment per person" dedupe (#357). The real impl matches on
   * external_id / salesforce_id / attendee email / attendee phone across active
   * rows; `findPersonMatch` then grades each candidate's confidence.
   */
  /** Scoped to one WORLD (#2660): the test bookings or the real ones, never both. */
  findActiveBookingsForPerson(identity: PersonIdentity, world: PersonWorld): Promise<Booking[]>;
  /**
   * #3739: earlier bookings in ANY status that carry a lead id and hold BOTH this
   * email and this phone, in one world, for an advisor link confirm whose link
   * carried no Lead id. Throws on a failed read; the confirm books without an id.
   */
  earlierLeadBookings(
    contact: { email: string; phone: string },
    world: NamedWorld,
  ): Promise<EarlierLeadBookingRow[]>;
  /**
   * Active bookings whose `external_id` OR `salesforce_id` is any of `ids`, for
   * the lookup API (#2657). Separate from the dedupe fetch above on purpose: that
   * one matches each id to its own column, and an embed booking holds the lead's
   * id in `salesforce_id` only, so a caller sending it as `externalId` could
   * never find it there. `lookupStrongIds` builds the set; the result is judged
   * again by `bookingMatchesLookupIds` before anything is returned.
   */
  /** Each row carries its bucket's world (#2660), read at the fetch, so the
   *  lookup view can say whether a booking is a test one. */
  findActiveBookingsByStrongIds(ids: readonly string[]): Promise<BookingWithWorld[]>;
  /**
   * The display name of the agent a booking is assigned to, read LIVE (#1337,
   * #1338). Null when the id is null or resolves to nothing, so a caller shows
   * no name rather than a stale or borrowed one: coverage reassignment and bulk
   * reassign both move a booking to a different agent, so a name captured at
   * booking time would promise a lead one person and send another (L75).
   */
  loadAgentDisplayName(userId: string | null): Promise<string | null>;
  /** #392 list: filtered, ordered, offset-paginated booking page + the buckets
   *  referenced by that page (for bucketCode), resolved in one .in() query. */
  queryBookings(filter: ListFilter): Promise<{ rows: Booking[]; buckets: Bucket[] }>;
  getAgentByEmail(email: string): Promise<User | null>;
  /** Ids of finished bookings still marked active, at most one batch. Ids only:
   *  marking a row completed needs nothing else about it (#2915). */
  loadPastBookingIdsToComplete(): Promise<string[]>;
  // webhooks + misc
  /** `suppressed` records the delivery but skips the external POST (#459: an
   *  is_test bucket's booking must never reach Regal/Cadence). `deferSend` (#884)
   *  hands the outbound POST to a scheduler (Next after()) instead of awaiting it;
   *  fire() passes `deps.deferSend`, so it is set only on user-facing requests. */
  emitWebhook(
    orgId: string,
    event: WebhookEvent,
    payload: BookingEventPayload,
    dedupeKey: string | null,
    suppressed: boolean,
    deferSend?: WebhookSendScheduler,
  ): Promise<void>;
  /** #884: when set (user-facing requests only), `fire()` routes the webhook's
   *  outbound POST through this scheduler so the response isn't blocked on the
   *  Regal/Cadence round-trip. The cron drains leave it unset and send inline,
   *  so their bounded fan-out still caps simultaneous connections. */
  deferSend?: WebhookSendScheduler;
  /** #3266: when set (a lead's request only), a page raised after the booking
   *  committed is sent after the response, outside the confirm's budget, so the
   *  lead's answer never waits on Slack (`pageAfterAnswer`). The cron drains leave
   *  it unset and send the page inline, as they always did. */
  deferPage?: PageScheduler;
  newManageToken(): string;
  /** #3495: a fresh booking's id, minted before its save because the webhook built
   *  for it names the booking and its dedupe key IS the id. */
  newBookingId(): string;
  /** A fresh, unique synthetic idempotency key for a keyless (anonymous) booking
   *  (#666), so it still gets the reservation-backed crash-safe create every keyed
   *  booking has. Random per call: there's no stable identity to dedupe on, so it
   *  provides no cross-request collapse (matching the old anonymous behavior), only
   *  the durable net. Distinct, non-colliding shape (e.g. an "anon_"-prefixed token)
   *  so it can never equal a derived bucket|slot|contact key. */
  newIdempotencyKey(): string;
  appBaseUrl(): string;
  /**
   * Best-effort clear of a bucket's cached availability after a booking changes it.
   * A create passes the booked advisor and window (#3324), once its busy block has
   * committed, so the time can be spliced out of every pool that advisor serves. A
   * reschedule or reassign also passes the window the booking LEFT (`freed`, #3334),
   * which goes back on offer in every pool the old advisor serves. The cancel step
   * passes none and refreshes the code's pool.
   */
  invalidateSlots(bucketCode: string, booked?: BookedWindow & { freed?: BookedWindow }): Promise<void>;
  /**
   * Persist one routing decision to the decision log and fire a misroute alert if
   * warranted (#504). Injected (rather than called as a module function) so tests
   * can assert the orchestration records the expected outcome + payload directly,
   * instead of inferring it from a swallowed-error log line. Best-effort in the
   * live impl; every call site already wraps it in its own try/catch so a decision
   * -log failure never affects the booking.
   */
  recordRoutingDecision(input: RecordRoutingDecisionInput): Promise<void>;
  /**
   * #3797: judge a `candidate_read_empty` refusal against the list the lead picked
   * from: read its pools' stored rows (the row proofs this refusal leaves) and, when
   * the confirm carried that list's `computed_at`, the busy time over the requested
   * window and the row proofs before it (`offer-race.ts`). Called as the refusal is
   * recorded, so the verdict lands on its routing decision and on the trace the route
   * tallies from. THROWS on a failed read; the caller then records the verdict as
   * `unknown`, which counts exactly as a refusal did before. Optional: deps without it
   * judge nothing.
   */
  judgeRefusedOffer?(input: {
    trace: RefusalTrace;
    servedComputedAt: string | null;
    eventType: Pick<EventType, "duration_min" | "buffer_before_min" | "buffer_after_min">;
  }): Promise<{
    verdict: OfferVerdict | null;
    staleRowCodes: string[];
    storedRows?: { bucket_code: string; payload: unknown; computed_at: string }[];
  }>;
  /**
   * The bucket's raw pool (its org agents, manual members and criteria), for the
   * routing decision's considered and excluded lists. Injected rather than imported
   * (#3272), so the refusal record a test drives is the one production writes; an
   * imported read cannot run under the node suite and left that record untested.
   */
  resolveBucketPool(bucket: Bucket): Promise<Parameters<typeof buildRoutingTraceExtras>[0]>;
  /**
   * The tier the availability cache CURRENTLY displays for a bucket code, or null
   * (#827). Read once on a fresh confirm whose caller did not hand back the tier it
   * had on show (`CreateBookingInput.shownTier`, #3495), before write-through mutates the cache,
   * so createBooking can measure when verify-on-book dropped a further rung
   * between what the booker showed and what it actually booked. Best-effort: a
   * read error or a hidden test bucket returns null and simply skips the measure.
   */
  displayedTier(bucketCode: string): Promise<string | null>;
}

/** Alert once a queued deletion has failed this many times. */
export const PENDING_DELETION_ALERT_AFTER = 5;

/** Stop retrying a deletion after this many attempts (it stays in the table,
 *  diagnosable via last_error, and already alerted at PENDING_DELETION_ALERT_AFTER). */
export const PENDING_DELETION_GIVE_UP_AT = 50;

/** A queued deletion the drain has stopped retrying because Google refused the
 *  calendar for good (#2577). `kind` is the classification the refusal was ended
 *  on; the copy treats anything that is not `not-provisioned` as an account that is
 *  gone, matching #916's conservative default for an unclassified kind. */
export interface RefusedEventDeletion {
  row: PendingEventDeletion;
  kind: FailureKind;
}

/**
 * Drain a batch of the deletion retry queue (#401): re-attempt each delete;
 * remove on success (404/410 already-gone counts as success); on a TRANSIENT
 * failure bump the attempt count and report rows that crossed the alert threshold
 * as `stuck`. Pure: the caller (self-heal lane) sends the throttled alerts.
 *
 * A failure `isDefinitiveFailure` (never a literal `kind === "gone"`, see AGENTS.md
 * "Three ways a Google calendar can fail, not two") ends the row on THIS pass
 * (#2577): its attempts are written straight to PENDING_DELETION_GIVE_UP_AT, which
 * `loadPendingEventDeletions` excludes, so the delete is never retried, and the
 * row is reported in `refused` with its kind rather than in `stuck`. The row STAYS
 * in the table: it is the only record that an event is orphaned on a calendar
 * nobody can reach, and `last_error` names the kind so the record says why. It is
 * not `stuck`, because that alert's copy sends the reader to check Google API
 * health, and no amount of health fixes an account that was never given Calendar.
 * A refused row still counts in `failed`: the saturation reporter reads
 * deleted + failed + held as the size of the page this pass loaded (#888).
 *
 * `held` counts the rows whose event somebody now holds (#3215, L744), which are
 * never deleted: one a live booking holds is dropped as obsolete, and one a
 * write still in flight pins (a pending create reservation, a standing reschedule
 * lock or a reassign intent, #3217) is left for a later pass.
 *
 * Once Google refuses a calendar for good, every other row for that calendar would
 * spend a Google call only to reach the same answer (#1630), and each pass alerted
 * on its own refusals, so the page about one departed advisor named 1 of their 4
 * invites. So the rest of that calendar's rows settle in the SAME pass with no
 * Google call: the rest of this page first, then up to `siblingLimit` more read
 * past it (`beyondPage`). Each still goes through the holder check first, so a row
 * a live booking holds is dropped as before rather than recorded as orphaned, and
 * each is settled exactly as a refused row is (at the give-up count, kept as the
 * record), with a `last_error` that says it was not itself tried. Rows past the
 * page appear in `refused` and `stuck` but never in `deleted`, `failed` or `held`,
 * which stay the size of the page this pass loaded.
 */
export async function processPendingEventDeletions(
  deps: BookingDeps,
  limit: number,
  opts: { siblingLimit?: number } = {},
): Promise<{
  deleted: number;
  failed: number;
  held: number;
  stuck: PendingEventDeletion[];
  refused: RefusedEventDeletion[];
  /** #1630: rows of a refused calendar read and settled past this page. */
  beyondPage: number;
}> {
  const rows = await deps.loadPendingEventDeletions(limit);
  // This pass's calendars Google has refused for good, with the kind it ended on.
  const refusedCalendars = new Map<string, FailureKind>();
  let deleted = 0;
  let failed = 0;
  let held = 0;
  const stuck: PendingEventDeletion[] = [];
  const refused: RefusedEventDeletion[] = [];
  for (const row of rows) {
    const outcome = await drainPendingDeletion(deps, row, refusedCalendars);
    if (outcome.kind === "deleted") deleted++;
    else if (outcome.kind === "held") held++;
    else if (outcome.kind === "refused") {
      failed++;
      refused.push({ row, kind: outcome.refusal });
    } else {
      failed++;
      if (outcome.stuck) stuck.push(row);
    }
  }

  // #1630: the rest of each refused calendar's queue, past this page.
  let beyondPage = 0;
  let budget = opts.siblingLimit ?? PENDING_DELETION_SIBLING_LIMIT;
  const seen = new Set(rows.map((r) => r.id));
  for (const email of [...refusedCalendars.keys()]) {
    if (budget <= 0) break;
    let more: PendingEventDeletion[];
    try {
      // Asked for enough to see past this page's own rows of the calendar that are
      // still pending (held, or a blip before the refusal), which are skipped.
      const pageRows = rows.filter((r) => r.calendar_email === email).length;
      more = await deps.loadPendingEventDeletionsForCalendar(email, budget + pageRows);
    } catch (err) {
      // Those rows keep their place in the queue and each meets the refusal on a
      // later pass, as before #1630; this pass's own result is unaffected.
      log.warn(
        "booking",
        { msg: "could not read a refused calendar's other queued deletions; left for a later pass", calendar_email: email },
        err,
      );
      continue;
    }
    for (const row of more) {
      if (budget <= 0) break;
      // Only rows of this calendar, so no row read here can reach a Google call.
      if (seen.has(row.id) || row.calendar_email !== email) continue;
      seen.add(row.id);
      budget--;
      beyondPage++;
      const outcome = await drainPendingDeletion(deps, row, refusedCalendars);
      if (outcome.kind === "refused") refused.push({ row, kind: outcome.refusal });
      else if (outcome.kind === "failed" && outcome.stuck) stuck.push(row);
    }
  }
  return { deleted, failed, held, stuck, refused, beyondPage };
}

/**
 * How many rows of refused calendars one drain pass settles past its page (#1630).
 * They cost no Google call, only the holder reads and one write each (about five
 * database subrequests a row), so this is looser than the page, whose rows each
 * cost a Google call. It exists so one pass stays bounded: a departed advisor's
 * queue is their upcoming calls, and any left over meet the same rule next pass.
 */
export const PENDING_DELETION_SIBLING_LIMIT = 50;

/** What happened to one queued deletion in a drain pass. */
type PendingDeletionOutcome =
  | { kind: "deleted" }
  | { kind: "held" }
  | { kind: "failed"; stuck: boolean }
  | { kind: "refused"; refusal: FailureKind };

/**
 * One queued deletion, as the drain handles it (#401, #2577, #3215, #1630). Shared
 * by the page and by the rows read past it, so a row is judged the same way
 * whichever read found it. `refusedCalendars` is this pass's record of calendars
 * Google has refused for good: a row on one of them settles without a Google call,
 * and a fresh refusal is added to it.
 */
async function drainPendingDeletion(
  deps: BookingDeps,
  row: PendingEventDeletion,
  refusedCalendars: Map<string, FailureKind>,
): Promise<PendingDeletionOutcome> {
  // #3215 (L744): ask who holds the event BEFORE deleting it. The id is derived
  // from the request, so a lead's retry adopts the event the failed attempt
  // queued here, and deleting it leaves a confirmed booking with nothing on the
  // agent's calendar. A failed read is a transient failure of this row, never a
  // delete, and never a Google refusal (it is not Google's answer).
  let holder: Awaited<ReturnType<typeof queuedEventHolder>>;
  try {
    holder = await queuedEventHolder(deps, row.gcal_event_id);
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    await deps.bumpPendingEventDeletion(row.id, attempts, `could not read who holds the event: ${message}`);
    return { kind: "failed", stuck: attempts >= PENDING_DELETION_ALERT_AFTER };
  }
  if (holder?.kind === "booking") {
    // The deletion is obsolete, not failed: the row goes, and the log line is
    // the record of why an event it asked to delete is still there.
    log.info("booking", {
      msg: "queued event deletion dropped: a live booking holds the event",
      pending_deletion_id: row.id,
      booking_id: row.booking_id,
      holder_booking_id: holder.bookingId,
      gcal_event_id: row.gcal_event_id,
    });
    await deps.removePendingEventDeletion(row.id);
    return { kind: "held" };
  }
  if (holder?.kind === "pending") {
    // A write still in flight pins it (a pending create reservation, a standing
    // reschedule lock or a reassign intent, #3217), so a resume may yet adopt it.
    // Kept for a later pass: once the reservation completes the row is dropped
    // above, and once it expires the event is deleted below. Touched rather than
    // left alone, because the loader takes the least recently touched rows
    // first: an untouched held row would sit at the front of every page, and
    // enough of them would starve every deletable row behind them. Attempts are
    // unchanged, since holding is not failing and must not walk the row toward
    // the stuck alert or the give up.
    await deps.bumpPendingEventDeletion(
      row.id,
      row.attempts,
      "held: a write still in flight pins this event, so a resume may adopt it",
    );
    return { kind: "held" };
  }
  const known = refusedCalendars.get(row.calendar_email);
  if (known) {
    // #1630: Google refused this calendar for good earlier in this pass and would
    // answer this row the same way, so it is settled as that row was, without a
    // call of its own. Its last_error says it was not tried, so the record claims
    // only what was measured (L11).
    await deps.bumpPendingEventDeletion(
      row.id,
      PENDING_DELETION_GIVE_UP_AT,
      `${known}: not attempted, Google refused this calendar for good earlier in the same drain pass`,
    );
    return { kind: "refused", refusal: known };
  }
  try {
    await deps.deleteEvent(row.calendar_email, row.gcal_event_id);
    await deps.removePendingEventDeletion(row.id);
    return { kind: "deleted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = reachabilityFromError(err);
    if (isDefinitiveFailure(kind)) {
      await deps.bumpPendingEventDeletion(row.id, PENDING_DELETION_GIVE_UP_AT, `${kind}: ${message}`);
      refusedCalendars.set(row.calendar_email, kind);
      return { kind: "refused", refusal: kind };
    }
    const attempts = row.attempts + 1;
    await deps.bumpPendingEventDeletion(row.id, attempts, message);
    return { kind: "failed", stuck: attempts >= PENDING_DELETION_ALERT_AFTER };
  }
}

/** Who each refused calendar belongs to, and where a departed owner's calls went (#1630). */
export interface RefusedDeletionFacts {
  /** One per refused row, in order, with `movedToAnotherAdvisor` set on a departed owner's rows. */
  rows: RefusedDeletionForAlert[];
  /** Keyed by normalised address (#1663); null when the owners could not be read. */
  owners: Map<string, CalendarOwnerForAlert> | null;
}

/**
 * What the refusal copy needs about each refused calendar's owner (#1630).
 *
 * Never throws. A failed owner read returns `owners: null`, which the copy turns
 * into today's page: a departure may be claimed only where it was read (L11), and
 * an empty map would claim nobody had left. An address two users answer to names
 * nobody (L521) and falls to the page too. The calls are looked up only for owners
 * who have left; a failed read of them keeps the departure and claims no move.
 */
export async function describeRefusedDeletions(
  deps: BookingDeps,
  refused: RefusedEventDeletion[],
): Promise<RefusedDeletionFacts> {
  const rows: RefusedDeletionForAlert[] = refused.map((r) => ({
    calendarEmail: r.row.calendar_email,
    eventId: String(r.row.gcal_event_id),
    kind: r.kind,
  }));
  if (refused.length === 0) return { rows, owners: new Map() };
  const emails = [...new Set(refused.map((r) => normalizeEmail(r.row.calendar_email)))];
  let users: Awaited<ReturnType<BookingDeps["loadCalendarOwners"]>>;
  try {
    users = await deps.loadCalendarOwners(emails);
  } catch (err) {
    log.warn("booking", { msg: "could not read who owns the refused calendars; worded as for an active account" }, err);
    return { rows, owners: null };
  }
  const matches = new Map<string, typeof users>();
  for (const u of users) {
    const key = normalizeEmail(u.email);
    matches.set(key, [...(matches.get(key) ?? []), u]);
  }
  const owners = new Map<string, CalendarOwnerForAlert>();
  const ownerIds = new Map<string, string>();
  for (const [email, found] of matches) {
    if (found.length !== 1) {
      log.warn("booking", { msg: "a refused calendar's address matches more than one user; no owner named", calendar_email: email, matches: found.length });
      continue;
    }
    owners.set(email, { name: found[0].name, deactivatedAt: found[0].deactivated_at });
    ownerIds.set(email, found[0].id);
  }

  const departedAt = (r: RefusedEventDeletion) => owners.get(normalizeEmail(r.row.calendar_email))?.deactivatedAt ?? null;
  const bookingIds = [
    ...new Set(refused.filter((r) => departedAt(r) !== null && r.row.booking_id).map((r) => r.row.booking_id as string)),
  ];
  let assignees: Map<string, Pick<Booking, "id" | "assigned_user_id" | "status">> | null = new Map();
  if (bookingIds.length > 0) {
    try {
      assignees = new Map((await deps.loadBookingAssignees(bookingIds)).map((b) => [b.id, b]));
    } catch (err) {
      log.warn("booking", { msg: "could not read where a departed advisor's calls went; no move claimed" }, err);
      assignees = null;
    }
  }
  refused.forEach((r, i) => {
    if (departedAt(r) === null) return;
    const ownerId = ownerIds.get(normalizeEmail(r.row.calendar_email));
    rows[i].movedToAnotherAdvisor = assignees === null ? null : callMovedAway(r.row.booking_id, ownerId, assignees);
  });
  return { rows, owners };
}

/**
 * Whether a departed owner's call now sits, live, with somebody else (#1630). An
 * invite with no booking, a booking the read did not return, a cancelled call and a
 * call still on the owner are all NOT moved: each was measured, and none of them is
 * a call another advisor now takes.
 */
function callMovedAway(
  bookingId: string | null,
  ownerId: string | undefined,
  assignees: Map<string, Pick<Booking, "id" | "assigned_user_id" | "status">>,
): boolean {
  if (!bookingId) return false;
  const b = assignees.get(bookingId);
  if (!b) return false;
  return ACTIVE_BUSY_STATUSES.has(b.status) && b.assigned_user_id !== null && b.assigned_user_id !== ownerId;
}

/**
 * Who holds a queued event now (#3215): a live booking (the deletion is obsolete),
 * a pending create reservation (a resume may yet adopt it), or nobody. THROWS when
 * either read fails, so no caller can read a failure as nobody.
 */
async function queuedEventHolder(
  deps: BookingDeps,
  eventId: string,
): Promise<{ kind: "booking"; bookingId: string } | { kind: "pending" } | null> {
  const bookingId = await liveEventHolder(deps, eventId);
  if (bookingId) return { kind: "booking", bookingId };
  return (await deps.pendingWritePinsEvent(eventId)) ? { kind: "pending" } : null;
}

/**
 * Creation-orphan check (#830): a create that succeeded on Google but whose
 * booking never persisted (the DB insert failed AND its rollback delete also
 * failed) is enqueued with a NULL booking_id. The deletion drain retries the
 * removal, but only alerts after it gives up (5+ attempts), so a stray event can
 * sit on the customer's calendar firing reminders for a booking Slate has no
 * record of, unnoticed until then.
 *
 * This surfaces it EARLIER and distinctly. Before alerting, it verifies each
 * orphan's event STILL EXISTS on Google, so an event the agent manually deleted
 * (a false orphan) or one the drain already removed does not cry wolf. An
 * existence check that THROWS (a Google blip) is treated as unverified and
 * skipped this tick; the next tick re-checks and the drain's give-up alert is the
 * ultimate backstop. Pure: the caller sends the throttled alert for `confirmed`.
 */
export async function checkCreationOrphans(
  deps: BookingDeps,
  limit: number,
): Promise<{ scanned: number; confirmed: PendingEventDeletion[] }> {
  const rows = await deps.loadCreationOrphans(limit);
  const confirmed: PendingEventDeletion[] = [];
  for (const row of rows) {
    let exists: boolean;
    try {
      // #3215: an event a retry adopted, or that a pending reservation may yet
      // adopt, is not an orphan, however much it exists. Unreadable is skipped
      // like an unreadable existence check below.
      if (await queuedEventHolder(deps, row.gcal_event_id)) continue;
      exists = await deps.eventExists(row.calendar_email, row.gcal_event_id);
    } catch {
      // Couldn't confirm the event this tick; don't risk a false alert.
      continue;
    }
    if (exists) confirmed.push(row);
  }
  return { scanned: rows.length, confirmed };
}

/** Booking statuses that keep a slot legitimately busy (must NOT be freed).
 *  `rescheduled` moves in place and is still active; `completed` happened. */
const ACTIVE_BUSY_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  "confirmed",
  "rescheduled",
  "completed",
]);

/**
 * Reconcile sweep (#428): a cancel runs its steps sequentially (atomic claim,
 * gcal delete, busy_block delete, ...), so a crash or a swallowed delete BEFORE
 * the busy_block step leaves the slot silently stuck as busy. This frees the
 * stuck rows so the slot self-heals. Pure — the caller (sync lane) does the
 * bounded recompute for `userIds` and the throttled alert for `freed`.
 *
 * SAFETY: only frees `slate`-sourced rows whose booking is cancelled or gone. A
 * `gcal` mirror is NEVER freed (it tracks a real external-calendar event;
 * freeing it would reopen a slot the agent is genuinely busy on, risking a
 * double-book), and an active booking's row is kept.
 *
 * It also leaves alone a cancel that is still DELIVERING (#784). The cancel claims
 * the status flip first and deletes the block later, as an outbox step queued behind
 * a slow Google delete, so a healthy in-flight cancel is indistinguishable here from
 * a missed delete. Freeing it was harmless (the step would have deleted the row
 * anyway) but it was then reported as damage, and the caller's Slack alert told
 * whoever read it to "check cancel-path health" on a cancel path that was working.
 * Once the outbox row is delivered, a block that STILL exists is a genuine miss, and
 * this sweep is exactly what heals it.
 */
export async function reconcileCancelledBusyBlocks(
  deps: BookingDeps,
  limit: number,
  offset = 0,
): Promise<{
  freed: number;
  /** Of `freed`, the ones a cancel's write-through delete missed. */
  freedCancelled: number;
  /** Of `freed`, the ones nothing owned at all (no booking, no time off). */
  freedOrphans: number;
  userIds: string[];
  /**
   * The booking ids whose block this freed (#3585): so the alert names WHICH booking,
   * not only "across N agents", and a genuine missed write is distinguishable in the
   * log from the cancel/reconcile race rather than inferred from a point-in-time
   * snapshot. The orphans (no booking_id) are not here; they are counted separately.
   */
  freedBookingIds: string[];
  scanned: number;
}> {
  const rows = await deps.loadReconcilableBusyBlocks(limit, offset);
  const bookingIds = [
    ...new Set(
      rows
        .filter((r) => r.source === "slate" && r.booking_id !== null)
        .map((r) => r.booking_id as string),
    ),
  ];
  // #1464: the OOO fallback writes a slate row with no booking, which is the shape
  // this sweep read as an orphan. Ask which of those owners is still approved
  // before judging anything, in one batched read.
  const oooIds = [
    ...new Set(
      rows
        .filter((r) => r.source === "slate" && r.ooo_request_id !== null)
        .map((r) => r.ooo_request_id as string),
    ),
  ];
  const [statuses, inflightCancels, approvedOoo] = await Promise.all([
    bookingIds.length
      ? deps.loadBookingStatuses(bookingIds)
      : Promise.resolve(new Map<string, BookingStatus>()),
    bookingIds.length
      ? deps.loadInflightCancelBookingIds(bookingIds)
      : Promise.resolve(new Set<string>()),
    oooIds.length
      ? deps.loadApprovedOooRequestIds(oooIds)
      : Promise.resolve(new Set<string>()),
  ]);

  const stuck = rows.filter((r) => {
    if (r.source !== "slate") return false; // never free a gcal mirror
    // An approved time off owns this window: it is the only thing blocking it when
    // the agent's calendar event could not be created, so it is not an orphan.
    if (r.ooo_request_id !== null && approvedOoo.has(r.ooo_request_id)) return false;
    if (r.booking_id === null) return true; // orphan: nothing owns this slot
    // The cancel's own busy_block delete is still queued: not damage, just in flight.
    if (inflightCancels.has(r.booking_id)) return false;
    const status = statuses.get(r.booking_id);
    // Missing booking (not in the map) or an explicitly cancelled one is stuck;
    // anything still active stays busy.
    return status === undefined || !ACTIVE_BUSY_STATUSES.has(status);
  });

  if (stuck.length === 0) {
    return { freed: 0, freedCancelled: 0, freedOrphans: 0, userIds: [], freedBookingIds: [], scanned: rows.length };
  }
  await deps.deleteBusyBlocksByIds(stuck.map((r) => r.id));
  const freedCancelled = stuck.filter((r) => r.booking_id !== null).length;
  return {
    freed: stuck.length,
    freedCancelled,
    freedOrphans: stuck.length - freedCancelled,
    userIds: [...new Set(stuck.map((r) => r.user_id))],
    freedBookingIds: [...new Set(stuck.filter((r) => r.booking_id !== null).map((r) => r.booking_id as string))],
    scanned: rows.length,
  };
}

/**
 * How long a booking is left alone before the reconcile-missing sweep will heal
 * it (#778). A booking commits its row and then writes its busy_block, so for a
 * moment a perfectly healthy booking has no block. Without this window the sweep
 * scans newest-first straight into that gap, "recreates" a block that was already
 * on its way (harmless since #770's UNIQUE index, but wasted), and then reports it
 * as a missed write: recomputing buckets and firing a Slack alert for a booking
 * that was never broken.
 *
 * 60s is comfortably longer than any in-flight create, and gives the reservation
 * drain (every minute) time to resume a crashed one, so a block still missing when
 * the window closes is one that genuinely never landed. The cost is that such a
 * block leaves its slot showing free for up to a minute longer; that is bounded,
 * because verify-on-book re-checks live Google at confirm time.
 */
export const RECONCILE_MISSING_GRACE_MS = 60_000;

/** An active upcoming booking, with everything the reconcile-missing sweep
 *  needs to re-create its busy_block (#431). */
export interface ActiveUpcomingBooking {
  id: string;
  /** The assigned agent (guaranteed non-null by the loader). */
  user_id: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Reconcile-missing sweep (#431): the dangerous counterpart to #428. A missed
 * busy_block write-through INSERT leaves an active booking's slot showing FREE
 * in the embed, so it can be DOUBLE-BOOKED on the Slate side until the next full
 * sync mirrors the Google event. This re-creates the missing slate block for any
 * active upcoming booking that lacks one, then the caller recomputes the buckets.
 *
 * Safety bias: this ONLY ever INSERTS, never deletes. The failure we prevent
 * (missing block -> free slot -> double-book) is far worse than the only
 * downside of over-acting (a duplicate block just keeps the slot busy), so it is
 * safe to run aggressively. A genuinely-missing block is inserted once; the next
 * tick sees the block and skips it, so blocks don't accumulate in steady state.
 *
 * It does NOT act on two kinds of booking, both withheld by the loader. One still
 * inside its grace window (#778, RECONCILE_MISSING_GRACE_MS): a booking that is
 * merely mid-create has not missed anything, and treating it as a miss made this
 * sweep's counters and its Slack alert report far more damage than had occurred.
 * And one whose agent has left the pool (#3304, `hasLeftPool`): leaving deletes the
 * agent's blocks on purpose and the pool exit backstop deletes them again every
 * tick, so a block re-created for them was never a missed write, only a false page.
 *
 * Returns the affected agents (not buckets): a missing block makes the agent
 * look free in EVERY bucket they serve, so the caller recomputes all of each
 * agent's buckets, exactly as the #428 sweep does for freed agents.
 */
export async function reconcileMissingBusyBlocks(
  deps: BookingDeps,
  limit: number,
  offset = 0,
): Promise<{ recreated: number; bookingIds: string[]; userIds: string[]; scanned: number }> {
  const bookings = await deps.loadActiveUpcomingBookings(limit, offset);
  const empty = { recreated: 0, bookingIds: [], userIds: [], scanned: bookings.length };
  if (bookings.length === 0) return empty;

  const haveBlock = await deps.loadBusyBlockBookingIds(bookings.map((b) => b.id));
  const missing = bookings.filter((b) => !haveBlock.has(b.id));
  if (missing.length === 0) return empty;

  // #3585: re-verify the NARROW candidate set is still active immediately before
  // re-creating. The booking read and the block read above are two separate reads; a
  // cancellation landing between them deletes the block and makes an active booking
  // look like a missed write-through INSERT, so the sweep re-created a block for a
  // booking being cancelled and paged a false "missed write" (and the next tick freed
  // it and paged a false "stuck block"). Re-reading just the `missing` ids collapses
  // that window from the full two-scan gap (tens of ms to seconds under load, which an
  // ordinary cancel hit) to a single read-then-insert, which an ordinary cancel does
  // not. The insert-only safety bias is unchanged: a genuinely-missing block for a
  // still-active booking is still re-created.
  //
  // A RESIDUAL window remains, between this re-verify and the insert below: a cancel
  // landing there still re-creates one block and the next tick frees and pages about
  // it. Closing it fully needs a DB-side conditional insert (INSERT ... SELECT WHERE
  // the booking is still active), an RPC and a migration, tracked in #3592. It is left
  // there because this residual is in the SAFE direction (the stray block keeps the
  // slot busy, never a double-book) and is now MEASURABLE rather than inferred: both the
  // re-create and the free side name the booking ids, so if it ever fires the two pages
  // carry the same id a cancel is logged against, instead of a point-in-time snapshot
  // having to rule it out by hand.
  const stillActive = await deps.loadStillActiveBookingIds(missing.map((b) => b.id));
  const toRecreate = missing.filter((b) => stillActive.has(b.id));
  if (toRecreate.length === 0) return empty;

  await deps.insertBusyBlocks(
    toRecreate.map((b) => busyBlockFor(b.user_id, b.starts_at, b.ends_at, b.id)),
  );
  return {
    recreated: toRecreate.length,
    bookingIds: toRecreate.map((b) => b.id),
    userIds: [...new Set(toRecreate.map((b) => b.user_id))],
    scanned: bookings.length,
  };
}

/**
 * Verify-on-book wave size: how many round-robin candidates to confirm per
 * batched free/busy round-trip. The real verifier reads the whole wave's
 * free/busy in one (or, for multi-calendar agents, a few parallel) Google
 * call(s) and returns the free subset; `selectAgent` returns the first free
 * candidate in round-robin order, only advancing to the next wave if the whole
 * wave is busy. Sized to Google's 20-calendar freeBusy cap so a wave of
 * single-calendar agents is one round-trip (#167).
 */
const VERIFY_WAVE_SIZE = 20;

/**
 * #2281: how many further advisors a confirm that LOST the overlap race (#2274)
 * may be handed to before the lead is asked to pick another time. Each attempt
 * costs a live free check, a calendar event and its removal, all on the lead's
 * confirm tap, and a confirm losing to several racers in a row is a burst the
 * lead is better told about than kept waiting through.
 *
 * #3338: counted per CONFIRM, across every rung it walks, so walking down the
 * ladder after a lost race never resets it.
 */
export const MAX_RACE_REASSIGNS = 3;

/**
 * Why the search for the next advisor after a lost race found nobody (#3338).
 * Typed so exactly ONE of them, `rung-exhausted`, lets the confirm walk on down
 * the ladder; a refusal that merely failed to find somebody must never be read as
 * the rung having nobody (L35, L11). Asked only about a lost race
 * (`attemptReservation` answering `lost`), so there is no reason for a failure
 * that was not one: a transient insert failure keeps its own path, which leaves
 * the reservation for the drain.
 *
 *  - `named-link`: a named advisor link (#2073), which must never fall to anybody;
 *  - `not-chosen-here`: the advisor that lost was not one this confirm chose from
 *    the rung: a same key racer's pin was adopted, so choosing again under it would
 *    be a second request's decision;
 *  - `bound`: `MAX_RACE_REASSIGNS`;
 *  - `rung-exhausted`: nobody after the loser on this rung is free;
 *  - `check-failed`: the live check could not answer, by error or for any advisor.
 *    A check that cannot answer is never read as free, nor as busy;
 *  - `deadline`: the live check ran out of time (#3402), carrying the deadline.
 */
export type NoNextAdvisor = "named-link" | "not-chosen-here" | "bound" | "rung-exhausted" | "check-failed";

export type NextAfterLostRace =
  | { kind: "advisor"; assignment: AssignResult }
  | { kind: "none"; reason: NoNextAdvisor }
  | { kind: "none"; reason: "deadline"; err: unknown };

/**
 * #2281: when a confirm's insert loses the overlap race (#2274), the advisor to
 * hand it to instead, or WHY there is none (#3338, `NoNextAdvisor`).
 *
 * The only advisors this can return are the ones AFTER the loser in the candidate
 * list the booked rung already resolved for this instant, in round robin order,
 * confirmed free by the same live check verify on book uses. It never resolves the
 * pool again and never books a named link's lead with anybody else. Walking on down
 * the ladder when the rung is spent is the CALLER's step (`createHeld`), taken
 * only on `rung-exhausted`, and only when the confirm has the time for it.
 *
 * It is asked only about a lost race (`attemptReservation` answering `lost`): a
 * transient insert failure keeps its own path, which leaves the reservation for
 * the drain. A deadline from the free check comes back as `deadline` with the
 * error itself (#3402): the time was not learned to be taken, the budget ran out,
 * so the lead gets the retryable answer and the page names the timeout.
 *
 * #3462: this runs BEFORE the lost attempt is rolled back, so a confirm with
 * nobody to hand to can tell the confirms waiting behind it first. Nothing here
 * reads the lost attempt's event or reservation, only the advisors after the
 * loser. The rollback still finishes before any further attempt: its reservation
 * reuses the idempotency key, whose unique index would hand back the lost one,
 * while its event pins an id of its own, since the id is derived from the advisor
 * as well as the idempotency key.
 */
export async function nextAdvisorAfterLostRace(
  deps: Pick<BookingDeps, "loadEmails" | "verifyFree">,
  lost: {
    named: boolean;
    reservation: Pick<BookingReservation, "pinned_user_id">;
    lostUserId: string;
    candidates: string[];
    lostSoFar: number;
    startIso: string;
    endIso: string;
    eventType: EventType;
    /** #3257: the confirm's claim in its slot's line, so the next advisor is one
     *  nobody beside it is booking. */
    seat: SharedSeat | null;
  },
): Promise<NextAfterLostRace> {
  const none = (reason: NoNextAdvisor): NextAfterLostRace => ({ kind: "none", reason });
  if (lost.named) return none("named-link");
  if (lost.reservation.pinned_user_id !== lost.lostUserId) return none("not-chosen-here");
  if (lost.lostSoFar >= MAX_RACE_REASSIGNS) return none("bound");
  const at = lost.candidates.indexOf(lost.lostUserId);
  // Unreachable while every pick comes from the rung's own candidates; said as
  // what it would mean rather than guessed at, and never a reason to walk down.
  if (at < 0) return none("not-chosen-here");
  const { pool: remaining } = await unclaimedFirst(lost.seat, lost.candidates.slice(at + 1));
  if (remaining.length === 0) return none("rung-exhausted");
  // #3489: the next advisor is claimed the moment it is chosen, BEFORE the live check,
  // as a confirm's first pick is (`claimFromLine`). Claimed only once Google answered
  // (and, before that, only once the lost attempt was rolled back), a confirm beside
  // this one that lost its own race in the meantime could not see it, chose the same
  // advisor, and lost a second race to this one. Google may take another; that one is
  // claimed in its place.
  if (lost.seat) await lost.seat.claim(remaining[0]!, false);
  try {
    const { assignment, anyUnverified } = await selectAgent(
      remaining,
      (userIds) => deps.loadEmails(userIds),
      (emails, ids) => {
        const [fromIso, toIso] = bufferedWindow(lost.eventType, lost.startIso, lost.endIso);
        return deps.verifyFree(emails, fromIso, toIso, ids);
      },
      VERIFY_WAVE_SIZE,
    );
    if (assignment) {
      if (lost.seat && assignment.userId !== remaining[0]) await lost.seat.claim(assignment.userId, false);
      return { kind: "advisor", assignment };
    }
    // Somebody after the loser could not be checked, so the rung is not known to
    // be spent: it is never dropped for an advisor nobody could ask about.
    return none(anyUnverified ? "check-failed" : "rung-exhausted");
  } catch (err) {
    // #3402: a deadline is not a check that failed. The confirm's budget ran out
    // (or the call's own limit did), so nothing about the slot was learned and the
    // lead can retry: refusing it as a taken time would tell them something
    // nobody measured, and nobody would be paged (L11). The caller raises it as
    // itself, and it becomes the dependency timeout (`timeoutAsRetryable`).
    if (findDeadlineExceeded(err)) return { kind: "none", reason: "deadline", err };
    log.warn(
      "booking",
      { msg: "could not check the next advisor after a lost race; refusing the time", lost_user_id: lost.lostUserId },
      err,
    );
    return none("check-failed");
  }
}

/**
 * Verify-on-book: confirm round-robin candidates against live Google free/busy
 * in WAVES (one batched check per wave) rather than one serial call each, so a
 * large candidate pool can't chain many slow Google calls onto the lead's
 * confirm tap. First confirmed-free agent in round-robin order wins. Selection
 * core is `selectAgent` (pure/tested); this wires it to DB + Google.
 */
async function assignAgent(
  deps: Pick<BookingDeps, "roundRobinCandidates" | "loadEmails" | "verifyFree">,
  bucket: Bucket,
  eventType: EventType,
  startIso: string,
  endIso: string,
  preview = false,
  onlyUserId?: string,
  excludeLow = false,
  /** #3257: this confirm's claim in its slot's line; see `claimFromLine`. */
  seat: SharedSeat | null = null,
  /**
   * #3248: a reroute. The booking's current advisor is taken out of the candidates
   * BEFORE verify, because their own call makes them busy in Google and they are
   * judged separately; the round robin is asked at the fixed time. #3249:
   * `alsoExclude` names advisors a re-search must not offer back (the one just
   * found booked or at their daily cap at confirm).
   */
  reroute?: { excludeUserId: string; forBookingId: string; alsoExclude?: readonly string[] },
  /**
   * #3338: advisors this confirm already knows cannot take the time, left out of
   * the read as if the cache had not offered them: on a walk down after a lost
   * race, those who lost a race at this instant (the overlap index says they hold
   * it) and, on the rung the race was lost on, those it already asked there.
   */
  exclude: readonly string[] = [],
  /**
   * #3489: the confirm's place in its line. `place` names the rung of its ladder it
   * reads, so its read becomes the line's frontier and handing on releases one waiter
   * per advisor it left unclaimed. `handed` is what the line released it with: that
   * advisor alone, judged through the pool's own resolver (`narrowTo`), and already
   * claimed for it, so it is not claimed again.
   */
  line: { place?: ClaimPlace; handed?: StartFrom; inputs?: LadderInputs } = {},
): Promise<AssignResult & { candidates: string[]; read: string[] }> {
  const handed = line.handed;
  // #3489: a walk's ladder read, so this rung is judged from rows already in hand.
  const walk: RoundRobinOpts = { ...(handed ? { narrowTo: handed.advisor } : {}), ...(line.inputs ? { inputs: line.inputs } : {}) };
  const { candidates: ranked, memberCount, memberIds } = await deps.roundRobinCandidates(
    bucket,
    eventType,
    Date.parse(startIso),
    preview,
    onlyUserId,
    excludeLow,
    reroute ? { fixedTime: true, forBookingId: reroute.forBookingId } : Object.keys(walk).length > 0 ? walk : undefined,
  );
  const read = (
    reroute
      ? ranked.filter((id) => id !== reroute.excludeUserId && !(reroute.alsoExclude ?? []).includes(id))
      : ranked
  ).filter((id) => !exclude.includes(id));
  // A handed confirm books its handed advisor or nobody, whatever else the read returned.
  const candidates = handed ? read.filter((id) => id === handed.advisor) : await claimFromLine(seat, read, line.place);
  // #3489: from here the claimed advisor is no longer untried: an end now says how it
  // went (`ClaimOutcome`), and the line no longer hands them back unasked.
  // A handed advisor is asked about by the narrowed read itself, so one it finds
  // unusable ends known, never untried, and is not handed to the next confirm.
  const asked = handed ? handed.advisor : candidates[0];
  if (seat && asked !== undefined) await seat.trying(asked);

  const { assignment, anyUnverified, checked } = await selectAgent(
    candidates,
    // #3489: from the walk's ladder read when there is one: it holds every advisor's row.
    (userIds) => (line.inputs ? Promise.resolve(line.inputs.emails(userIds)) : deps.loadEmails(userIds)),
    // #3495: with the ids the emails were read from, so the calendars are read by id.
    (emails, ids) => {
      const [fromIso, toIso] = bufferedWindow(eventType, startIso, endIso);
      return deps.verifyFree(emails, fromIso, toIso, ids);
    },
    VERIFY_WAVE_SIZE,
  );
  if (!assignment) {
    // #3272: what this rung saw at each stage, carried on whichever refusal follows
    // so the ladder and the route can say where the confirm was refused. `claimed`
    // counts the read advisors another confirm in the line held.
    const rung = rungTraceFrom({
      code: bucket.code,
      members: memberCount,
      read,
      claimedByOthers: seat ? await seat.claimedByOthers() : undefined,
      checked,
      anyUnverified,
      memberIds,
    });
    // #1300: an EMPTY BUCKET is a misconfiguration and pages; a bucket whose people
    // are simply not on shift is an ordinary evening and must not.
    //
    // The candidate list is already filtered by all three gates, so zero candidates
    // used to mean both, and the alert said "No advisors are configured for this
    // booking type" for every out of hours attempt a bot could make. The pool size
    // is what tells them apart, and it is the only thing that can.
    if (memberCount === 0) throw withRung(new NoEligibleAgentsError(bucket.code, bucket.is_test), rung);
    // People exist and none of them can take this time: from the caller's side that
    // is the same instruction as a taken slot, pick another time, so it reuses that
    // error rather than inventing a code the booking API's contract does not carry.
    // No agent was free. If at least one candidate couldn't be VERIFIED (read
    // error / outage), this isn't a genuinely-full slot — surface it distinctly
    // so the caller alerts + lets the lead retry, rather than showing "no times".
    if (anyUnverified) throw withRung(new VerifyUnavailableError(), rung);
    throw withRung(new SlotUnavailableError(), rung);
  }
  // Google may have found the advisor it first claimed busy: claim the one it took.
  if (seat && assignment.userId !== candidates[0]) await seat.claim(assignment.userId, false);
  // #3489: a handed confirm reasons over the rung's whole read, never a list of one: its
  // full verdict and its pick after a lost race (the advisors after its own, in the
  // leader's order) see the rung as the leader read it, not only the advisor it was handed.
  return { ...assignment, candidates: handed ? [...handed.read] : candidates, read: handed ? [...handed.read] : read };
}

/**
 * The candidates a confirm in a slot's line books from, and its claim among them
 * (#3257).
 *
 * Confirms running side by side for one time would otherwise all take the same
 * top advisor, since the round robin orders every one of them alike, and all but
 * one would lose the insert race and pay a second free check and calendar event to
 * be reassigned, which at production speed outruns the budget. So the advisors
 * other confirms in flight have claimed are left out, and this confirm claims the
 * first of the rest before the slow live check. When another unclaimed advisor is
 * left after it, the line is handed on now, so the next confirm starts at once.
 *
 * When every candidate is claimed by somebody in flight, none is left out: one of
 * those may yet fail and free its advisor, and the insert's race handling decides,
 * exactly as before the line existed. Dropping a rung for advisors that are merely
 * claimed would send a lead to a lower tier for a reason that is not true.
 */
async function claimFromLine(seat: SharedSeat | null, candidates: string[], place?: ClaimPlace): Promise<string[]> {
  if (!seat) return candidates;
  // #3325: read and claim in ONE call, so a leader on another isolate cannot claim
  // the same advisor between the two.
  const answer = await seat.claimFirst(candidates, place);
  // #3489 step 3: to a confirm that can walk, every candidate claimed is a spent rung.
  if (answer.spent) throw new RungSpentByClaimsError();
  return answer.pool;
}

/**
 * An in place move claims its advisor, handing the line on only when an advisor
 * nobody in flight has claimed is left at `startIso` beside `userId` (#3257): the
 * hand on rule `claimFromLine` applies to a new booking, for a move that never
 * reads the candidates otherwise. One cache read (the candidate read, no Google
 * call), made only by a move that holds a turn in the line. A read that fails
 * claims with nobody beside it, keeping the line, the safe side: the crowd waits
 * for the move rather than racing it for what may be the last advisor. The claim
 * and the judgement of who else is free are ONE call (#3325, `claimBeside`).
 */
async function claimBesideMove(
  deps: BookingDeps,
  seat: SharedSeat,
  bucket: Bucket,
  eventType: EventType,
  startIso: string,
  userId: string,
): Promise<void> {
  let besides: string[] = [];
  try {
    ({ candidates: besides } = await deps.roundRobinCandidates(bucket, eventType, Date.parse(startIso), true));
  } catch (err) {
    log.warn("booking", { msg: "could not read who else is free beside a move; keeping the confirm line", bucket_code: bucket.code }, err);
    besides = [];
  }
  await seat.claimBeside(userId, besides);
}

/**
 * The advisors in `candidates` that no other confirm in flight has claimed, in
 * order, or all of them when every one is claimed (#3257). The one rule for the
 * first pick and for the pick after a lost race, so neither can hand a confirm an
 * advisor the one beside it is booking while somebody unclaimed is free, and both
 * leave a fully claimed list to the insert to decide, exactly as before the line.
 */
async function unclaimedFirst(seat: SharedSeat | null, candidates: string[]): Promise<{ pool: string[]; unclaimed: number }> {
  if (!seat) return { pool: candidates, unclaimed: candidates.length };
  const others = await seat.claimedByOthers();
  const unclaimed = candidates.filter((id) => !others.has(id));
  return { pool: unclaimed.length > 0 ? unclaimed : candidates, unclaimed: unclaimed.length };
}

/** #3248: how a round robin read is asked when the time is already chosen. */
export interface RoundRobinOpts {
  fixedTime?: boolean;
  forBookingId?: string;
  /**
   * #3489: only this advisor, judged through the pool's own resolver (`narrowedTo`):
   * the read a confirm the line released makes for the advisor it was handed.
   */
  narrowTo?: string;
  /**
   * #3489: the walk's ladder read (`BookingDeps.readLadderInputs`), so this rung is judged
   * from rows already in hand rather than read with seven to nine requests of its own.
   */
  inputs?: LadderInputs;
}

/**
 * What a reroute needs to know about the booking's CURRENT advisor on one rung
 * (#3248). Read through the bucket's REAL resolver (no named agent shortcut, which
 * skips the pool check, red team 4), with their cached busy time and daily count,
 * and whether they have approved time off over the call. Every read inside throws
 * on failure: an unreadable answer is the retriable error, never a keep (audit 12).
 */
export interface CurrentAgentPicture {
  /** The rung's pool as `eligibleAgentIds` resolves it, fallback flag and Low carriers included. */
  pool: EligibleAgents;
  /** Their availability over the booking's window, or null when they have no schedule row. */
  member: MemberAvailability | null;
  onTimeOff: boolean;
  businessHours: BusinessHoursRules;
}

/** The side effects `findRerouteTarget` needs; the routes wire the real ones (#3249). */
export interface RerouteTargetDeps
  extends Pick<BookingDeps, "resolveBucketByCode" | "roundRobinCandidates" | "loadEmails" | "verifyFree"> {
  loadCurrentAgentPicture(bucket: Bucket, eventType: EventType, booking: Booking): Promise<CurrentAgentPicture>;
  now(): number;
}

/**
 * Where a reroute would put a booking (#3244). The names say whether the advisor
 * changes and whether the ladder was walked; `rungsDropped` and `bucket` say how
 * far and where. `keep-last-resort` corrects the bucket to the REQUESTED one while
 * keeping the advisor, because nobody else anywhere could take the time.
 */
export type RerouteTarget =
  | { outcome: "keep-in-requested" | "keep-cascaded" | "keep-last-resort"; bucket: Bucket; eventType: EventType; rungsDropped: number }
  | {
      /**
       * #3487: nobody else on any rung is free AND the current advisor cannot take
       * the call either, so there is nobody to keep. Its own outcome, carrying why,
       * so it never reads as a keep of an advisor who is out.
       */
      outcome: "none-current-unavailable";
      reason: CurrentAgentUnavailable;
      bucket: Bucket;
      eventType: EventType;
      rungsDropped: 0;
    }
  | {
      outcome: "move-in-requested" | "move-cascaded";
      bucket: Bucket;
      eventType: EventType;
      rungsDropped: number;
      userId: string;
      email: string;
      candidates: string[];
    };

/**
 * Whether the current advisor can keep the booking on this rung: a real member of
 * the pool (a fallback stand in is not membership), not a Low carrier on a rung
 * that excludes Low (an unknown answer there fails closed), not on approved time
 * off, and free for the booking's EXACT window by the same predicate the booker
 * uses, with the booking itself taken out of their busy time and cap count. No
 * minimum notice: that rule is for a lead choosing a time, and this one is chosen.
 */
export function currentAgentFitsRung(
  picture: CurrentAgentPicture,
  agentId: string,
  eventType: EventType,
  booking: Pick<Booking, "starts_at" | "ends_at">,
  excludeLow: boolean,
  nowMs: number,
): boolean {
  const { pool } = picture;
  if (pool.fallbackApplied || !pool.ids.includes(agentId)) return false;
  if (excludeLow && (pool.lowIds === undefined || pool.lowIds.includes(agentId))) return false;
  return currentAgentUnavailableReason(picture, eventType, booking, nowMs) === null;
}

/** Why the current advisor cannot take a booking's time (#3487). */
export type CurrentAgentUnavailable = "time_off" | "no_schedule" | "not_free";

/**
 * Why the current advisor cannot take the booking's time at all, whatever pool it
 * sits in (#3487): approved time off over it, no schedule row, or not free for its
 * exact window (off shift, another meeting inside the call or its buffers, or over
 * their daily cap with other calls). Null when they can. The availability half of
 * `currentAgentFitsRung`, shared so the last resort and the keep confirm judge an
 * out advisor by the one rule every rung does.
 */
export function currentAgentUnavailableReason(
  picture: Pick<CurrentAgentPicture, "member" | "onTimeOff" | "businessHours">,
  eventType: EventType,
  booking: Pick<Booking, "starts_at" | "ends_at">,
  nowMs: number,
): CurrentAgentUnavailable | null {
  const { member } = picture;
  if (picture.onTimeOff) return "time_off";
  if (member === null) return "no_schedule";
  const startMs = Date.parse(booking.starts_at);
  const endMs = Date.parse(booking.ends_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "not_free";
  const adjusted = withoutOwnBooking(member, { startMs, endMs });
  const free =
    freeMembersAtExactWindow(
      [adjusted],
      {
        durationMin: Math.round((endMs - startMs) / 60_000),
        bufferBeforeMin: eventType.buffer_before_min,
        bufferAfterMin: eventType.buffer_after_min,
        minNoticeMin: 0,
        dailyCap: eventType.daily_cap,
        businessHours: picture.businessHours,
        nowMs,
      },
      startMs,
    ).length === 1;
  return free ? null : "not_free";
}

/**
 * #3487: `currentAgentUnavailableReason` for the booking's current advisor in one
 * bucket, read through the same picture the search reads. A booking with nobody on
 * it has nobody to judge (null). Every read throws on failure, never reads as free.
 */
export async function currentAgentUnavailableIn(
  deps: Pick<RerouteTargetDeps, "loadCurrentAgentPicture" | "now">,
  booking: Booking,
  rung: { bucket: Bucket; eventType: EventType },
): Promise<CurrentAgentUnavailable | null> {
  if (!booking.assigned_user_id) return null;
  const picture = await deps.loadCurrentAgentPicture(rung.bucket, rung.eventType, booking);
  return currentAgentUnavailableReason(picture, rung.eventType, booking, deps.now());
}

/**
 * Route a booking AS IF it were new into `requested`, at its existing time (#3244,
 * phase 2 #3248), through the booker's own `roundRobinCandidates`, `assignAgent` and
 * `walkTierLadder`, in Dan's order: at each rung, keep the current advisor if they
 * fit, otherwise the first advisor in round robin order verified free; nobody on
 * any rung keeps the current advisor as the last resort, unless they cannot take
 * the call either (#3487), which is `none-current-unavailable`.
 *
 * The window is the booking's STORED start and end, never recomputed. A verify
 * outage throws `VerifyUnavailableError` (retriable) rather than cascading past an
 * advisor it could not check or falling back to a keep, and so does any failed read
 * behind the current advisor's picture.
 */
export async function findRerouteTarget(
  deps: RerouteTargetDeps,
  booking: Booking,
  requested: { bucket: Bucket; eventType: EventType },
  /** #3249: advisors a re-search must not offer back. */
  opts: { excludeUserIds?: readonly string[] } = {},
): Promise<RerouteTarget> {
  const current = booking.assigned_user_id;
  const startIso = new Date(booking.starts_at).toISOString();
  const endIso = new Date(booking.ends_at).toISOString();
  const allowTest = requested.bucket.is_test;

  // The current advisor's picture on the requested rung, kept for the last resort.
  let requestedPicture: CurrentAgentPicture | null = null;
  type Hit =
    | { keep: true; bucket: Bucket; eventType: EventType }
    | { keep: false; bucket: Bucket; eventType: EventType; userId: string; email: string; candidates: string[] };
  const winner = await walkTierLadder<Hit>(requested.bucket.code, async (rungCode, i) => {
    const resolved = i === 0 ? requested : await deps.resolveBucketByCode(rungCode);
    if (!resolved) return { hit: false };
    if (resolved.bucket.is_test !== allowTest) return { hit: false };
    const excludeLow = rungExcludesLow(requested.bucket.code, rungCode);

    if (current) {
      const picture = await deps.loadCurrentAgentPicture(resolved.bucket, resolved.eventType, booking);
      if (i === 0) requestedPicture = picture;
      if (currentAgentFitsRung(picture, current, resolved.eventType, booking, excludeLow, deps.now())) {
        return { hit: true, value: { keep: true, bucket: resolved.bucket, eventType: resolved.eventType } };
      }
    }
    try {
      const { userId, email, candidates } = await assignAgent(
        deps,
        resolved.bucket,
        resolved.eventType,
        startIso,
        endIso,
        false,
        undefined,
        excludeLow,
        null,
        { excludeUserId: current ?? "", forBookingId: booking.id, alsoExclude: opts.excludeUserIds },
      );
      return {
        hit: true,
        value: { keep: false, bucket: resolved.bucket, eventType: resolved.eventType, userId, email, candidates },
      };
    } catch (err) {
      if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) return { hit: false };
      throw err;
    }
  });

  if (!winner) {
    // #3487: the last resort keeps an advisor who can still take the call. One who
    // cannot (time off, off shift, not free) is not kept: there is nobody to keep.
    // Judged on the requested rung, whose event type the kept call would carry.
    const reason =
      current && requestedPicture
        ? currentAgentUnavailableReason(requestedPicture, requested.eventType, booking, deps.now())
        : null;
    if (reason) {
      return { outcome: "none-current-unavailable", reason, bucket: requested.bucket, eventType: requested.eventType, rungsDropped: 0 };
    }
    return { outcome: "keep-last-resort", bucket: requested.bucket, eventType: requested.eventType, rungsDropped: 0 };
  }
  const { value, rungsDropped } = winner;
  if (value.keep) {
    return {
      outcome: rungsDropped === 0 ? "keep-in-requested" : "keep-cascaded",
      bucket: value.bucket,
      eventType: value.eventType,
      rungsDropped,
    };
  }
  return {
    outcome: rungsDropped === 0 ? "move-in-requested" : "move-cascaded",
    bucket: value.bucket,
    eventType: value.eventType,
    rungsDropped,
    userId: value.userId,
    email: value.email,
    candidates: value.candidates,
  };
}

interface TierAssignResult {
  bucket: Bucket;
  eventType: EventType;
  startIso: string;
  endIso: string;
  userId: string;
  email: string;
  candidates: string[];
  /**
   * #3257: the rung's whole candidate list as read, before the advisors other
   * confirms in flight had claimed were left out of `candidates`. Whether the slot
   * is full is judged on this, never on the thinned list: a claimed advisor this
   * confirm never asked about may be free again by the time it finishes.
   */
  read: string[];
  /**
   * #3489: the line handed this confirm its advisor off another confirm's read. Others
   * hold claims on this rung by construction (the one whose read it was, at least), so
   * this confirm never decides on its own that the slot is full or the ladder spent:
   * the confirm that read the rung may yet fail and free its advisor.
   */
  handed?: boolean;
  /**
   * #3489 step 3: the walk skipped a rung above this one only because every advisor on
   * it was claimed by another confirm still in flight, so this booking dropped behind
   * claims, not behind bookings (`routing_trace.dropped_behind: "claimed"`).
   */
  pastClaims?: boolean;
  /**
   * #3529: a rung above this one was skipped without this confirm reading it: the line
   * handed it a lower rung off another confirm's read, or a walk down after a lost race
   * resumed below rungs it had passed only for claims or never read. Whatever freed an
   * advisor up there since is unknown to it, so it never proves the ladder spent.
   */
  unreadAbove?: boolean;
  /**
   * #3529: advisors on this rung this confirm already asked about and found unable to
   * take the time, beyond `candidates`: the advisor the line handed it, when that one
   * could not. A walk down after a lost race leaves them out with the rest it asked.
   */
  alsoAsked?: string[];
  /**
   * #3529: the ladder read this booking decided from covered every rung below this one
   * and found nobody free on any of them, so for its full verdict this rung stands for
   * the ladder's last: its own walk's lower read, or the `deepest` mark it was handed.
   */
  deepest?: boolean;
  /**
   * #3529: the line handed this confirm the last advisor the read it was handed from had
   * unclaimed (`StartFrom.last`), which its place in that read cannot show.
   */
  handedLast?: boolean;
  /**
   * #3489: the ladder read the walk judged its rungs from, so the booking takes the
   * advisor's row and the routing trace's pool from it rather than reading them again.
   */
  ladder?: LadderInputs;
  rungsDropped: number;
  /** #3338: when the walk reached the rung that took it (`Date.now()`), so a lost
   *  race can measure that one rung's cost apart from the rungs dropped above it. */
  rungStartedAtMs: number;
  /** #2158: the bucket's legal rule matched nobody, so it was dropped and the
   *  tier's whole pool was used. Carried out here rather than recomputed, so the
   *  trace and the notice describe the pool this booking actually came from. */
}

/**
 * #3529: whether a claim that ended without a booking could have freed an advisor this
 * confirm never asked about, so nothing it found proves the ladder spent. True when the
 * line handed it the advisor (others claimed that rung by construction), when its walk
 * skipped a rung only because every advisor on it was claimed (`pastClaims`), and when
 * it left advisors out of the rung it booked from for another confirm's claim (#3257).
 * The one judge of a full verdict and of a lost race with nowhere left to walk, so the
 * two can never disagree about the same tier.
 */
function claimsMayFree(tier: TierAssignResult): boolean {
  return (
    tier.handed === true ||
    tier.pastClaims === true ||
    tier.unreadAbove === true ||
    tier.read.some((id) => !tier.candidates.includes(id))
  );
}

/**
 * Where a walk down the ladder after a lost race picks up (#3338).
 *
 * `rung` is the index (into the requested code's ladder) of the rung the race was
 * lost on; rungs above it are not read again. That rung IS read again, with every
 * advisor this confirm already asked there left out (`askedOnRung`), so the only
 * ones it can offer are advisors this confirm left alone because another confirm
 * in its line had claimed them (#3257). Those are tried exactly as a normal confirm
 * meeting them would try them, which is the rule that a rung is never dropped for
 * advisors that are merely claimed. Nobody left there, the walk drops the rung like
 * any confirm's. `taken` (the advisors who lost a race at this instant) is left out
 * of every rung, since an advisor can sit in more than one rung's pool.
 *
 * The same walk as an ordinary confirm's (`assignAgentWithTierFallback`), picked up
 * part way down, so a lost race walks the ladder exactly as any confirm does: one
 * per rung predicate, one rungs-dropped measure from the requested code.
 */
interface LadderResume {
  rung: number;
  askedOnRung: readonly string[];
  taken: readonly string[];
  /**
   * #3529: the rungs above `rung` are not known spent: the confirm passed one only for
   * claims, or never read them (`claimsMayFree`). A walk that then finds nobody parks in
   * the line (`LadderSpentByClaimsError`) rather than refusing.
   */
  unreadAbove: boolean;
}

/**
 * Assign for the requested bucket; if that bucket has no agent free for the
 * slot, cascade down the debt-tier ladder and assign in the first lower bucket
 * that can serve it. The server is the authority here — the client never says
 * which tier to use. Cascades only on SlotUnavailable / NoEligibleAgents (the
 * tier is genuinely exhausted), never on VerifyUnavailable (a transient outage),
 * which is rethrown so an outage can't masquerade as a tier-drop.
 */
async function assignAgentWithTierFallback(
  deps: BookingDeps,
  requested: { bucket: Bucket; eventType: EventType },
  startInstantIso: string,
  allowTestBuckets: boolean,
  // Read-only paths (dry-run preview, the validate-only bookable check #541) pass
  // true so the cascade routes WITHOUT the unfair-ordering alert. The real book
  // leaves it false.
  preview = false,
  /** #3257: the real book's claim in its slot's line; read only paths pass none. */
  seat: SharedSeat | null = null,
  /** #3338: pick the walk up after a lost race (`LadderResume`); absent for an ordinary confirm. */
  resume: LadderResume | null = null,
  /** #3489: what the confirm line released this confirm with (`StartFrom`), if anything. */
  handed: StartFrom | null = null,
  /**
   * #3529: whether this walk may pass a rung only because its advisors are claimed
   * (`ClaimPlace.canWalk`). A bucket move may not: it is about one person, and a move
   * parked behind a crowd answers them as the crowd is answered, never as a move.
   */
  canWalk = true,
): Promise<TierAssignResult> {
  // Shares walkTierLadder with the availability display cascade (#499), so the two
  // can never drift on the ladder or the rungs-dropped accounting; only the per-rung
  // predicate differs (here: an agent verifies free for the slot).
  let lastErr: unknown = null;
  // #3272: every rung this confirm was refused on, in ladder order.
  const rungs: RungTrace[] = [];
  const trace = (stage: RefusalStage): RefusalTrace => ({
    requestedStart: startInstantIso,
    bucketCode: requested.bucket.code,
    stage,
    rungs,
  });
  // #3300: each rung walked is timed on the request's profile, so a confirm that
  // ran out of time while dropping tiers says which rung it was on and what each
  // one cost. A rung skipped before any read (no bucket row) still counts as walked.
  const timeRung = <R>(code: string, fn: () => Promise<R>): Promise<R> => (deps.profile ? deps.profile.rung(code, fn) : fn());
  // #3338: rungs above the one a lost race happened on were walked already.
  const skipped: RungOutcome<Omit<TierAssignResult, "rungsDropped">> = { hit: false };
  // #3489 step 3: a rung skipped only because every advisor on it is claimed by a
  // confirm still in flight. A ladder spent with one of those parks, never refuses.
  let spentByClaims = false;
  // #3441: whether any rung this walk read had people on it and refused the time as
  // taken, which is what lets a walk ending on an EMPTY bucket still say the time is
  // taken for everybody waiting behind it (`markLadderSpent`).
  let refusedAsTaken = false;
  // #3529: a rung above the one this walk starts on was never read by it (`unreadAbove`).
  const unreadAbove = (resume !== null && resume.rung > 0 && resume.unreadAbove) || (handed !== null && handed.rung > 0);
  // Whether a rung has one below it, which decides whether claiming its last advisor
  // hands the line on (`ClaimPlace.below`).
  const ladderCodes = tierLadder(requested.bucket.code);
  const ladderLength = ladderCodes.length;
  // #3489: the whole ladder's candidate inputs in ONE request, so a walk costs one read
  // however many rungs it crosses, and a lower rung's bucket is taken from it too. A
  // read that fails throws here, before any rung, as a failed rung read did.
  const readLadder = (stage: string) => timeStage(deps.profile, stage, () => deps.readLadderInputs!(ladderCodes, startInstantIso, requested.eventType));
  // #3530: when the read ANSWERED. The bound is about time the walk spends after it has
  // the read in hand (live checks, line waits), so a read that was itself slow to arrive
  // is used rather than thrown away at once: a slow database is exactly when a second
  // read is least wanted.
  let ladder = deps.readLadderInputs ? await readLadder("ladder-read") : null;
  let ladderReadAtMs = Date.now();
  // #3530: the read, re-made once it is older than `LADDER_READ_MAX_AGE_MS`. A walk that
  // spent real time on the live checks above a rung judges that rung from a fresh read,
  // never from busy time, counts, holds and a roster read before those checks. A re-read
  // that fails throws, exactly as the first read does: falling back to the stale read is
  // the exposure itself.
  const freshLadder = async (): Promise<LadderInputs | null> => {
    if (!ladder || Date.now() - ladderReadAtMs <= LADDER_READ_MAX_AGE_MS) return ladder;
    const ageMs = Date.now() - ladderReadAtMs;
    ladder = await readLadder("ladder-reread");
    ladderReadAtMs = Date.now();
    log.info("booking", { msg: "ladder read re-made: the walk outlived it", bucket_code: requested.bucket.code, age_ms: ageMs });
    return ladder;
  };
  const winner = await walkTierLadder<Omit<TierAssignResult, "rungsDropped">>(
    requested.bucket.code,
    // #3489: a confirm handed a rung starts there; the rungs above it were read spent by
    // the leader whose read it was handed.
    (rungCode, i) => (resume && i < resume.rung) || (handed && i < handed.rung) ? Promise.resolve(skipped) : timeRung(rungCode, async (): Promise<RungOutcome<Omit<TierAssignResult, "rungsDropped">>> => {
      const rungStartedAtMs = Date.now();
      const rungLadder = await freshLadder();
      const resolved = i === 0 ? requested : rungLadder ? rungLadder.bucket(rungCode) : await deps.resolveBucketByCode(rungCode);
      if (!resolved) return { hit: false }; // a lower tier with no bucket row: skip
      if (resolved.bucket.is_test && !allowTestBuckets) return { hit: false };
      const { startIso, endIso } = bookingWindow(startInstantIso, resolved.eventType.duration_min);
      // The same rule the display cascade judged this rung by (#2842).
      const excludeLow = rungExcludesLow(requested.bucket.code, rungCode);
      let exclude = !resume ? [] : i === resume.rung ? [...resume.askedOnRung, ...resume.taken] : resume.taken;
      // #3529: the handed advisor, once it was asked and could not take the time.
      let handedRefused: string | null = null;
      // #3489: the advisor the line handed, tried alone first. One that cannot take the
      // time (the narrowed read finds them busy or out of the pool, or Google does) is
      // left out and THIS rung read in full below, never a rung dropped while it may
      // still have people free. Its refusal is not this rung's: the full read is.
      if (handed && i === handed.rung && !exclude.includes(handed.advisor)) {
        try {
          const { userId, email, candidates, read } = await assignAgent(
            deps, resolved.bucket, resolved.eventType, startIso, endIso, preview, undefined, excludeLow, seat, undefined, exclude, { handed, ...(rungLadder ? { inputs: rungLadder } : {}) },
          );
          return {
            hit: true,
            value: {
              bucket: resolved.bucket,
              eventType: resolved.eventType,
              startIso,
              endIso,
              userId,
              email,
              candidates,
              read,
              handed: true,
              rungStartedAtMs,
              ...(handed.deepest ? { deepest: true } : {}),
              ...(handed.last ? { handedLast: true } : {}),
            },
          };
        } catch (err) {
          if (!(err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError)) {
            const rung = rungOf(err);
            if (rung) rungs.push(rung);
            throw rung ? traced(err, trace(rung.stage)) : err;
          }
          exclude = [...exclude, handed.advisor];
          handedRefused = handed.advisor;
        }
      }
      // #3530: the handed advisor's live check above may have spent the read's age.
      const fullLadder = handedRefused ? await freshLadder() : rungLadder;
      try {
        // #3529: the rungs below, read from the same ladder read, so the line can hand the
        // whole ladder out at once rather than a rung a walker at a time.
        const lowerRead = seat && canWalk && fullLadder ? await lowerRungReads(deps, fullLadder, ladderCodes, i, requested.bucket.code, startInstantIso, preview, allowTestBuckets, exclude) : null;
        const lower = lowerRead?.rungs ?? [];
        const { userId, email, candidates, read } = await assignAgent(
          deps, resolved.bucket, resolved.eventType, startIso, endIso, preview, undefined, excludeLow, seat, undefined, exclude, {
            place: {
              rung: i,
              canWalk,
              below: i < ladderLength - 1,
              ...(lower.length > 0 ? { lower } : {}),
              ...(lowerRead?.complete ? { lowerComplete: true as const } : {}),
            },
            ...(fullLadder ? { inputs: fullLadder } : {}),
          },
        );
        return {
          hit: true,
          value: {
            bucket: resolved.bucket,
            eventType: resolved.eventType,
            startIso,
            endIso,
            userId,
            email,
            candidates,
            read,
            rungStartedAtMs,
            ...(handedRefused ? { alsoAsked: [handedRefused] } : {}),
            // #3529: below this rung its own complete read found nobody.
            ...(lowerRead?.complete && lower.length === 0 ? { deepest: true } : {}),
          },
        };
      } catch (err) {
        // #3489 step 3: claimed through, not spent: remembered, never the reason.
        if (err instanceof RungSpentByClaimsError) {
          spentByClaims = true;
          return { hit: false };
        }
        const rung = rungOf(err);
        // #2842: a rung filtered to advisors without Low can hold nobody on a
        // perfectly configured bucket (most Medium advisors also carry Low), so an
        // empty one says nothing about the bucket. It is skipped WITHOUT becoming
        // the reason, so the lead is told what the rungs that could serve them
        // said, and a filtered rung can never page as an empty bucket. Nor is it
        // recorded (#3272): in stage_counts it would read as an empty pool.
        if (err instanceof NoEligibleAgentsError && excludeLow) return { hit: false };
        if (rung) rungs.push(rung);
        if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) {
          lastErr = err; // this tier can't serve the slot; drop a rung
          // #3441: a rung with people on it, none able to take the time.
          if (err instanceof SlotUnavailableError) refusedAsTaken = true;
          return { hit: false };
        }
        // VerifyUnavailableError and anything unexpected: do not mask. An outage the
        // rung measured carries the ladder so far.
        throw rung ? traced(err, trace(rung.stage)) : err;
      }
    }),
  );
  if (winner) {
    return {
      ...winner.value,
      rungsDropped: winner.rungsDropped,
      ...(spentByClaims ? { pastClaims: true } : {}),
      ...(unreadAbove ? { unreadAbove: true } : {}),
      ...(ladder ? { ladder } : {}),
    };
  }
  // #3489 step 3: a claim in flight may yet free an advisor the walk skipped, so the
  // line, which sees every claim end, answers this confirm rather than a refusal.
  // #3529: so may one on a rung above that this walk never read.
  //
  // #3440, #3441: every rung was refused or empty, so the ladder is spent, and the
  // refusal is marked to settle the confirms waiting behind it (`verdictForRefusal`).
  // Whichever rung came LAST names the error, so a ladder whose last rung is an empty
  // bucket ends in `NoEligibleAgentsError` while a rung above it refused the time as
  // taken: marked all the same, and still that error, so this confirm is answered and
  // recorded as an empty bucket and the page is unchanged. A ladder with nobody on ANY
  // rung is not marked: no rung ever refused the time as taken, so telling a crowd
  // "taken" would be a claim nothing measured (L11), and each walks its empty rungs,
  // which asks nobody at Google, to its own empty bucket answer. A rung passed only for
  // claims had people on it too.
  const last = (lastErr ?? new SlotUnavailableError()) as SlotUnavailableError | NoEligibleAgentsError;
  const spent = !(last instanceof NoEligibleAgentsError) || refusedAsTaken || spentByClaims;
  const refusal = traced(spent ? markLadderSpent(last) : last, trace(ladderStage(rungs)));
  if (spentByClaims || unreadAbove) throw new LadderSpentByClaimsError(refusal);
  throw refusal;
}

/**
 * #3529: the candidate reads of every rung below `from`, judged by the same rules a walk
 * judges each rung by (its bucket, the test bucket rule, the Low exclusion of a top tier
 * lead's cascade) from the ladder read the walk already holds, so it costs no request.
 * Handed to the line with the claim on `from`, which then releases the whole ladder at
 * once, top rung first (`ClaimPlace.lower`). Best effort: a read that fails sends none,
 * and the line hands out one rung at a time as before.
 */
export async function lowerRungReads(
  deps: Pick<BookingDeps, "roundRobinCandidates">,
  ladder: LadderInputs,
  codes: readonly string[],
  from: number,
  requestedCode: string,
  startInstantIso: string,
  preview: boolean,
  allowTestBuckets: boolean,
  /** Everybody this confirm already knows cannot take the instant: the advisors it lost a
   *  race to, those it asked and found unable, and an advisor it was handed and found
   *  unable. Busy at the instant is busy on every rung, so the line is never handed them. */
  exclude: readonly string[],
): Promise<{ rungs: { rung: number; read: string[] }[]; complete: boolean }> {
  const out: { rung: number; read: string[] }[] = [];
  try {
    for (let j = from + 1; j < codes.length; j++) {
      const resolved = ladder.bucket(codes[j]!);
      if (!resolved || (resolved.bucket.is_test && !allowTestBuckets)) continue;
      const { startIso } = bookingWindow(startInstantIso, resolved.eventType.duration_min);
      const { candidates } = await deps.roundRobinCandidates(
        resolved.bucket,
        resolved.eventType,
        Date.parse(startIso),
        preview,
        undefined,
        rungExcludesLow(requestedCode, codes[j]!),
        { inputs: ladder },
      );
      const read = candidates.filter((id) => !exclude.includes(id));
      if (read.length > 0) out.push({ rung: j, read });
    }
  } catch (err) {
    // A confirm out of its budget is not a failed read: it ends the confirm.
    if (findDeadlineExceeded(err)) throw err;
    log.warn("booking", { msg: "could not read the rungs below for the line; it hands out one rung at a time", bucket_code: requestedCode }, err);
    return { rungs: [], complete: false };
  }
  // Every rung below was judged, so a rung missing from `rungs` was read and found empty.
  return { rungs: out, complete: true };
}

/**
 * The step a confirm takes when its insert lost the overlap race and nobody after
 * the loser on that rung is free (#3338): the ordinary ladder walk, picked up at
 * that rung (`LadderResume`), so the rest of the ladder is walked exactly as any
 * confirm walks it. Gives back the rung that can take the time, rebuilt whole
 * (bucket, event type, window, candidates, read and rungs dropped from the
 * requested code), or the rungs it asked when none can, for the refusal's trace.
 *
 * Only a rung genuinely spent ends the walk. An outage on a rung below (a live
 * check that could not answer) and a deadline go up as themselves, the retryable
 * answer, exactly as they do from an ordinary confirm's walk: a rung nobody could
 * ask about is never read as having nobody (L11).
 */
async function walkDownAfterLostRace(
  deps: BookingDeps,
  requested: { bucket: Bucket; eventType: EventType },
  input: Pick<CreateBookingInput, "startIso" | "allowTestBuckets">,
  seat: SharedSeat | null,
  resume: LadderResume,
  /** #3529: `assignAgentWithTierFallback`'s `canWalk`, the same for every walk one confirm takes. */
  canWalk: boolean,
): Promise<{ tier: TierAssignResult } | { refusedOn: RungTrace[] }> {
  try {
    return {
      tier: await assignAgentWithTierFallback(deps, requested, input.startIso, input.allowTestBuckets ?? false, false, seat, resume, null, canWalk),
    };
  } catch (err) {
    if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) {
      return { refusedOn: refusalTraceOf(err)?.rungs ?? [] };
    }
    throw err;
  }
}

/**
 * Assign the ONE agent a named link books (#2073), through the same `assignAgent`
 * the pool uses, narrowed to them: the same candidate predicate (every
 * availability gate) and the same verify on book, with nothing to fall back to.
 *
 * `NoEligibleAgentsError` is a pool with nobody in it, which pages as a
 * misconfigured bucket. For one named agent it only means they have nothing to
 * offer at that time, which is the same instruction as a taken slot.
 */
async function assignNamedAgent(
  deps: BookingDeps,
  resolved: { bucket: Bucket; eventType: EventType },
  startInstantIso: string,
  agentUserId: string,
): Promise<TierAssignResult> {
  const rungStartedAtMs = Date.now();
  const { startIso, endIso } = bookingWindow(startInstantIso, resolved.eventType.duration_min);
  let assigned: AssignResult & { candidates: string[]; read: string[] };
  try {
    assigned = await assignAgent(deps, resolved.bucket, resolved.eventType, startIso, endIso, false, agentUserId);
  } catch (err) {
    const rung = rungOf(err);
    const asTaken = err instanceof NoEligibleAgentsError ? new SlotUnavailableError() : err;
    // #3440: the one advisor a named link names is its whole ladder, so a taken time
    // settles the confirms waiting behind it, as it always did.
    const refused = asTaken instanceof SlotUnavailableError ? markLadderSpent(asTaken) : asTaken;
    throw rung
      ? traced(refused, { requestedStart: startInstantIso, bucketCode: resolved.bucket.code, stage: rung.stage, rungs: [rung] })
      : refused;
  }
  // The candidate read was narrowed to this agent, so anybody else here is a
  // fault in that read. Refused rather than booked: booking somebody the link
  // does not name is the one outcome this path must never produce (L75).
  if (assigned.userId !== agentUserId) {
    throw new Error("named link assignment returned an agent the link does not name");
  }
  return {
    bucket: resolved.bucket,
    eventType: resolved.eventType,
    startIso,
    endIso,
    userId: assigned.userId,
    email: assigned.email,
    candidates: assigned.candidates,
    read: assigned.read,
    rungsDropped: 0,
    rungStartedAtMs,
  };
}

/**
 * What a webhook says beyond the booking itself. An object rather than more
 * positional arguments: `bookingEventId` and `previousAgentEmail` are both
 * `string | null`, so as positions they would be silently transposable at every
 * call site (L455).
 */
interface WebhookExtras {
  /** History row id (or, for a reassign, the outbox row id) for the dedupe key. */
  bookingEventId?: string | null;
  /** The advisor a reassign moved the booking away from (#2368). */
  previousAgentEmail?: string | null;
  /** The number a phone correction replaced (#1512). */
  previousPhone?: string | null;
}

function webhookPayload(
  deps: BookingDeps,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
  reason: BookingReasonMeta | null,
  previousAgentEmail: string | null,
  previousPhone?: string | null,
): BookingEventPayload {
  return {
    booking_id: booking.id,
    salesforce_id: booking.salesforce_id,
    bucket_code: bucket.code,
    event_type: eventType.name,
    event_type_slug: eventType.regal_type,
    event_description: eventType.description,
    status: booking.status,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    timezone: booking.timezone,
    // Read from the booking's agent snapshot, so it works even if the agent
    // was later removed from Slate.
    agent: {
      id: booking.assigned_user_id ?? "",
      name: booking.agent_name,
      email: booking.agent_email ?? "",
    },
    attendee: {
      name: booking.attendee_name,
      first_name: booking.attendee_first_name ?? null,
      email: booking.attendee_email,
      phone: booking.attendee_phone,
    },
    prefill: booking.prefill,
    manage_url: manageUrl(deps, booking.manage_token),
    reason,
    previous_agent_email: previousAgentEmail,
    // #1512, #4031: only on a phone correction (a contact update, or a move that
    // corrected the number), the events that have a number they replaced.
    ...(previousPhone !== undefined ? { previous_attendee_phone: previousPhone } : {}),
    // #2073: null for an agent link booking, which nothing routed. A summary built
    // from its null trace would read as a routed booking with no fallback.
    routing: booking.kind === "agent_link" ? null : routingMetaFromTrace(booking.routing_trace),
    // #2073: absent on a row read before the column existed, which was routed.
    booking_kind: booking.kind ?? "routed",
  };
}

/**
 * Emit a booking webhook. `reason` carries the why+who for
 * rescheduled/cancelled/reassigned and is null for created/completed, passed
 * only at those call sites so the shared builder never pollutes create/complete
 * with empty reason fields.
 */
async function fire(
  deps: BookingDeps,
  event: WebhookEvent,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
  reason: BookingReasonMeta | null = null,
  extras: WebhookExtras = {},
): Promise<void> {
  const bookingEventId = extras.bookingEventId ?? null;
  // #459: the smoke test books real bookings on a hidden is_test bucket via the
  // key-authed API, so without this every smoke run would inject a synthetic lead
  // into Regal/Cadence and then cancel it. Every booking webhook passes through
  // here, so this one flag covers created/cancelled/rescheduled/completed.
  //
  // The delivery is still RECORDED and only the external POST is skipped (emit.ts).
  // Dropping the emission entirely would erase the webhook_deliveries rows that
  // scripts/smoke-create-resume.ts counts to prove the exactly-once dedupe survives
  // a crash-resume on real Postgres.
  await deps.emitWebhook(
    booking.org_id,
    event,
    webhookPayload(deps, booking, bucket, eventType, reason, extras.previousAgentEmail ?? null, extras.previousPhone),
    webhookDedupeKey(event, { bookingId: booking.id, bookingEventId }),
    bucket.is_test,
    // #884: set only on user-facing requests, so the confirm/cancel/reschedule
    // response returns without waiting on the send. Unset on the cron drains
    // (completion sweep, outbox + reservation drains), which stay inline-bounded.
    deps.deferSend,
  );
}

/** The reason meta carried on a rescheduled/cancelled webhook. */
function reasonMeta(
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
): BookingReasonMeta {
  return { code: reason.code, detail: reason.detail, initiator };
}

// --- Outbox step handlers (#429 P3) -----------------------------------------
// Each handler is idempotent and derives everything from the booking id + the
// outbox row's payload, so the inline run and a drain re-run after a crash reach
// the same end state. The registry is shared by the producers (run inline) and
// the /api/cron/outbox drain.

const CANCEL_STEPS = {
  GCAL_DELETE: "cancel:gcal_delete",
  BUSYBLOCK_DELETE: "cancel:busyblock_delete",
  RECOMPUTE: "cancel:recompute",
  OWNER_ALERT_DELETE: "cancel:owner_alert_delete",
  NOTIFY: "cancel:notify",
} as const;

/**
 * The ordered steps a cancel must deliver.
 *
 * NOTE for `cancel_duplicate_booking` (migration 0124): that function enqueues its own
 * cancel row in SQL and therefore holds a SECOND copy of this list, which
 * `scripts/test-duplicate-cancel.ts` holds against this one. `cancel:owner_alert_delete`
 * is deliberately NOT in the SQL copy yet, and the reason is deploy ORDER, not an
 * oversight: a step with no handler FAILS its row (outbox.ts), so a migration that
 * enqueued it would break every Regal duplicate cancel in the window between the
 * migration being applied and this code being deployed (L640). #2433 adds it to the
 * function in the migration after that deploy.
 */
export function cancelOutboxSteps(): OutboxStep[] {
  return [
    { name: CANCEL_STEPS.GCAL_DELETE, state: "pending" },
    { name: CANCEL_STEPS.BUSYBLOCK_DELETE, state: "pending" },
    { name: CANCEL_STEPS.RECOMPUTE, state: "pending" },
    { name: CANCEL_STEPS.OWNER_ALERT_DELETE, state: "pending" },
    { name: CANCEL_STEPS.NOTIFY, state: "pending" },
  ];
}

const RESCHEDULE_STEPS = {
  BUSYBLOCK_MOVE: "reschedule:busyblock_move",
  RECOMPUTE: "reschedule:recompute",
  OWNER_ALERT_MOVE: "reschedule:owner_alert_move",
  NOTIFY: "reschedule:notify",
} as const;

/** The ordered POST-commit steps a reschedule must deliver. The agent decision
 *  + gcal create/update stay inline (the create-idempotency is P4, #439); the
 *  outbox covers the slot move, recompute, the owner alert's own move, and the
 *  rescheduled webhook. */
export function rescheduleOutboxSteps(): OutboxStep[] {
  return [
    { name: RESCHEDULE_STEPS.BUSYBLOCK_MOVE, state: "pending" },
    { name: RESCHEDULE_STEPS.RECOMPUTE, state: "pending" },
    { name: RESCHEDULE_STEPS.OWNER_ALERT_MOVE, state: "pending" },
    { name: RESCHEDULE_STEPS.NOTIFY, state: "pending" },
  ];
}

const REASSIGN_STEPS = {
  BUSYBLOCK_MOVE: "reassign:busyblock_move",
  RECOMPUTE: "reassign:recompute",
  NOTIFY: "reassign:notify",
  OWNER_ALERT_REMOVE: "reassign:owner_alert_remove",
  OWNER_ALERT: "reassign:owner_alert",
  OWNER_NOTICE: OWNER_NOTICE_STEP,
} as const;

/** Post-commit steps for a contact-owner reassign (#9). Like reschedule, the
 *  gcal delete-old + create-new stays inline (create-idempotency is P4); the
 *  outbox covers the slot move, recompute, and the booking.reassigned webhook
 *  (#2368: a reassign never moves the time, so it is not a reschedule).
 *
 *  The two owner-alert steps run LAST and in this order, which is load bearing
 *  (#2371): the remove step closes an alert belonging to whoever no longer holds
 *  the call, and only then can the create step write one for whoever now does.
 *  Reversed, an owner-to-owner move would meet the partial unique index on the
 *  booking's live alert and fail a step that has nothing wrong with it.
 *
 *  OWNER_NOTICE (#2372) is last, and is its OWN step rather than a few lines inside
 *  NOTIFY. A step that throws is marked failed and the executor carries on, so the
 *  separation is what stops a Slack outage failing the step that carries the
 *  `booking.reassigned` webhook, which is what a lead's Regal journey runs on (L73).
 *  Last because nothing else waits on it: it tells people about work already done. */
export function reassignOutboxSteps(): OutboxStep[] {
  return [
    { name: REASSIGN_STEPS.BUSYBLOCK_MOVE, state: "pending" },
    { name: REASSIGN_STEPS.RECOMPUTE, state: "pending" },
    { name: REASSIGN_STEPS.NOTIFY, state: "pending" },
    { name: REASSIGN_STEPS.OWNER_ALERT_REMOVE, state: "pending" },
    { name: REASSIGN_STEPS.OWNER_ALERT, state: "pending" },
    { name: REASSIGN_STEPS.OWNER_NOTICE, state: "pending" },
  ];
}

/**
 * Take an alert off the calendar and close its row, in that order (#2371).
 *
 * The order is the invariant: the event goes first, so a crash between the two
 * leaves a row still pointing at a real event (the next pass finds it and finishes
 * the job) rather than an event nothing points at, which nobody could ever find
 * again. A transient Google failure throws, so the outbox retries it.
 *
 * A DEFINITIVE failure (the account is gone, or was never given Calendar) closes the
 * row anyway and records the kind: no amount of retrying reaches that calendar, and
 * a row left open would make every later pass try again forever. The event, if it is
 * still there at all, belongs to an account nobody can reach.
 */
async function removeOwnerAlert(deps: BookingDeps, alert: OwnerAlertEvent): Promise<void> {
  if (!alert.gcal_event_id) {
    // Nothing was ever written (the create failed, or was refused). Closing the row
    // is the whole removal.
    await deps.markOwnerAlertRemoved(alert.id);
    return;
  }
  try {
    // The same value twice, and deliberately: `calendar_id` holds the advisor's own
    // calendar ADDRESS, which is both the calendar to delete from and the identity to
    // delete as. One column answering both is one fewer thing to keep in step.
    await deps.deleteOwnerAlertEvent(alert.calendar_id, alert.calendar_id, alert.gcal_event_id);
  } catch (err) {
    const kind = reachabilityFromError(err);
    if (!isDefinitiveFailure(kind)) throw err;
    await deps.markOwnerAlertRemoved(alert.id, kind);
    return;
  }
  await deps.markOwnerAlertRemoved(alert.id);
}

/**
 * What a reschedule's or reassign's slot refresh hands the splice (#3334): the call
 * as the booking now holds it, and the call as it was before the move.
 *
 * The step runs after the commit, so the booking row already holds the NEW time and
 * advisor; the old ones come from the payload the move recorded at enqueue. The
 * payload records where the old call STARTED, not where it ended, so its end is the
 * start plus the call's length, which a move keeps (a reschedule takes the event
 * type's duration and a reassign never touches the time). Were the length ever to
 * differ, the freed window would be narrower by the difference, and the starts it
 * missed would wait for the lane: withheld, the safe side.
 *
 * `undefined` means the code's pool refresh runs instead, for a row that cannot say
 * where the call was (nothing to judge as freed, and a half splice would leave the
 * old time withheld in the booked code's pool too) or a booking with nobody on it.
 * An old advisor of null means nobody held the call, so only the time taken is
 * spliced.
 */
function movedWindows(
  booking: Booking,
  payload: BookingOutbox["payload"],
): (BookedWindow & { freed?: BookedWindow }) | undefined {
  if (!booking.assigned_user_id || !payload.fromStartsIso || payload.fromAgentUserId === undefined) return undefined;
  const taken = { userId: booking.assigned_user_id, startsAt: booking.starts_at, endsAt: booking.ends_at };
  if (payload.fromAgentUserId === null) return taken;
  const fromMs = Date.parse(payload.fromStartsIso);
  const lengthMs = Date.parse(booking.ends_at) - Date.parse(booking.starts_at);
  if (!Number.isFinite(fromMs) || !Number.isFinite(lengthMs)) return undefined;
  return {
    ...taken,
    freed: {
      userId: payload.fromAgentUserId,
      startsAt: payload.fromStartsIso,
      endsAt: new Date(fromMs + lengthMs).toISOString(),
    },
  };
}

export const OUTBOX_HANDLERS: OutboxHandlers = {
  [CANCEL_STEPS.GCAL_DELETE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return; // booking gone -> nothing to delete
    const { booking } = ctx;
    if (booking.agent_email && booking.gcal_event_id) {
      await deleteEventBestEffort(deps, booking.agent_email, booking.gcal_event_id, booking.id);
    }
  },
  [CANCEL_STEPS.BUSYBLOCK_DELETE]: async (deps, row) => {
    if (!row.booking_id) return;
    await deps.deleteBusyBlocksForBooking(row.booking_id);
  },
  [CANCEL_STEPS.RECOMPUTE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (ctx) await deps.invalidateSlots(ctx.bucket.code);
  },
  // #2371: the call is off, so the advisor's warning about it must be too. No gate on
  // the reason or the initiator: whatever cancelled it, an alert for a call that is
  // not happening is a standing wrong claim on somebody's calendar.
  [CANCEL_STEPS.OWNER_ALERT_DELETE]: async (deps, row) => {
    if (!row.booking_id) return;
    const alert = await deps.loadLiveOwnerAlert(row.booking_id);
    if (!alert) return;
    await removeOwnerAlert(deps, alert);
  },
  [CANCEL_STEPS.NOTIFY]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking, bucket, eventType } = ctx;
    const p = row.payload;
    const reason: ValidatedReason = {
      code: p.reasonCode ?? "",
      detail: p.reasonDetail ?? null,
    };
    const initiator: BookingEventInitiator = p.initiator ?? "system";
    // Record history idempotently: reuse the existing row's id on a drain re-run
    // (so the webhook dedupe key is stable) instead of inserting a duplicate.
    let eventId = await deps.getBookingEventId(booking.id, "cancelled", null);
    if (!eventId) {
      eventId = await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "cancelled",
          initiator,
          reason,
          fromStartsIso: p.fromStartsIso ?? booking.starts_at,
          toStartsIso: null,
          fromAgentUserId: p.fromAgentUserId ?? booking.assigned_user_id,
          toAgentUserId: null,
          actorUserId: p.actorUserId,
          actingAsUserId: p.actingAsUserId,
          nowMs: Date.now(),
        }),
      );
    }
    await fire(
      deps,
      "booking.cancelled",
      booking,
      bucket,
      eventType,
      reasonMeta(reason, initiator),
      { bookingEventId: eventId },
    );
  },

  // Reschedule post-commit steps. Handlers re-read the booking, which already
  // holds the NEW time/agent (updateBooking ran before the row was enqueued), so
  // the move/recompute target the new slot and the webhook carries the new time.
  [RESCHEDULE_STEPS.BUSYBLOCK_MOVE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx || !ctx.booking.assigned_user_id) return;
    await deps.moveBusyBlock(
      ctx.booking.assigned_user_id,
      ctx.booking.starts_at,
      ctx.booking.ends_at,
      ctx.booking.id,
    );
  },
  [RESCHEDULE_STEPS.RECOMPUTE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    // #3334: both windows, so the new time leaves, and the old one returns to, every
    // pool the advisors serve rather than only this code's.
    if (ctx) await deps.invalidateSlots(ctx.bucket.code, movedWindows(ctx.booking, row.payload));
  },
  /**
   * #2371: the call moved, so the warning moves with it. The advisor keeps it, which
   * is the point: the same person is still the one who has spoken to this lead.
   *
   * A reschedule can also RE-ROUTE to a different agent (the in-place guard declines
   * and the booking lands elsewhere). Then the alert belongs to somebody who no longer
   * holds the call, so it is removed rather than moved: moving it would put a warning
   * about a call on the calendar of somebody who is not taking it.
   */
  [RESCHEDULE_STEPS.OWNER_ALERT_MOVE]: async (deps, row) => {
    if (!row.booking_id) return;
    const alert = await deps.loadLiveOwnerAlert(row.booking_id);
    if (!alert) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    if (alert.user_id !== ctx.booking.assigned_user_id) {
      await removeOwnerAlert(deps, alert);
      return;
    }
    // No event to move: either the create has not landed yet (its own step retries
    // and will use the booking's CURRENT time, which is already the new one), or the
    // calendar was definitively refused and nothing will ever be written. A recorded
    // skip means that calendar is unreachable, so asking again on every later
    // reschedule spends a call to learn what the row already says.
    if (!alert.gcal_event_id || alert.skip_reason) return;
    const window = ownerAlertWindow(ctx.booking.starts_at);
    try {
      await deps.moveOwnerAlertEvent(
        // Address and identity, as in removeOwnerAlert above.
        alert.calendar_id,
        alert.calendar_id,
        alert.gcal_event_id,
        window.start,
        window.end,
        ctx.booking.timezone,
      );
    } catch (err) {
      // The advisor deleted the alert themselves: there is nothing to move and
      // nothing wrong. Close the row so no later step hunts for it.
      if (err instanceof EventGone) {
        await deps.markOwnerAlertRemoved(alert.id, "event-gone");
        return;
      }
      const kind = reachabilityFromError(err);
      if (!isDefinitiveFailure(kind)) throw err;
      await deps.recordOwnerAlertSkip(alert.id, kind);
    }
  },
  [RESCHEDULE_STEPS.NOTIFY]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking, bucket, eventType } = ctx;
    const p = row.payload;
    const reason: ValidatedReason = {
      code: p.reasonCode ?? "",
      detail: p.reasonDetail ?? null,
    };
    const initiator: BookingEventInitiator = p.initiator ?? "system";
    const toStartsIso = booking.starts_at; // the new time (already committed)
    // Versioned by (to_starts_at, reschedule_seq): an oscillation back to a
    // previously-used time still gets a fresh history row + dedupe key, so its
    // webhook isn't swallowed by the earlier reschedule's row (#614). The seq is
    // stable across a drain re-run of THIS move, so the resume still dedupes.
    const seq = booking.reschedule_seq;
    let eventId = await deps.getBookingEventId(booking.id, "rescheduled", toStartsIso, seq);
    if (!eventId) {
      eventId = await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "rescheduled",
          initiator,
          reason,
          fromStartsIso: p.fromStartsIso ?? booking.starts_at,
          toStartsIso,
          fromAgentUserId: p.fromAgentUserId ?? null,
          toAgentUserId: booking.assigned_user_id,
          actorUserId: p.actorUserId,
          actingAsUserId: p.actingAsUserId,
          rescheduleSeq: seq,
          nowMs: Date.now(),
        }),
      );
    }
    await fire(
      deps,
      "booking.rescheduled",
      booking,
      bucket,
      eventType,
      reasonMeta(reason, initiator),
      // #4031: a number the move corrected rides this event (#2164), so the payload
      // names the one it replaced and Regal makes the new one primary and subscribed.
      // Absent on a row with no correction, and on one enqueued before this existed.
      {
        bookingEventId: eventId,
        ...(p.previousAttendeePhone !== undefined ? { previousPhone: p.previousAttendeePhone } : {}),
      },
    );
  },

  // Reassign post-commit steps. Move/recompute mirror reschedule (re-read the
  // booking, now at the new agent). Notify differs: the history action is
  // 'reassigned' (so it doesn't inflate reschedule-rate) and since #2368 so is
  // the webhook, booking.reassigned. It used to be booking.rescheduled, which
  // meant every Regal journey listening for a time change fired on a booking
  // whose time had not moved, and a lead could be told their call had been
  // rebooked when only the advisor had changed. Every reassign fires it: the
  // machine owner move, an admin reassign, the bulk redistribute and the
  // offboarding coverage sweep all land here, and none of them touches the time.
  // The time being UNCHANGED is also why there is no time to version the dedupe
  // key by; we key the webhook on the outbox row id (stable per reassign, so a
  // resume re-fire is deduped, exactly once).
  [REASSIGN_STEPS.BUSYBLOCK_MOVE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx || !ctx.booking.assigned_user_id) return;
    await deps.moveBusyBlock(
      ctx.booking.assigned_user_id,
      ctx.booking.starts_at,
      ctx.booking.ends_at,
      ctx.booking.id,
    );
  },
  [REASSIGN_STEPS.RECOMPUTE]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    // #3334: the same time, taken by the new advisor and left by the old one.
    if (ctx) await deps.invalidateSlots(ctx.bucket.code, movedWindows(ctx.booking, row.payload));
  },
  [REASSIGN_STEPS.NOTIFY]: async (deps, row) => {
    if (!row.booking_id) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking, bucket, eventType } = ctx;
    const p = row.payload;
    const reason: ValidatedReason = {
      code: p.reasonCode ?? "",
      detail: p.reasonDetail ?? null,
    };
    // A manager-driven reassign carries initiator 'admin' (#546); the machine
    // contact-owner path leaves it unset -> 'system'. The history row AND the
    // webhook meta must agree, so both read the payload's initiator.
    const initiator: BookingEventInitiator = p.initiator ?? "system";
    // Record the override audit row (action 'reassigned'). Not guarded for
    // idempotent resume because a reassign has no natural per-operation key in
    // booking_events; a duplicate on the rare within-step crash is acceptable
    // (audit only). The webhook below stays exactly-once via the row-id key.
    await deps.insertBookingEvent(
      bookingEventFrom({
        bookingId: booking.id,
        action: "reassigned",
        initiator,
        reason,
        fromStartsIso: booking.starts_at,
        toStartsIso: booking.starts_at,
        fromAgentUserId: p.fromAgentUserId ?? null,
        toAgentUserId: booking.assigned_user_id,
        actorUserId: p.actorUserId,
        actingAsUserId: p.actingAsUserId,
        fromBucketId: p.fromBucketId ?? null,
        toBucketId: p.toBucketId ?? null,
        nowMs: Date.now(),
      }),
    );
    // Dedupe key = the outbox row id: stable across inline run + drain resume,
    // so the booking.reassigned webhook fires exactly once.
    //
    // The advisor it moved AWAY from can only come off the outbox payload: this
    // step re-reads the booking, which by now holds the new advisor. A row
    // enqueued before that field existed carries nothing, and null is what that
    // has to mean. The alternative, resolving `fromAgentUserId` to an address
    // here, would spend a read on the drain to report whatever that account
    // looks like today rather than who held the booking (L192, L443).
    await fire(
      deps,
      "booking.reassigned",
      booking,
      bucket,
      eventType,
      reasonMeta(reason, initiator),
      { bookingEventId: row.id, previousAgentEmail: p.fromAgentEmail ?? null },
    );
  },

  /**
   * #2371: an alert belonging to an advisor who no longer holds this call comes off
   * their calendar. Deliberately NOT gated on the reason or the initiator, because
   * EVERY reassign reaches here: the machine owner move, an admin coverage move, the
   * bulk redistribute and the offboarding sweep. Whichever one it was, the warning is
   * now on the wrong person's calendar.
   *
   * The predicate is "the alert's advisor is not the booking's advisor", which is also
   * what makes a reassign back onto the SAME owner leave the one alert alone.
   */
  [REASSIGN_STEPS.OWNER_ALERT_REMOVE]: async (deps, row) => {
    if (!row.booking_id) return;
    const alert = await deps.loadLiveOwnerAlert(row.booking_id);
    if (!alert) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    if (alert.user_id === ctx.booking.assigned_user_id) return;
    await removeOwnerAlert(deps, alert);
  },

  /**
   * #2371: the machine routed this lead back to the advisor who has already pitched
   * them, so that advisor gets a warning on their own calendar before the call.
   *
   * Only the MACHINE owner move (`isOwnerAlertReassign`): an admin picking the same
   * reason for a coverage move is moving the call to somebody with no history here,
   * and an alert on their calendar would be a claim nothing measured.
   *
   * The ROW comes first and the Google event second (L421). A crash in between leaves
   * a row with a null event id, which this step's own retry finishes; the reverse
   * would leave an event on a real advisor's calendar that nothing in Slate could
   * ever find again. The client id is deterministic on the OUTBOX ROW, so that retry
   * meets Google's 409 and adopts the event already there rather than making a second.
   */
  [REASSIGN_STEPS.OWNER_ALERT]: async (deps, row) => {
    if (!row.booking_id) return;
    if (!isOwnerAlertReassign(row.payload)) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return;
    const { booking } = ctx;
    const userId = booking.assigned_user_id;
    const email = booking.agent_email;
    if (!userId || !email) {
      // reassignBooking refuses a target with no email, so this is unreachable on the
      // live path; said rather than assumed, because a silent return here would be a
      // missing alert nobody could explain.
      log.warn("owner-alert", {
        msg: "reassigned booking has no advisor to alert",
        booking_id: booking.id,
      });
      return;
    }

    let alert = await deps.loadLiveOwnerAlert(booking.id);
    if (alert && alert.user_id !== userId) {
      // The remove step ahead of this one owns that row and did not close it, so it
      // failed; let it retry rather than writing a second live alert into the unique
      // index behind its back.
      return;
    }
    if (!alert) {
      alert = await deps.insertOwnerAlert({
        booking_id: booking.id,
        user_id: userId,
        calendar_id: email,
      });
    }
    // Already on the calendar, or definitively refused: either way there is nothing
    // left for this step to do, on this pass or any later one.
    if (alert.gcal_event_id || alert.skip_reason) return;

    const clientId = await deterministicEventId(`owner-alert:${row.id}`, userId);
    let eventId: string;
    try {
      eventId = await deps.createOwnerAlertEvent(
        email,
        alert.calendar_id,
        ownerAlertBody({ startsAt: booking.starts_at, timezone: booking.timezone }),
        clientId,
      );
    } catch (err) {
      const kind = reachabilityFromError(err);
      // `gone` or `not-provisioned`: retrying can never reach this calendar, and this
      // is an informational nicety, not a booking. Record which one it was and stop,
      // so the row explains its own silence and nothing pages about an advisor whose
      // Google account a Workspace admin has to fix.
      if (isDefinitiveFailure(kind)) {
        await deps.recordOwnerAlertSkip(alert.id, kind);
        return;
      }
      throw err; // transient: the drain comes back
    }
    await deps.setOwnerAlertEventId(alert.id, eventId);
  },

  /**
   * #2372: the sales side is told that a lead's call went to the advisor who owns
   * them. The last of the Pipedream owner reassign flow's five steps to move into
   * Slate, and it posts as Slate's own app rather than through a Slack Workflow.
   *
   * Gated exactly as the calendar alert above is (`isOwnerAlertReassign`): an ADMIN
   * choosing "Owner reassignment" for a coverage move has not routed anybody back to
   * an advisor they have spoken with, and saying so would be a claim nothing measured.
   *
   * It posts ONLY to the handoff channel and never falls back to the alerts or info
   * channel. This is a sales notice; landing it in the channel somebody is paged in
   * is how a paging channel stops being read (L36).
   *
   * Four outcomes, and they are deliberately not four shades of one:
   *
   *  - switched OFF on /admin/alerts (migration 0188): the step completes without
   *    posting or reading the channel, and records `switched_off` on the step, which
   *    the weekly withheld count (#2440) deliberately does not count. An unreadable
   *    switch throws, so the step retries rather than guessing either way.
   *  - NO channel set: the notice is dropped, recorded in the log AND on the step
   *    as a `withheld` reason (#2440, counted weekly by the monitor lane), and the
   *    step completes. It must not page: the monitor lane already owns "handoffs are
   *    waiting and no channel is set" (#2367), and a reassign notice is not a
   *    handoff, so raising one here would invent a row nobody can resolve.
   *  - Slack REFUSED this post (`not_in_channel`, a rate limit, a timeout): the step
   *    throws, so it stays pending and the drain comes back for it.
   *  - this deployment holds NO SLACK TOKEN at all: recorded and done. No later
   *    attempt from the same deployment can be different, and a row retried to the
   *    give-up cap would raise a stuck-outbox page which is itself delivered by the
   *    Slack that is not there.
   *
   * Exactly once rests on the outbox step state, which the executor persists under
   * this holder's lease after every step, so the inline run marks it done and a later
   * drain skips it. Anything keyed differently, on the BOOKING for instance, would
   * also swallow the second notice when a lead is legitimately moved to an owner
   * twice; the row id is what identifies one reassign (the same key the webhook
   * dedupes on).
   */
  [REASSIGN_STEPS.OWNER_NOTICE]: async (deps, row) => {
    if (!row.booking_id) return;
    if (!isOwnerAlertReassign(row.payload)) return;
    const ctx = await deps.loadBookingById(row.booking_id);
    if (!ctx) return; // booking gone -> nothing to say about it
    const { booking, bucket } = ctx;
    // #396: the canary books, reassigns and cancels on the isolated SMOKE bucket
    // every six hours, so without this each pass puts a synthetic lead in front of
    // the sales team. Read off the BUCKET, which is where the flag lives; `bookings`
    // has no `is_test` column (#2369). The same choke point `fire` uses for webhooks.
    if (bucket.is_test) return;

    if (!(await deps.ownerReassignNoticeOn())) {
      return { withheld: OWNER_NOTICE_WITHHELD.switchedOff };
    }

    const channel = await deps.loadHandoffChannel();
    if (!channel) {
      log.warn("owner-notice", {
        msg: "no handoff channel is set, so the sales side was not told about an owner reassign",
        booking_id: booking.id,
        outbox_id: row.id,
      });
      // #2440: recorded on the step itself, so the monitor lane can count a blank
      // channel stretch once a week rather than leaving only this log line.
      return { withheld: OWNER_NOTICE_WITHHELD.noChannel };
    }

    const text = formatOwnerReassignNotice({
      advisorName: booking.agent_name,
      advisorEmail: booking.agent_email,
      advisorTimezone: booking.assigned_user_id
        ? await deps.advisorTimezone(booking.assigned_user_id)
        : null,
      startsAt: booking.starts_at,
      leadName: booking.attendee_name,
      bookingUrl: `${deps.appBaseUrl()}${bookingDetailHref(booking.id)}`,
    });

    const reply = await deps.postHandoffNotice(channel, text);
    if (reply.ok) return;
    if (reply.error === SLACK_NOT_CONFIGURED) {
      log.warn("owner-notice", {
        msg: "this deployment has no Slack bot token, so the owner reassign notice was dropped",
        booking_id: booking.id,
        outbox_id: row.id,
      });
      return { withheld: OWNER_NOTICE_WITHHELD.noSlack };
    }
    // Short and ours: this lands in `booking_outbox.last_error`, which the drain's
    // stuck-row page quotes.
    throw new Error(`owner reassign notice not posted: ${reply.error ?? "no reason given"}`);
  },
};

/** The lead's manage page for one booking, on the given base URL. The one place
 *  that path is spelled, so the webhook, the confirm response, the calendar entry
 *  and the ICS link's redirect for a cancelled call (#2648) all send a lead to the
 *  same page. */
export function manageUrlFor(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/booking/manage/${token}`;
}

function manageUrl(deps: Pick<BookingDeps, "appBaseUrl">, token: string): string {
  return manageUrlFor(deps.appBaseUrl(), token);
}

/**
 * The lead's OTHER active booking, as much of it as we may show them.
 *
 * #1340: the match answers two questions that must be graded differently.
 * "Is this likely the same person, so don't double-book them" stays LOOSE: a
 * weak, one-signal match still counts, so the dedupe / refusal path is
 * unchanged. "May we show this person that booking and hand over its manage
 * token" is STRICT, because the manage token is the ONLY thing protecting that
 * booking and it can reschedule or cancel it. A shared household phone or a
 * couple on one email address grades `weak` (findPersonMatch), so a weak match
 * gets `disclose: false` and carries no start time and no link.
 */
export type DuplicateWarning =
  | {
      /** Identity is solid enough (strong / medium) to name the booking. */
      disclose: true;
      /** Start of the lead's OTHER active booking (ISO instant). */
      startsAt: string;
      /** Manage link for that booking, so they can view or cancel it. */
      manageUrl: string;
    }
  | {
      /** Same person by ONE signal only. Reveals nothing about the booking. */
      disclose: false;
    };

/** Match strengths that may be shown the matched booking's details + token. */
const DISCLOSABLE_MATCH: ReadonlySet<MatchStrength> = new Set<MatchStrength>([
  "strong",
  "medium",
]);

/**
 * After a booking succeeds, find the lead's OTHER active booking so the
 * confirmation screen can warn them (#626).
 *
 * Since #1337 the public booker DECLINES a second booking before creating it, so
 * this is no longer the ordinary path: it is the BACKSTOP for the window that
 * refusal cannot cover, which since #1641 is two simultaneous confirms both
 * passing the check. When a duplicate does reach here, the lead is told.
 *
 * It is NOT a backstop for a failed lookup, and was never able to be one: it runs
 * the same query on the same table, so the read that failed for `findExistingCall`
 * fails here too and this returns no warning (L345). That is why the lookup
 * failure is now refused up front rather than warned about afterwards (#1641).
 *
 * Reuses the same identity grading (findPersonMatch) and candidate lookup as the
 * dedupe path; this wrapper only drops the just-created row and decides how much
 * of the match may be disclosed (#1340).
 */
export async function findDuplicateWarning(
  input: {
    excludeBookingId: string;
    salesforceId: string | null;
    attendee: { email?: string; phone?: string };
    /** The world the booking was just made in (#2660). */
    isTest: boolean;
  },
  deps: Pick<BookingDeps, "findActiveBookingsForPerson" | "appBaseUrl">,
): Promise<DuplicateWarning | null> {
  const identity: PersonIdentity = {
    externalId: null,
    salesforceId: input.salesforceId,
    email: input.attendee.email ?? null,
    phone: input.attendee.phone ?? null,
  };
  const candidates = (
    await deps.findActiveBookingsForPerson(identity, { isTest: input.isTest })
  ).filter((b) => b.id !== input.excludeBookingId);
  const match = findPersonMatch(identity, candidates);
  if (!match) return null;
  if (!DISCLOSABLE_MATCH.has(match.strength)) return { disclose: false };
  return {
    disclose: true,
    startsAt: match.booking.starts_at,
    manageUrl: manageUrl(deps, match.booking.manage_token),
  };
}

/** Max reservations completed at once when draining a backlog (AUD-062). Rows are
 *  leased independently so concurrency never double-runs one; the cap keeps the
 *  per-row create/webhook calls under the same subrequest ceiling. */
const RESERVATION_DRAIN_CONCURRENCY = 6;

/**
 * The active call this person already has, or null to go ahead and book.
 *
 * Fails CLOSED, loudly (#1641, reversing the original call). A lookup that ERRORS
 * knows nothing about this lead, and the empty list it used to produce is not
 * "nothing found", it is the specific claim "this person has no call", which is
 * exactly what creates the duplicate. The full reasoning, including why the
 * confirmation-screen backstop cannot cover this particular failure, is on
 * `ExistingCallCheckUnavailableError`.
 *
 * The detail goes to the log; the lead gets one short sentence and a retry.
 */
async function findExistingCall(
  input: CreateBookingInput,
  deps: BookingDeps,
  world: PersonWorld,
): Promise<ExistingCall | null> {
  return findExistingCallForIdentity(personIdentityOf(input), deps, world);
}

/**
 * The bucket part of a confirm's idempotency key (#2638).
 *
 * A request whose link carried a routable code, or which never said what its
 * link carried (the direct booking API), keys on its bucket code exactly as it
 * always has, so a booking in flight across the deploy still matches its retry.
 * One whose link carried NO routable code is routed by Salesforce, which can
 * answer differently or not at all on the retry, so it keys on the RAW link code
 * instead, under a prefix no bucket code carries. With the lead id already in the
 * key, that is stable across every retry of the same submit.
 */
export function idempotencyCodeFor(
  input: Pick<CreateBookingInput, "bucketCode" | "requestedCode" | "agentLinkUserId">,
): string {
  // #2073: a named link booking keys on the AGENT, under a prefix no bucket code
  // carries. The bucket it lands in is derived from the agent's attributes and
  // can move between a submit and its retry; the agent the link names cannot.
  if (input.agentLinkUserId !== undefined) return `agent-link:${input.agentLinkUserId}`;
  if (input.requestedCode === undefined) return input.bucketCode;
  if (resolveRequestedCode(input.requestedCode).kind === "valid") return input.bucketCode;
  return `unrouted:${input.requestedCode}`;
}

/**
 * The bucket code a booker confirm routes on (#2638), and the record of where it
 * came from. A routable code on the link is left exactly as the caller posted it;
 * anything else is decided by `resolveRoutingCode`, which asks Salesforce when the
 * link names a lead and THROWS `LeadCodeUnavailableError` when that read fails.
 */
async function routeOnLeadCode(
  input: CreateBookingInput,
  deps: BookingDeps,
): Promise<{ input: CreateBookingInput; codeSource: RoutingCodeRecord | undefined }> {
  if (input.requestedCode === undefined) return { input, codeSource: undefined };
  const routed = await resolveRoutingCode(input.requestedCode, input.salesforceId ?? null, deps.readLeadXbc, {
    id: partnerKeysFrom(input.prefill).submissionId,
    readLeadId: deps.readSubmissionLead,
  });
  if (routed.source === "link") {
    // #3508: the landing may have shown (and the Booker posted) the lead's current
    // score in place of a stale link code; record it, so the booking does not read
    // as routed on the link while sitting with another team.
    const shown = input.bucketCode !== routed.code ? { shown: input.bucketCode } : {};
    return { input, codeSource: { ...routed.record, ...shown } };
  }
  return { input: { ...input, bucketCode: routed.code }, codeSource: routed.record };
}

/**
 * The call this person already has, graded for disclosure, from an identity alone.
 *
 * Split out of the confirm path in #2166 so the BOOKER'S LANDING can ask the same
 * question. On `/booking/{salesforceId}` the id in the path is a strong match, the
 * same identity the confirm recognises them by, so the lead is known from the first
 * render and there is nothing to wait for. Asking it later means the notice arrives
 * one picked time and one filled form too late, which reads as the product having
 * forgotten them.
 *
 * ONE grader for both, deliberately. Two would be two opinions about who may be
 * shown a booking, and the looser one would decide (L70, #1340).
 */
export async function findExistingCallForIdentity(
  identity: PersonIdentity,
  deps: BookingDeps,
  /** The world of the bucket in play (#2660), named by the caller: the landing
   *  page from the row it read, the confirm from the bucket it resolved. */
  world: PersonWorld,
): Promise<ExistingCall | null> {
  let match: PersonMatch | null;
  try {
    match = findPersonMatch(identity, await deps.findActiveBookingsForPerson(identity, world));
  } catch (err) {
    // The full read error goes here and only here; the lead sees the error's own
    // one-sentence message (src/lib/api/errors.ts convention).
    log.error(
      "booking",
      { msg: "existing-call check failed; refusing rather than booking" },
      err,
    );
    throw new ExistingCallCheckUnavailableError();
  }
  if (!match) return null;
  if (!DISCLOSABLE_MATCH.has(match.strength)) return { disclose: false };
  return {
    disclose: true,
    startsAt: match.booking.starts_at,
    // Read live, and left null rather than guessed when unresolvable.
    advisorName: await deps
      .loadAgentDisplayName(match.booking.assigned_user_id ?? null)
      .catch(() => null),
    manageToken: match.booking.manage_token,
    rescheduleTimesFrom: rescheduleTimesFrom(match.booking),
    mayCancel: match.strength === "strong",
    // #2213: the whole number. The panel let a recognised lead move and cancel and
    // not correct the number the advisor will ring, once #2203 took the details
    // form off that path, and showing it whole is what lets them read back exactly
    // what Slate holds. Blank reads as none, because a column holding spaces
    // arrives through the API and through an import, and " " is not a number
    // anybody can be told we will call.
    phone: (match.booking.attendee_phone ?? "").trim() || null,
  };
}

/**
 * A bucket already resolved by code earlier in the same request (#2670), so a
 * later step can reuse it rather than read the same row again. Carries the CODE
 * it was resolved for, because a step may only reuse it for that same code.
 */
export interface KnownBucket {
  code: string;
  resolved: { bucket: Bucket; eventType: EventType };
}

export async function createBooking(
  requestedInput: CreateBookingInput,
  deps: BookingDeps,
  /**
   * #2670: the direct booking API resolves the bucket before the person decision
   * (#2660), and hands it here so the create does not read it a second time. Used
   * only when it was resolved for the very code this create books into; any other
   * code (a booker confirm rerouted on the lead's Salesforce code) is resolved as
   * before. The test bucket check below still runs on it either way.
   */
  opts: {
    requested?: KnownBucket;
    /**
     * #3257: the caller already holds this slot's turn in the confirm line and will
     * report the verdict itself (the direct booking API, which enters the line
     * before its person decision). Entering again would wait behind itself.
     */
    held?: HeldTurn;
  } = {},
): Promise<BookingResult> {
  return (await createBookingWithVerdict(requestedInput, deps, opts)).result;
}

/**
 * The idempotency key a confirm collapses onto (#2638), from the request alone.
 *
 * A STABLE key (caller supplied, or derived from the lead's contact identity) is
 * what lets a re-submit collapse onto the same booking. Anonymous bookings have
 * none (idempotencyKeyFor returns null). Built from what a retry sends again
 * unchanged, never from the pool Salesforce resolves (`idempotencyCodeFor`), so a
 * retry of a confirm that already booked matches it without a second Salesforce
 * call: an outage on the retry, or a score that moved between the two, would
 * otherwise refuse the retry or miss the original and book a second call.
 *
 * Pure, so the confirm line can recognise a double submit before any read
 * (#3257), and shared so the API entry and the create cannot key it differently.
 */
export function stableKeyFor(input: CreateBookingInput): string | null {
  return (
    input.idempotencyKey ??
    idempotencyKeyFor({
      bucketCode: idempotencyCodeFor(input),
      startIso: input.startIso,
      email: input.attendee.email,
      phone: input.attendee.phone,
      salesforceId: input.salesforceId,
    })
  );
}

/**
 * The confirm line a request joins, when it is known before any read (#3257).
 *
 * The line is one bucket, one instant and, for a named link, one advisor, and all
 * three are in the request, so almost every confirm can join it before reading
 * anything. The exception is a booker link carrying NO routable code: Salesforce
 * decides its bucket (`routeOnLeadCode`), so the code it names is not the code it
 * books, and a "full" verdict from a confirm in one bucket would refuse a confirm
 * that is really in another. That one returns null and joins after routing.
 */
export function queueKeyBeforeRouting(
  input: Pick<CreateBookingInput, "bucketCode" | "startIso" | "requestedCode" | "agentLinkUserId">,
  lineGroupOf?: (code: string) => string | null,
): LineKey | null {
  const known =
    input.agentLinkUserId !== undefined ||
    input.requestedCode === undefined ||
    resolveRequestedCode(input.requestedCode).kind === "valid";
  return known ? confirmQueueKey(input.bucketCode, input.startIso, input.agentLinkUserId, lineGroupOf) : null;
}

/**
 * Who a confirm is about, as every person check reads it: the direct booking
 * API's person decision, the booker's one call per person gate, and the confirm
 * line's check for a lead who already holds the time (#3257). One builder, so the
 * three can never key a person three ways (L41).
 */
export function personIdentityOf(input: CreateBookingInput): PersonIdentity {
  return {
    externalId: input.externalId ?? null,
    salesforceId: input.salesforceId ?? null,
    email: input.attendee.email ?? null,
    phone: input.attendee.phone ?? null,
  };
}

/**
 * What a leader that settled its slot hands the confirms waiting behind it.
 *
 * `booked` is its own booking, for a double submit of it. `seated` is every active
 * booking at the instant (#3257), so a follower that already holds the time is
 * not told it is taken. Null when nobody was waiting when the leader reported, so
 * the read was not worth making; a follower arriving in that moment then cannot
 * rule itself out and runs its own person check.
 */
export interface SlotSettlement {
  booked: ConfirmTaker | null;
  seated: Booking[] | null;
}

/** Where a confirm stands in its slot's line. */
interface LineStanding {
  key: LineKey;
  stableKey: string | null;
  bucketCode: string;
  startIso: string;
  person: PersonIdentity;
}

/**
 * One turn in the confirm line (#3221), shared by the create and the direct
 * booking API so the two cannot answer a waiting confirm two different ways.
 *
 * The leader runs `work` and reports its verdict, a failure included. A follower
 * whose leader settled the slot is answered from that verdict without a read of
 * its own: its own booking back when it is a double submit of the leader, else
 * the slot is taken, UNLESS it already holds the time (#3257).
 *
 * A follower that already holds it, by the same grader the person decision uses
 * (`findPersonMatch`) over who sits at the instant, runs its own chain rather than
 * being answered, so the answer it gets IS the person decision's: deduped, the
 * #1465 bucket move or its refusal, confirm required, or the booker's "you already
 * have a call". Matching here only decides who asks; it never discloses anything,
 * so it may be loose, while what is shown stays with the real decision (#1340).
 * At most the pool's own advisors can hold the instant, so this never becomes a
 * crowd reading the database.
 *
 * A follower whose wait runs out (`confirmLineWaitMs`) is answered retryably at
 * once: it has only the reserve left, too little to run a chain of its own.
 */
async function inConfirmTurn<R>(
  deps: BookingDeps,
  line: LineStanding,
  work: (held: HeldTurn) => Promise<{ result: R; verdict: LeaderVerdict<ConfirmTaker> }>,
  fromTaker: (taker: ConfirmTaker) => R,
  /**
   * #3257: one cheap read that may answer this confirm without the line at all
   * (a replay of a booking that already exists), or null to join it. Made only
   * when the line is BUSY and a lookahead is free (`ConfirmQueue.lookahead`), so a
   * replay is never kept waiting behind a confirm still booking, while a crowd
   * still sends at most `CONFIRM_LINE_LOOKAHEAD` such reads past the line.
   */
  ahead?: () => Promise<R | null>,
): Promise<{ result: R; verdict: LeaderVerdict<ConfirmTaker> }> {
  // #3354: before the FIRST call into the line, which on the API path is the
  // lookahead: that is where the switch read and the first round trip happen.
  deps.mark?.("line_start");
  // #3300: the line's own calls and the wait for a turn, as stages of the profile,
  // so a confirm that spent its budget waiting in line says so.
  let waitMs: number;
  let turn: Awaited<ReturnType<BookingDeps["confirmQueue"]["enter"]>>;
  try {
    const giveBack = ahead
      ? await timeStage(deps.profile, "line-lookahead", () => deps.confirmQueue.lookahead(line.key, confirmLineWaitMs(budgetLeftMs())))
      : null;
    if (giveBack && ahead) {
      let early: R | null = null;
      try {
        early = await timeStage(deps.profile, "line-ahead-read", ahead);
      } catch (err) {
        // The lookahead is a shortcut, never a gate: a read that fails here is
        // treated as finding nothing, and the confirm joins the line, where the
        // leader's own reads (or its own, when it leads) answer it properly.
        log.warn(
          "booking",
          { msg: "the replay check ahead of the confirm line failed; joining the line instead", bucket_code: line.bucketCode },
          err,
        );
      } finally {
        await giveBack();
      }
      // Answered without the line, so it settles nothing for anybody in it.
      if (early !== null) {
        deps.mark?.("line_turn");
        return { result: early, verdict: { full: false } };
      }
    }
    waitMs = confirmLineWaitMs(budgetLeftMs());
    turn = await timeStage(deps.profile, "confirm-line", () => deps.confirmQueue.enter(line.key, waitMs));
  } finally {
    // #3351: a lookahead on the shared line can keep a lead or a ticket for the enter
    // that follows. Whatever way this entry ends, anything it kept is given back, so
    // the line is never held for a confirm that left; once the enter came, nothing.
    // Best effort: a give back that fails is logged and never replaces the entry's own
    // outcome, an error included.
    try {
      await deps.confirmQueue.release();
    } catch (err) {
      log.warn("booking", { msg: "giving back what a lookahead kept on the confirm line failed", bucket_code: line.bucketCode }, err);
    }
  }
  // #3354: the line has answered, whether with a turn, a refusal or a timeout.
  deps.mark?.("line_turn");
  // #3489 step 3: a lead whose walk found its ladder spent only by claims still in
  // flight PARKS and waits again, and whatever the line answers next is handled
  // exactly as the first answer was: refused, timed out, or a lead that reads again.
  // What its walk found, kept for the answer that says the walk stands.
  let walkedPast: LadderSpentByClaimsError | null = null;
  for (;;) {
    if (turn.kind === "refused") {
      const settled = turn.settled;
      // A double submit queued behind its own first submit gets that booking back,
      // as it would from the idempotency key had the two not been in line.
      if (line.stableKey && settled?.booked && settled.booked.idempotencyKey === line.stableKey) {
        return { result: fromTaker(settled.booked), verdict: { full: false } };
      }
      if (!settled?.seated || findPersonMatch(line.person, settled.seated)) {
        log.info("booking", {
          msg: "confirm waited behind one that settled the slot and may already hold the time, so it runs its own person check",
          bucket_code: line.bucketCode,
          seated_known: Boolean(settled?.seated),
        });
        return work({ seat: null, queued: true });
      }
      log.info("booking", {
        msg: "confirm waited behind one that settled the slot, refused without running",
        bucket_code: line.bucketCode,
        refusal: turn.refusal,
      });
      // #3272: answered from the leader's verdict, so the stage is the line's, and the
      // leader's refusal rides along. It reaches the confirm line, never a routing
      // decision row: writing one would put a bucket read and an insert on every one
      // of a crowd waiting behind a full slot, the very reads the line exists to keep
      // off it (#3257, test-confirm-contention). The leader's row is the slot's record.
      // #3338: a leader settles the line only when its whole ladder was spent
      // (`verdictForRefusal`, and the booked case in `createHeld`), so a follower
      // answered from that verdict was refused with the ladder spent too.
      throw traced(turn.refusal === "race" ? new RaceLostRefusalError(1, false, true) : new SlotUnavailableError(), {
        requestedStart: line.startIso,
        bucketCode: line.bucketCode,
        stage: "follower",
        rungs: [],
        leaderRefusal: turn.refusal,
        leadId: refusedLeadId(line.person),
      });
    }
    if (turn.kind === "unqueued") {
      log.warn("booking", {
        msg: "confirm waited out the one ahead of it in line; answering retryably rather than starting work it has no time to finish",
        bucket_code: line.bucketCode,
        wait_ms: waitMs,
      });
      throw new DependencyTimeoutError(
        { label: "the confirm ahead of it in line", timeoutMs: waitMs, budget: null },
        null,
      );
    }
    const lead = turn;
    // The turn's end is reported however the work ends, and however the settling read
    // ends: a report that never arrives holds the line until its lease runs out (#3325).
    //
    // #3462: and exactly ONCE. A leader that lost the insert race with nobody to hand
    // to reports from inside its work (`lostRace`), before its rollback; the report
    // after the work is then this same one, never a second, which could only say less
    // (a rollback that failed would read as nothing settled). Awaiting the same promise
    // is also what surfaces a failed early report where a failed report always surfaced.
    let reporting: Promise<void> | null = null;
    // #3489: how this confirm's claim ended, for the line (`ClaimOutcome`). Only once it
    // has said `trying` can it know: before that its advisor is untried, which the line
    // decides itself, so this reports `unknown` and the line reads it as untried.
    let tried = false;
    // #3489 step 3: whether a crowd stood behind this confirm, so a booking reads who is
    // seated for a pending verdict its end may complete. Learnt from the line at no extra
    // call: it waited, it was released, or a claim saw others waiting or claiming.
    let crowd = lead.queued || lead.start !== undefined;
    const seat: SharedSeat = {
      ...lead.seat,
      trying: async (userId) => {
        tried = true;
        await lead.seat.trying(userId);
      },
      claimFirst: async (candidates, place) => {
        const answer = await lead.seat.claimFirst(candidates, place);
        if ((answer.waiting ?? 0) > 0 || answer.unclaimed < candidates.length) crowd = true;
        return answer;
      },
    };
    const report = (verdict: LeaderVerdict<ConfirmTaker>, outcome: ClaimOutcome) =>
      (reporting ??= timeStage(deps.profile, "line-report", async () => {
        let settled: LeaderVerdict<SlotSettlement> = { full: false };
        let settlement: SlotSettlement | undefined;
        try {
          settled = await settleSlot(deps, line, verdict, await lead.waiting());
          if (!verdict.full && outcome === "booked" && crowd && verdict.booked) settlement = await seatedNow(deps, line, verdict.booked);
        } finally {
          await lead.done(settled, tried ? outcome : "unknown", settlement);
        }
      }));
    const lostRace = async (refusal: LostRaceRefusal) => {
      try {
        await report(lostRaceVerdict(refusal), "lost-race");
      } catch {
        // Surfaced by the closing report below, which awaits this same promise, so the
        // leader's rollback and bookkeeping still run in full first.
      }
    };
    // #3489 step 3: its walk stands (`LineTurn.spent`): every claim it walked past has
    // since booked, so the ladder is spent as its own walk found it. It says so and
    // refuses with what the walk found, rather than walking the whole ladder again.
    // #3529: unless the person may already sit at the instant (their other submit just
    // booked), the question every other refusal the line hands out asks first: then it
    // runs, and its own person decision answers them from the call they hold.
    if (lead.spent && walkedPast && !(await personMayHoldInstant(deps, line))) {
      const refusal = walkedPast.refusal;
      // #3529: on record like any refusal; best effort, the recorder never throws.
      await walkedPast.recordRefusal?.();
      await report(verdictForRefusal(refusal), claimOutcomeOf(refusal));
      throw refusal;
    }
    let done: { result: R; verdict: LeaderVerdict<ConfirmTaker> };
    try {
      done = await work({ seat, queued: lead.queued, lostRace, ...(lead.start ? { start: lead.start } : {}) });
    } catch (err) {
      // #3489 step 3: not a refusal. Nothing was reported, so the turn is still this
      // confirm's to end, by parking.
      if (err instanceof LadderSpentByClaimsError && reporting === null) {
        walkedPast = err;
        log.info("booking", {
          msg: "every rung this confirm could book is held by confirms still in flight; waiting in the line for them",
          bucket_code: line.bucketCode,
        });
        turn = await timeStage(deps.profile, "line-park", () => lead.park(confirmLineWaitMs(budgetLeftMs())));
        continue;
      }
      await report(verdictForRefusal(err), claimOutcomeOf(err));
      throw err;
    }
    await report(done.verdict, "booked");
    return done;
  }
}

/**
 * #3529: whether the person behind this confirm may already hold its instant, asked
 * before a walk that stands refuses them. Unreadable is a yes: the confirm then runs its
 * own person decision, which reads for itself, rather than refusing somebody who may
 * hold the time on a read that never happened.
 */
async function personMayHoldInstant(deps: BookingDeps, line: LineStanding): Promise<boolean> {
  try {
    return findPersonMatch(line.person, await deps.findActiveBookingsStartingAt(line.startIso)) !== null;
  } catch (err) {
    log.warn("booking", { msg: "could not read who holds the instant before a walk that stands refused, so the confirm runs its own person check", bucket_code: line.bucketCode }, err);
    return true;
  }
}

/**
 * #3489 step 3: who sits at the instant as a booking that saw a crowd ends: the
 * settlement a pending verdict this end completes is answered with. A read that fails
 * gives none, so the line never answers from a stale one and lets one confirm read.
 */
async function seatedNow(deps: BookingDeps, line: LineStanding, booked: ConfirmTaker): Promise<SlotSettlement | undefined> {
  try {
    return { booked, seated: await deps.findActiveBookingsStartingAt(line.startIso) };
  } catch (err) {
    log.warn(
      "booking",
      { msg: "could not read who holds the instant as a booking ended, so the line lets one confirm read for itself", bucket_code: line.bucketCode },
      err,
    );
    return undefined;
  }
}

/**
 * #3489: how a confirm's claim ended when its confirm threw, for the line. A lost race
 * and a slot every advisor on the ladder was found busy for say what became of the
 * advisor; anything else (an outage, a deadline, a refusal before booking) says nothing
 * certain, so `unknown`, never handed on.
 */
function claimOutcomeOf(err: unknown): ClaimOutcome {
  if (err instanceof RaceLostRefusalError) return "lost-race";
  if (err instanceof SlotUnavailableError) return "advisor-busy";
  return "unknown";
}

/**
 * The verdict a leader reports, with who sits at the instant when it settles the
 * slot and somebody is waiting (#3257). A read that fails settles nothing: no
 * follower could then be told for sure that the time is not theirs, so the next
 * one in line runs for itself, and its own read settles the rest.
 */
async function settleSlot(
  deps: BookingDeps,
  line: LineStanding,
  verdict: LeaderVerdict<ConfirmTaker>,
  waiting: number,
): Promise<LeaderVerdict<SlotSettlement>> {
  if (!verdict.full) return { full: false };
  if (waiting === 0) return { ...verdict, settled: { booked: verdict.settled, seated: null } };
  let seated: Booking[];
  try {
    seated = await deps.findActiveBookingsStartingAt(line.startIso);
  } catch (err) {
    log.warn(
      "booking",
      {
        msg: "could not read who holds the instant, so the next confirm in line runs for itself",
        bucket_code: line.bucketCode,
        waiting,
      },
      err,
    );
    return { full: false };
  }
  return { ...verdict, settled: { booked: verdict.settled, seated } };
}

/**
 * A turn in the confirm line that a caller already holds (#3257): `seat` is its
 * claim on an advisor, or null when it is running outside the line (a lead who
 * already holds the time, answered by its own chain).
 */
export interface HeldTurn {
  seat: SharedSeat | null;
  /**
   * #3529: the create is a bucket MOVE (`moveToRequestedBucket`), which never walks past
   * a rung for claims (`ClaimPlace.canWalk`): one that did parked behind the crowd and
   * could be answered "taken" where a move's own rule keeps the lead's call.
   */
  move?: true;
  /** #3489: what the line released this confirm with (`LineTurn.start`), if anything. */
  start?: StartFrom;
  /** #3338: the confirm waited behind another for this turn (`LineTurn.queued`). */
  queued: boolean;
  /**
   * #3462: tells the line NOW how this confirm's lost insert race ended when it is
   * refused with nothing more to ask, so the confirms waiting behind it are answered
   * while it still rolls the lost attempt back and records the refusal. That work
   * cannot change what they are owed. The verdict comes from `lostRaceVerdict`, the
   * same one the closing report would give, so the two can never disagree: full only
   * when the ladder is spent (#3338). The turn reports once, so its report at the end
   * is then skipped. Never throws: a report that fails is surfaced by that closing
   * report, exactly where a failed report always surfaced, so the rollback still runs.
   *
   * Absent outside the line, and wherever the refusal does not reach the line as
   * the lost race: a bucket move that answers it as a declined move
   * (`moveToRequestedBucket`), whose turn reports that nothing settles.
   */
  lostRace?: (refusal: LostRaceRefusal) => Promise<void>;
}

/**
 * The booking an earlier submit with this idempotency key already made, as the
 * create returns it, or null. The one replay read, made inside the line by a
 * leader and ahead of it by a confirm arriving at a busy line (#3257).
 */
async function replayOf(deps: BookingDeps, stableKey: string): Promise<BookingResult | null> {
  const existing = await deps.findBookingByIdempotencyKey(stableKey);
  return existing ? { booking: existing, manageUrl: manageUrl(deps, existing.manage_token) } : null;
}

/** A booking a waiting double submit is handed back, as the create returns it. */
function bookingFromTaker(taker: ConfirmTaker): BookingResult {
  return { booking: taker.result.booking, manageUrl: taker.result.manageUrl };
}

/**
 * `createBooking`, with the verdict its confirm showed about the slot, so a caller
 * holding the turn itself (the direct booking API) can report it.
 */
async function createBookingWithVerdict(
  requestedInput: CreateBookingInput,
  deps: BookingDeps,
  opts: { requested?: KnownBucket; held?: HeldTurn },
): Promise<{ result: BookingResult; verdict: LeaderVerdict<ConfirmTaker> }> {
  const stableKey = stableKeyFor(requestedInput);
  // #3257: join the line BEFORE any read when the line is known from the request,
  // so a crowd for one slot waits for its leader rather than each doing the
  // idempotency read, the routing and the bucket read first. Those reads are what
  // timed out on 2026-10-04 (run 37229344882) with the #3221 line behind them.
  if (opts.held) return createChecked(requestedInput, deps, opts, stableKey, opts.held);
  const early = queueKeyBeforeRouting(requestedInput, deps.lineGroupOf);
  if (early === null) return createChecked(requestedInput, deps, opts, stableKey, "late");
  return inConfirmTurn(
    deps,
    {
      key: early,
      stableKey,
      bucketCode: requestedInput.bucketCode,
      startIso: requestedInput.startIso,
      person: personIdentityOf(requestedInput),
    },
    (held) => createChecked(requestedInput, deps, opts, stableKey, held),
    bookingFromTaker,
    stableKey ? () => replayOf(deps, stableKey) : undefined,
  );
}

/**
 * #3739: an advisor link confirm, with the Lead id it is saved under and where that
 * id came from (`lead-id-from-bookings.ts`).
 *
 * A link carrying an id keeps it, recorded as `link`, and reads nothing. A bare link
 * takes the one Lead id the lead's earlier bookings agree on, matched on BOTH email
 * and phone in the bucket's world, recorded as `earlier-booking`. Two different ids
 * save none and are logged. A failed read is logged and books with no id: a lead is
 * never refused because a reporting join key could not be found, and nothing
 * downstream reads the missing id as a fact about them (it is the state every bare
 * link booking was in before this).
 *
 * Salesforce is deliberately NOT asked by email when Slate holds no earlier booking:
 * that would put a second external call on the confirm path of every bare link
 * booking for a lead Slate has never booked, against a reporting gap the advisor's
 * own link can close at the source. Decided on #3739.
 */
async function withAgentLinkLeadId(
  input: CreateBookingInput,
  advisorId: string,
  isTest: boolean,
  deps: Pick<BookingDeps, "earlierLeadBookings">,
): Promise<CreateBookingInput> {
  const own = (from: LeadIdFrom | null, extra: Partial<CreateBookingInput> = {}): CreateBookingInput => ({
    ...input,
    ...extra,
    prefill: withLeadIdFrom(input.prefill, from),
  });
  if (personStrongIds(personIdentityOf(input)).length > 0) return own("link");
  const email = input.attendee.email?.trim();
  const phone = input.attendee.phone?.trim();
  if (!email || !phone) return own(null);
  let rows: EarlierLeadBookingRow[];
  try {
    rows = await deps.earlierLeadBookings({ email, phone }, { isTest });
  } catch (err) {
    log.warn("agent-link", { msg: "earlier bookings unreadable, booking with no Lead id", advisor_id: advisorId }, err);
    return own(null);
  }
  const inferred = leadIdFromEarlierBookings({ email, phone }, advisorId, rows);
  if (inferred.kind === "conflict") {
    log.warn("agent-link", {
      msg: "earlier bookings name different Leads, booking with no Lead id",
      advisor_id: advisorId,
      lead_id_count: inferred.leadIdCount,
      booking_ids: inferred.bookingIds.join(","),
    });
    return own(null);
  }
  if (inferred.kind === "none") return own(null);
  log.info("agent-link", {
    msg: "Lead id taken from an earlier booking",
    advisor_id: advisorId,
    salesforce_id: inferred.leadId,
    same_advisor: inferred.sameAdvisor,
    booking_ids: inferred.bookingIds.join(","),
  });
  return own("earlier-booking", { salesforceId: inferred.leadId });
}

/**
 * Everything a confirm checks and reads before the create proper. `held` is the
 * turn it already holds, or "late" for a confirm that could not join the line
 * before routing (a booker link Salesforce routes), which joins it here once its
 * bucket is known.
 */
async function createChecked(
  requestedInput: CreateBookingInput,
  deps: BookingDeps,
  opts: { requested?: KnownBucket },
  stableKey: string | null,
  held: HeldTurn | "late",
): Promise<{ result: BookingResult; verdict: LeaderVerdict<ConfirmTaker> }> {
  /**
   * Where this confirm's time went (#2321, #3300).
   *
   * The request's own profile, opened by the route (`answerTimed`), so a slow or
   * timed out confirm's `confirm answered` line can say where its time went. A
   * caller with none (a suite, a path no route times) gets one of its own.
   *
   * Under SLATE_LOADTEST the confirm's apportionment is ALSO logged on its own
   * `confirm-profile` line, as it was before #3300, over a window opened HERE: the
   * load run's judges read its `total_ms` and `isolate_age_ms` as measured from
   * this point (#2340, #3354), and a window keeps that meaning now that the
   * profile itself starts at the route. The 2026-09-14 load run measured the
   * request path at a CPU p99 of 4,908ms against a wall p95 of 4,025ms with no cron
   * in the window; this is WALL time, apportioned only because that run measured
   * the two as roughly equal (L355).
   */
  const profile = deps.profile ?? makeConfirmProfile({ now: () => Date.now() });
  const loadtestWindow = isLoadtest() ? profile.window(ISOLATE_READY_AT_MS) : null;
  // #3354: the end of the wait the confirm startup bar measures.
  deps.mark?.("profile");

  // Fast path: a double-click / retry of the same submit returns the existing
  // active booking instead of creating a second one (+ a second gcal event).
  // Only a stable key can match a prior booking; a synthetic key (below) is fresh
  // per request, so there's nothing to look up. It runs BEFORE the Salesforce
  // read below, so a retry of a booking that exists never depends on it.
  // #3491: the in flight reservation is read by the same key alone, so a confirm
  // that already holds its turn starts it HERE, alongside the replay, rather than
  // after the bucket, the person check and the calling window, which made it wait
  // for the two in turn (each about 130 to 220ms median, 440 to 590ms p95, on load
  // runs 20 and 21). It is still USED where it always was (`createHeld`): a replay
  // answers first and a refusal refuses first, and a failure of this read reaches
  // the lead only from there; the guard keeps it from becoming an unhandled
  // rejection on the paths that never read it. A "late" confirm has not joined the
  // line yet and may be answered as a follower without running, so it reads in its
  // turn as before: a crowd's followers add no read to the database (#3221).
  const inFlightRead: Promise<BookingReservation | null> | null =
    stableKey && held !== "late" ? deps.loadReservationByKey(stableKey) : null;
  inFlightRead?.catch(() => undefined);
  if (stableKey) {
    const existing = await profile.time("idempotency-lookup", () => replayOf(deps, stableKey));
    // A replay settles nothing about the slot for anybody else in line.
    if (existing) return { result: existing, verdict: { full: false } };
  }

  // #2638: a booker confirm whose link carried no routable code is routed on the
  // lead's Salesforce XBC when the link names the lead, and on the catch-all only
  // when Salesforce holds none. Decided HERE, on the server, before anything else
  // reads the bucket code, so the code the client posted for a rescued lead is
  // never what decides their pool. Only the booker's confirm says what the link
  // carried (`requestedCode`); the direct booking API names a bucket outright and
  // is untouched. A failed Salesforce read throws `LeadCodeUnavailableError`
  // before any write, and the route answers 503.
  // #2073: a named link does not route, so it never asks Salesforce for a code.
  const agentLinkUserId = requestedInput.agentLinkUserId;
  const { input: routedInput, codeSource } =
    agentLinkUserId !== undefined
      ? { input: { ...requestedInput, requestedCode: undefined }, codeSource: undefined }
      : await profile.time("lead-code", () => routeOnLeadCode(requestedInput, deps));

  // #2310: the lead's calling window, judged in the zone the booker was using.
  // AFTER the idempotency fast path, so a retry of a booking that already exists
  // (one made before this gate shipped, or across the deploy boundary) returns
  // it rather than being refused; BEFORE every write, so a refused time leaves
  // nothing behind. The in-flight resume below sits after this: a reservation
  // for an outside start can only predate the gate, and the reservation drain
  // completes it on its own, so refusing the retry loses nothing.
  assertWithinLeadCallingWindow(routedInput.startIso, routedInput.timezone);

  const known = opts.requested?.code === routedInput.bucketCode ? opts.requested.resolved : null;
  const resolved =
    known ??
    (await profile.time("resolve-bucket", () => deps.resolveBucketByCode(routedInput.bucketCode)));
  if (!resolved) throw new UnknownBucketError();
  const { bucket, eventType } = resolved;

  // A synthetic test bucket (#396) is unbookable on the public path unless the
  // caller may book one: the key-authed direct booking API may when its caller is
  // the canary (#2669, `mayBookTestBuckets`), and it and the Booker's confirm may
  // for the PUBLIC test bucket (#2660). To a real lead
  // a hidden one must look like the bucket doesn't exist (same error as an
  // unknown code, no hint that a hidden bucket is there).
  if (bucket.is_test && !routedInput.allowTestBuckets) throw new UnknownBucketError();

  // #3739: the Lead id an advisor link booking is saved under. After the bucket,
  // whose world the read is asked in, and before anything is written, so the row
  // carries it from the start. The provenance key is the server's on every confirm.
  const input =
    agentLinkUserId !== undefined
      ? await profile.time("lead-id-from-bookings", () => withAgentLinkLeadId(routedInput, agentLinkUserId, bucket.is_test, deps))
      : { ...routedInput, prefill: withLeadIdFrom(routedInput.prefill, null) };

  // #3221: confirms for one slot take turns within this isolate. Before this a
  // hundred at once each ran the whole path below with a hundredth of the
  // isolate, all ran out of budget together, and nobody was booked. The leader
  // runs; when its confirm shows the slot is full, everybody waiting is answered
  // from that without doing the work, so the first in wins and the rest are told
  // the time is taken in moments. See `confirm-queue.ts`.
  //
  // #3257: most confirms joined the line before any of the reads above
  // (`createBookingWithVerdict`) and already hold their turn here. Only a booker
  // link Salesforce routed joins now, once its bucket is known.
  const ctx: HeldCreate = { input, stableKey, agentLinkUserId, codeSource, bucket, eventType, profile, loadtestWindow, seat: null, queued: false, inFlightRead };
  if (held !== "late") return createHeld({ ...ctx, seat: held.seat, queued: held.queued, lostRace: held.lostRace, start: held.start, ...(held.move ? { move: true as const } : {}) }, deps);
  return inConfirmTurn(
    deps,
    {
      key: confirmQueueKey(input.bucketCode, input.startIso, agentLinkUserId, deps.lineGroupOf),
      stableKey,
      bucketCode: input.bucketCode,
      startIso: input.startIso,
      person: personIdentityOf(input),
    },
    (turn) => createHeld({ ...ctx, seat: turn.seat, queued: turn.queued, lostRace: turn.lostRace, start: turn.start }, deps),
    bookingFromTaker,
  );
}

/** What `createBooking` hands the part of the confirm that runs in turn. */
interface HeldCreate {
  input: CreateBookingInput;
  stableKey: string | null;
  agentLinkUserId: string | undefined;
  codeSource: RoutingCodeRecord | undefined;
  bucket: Bucket;
  eventType: EventType;
  profile: ConfirmProfile;
  /** The load test's window over this confirm (#2321), or null off the load test. */
  loadtestWindow: { read(): ConfirmProfileReading } | null;
  /** #3257: this confirm's claim on an advisor in its slot's line, or none. */
  seat: SharedSeat | null;
  /** #3491: the in flight reservation read, started with the replay; null to read it here. */
  inFlightRead: Promise<BookingReservation | null> | null;
  /** #3338: it waited behind another confirm for its turn (`LineTurn.queued`). */
  queued: boolean;
  /** #3462: tells the line at once how a lost race was refused (`HeldTurn.lostRace`). */
  lostRace?: (refusal: LostRaceRefusal) => Promise<void>;
  /** #3489: what the line released this confirm with (`HeldTurn.start`). */
  start?: StartFrom;
  /** #3529: a bucket move, which never walks past claims (`HeldTurn.move`). */
  move?: true;
}

/**
 * The refusal columns of a routing decision (#3272), from the trace the refusal
 * carries. With no trace (an error thrown before any rung measured anything) the
 * instant is still recorded, since the request named it, and the stage is left
 * null rather than guessed.
 */
function refusalRecord(
  trace: RefusalTrace | null,
  startIso: string,
  person: { salesforceId?: string | null; externalId?: string | null },
): Pick<RecordRoutingDecisionInput, "requestedStart" | "refusalStage" | "stageCounts" | "leadId"> {
  return {
    requestedStart: trace?.requestedStart ?? startIso,
    // A follower writes no row (see `inConfirmTurn`), so it never reaches here.
    refusalStage: trace && trace.stage !== "follower" ? trace.stage : null,
    stageCounts: trace ? trace.rungs.map(rungCounts) : null,
    leadId: refusedLeadId(person),
  };
}

/** A client sent stamp as the ISO instant it names, or null when it names none (#3797). */
function storableStamp(stamp: string | undefined): string | null {
  const ms = parseStampMs(stamp);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * #3797: judge a refusal at the cached free check against the list the lead picked
 * from, or null when it is not one (another stage, a race lost at the insert, deps
 * with no judge). NEVER throws: the refusal must still be recorded, and a judgement
 * that failed is `unknown` when there was a list to judge, which counts exactly as a
 * refusal did before. Unknown is never folded into a race.
 */
async function judgeOffer(
  deps: Pick<BookingDeps, "judgeRefusedOffer">,
  err: unknown,
  trace: RefusalTrace | null,
  servedComputedAt: string | null,
  eventType: Pick<EventType, "duration_min" | "buffer_before_min" | "buffer_after_min">,
): Promise<{
  verdict: OfferVerdict | null;
  staleRowCodes: string[];
  storedRows?: { bucket_code: string; payload: unknown; computed_at: string }[];
} | null> {
  if (!deps.judgeRefusedOffer || !trace || trace.stage !== "candidate_read_empty") return null;
  if (!(err instanceof SlotUnavailableError) || err instanceof RaceLostRefusalError) return null;
  try {
    return await deps.judgeRefusedOffer({ trace, servedComputedAt, eventType });
  } catch (failed) {
    log.warn("booking", { msg: "could not judge a refused time against the list it was offered from", bucket_code: trace.bucketCode }, failed);
    return { verdict: servedComputedAt ? "unknown" : null, staleRowCodes: [] };
  }
}

/** What a waiting double submit needs to recognise its own booking (#3221). */
export interface ConfirmTaker {
  idempotencyKey: string;
  result: BookingResult;
}

/**
 * The line a confirm joins (#3325): a GROUP whose confirms can settle each other,
 * and the instant. For a named link the group is the advisor it names, whichever
 * code the link came through, since two links to one advisor contend for the same
 * person and two to different advisors never do; otherwise it is the bucket's code.
 * The instant is parsed, so two spellings of one moment share a line.
 */
export function confirmQueueKey(
  bucketCode: string,
  startIso: string,
  agentLinkUserId: string | undefined,
  /**
   * #3325: the code's LADDER group when this isolate knows every rung's pool
   * (`ladderGroupOf`), so sibling codes that walk the same pools share one line;
   * null or absent keeps the code's own line. Never asked for a named link.
   */
  lineGroupOf?: (code: string) => string | null,
): LineKey {
  const group = agentLinkUserId !== undefined ? `link:${agentLinkUserId}` : codeLineGroup(bucketCode, lineGroupOf);
  return { group, instant: String(Date.parse(startIso)) };
}

/**
 * What a confirm that FAILED shows the confirms waiting behind it. Only a refusal
 * that spent the whole LADDER settles the slot for them (#3338), because they
 * asked the same question of the same slot and walk the same pools at every rung:
 * a walk on which every rung was refused or empty and at least one rung had people
 * who could not take the time (`provesLadderSpent`), and a lost race only
 * when nothing was left below it either (`ladderExhausted`), never at the bound,
 * which stopped while the rung was still handing out advisors (L11). Anything else
 * says nothing about them, so the next one runs, from the top of the ladder like
 * any confirm: an outage, a person already holding a call, the lead's own calling
 * window, a lost race that could not ask the rest of the ladder, and a taken time
 * that never walked the ladder at all, which is a reschedule's own bucket. (A
 * resumed reservation whose pin was taken walks the ladder since #3837, so its
 * refusal is an ordinary walk's.) Being a `SlotUnavailableError` is not the test: a
 * refusal is full only where it was MARKED as proving the ladder spent.
 */
function verdictForRefusal(err: unknown): LeaderVerdict<ConfirmTaker> {
  if (err instanceof RaceLostRefusalError) return lostRaceVerdict({ ladderExhausted: err.ladderExhausted, boundHit: err.boundHit });
  if (provesLadderSpent(err)) return { full: true, refusal: "taken", settled: null };
  return { full: false };
}

/**
 * #3440, #3441: the mark a refusal carries when it PROVES its confirm's whole ladder
 * spent, set only where that is known: the end of an ordinary ladder walk that some
 * rung of refused as taken (`assignAgentWithTierFallback`), and a named link, whose one
 * advisor is its whole ladder (`assignNamedAgent`). `verdictForRefusal` reads nothing
 * else, so a refusal from anywhere that never walked the ladder settles nobody, however
 * it is typed. A symbol, like the refusal's trace, so it never reaches a stored record.
 */
const LADDER_SPENT = Symbol("ladderSpent");

function markLadderSpent<E extends SlotUnavailableError | NoEligibleAgentsError>(err: E): E {
  (err as unknown as Record<symbol, unknown>)[LADDER_SPENT] = true;
  return err;
}

function provesLadderSpent(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  return (err as Record<symbol, unknown>)[LADDER_SPENT] === true;
}

/**
 * What a confirm refused after losing the insert race shows the confirms behind it,
 * whether it says so at the end or as soon as it knows (#3462, `HeldTurn.lostRace`):
 * one value, so the two can never tell the line different things.
 */
function lostRaceVerdict(refusal: LostRaceRefusal): LeaderVerdict<ConfirmTaker> {
  return refusal.ladderExhausted && !refusal.boundHit ? { full: true, refusal: "race", settled: null } : { full: false };
}

/** How a confirm refused after a lost race ended, as its line is told (#3338, #3462). */
interface LostRaceRefusal {
  /** Nobody was free anywhere on its ladder (`RaceLostRefusalError.ladderExhausted`). */
  ladderExhausted: boolean;
  /** It stopped at `MAX_RACE_REASSIGNS`, which says nothing about the advisors left. */
  boundHit: boolean;
}

async function createHeld(
  ctx: HeldCreate,
  deps: BookingDeps,
): Promise<{ result: BookingResult; verdict: LeaderVerdict<ConfirmTaker> }> {
  const { input, stableKey, agentLinkUserId, codeSource, bucket, eventType, profile, loadtestWindow, seat, queued, lostRace, start, move } = ctx;

  // One call per person, ENFORCED (#1337), not reported after the fact. Runs
  // AFTER the idempotency fast path above on purpose: a double-click's second
  // request would otherwise find the booking its own first request just made and
  // decline it, turning a successful confirm into "you already have a call". And
  // after the bucket resolves (#2660), because the gate is asked in that bucket's
  // WORLD: a test booking under an address must never refuse the real lead who
  // owns it, and a tester must never be refused because a lead shares theirs.
  // #2073: never on a named link, whatever the caller asked: see agentLinkUserId.
  if (input.refuseIfPersonHasCall && agentLinkUserId === undefined) {
    const existingCall = await profile.time("person-gate", () =>
      findExistingCall(input, deps, { isTest: bucket.is_test }),
    );
    if (existingCall) throw new ExistingCallError(existingCall);
  }

  // Every booking gets the reservation-backed crash-safe create (#666). A keyless
  // (anonymous) booking has no stable key to pin a re-submit by, so it gets a
  // fresh synthesized one: no cross-request dedupe (there's nothing to dedupe on,
  // same as the old anonymous behavior), but the reservation + drain still
  // guarantee booking.created is delivered exactly once even across a crash.
  const idempotencyKey = stableKey ?? deps.newIdempotencyKey();

  // Resume an in-flight reservation: a re-submit after a crash mid-create reuses
  // the SAME pinned agent + event id instead of re-running assignAgent (which
  // could land on a different agent and duplicate the calendar event). Only a
  // stable key can name a prior in-flight reservation.
  if (stableKey) {
    // The time still left to wait on a read started with the replay (#3491).
    const started = ctx.inFlightRead;
    const inFlight = await profile.time("inflight-lookup", () => started ?? deps.loadReservationByKey(stableKey));
    // A resumed reservation was pinned by an earlier request, so a booking it makes
    // says nothing about who else the slot has room for: the next confirm in line runs.
    if (inFlight) {
      const resumed = await profile.time("complete-reservation", () => resumeReservation(deps, inFlight, stableKey));
      if (resumed !== null) return { result: answerCommitted(resumed), verdict: { full: false } };
      // #3837 (Dan, 2026-10-16): the advisor it pinned has been taken since, and the
      // stale reservation is rolled back. The lead walks the ladder from the top for
      // the same time, exactly as a fresh confirm does below, with the same verdicts
      // for the line: only a walk that spends the ladder settles the confirms behind
      // it (#3440). The walk reserves under the same key, so a third retry is still
      // guarded by it.
      //
      // #3847: null also means the pending reservation's booking was cancelled or
      // completed since it committed, so it was settled (deleted) rather than made
      // again. This lead is asking for the time again, so they walk afresh too.
    }
  }

  // The tier on show for the requested bucket, so we can measure runtime divergence
  // once the booking lands (#827). The tier the caller's page HAD on show when it
  // sent it (#3495); otherwise the one the availability cache shows RIGHT NOW, read
  // before assign (and before the confirm's write-through mutates the cache).
  // Best-effort: a null (read failed, or a hidden test bucket) skips the measure.
  // Not asked on a named link (#2073): it measures routing, and nothing routed.
  const displayedTier =
    agentLinkUserId !== undefined
      ? null
      : input.shownTier !== undefined
        ? input.shownTier
        : await profile
            .time("displayed-tier", () => deps.displayedTier(input.bucketCode))
            .catch(() => null);

  // #3338: how many rungs this confirm's ladder has. A named link has no ladder:
  // its one advisor is its only rung.
  const ladderRungs = agentLinkUserId !== undefined ? 1 : tierLadder(bucket.code).length;
  // #3338: this confirm's slowest Google call so far, its live checks, measured
  // where they are made. A floor for what its commit chain's Google write will
  // cost (`expectedCommitMs`), so even a confirm on an isolate that has run no
  // chain yet is not judged against nothing. Every walk and check below goes
  // through these deps.
  let slowestGoogleMs = 0;
  const checked: BookingDeps = {
    ...deps,
    verifyFree: async (emails, fromIso, toIso, ids) => {
      const from = Date.now();
      try {
        return await deps.verifyFree(emails, fromIso, toIso, ids);
      } finally {
        slowestGoogleMs = Math.max(slowestGoogleMs, Date.now() - from);
      }
    },
  };
  // Best-effort: record no-booking attempts so "why did this lead get no slots"
  // is answerable. Awaited so the write is not dropped by the CF runtime; the
  // caller's try/catch ensures the original error still propagates unchanged.
  // #3529: a closure, so a walk that parks and later stands records with it too.
  const recordRefusal = async (err: unknown): Promise<void> => {
    if (
      err instanceof NoEligibleAgentsError ||
      err instanceof VerifyUnavailableError ||
      err instanceof SlotUnavailableError
    ) {
      const outcome =
        err instanceof NoEligibleAgentsError ? "no_eligible_agents" : "no_availability";
      // #3272: the trace the refusal carries says when it was asked for, which stage
      // refused it, and what the requested rung's cached read found free.
      const trace = refusalTraceOf(err);
      if (trace) trace.leadId = refusedLeadId(input);
      const requestedRung = trace?.rungs.find((r) => r.code === bucket.code);
      try {
        await profile.time("record-refusal", async () => {
          // #3797: judged alongside the pool read, so a lost race is told apart from a
          // stale offer before the decision row is written and before the route tallies.
          const [pool, offer] = await Promise.all([
            deps.resolveBucketPool(bucket),
            judgeOffer(deps, err, trace, input.servedComputedAt ?? null, eventType),
          ]);
          if (trace && offer) {
            if (offer.verdict) trace.offerVerdict = offer.verdict;
            trace.staleRowCodes = offer.staleRowCodes;
            if (offer.storedRows) trace.storedRows = offer.storedRows;
          }
          await deps.recordRoutingDecision({
            orgId: bucket.org_id,
            bookingId: null,
            bucketCode: bucket.code,
            bucketId: bucket.id,
            criteria: pool.criteria,
            // The requested rung's cached read is the real free set: those advisors
            // were considered and refused later (the stage says where), and only the
            // rest were unavailable in the cache. Labelling the whole pool
            // no_availability, as an empty free set did, read as "everyone busy"
            // whatever refused them (#3272). With no read to go on (the read itself
            // failed), both lists stay empty rather than claim anything.
            ...(requestedRung?.readIds
              ? buildRoutingTraceExtras(pool, requestedRung.readIds)
              : { considered: [], excluded: [] }),
            ...refusalRecord(trace, input.startIso, input),
            // #3797: what the judgement concluded and what it was judged against.
            offerVerdict: trace?.offerVerdict ?? null,
            // The client's own string goes to a timestamptz, so it is stored only once
            // read, as the instant it names: an unreadable one would refuse the insert
            // and lose the whole decision (its verdict is already `unknown`).
            servedComputedAt: trace?.offerVerdict ? storableStamp(input.servedComputedAt) : null,
            staleRowCodes: trace?.staleRowCodes && trace.staleRowCodes.length > 0 ? trace.staleRowCodes : null,
            chosenUserId: null,
            chosenAttributes: null,
            emptyPoolFallback: false,
            tierFallback: false,
            rungsDropped: 0,
            requestedTier: pool.criteria.debt_team ? String(pool.criteria.debt_team) : null,
            bookedTier: null,
            // No booking was made, so the subject is the bucket that was TRIED. A
            // rescued lead who then found no times is still a rescued lead, and
            // leaving it off here would undercount exactly the population whose
            // rescue did not work.
            ...catchallRecord(input.requestedCode, bucket.code, codeSource),
            outcome,
          });
        });
      } catch {
        // best-effort: never change the thrown booking error
      }
    }
  };
  // Fresh create: cascade down the tier ladder if the requested bucket has no
  // agent free for the slot. A crash before the reservation strands nothing.
  let tier: TierAssignResult;
  try {
    tier = await profile.time("assign-and-verify", () =>
      agentLinkUserId !== undefined
        ? assignNamedAgent(checked, { bucket, eventType }, input.startIso, agentLinkUserId)
        : assignAgentWithTierFallback(checked, { bucket, eventType }, input.startIso, input.allowTestBuckets ?? false, false, seat, null, start ?? null, !move),
    );
  } catch (err) {
    // #2073: a named link records no routing decision, refused or not: the
    // routing decision log is what the catch all rate and the routing analytics
    // count, and nothing was routed.
    if (agentLinkUserId !== undefined) throw err;
    // #3529: a walk that parks records nothing yet (it may still book); it carries the
    // recorder, for a walk that later stands.
    if (err instanceof LadderSpentByClaimsError) err.recordRefusal ??= () => recordRefusal(err.refusal);
    else await recordRefusal(err);
    throw err;
  }
  // #3338: when the attempt this confirm is on began: the start of the rung that
  // took it, never the start of the walk, so a lost race measures what ONE rung
  // costs (its read, its live check and its commit chain), not the rungs above it
  // the walk had already dropped (L224).
  let attemptFromMs = tier.rungStartedAtMs;
  // #2281: who this attempt is booking. Starts as the rung's first free advisor
  // and moves, at most MAX_RACE_REASSIGNS times in all, to the next advisor the
  // SAME rung already resolved when an insert loses the overlap race (#2274), and
  // since #3338 on down the ladder when nobody after it on that rung is free.
  let chosen: AssignResult = { userId: tier.userId, email: tier.email };
  const raceLost: string[] = [];
  // #3338: the routing trace's considered and excluded lists belong to the rung
  // being booked, so they are rebuilt with it when a lost race walks the confirm
  // down. Best-effort: a transient pool read failure must not fail the booking.
  const traceExtrasFor = async (t: TierAssignResult): Promise<ReturnType<typeof buildRoutingTraceExtras>> => {
    if (agentLinkUserId !== undefined) return { considered: t.candidates, excluded: [] };
    try {
      // #3489: the walk's ladder read holds the pool already.
      const pool = t.ladder ? t.ladder.pool(t.bucket) : await profile.time("routing-trace", () => deps.resolveBucketPool(t.bucket));
      return buildRoutingTraceExtras(pool, t.candidates);
    } catch {
      return { considered: t.candidates, excluded: [] };
    }
  };
  let traceExtras = await traceExtrasFor(tier);
  // #3338: whether the rung being booked was reached by walking down after a lost
  // race, recorded on the booking so that branch is counted where tier drops are
  // (`tier-drop-counts.ts`), and seen when it never fires (L551).
  let walkedDownAfterRace = false;
  const phone = toE164(input.attendee.phone);
  const manageToken = deps.newManageToken();
  // #2072: where the lead booked from, read off the link on the SERVER. An
  // unknown value is recorded as `unrecognised` and the booking goes ahead: a
  // broken link must never cost a lead. The raw value is logged so the link can
  // be found and fixed, and stays in prefill; the column holds only the
  // vocabulary.
  const sourceReading = readBookingSource(input.prefill, input.apiCaller, input.mcpChannel);
  if (sourceReading.unrecognisedRaw !== null) {
    log.warn("booking-source", {
      msg: "unrecognised source on the booking link",
      raw: sourceReading.unrecognisedRaw,
      bucket_code: input.bucketCode,
    });
  }

  let result: BookingResult;
  for (;;) {
    // #3338: read off the rung being booked on every attempt, never kept from the
    // first one, since a lost race can walk the confirm down to another rung with
    // its own bucket, event type and call length (L14, L510).
    const { bucket: bookedBucket, eventType: bookedEventType, startIso, endIso, candidates } = tier;
    const { userId, email } = chosen;
    // #3338: never START the commit chain (the reservation, the calendar event, the
    // insert) without the budget to finish it. A confirm cut off part way through
    // leaves a reservation and an event the drain later turns into a booking for a
    // lead who was told to try again (L12), which is what a confirm promoted late
    // in a crowd did once a crowd walked the ladder. What the chain costs is
    // measured (`commit-cost.ts`): this isolate's recent chains, and never less
    // than this confirm's own slowest Google call. Short of it, the lead is told to
    // retry with nothing started: no event, no reservation, and the claim on the
    // advisor is let go when the line hears the refusal.
    const commitNeededMs = expectedCommitMs({
      slowestRecentChainMs: deps.commitCosts.slowestRecentMs(Date.now()),
      slowestGoogleCallMs: slowestGoogleMs,
    });
    const commitLeftMs = budgetLeftMs();
    if (!budgetCovers(commitLeftMs, commitNeededMs)) {
      const leftMs = Math.max(0, commitLeftMs ?? 0);
      log.warn("booking", {
        msg: "confirm has too little of its budget left to write the booking and its calendar event; answering retryably with nothing started",
        user_id: userId,
        bucket_code: bookedBucket.code,
        needed_ms: commitNeededMs,
        left_ms: leftMs,
      });
      throw new DependencyTimeoutError(
        { label: "writing the booking and its calendar event", timeoutMs: leftMs, budget: null, neededMs: commitNeededMs },
        null,
      );
    }
    // #3489: the walk's ladder read holds the advisor's row; read it only without one.
    const agent = tier.ladder?.user(userId) ?? (await profile.time("load-advisor", () => deps.getUser(userId)));
    const gcalClientId = await deterministicEventId(idempotencyKey, userId);
    const bookingInsert: BookingInsert = {
      org_id: bookedBucket.org_id,
      bucket_id: bookedBucket.id,
      event_type_id: bookedEventType.id,
      assigned_user_id: userId,
      agent_name: agent.name,
      agent_email: agent.email,
      starts_at: startIso,
      ends_at: endIso,
      original_starts_at: startIso,
      original_ends_at: endIso,
      timezone: input.timezone,
      status: "confirmed",
      salesforce_id: input.salesforceId ?? null,
      attendee_name: input.attendee.name ?? null,
      // #2549: the answered first name, or null; never a split of the name above.
      attendee_first_name: storedFirstName(input.attendee.name, input.attendee.firstName),
      attendee_email: input.attendee.email ?? null,
      attendee_phone: phone,
      prefill: input.prefill,
      gcal_event_id: gcalClientId, // the pinned client id IS the stored event id
      manage_token: manageToken,
      idempotency_key: idempotencyKey,
      external_id: input.externalId ?? null,
      source: sourceReading.source,
      // #2728: re-reduced here rather than trusted, so a path or query the client
      // sent (which can carry a lead's details) never reaches the row.
      referrer_origin: readReferrerOrigin(input.referrerOrigin),
      kind: agentLinkUserId !== undefined ? "agent_link" : "routed",
      // #2073: nothing was routed, so there is no trace, and a fabricated one would
      // read as a routing decision to every reader of the column.
      routing_trace: agentLinkUserId !== undefined ? null : {
        bucket_code: bookedBucket.code,
        bucket_id: bookedBucket.id,
        considered: candidates,
        chosen_user_id: userId,
        fallback_applied:
          bookedBucket.fallback_user_id != null &&
          candidates.length > 0 &&
          candidates.every((id) => id === bookedBucket.fallback_user_id),
        excluded: traceExtras.excluded,
        tier_fallback: tier.rungsDropped > 0,
        requested_tier: tierKeyOf(input.bucketCode),
        booked_tier: tierKeyOf(bookedBucket.code),
        rungs_dropped: tier.rungsDropped,
        // 2026-10-02: the tier on show at confirm, saved so a drop is countable by
        // cause on /admin/routing rather than only in a 7 day log line.
        displayed_tier: displayedTier,
        // #2638: where the routed code came from, and when the catch-all applied,
        // why Salesforce could not supply one. Absent when the caller did not say
        // what the link carried (the direct booking API, an older embed).
        ...(codeSource ? { code_source: codeSource } : {}),
        // #2281: the advisors this confirm was first given and lost to a racing
        // booking, in the order tried. Present only when that happened, so the
        // trace never reads as though the first choice took the call.
        ...(raceLost.length > 0 ? { race_lost: [...raceLost] } : {}),
        // #3338: the drop was made BEHIND other confirms for this same time, by
        // losing the insert race on a rung above, or by waiting in this slot's line
        // while the ones ahead booked it. Present only then, so each branch is
        // counted apart where tier drops are (`tier-drop-counts.ts`) and seen when
        // it never fires (L551).
        // #3489 step 3: `claimed` when it walked past a rung other confirms in flight
        // held, which the line no longer waits on (Dan, 2026-10-07).
        ...(walkedDownAfterRace
          ? { dropped_behind: "race" as const }
          : tier.pastClaims && tier.rungsDropped > 0
            ? { dropped_behind: "claimed" as const }
            : queued && tier.rungsDropped > 0
              ? { dropped_behind: "line" as const }
              : {}),
      },
    };
    const event: ReservationPayload["event"] = {
      summary: eventSummary({ eventType: bookedEventType.name, advisor: agent.name, lead: input.attendee.name ?? null }),
      description: eventDescription(phone, manageUrl(deps, manageToken), { isTest: bookedBucket.is_test }),
      location: eventLocation(phone),
      start: startIso,
      end: endIso,
      timezone: input.timezone,
      attendeeEmail: input.attendee.email,
      attendeeName: input.attendee.name,
    };

    // #3338: the commit chain starts here, and is measured from here to the
    // insert's answer, so the next confirm in this isolate knows what one costs.
    const chainFromMs = Date.now();
    // The UNIQUE(idempotency_key) on the reservation is the concurrency arbiter:
    // a same-key racer that already won is returned here, so we adopt ITS pin.
    const reservation = await profile.time("reserve", () =>
      deps.insertReservation({
        idempotency_key: idempotencyKey,
        pinned_user_id: userId,
        pinned_agent_email: email,
        gcal_client_id: gcalClientId,
        payload: {
          booking: bookingInsert,
          event,
          bucketCode: input.bucketCode,
          requestedCode: input.requestedCode,
        },
      }),
    );

    // The insert, the exclusion index write and the cache write through, which is
    // where the overlap constraint (#2280) and the in request pool recompute both
    // land: two of the three candidates #2321 names.
    // #3338: the commit's answer closes the chain's measurement. Since #3495 that one
    // call carries the side effects the drain used to finish after the insert, so the
    // chain is the whole save. Only a chain that COMMITTED with budget still left is
    // what a chain costs: one cut off at the commit, failed, lost to a race or
    // answered after the budget was spent measured only what a budget allowed, and
    // recording it could hold every later confirm on this isolate out (L465).
    let committedChainMs: number | null = null;
    const measured: BookingDeps = {
      ...deps,
      commitFreshBooking: async (req) => {
        const answer = await deps.commitFreshBooking(req);
        const leftMs = budgetLeftMs();
        if (answer.kind === "committed" && (leftMs === null || leftMs > 0)) committedChainMs = Date.now() - chainFromMs;
        return answer;
      },
    };
    const attempt = await profile.time("complete-reservation", () =>
      attemptReservation(measured, reservation, { bucket: bookedBucket, eventType: bookedEventType, agent }),
    );
    if (attempt.kind === "completed") {
      result = answerCommitted(attempt.completed);
      if (committedChainMs !== null) deps.commitCosts.record(committedChainMs, Date.now());
      break;
    }
    // A fresh confirm passes what it holds (`known`), and only a resume without it
    // looks for an earlier booking, so this cannot be settled (#3847). Said loudly
    // rather than read as a lost race, should that ever stop being true.
    if (attempt.kind === "settled") {
      throw new Error(`a fresh confirm's reservation ${reservation.id} was settled, which only a resume can do`);
    }

    // The insert lost to a booking that is not this request's own (#2274).
    //
    // #3462: what happens next is decided BEFORE the lost attempt is rolled back,
    // so a confirm refused with its ladder spent tells its line at once. The
    // rollback, and the bookkeeping after it, cannot change what the confirms
    // behind it are owed, and on load run 37566700055 waiting for them cost 41
    // followers their budget. Both still run in full, under the same allowance.
    // The rollback always comes before a further attempt, whose reservation reuses
    // the idempotency key.
    //
    // When this attempt learnt it had lost, before the search below spends any
    // more of the budget: the attempt's own cost is measured up to here.
    const lostAtMs = Date.now();
    const reassignFromMs = lostAtMs;
    let next: NextAfterLostRace;
    try {
      next = await profile.time("race-reassign", () => nextAdvisorAfterLostRace(checked, {
        named: agentLinkUserId !== undefined,
        reservation,
        lostUserId: userId,
        candidates,
        lostSoFar: raceLost.length,
        startIso,
        endIso,
        eventType: bookedEventType,
        seat,
      }));
    } catch (err) {
      // Every way the search can find nobody is a typed reason, so this is a fault
      // in the search itself. The lost attempt is rolled back all the same; a
      // rollback that fails throws its own error instead.
      await profile.time("race-rollback", attempt.rollBack);
      throw err;
    }
    if (next.kind === "advisor") {
      // #3257: the confirms beside it in line must not pick this one next. The search
      // claimed it the moment it chose it (`nextAdvisorAfterLostRace`), before this
      // rollback, which in production deletes a calendar event (#3489).
      await profile.time("race-rollback", attempt.rollBack);
      log.info("booking", {
        msg: "confirm lost the overlap race, handed to the next advisor in the same rung",
        lost_user_id: userId,
        next_user_id: next.assignment.userId,
        bucket_code: bookedBucket.code,
        attempt: raceLost.length + 2,
      });
      raceLost.push(userId);
      chosen = next.assignment;
      attemptFromMs = reassignFromMs;
      continue;
    }
    // A deadline is the retryable outage, never a taken time (#3402), and the line
    // hears that nothing settled.
    if (next.reason === "deadline") {
      await profile.time("race-rollback", attempt.rollBack);
      throw next.err;
    }
    // #3338: nobody after the loser on this rung is free, so the confirm walks on
    // down the ladder, "Same as a normal confirm" (Dan, 2026-10-06). It is the ONE
    // reason that does: every other one learnt nothing about the rest of the
    // ladder and refuses exactly as before.
    let walkedPast: RungTrace[] = [];
    // Nowhere left to walk: the race was on the ladder's last rung, and every
    // advisor this confirm read there it also asked (none was passed over for
    // another confirm's claim, #3257). Then the ladder is spent, whatever the
    // budget, and the refusal below says so. #3529: nor did it pass a rung above
    // only for claims, or skip one unread; then the walk below parks instead.
    const nothingLeftToWalk = tier.rungsDropped >= ladderRungs - 1 && !claimsMayFree(tier);
    // #2838: a bound hit is paged. #3338: the ladder is spent only when the walk
    // below found nobody (or the race was on the last rung, where there was no walk
    // to take), or for a named link, whose one advisor is its whole ladder. Only
    // that settles the confirms waiting behind this one (`lostRaceVerdict`).
    const boundHit = next.reason === "bound";
    const ladderExhausted = next.reason === "rung-exhausted" || next.reason === "named-link";
    if (next.reason === "rung-exhausted" && !nothingLeftToWalk) {
      // Only with the time to finish it. One rung costs what the attempt that
      // just lost cost, measured on this confirm (L224): its live check, its
      // reservation, its calendar event and its insert. Starting the next rung
      // with less left would cut it off part way, after a live check and a
      // calendar event nobody can use, so the lead is told to retry instead,
      // never that the time is taken while a rung below may have somebody free.
      // A budget already spent starts nothing, however cheap the attempt was.
      const neededMs = lostAtMs - attemptFromMs;
      const walkLeftMs = budgetLeftMs();
      if (!budgetCovers(walkLeftMs, neededMs)) {
        await profile.time("race-rollback", attempt.rollBack);
        // Clamped where it is read, so the page can never say a negative time.
        const leftMs = Math.max(0, walkLeftMs ?? 0);
        log.warn("booking", {
          msg: "confirm lost the overlap race on its rung's last advisor and has too little time left to walk down the ladder; answering retryably",
          lost_user_id: userId,
          bucket_code: bookedBucket.code,
          needed_ms: neededMs,
          left_ms: leftMs,
        });
        throw new LostRaceOutOfTimeError({ label: "the tier below a lost race", timeoutMs: leftMs, budget: null, neededMs });
      }
      // #3462: the lost attempt is rolled back WHILE the walk asks the rungs below.
      // The two touch nothing in common (the walk never asks the advisor that lost),
      // so a walk that finds nobody tells the line before the rollback ends, and one
      // that finds somebody waits for it: the further attempt's reservation reuses
      // the idempotency key. Handled at once, so a rollback that fails while the walk
      // runs is never an unhandled rejection; awaited below, where it is the answer.
      const rollingBack = profile.time("race-rollback", attempt.rollBack);
      void rollingBack.catch(() => undefined);
      let below: Awaited<ReturnType<typeof walkDownAfterLostRace>>;
      try {
        below = await profile.time("race-walk-down", () =>
          walkDownAfterLostRace(checked, { bucket, eventType }, input, seat, {
            rung: tier.rungsDropped,
            // #3489: a handed confirm asked only the advisors it lost on (`taken`), never the
            // rest of the read it was handed, which others were booking; those are read again.
            // #3529: and never the advisor it was handed and already found unable.
            askedOnRung: tier.handed ? [] : [...candidates, ...(tier.alsoAsked ?? [])],
            taken: [...raceLost, userId],
            // #3529: only what is true ABOVE the rung; its own claimed advisors are offered
            // again by the walk itself (`askedOnRung`).
            unreadAbove: tier.pastClaims === true || tier.unreadAbove === true || tier.handed === true,
          }, !move),
        );
      } catch (err) {
        // #3529: a walk down that parks carries the recorder too, for a walk that stands.
        if (err instanceof LadderSpentByClaimsError && agentLinkUserId === undefined) err.recordRefusal ??= () => recordRefusal(err.refusal);
        // The walk's failure is the answer; a rollback that also failed is logged,
        // never lost.
        await rollingBack.catch((rollbackErr: unknown) =>
          log.warn("booking", { msg: "the lost attempt's rollback failed while the walk down the ladder failed too" }, rollbackErr),
        );
        throw err;
      }
      if ("tier" in below) {
        await rollingBack;
        log.info("booking", {
          msg: "confirm lost the overlap race with nobody after it on its rung, and walked down the ladder",
          lost_user_id: userId,
          next_user_id: below.tier.userId,
          bucket_code: bookedBucket.code,
          next_bucket_code: below.tier.bucket.code,
          rungs_dropped: below.tier.rungsDropped,
          attempt: raceLost.length + 2,
        });
        raceLost.push(userId);
        if (below.tier.rungsDropped > tier.rungsDropped) walkedDownAfterRace = true;
        tier = below.tier;
        // The next attempt is measured from the rung that took it.
        attemptFromMs = tier.rungStartedAtMs;
        traceExtras = await traceExtrasFor(tier);
        chosen = { userId: tier.userId, email: tier.email };
        continue;
      }
      walkedPast = below.refusedOn;
      // The ladder is spent: the line hears now, while the rollback may still run.
      await lostRace?.({ ladderExhausted, boundHit });
      // A failure here is the lead's answer, as it was inside the completion.
      await rollingBack;
    } else {
      // #3462: refused with nothing more to ask, so the line hears now, before the
      // rollback; the closing report is this same one.
      await lostRace?.({ ladderExhausted, boundHit });
      // A failure here is the lead's answer, as it was inside the completion.
      await profile.time("race-rollback", attempt.rollBack);
    }
    // #2838: refused after a lost race. Said apart so it can be counted, and
    // a bound hit paged at once: a lead turned away while the rung was still
    // handing out advisors, which ordinary traffic cannot produce.
    log.warn("booking", {
      msg: "confirm lost the overlap race and was refused",
      lost_user_id: userId,
      bucket_code: bookedBucket.code,
      lost_races: raceLost.length + 1,
      bound_hit: boundHit,
      why: next.reason,
    });
    const page = raceBoundHitPage({
      boundHit,
      isTest: bookedBucket.is_test,
      loadtest: isLoadtest(),
      requestedCode: input.bucketCode,
      bucketCode: bookedBucket.code,
      startIso,
      lostRaces: raceLost.length + 1,
    });
    // Handed to the injected dispatcher, never sent from here: production
    // defers it past the response, and a test supplies a fake (L2).
    // A dispatcher that throws is logged and the lead still gets the 409:
    // the refusal is their answer, and a page must never turn it into a 500.
    if (page) {
      try {
        deps.pageRaceBoundHit(page);
      } catch (pageErr) {
        log.warn("booking", { msg: "could not hand off a race bound hit page; the refusal stands" }, pageErr);
      }
    }
    const raceTrace: RefusalTrace = {
      requestedStart: input.startIso,
      bucketCode: input.bucketCode,
      stage: "race_lost",
      rungs: [
        {
          code: bookedBucket.code,
          members: null,
          read: tier.read.length,
          claimed: null,
          checked: null,
          stage: "race_lost",
        },
        // #3338: and every rung the walk down asked after it, in ladder order.
        ...walkedPast,
      ],
      lostRaces: raceLost.length + 1,
      leadId: refusedLeadId(input),
    };
    // #3272: a lost race wrote no routing decision at all, so it was the one
    // refusal nothing could look up. Best effort, like the refusal record above.
    if (agentLinkUserId === undefined) {
      try {
        await deps.recordRoutingDecision({
          orgId: bookedBucket.org_id,
          bookingId: null,
          bucketCode: bookedBucket.code,
          bucketId: bookedBucket.id,
          criteria: bookedBucket.criteria,
          considered: traceExtras.considered,
          excluded: traceExtras.excluded,
          chosenUserId: null,
          chosenAttributes: null,
          emptyPoolFallback: false,
          tierFallback: tier.rungsDropped > 0,
          rungsDropped: tier.rungsDropped,
          requestedTier: bucket.criteria.debt_team ? String(bucket.criteria.debt_team) : null,
          bookedTier: null,
          ...catchallRecord(input.requestedCode, bookedBucket.code, codeSource),
          ...refusalRecord(raceTrace, input.startIso, input),
          outcome: "no_availability",
        });
      } catch {
        // best-effort: never change the refusal
      }
    }
    throw traced(new RaceLostRefusalError(raceLost.length + 1, boundHit, ladderExhausted), raceTrace);
  }
  // The apportionment, once, at the end. It carries no contact data: the stage
  // names and their durations, plus what they do NOT account for. Under
  // SLATE_LOADTEST only (the window); in production the same stages reach the
  // route's `confirm answered` line instead, when the confirm was slow (#3300).
  const reading = loadtestWindow?.read();
  if (reading) {
    log.info("confirm-profile", {
      msg: "where the confirm spent its wall time",
      booking_id: result.booking.id,
      bucket: input.bucketCode,
      // The two numbers the judge reads, as FIELDS rather than only inside the
      // sentence (#2340). The sentence is for a person; a judge parsing prose
      // breaks on the first wording change, and the wording is the half most
      // likely to be edited.
      total_ms: reading.totalMs,
      isolate_age_ms: reading.isolateAgeMs,
      detail: confirmProfileLine(reading),
    });
  }

  // Runtime half of AUD-061 (#827): the booker showed a slot from `displayedTier`
  // but live verify-on-book may have dropped a further rung to `bookedTier`. Log
  // (do not alert) each divergence; a spike flags cache staleness or a routing
  // problem. Best-effort: never affect the booking result.
  try {
    const bookedTier = tierKeyOf(tier.bucket.code);
    if (displayedTier && bookedTier && displayedTier !== bookedTier) {
      log.info("tier-divergence", {
        msg: "displayed tier differs from booked tier at confirm",
        bucket: input.bucketCode,
        requested_tier: tierKeyOf(input.bucketCode),
        displayed_tier: displayedTier,
        booked_tier: bookedTier,
        rungs_dropped: tier.rungsDropped,
        booking_id: result.booking.id,
      });
    }
  } catch {
    // never let the measure affect a successful booking
  }
  // #3221: the slot is full for everybody waiting behind this confirm when the
  // rung it booked from has nobody left after the advisor it took. The ones before
  // that advisor were already found busy, or lost to a race; the ones after were
  // never asked, so with any of them left the next confirm runs and asks.
  //
  // #3257: judged on the rung's whole list as READ, not the one thinned of other
  // confirms' claims. An advisor left out for a claim was never asked by this
  // confirm, and the confirm holding it may have failed and freed it since, so any
  // advisor skipped that way leaves the slot open: the next in line reads for
  // itself, which costs it one candidate read when the claim did book.
  //
  // #3338: and only when that rung is the LADDER's last. The confirms waiting are
  // in the same line because they walk the same pools at every rung, so a rung
  // above the last one spent leaves them the rungs below it, which they walk as
  // any confirm does (Dan, 2026-10-06: "Same as a normal confirm"). The next in
  // line leads and walks from the top; the advisor just booked reads as busy in the
  // write through cache, so it drops that rung for the price of one candidate read.
  // A named link has no ladder: its one advisor is its last rung.
  const { candidates } = tier;
  // #3529: or the deepest rung the read it decided from found anyone on.
  const lastRung = tier.rungsDropped >= ladderRungs - 1 || tier.deepest === true;
  const at = candidates.indexOf(result.booking.assigned_user_id ?? chosen.userId);
  //
  // #3529: and never outright when an advisor it skipped for a claim may have been freed
  // since (`claimsMayFree`). The line can tell, by whether any claim has ended unbooked
  // since the read this confirm decided from (`unlessFreed`): its own first read, or for a
  // confirm handed a rung, the read it was handed from, which is what saw the rungs above.
  // In a crowd that is the usual case, and everybody waiting is answered at once; the
  // line voids the verdict when it has no read to vouch with.
  // A handed confirm took the last one when the line says it did (`handedLast`): its read ends
  // wherever round robin put its people, often with somebody handed a rung above (#3529).
  const lastAdvisor = lastRung && ((at >= 0 && at === candidates.length - 1) || (tier.handed === true && tier.handedLast === true));
  const settled = { idempotencyKey, result };
  const verdict: LeaderVerdict<ConfirmTaker> = !lastAdvisor
    ? { full: false, booked: settled }
    : !claimsMayFree(tier)
      ? { full: true, refusal: "race", settled }
      : { full: true, refusal: "race", settled, unlessFreed: true };
  return { result, verdict };
}

/**
 * What a fresh confirm already holds when it commits (#3495): its booked bucket with its
 * event type, and the advisor it read before writing the booking. Each is used only for
 * the row it describes (the bucket by code, the advisor by id), so a crash resume or a
 * booking made by another request still reads its own. The reservation drain holds
 * neither and passes nothing.
 */
interface CommitKnown {
  bucket: Bucket;
  eventType: EventType;
  agent: User;
}

/**
 * The post-insert side effects a create MUST deliver, factored out so the fresh
 * create and a crash-resume run the SAME sequence (#613). Every step is
 * idempotent (moveBusyBlock replaces any prior block for the booking, and
 * booking.created dedupes on the booking id (`webhookDedupeKey`) so a re-run
 * emits nothing new), so running it inline once, or again from the reservation
 * drain after a crash, reaches the same end state without a duplicate block or a
 * double webhook. Returns the resolved bucket/eventType. THROWS when the bucket
 * no longer resolves (#3516), since the webhook it owes cannot be built.
 */
async function deliverCreatedSideEffects(
  deps: BookingDeps,
  booking: Booking,
  bookedCode: string,
  known?: CommitKnown,
): Promise<{ bucket: Bucket; eventType: EventType }> {
  if (booking.assigned_user_id) {
    await deps.moveBusyBlock(
      booking.assigned_user_id,
      booking.starts_at,
      booking.ends_at,
      booking.id,
    );
  }
  // #3324: after the busy block above has committed, so the splice's fence is
  // stamped no earlier than the block every later compute will read.
  await deps.invalidateSlots(
    bookedCode,
    booking.assigned_user_id
      ? { userId: booking.assigned_user_id, startsAt: booking.starts_at, endsAt: booking.ends_at }
      : undefined,
  );

  // Re-resolve bucket + eventType for the webhook (works on the drain path too), unless
  // the confirm already holds them for this very code (#3495: one request fewer).
  const resolved =
    known && known.bucket.code === bookedCode
      ? { bucket: known.bucket, eventType: known.eventType }
      : await deps.resolveBucketByCode(bookedCode);
  if (!resolved) {
    // #3516: booking.created cannot be built without the bucket, and it used to be
    // skipped here in silence while the caller went on to delete the reservation,
    // the only record that Regal was still owed it. Throwing keeps the reservation
    // pending: the drain backs off with this as its last_error, and past
    // DRAIN_ALERT_AFTER attempts it pages as `reservation_drain_stuck`. Since #3514
    // the one call save leaves a reservation pending for exactly this reason
    // (`unbuilt`), so this is the step that decides whether anybody hears of it.
    throw new Error(
      `booking ${booking.id} committed, but booking.created cannot be sent: the booked bucket ${bookedCode} no longer resolves. Regal has not been told about this booking`,
    );
  }
  await fire(deps, "booking.created", booking, resolved.bucket, resolved.eventType);
  return resolved;
}

/**
 * What completing a reservation produced (#3263): the booking, and the failure
 * that stopped the work AFTER its commit, or null when all of it landed.
 *
 * Once the booking row has committed, nothing that follows may turn the answer
 * into a failure: the lead would be told to try again for a booking that exists,
 * and one who walks away is left unsure they booked. So a failure there is
 * carried here rather than thrown, the reservation is left pending, and the
 * reservation drain re-runs the same idempotent side effects on its next tick.
 * The two kinds of caller then read it differently, which is why it is returned
 * rather than swallowed: a lead's confirm answers the booking
 * (`answerCommitted`), and the drain treats it as the failure it is, so a finish
 * that never lands backs off and reaches the stuck alert instead of reading as
 * completed every tick.
 */
interface CompletedReservation {
  result: BookingResult;
  unfinished: unknown;
}

/**
 * A lead's confirm answering a booking that committed (#3263), whatever became
 * of the work after it. The cut off work is logged and never paged one by one: the
 * drain finishes it, and pages through its own stuck alert if it cannot. Since
 * #3267 the answer also SAYS so, and the route counts it, because one such confirm
 * is the drain doing its job and a wave of them is an outage in the confirm path
 * that answered every lead in it (L77): the monitor lane pages on the share.
 */
function answerCommitted(completed: CompletedReservation): BookingResult {
  if (completed.unfinished !== null) {
    log.error(
      "booking",
      {
        msg: "the booking committed and the work after it did not finish; answering the booking, and the reservation drain finishes the rest",
        booking_id: completed.result.booking.id,
      },
      completed.unfinished,
    );
    return { ...completed.result, followUpLeftToDrain: true };
  }
  return completed.result;
}

/**
 * The post-commit work of a create, with its failure returned rather than thrown
 * (#3263), so the booking that committed is always the answer. The reservation is
 * deleted only once everything before it landed, so a failure leaves it pending
 * for the drain.
 */
async function finishCommitted(work: () => Promise<void>): Promise<unknown> {
  try {
    await work();
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Complete a booking from its reservation (#429 P4), for the drain. The fresh
 * create and the re-submit resume (`resumeReservation`, #3837) run the same
 * `attemptReservation`, so a crash anywhere resumes to the same end state. Idempotent: createEvent reuses the event (deterministic id → 409),
 * a booking already inserted short-circuits, and insertBooking keeps the
 * active-slot 23505 handling. Deletes the reservation on success.
 *
 * Throws only for a failure BEFORE the booking committed. Anything after the
 * commit comes back as `unfinished` (#3263). A slot taken by another booking is
 * rolled back here and thrown as `SlotUnavailableError`, which the drain treats
 * as terminal. The fresh create and the re-submit resume call
 * `attemptReservation` instead (#3462, #3837), because each acts on a lost attempt
 * itself: the fresh create decides its next advisor before the rollback, and the
 * resume rolls back and then walks the ladder.
 *
 * Answers null when the reservation was SETTLED (#3847): its booking committed and
 * has since been cancelled or completed, so the reservation was deleted and nothing
 * was made again.
 */
async function completeReservation(
  deps: BookingDeps,
  reservation: BookingReservation,
): Promise<CompletedReservation | null> {
  const attempt = await attemptReservation(deps, reservation);
  if (attempt.kind === "completed") return attempt.completed;
  if (attempt.kind === "settled") return null;
  await attempt.rollBack();
  throw new SlotUnavailableError();
}

/**
 * A lead's retry resuming the reservation its earlier confirm left (#3837). Returns the
 * booking it completed, or null when the advisor the reservation pinned has been taken
 * since: the reservation and its event are rolled back by then, so the caller walks
 * the ladder as a fresh confirm. Null too when the reservation's booking was cancelled
 * or completed since it committed (#3847): the reservation is settled, not made again.
 *
 * It holds the reservation's lease, the one the drain takes
 * (`processBookingReservations`), for the whole attempt, so the drain and a lead's
 * retry can never both work one reservation. Before #3837 the resume took none, and on
 * a reservation old enough for the drain (#3466) the two could complete it, or roll it
 * back, at once.
 *
 *   - Another holder has the lease: the retry leaves the reservation alone. The
 *     booking that holder made, if it has finished, is the answer; otherwise the lead
 *     is told to try again (`ReservationHeldError`). It never walks: the reservation
 *     still stands under this key, and a walk would reserve under the same key and
 *     adopt it.
 *   - The claim itself fails: a claim nobody could confirm is not a claim, so nothing
 *     is written and it is the retryable outage.
 *   - The rollback of a taken pin fails: the retryable outage is thrown
 *     (`ReservationRollbackError`, #3859) and nothing is walked, for the same reason.
 *     The lease is given back, so the drain retries the row. A rollback that finds the
 *     row already gone is not a failure, and the walk goes on (`dropLostReservation`).
 */
async function resumeReservation(
  deps: BookingDeps,
  reservation: BookingReservation,
  stableKey: string,
): Promise<CompletedReservation | null> {
  let lease: string | null;
  try {
    lease = await deps.leaseReservation(reservation.id);
  } catch (err) {
    // A deadline is answered as the deadline it is; anything else as the outage.
    const mapped = timeoutAsRetryable(err);
    if (mapped instanceof VerifyUnavailableError) throw mapped;
    const refused = new VerifyUnavailableError();
    refused.cause = err;
    throw refused;
  }
  if (lease === null) {
    // The holder may have just finished: the booking it made is this lead's answer.
    const made = await replayOf(deps, stableKey);
    if (made) return { result: made, unfinished: null };
    throw new ReservationHeldError();
  }
  try {
    const attempt = await attemptReservation(deps, reservation);
    if (attempt.kind === "completed") return attempt.completed;
    // #3847: its booking was cancelled or completed since it committed, so the
    // reservation is already deleted and nothing was made; the lead walks afresh.
    if (attempt.kind === "settled") return null;
    await attempt.rollBack();
    return null;
  } finally {
    // A release that cannot land must never change the answer: a booking may have
    // committed above. The lease ends on its own at its TTL.
    await deps.releaseReservationLease(reservation.id, lease).catch((err: unknown) => {
      log.warn("reservations", { msg: "a resumed reservation's lease could not be given back; it ends on its own", reservation_id: reservation.id }, err);
    });
  }
}

/**
 * What completing a reservation came to (#3462): completed (`CompletedReservation`);
 * LOST, its insert refused because a booking that is not this request's own holds
 * the slot, with the rollback that loss still owes; or SETTLED (#3847), its booking
 * committed and has since been cancelled or completed, so the reservation was
 * deleted and nothing was made again. Only a resume (called without `known`, so the
 * drain and a lead's retry) can answer settled, because only a resume looks for an
 * earlier booking on the key; a fresh confirm treats settled as an error.
 *
 * The rollback is handed back rather than run, so a lead's confirm can tell the
 * confirms waiting behind it that the time is taken BEFORE it spends the cleanup
 * allowance (#3462). A caller that takes the loss must run it, under any outcome:
 * `completeReservation` runs it at once. One it never ran would still be repaired,
 * since the reservation stays pending and the drain's own completion meets the
 * same conflict and rolls it back, but late and in the wrong place.
 */
type ReservationAttempt =
  | { kind: "completed"; completed: CompletedReservation }
  | { kind: "lost"; rollBack: () => Promise<void> }
  /** #3847: the resume found this reservation's booking already cancelled or
   *  completed. The reservation was deleted and nothing was made. Only a resume
   *  (no `known`) can answer it. */
  | { kind: "settled"; booking: Booking };

/** The statuses a booking is live in, as the replay read and the active key index count them. */
function isActiveStatus(status: Booking["status"]): boolean {
  return status === "confirmed" || status === "rescheduled";
}

/**
 * Whether a booking on the reservation's key is the one THIS reservation made
 * (#3847). The reservation is written before its booking commits, both stamped by
 * Postgres's own clock, so its booking is never older than it. A booking older than
 * the reservation is an earlier booking on the same key, cancelled before this
 * reservation was written. THROWS when either stamp is unreadable: settling a new
 * create would drop a lead's booking, and recreating would resurrect a cancelled
 * one, so neither is chosen on a guess; the drain backs off and pages instead.
 */
function bookingIsThisReservations(booking: Booking, reservation: BookingReservation): boolean {
  const bookedMs = Date.parse(booking.created_at);
  const reservedMs = Date.parse(reservation.created_at);
  if (!Number.isFinite(bookedMs) || !Number.isFinite(reservedMs)) {
    throw new Error(
      `reservation ${reservation.id}: cannot tell whether ${booking.status} booking ${booking.id} is its own (unreadable created_at), so it is neither settled nor made again`,
    );
  }
  return bookedMs >= reservedMs;
}

/**
 * The reservation half of a lost attempt's rollback (#3859). Every caller that runs
 * one goes on to reserve again under the SAME idempotency key, or leaves the row to
 * the drain: the fresh confirm's next advisor or walk down the ladder (#3338), the
 * resumed reservation's walk (#3837), and the drain's own terminal rollback. The
 * reservation's insert adopts whatever row already holds the key, so this delete is
 * all that keeps the next attempt off the lost reservation, still pinned to the
 * advisor who was just taken.
 *
 * So a refused delete stops the confirm. It is answered as the retryable outage
 * (`ReservationRollbackError`, or the deadline it was), carrying the database's own
 * error, and the row is left pending for the drain, whose completion meets the same
 * conflict and rolls it back on a later tick.
 *
 * A delete that found no row is not a failure: no row by that id is exactly what the
 * next reservation needs. Only a holder of the same reservation can have removed it,
 * a concurrent confirm of the same lead (which adopted it by key, and rolled back or
 * booked) or the drain after a lapsed lease, and a booking either of them made is
 * found by the key when the next attempt saves. It is logged, so the overlap is seen.
 */
async function dropLostReservation(deps: BookingDeps, reservationId: string): Promise<void> {
  let outcome: ReservationDeleteOutcome;
  try {
    outcome = await deps.deleteReservation(reservationId);
  } catch (err) {
    const mapped = timeoutAsRetryable(err);
    if (mapped instanceof VerifyUnavailableError) throw mapped;
    throw new ReservationRollbackError(reservationId, err);
  }
  if (outcome === "gone") {
    log.info("reservations", {
      msg: "a lost attempt's reservation was already gone when it was rolled back; a holder of the same key removed it",
      reservation_id: reservationId,
    });
  }
}

/** `completeReservation`, with a lost race handed back unrolled (see `ReservationAttempt`). */
async function attemptReservation(
  deps: BookingDeps,
  reservation: BookingReservation,
  /** #3495: what a fresh confirm already holds (`CommitKnown`); absent on the drain. */
  known?: CommitKnown,
): Promise<ReservationAttempt> {
  const { booking: bookingInsert, event, bucketCode, requestedCode } = reservation.payload;
  const key = bookingInsert.idempotency_key;

  // A resume after the booking was inserted but before the reservation was
  // deleted. A crash here could have landed BEFORE booking.created fired (1336
  // -> 1374), which used to be dropped permanently: short-circuiting to just
  // delete the reservation skipped every post-insert side effect (#613). Instead,
  // re-run the idempotent side effects (busyblock/recompute/notify) so the
  // previously-lost booking.created is delivered exactly once, THEN clean up.
  //
  // #3495: only the drain's resume asks. A fresh confirm (`known`) looked its key up
  // moments before reserving, and the save below refuses a second booking on the key
  // and hands back the winner, so asking again here was one more database wait on
  // every booking (about 130ms at the median, 480ms at the p95, on load run 20) for a
  // case the save already answers. That case's calendar event is handled there.
  //
  // #3847: the lookup is the newest booking on the key in ANY status, never the
  // active only replay read. That read missed a booking cancelled or completed after
  // it committed, so the reservation read as never committed and the code below made
  // the booking AGAIN: a calendar event for a call the lead called off, a new booking
  // row and a booking.created. Such a booking SETTLES the reservation instead. It
  // throws on a failed read, because the fail open null the replay read gives would
  // walk straight into that recreate.
  if (key && !known) {
    const latest = await deps.findLatestBookingByIdempotencyKey(key);
    if (latest && !isActiveStatus(latest.status)) {
      if (bookingIsThisReservations(latest, reservation)) {
        await deps.deleteReservation(reservation.id);
        log.warn("reservations", {
          msg: "reservation settled: its booking committed and was later cancelled or completed, so it is not made again",
          reservation_id: reservation.id,
          booking_id: latest.id,
          booking_status: latest.status,
        });
        return { kind: "settled", booking: latest };
      }
      // Otherwise it is an EARLIER booking on the same key (a lead who cancelled and
      // then booked the same time again), and this reservation is a new create.
    }
    const already = latest && isActiveStatus(latest.status) ? latest : null;
    if (already) {
      const bookedCode = already.routing_trace?.bucket_code ?? bucketCode;
      const unfinished = await finishCommitted(async () => {
        await deliverCreatedSideEffects(deps, already, bookedCode, known);
        await deps.deleteReservation(reservation.id);
      });
      return {
        kind: "completed",
        completed: { result: { booking: already, manageUrl: manageUrl(deps, already.manage_token) }, unfinished },
      };
    }
  }

  // Create OR reuse the calendar event with the pinned client id. Past a cancelled
  // tombstone the create walks to a fresh id (#3217), and the reservation is
  // repointed at it first, so the drain holds the fresh event while the
  // reservation is pending and a resume adopts it rather than writing another.
  const gcalEventId = await deps.createEvent(
    reservation.pinned_agent_email,
    {
      summary: event.summary,
      description: event.description,
      location: event.location ?? undefined,
      start: event.start,
      end: event.end,
      timezone: event.timezone,
      attendeeEmail: event.attendeeEmail ?? undefined,
      attendeeName: event.attendeeName ?? undefined,
    },
    reservation.gcal_client_id,
    {
      onFreshId: async (fresh) => {
        await deps.repinReservationEvent(reservation.id, reservation.gcal_client_id, fresh);
        reservation.gcal_client_id = fresh;
      },
    },
  ).catch(async (err: unknown): Promise<never> => {
    if (!isInvalidAttendeeEmailRefusal(err)) throw err;
    // #3359: Google will never invite this address, so the reservation can never
    // complete and nothing was written to the calendar. Terminal, exactly like a
    // taken slot below: the row goes now, under the cleanup allowance, so neither
    // the drain nor the lead's own retry re-sends a create Google has refused. A
    // failed delete throws ITS error instead, and the row stays on the drain's
    // ordinary retry, where it backs off and pages rather than looping silently.
    await withinOwedCleanup(() => deps.deleteReservation(reservation.id));
    throw new AttendeeEmailRefusedError(err);
  });

  // #3495: the booking, its busy block, its webhook deliveries, its routing record and
  // the reservation's delete in ONE call (`commit_fresh_booking`), where they were
  // six. Built here from the reservation exactly as the separate calls were: the
  // bucket the booking lands in, the webhook fire() would send, and the routing
  // record, which a crash resume never writes (it is not re-run, as before).
  const bookingId = deps.newBookingId();
  const row = { ...bookingInsert, id: bookingId, gcal_event_id: gcalEventId };
  // On a tier drop the trace records the booked (lower) bucket, so the webhook, the
  // slot refresh and the routing record all name the bucket whose times changed.
  const bookedCode = bookingInsert.routing_trace?.bucket_code ?? bucketCode;
  const routed = bookingInsert.kind !== "agent_link";
  // Nothing was written. The reservation stays PENDING, so the drain, or the lead's
  // own retry, resumes it and adopts THIS event through its deterministic id
  // (#3215). The event is therefore NOT deleted live: a deleted event keeps its id,
  // so the resume would be handed a cancelled event and confirm a booking with
  // nothing on the agent's calendar. Its deletion is queued instead, and the drain
  // holds it while the reservation is pending, drops it once a booking adopts the
  // event, and deletes it only once neither does. Queued under the cleanup
  // allowance, because the commonest cause is the confirm budget running out. The
  // store's own error rides along as the cause, so a deadline in it still reaches
  // the route as the retryable outage (`timeoutAsRetryable`).
  const failNothingWritten = async (err: unknown): Promise<never> => {
    await queueOwedEventDeletion(deps, reservation.pinned_agent_email, gcalEventId, null);
    throw new Error("Failed to persist booking", { cause: err });
  };

  // The two reads behind the webhook and the routing record. A fresh confirm holds
  // both (`known`); only the drain's resume reads them. They feed those two parts
  // alone, which never decided whether a booking is made: before the one call save
  // they ran after the insert, where a failure cost that part and nothing else. So a
  // failed read degrades its part here, and never fails the booking.
  let resolved: Awaited<ReturnType<BookingDeps["resolveBucketByCode"]>> = null;
  let unbuilt: string | null = null;
  try {
    resolved =
      known && known.bucket.code === bookedCode
        ? { bucket: known.bucket, eventType: known.eventType }
        : await deps.resolveBucketByCode(bookedCode);
    if (!resolved) unbuilt = `the booked bucket ${bookedCode} no longer resolves`;
  } catch (err) {
    unbuilt = `the booked bucket ${bookedCode} would not read (${err instanceof Error ? err.message : String(err)})`;
    log.warn("booking", { msg: "the booked bucket would not read; saving the booking without its webhook, which the drain sends", booking_id: bookingId, bucket_code: bookedCode }, err);
  }
  // #3495: the advisor the confirm read before writing, when it is this booking's.
  // Unread, the routing record goes in without their attributes, which the misroute
  // check then does not judge (`alertIfMisroute`).
  let chosenAgent: User | null = null;
  if (routed && resolved) {
    try {
      chosenAgent =
        known && known.agent.id === row.assigned_user_id ? known.agent : await deps.getUser(row.assigned_user_id);
    } catch (err) {
      log.warn("routing", { msg: "the advisor would not read; the routing record goes in without their attributes", booking_id: bookingId }, err);
    }
  }

  // Everything else the save needs is built from what is held. A failure here sent
  // nothing, so it is today's failure before the insert, with no read back.
  let request: CommitFreshInput;
  try {
    const asBooking = row as unknown as Booking;
    const rt = bookingInsert.routing_trace;
    request = {
      booking: row,
      reservationId: reservation.id,
      webhook: !resolved
        ? { unbuilt: unbuilt ?? `the booked bucket ${bookedCode} no longer resolves` }
        : {
            payload: webhookPayload(deps, asBooking, resolved.bucket, resolved.eventType, null, null),
            // The one rule for a booking webhook's key (#436): booking.created keys on the id.
            dedupeKey: webhookDedupeKey("booking.created", { bookingId, bookingEventId: null }) ?? bookingId,
            // #459: a test bucket's delivery is recorded and never sent.
            suppressed: resolved.bucket.is_test,
          },
      // #2073: a named link booking logs no routing decision, and one whose bucket
      // would not read has nothing to log it against (as before the one call save).
      routing: !routed || !resolved
        ? null
        : {
            orgId: row.org_id,
            bookingId,
            bucketCode: resolved.bucket.code,
            bucketId: resolved.bucket.id,
            criteria: resolved.bucket.criteria,
            considered: rt?.considered ?? [],
            excluded: rt?.excluded ?? [],
            chosenUserId: row.assigned_user_id,
            chosenAttributes: chosenAgent?.attributes ?? null,
            emptyPoolFallback: rt?.fallback_applied ?? false,
            tierFallback: rt?.tier_fallback ?? false,
            rungsDropped: rt?.rungs_dropped ?? 0,
            requestedTier: rt?.requested_tier ?? null,
            bookedTier: rt?.booked_tier ?? null,
            // Judged against the bucket actually booked, never against the raw value
            // alone: the raw one comes from the client (#1908).
            ...catchallRecord(requestedCode, resolved.bucket.code, rt?.code_source),
            outcome: "booked",
          },
    };
  } catch (err) {
    return failNothingWritten(err);
  }

  let answer: CommitFreshResult;
  try {
    answer = await deps.commitFreshBooking(request);
  } catch (err) {
    // A call with no answer (a deadline, a dropped connection, an unreadable answer)
    // may have COMMITTED, so before a lead is told their booking failed it is read
    // back by their key, under the cleanup allowance since the budget may be spent.
    // A refusal Postgres answered wrote nothing, and needs no read (red team 3).
    if (!(err instanceof CommitRefusedError) && key) {
      // A read back that fails leaves it UNKNOWN whether the booking landed. The lead
      // is still told it failed, retryably (their retry finds it by key if it did),
      // but the failure is logged, or it reads exactly like a read that found nothing.
      const found = await withinOwedCleanup(() => deps.readBookingByIdempotencyKey(key)).catch((readErr: unknown) => {
        log.error("booking", { msg: "the save got no answer and could not be read back, so whether it landed is unknown", booking_id: bookingId }, readErr);
        return null;
      });
      if (found) {
        // Ours: the work after the save is run for it. Another request's, with the
        // lead's own key: it is the answer, exactly as a conflict's winner is.
        const unfinished = await finishCommitted(async () => {
          if (found.id === bookingId) await afterFreshCommit(deps, found, gcalEventId, bookedCode, bucketCode, routed);
          else await deps.deleteReservation(reservation.id);
        });
        log.warn("booking", { msg: "the save's answer was lost and the booking was read back", booking_id: found.id }, err);
        return {
          kind: "completed",
          completed: {
            result: { booking: found, manageUrl: manageUrl(deps, found.manage_token), ...(found.id === bookingId ? { newlyInserted: true } : {}) },
            unfinished,
          },
        };
      }
    }
    return failNothingWritten(err);
  }

  if (answer.kind === "conflict") {
    if (answer.winner) {
      // The lead's own key won (a concurrent duplicate): its booking is the answer
      // however this cleanup goes (#3263); a reservation left behind is the drain's.
      //
      // #3495: the event id is derived from the key AND the advisor, so a loser that
      // picked another advisor than the winner wrote an event of its own, which would
      // otherwise stay on that advisor's calendar as a second invite. A loser on the
      // winner's own advisor shares the winner's event, which must stay.
      const winner = answer.winner;
      const unfinished = await finishCommitted(async () => {
        if (winner.gcal_event_id !== gcalEventId) {
          await compensateEvent(deps, reservation.pinned_agent_email, gcalEventId, null);
        }
        await deps.deleteReservation(reservation.id);
      });
      return {
        kind: "completed",
        completed: { result: { booking: winner, manageUrl: manageUrl(deps, winner.manage_token) }, unfinished },
      };
    }
    // Genuinely unavailable: the event + reservation are owed a rollback, under
    // the cleanup allowance, since this failure can arrive with the confirm budget
    // spent (#3215). Handed back rather than run (#3462, `ReservationAttempt`).
    // #3439: an allowance of its own while the confirm has one to spare, because
    // the confirm goes on to the next advisor and may lose another race seconds
    // later, when the request's one shared allowance would already have ended.
    return {
      kind: "lost",
      rollBack: () =>
        withinLostRaceCleanup(async () => {
          await compensateEvent(deps, reservation.pinned_agent_email, gcalEventId, null);
          await dropLostReservation(deps, reservation.id);
        }),
    };
  }

  const booking = answer.booking;
  // #3263: the booking has COMMITTED. From here on a failure is returned as
  // unfinished rather than thrown, so the lead is answered with the booking that
  // exists. A webhook step that failed left the reservation pending, so the drain
  // re-runs the side effects and the webhook is not lost, which is today's rule.
  const failedWebhook = answer.failed.webhook;
  const unfinished = await finishCommitted(async () => {
    await afterFreshCommit(deps, booking, gcalEventId, bookedCode, bucketCode, routed);
    if (failedWebhook !== undefined) {
      throw new Error(`the booking committed and its webhook did not go in (${failedWebhook}); the reservation drain finishes it`);
    }
  });
  // #2838: the one return where THIS call's own save made the booking. Every other
  // return hands back a booking an earlier or racing confirm made.
  return {
    kind: "completed",
    completed: { result: { booking, manageUrl: manageUrl(deps, booking.manage_token), newlyInserted: true }, unfinished },
  };
}

/**
 * The work after a fresh booking's save that is not the database's (#3495): the
 * slot refresh, the stray mirror's delete, and the tier alert. The busy block, the
 * webhook, the routing record and the reservation are inside the save itself.
 */
async function afterFreshCommit(
  deps: BookingDeps,
  booking: Booking,
  /** The event this create wrote or adopted, never re-read off the row (#586). */
  gcalEventId: string,
  /** The bucket whose times changed: the booked one, a rung down on a tier drop. */
  bookedCode: string,
  /** The bucket the lead asked for, which the tier alert compares against. */
  requestedBucketCode: string,
  routed: boolean,
): Promise<void> {
  // #3324: after the busy block committed (inside the save), so the splice's fence
  // is stamped no earlier than the block every later compute will read.
  //
  // The save has already deleted the reservation, so nothing re-runs these three
  // steps: each has its own boundary, so one that throws cannot take the others with
  // it (L73), and none reports itself as work the drain will finish. A refresh that
  // fails leaves the time offered until the every minute recompute lane reconverges
  // the bucket, so it is logged as the error it is.
  try {
    await deps.invalidateSlots(
      bookedCode,
      booking.assigned_user_id
        ? { userId: booking.assigned_user_id, startsAt: booking.starts_at, endsAt: booking.ends_at }
        : undefined,
    );
  } catch (err) {
    log.error("booking", { msg: "the slot refresh after a booking failed; the recompute lane reconverges the bucket", booking_id: booking.id, bucket: bookedCode }, err);
  }

  // #586: the booking now owns this event id, so any source=gcal block for it is a
  // stray mirror a push-sync cached while racing the create. Deleted AFTER the commit
  // (inside it, a sync could write the mirror between the delete and the commit, red
  // team 4), and after the lead's answer when there is a scheduler to hand it to,
  // since it is best effort: the sync's slate-id delete and the full-resync purge are
  // the backstops.
  const userId = booking.assigned_user_id;
  if (userId && gcalEventId) {
    const clearMirror = async () => {
      try {
        await deps.deleteGcalMirrorBlock(userId, gcalEventId);
      } catch {
        // best-effort
      }
    };
    if (deps.deferSend) deps.deferSend(clearMirror);
    else await clearMirror();
  }

  // Best-effort routing fallback alert. Throttled via alert_state, and sent only
  // for a drop of two or more debt tiers. The rung COUNT is deliberately not
  // passed: since #1909 a rung is not a tier, so the alert derives it from the
  // two codes itself.
  //
  // Everything smaller SENDS NOTHING HERE: a sideways overflow (#2228), a top
  // tier cascade (#2843), and a single tier drop (2026-10-02), each the ladder
  // working as designed. The reasons are in tier-alert.ts.
  //
  // #3266: after the lead's answer on their own request, outside the confirm's
  // budget, since the booking is made and nothing in the answer reads the page.
  if (routed) {
    const tierAlert = tierFallbackAlert({
      requestedCode: requestedBucketCode,
      effectiveCode: booking.routing_trace?.bucket_code ?? requestedBucketCode,
    });
    if (tierAlert) {
      await pageAfterAnswer(deps.deferPage, "tier-fallback-page", () =>
        // alert-key: tier_fallback_deep:*
        sendThrottledAlert(tierAlert.key, tierAlert.cooldownMs, tierAlert.text).catch(
          logAlertSendFailure(tierAlert.key),
        ),
      );
    }
  }
}

/**
 * Drain pending create reservations (#429 P4 / Phase C): a booking whose create
 * crashed after the reservation was written resumes here. Each row is leased, then
 * completed idempotently: completeReservation reuses the pinned event and deletes
 * the row on success. A failure releases the lease so the next tick retries.
 *
 * The lease is what keeps two drains, and the drain and a lead's re-submit, from
 * both working one row. The re-submit takes the same lease (`resumeReservation`,
 * #3837) and a row it holds is skipped here; until #3837 it took none, so this
 * held only between drains. A live confirm's own reservation is kept off the drain
 * by its age instead (`RESERVATION_DRAIN_MIN_AGE_MS`, #3466).
 */
export async function processBookingReservations(
  deps: BookingDeps,
  limit: number,
): Promise<{
  processed: number;
  completed: number;
  /** #3847: reservations whose booking was already cancelled or completed, deleted
   *  without making anything again. */
  settled: number;
  failed: number;
  stuck: BookingReservation[];
}> {
  const rows = await deps.loadDrainableReservations(limit);
  let completed = 0;
  let settled = 0;
  let failed = 0;
  const stuck: BookingReservation[] = [];
  // Complete reservations concurrently but bounded (AUD-062): each is leased
  // first, so two drains never double-run a row; a large backlog clears in far
  // fewer ticks than a serial await-per-row loop.
  await mapWithConcurrency(rows, RESERVATION_DRAIN_CONCURRENCY, async (reservation) => {
    const lease = await deps.leaseReservation(reservation.id);
    if (lease === null) return;
    try {
      // #3263: a lead's confirm answers a committed booking whatever became of
      // the work after it; the drain is what finishes that work, so for the drain
      // an unfinished finish is a failure: it backs off and reaches the stuck alert.
      const done = await completeReservation(deps, reservation);
      // #3847: settled, its booking already cancelled or completed. The row is gone
      // and nothing is owed, so it is neither a completion nor a failure.
      if (done === null) {
        settled++;
        return;
      }
      if (done.unfinished !== null) throw done.unfinished;
      completed++;
    } catch (err) {
      failed++;
      // A genuine SlotUnavailable is TERMINAL: completeReservation already deleted
      // the row (the slot was taken), so don't bump/alert - that would schedule a
      // backoff on a row that no longer exists and could fire a "not completing"
      // alert pointing on-call at a deleted row. Only a TRANSIENT failure leaves
      // the row pending: bump attempts + last_error with backoff (#445) so we
      // don't re-hit it every tick; past the alert threshold it's reported stuck.
      if (err instanceof AttendeeEmailRefusedError) {
        // #3359: terminal for the same reason, and completeReservation has already
        // deleted the row. Said in the log because the row, and its last_error, are
        // gone: this line is the only record of why. No address, which is contact data.
        log.warn("reservations", {
          msg: "reservation deleted: Google refused the attendee email, which no retry can change",
          reservation_id: reservation.id,
          attempts: reservation.attempts + 1,
        });
      } else if (!(err instanceof SlotUnavailableError)) {
        const attempts = reservation.attempts + 1;
        // #3859: a refused rollback's message is the sentence a lead is shown, so the
        // row records what the database said instead.
        const lastError =
          err instanceof ReservationRollbackError ? err.detail : err instanceof Error ? err.message : String(err);
        await deps.bumpReservationAttempt(reservation.id, attempts, lastError);
        if (attempts >= DRAIN_ALERT_AFTER) {
          stuck.push({ ...reservation, attempts, last_error: lastError });
        }
      }
    } finally {
      // Always release, even if the bump above rejected - mirror the outbox
      // drain so a transient bump error can't leak the lease or abort the batch.
      // Gated on our own token (#3169): past the TTL another drain may hold it now.
      await deps.releaseReservationLease(reservation.id, lease);
    }
  });
  return { processed: rows.length, completed, settled, failed, stuck };
}

/**
 * GC sweep for abandoned reschedule lease-pins (#439, milestone #7). A crash +
 * never-retried reassign leaves a stray Google event — cosmetic, since
 * availability is busy_blocks-cache-first and never reads live Google, and the
 * expired lease already unblocks the booking. For each lease past its
 * `lease_until + grace` whose REASSIGN pin was never adopted (its
 * `gcal_client_id` isn't the booking's live event), enqueue the orphaned event
 * for durable deletion, then delete the lock row. Cleanup ONLY — it never
 * completes or reassigns a booking, so it does not violate the "no completion
 * drain" decision. Runs on the existing /api/cron/outbox lane.
 *
 * `dropped` counts the pins whose reschedule was genuinely LOST: the booking never
 * reached the pinned target time, so it is still sitting where it started and the
 * move has to be re-run. The caller alerts on it, because cleaning this up in
 * silence let a stranded reschedule vanish unnoticed (#757, "fail loud, not
 * silent"). A pin whose booking DID reach the target is not dropped: that
 * reschedule committed and only its lock release was lost, and alerting on it would
 * cry wolf.
 *
 * #3924: an IN PLACE pin can leave the lead's invite wrong, not just a stray lock.
 * The move PATCHes the booking's own invite with `sendUpdates=all` before it commits,
 * so a crash between the two leaves the lead emailed a time nobody booked, and the
 * moved invite handler (#3919) cannot see it, because it arrived while this pin held
 * the booking's lock. So for an in place pin the sweep reads the invite and, when it
 * is at the pin's target, PATCHes it back to the booking's time, which emails the
 * lead the booked time again. Anything it cannot put back is returned in
 * `strandedInvites` for the caller to report. Undoing rather than finishing the
 * move is this sweep's rule throughout: it never completes a reschedule.
 *
 * Every row is TAKEN OVER before it is touched (`takeOverAbandonedReschedulePin`), a
 * compare and swap on the row still being the abandoned one, and freed with the
 * token that took it. So two sweeps never both act on a row, and a reschedule that
 * adopted the pin between the read and the takeover keeps it: the sweep no longer
 * deletes a lock a live holder has just taken. While the sweep holds it, a lead's
 * reschedule and the moved invite handler find the booking locked and leave it.
 * A failed queueing throws with the lock still leased, so the next sweep retries it.
 */
export async function processAbandonedReschedulePins(
  deps: BookingDeps,
  graceMs: number,
  nowMs: number = Date.now(),
): Promise<AbandonedPinSweep> {
  const rows = await deps.loadAbandonedReschedulePins(graceMs);
  let swept = 0;
  let enqueued = 0;
  let dropped = 0;
  let invitesPutBack = 0;
  const strandedInvites: StrandedInvite[] = [];
  for (const row of rows) {
    const token = await deps.takeOverAbandonedReschedulePin(row, graceMs);
    if (token === null) continue;
    swept += 1;
    // A reroute's pin always names an event of its own. An in place pin names the
    // booking's own event, unless the move RECREATED a deleted one (#617, #3217),
    // when it names that recreated event, which a crash before the commit leaves
    // on the calendar. So an in place pin owns its event only when it is not the
    // booking's, and only when the booking's event was actually read: a null there
    // says nothing. The drain asks who holds the event before deleting it.
    if (
      row.gcal_client_id &&
      row.gcal_client_id !== row.booking_gcal_event_id &&
      (row.branch === "reassign" || row.booking_gcal_event_id !== null)
    ) {
      await deps.enqueueEventDeletion(row.pinned_agent_email, row.gcal_client_id, row.booking_id);
      enqueued += 1;
    }
    // Compare instants, not strings: the DB and the pin can render the same moment
    // with different ISO spellings (`+00:00` vs `Z`). A booking that no longer
    // exists has no stranded reschedule to re-run, so it is cleanup, not a drop.
    if (
      row.booking_starts_at !== null &&
      Date.parse(row.booking_starts_at) !== Date.parse(row.target_starts_at)
    ) {
      dropped += 1;
    }
    if (row.branch === "in_place" && row.gcal_client_id) {
      const invite = await putBackAbandonedInvite(deps, row, row.gcal_client_id, nowMs);
      if (invite === "put-back") invitesPutBack += 1;
      else if (invite !== null) strandedInvites.push(invite);
    }
    await deps.releaseAbandonedReschedulePin(row.booking_id, token);
  }
  return { swept, enqueued, dropped, invitesPutBack, strandedInvites };
}

const INVITE_ACTIVE: ReadonlySet<BookingStatus> = new Set<BookingStatus>(["confirmed", "rescheduled"]);

/**
 * #3924: put an abandoned in place move's invite back to its booking's time, under
 * the lock the sweep holds. Null when there is nothing to do; never throws, because
 * a failure here is a report, not a reason to leave the lock or stop the sweep.
 *
 * The booking is read again under the lock, because the sweep's own read came
 * before it. A booking that is gone, cancelled or completed, reassigned (its invite
 * is another event now), or whose call has ended is left alone: there is nothing
 * the lead could still be misled about that a put back would fix, and a cancelled
 * call must never be emailed about. An invite that is gone or holds no time is left
 * too: that is not something the crashed move did.
 */
async function putBackAbandonedInvite(
  deps: BookingDeps,
  row: AbandonedReschedulePin,
  eventId: string,
  nowMs: number,
): Promise<"put-back" | StrandedInvite | null> {
  const stranded = (
    reason: StrandedInvite["reason"],
    bookedStartsAt: string | null,
    inviteStartsAt: string | null,
    detail: string | null,
  ): StrandedInvite => ({
    bookingId: row.booking_id,
    advisorEmail: row.pinned_agent_email,
    bookedStartsAt,
    targetStartsAt: row.target_starts_at,
    inviteStartsAt,
    reason,
    detail,
  });
  let booking: BookingInviteState | null;
  try {
    booking = await deps.readBookingInviteState(row.booking_id);
  } catch (err) {
    return stranded("booking-unreadable", row.booking_starts_at, null, shortErrorReason(err));
  }
  if (!booking || !INVITE_ACTIVE.has(booking.status) || booking.gcal_event_id !== eventId) return null;
  const endsMs = parseStampMs(booking.ends_at);
  if (endsMs !== null && endsMs <= nowMs) return null;
  let event: GoogleEvent | null;
  try {
    event = await deps.readEventOnPrimary(row.pinned_agent_email, eventId);
  } catch (err) {
    return stranded("invite-unreadable", booking.starts_at, null, shortErrorReason(err));
  }
  if (!event) return null;
  const booked = { startsAt: booking.starts_at, endsAt: booking.ends_at };
  const verdict = judgeAbandonedInvite(event, booked, row.target_starts_at, booking.timezone);
  if (verdict === "nothing") return null;
  const inviteStartsAt = event.start?.dateTime ?? event.start?.date ?? null;
  if (verdict === "elsewhere") return stranded("elsewhere", booking.starts_at, inviteStartsAt, null);
  try {
    await deps.updateEventTime(row.pinned_agent_email, eventId, booking.starts_at, booking.ends_at, booking.timezone);
  } catch (err) {
    return err instanceof EventGone
      ? stranded("gone", booking.starts_at, inviteStartsAt, null)
      : stranded("refused", booking.starts_at, inviteStartsAt, shortErrorReason(err));
  }
  return "put-back";
}

/**
 * GC sweep for abandoned standalone-reassign create intents (#518). A crash
 * between `reassignBooking`'s createEvent and the atomic swap leaves the new
 * event orphaned on the target calendar with the booking still on the old agent;
 * a crash after the swap but before the inline delete-old leaves the REPLACED
 * event orphaned. Both are recorded on the intent. For each intent past
 * `lease_until + grace`, delete whichever recorded event is NOT the booking's
 * live one, then remove the intent row.
 *
 * Cleanup ONLY, like the reschedule sweep it never completes/reassigns (resume
 * is a verified trap: the reassign ordinal is computed live and the swap appends
 * history unconditionally, so a resumed swap would spawn a third event + double
 * the history). `dropped` counts intents whose NEW event was never adopted (a
 * contact-owner reassign that was silently lost), so the caller alerts on it
 * ("fail loud"; the machine override path has no human retry loop).
 */
export async function processAbandonedReassignIntents(
  deps: BookingDeps,
  graceMs: number,
): Promise<{ swept: number; enqueued: number; dropped: number }> {
  const rows = await deps.loadAbandonedReassignIntents(graceMs);
  let enqueued = 0;
  let dropped = 0;
  for (const row of rows) {
    const live = row.booking_gcal_event_id;
    // The NEW event is not the live one, so it is an orphan either way: delete it.
    // But whether that means the reassign was LOST depends on whether its swap ever
    // committed (#758). A committed swap that a LATER reassign superseded also leaves
    // its event non-live, and calling that "silently lost, re-run it" is a false alarm
    // for a reassign that actually happened. `swapped_at` is written only after the
    // swap commits, so it separates the two; null still means never adopted => lost.
    if (row.gcal_client_id !== live) {
      await deps.enqueueEventDeletion(row.pinned_agent_email, row.gcal_client_id, row.booking_id);
      enqueued += 1;
      if (row.swapped_at === null) dropped += 1;
    }
    // The REPLACED old event (recorded post-swap): if it isn't the live event,
    // the swap committed (reassign succeeded) but the inline delete-old was
    // interrupted. Finish it. This is NOT a dropped reassign.
    if (
      row.prev_gcal_event_id &&
      row.prev_agent_email &&
      row.prev_gcal_event_id !== live
    ) {
      await deps.enqueueEventDeletion(row.prev_agent_email, row.prev_gcal_event_id, row.booking_id);
      enqueued += 1;
    }
    await deps.deleteReassignIntent(row.booking_id, row.gcal_client_id);
  }
  return { swept: rows.length, enqueued, dropped };
}

/** Input for the direct booking API path: a normal booking plus the external
 *  caller's required per-person id and the confirm-reschedule flag (#357). */
export interface ApiBookingInput extends CreateBookingInput {
  externalId: string;
  confirmReschedule: boolean;
}

/** Read-only preview of what an API booking WOULD do (dry run, #380). */
export interface ApiBookingPreview {
  dryRun: true;
  outcome: ApiBookingOutcome;
  /** For a would-be create: the agent round-robin + verify-on-book would assign. */
  wouldAssign: { id: string; name: string | null; email: string | null } | null;
  /** For dedupe/reschedule/confirm: the existing booking the person matched. */
  existingBookingId: string | null;
}

export type ApiBookingOutcome =
  | "created"
  | "deduped"
  | "rescheduled"
  | "confirm_required";

/**
 * Why a requested bucket change could not be honoured (#1465).
 *
 * Both are ordinary "no" answers from the target bucket rather than errors: the
 * lead still holds a valid appointment, so answering with a failure would tell
 * the caller nothing is booked, which is false. Anything else propagates.
 */
export type BucketChangeDeclineReason = "slot_taken" | "no_eligible_agents";

export interface ApiBookingResult {
  outcome: ApiBookingOutcome;
  booking: Booking;
  manageUrl: string;
  /** #543: present on a "rescheduled" outcome when the in-place agent was
   *  declined and the booking reassigned. Observability only. */
  rescheduleDecline?: RescheduleDeclineReason;
  /**
   * #1465: present on a "deduped" outcome when the request named a DIFFERENT
   * bucket and the move into it could not be made. The lead keeps the
   * appointment they had, in the OLD bucket, and this says so, because a bare
   * 200 deduped reads as "handled" while the routing request was dropped.
   */
  bucketChangeDeclined?: BucketChangeDeclineReason;
  /**
   * #2838, #2861: the race tally row THIS call's own confirm earned, beside its
   * ordinary outcome: a booking made after a lost overlap race, on the create arm
   * or on a cross bucket move, or a move refused after one and reported as a
   * declined bucket change. Absent on an uncontested confirm and on a replay of a
   * booking an earlier call made. A lost race that is THROWN is not named here:
   * the route counts the `RaceLostRefusalError` itself, so it is counted once.
   */
  raceOutcome?: RaceTallyOutcome;
  /** #3267: on the create arm, the confirm answered the booking and left the work
   *  after its save to the reservation drain (`BookingResult.followUpLeftToDrain`). */
  followUpLeftToDrain?: true;
}

// Machine-to-machine rebooking reason; recorded on the reschedule history row.
const API_REBOOK_REASON: ValidatedReason = { code: "api_rebooking", detail: null };

/**
 * Direct booking API entry (#357): enforce "one active appointment per person".
 * Look the lead up across active bookings, grade the match, then create / dedupe
 * / auto-reschedule / ask-to-confirm. Auto-reschedule reuses the full reschedule
 * path (verify-on-book, history, booking.rescheduled webhook) when the bucket is
 * unchanged.
 *
 * A rebook naming a DIFFERENT bucket is a routing request, not a time request,
 * and it is honoured at BOTH a new time (#364) and the time the lead already
 * holds (#1465), by the same move: create in the new bucket first, then cancel
 * the old, so a refusal there leaves the existing appointment intact.
 */
/** Shared person-dedupe decision used by both the real book and the dry run. */
async function resolvePersonDecision(
  input: ApiBookingInput,
  deps: BookingDeps,
) {
  const identity = personIdentityOf(input);
  // The decision is graded in the WORLD of the bucket being booked (#2660): the
  // canary's SMOKE booking dedupes against its SMOKE2 one (both test) and never
  // against a real lead's, and a real lead's never against a test booking.
  //
  // #3489: the person read is asked in that bucket's world BY ITS CODE, which the read
  // maps to the world itself, so it goes out beside the bucket read instead of after
  // it: one round trip fewer before every confirm. Both are settled before either is
  // used, and the bucket decides first, so an unknown or hidden bucket is the same 422
  // whatever the person read did, and only then does a failed person read fail the
  // confirm (never read as no bookings).
  const [bucketRead, personRead] = await Promise.allSettled([
    deps.resolveBucketByCode(input.bucketCode),
    deps.findActiveBookingsForPerson(identity, { bucketCode: input.bucketCode }),
  ]);
  if (bucketRead.status === "rejected") throw bucketRead.reason;
  const resolved = bucketRead.value;
  if (!resolved) throw new UnknownBucketError();
  if (resolved.bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();
  if (personRead.status === "rejected") throw personRead.reason;
  const candidates = personRead.value;
  const match = findPersonMatch(identity, candidates);
  const decision = decidePersonBooking({
    startIso: input.startIso,
    match,
    confirmReschedule: input.confirmReschedule,
  });
  // #2670: handed on, so the create (or the move) does not read the bucket again.
  const requested: KnownBucket = { code: input.bucketCode, resolved };
  return { decision, requested };
}

/**
 * Dry run (#380): run the full decision — person match, and for a would-be
 * create the real round-robin + verify-on-book — and report what WOULD happen,
 * writing nothing (no calendar event, no booking, no webhook). Routing failures
 * (e.g. NoEligibleAgentsError) still surface, so the caller can validate a bucket.
 */
export async function previewBooking(
  input: ApiBookingInput,
  deps: BookingDeps,
): Promise<ApiBookingPreview> {
  const { decision, requested } = await resolvePersonDecision(input, deps);
  // #2310, L686: the dry run runs the same calling-window judge the real call
  // does, on exactly the arms where the real call runs it: a create, and a rebook
  // that becomes a reschedule (judged in the request's zone there too). A dedupe
  // keeps the instant the lead already holds, and confirm_required books
  // nothing, so neither is judged by the real call and neither is here.
  if (decision.action === "create" || decision.action === "reschedule") {
    assertWithinLeadCallingWindow(input.startIso, input.timezone);
  }
  if (decision.action === "create") {
    // #2670: the bucket the person decision already resolved and vetted (unknown
    // and hidden test buckets were refused there), so it is not read twice.
    const { resolved } = requested;
    // Route through the SAME per-slot tier cascade the real book uses
    // (assignAgentWithTierFallback), not a plain single-bucket assign. Otherwise
    // the dry run answers "no eligible" for a busy-but-not-empty top tier that the
    // real book would serve from a lower rung, so preview and book disagree (#541).
    const tier = await assignAgentWithTierFallback(
      deps,
      { bucket: resolved.bucket, eventType: resolved.eventType },
      input.startIso,
      input.allowTestBuckets ?? false,
      true, // preview: read-only, no unfair-ordering alert
    );
    const agent = await deps.getUser(tier.userId);
    return {
      dryRun: true,
      outcome: "created",
      wouldAssign: { id: agent.id, name: agent.name, email: agent.email },
      existingBookingId: null,
    };
  }
  const outcome: ApiBookingOutcome =
    decision.action === "dedupe" ? "deduped" : decision.action === "reschedule" ? "rescheduled" : "confirm_required";
  return { dryRun: true, outcome, wouldAssign: null, existingBookingId: decision.booking.id };
}

/** Identity-free input for the validate-only bookable check (#541/#1017). No
 *  lead, no person-dedupe: only "could SOMEONE book this bucket at this time?". */
export interface BookableInput {
  bucketCode: string;
  startIso: string;
  allowTestBuckets?: boolean;
}

/** Why a slot is / is not bookable. `available` = an agent would take it;
 *  `closed` = the ORG is not open at T, so no agent could take it whatever the
 *  roster looks like (#1295); `slot_taken` = the whole tier ladder is busy at T;
 *  `no_eligible_agents` = the pool is empty/misconfigured all the way down. A
 *  transient verify outage is NOT a reason here: it throws VerifyUnavailableError
 *  so the caller never gets a false "no".
 *
 *  `closed` exists because without it a shut org answered `slot_taken`, a claim the
 *  check never measured: every agent fails gate 1, the ladder reports itself
 *  exhausted, and the caller is told the times were taken when nobody was ever
 *  offered them. Distinct causes get distinct messages. */
export type BookableReason = "available" | "closed" | "slot_taken" | "no_eligible_agents";

export interface BookableResult {
  bookable: boolean;
  reason: BookableReason;
  /** The bucket that would actually serve after the per-slot tier cascade, or null
   *  when nothing could (bookable:false). */
  effectiveBucketCode: string | null;
  /** True when the requested tier was busy and a lower rung would serve instead. */
  tierFallback: boolean;
  rungsDropped: number;
  wouldAssign: { id: string; name: string | null; email: string | null } | null;
}

/**
 * Answer "is this exact time bookable in this bucket?" WITHOUT writing anything
 * and WITHOUT any lead identity (#541/#1017). It runs the SAME per-slot routing
 * the real book runs (round-robin candidates + verify-on-book, cascading down the
 * debt-tier ladder), so the answer can never disagree with an actual book: a
 * cache-membership check was rejected in planning because the availability
 * cascade drops a tier only when the WHOLE horizon is empty, while the booking
 * cascade drops PER-SLOT at T.
 *
 * Routes in preview mode (no unfair-ordering alert). A busy
 * ladder is a normal `bookable:false` answer, NOT an error; only an unknown
 * bucket (UnknownBucketError) and a transient verify outage (VerifyUnavailableError)
 * throw, so the caller can map them to 422 / 503 respectively.
 */
export async function checkBookable(
  input: BookableInput,
  deps: BookingDeps,
): Promise<BookableResult> {
  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new UnknownBucketError();
  // A hidden smoke-test bucket is invisible unless the caller opts in, exactly as
  // the real book treats it (createBooking), so it can never be probed here.
  if (resolved.bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();

  // Gate 1 up front (#1295). The routing pass below would also refuse a closed hour,
  // every agent failing the same gate, but it would surface as `slot_taken`: the
  // ladder cannot tell "everyone is busy" from "nobody was ever offered this". An
  // unreadable week throws out of here rather than answering, so a read failure can
  // never present as a confident "the org is open".
  const businessHours = await deps.businessHours();
  const startMs = Date.parse(input.startIso);
  const endMs = startMs + resolved.eventType.duration_min * 60_000;
  // #1363: through the org's own judge, so a date exception shuts this path too.
  // The weekly rules alone would keep accepting a booking on a holiday.
  if (!isOrgOpen(businessHours, startMs, endMs)) {
    return notBookable("closed");
  }

  try {
    const tier = await assignAgentWithTierFallback(
      deps,
      { bucket: resolved.bucket, eventType: resolved.eventType },
      input.startIso,
      input.allowTestBuckets ?? false,
      true, // preview: read-only
    );
    const agent = await deps.getUser(tier.userId);
    return {
      bookable: true,
      reason: "available",
      effectiveBucketCode: tier.bucket.code,
      tierFallback: tier.bucket.code !== resolved.bucket.code,
      rungsDropped: tier.rungsDropped,
      wouldAssign: { id: agent.id, name: agent.name, email: agent.email },
    };
  } catch (err) {
    // The ladder is genuinely exhausted at T: a normal "no", never an error.
    if (err instanceof SlotUnavailableError) {
      return notBookable("slot_taken");
    }
    if (err instanceof NoEligibleAgentsError) {
      return notBookable("no_eligible_agents");
    }
    // VerifyUnavailableError (a transient outage) and anything unexpected propagate,
    // so a hiccup never masquerades as a confident "not bookable".
    throw err;
  }
}

/**
 * From a bucket's offered slot instants, the nearest one strictly before and the
 * nearest strictly after `aroundIso` (#1017 `alternatives` hints). Pure so it is
 * node-testable; the caller supplies the cached slots. Tolerates an unsorted list
 * and skips unparseable / exactly-equal instants. These are HINTS from the
 * availability cache, not a guarantee the slot is still free at book time.
 */
export function nearestSlots(
  slots: string[],
  aroundIso: string,
): { before: string | null; after: string | null } {
  const around = Date.parse(aroundIso);
  let before: string | null = null;
  let after: string | null = null;
  for (const s of slots) {
    const t = Date.parse(s);
    if (!Number.isFinite(t) || t === around) continue;
    if (t < around) {
      if (before === null || t > Date.parse(before)) before = s;
    } else if (after === null || t < Date.parse(after)) {
      after = s;
    }
  }
  return { before, after };
}

function notBookable(reason: BookableReason): BookableResult {
  return {
    bookable: false,
    reason,
    effectiveBucketCode: null,
    tierFallback: false,
    rungsDropped: 0,
    wouldAssign: null,
  };
}

/**
 * Move a lead's existing appointment into the bucket the request names, when
 * that bucket differs from the one they are in (#364, #1465).
 *
 * Create in the new bucket FIRST, then cancel the old, so a refusal in the new
 * bucket leaves the existing appointment intact rather than leaving the lead
 * with nothing. At the SAME instant that ordering matters most: the lead's own
 * booking still occupies their current agent while the new one is placed, so a
 * bucket whose only free agent is that same person legitimately answers no.
 *
 * `tolerateRefusal` decides what a normal "no" from the new bucket means, and
 * the two callers genuinely differ. On a same-instant rebook the lead keeps a
 * valid appointment, so the refusal is reported as a declined bucket change; on
 * a rebook to a new time they asked for something they did not get, so it
 * propagates.
 */
type BucketMove =
  | { outcome: "unchanged" }
  | { outcome: "moved"; booking: Booking; manageUrl: string; raceOutcome: RaceTallyOutcome | null }
  | { outcome: "declined"; reason: BucketChangeDeclineReason; raceOutcome: RaceTallyOutcome | null };

/** Spread onto an `ApiBookingResult`: the field only when there is a race to count. */
function raceField(raceOutcome: RaceTallyOutcome | null): { raceOutcome?: RaceTallyOutcome } {
  return raceOutcome ? { raceOutcome } : {};
}

async function moveToRequestedBucket(
  input: ApiBookingInput,
  existing: Booking,
  deps: BookingDeps,
  /** #2670: the bucket the person decision already resolved, so it is read once. */
  requested: KnownBucket,
  /** `held`: the caller holds this slot's confirm line turn (#3257). */
  opts: { tolerateRefusal?: boolean; held?: HeldTurn } = {},
): Promise<BucketMove> {
  if (requested.resolved.bucket.id === existing.bucket_id) return { outcome: "unchanged" };

  // #3462: a refusal tolerated here is answered as a declined move, and this call's
  // turn then reports that nothing settles (`bookViaApiDecided`), so the create must
  // not tell the line early that the time is taken. One that is not tolerated goes
  // up as itself, and the line hears a lost race as taken either way.
  // #3529: either way it is a move, which never walks past claims.
  const held: HeldTurn | undefined = opts.held
    ? opts.tolerateRefusal !== false
      ? { seat: opts.held.seat, queued: opts.held.queued, move: true }
      : { ...opts.held, move: true }
    : undefined;
  let created: Awaited<ReturnType<typeof createBooking>>;
  try {
    created = await createBooking(input, deps, { requested, held });
  } catch (err) {
    if (opts.tolerateRefusal === false) throw err;
    // Only the two ordinary "no" answers are tolerated. A transient verify
    // outage or anything unexpected must never be reported as a lead who simply
    // could not be moved, because that would be a claim the code never measured.
    //
    // #2861: a refusal after a lost overlap race is still a declined bucket
    // change to the caller, and is named so the race tally counts it. Swallowed
    // here, it would never reach the route's own catch, which is the only other
    // place a lost race refusal is counted.
    if (err instanceof SlotUnavailableError) {
      return {
        outcome: "declined",
        reason: "slot_taken",
        raceOutcome: err instanceof RaceLostRefusalError ? raceOutcomeForRefusal(err) : null,
      };
    }
    if (err instanceof NoEligibleAgentsError) {
      return { outcome: "declined", reason: "no_eligible_agents", raceOutcome: null };
    }
    throw err;
  }
  await cancelBooking(existing.manage_token, API_REBOOK_REASON, "system", deps);
  return {
    outcome: "moved",
    booking: created.booking,
    manageUrl: created.manageUrl,
    // #2867: its own row, because a move's outcome row is `rescheduled` or
    // `deduped` and never `created`, so the create arm's row would count a
    // loser with no confirm behind it.
    raceOutcome: raceOutcomeForMove(created),
  };
}

export async function bookViaApi(
  input: ApiBookingInput,
  deps: BookingDeps,
): Promise<ApiBookingResult> {
  // #3257: join the slot's confirm line BEFORE the person decision. With the line
  // behind it, a hundred calls for one slot each read the bucket and the person's
  // bookings first, and on 2026-10-04 (run 37229344882) those reads timed out on
  // every one of them, so nobody was booked. Now the first call leads and runs the
  // whole decision; the rest wait, read nothing, and are answered from what it
  // showed. Whoever books has run the person decision itself (#357, #1641), as
  // leader or after waiting out the bound, so dedupe for one person is unchanged.
  const key = queueKeyBeforeRouting(input, deps.lineGroupOf);
  if (key === null) return (await bookViaApiDecided(input, deps, undefined)).result;
  const { result } = await inConfirmTurn(
    deps,
    { key, stableKey: stableKeyFor(input), bucketCode: input.bucketCode, startIso: input.startIso, person: personIdentityOf(input) },
    (held) => bookViaApiDecided(input, deps, held),
    // A double submit answered from its own first call's verdict gets that booking:
    // waiting behind it in line, or arriving inside the line's memory of the verdict
    // after it answered (#3570). It made nothing, so it says `deduped`, as the person
    // decision answers the same resubmit once the line has forgotten (#4019): told
    // `created`, a caller may treat a booking it already holds as a new one. No race
    // row, since the call that made it already counted one.
    (taker): ApiBookingResult => ({ outcome: "deduped", booking: taker.result.booking, manageUrl: taker.result.manageUrl }),
    // #3257: a resubmit of a call the lead already holds (a retry, a double send)
    // is answered from the person decision without waiting behind a confirm that
    // is still booking, as it was before the line existed.
    async () => {
      const { decision, requested } = await resolvePersonDecision(input, deps);
      if (decision.action === "create" || !takesNoAdvisorHere(decision, requested)) return null;
      return bookViaApiArm(input, deps, decision, requested, undefined);
    },
  );
  return result;
}

/**
 * Whether the person decision's arm leaves this time's advisors alone (#3257):
 * asking the lead first, or a same instant resubmit in the bucket they already
 * hold, which hands back the call they have. A move into another bucket or a
 * reschedule into this time DOES take an advisor here, and claims one like any
 * new booking.
 */
function takesNoAdvisorHere(
  decision: Exclude<Awaited<ReturnType<typeof resolvePersonDecision>>["decision"], { action: "create" }>,
  requested: KnownBucket,
): boolean {
  if (decision.action === "confirm_required") return true;
  return decision.action === "dedupe" && requested.resolved.bucket.id === decision.booking.bucket_id;
}

/**
 * The direct booking API's person decision and the arm it chose, with what that
 * showed about the slot for the calls waiting behind it (#3257). Only the create
 * arm can settle the slot for them; a dedupe, a move or a reschedule is about this
 * one person, so the next call in line runs for itself.
 */
async function bookViaApiDecided(
  input: ApiBookingInput,
  deps: BookingDeps,
  /** The slot's turn this call holds, so a create or a move must not join again;
   *  undefined when it is outside the line (a link whose bucket is not known yet). */
  held: HeldTurn | undefined,
): Promise<{ result: ApiBookingResult; verdict: LeaderVerdict<ConfirmTaker> }> {
  const { decision, requested } = await timeStage(deps.profile, "person-decision", () => resolvePersonDecision(input, deps));
  deps.mark?.("decided");
  if (decision.action === "create") {
    const { result: res, verdict } = await createBookingWithVerdict(input, deps, { requested, held });
    return {
      result: {
        outcome: "created",
        booking: res.booking,
        manageUrl: res.manageUrl,
        ...raceField(raceOutcomeForConfirm(res)),
        ...(res.followUpLeftToDrain ? { followUpLeftToDrain: true as const } : {}),
      },
      verdict,
    };
  }
  // #3257: an arm that takes no advisor at this time hands the line on now, so it
  // never holds up a lead booking here for the length of its own work.
  if (takesNoAdvisorHere(decision, requested)) await held?.seat?.pass();
  return { result: await bookViaApiArm(input, deps, decision, requested, held), verdict: { full: false } };
}

async function bookViaApiArm(
  input: ApiBookingInput,
  deps: BookingDeps,
  decision: Exclude<Awaited<ReturnType<typeof resolvePersonDecision>>["decision"], { action: "create" }>,
  requested: KnownBucket,
  held: HeldTurn | undefined,
): Promise<ApiBookingResult> {
  switch (decision.action) {
    case "dedupe": {
      // #1465: the decision is made on the INSTANT alone, which is right for its
      // own rule (the same instant is the same booking intent) but leaves the
      // bucket with nowhere to be noticed. A re-tiered lead confirming the time
      // they already hold is the ordinary call, and answering 200 deduped left
      // them with the old pool and the old agent while the response said nothing.
      const moved = await moveToRequestedBucket(input, decision.booking, deps, requested, { held });
      if (moved.outcome === "moved") {
        return {
          outcome: "rescheduled",
          booking: moved.booking,
          manageUrl: moved.manageUrl,
          ...raceField(moved.raceOutcome),
        };
      }
      return {
        outcome: "deduped",
        booking: decision.booking,
        manageUrl: manageUrl(deps, decision.booking.manage_token),
        // Undefined when the bucket never changed, so the field means "the
        // change you asked for was dropped" rather than merely "no change".
        ...(moved.outcome === "declined"
          ? { bucketChangeDeclined: moved.reason, ...raceField(moved.raceOutcome) }
          : {}),
      };
    }
    case "reschedule": {
      // #364: if the rebook targets a DIFFERENT bucket than the existing
      // appointment, move the lead to the new bucket rather than just shifting
      // the time within the original one (so they route to the team matching
      // their new request). One shared move with the same-instant case (#1465),
      // so the two cannot diverge on what a bucket change means.
      //
      // A refusal here is NOT swallowed: the lead asked for a different time and
      // did not get it, so there is nothing to report as handled and the error
      // propagates. That asymmetry with the dedupe arm is the point.
      const moved = await moveToRequestedBucket(input, decision.booking, deps, requested, {
        tolerateRefusal: false,
        held,
      });
      if (moved.outcome === "moved") {
        return {
          outcome: "rescheduled",
          booking: moved.booking,
          manageUrl: moved.manageUrl,
          ...raceField(moved.raceOutcome),
        };
      }
      const res = await rescheduleBooking(
        decision.booking.manage_token,
        input.startIso,
        API_REBOOK_REASON,
        "system",
        deps,
        undefined,
        undefined,
        undefined,
        // #2310: judged in the zone the caller sent with this request, the
        // same zone its create arm is judged in.
        // #3257: a move into this time takes an advisor here, so it claims one.
        { leadZone: input.timezone, seat: held?.seat ?? null },
      );
      return {
        outcome: "rescheduled",
        booking: res.booking,
        manageUrl: res.manageUrl,
        rescheduleDecline: res.rescheduleDecline,
      };
    }
    case "confirm_required":
      return {
        outcome: "confirm_required",
        booking: decision.booking,
        manageUrl: manageUrl(deps, decision.booking.manage_token),
      };
  }
}

/** Active statuses a person can still cancel (#386). */
const CANCELLABLE_STATUSES: readonly BookingStatus[] = ["confirmed", "rescheduled"];

/** Resolved list filter handed to the DB dep (codes already resolved to ids). */
export interface ListFilter {
  status: BookingStatus | null;
  afterStart: string | null;
  beforeEnd: string | null;
  updatedSince: string | null;
  bucketId: string | null;
  assignedUserId: string | null;
  limit: number;
  offset: number;
  orderBy: "starts_at" | "updated_at";
}

/**
 * Outward-facing view of a booking for the lookup/cancel API (#386).
 *
 * Extends `PartnerKeys` (#2659): `submissionId` and `regalProfileId`, the join
 * keys the landing page put on the booking URL, read off the booking's own
 * `prefill` through the one reader and null when the page passed none, so a
 * caller can always read the field. On every view (lookup, by id, list,
 * cancel) because the warehouse and the host's confirmed page join on them.
 */
export interface ApiBookingView extends PartnerKeys {
  id: string;
  externalId: string | null;
  salesforceId: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  agent: { name: string | null; email: string | null };
  manageUrl: string;
  /**
   * The booking is on a TEST bucket (#2660): it reached a test calendar and no
   * downstream system. Carried on every view so a host's confirmed page, which
   * reads the by id lookup, can label a partner's test booking as one. Read off
   * the booking's bucket at the fetch, never off the caller.
   */
  isTest: boolean;
}

/**
 * ONE booking, as the booking confirmed page renders it (#2643): the lookup view
 * plus the lead's own contact (the Client rows and the text reminder card) and the
 * add to calendar links.
 *
 * Only ever built for a caller who named the booking by a STRONG id, so it can
 * never hand one person's phone to another (#1340): the by id lookup requires
 * the externalId or salesforceId to match, and the confirm response is built for
 * the booking that caller just made or silently moved. It is deliberately NOT on
 * the cross person list, where a leaked key would otherwise read everybody's
 * contact in pages.
 */
export interface ApiBookingDetail extends ApiBookingView {
  contact: { name: string | null; email: string | null; phone: string | null };
  /** Null on a cancelled call, where there is nothing to add, and on the rare row
   *  whose stored time cannot be read (logged), which must not fail the answer. */
  calendarLinks: CalendarLinks | null;
}

/** A list row: the lookup view plus its bucket code (#392). */
export interface ApiBookingListItem extends ApiBookingView {
  bucketCode: string | null;
}

function toApiBookingView(b: Booking, deps: BookingDeps, isTest: boolean): ApiBookingView {
  return {
    id: b.id,
    ...bookingIdentityFrom(b),
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    status: b.status,
    agent: { name: b.agent_name, email: b.agent_email },
    manageUrl: manageUrl(deps, b.manage_token),
    isTest,
    ...partnerKeysFrom(b.prefill),
  };
}

/**
 * The two fields `ApiBookingDetail` adds, built once for every surface that
 * carries them (the by id lookup, the key authed confirm response, and the
 * Booker's own confirm response), so the three cannot describe one call three
 * ways (L41). Pure: the base URL is handed in.
 */
export function bookingDetailExtras(
  b: Booking,
  appBaseUrl: string,
): Pick<ApiBookingDetail, "contact" | "calendarLinks"> {
  const manage = manageUrl({ appBaseUrl: () => appBaseUrl }, b.manage_token);
  let links: CalendarLinks | null = null;
  if (b.status !== "cancelled") {
    // Every caller builds these AFTER a booking or a move has committed, so this
    // must never throw: the route would fall into its error branch and tell the
    // lead a call that exists did not happen (#2644, L12). An unreadable stored
    // time degrades to no links, and the log says which booking.
    try {
      links = calendarLinks(leadCalendarEvent(b, manage), icsUrl(appBaseUrl, b.manage_token));
    } catch (err) {
      log.error("booking", { msg: "calendar links could not be built", booking_id: b.id }, err);
    }
  }
  return {
    contact: { name: b.attendee_name, email: b.attendee_email, phone: b.attendee_phone },
    calendarLinks: links,
  };
}

/** The ICS file for one booking, served by its manage token (#2643). Built from the
 *  same event the calendar links are, so the file and the links agree. */
export function bookingIcs(b: Booking, appBaseUrl: string, stampIso: string): string {
  const manage = manageUrl({ appBaseUrl: () => appBaseUrl }, b.manage_token);
  return icsDocument(leadCalendarEvent(b, manage), stampIso);
}

function toApiBookingDetail(b: Booking, deps: BookingDeps, isTest: boolean): ApiBookingDetail {
  return { ...toApiBookingView(b, deps, isTest), ...bookingDetailExtras(b, deps.appBaseUrl()) };
}

/**
 * #392 cross-person list. Resolves the bucket/agent filters to ids (an unknown
 * code/email yields an empty page with no DB scan), queries one offset page, and
 * tags each row with its bucket code from the joined buckets. nextCursor is set
 * only when the page came back full.
 */
export async function listBookings(
  query: ListQuery,
  deps: BookingDeps,
): Promise<{ items: ApiBookingListItem[]; nextCursor: string | null }> {
  let bucketId: string | null = null;
  if (query.bucketCode) {
    const resolved = await deps.resolveBucketByCode(query.bucketCode);
    if (!resolved) return { items: [], nextCursor: null };
    bucketId = resolved.bucket.id;
  }
  let assignedUserId: string | null = null;
  if (query.agentEmail) {
    const agent = await deps.getAgentByEmail(query.agentEmail);
    if (!agent) return { items: [], nextCursor: null };
    assignedUserId = agent.id;
  }

  const { rows, buckets } = await deps.queryBookings({
    status: query.status,
    afterStart: query.afterStart,
    beforeEnd: query.beforeEnd,
    updatedSince: query.updatedSince,
    bucketId,
    assignedUserId,
    limit: query.limit,
    offset: query.offset,
    orderBy: query.updatedSince ? "updated_at" : "starts_at",
  });

  const byBucketId = new Map(buckets.map((b) => [b.id, b]));
  const items: ApiBookingListItem[] = rows.map((b) => ({
    ...toApiBookingView(b, deps, byBucketId.get(b.bucket_id)?.is_test === true),
    bucketCode: byBucketId.get(b.bucket_id)?.code ?? null,
  }));
  const nextCursor = rows.length === query.limit ? encodeCursor(query.offset + query.limit) : null;
  return { items, nextCursor };
}

/** List a person's ACTIVE bookings for the lookup API (#386). Strong id only,
 *  and each supplied id may sit in EITHER id column (#2657): a booking made
 *  through the embed holds the lead's id in `salesforce_id` alone, and the
 *  caller cannot know which route made it. A blank identity fetches nothing and
 *  lists nothing, and every fetched row is judged again so a fetch that over
 *  read cannot disclose another lead's booking. */
export async function lookupPersonBookings(
  identity: LookupIdentity,
  deps: BookingDeps,
): Promise<ApiBookingView[]> {
  const ids = lookupStrongIds(identity);
  if (ids.length === 0) return [];
  const bookings = await deps.findActiveBookingsByStrongIds(ids);
  return bookings
    .filter((b) => bookingMatchesLookupIds(b, ids))
    .map((b) => toApiBookingView(b, deps, b.isTest));
}

/** Read ONE booking by id for the lookup API (#386), at any status (so the bot
 *  can poll a cancelled/completed one). Throws BookingNotFoundError if missing,
 *  not owned by the caller, or (when `status` is set) not in that status.
 *  Ownership is a supplied strong id matching either id column (#2657). */
export async function getPersonBookingById(
  input: {
    bookingId: string;
    identity: LookupIdentity;
    status: BookingStatus | null;
  },
  deps: BookingDeps,
): Promise<ApiBookingDetail> {
  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx || !bookingMatchesLookupIds(ctx.booking, lookupStrongIds(input.identity))) {
    throw new BookingNotFoundError();
  }
  if (input.status && ctx.booking.status !== input.status) {
    throw new BookingNotFoundError();
  }
  return toApiBookingDetail(ctx.booking, deps, ctx.bucket.is_test);
}

/** Cancel ONE booking by id for the cancel API (#386). Requires the booking to
 *  exist, be owned by the caller (strong id), and be active; else
 *  BookingNotFoundError. Reuses the standard cancel path (gcal delete, busy-block
 *  clear, history row, booking.cancelled webhook), stamped initiator=customer.
 *  Ownership is the SAME question the by id lookup asks, so it is resolved the
 *  same way: a supplied strong id matching either id column (#2657), or a caller
 *  who can read an embed booking by externalId gets 404 cancelling it. */
export async function cancelDirectBooking(
  input: {
    bookingId: string;
    identity: LookupIdentity;
    reason: ValidatedReason;
  },
  deps: BookingDeps,
): Promise<ApiBookingView> {
  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx || !bookingMatchesLookupIds(ctx.booking, lookupStrongIds(input.identity))) {
    throw new BookingNotFoundError();
  }
  if (!CANCELLABLE_STATUSES.includes(ctx.booking.status)) {
    throw new BookingNotFoundError();
  }
  // Re-checks status under a fresh read; false means another cancel already
  // won the race (the row was cancelled between our pre-check and here), so
  // this call is the loser and must 404 rather than report a second success.
  const transitioned = await cancelBooking(ctx.booking.manage_token, input.reason, "customer", deps);
  if (!transitioned) throw new BookingNotFoundError();
  return toApiBookingView({ ...ctx.booking, status: "cancelled" }, deps, ctx.bucket.is_test);
}

/**
 * The booking's routing trace, or a seed standing in for one on a legacy row that
 * never had one, so a later move is still recorded rather than dropped for want of
 * a base. The seed names the current advisor as the original choice, since that is
 * the only decision the row can still tell us about.
 */
function traceOrSeed(booking: Booking, bucket: Bucket): RoutingTrace {
  return (
    booking.routing_trace ?? {
      bucket_code: bucket.code,
      bucket_id: bucket.id,
      considered: [],
      chosen_user_id: booking.assigned_user_id ?? "",
      fallback_applied: false,
      reassignments: [],
    }
  );
}

/**
 * The trace with one move appended to its reassignments (#2916). `chosen_user_id`
 * and `considered` are left as they were: they record what the ranker decided at
 * booking time, and the reassignments list is where every later hand over lives,
 * whichever path made it.
 */
function traceWithMove(trace: RoutingTrace, from: string | null, to: string, nowMs: number): RoutingTrace {
  return {
    ...trace,
    reassignments: [...(trace.reassignments ?? []), { from, to, at: new Date(nowMs).toISOString() }],
  };
}

export async function rescheduleBooking(
  token: string,
  newStartIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  deps: BookingDeps,
  nowMs: number = Date.now(),
  actor?: BookingActor,
  /**
   * The lead's own details, when they typed them on the way here (#2164).
   *
   * The booker's move panel is reached by entering a name, an email and a phone
   * number, and a lead's commonest reason to come back is that the first ones were
   * wrong. Applied BEFORE the move, never after, and that ordering is the whole
   * point: the calendar event this reschedule writes and the `booking.rescheduled`
   * payload it emits are both built from the row, so a correction landing after
   * them would reach neither and the advisor would ring the number the lead just
   * replaced.
   *
   * Undefined on every other caller, which is every path where nobody typed
   * anything: the manage link's own reschedule, the admin move, the API.
   */
  contact?: { name?: string; firstName?: string; email?: string; phone?: string },
  /**
   * #2310: the zone the lead is looking at the new time in, when the caller
   * knows it: the manage page and the booker's move panel send the zone they
   * are showing, and the direct API sends the zone on its request. Undefined for
   * an admin move, where the screen's zone is the ADMIN's, so the booking's own
   * zone (the one the lead booked in) is the lead's clock instead.
   */
  opts?: {
    leadZone?: string | null;
    /** #3257: the direct booking API's claim in this time's confirm line. */
    seat?: SharedSeat | null;
  },
): Promise<BookingResult> {
  // #2310: a zone the caller supplied is judged BEFORE the contact write below,
  // so a refused move never leaves the lead's details rewritten behind it. One
  // exception needs the row: a "move" onto the instant the booking already holds
  // is a no-op, not a move, and a call booked before this gate existed may sit
  // outside the window. So only an outside start pays a read here, to tell the
  // two apart. With no zone supplied, the booking's own zone is the lead's clock
  // and it is judged after the load below.
  const suppliedZone = opts?.leadZone ?? null;
  // A contact correction is a WRITE that must not land behind a refused move, so
  // it is judged here too even with no zone supplied (a page cached from before
  // this shipped): then the booking's own zone is the lead's clock. Only an
  // outside start, or a move that carries details, pays the extra read.
  const suppliedOutside = suppliedZone !== null && !withinLeadCallingWindow(newStartIso, suppliedZone);
  if (suppliedOutside || (suppliedZone === null && contact)) {
    const held = await deps.loadBookingContext(token);
    // A missing or finished booking is refused for THAT reason, by the same
    // helper the main path uses, before the window is judged (L11): "outside
    // calling hours" about a booking that does not exist sends the reader to
    // pick another time, which can never help.
    assertReschedulable(held);
    const zone = suppliedZone ?? held.booking.timezone;
    const sameInstant = Date.parse(held.booking.starts_at) === Date.parse(newStartIso);
    if (!sameInstant && !withinLeadCallingWindow(newStartIso, zone)) {
      throw new OutsideCallingWindowError(leadCallingZone(zone));
    }
  }
  // Applied first, so everything below reads the details the lead just gave. A
  // refusal here stops the move: writing them is the point of having been given
  // them, and moving the call while silently dropping them is the one outcome
  // this was opened to end (L12).
  let contactChanged: ContactChange | null = null;
  // #4031: the number this correction replaced, so the move's webhook can tell Regal
  // the new one is a correction. Undefined when the move did not change the phone.
  let correction: MoveCorrection = {};
  if (contact) {
    const res = await updateBookingContact(token, contact, deps);
    if (!res.ok) throw new ContactRefusedError(res.error);
    contactChanged = contactUnchanged(res.changed) ? null : res.changed;
    if (res.changed.phone) correction = { previousPhone: res.previousPhone ?? null };
  }
  // #538: fold the in-place guard's working-hours read into the context load so
  // it costs no extra round-trip on the hot reschedule path.
  const ctx = await deps.loadBookingContext(token, { withWorkingHours: true });
  assertReschedulable(ctx);
  // #3401: whose call this is, for the line if the move then times out.
  deps.noteLeadId?.(refusedLeadId({ salesforceId: ctx.booking.salesforce_id, externalId: ctx.booking.external_id }));
  const { booking, eventType } = ctx;

  const { startIso, endIso } = bookingWindow(
    newStartIso,
    eventType.duration_min,
  );

  // Idempotency guard 1 — sequential duplicate / no-op reschedule: if the
  // booking already sits at the requested instant (e.g. a double-click whose
  // first call already landed), there's nothing to move. Still ensure the
  // reason event is recorded — a first attempt that moved the booking but died
  // before recording it would otherwise lose the (mandatory) reason (#326).
  // Non-holder early return (never claimed -> never releases).
  if (Date.parse(booking.starts_at) === Date.parse(startIso)) {
    if (!(await deps.hasBookingEvent(booking.id, "rescheduled", startIso, booking.reschedule_seq))) {
      await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "rescheduled",
          initiator,
          reason,
          fromStartsIso: booking.starts_at,
          toStartsIso: startIso,
          fromAgentUserId: booking.assigned_user_id,
          toAgentUserId: booking.assigned_user_id,
          actorUserId: actor?.userId,
          actingAsUserId: actor?.actingAsUserId,
          rescheduleSeq: booking.reschedule_seq,
          nowMs: Date.now(),
        }),
      );
    }
    // Atomically clean up a lock row a commit-then-crash may have left for THIS
    // now-committed target: one conditional delete (booking_id AND target) instead
    // of read-then-delete (#480). A concurrent different-target holder re-pinned to
    // its own target, so its live lease is never clobbered, and there is no
    // read->delete window for such a re-pin to slip into.
    await deps.releaseRescheduleIfTarget(booking.id, startIso);
    return { booking, manageUrl: manageUrl(deps, token), contactChanged, isTest: ctx.bucket.is_test };
  }

  // #2310: with no zone supplied (an admin move), the lead's clock is the zone
  // the booking was made in. Judged after guard 1, so a no-op onto the time the
  // booking already holds is never refused, and before the lease, so a refusal
  // claims nothing.
  if (suppliedZone === null) assertWithinLeadCallingWindow(startIso, booking.timezone);

  // Idempotency guard 2 — claim the per-booking lease (#439). The discriminated
  // outcome drives everything: a non-holder (idempotent/noop/conflict) returns or
  // throws WITHOUT touching the finally; only a holder (won/resume/
  // fresh-after-abandon) enters the try/finally, so the release rule holds.
  const claim = await deps.claimReschedule(booking.id, startIso);
  if (claim.outcome === "idempotent" || claim.outcome === "noop") {
    return { booking, manageUrl: manageUrl(deps, token), contactChanged, isTest: ctx.bucket.is_test };
  }
  if (claim.outcome === "conflict") {
    throw new RescheduleConflictError();
  }

  let applied = false;
  try {
    const result = await applyReschedule(
      deps, token, ctx, startIso, endIso, reason, initiator, claim, nowMs, actor, opts?.seat ?? null, correction,
    );
    applied = true;
    return { ...result, contactChanged, isTest: ctx.bucket.is_test };
  } finally {
    // #3215: after a FAILURE, under the cleanup allowance. A reschedule that failed
    // because the confirm budget ran out would otherwise have its release refused
    // at 0ms too, and the lead's retry would meet its own lock until the lease
    // expired. Only then: the allowance is opened once per request and shared, so
    // a release after a success must not spend it before the route needs it. The
    // one cleanup that does not share it is a lost race's rollback in the middle of
    // a confirm (#3439, `withinLostRaceCleanup`), which gets its own while the
    // confirm budget can hold it, and so never opens the shared one early either.
    if (applied) await deps.releaseReschedule(booking.id);
    else await withinOwedCleanup(() => deps.releaseReschedule(booking.id));
  }
}

async function applyReschedule(
  deps: BookingDeps,
  token: string,
  ctx: BookingContext,
  startIso: string,
  endIso: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  claim: Extract<RescheduleClaim, { outcome: "won" | "resume" | "fresh-after-abandon" }>,
  nowMs: number,
  actor?: BookingActor,
  /** #3257: this move's claim in the new time's confirm line, or none. */
  seat: SharedSeat | null = null,
  /** #4031: what the move's own contact write corrected, carried to its webhook. */
  correction: MoveCorrection = {},
): Promise<BookingResult> {
  const { booking, bucket, eventType } = ctx;
  const currentEmail = booking.agent_email;
  // Capture the pre-move time + agent for the history row before we mutate.
  const fromStartsIso = booking.starts_at;
  const fromAgentUserId = booking.assigned_user_id;
  // The assignee + event id we read, used to GATE the commit (#615): if a
  // concurrent cancel or reassign changed either (or the status) before we
  // commit, the gated UPDATE touches 0 rows and we roll back rather than win.
  const fromGcalEventId = booking.gcal_event_id;
  // Why the current agent could NOT be kept in place (#543), surfaced to the
  // service layer (on success via BookingResult, on failure via the thrown
  // error) for an observability breadcrumb. null = kept in place / no in-place
  // candidate / a resume (the original attempt already reported it).
  let inPlaceDeclineReason: RescheduleDeclineReason | null = null;

  // Resolve the pin. RESUME reads it verbatim — NEVER recompute the agent/branch/
  // event id (recomputing reopens window a + the oscillation ghost). A fresh
  // attempt (won) or fresh-after-abandon computes a new pin and writes it BEFORE
  // any Google call (the load-bearing crash-safety invariant).
  let pin: ReschedulePin;
  if (claim.outcome === "resume") {
    pin = claim.pin;
  } else {
    // fresh-after-abandon keys the new seq off the ABANDONED pin's seq (+1), not
    // booking.reschedule_seq, so the new id can't collide with the abandoned one.
    const baseSeq =
      claim.outcome === "fresh-after-abandon" ? claim.pin.reschedule_seq : booking.reschedule_seq;
    const seq = baseSeq + 1;

    // fresh-after-abandon: the stale pin's event (for a DIFFERENT target) is
    // orphaned — enqueue it for durable deletion if it isn't the live event.
    if (claim.outcome === "fresh-after-abandon") {
      const stale = claim.pin;
      if (stale.gcal_client_id && stale.gcal_client_id !== booking.gcal_event_id) {
        await deps.enqueueEventDeletion(stale.pinned_agent_email, stale.gcal_client_id, booking.id);
      }
    }

    // Branch decision — the ONLY place the in-place guard / assignAgent run, and
    // only on a FRESH attempt. A resume never reaches here, so a poisoned freeBusy
    // can't flip a same-agent move to a new agent (window b).
    //
    // The in-place branch keeps the current agent only if the new time passes the
    // FULL set of slot rules the booker's `memberOpenStarts` enforces — the SAME
    // `isBookableSlotForAgent` predicate, so the two paths can't drift (#536):
    // working hours (#527), minimum notice, daily cap, AND buffer-before/after.
    // Without all four, a reschedule (especially a direct-API one not picked from
    // offered slots) could park an agent on a slot the booker would never offer.
    // The reads are scoped to the assigned agent + new slot:
    //  - working-hours schedule (rules-only) as a cheap gate before any live call;
    //  - live busy across the BUFFERED window, excluding the booking's OWN still-
    //    present event (#523) so a sub-event-length move isn't a self-conflict; a
    //    read failure (null) re-routes, exactly as the old `isFree` path did;
    //  - the agent's OTHER bookings on the target LOCAL day for the daily cap,
    //    excluding the booking being moved (so a same-day nudge isn't self-counted).
    // A schedule-less agent has no shift windows -> off-shift -> re-route.
    const ownEvent = { start: Date.parse(booking.starts_at), end: Date.parse(booking.ends_at) };
    const businessHours = await deps.businessHours();
    const slotRules: SlotRules = {
      durationMin: eventType.duration_min,
      bufferBeforeMin: eventType.buffer_before_min,
      bufferAfterMin: eventType.buffer_after_min,
      minNoticeMin: eventType.min_notice_min,
      dailyCap: eventType.daily_cap,
      businessHours,
    };
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    let keepInPlace = false;
    // Reason vocabulary here: working_hours | calendar (live busy read failed) |
    // min_notice | buffer. daily_cap can't fire on a keep-same-agent move
    // (enforceDailyCap is off). null while there was no in-place candidate.
    if (currentEmail && booking.assigned_user_id && booking.gcal_event_id) {
      // #3257: claimed before the live read, so a lead booking this time beside the
      // move is given another advisor at once. The line is handed on only when an
      // advisor nobody has claimed is left beside this one, judged as the create
      // path judges it, so a move into the last advisor keeps the crowd behind it.
      // If the advisor is declined below, the reroute's own pick replaces the claim.
      if (seat) await claimBesideMove(deps, seat, bucket, eventType, startIso, booking.assigned_user_id);
      // Folded into the context load (#538); the fallback covers a context loaded
      // without the fold (it re-reads rather than crash on a missing schedule).
      const wh = ctx.agentWorkingHours ?? (await deps.agentWorkingHours(booking.assigned_user_id));
      // Cheap rules-only gates first, so a refused reschedule re-routes without a
      // needless live Google read. The ORG's day (#1295) is checked ahead of this
      // agent's shift, matching the shared predicate's order, so a move into a
      // closed hour reports the org rather than blaming the agent's roster. Both
      // windows are judged in their OWN zone; they are never intersected.
      if (
        !isOrgOpen(businessHours, startMs, endMs)
      ) {
        inPlaceDeclineReason = "business_hours";
      } else if (!isWithinWorkingHours(wh.rules, wh.timezone, startMs, endMs)) {
        inPlaceDeclineReason = "working_hours";
      } else {
        const busy = await deps.busyIntervalsForAgent(
          currentEmail,
          new Date(startMs - slotRules.bufferBeforeMin * 60_000).toISOString(),
          new Date(endMs + slotRules.bufferAfterMin * 60_000).toISOString(),
        );
        if (busy === null) {
          // Live calendar read failed -> re-route, exactly as the old isFree path did.
          inPlaceDeclineReason = "calendar";
        } else {
          // A reschedule that keeps the same agent is NOT a net-new booking, so the
          // daily cap does not apply here (it would otherwise reroute a simple move
          // onto a day already full of the agent's OTHER meetings). Still enforce
          // working-hours (gated above), min-notice, and buffer.
          inPlaceDeclineReason = bookableSlotReason(
            { timezone: wh.timezone, rules: wh.rules, busy, bookingStartsMs: [] },
            slotRules,
            startMs,
            nowMs,
            { ignoreBusy: ownEvent, enforceDailyCap: false },
          );
          keepInPlace = inPlaceDeclineReason === null;
        }
      }
    }
    // #2073: a named link booking belongs to the agent it names. When they cannot
    // take the new time it is refused, never moved to somebody from the bucket
    // it is stored in, which the link never routed through.
    if (!keepInPlace && booking.kind === "agent_link") {
      const refusal =
        inPlaceDeclineReason === "calendar" ? new VerifyUnavailableError() : new SlotUnavailableError();
      tagRescheduleFailure(refusal, { bookingId: booking.id, inPlaceDeclineReason: inPlaceDeclineReason ?? undefined });
      throw refusal;
    }
    if (keepInPlace) {
      // keepInPlace is only true when all three were present (the guard block above).
      pin = {
        reschedule_seq: seq,
        branch: "in_place",
        pinned_user_id: booking.assigned_user_id!,
        pinned_agent_email: currentEmail!,
        gcal_client_id: booking.gcal_event_id!, // in-place re-PATCHes the existing event
        target_starts_at: startIso,
      };
    } else {
      let next;
      try {
        next = await assignAgent(deps, bucket, eventType, startIso, endIso, false, undefined, false, seat);
      } catch (err) {
        // The reschedule ultimately failed: the in-place agent was declined and
        // the reroute found nobody. Tag the error with the in-place decline reason
        // (#543) so the service layer can log the two together — the pure layer
        // does no IO itself. Then rethrow the typed error unchanged.
        tagRescheduleFailure(err, { bookingId: booking.id, inPlaceDeclineReason: inPlaceDeclineReason ?? undefined });
        throw err;
      }
      pin = {
        reschedule_seq: seq,
        branch: "reassign",
        pinned_user_id: next.userId,
        pinned_agent_email: next.email,
        gcal_client_id: await deterministicEventId(`reschedule:${booking.id}:${seq}`, next.userId),
        target_starts_at: startIso,
      };
    }
    await deps.writeReschedulePin(booking.id, pin);
  }

  // Who takes the call after this move: the advisor already on it in place, or the
  // one the reroute pinned. Read BEFORE the event is built, because the invite's
  // title names them (#3376), and a reroute hands the call to somebody else.
  const agentName =
    pin.branch === "in_place" ? booking.agent_name : (await deps.getUser(pin.pinned_user_id)).name;

  // The event either branch below may have to CREATE, built once: the in place
  // branch creates it only when the PATCH target is gone, the reassign branch
  // always does, and the two must describe the same call the same way.
  const movedEvent = {
    summary: eventSummary({ eventType: eventType.name, advisor: agentName, lead: booking.attendee_name }),
    description: eventDescription(booking.attendee_phone, manageUrl(deps, token), { isTest: bucket.is_test }),
    location: eventLocation(booking.attendee_phone) ?? undefined,
    start: startIso,
    end: endIso,
    timezone: booking.timezone,
    attendeeEmail: booking.attendee_email ?? undefined,
    attendeeName: booking.attendee_name ?? undefined,
  };

  // Execute the pinned branch.
  let newGcalEventId = booking.gcal_event_id;
  // Whether this reschedule WROTE an event of its own (the reroute always does;
  // the in place branch only when it recreated a deleted one, #617), which is the
  // event a lost commit rolls back.
  let recreated = false;
  if (pin.branch === "in_place") {
    // Idempotent PATCH — a resume simply re-PATCHes the same event to the same
    // time. No createEvent / 409-reuse here; the pin stores the existing event id.
    try {
      await deps.updateEventTime(pin.pinned_agent_email, pin.gcal_client_id, startIso, endIso, booking.timezone);
      newGcalEventId = pin.gcal_client_id;
    } catch (err) {
      // #617: the PATCH target was deleted on Google. Rather than commit a
      // phantom move, recreate the event on the SAME agent at the new time. The
      // deterministic id keeps a crash-resume idempotent (a repeat insert 409s
      // and reuses the same event), and the customer gets a fresh invite.
      if (!(err instanceof EventGone)) throw err;
      // #3217: the recreated event belongs to THIS reschedule, so it gets the same
      // queue and hold as the reroute below. The pin names it before it is
      // written, so the deletion drain holds it while a resume may still adopt it
      // (a resume re-PATCHes the pinned event, which is now this one), and a
      // failure queues it rather than deleting it live.
      const recreateId = await deterministicEventId(
        `reschedule-recreate:${booking.id}:${pin.reschedule_seq}`,
        pin.pinned_user_id,
      );
      pin = await repin(deps, booking.id, pin, recreateId);
      try {
        newGcalEventId = await deps.createEvent(pin.pinned_agent_email, movedEvent, recreateId, {
          onFreshId: async (fresh) => {
            pin = await repin(deps, booking.id, pin, fresh);
          },
        });
      } catch (createErr) {
        throw await refusedOrQueued(deps, createErr, pin.pinned_agent_email, pin.gcal_client_id, booking.id);
      }
      recreated = true;
    }
  } else {
    // reassign: CREATE-FIRST the new event with the pinned deterministic id (a
    // resume's repeat insert 409s and GET-and-reuses it -> no duplicate). The OLD
    // event is deleted only AFTER the durable commit below (AUD-044/#518): a
    // delete-first strands the booking on a deleted event if the create or commit
    // fails. On a generic create failure the new event (which may have landed on
    // Google even though the answer never came back) is QUEUED for deletion, never
    // deleted live (#3217): the retry derives this same id, and a deleted event
    // keeps it, so a live delete hands the retry a cancelled event to adopt. The
    // drain drops the row once the retry's commit holds the event.
    // Past a cancelled tombstone the create walks to a fresh id, and the pin is
    // rewritten with it BEFORE it is inserted, so a resume lands on it and the
    // queue below names the event that was actually written.
    try {
      newGcalEventId = await deps.createEvent(pin.pinned_agent_email, movedEvent, pin.gcal_client_id, {
        onFreshId: async (fresh) => {
          pin = await repin(deps, booking.id, pin, fresh);
        },
      });
    } catch (err) {
      throw await refusedOrQueued(deps, err, pin.pinned_agent_email, pin.gcal_client_id, booking.id);
    }
    recreated = true;
  }

  const agentEmail = pin.pinned_agent_email;
  const assigned = pin.pinned_user_id;

  // Single atomic commit at the new time/agent, advancing the ordinal ONLY on
  // success (so a crash-retry recomputes the same seq -> same deterministic id).
  // GATED on the booking still being the one we started moving (#615): a
  // concurrent cancel (status flip) or reassign (assignee + event id swap) makes
  // this touch 0 rows, so we don't resurrect a cancelled booking or clobber the
  // reassign.
  // #2373: this THROWS when the statement did not run, rather than reporting zero
  // rows. That is deliberate and it is safe to run twice: a throw here is exactly
  // a crash here, which the durable pin above already handles, so a retry
  // recomputes the same seq and the same deterministic event id and re-reads the
  // row through the `alreadyCommitted` branch below. Rolling the event back on a
  // failed write would be wrong for the same reason it is wrong on a crash: the
  // next attempt is going to reuse it.
  // #3265: the move's outbox work goes INTO the commit, so the move and its record of
  // the slot move and webhook land together or not at all.
  const rescheduleOutbox = {
    steps: rescheduleOutboxSteps(),
    payload: {
      reasonCode: reason.code,
      reasonDetail: reason.detail,
      initiator,
      fromStartsIso,
      fromAgentUserId,
      actorUserId: actor?.userId,
      actingAsUserId: actor?.actingAsUserId,
      // #4031: only when the move replaced the number, so its absence means "not corrected".
      ...(correction.previousPhone !== undefined ? { previousAttendeePhone: correction.previousPhone } : {}),
    },
  };
  const committed = await deps.commitReschedule(
    booking.id,
    {
      starts_at: startIso,
      ends_at: endIso,
      assigned_user_id: assigned,
      agent_name: agentName,
      agent_email: agentEmail,
      status: "rescheduled",
      gcal_event_id: newGcalEventId,
      reschedule_seq: pin.reschedule_seq,
      // #2916: a reroute hands the call to another advisor, so it is recorded in
      // the trace's reassignments the way a reassign records it. Built from the
      // snapshot, which is safe here and only here: the write is gated on the
      // assignee AND the event id we read, and every other writer of the trace (a
      // reassign) changes both, so a stale trace can never land over a newer one.
      ...(assigned !== fromAgentUserId
        ? { routing_trace: traceWithMove(traceOrSeed(booking, bucket), fromAgentUserId, assigned, nowMs) }
        : {}),
    },
    { assignedUserId: fromAgentUserId, gcalEventId: fromGcalEventId },
    rescheduleOutbox,
  );
  // The outbox row the commit wrote, or null when this attempt's commit touched
  // nothing: either a real conflict (thrown below) or an earlier attempt that already
  // committed this exact pin, whose own commit wrote the row the drain will run.
  const outboxId = committed;
  if (!committed) {
    // 0 rows: the booking is no longer the one we started moving. Two cases:
    //  - a crash-resume whose prior attempt already committed THIS exact pin
    //    (the row now carries our seq + event id) — idempotent, fall through;
    //  - a genuine conflict: a concurrent cancel/reassign/completion changed it.
    // Distinguish by re-reading, so only a real conflict rolls back + throws.
    const fresh = await deps.loadBookingById(booking.id);
    const alreadyCommitted =
      fresh != null &&
      fresh.booking.reschedule_seq === pin.reschedule_seq &&
      fresh.booking.gcal_event_id === newGcalEventId &&
      (fresh.booking.status === "rescheduled" || fresh.booking.status === "confirmed");
    if (!alreadyCommitted) {
      // Roll back the event THIS reschedule created (reassign branch only; the
      // in_place branch re-PATCHed a pre-existing event that the winner owns, so
      // deleting it here could remove a live event — leave it to the winner).
      // Queued rather than deleted live (#3217): the commit lost to a concurrent
      // reassign keeps the reschedule ordinal where it was, so the lead's retry
      // derives this same id, and a deleted event would come back cancelled. An
      // in place move that RECREATED a deleted event (#617) wrote one of its own
      // too, and it is rolled back the same way.
      if (recreated && newGcalEventId) {
        await queueOwedEventDeletion(deps, pin.pinned_agent_email, newGcalEventId, booking.id);
      }
      throw new RescheduleConflictError();
    }
  }
  booking.gcal_event_id = newGcalEventId;

  // AUD-044/#518: for a reroute (new agent), delete the OLD event only AFTER the
  // new event is durably committed above (create-first). A crash before the
  // commit therefore never leaves the booking pointing at a deleted event; a
  // crash HERE leaves a cosmetic old-event orphan (availability is cache-first),
  // not a booking without a calendar hold. Skip when the pinned id 409-reused the
  // same event (deleting it would remove the live event). in_place never deletes
  // (it re-PATCHes the pre-existing event).
  if (
    pin.branch === "reassign" &&
    currentEmail &&
    fromGcalEventId &&
    fromGcalEventId !== newGcalEventId
  ) {
    await deleteEventBestEffort(deps, currentEmail, fromGcalEventId, booking.id);
  }

  const updated = {
    ...booking,
    starts_at: startIso,
    ends_at: endIso,
    assigned_user_id: assigned,
    agent_name: agentName,
    agent_email: agentEmail,
    status: "rescheduled" as const,
  };

  // The booking is committed at the NEW time/agent, and its post-commit side effects
  // (slot move, recompute, rescheduled webhook) were recorded in the same transaction
  // (#3265). Run them now through the idempotent outbox executor (#429 P3), leased so
  // a drain tick can't double-run them. Nothing here may become the lead's error: the
  // move happened, and whatever is cut off here the drain finishes from the row.
  if (outboxId !== null) {
    const unfinished = await finishCommitted(() => runCommittedRescheduleOutbox(deps, booking.id, outboxId, rescheduleOutbox));
    if (unfinished !== null) {
      log.error(
        "booking",
        {
          msg: "the reschedule committed and the work after it did not finish; answering the move, and the outbox drain finishes the rest",
          booking_id: booking.id,
        },
        unfinished,
      );
    }
  }

  return {
    booking: updated,
    manageUrl: manageUrl(deps, token),
    rescheduleDecline: inPlaceDeclineReason ?? undefined,
  };
}

/**
 * Run a committed reschedule's recorded outbox work inline (#3265), leased so a drain
 * tick cannot run it alongside.
 */
async function runCommittedRescheduleOutbox(
  deps: BookingDeps,
  bookingId: string,
  outboxId: string,
  outbox: { steps: OutboxStep[]; payload: OutboxPayload },
): Promise<void> {
  const { steps, payload } = outbox;
  // #1048: honour the lease answer. A null means a drain tick already holds this
  // row and is running the very steps we would run, so the right thing is to leave
  // it alone rather than run them alongside it. The row is durable, so nothing is
  // lost: whoever holds it finishes the delivery.
  const lease = await deps.leaseOutbox(outboxId);
  if (lease) {
    try {
      await runOutboxSteps(
        deps,
        {
          id: outboxId,
          booking_id: bookingId,
          action: "reschedule",
          status: "pending",
          steps,
          payload,
          // The token this holder owns; every write the executor makes is gated on it.
          lease_until: lease,
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: "",
          updated_at: "",
        },
        OUTBOX_HANDLERS,
        lease,
      );
    } finally {
      await deps.releaseOutboxLease(outboxId, lease);
    }
  }
}

/**
 * Reassign a booking to a specific owning agent (the contact-owner override,
 * #9). The caller (an upstream automation) has already decided this lead should
 * stick to this agent, so this is FORCED: the agent is booked at the same time
 * even if busy. It's the ONLY path that double-books — the booking is marked
 * `allow_double_book` so the active-slot unique index lets it stack. Throws
 * "Booking not found" / "Agent not found or not bookable" for the caller to map.
 */
/**
 * The explanation shown on the new agent's invite when a booking is reassigned
 * (#969). The customer keeps the same time, so a fresh invite could look like a
 * mistake; this reassures them in plain, warm language. Kept notification-count
 * to ONE (this invite) by removing the old event silently.
 */
export const REASSIGN_INVITE_DESCRIPTION =
  "Your appointment time has not changed. You have been matched with a different Pennie advisor who will be with you at this time. There is nothing you need to do.";

export interface ReassignOptions {
  /** Push through even when the target agent is at their daily cap (the machine
   *  contact-owner path passes true; the manager UI passes it on the 2nd step). */
  overrideCap?: boolean;
  /** Staff user accountable for a manager-driven reassign (#549). */
  actor?: BookingActor;
  /** Who drove it: 'system' (machine, default) or 'admin' (manager UI, #546). */
  initiator?: BookingEventInitiator;
  /** Allow a target OUTSIDE the bookable pool — manager coverage/escalation
   *  (#546). Default false keeps the machine path bookable-only. */
  allowNonBookable?: boolean;
  /** #3249: this reassign is a reroute move into a corrected bucket, carrying the
   *  hold the confirm claimed. The swap consumes it; see `reroute.ts`. */
  reroute?: RerouteSwapArgs;
  /**
   * #1677: move the booking only if it is still where the caller saw it. The coverage
   * drain spends seconds choosing an advisor for a booking's time, and an admin's own
   * reassign, a second sweep or the lead's reschedule can land in that time. Refused as
   * `booking_moved` (a `RerouteRefusedError`) before any calendar event when the booking
   * loaded here already differs, and by the swap under its row lock when the change
   * lands after that. Absent, nothing is checked, as for every other reassign.
   */
  expect?: ReassignExpectation;
}

/** The booking's state a reassign was decided on (#1677): its advisor and its start. */
export interface ReassignExpectation {
  assignedUserId: string;
  startsAt: string;
}

/** Whether a booking still has the state a reassign was decided on (#1677). */
export function bookingStillAsExpected(
  booking: Pick<Booking, "assigned_user_id" | "starts_at">,
  expect: ReassignExpectation,
): boolean {
  return booking.assigned_user_id === expect.assignedUserId && Date.parse(booking.starts_at) === Date.parse(expect.startsAt);
}

export async function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  deps: BookingDeps,
  opts: ReassignOptions = {},
): Promise<BookingResult & { overCap: boolean }> {
  const { overrideCap = false, actor, initiator = "system", allowNonBookable = false, reroute, expect } = opts;
  const ctx = await deps.loadBookingById(bookingId);
  if (!ctx) throw new BookingNotFoundError();
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new BookingNotChangeableError();
  }
  // #1677: already changed since the caller decided, so nothing is created anywhere.
  if (expect && !bookingStillAsExpected(booking, expect)) throw new RerouteRefusedError("booking_moved");

  const agent = await deps.getAgentByEmail(agentEmail);
  if (!agent || !agent.email || (!agent.bookable && !allowNonBookable)) {
    throw new AgentNotAvailableError();
  }
  // A booking and its advisor are in the same WORLD (#2660): a test booking
  // moves only between test agents (the canary's own reassign scenario), and a
  // real booking never lands on one. Judged on the BUCKET's flag and the agent's,
  // the two places the flag lives, so the admin picker excluding test agents is
  // not the only thing standing between a stranger's test and a real calendar.
  if (Boolean(bucket.is_test) !== Boolean(agent.is_test)) {
    throw new ReassignAcrossWorldsError();
  }
  if (agent.id === booking.assigned_user_id) {
    return { booking, manageUrl: manageUrl(deps, booking.manage_token), overCap: false };
  }

  // Daily-cap awareness (#reassign-cap): the cap counts meetings per agent per day.
  // Moving a booking onto a DIFFERENT agent is net-new load for that agent, so the
  // cap applies. We compute it ALWAYS so we can report it; we only BLOCK when the
  // caller hasn't opted to override (the machine contact-owner path passes true).
  let overCap = false;
  if (eventType.daily_cap !== null) {
    const wh = await deps.agentWorkingHours(agent.id);
    const day = DateTime.fromISO(booking.starts_at, { zone: wh.timezone }).startOf("day");
    const dayStartsMs = await deps.agentActiveBookingStartsMs(
      agent.id,
      day.toISO()!,
      day.plus({ days: 1 }).toISO()!,
      booking.id,
    );
    overCap = !isUnderDailyCap(
      dayStartsMs,
      wh.timezone,
      Date.parse(booking.starts_at),
      eventType.daily_cap,
    );
    if (overCap && !overrideCap) {
      throw new DailyCapExceededError(agent.email, day.toISODate()!);
    }
  }

  // Create the event on the TARGET agent FIRST, then swap atomically (#449). We
  // do NOT delete the old event up front from a stale read - that's exactly what
  // orphaned the loser's event in a concurrent distinct-reassign. Instead the
  // swap RETURNS the event it replaced, and we delete that below.
  //
  // P4 (#439): a deterministic client id keyed on the booking, the TARGET agent
  // (deterministicEventId mixes agent.id into the hash, so a cross-agent move
  // can't collide on the target calendar), and the reassignment ordinal (so a
  // later A->B->A move doesn't reuse a tombstoned id). The reassign target is
  // caller-supplied, so a crash-retry recomputes the same id and createEvent
  // reuses the event (Google 409) instead of spawning a duplicate.
  const reassignOrdinal = booking.routing_trace?.reassignments?.length ?? 0;
  let gcalClientId = await deterministicEventId(
    `reassign:${booking.id}:${reassignOrdinal}`,
    agent.id,
  );
  // #518: durable intent written BEFORE the create, so a crash between here and
  // the swap is cleaned by processAbandonedReassignIntents (the new event is
  // orphaned + the reassign silently lost otherwise). Idempotent on
  // (booking_id, gcal_client_id): a same-target retry (identical deterministic
  // id, #449) refreshes the lease instead of failing.
  await deps.writeReassignIntent({
    bookingId: booking.id,
    pinnedAgentEmail: agent.email,
    gcalClientId,
  });
  // The intents this call wrote for ids that may have NO event behind them (a
  // tombstone, or a fresh id not yet inserted). Cleared together if the create
  // ends without an event, so none is left standing for the drain to hold.
  const unbacked = new Set<string>([gcalClientId]);
  let hookFailed = false;
  let newEventId: string;
  try {
    newEventId = await deps.createEvent(
      agent.email,
      {
        summary: eventSummary({ eventType: eventType.name, advisor: agent.name, lead: booking.attendee_name }),
        location: eventLocation(booking.attendee_phone) ?? undefined,
        // #969: this invite is the ONE notification the customer gets on a reassign
        // (the old event is removed silently below). Explain the swap so a fresh
        // invite for an appointment they already have does not read as a mistake.
        description: REASSIGN_INVITE_DESCRIPTION,
        start: booking.starts_at,
        end: booking.ends_at,
        timezone: booking.timezone,
        attendeeEmail: booking.attendee_email ?? undefined,
        attendeeName: booking.attendee_name ?? undefined,
      },
      gcalClientId,
      {
        // #3217: past a cancelled tombstone (a failed swap's event the drain
        // deleted before this retry) the create walks to a fresh id. Its intent is
        // written first, the same rule as above, and the tombstone's goes, since
        // there is nothing left on Google for it to clean up.
        onFreshId: async (fresh) => {
          try {
            await deps.writeReassignIntent({ bookingId: booking.id, pinnedAgentEmail: agent.email, gcalClientId: fresh });
            unbacked.add(fresh);
            const tombstoned = gcalClientId;
            gcalClientId = fresh;
            await deps.deleteReassignIntent(booking.id, tombstoned);
            unbacked.delete(tombstoned);
          } catch (hookErr) {
            hookFailed = true;
            throw hookErr;
          }
        },
      },
    );
  } catch (err) {
    // Every id in the chain a tombstone, or the hook refused before a fresh id was
    // inserted: nothing was created, so no intent may be left standing for the
    // drain to hold. Each delete is tried on its own; one the store refuses is
    // left to the abandoned intent sweep, which clears it once its lease passes.
    // #3373: Google refusing the lead's address wrote no event either, so it clears
    // the same way, and is answered as a refusal about the email rather than a 500.
    const refused = isInvalidAttendeeEmailRefusal(err);
    if (err instanceof EventCancelledOnReuse || hookFailed || refused) {
      for (const id of unbacked) {
        await deps.deleteReassignIntent(booking.id, id).catch((delErr) =>
          log.warn("reassign", { msg: "could not clear an intent with no event behind it", booking_id: booking.id, gcal_event_id: id }, delErr),
        );
      }
    }
    throw refused ? new AttendeeEmailRefusedError(err) : err;
  }

  // The reassignment audit record is appended server-side in reassign_booking_swap
  // under the row lock (#519): building the final array here off a snapshot read
  // before the swap would let two concurrent reassigns overwrite each other's
  // history entry. We pass only a BASE trace to seed the row if it has none; the
  // swap derives the record (from = the genuinely-current agent under the lock,
  // to = this target, at = now) and appends it onto the row's own current history.
  const baseTrace: RoutingTrace = traceOrSeed(booking, bucket);
  // Captured BEFORE the swap for the returned object's local trace view: the
  // agent we're moving away from, as this caller saw it.
  const fromUserId = booking.assigned_user_id;

  let swap: {
    prevGcalEventId: string | null;
    prevAgentEmail: string | null;
    updated: boolean;
    refused?: RerouteSwapRefusal | null;
  };
  try {
    swap = await deps.reassignSwap({
      bookingId: booking.id,
      userId: agent.id,
      agentName: agent.name,
      agentEmail: agent.email,
      gcalEventId: newEventId,
      gcalClientId,
      routingTrace: baseTrace,
      ...(reroute ? { reroute } : {}),
      ...(expect ? { expect } : {}),
    });
  } catch (err) {
    // The swap (durable anchor) failed: queue the event we optimistically created
    // so it isn't orphaned, then surface the failure. Queued, never deleted live
    // (#3217): the reassign ordinal has not moved, so a retry derives this same id
    // and must find the event live. The intent is LEFT standing for the same
    // reason: it is what tells the drain a resume may still adopt the event (the
    // way a pending reservation does for a create), and the retry refreshes it, or
    // the abandoned intent sweep clears it once its lease has passed.
    await queueOwedEventDeletion(deps, agent.email, newEventId, booking.id);
    throw err;
  }

  if (swap.refused) {
    // #3249: the bucket aware swap wrote nothing (the hold ran out, was replaced,
    // or the booking moved). Nothing points at the event created above, so it goes
    // and its intent with it, exactly as for a booking gone terminal below, and the
    // refusal is surfaced in the swap's own word rather than as "not changeable".
    await compensateEvent(deps, agent.email, newEventId, booking.id);
    await deps.deleteReassignIntent(booking.id, gcalClientId);
    throw new RerouteRefusedError(swap.refused);
  }

  if (!swap.updated) {
    // The booking went terminal (cancelled/completed) concurrently. Clean up the
    // event we optimistically created so it isn't orphaned + drop the intent,
    // then surface it.
    await compensateEvent(deps, agent.email, newEventId, booking.id);
    await deps.deleteReassignIntent(booking.id, gcalClientId);
    throw new BookingNotChangeableError();
  }

  // The intent is ALREADY stamped with the replaced event + swapped_at: the swap did
  // it in its own transaction (#759). It used to be a separate write here, which a
  // crash could land in front of, losing the old event id (the sweep could then never
  // clean the orphan) and leaving a committed swap looking never-adopted to the sweep,
  // which pages about it as a lost reassign (#758).

  // Delete the event the swap REPLACED - the genuinely-current one at swap time,
  // not the stale read - so no calendar event is ever left dangling. Skip when a
  // same-target re-submit reused the same event id (deterministic id => Google
  // 409 reuse): deleting it would remove the live event.
  if (
    swap.prevAgentEmail &&
    swap.prevGcalEventId &&
    swap.prevGcalEventId !== newEventId
  ) {
    // #969: remove the old agent's event SILENTLY so the customer gets no
    // cancellation email. The one notification they get is the new agent's invite
    // (created above with an explanatory description); a bare cancel + reinvite is
    // confusing for an internal swap where their time never changed.
    await deleteEventBestEffort(deps, swap.prevAgentEmail, swap.prevGcalEventId, booking.id, {
      notifyAttendee: false,
    });
  }

  // No reminder is resent (#2630, Dan 2026-09-22: "never resend"). A reminder
  // already sent keeps its record, because the invite created above already tells
  // the lead who is calling, and a second reminder from a second person reads as a
  // duplicate. A real reschedule still earns a fresh one, since the record is the
  // START it was sent about.

  // #518: create + swap + delete-old are done; the intent's crash-safety window
  // is closed, so drop it. Anything past this point (the outbox side effects
  // below) already resumes via the outbox drain (#429 P3), not the intent.
  await deps.deleteReassignIntent(booking.id, gcalClientId);

  const updated = {
    ...booking,
    assigned_user_id: agent.id,
    agent_name: agent.name,
    agent_email: agent.email,
    gcal_event_id: newEventId,
    // The status is left as it was (#2617): the swap no longer writes it, because
    // a reassign hands the same call to another advisor and the lead did nothing.
    allow_double_book: true,
    // Best-effort local view of the trace for the returned object (the swap owns
    // the authoritative append server-side, #519; this value is not surfaced to
    // any response, so a concurrent racer's extra entry not shown here is fine).
    routing_trace: {
      ...baseTrace,
      reassignments: [
        ...(baseTrace.reassignments ?? []),
        { from: fromUserId, to: agent.id, at: new Date().toISOString() },
      ],
    },
  };

  // Deliver the post-commit side effects (slot move, recompute, the
  // booking.reassigned webhook + 'reassigned' history) through the idempotent
  // outbox executor (#429 P3), so a crash here resumes via the drain. The gcal
  // delete-old + create-new above stay inline (create-idempotency is P4). Leased
  // around the inline run so a drain tick can't double-run it. The payload's
  // fromAgentUserId captures the PRE-reassign agent for the history row, and
  // fromAgentEmail the same agent for the webhook (#2368): `booking` here is the
  // row as it was BEFORE the swap, and the NOTIFY step re-reads a booking that
  // already holds the new advisor, so this is the only moment the outgoing
  // address can be captured.
  const steps = reassignOutboxSteps();
  const payload = {
    reasonCode: reason.code,
    reasonDetail: reason.detail,
    initiator,
    fromStartsIso: booking.starts_at,
    fromAgentUserId: booking.assigned_user_id,
    // The swap's OWN answer for who held the booking, read under its row lock,
    // not this caller's snapshot from before it (#519 made the same distinction
    // for the history record's `from`). Two reassigns racing both loaded the same
    // base, so the second one's snapshot names the agent the first already moved
    // it off, and the address is what a person reads in the Regal timeline.
    fromAgentEmail: swap.prevAgentEmail,
    actorUserId: actor?.userId,
    actingAsUserId: actor?.actingAsUserId,
    ...(reroute ? { fromBucketId: reroute.fromBucketId, toBucketId: reroute.bucketId } : {}),
  };
  const outboxId = await deps.enqueueOutbox({
    booking_id: booking.id,
    action: "reassign",
    steps,
    payload,
  });
  // #1048: honour the lease answer. A null means a drain tick already holds this
  // row and is running the very steps we would run, so the right thing is to leave
  // it alone rather than run them alongside it. The row is durable, so nothing is
  // lost: whoever holds it finishes the delivery.
  const lease = await deps.leaseOutbox(outboxId);
  if (lease) {
    try {
      await runOutboxSteps(
        deps,
        {
          id: outboxId,
          booking_id: booking.id,
          action: "reassign",
          status: "pending",
          steps,
          payload,
          // The token this holder owns; every write the executor makes is gated on it.
          lease_until: lease,
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: "",
          updated_at: "",
        },
        OUTBOX_HANDLERS,
        lease,
      );
    } finally {
      await deps.releaseOutboxLease(outboxId, lease);
    }
  }
  return { booking: updated, manageUrl: manageUrl(deps, booking.manage_token), overCap };
}

/**
 * What a cancel by token answers (#2658): whether THIS call made the transition,
 * and which booking it was about either way.
 *
 * The booking is named on BOTH outcomes because the embedded booker announces the
 * cancel to its host page as cal.com's `bookingCancelled`, which carries the
 * booking's id and bounds, and the host's funnel is about the call being off,
 * which is true whether this request or a concurrent one got there first.
 */
export interface CancelOutcome {
  claimed: boolean;
  booking: { id: string; startsAt: string; endsAt: string };
}

/** Cancel a booking by token. Returns true if THIS call transitioned the row
 *  to cancelled, false if it no-op'd an already-cancelled row (idempotent
 *  re-submit, or the losing side of a concurrent double-cancel). Callers that
 *  treat cancel as non-idempotent (the direct API, #398) map false to 404. */
export async function cancelBooking(
  token: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  deps: BookingDeps,
  actor?: BookingActor,
): Promise<boolean> {
  return (await cancelBookingWithDetail(token, reason, initiator, deps, actor)).claimed;
}

/** The cancel itself. `cancelBooking` above is this with the booking left off,
 *  for the callers that only ever asked whether they made the transition. */
export async function cancelBookingWithDetail(
  token: string,
  reason: ValidatedReason,
  initiator: BookingEventInitiator,
  deps: BookingDeps,
  actor?: BookingActor,
): Promise<CancelOutcome> {
  const ctx = await deps.loadBookingContext(token);
  if (!ctx) throw new Error("Booking not found");
  const { booking } = ctx;
  const named = { id: booking.id, startsAt: booking.starts_at, endsAt: booking.ends_at };
  if (booking.status === "cancelled") {
    // Already cancelled (re-submit). Ensure the reason was recorded — a first
    // attempt that flipped the status but died before recording it would lose
    // the mandatory reason (#326). One cancel per booking, so dedupe on action.
    if (!(await deps.hasBookingEvent(booking.id, "cancelled", null))) {
      await deps.insertBookingEvent(
        bookingEventFrom({
          bookingId: booking.id,
          action: "cancelled",
          initiator,
          reason,
          fromStartsIso: booking.starts_at,
          toStartsIso: null,
          fromAgentUserId: booking.assigned_user_id,
          toAgentUserId: null,
          actorUserId: actor?.userId,
          actingAsUserId: actor?.actingAsUserId,
          nowMs: Date.now(),
        }),
      );
    }
    return { claimed: false, booking: named };
  }

  // A completed meeting can't be flipped back to cancelled (#618). That would
  // corrupt show-rate analytics and fire a contradictory booking.cancelled to
  // Regal. For a customer clicking the manage link, reject with a friendly 4xx.
  // Admin/rebook/system callers skip the throw and rely on the status-gated
  // claim below to no-op instead of erroring mid-flow.
  if (initiator === "customer" && !CANCELLABLE_STATUSES.includes(booking.status)) {
    throw new BookingNotCancellableError();
  }

  // Atomically claim the transition BEFORE any side effect (#413). Two cancels
  // racing both read `active` above; the conditional flip lets exactly one win,
  // so the side effects below run once and the loser returns false (404 for the
  // non-idempotent direct API). A failed gcal delete still enqueues (#401), so
  // flipping status first never strands an event.
  if (!(await deps.claimCancellation(booking.id))) return { claimed: false, booking: named };

  // Record the cancel's intent durably, then deliver every side effect through
  // the idempotent outbox executor (#429 P3). The row is enqueued right after the
  // claim, so a crash mid-cancel resumes via the /api/cron/outbox drain instead
  // of stranding the gcal event or dropping the webhook. The inline run keeps the
  // happy path's latency; each step is idempotent so inline + drain never double-act.
  const steps = cancelOutboxSteps();
  const payload = {
    reasonCode: reason.code,
    reasonDetail: reason.detail,
    initiator,
    fromStartsIso: booking.starts_at,
    fromAgentUserId: booking.assigned_user_id,
    actorUserId: actor?.userId,
    actingAsUserId: actor?.actingAsUserId,
  };
  const outboxId = await deps.enqueueOutbox({
    booking_id: booking.id,
    action: "cancel",
    steps,
    payload,
  });
  // Lease the row before the inline run so a drain tick firing in the gap can't
  // run the same steps concurrently (which could double-insert history and so
  // double-fire the webhook). Released in finally; a crash leaves the lease to
  // expire so the drain reclaims it.
  // #1048: honour the lease answer. A null means a drain tick already holds this
  // row and is running the very steps we would run, so the right thing is to leave
  // it alone rather than run them alongside it. The row is durable, so nothing is
  // lost: whoever holds it finishes the delivery.
  const lease = await deps.leaseOutbox(outboxId);
  if (lease) {
    try {
      await runOutboxSteps(
        deps,
        {
          id: outboxId,
          booking_id: booking.id,
          action: "cancel",
          status: "pending",
          steps,
          payload,
          // The token this holder owns; every write the executor makes is gated on it.
          lease_until: lease,
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: "",
          updated_at: "",
        },
        OUTBOX_HANDLERS,
        lease,
      );
    } finally {
      await deps.releaseOutboxLease(outboxId, lease);
    }
  }
  return { claimed: true, booking: named };
}

/**
 * Complete one loaded batch: flip the due rows to `completed`. Returns how many
 * THIS call transitioned so the drain loop can tell progress (>0) from a stall
 * (0). Assumes `due` is non-empty.
 *
 * No webhook (#2915). Completion is decided on the clock, once a call's end time
 * has passed, not on evidence the call happened, so `booking.completed` fired for
 * no-shows too. Regal knows whether a call happened from its own call and
 * disposition data, and nothing listened for the event.
 */
async function completeDueBatch(
  deps: BookingDeps,
  dueIds: string[],
): Promise<number> {
  // One batched UPDATE for the whole batch instead of a round-trip per booking
  // (#164). The returned ids are the rows THIS call actually flipped, so an
  // overlapping cron tick that already completed some of them is not counted twice
  // (#163).
  const transitioned = await deps.completeBookingsIfDue(dueIds);
  return transitioned.length;
}

/**
 * Drain the finished-booking backlog: load and complete successive batches in
 * one run rather than clearing a single batch per tick and letting the rest
 * wait (#871, follow-up to #223). Each batch flips its rows to `completed`, so
 * the next `loadPastBookingIdsToComplete` query returns the following rows, so the
 * loop advances on its own and stops as soon as a batch comes back under the
 * cap (nothing more waiting).
 *
 * Two guards keep the loop bounded:
 *   - A batch that transitions ZERO rows makes no progress (every row it loaded
 *     was completed or cancelled by something else in between): stop rather
 *     than re-fetch the same set.
 *   - MAX_COMPLETION_DRAIN_BATCHES caps the run to stay inside the Worker
 *     CPU/subrequest budget. Hitting it with a full batch still pending is the
 *     fail-loud signal that the backlog is outgrowing the sweep, so warn (this
 *     replaces #223's per-batch warn, which now fires mid-drain and would read
 *     as "waiting" while we are in fact clearing it).
 */
export async function completePastBookings(
  deps: BookingDeps,
): Promise<{ completed: number; backlogRemains: boolean }> {
  let completed = 0;
  let batches = 0;
  let backlogRemains = false;

  while (batches < MAX_COMPLETION_DRAIN_BATCHES) {
    const due = await deps.loadPastBookingIdsToComplete();
    if (due.length === 0) break;
    batches += 1;

    const batchFull = due.length >= PAST_COMPLETION_BATCH_LIMIT;
    const transitioned = await completeDueBatch(deps, due);
    completed += transitioned;

    // Under-cap batch => nothing more waiting; zero progress => only stuck rows
    // left. Either way, stop before re-fetching. A full batch with progress
    // means more is likely queued: keep draining (subject to the cap).
    if (!batchFull || transitioned === 0) break;
    backlogRemains = batches >= MAX_COMPLETION_DRAIN_BATCHES;
  }

  if (backlogRemains) {
    log.warn("completion-sweep", {
      msg: "drain budget exhausted, backlog still waiting",
      drained: completed,
      batches,
    });
  }
  // `backlogRemains` is the completion sweep's saturation verdict: the caller
  // folds it into a consecutive-run streak and pages when sustained (#883).
  return { completed, backlogRemains };
}

/**
 * A lead corrects the number their advisor will call (#1341).
 *
 * The number is the most useful fact on the manage page and was the only one the
 * lead could not change. A mistyped digit, an old mobile, a work line nobody
 * answers: the advisor dials, nobody picks up, and it is recorded as a no show.
 * This is a scoped edit of ONE field on a booking the manage token already
 * authorises, not a new identity surface, so nothing else about the lead moves.
 *
 * The rule is the booker's own (`validateAttendee`), asked through the same
 * helper rather than a second copy, so a number the field would refuse can never
 * be accepted here and the product cannot say two things about one number
 * (#1356, L99).
 *
 * Order matters. The database is the source of truth and the invite is derived
 * from it, so the row is written first and the calendar body patched after. A
 * failed patch therefore leaves the lead's number CORRECT and one advisor's
 * invite stale, which is worth telling the lead was saved (because it was, L12)
 * and worth paging about (because the advisor will otherwise ring the old
 * number, which is exactly the harm this exists to prevent).
 */
export interface UpdatePhoneResult {
  ok: boolean;
  /** The stored number on success, normalised the way every write normalises it. */
  phone?: string;
  /** The lead-facing refusal on failure. Never a raw error. */
  error?: string;
  /**
   * Set when the number IS saved but the advisor's invite still shows the old
   * one. Returned rather than alerted here, because every other booking alert is
   * dispatched by the service layer; this keeps the domain node-testable and
   * puts the page where its siblings are. The caller must not turn it into a
   * failure for the lead: their number really is corrected.
   */
  staleInvite?: { agentEmail: string; bookingId: string };
  /**
   * Set when the number IS saved and `booking.contact_updated` could not be
   * recorded (#1512), so nothing will retry it and Regal still holds the old
   * number. Returned for the service layer to page, like `staleInvite`, and never
   * a failure for the lead: their number really is corrected.
   */
  downstreamUntold?: { bookingId: string };
}

/** One page per booking per day: a lead retyping the same number must not repage. */
export const STALE_PHONE_INVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The same for an untold correction (#1512): one booking, one page a day. */
export const PHONE_CORRECTION_UNSENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The manage page's own phone control (#1341), and the ONE caller that tells
 * downstream about the correction (#1512): the booker's move also writes contact
 * details, and its correction already rides the `booking.rescheduled` it emits.
 */
export async function updateBookingPhone(
  token: string,
  rawPhone: string,
  deps: BookingDeps,
): Promise<UpdatePhoneResult> {
  const res = await updateBookingContact(token, { phone: rawPhone }, deps, { announcePhoneCorrection: true });
  return res.ok
    ? {
        ok: true,
        phone: res.phone,
        ...(res.staleInvite ? { staleInvite: res.staleInvite } : {}),
        ...(res.downstreamUntold ? { downstreamUntold: res.downstreamUntold } : {}),
      }
    : { ok: false, error: res.error };
}

/**
 * What a move's own contact write corrected (#4031), handed to the move so its
 * webhook can say so. `previousPhone` is present only when the number changed.
 */
interface MoveCorrection {
  previousPhone?: string | null;
}

/** Which of the lead's own details a write actually moved. */
export interface ContactChange {
  name: boolean;
  email: boolean;
  phone: boolean;
}

export type UpdateContactResult =
  | {
      ok: true;
      /** The stored number, whether or not this write moved it. */
      phone: string;
      changed: ContactChange;
      /** The number this write replaced, present only when it moved the number (#4031). */
      previousPhone?: string | null;
      staleInvite?: { agentEmail: string; bookingId: string };
      downstreamUntold?: { bookingId: string };
    }
  | { ok: false; error: string };

/** True when this write moved nothing at all, so nothing was said or sent. */
export function contactUnchanged(changed: ContactChange): boolean {
  return !changed.name && !changed.email && !changed.phone;
}

/**
 * The lead's own details on a booking: their name, their email and the number
 * their advisor will ring (#1341 for the number, #2164 for the other two).
 *
 * A field left UNDEFINED is not touched. That is what lets the manage page's one
 * field control and the booker's whole form share this: the phone route sends one
 * key, the move sends three, and neither can reach anything else on the row.
 *
 * NOTHING IS WRITTEN WHEN NOTHING MOVED. A lead who reopens their link and
 * retypes the same details must not cost a row write, an invite rewrite and an
 * email to both people saying their event was updated.
 *
 * The invite is derived from the row, so it is refreshed AFTER the write, never
 * instead of it. Its failure is contained: the details are saved, and saying
 * otherwise would push the lead to retype what we already hold (L12).
 *
 * L33, stated rather than assumed: this pair is deliberately NOT outboxed. The
 * must-not-lose half is the row, and it commits first, so a crash between the two
 * loses the PAGE about a stale invite, never the correction itself. The residual
 * is one advisor reading old details off an invite with nothing saying so, which
 * is bounded and repairable from the booking. An outbox step would close it; it is
 * not worth a durable queue for a body rewrite.
 *
 * Every patch failure is treated the same on purpose: gone, refused or unwell, the
 * invite is stale either way, and splitting them would produce two pages that ask
 * for the same repair.
 */
export async function updateBookingContact(
  token: string,
  contact: { name?: string; firstName?: string; email?: string; phone?: string },
  deps: BookingDeps,
  opts: { announcePhoneCorrection?: boolean } = {},
): Promise<UpdateContactResult> {
  // Only the fields this caller actually sent are judged. Handing the validator a
  // field nobody supplied would refuse the write for a value nobody typed, and its
  // errors are all "enter your ..." sentences about an empty field.
  const asked: { name?: string; email?: string; phone?: string } = {};
  if (contact.name !== undefined) asked.name = contact.name.trim();
  if (contact.email !== undefined) asked.email = contact.email.trim();
  if (contact.phone !== undefined) asked.phone = contact.phone.trim();
  // Only the fields this caller SENT are judged. `validateAttendee` speaks for the
  // whole form, so reading its verdict on a field nobody supplied would refuse a
  // one field correction with "Enter your name" about a name that was never in
  // question.
  //
  // In the order the form shows them, so a lead correcting two things at once is
  // told about the first one they would look at.
  const errors = validateAttendee(asked);
  const invalid =
    (asked.name !== undefined ? errors.name : undefined) ??
    (asked.email !== undefined ? errors.email : undefined) ??
    (asked.phone !== undefined ? errors.phone : undefined);
  if (invalid) return { ok: false, error: invalid };

  const found = await deps.loadBookingContext(token);
  if (!found) return { ok: false, error: MANAGE_PHONE_NOT_FOUND };
  // The invite is edited in place, so its test line (#2660) stays as written; the
  // bucket is read only for the correction's webhook (#1512).
  const { booking, bucket, eventType } = found;
  // A call that has happened or been called off has no details left to correct,
  // and offering one would say we had not noticed. The page already hides the
  // control in those states; this is the same rule on the server, because a
  // client side gate is not a gate.
  if (booking.status === "cancelled" || booking.status === "completed") {
    return { ok: false, error: MANAGE_PHONE_NOT_CHANGEABLE };
  }

  // ONE shape for one number, and it is the shape the LOOKUP consumes (#2390).
  //
  // `findActiveBookingsForPerson` asks the database for `attendee_phone` equal to
  // `toE164(the number the caller gave)`, an exact equality on the column, and the rows it
  // fetches are the entire input to the one call per person rule. A row written in
  // any other spelling is a row that query can never fetch, so the gate cannot see
  // it and the same lead is booked twice: a second invite, a second slot consumed,
  // `booking.created` fired again. This used to write `formatPhoneAsTyped`, which
  // returns "(215) 555-9999" and never E.164, so the rule failed precisely for the
  // leads who had told us their number was wrong.
  //
  // `toE164` is the create path's own normalization, called here rather than copied,
  // so the two writers cannot drift into two spellings of one column (L150, L370).
  // It hands an unparseable number back verbatim rather than dropping it, which is
  // the same answer the create path gets for the same input.
  const nextPhone = asked.phone === undefined ? booking.attendee_phone : toE164(asked.phone);
  const nextName = asked.name === undefined ? booking.attendee_name : asked.name;
  const nextEmail = asked.email === undefined ? booking.attendee_email : asked.email;

  const changed: ContactChange = {
    name: nextName !== booking.attendee_name,
    // Compared without regard to case, because an address that differs only in
    // case is the same mailbox: rewriting the invite for it would email both
    // people about nothing.
    email: (nextEmail ?? "").toLowerCase() !== (booking.attendee_email ?? "").toLowerCase(),
    phone: nextPhone !== booking.attendee_phone,
  };
  const stored = nextPhone ?? "";

  // #2549: the answered first name moves WITH the name. A name changed by a caller
  // that sent no first name clears the old one, which would otherwise greet the
  // lead by somebody else's first name.
  //
  // #2835: and it may also move ON ITS OWN, when the name is unchanged and the
  // caller sent a first name that agrees with it: a lead who fixes only the split
  // between their first and last name. That was refused under #2549 because the
  // form seeded a returning lead by splitting the joined name, so an unedited
  // "Mary" came back looking like an answer. The form now seeds from the answered
  // first name and never sends back an untouched split (`prefillNameFields`), so
  // what arrives here is an answer. One that disagrees with the name, or that is
  // absent, leaves the stored answer alone rather than clearing it.
  const answeredFirstName = storedFirstName(nextName, contact.firstName);
  const firstNameMoved =
    !changed.name && answeredFirstName !== null && answeredFirstName !== booking.attendee_first_name;
  if (contactUnchanged(changed) && !firstNameMoved) return { ok: true, phone: stored, changed };

  const nextFirstName = changed.name || firstNameMoved ? answeredFirstName : booking.attendee_first_name;
  // What the row held before this write, so a correction Google refuses can be put
  // back exactly (#3373).
  const prior = {
    attendee_name: booking.attendee_name,
    attendee_first_name: booking.attendee_first_name,
    attendee_email: booking.attendee_email,
    attendee_phone: booking.attendee_phone,
  };
  await deps.updateBookingContact(booking.id, {
    ...(changed.name ? { attendee_name: nextName ?? "" } : {}),
    ...(changed.name || firstNameMoved ? { attendee_first_name: nextFirstName } : {}),
    ...(changed.email ? { attendee_email: nextEmail ?? "" } : {}),
    ...(changed.phone ? { attendee_phone: stored } : {}),
  });
  // The in-memory row too, so a caller that goes on to use this context (the move,
  // #2164) builds its calendar event and its webhook payload from the details the
  // lead just gave rather than the ones it read a moment ago.
  if (changed.name) booking.attendee_name = nextName ?? null;
  booking.attendee_first_name = nextFirstName;
  if (changed.email) booking.attendee_email = nextEmail ?? null;
  const previousPhone = prior.attendee_phone;
  if (changed.phone) booking.attendee_phone = stored;

  let staleInvite: { agentEmail: string; bookingId: string } | undefined;
  // The invite carries the joined name, never the first name, so a first name that
  // moved on its own leaves it exactly as it is and nothing is sent to rewrite it.
  if (booking.gcal_event_id && booking.agent_email && !contactUnchanged(changed)) {
    // #1334: the description is EDITED, never rebuilt. It reads what the invite says
    // now and changes the phone line, plus the calling number line only when
    // Salesforce answered with one, so every way of not knowing it (a refusal, a
    // timeout, an empty field) keeps the line the reminder lane already wrote, and
    // text this path did not compose (the reassign explanation, #969) survives.
    // The read is bounded by the manage page's own deadline, through the same
    // helper, so a slow Salesforce never stalls the lead's own correction.
    const callingNumber = changed.phone
      ? await callingNumberWithinDeadline(
          () => deps.readCallingNumber(bookingLeadId(booking)),
          (err) =>
            log.warn("manage-contact", {
              msg: "calling number unread, invite line left as it was",
              booking_id: booking.id,
              reason: shortErrorReason(err),
            }),
          deps.deadlineTimer,
        )
      : null;
    // The description read is its OWN step, so it cannot cost the rest of the
    // correction: a name or email moved with the phone still reaches the invite when
    // the description cannot be read. An invite that cannot be read (or is gone) has
    // only its description left as it was, never overwritten blind, and is reported
    // stale exactly as a failed write is.
    let description: string | undefined;
    let descriptionStale = false;
    if (changed.phone) {
      try {
        const current = await deps.readEventDescription(booking.agent_email, booking.gcal_event_id);
        if (current === null) throw new Error("the invite is gone");
        description = withCallingNumberLine(withPhoneLine(current, stored), callingNumber);
      } catch (err) {
        descriptionStale = true;
        log.warn("manage-contact", {
          msg: "invite description unread, left as it was",
          booking_id: booking.id,
          reason: shortErrorReason(err),
        });
      }
    }
    const patch = {
      // Each field is sent only when it moved, so the PATCH says exactly what
      // changed and `sendUpdates` is decided by whether the invitee did.
      ...(description !== undefined ? { description } : {}),
      ...(changed.name
        ? { summary: eventSummary({ eventType: eventType.name, advisor: booking.agent_name, lead: nextName ?? null }) }
        : {}),
      // #3376: the location is SET from the stored number, never edited, so unlike
      // the description it needs no read and moves even when the body could not be
      // read. A number the lead removed clears it.
      ...(changed.phone ? { location: eventLocation(stored) ?? "" } : {}),
      ...(changed.email ? { attendeeEmail: nextEmail ?? undefined, attendeeName: nextName ?? undefined } : {}),
    };
    let patchFailed = false;
    if (Object.keys(patch).length > 0) {
      try {
        await deps.updateEventContact(booking.agent_email, booking.gcal_event_id, patch);
      } catch (err) {
        // #3373: Google will never invite the new address, so this correction cannot
        // stand. It is the one patch failure that is not a stale invite: keeping the
        // row would store an address every later move of this call carries into a
        // refused create. The whole PATCH was refused, so the invite still holds the
        // old details, and the row goes back to them; the lead is told to fix the
        // email, as our own check would have. A revert that cannot be written throws
        // its own error rather than answering ok over a refused address (L12).
        if (changed.email && isInvalidAttendeeEmailRefusal(err)) {
          await deps.updateBookingContact(booking.id, {
            ...(changed.name ? { attendee_name: prior.attendee_name ?? "" } : {}),
            ...(changed.name || firstNameMoved ? { attendee_first_name: prior.attendee_first_name } : {}),
            attendee_email: prior.attendee_email ?? "",
            ...(changed.phone ? { attendee_phone: prior.attendee_phone ?? "" } : {}),
          });
          Object.assign(booking, prior);
          return { ok: false, error: INVALID_EMAIL };
        }
        patchFailed = true;
        log.warn("manage-contact", {
          msg: "invite not refreshed",
          booking_id: booking.id,
          reason: shortErrorReason(err),
        });
      }
    }
    if (descriptionStale || patchFailed) {
      staleInvite = { agentEmail: booking.agent_email, bookingId: booking.id };
    }
  }
  const downstreamUntold =
    opts.announcePhoneCorrection && changed.phone
      ? await announcePhoneCorrection(deps, booking, bucket, eventType, previousPhone)
      : undefined;
  return {
    ok: true,
    phone: stored,
    changed,
    ...(changed.phone ? { previousPhone } : {}),
    ...(staleInvite ? { staleInvite } : {}),
    ...(downstreamUntold ? { downstreamUntold } : {}),
  };
}

/**
 * Tell downstream a lead corrected their number with no reschedule beside it
 * (#1512), after the row is written and the invite has been tried.
 *
 * Through `fire`, so the payload is the one every booking event carries, built
 * from the row as it now stands, and a test bucket's correction is recorded but
 * never posted (#459). No dedupe key: each correction is its own event, and a key
 * built from the booking would drop the second one a lead makes.
 *
 * A failure is CONTAINED and REPORTED, never thrown: the number is saved, and
 * telling the lead otherwise would push them to retype a number we hold (L12),
 * whose retry then moves nothing and so would announce nothing either. Nothing
 * else will retry an event whose delivery row was never written, so the caller
 * pages instead.
 */
async function announcePhoneCorrection(
  deps: BookingDeps,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
  previousPhone: string | null,
): Promise<{ bookingId: string } | undefined> {
  try {
    await fire(deps, "booking.contact_updated", booking, bucket, eventType, null, { previousPhone });
    return undefined;
  } catch (err) {
    log.error("manage-contact", { msg: "phone correction not recorded for downstream", booking_id: booking.id }, err);
    return { bookingId: booking.id };
  }
}

export async function getBookingByToken(
  token: string,
  deps: BookingDeps,
): Promise<BookingContext | null> {
  try {
    return await deps.loadBookingContext(token);
  } catch {
    return null;
  }
}
