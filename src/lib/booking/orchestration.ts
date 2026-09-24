// Relative (not "@/") for the VALUE imports so this module is runnable
// under `node --experimental-strip-types` in tests — node doesn't resolve
// tsconfig path aliases, and type-only "@/" imports below are erased anyway.
import { toE164 } from "../phone.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  isUnderDailyCap,
  isOrgOpen,
  isWithinWorkingHours,
  type BusinessHoursRules,
  type SlotRules,
  type WorkingRule,
  type UnbookableReason,
} from "../availability/compute.ts";
import {
  bookingWindow,
  busyBlockFor,
  bookingEventFrom,
  deterministicEventId,
  EventGone,
  eventDescription,
  eventSummary,
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
  type PersonWorld,
  type PersonMatch,
  type MatchStrength,
} from "./person-dedupe.ts";
import {
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
import { bookingDetailHref } from "./detail.ts";
import { partnerKeysFrom, type PartnerKeys } from "./partner-keys.ts";
import { SLACK_NOT_CONFIGURED } from "../notify/slack.ts";
import { isDefinitiveFailure, reachabilityFromError } from "../google/reachability-classify.ts";
import type { FailureKind } from "../google/sync-health.ts";
import { encodeCursor, type ListQuery } from "./api-request.ts";
import { webhookDedupeKey } from "../webhooks/dedupe.ts";
import { runOutboxSteps, type OutboxHandlers } from "./outbox.ts";
import type { OutboxWriteOutcome } from "./outbox-lease.ts";
import { DRAIN_ALERT_AFTER } from "./drain-backoff.ts";
import { buildRoutingTraceExtras } from "../routing/explain.ts";
import { calendarLinks, icsDocument, icsUrl, leadCalendarEvent, type CalendarLinks } from "./calendar-links.ts";
import { resolveBucketPool } from "../availability/service.ts";
import type { RecordRoutingDecisionInput } from "../routing/record.ts";
import { tierKeyOf } from "../routing/tiers.ts";
import { walkTierLadder } from "../routing/tier-fallback.ts";
import { tierFallbackAlert } from "../routing/tier-alert.ts";
import {
  MANAGE_PHONE_NOT_CHANGEABLE,
  MANAGE_PHONE_NOT_FOUND,
} from "./manage-copy.ts";
import { validateAttendee } from "../attendee.ts";
import { leadCallingZone, withinLeadCallingWindow } from "./lead-calling-window.ts";
import { shortErrorReason } from "../notify/error-text.ts";
import { log } from "@/lib/log";
import {
  makeConfirmProfile,
  confirmProfileLine,
  ISOLATE_READY_AT_MS,
} from "@/lib/booking/confirm-profile";
import { isLoadtest } from "@/lib/loadtest-guard";
import { sendThrottledAlert } from "../notify/dispatch.ts";
import type { BookingEventPayload, BookingReasonMeta } from "@/lib/webhooks/types";
import { routingMetaFromTrace } from "@/lib/webhooks/types";
// Type-only (erased under --experimental-strip-types), so this never pulls the
// emit module's runtime deps into the node-tested domain code.
import type { WebhookSendScheduler } from "@/lib/webhooks/emit";
import { catchallRecord } from "@/lib/routing/catchall";
import type {
  Booking,
  BookingEventAction,
  BookingEventInitiator,
  BookingInsert,
  BookingStatus,
  BookingOutbox,
  BookingOutboxInsert,
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
    await deps
      .enqueueEventDeletion(email, eventId, bookingId)
      // Last line of defence: the live delete already failed, so if the retry
      // queue write is lost too, the Google event is orphaned on the agent's
      // calendar with nothing left to find it.
      .catch((err) =>
        log.error(
          "booking",
          { msg: "event-deletion enqueue failed", booking_id: bookingId, gcal_event_id: eventId },
          err,
        ),
      );
  }
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
  attendee: { name?: string; email?: string; phone?: string };
  prefill: Record<string, string>;
  /** Optional caller-supplied key; falls back to a derived bucket+slot+attendee key. */
  idempotencyKey?: string;
  /** External caller's stable per-person id (direct booking API, #357). */
  externalId?: string | null;
  /** Allow booking a synthetic test bucket (#396). Only the key-authed direct
   *  booking API sets this; the public /booking path leaves it falsy, so real
   *  leads can never book a test bucket. */
  allowTestBuckets?: boolean;
  /**
   * Refuse, rather than create, when this person already has an active call
   * (#1337). Set ONLY by the public booker: the direct booking API owns its own
   * decision (`decidePersonBooking`), which deliberately creates in a new bucket
   * before cancelling the old one on a cross-bucket rebook (#364), and would
   * break if the create underneath it started declining.
   */
  refuseIfPersonHasCall?: boolean;
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
  start: string;
  end: string;
  timezone: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

/**
 * insertBooking outcome. `conflict` means the slot is taken: another booking won
 * the verify-on-book race for this agent. EITHER guard can say so, and they are
 * not the same question (#2274). `bookings_active_slot_uniq` refuses a second
 * booking at the same START, and `bookings_active_no_overlap` refuses one
 * OVERLAPPING an existing booking for that agent, which is the case uniqueness
 * cannot see: appointments are longer than the grid they are offered on, so
 * adjacent offered times overlap. The caller turns either into
 * SlotUnavailableError, because both mean the same thing to a lead.
 */
export type InsertBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; conflict: boolean };

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

/** Every side effect the orchestration needs. `service.ts` wires the real ones. */
export interface BookingDeps {
  // availability / routing
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /** `preview` = a dry run (#380): route read-only, skipping the #321 shadow-study
   *  log + the unfair-ordering alert so previews don't pollute real-assignment data. */
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
  ): Promise<{ candidates: string[]; memberCount: number }>;
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
  ): Promise<VerifyResult>;
  createEvent(email: string, args: CreateEventArgs, clientId?: string): Promise<string>;
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
  /** Post one notice. Never throws; a refusal comes back as `ok: false`. */
  postHandoffNotice(channel: string, text: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * The zone this advisor keeps their week in, or null when Slate holds no
   * schedule for them. Never a default (see `loadAdvisorTimezone`).
   */
  advisorTimezone(userId: string): Promise<string | null>;
  /** #401: record a Google event deletion that failed, for the retry drain. */
  enqueueEventDeletion(calendarEmail: string, gcalEventId: string, bookingId: string | null): Promise<void>;
  /** #401: load pending event deletions for the retry drain. */
  loadPendingEventDeletions(limit: number): Promise<PendingEventDeletion[]>;
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
    patch: { summary?: string; description?: string; attendeeEmail?: string; attendeeName?: string },
  ): Promise<void>;
  // db
  getUser(userId: string): Promise<User>;
  /** Batched userId -> email resolver for a verify-on-book wave (skips emailless). */
  loadEmails(userIds: string[]): Promise<Map<string, string>>;
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
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
    patch: { attendee_name?: string; attendee_email?: string; attendee_phone?: string },
  ): Promise<void>;
  insertBooking(row: BookingInsert): Promise<InsertBookingResult>;
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
  }): Promise<{
    prevGcalEventId: string | null;
    prevAgentEmail: string | null;
    updated: boolean;
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
  /** Delete a reservation (delete-on-deliver, once the booking is persisted). */
  deleteReservation(id: string): Promise<void>;
  /** Pending reservations whose lease is free/expired, for the drain. */
  loadDrainableReservations(limit: number): Promise<BookingReservation[]>;
  /** Gated lease claim; true if THIS call took it (drain vs inline guard). */
  leaseReservation(id: string): Promise<boolean>;
  releaseReservationLease(id: string): Promise<void>;
  /** Record a failed reservation-drain pass (#445): bump attempts, store
   *  last_error, set next_attempt_at to now + exponential backoff. */
  bumpReservationAttempt(id: string, attempts: number, lastError: string): Promise<void>;
  /** Retention: delete up to `limit` pending reservations older than the cutoff
   *  (abandoned rows whose booking never completed). */
  deleteExpiredReservations(olderThanIso: string, limit: number): Promise<void>;
  /**
   * Gated reschedule commit (#615). Applies the move ONLY while the booking is
   * still the one we started moving: status still active AND assignee + gcal
   * event id unchanged since we read them. Returns true iff THIS update
   * transitioned the row. A concurrent cancel (flips status) or reassign (swaps
   * assignee + event id) makes it touch 0 rows, so the reschedule can roll back
   * instead of resurrecting a cancelled booking or clobbering the reassign.
   * Same gated-update shape as `claimCancellation` / `completeBookingsIfDue`.
   */
  commitReschedule(
    bookingId: string,
    patch: BookingUpdate,
    guard: { assignedUserId: string | null; gcalEventId: string | null },
  ): Promise<boolean>;
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
   * completable status, so an overlapping cron tick that already completed some
   * of them won't re-fire their booking.completed (#163). One statement for the
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
  loadPastBookingsToComplete(): Promise<BookingContext[]>;
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
  newManageToken(): string;
  /** A fresh, unique synthetic idempotency key for a keyless (anonymous) booking
   *  (#666), so it still gets the reservation-backed crash-safe create every keyed
   *  booking has. Random per call: there's no stable identity to dedupe on, so it
   *  provides no cross-request collapse (matching the old anonymous behavior), only
   *  the durable net. Distinct, non-colliding shape (e.g. an "anon_"-prefixed token)
   *  so it can never equal a derived bucket|slot|contact key. */
  newIdempotencyKey(): string;
  appBaseUrl(): string;
  /** Best-effort clear of a bucket's cached availability after a booking changes it. */
  invalidateSlots(bucketCode: string): Promise<void>;
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
   * The tier the availability cache CURRENTLY displays for a bucket code, or null
   * (#827). Read once on a fresh confirm, before write-through mutates the cache,
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
 * deleted + failed as the size of the page this pass loaded (#888).
 */
export async function processPendingEventDeletions(
  deps: BookingDeps,
  limit: number,
): Promise<{
  deleted: number;
  failed: number;
  stuck: PendingEventDeletion[];
  refused: RefusedEventDeletion[];
}> {
  const rows = await deps.loadPendingEventDeletions(limit);
  let deleted = 0;
  let failed = 0;
  const stuck: PendingEventDeletion[] = [];
  const refused: RefusedEventDeletion[] = [];
  for (const row of rows) {
    try {
      await deps.deleteEvent(row.calendar_email, row.gcal_event_id);
      await deps.removePendingEventDeletion(row.id);
      deleted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = reachabilityFromError(err);
      if (isDefinitiveFailure(kind)) {
        await deps.bumpPendingEventDeletion(row.id, PENDING_DELETION_GIVE_UP_AT, `${kind}: ${message}`);
        failed++;
        refused.push({ row, kind });
        continue;
      }
      const attempts = row.attempts + 1;
      await deps.bumpPendingEventDeletion(row.id, attempts, message);
      failed++;
      if (attempts >= PENDING_DELETION_ALERT_AFTER) stuck.push(row);
    }
  }
  return { deleted, failed, stuck, refused };
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
    return { freed: 0, freedCancelled: 0, freedOrphans: 0, userIds: [], scanned: rows.length };
  }
  await deps.deleteBusyBlocksByIds(stuck.map((r) => r.id));
  const freedCancelled = stuck.filter((r) => r.booking_id !== null).length;
  return {
    freed: stuck.length,
    freedCancelled,
    freedOrphans: stuck.length - freedCancelled,
    userIds: [...new Set(stuck.map((r) => r.user_id))],
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
 * The one thing it does NOT act on is a booking still inside its grace window: the
 * loader withholds those (#778, RECONCILE_MISSING_GRACE_MS), because a booking that
 * is merely mid-create has not missed anything, and treating it as a miss made this
 * sweep's counters and its Slack alert report far more damage than had occurred.
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

  await deps.insertBusyBlocks(
    missing.map((b) => busyBlockFor(b.user_id, b.starts_at, b.ends_at, b.id)),
  );
  return {
    recreated: missing.length,
    bookingIds: missing.map((b) => b.id),
    userIds: [...new Set(missing.map((b) => b.user_id))],
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
 * Verify-on-book: confirm round-robin candidates against live Google free/busy
 * in WAVES (one batched check per wave) rather than one serial call each, so a
 * large candidate pool can't chain many slow Google calls onto the lead's
 * confirm tap. First confirmed-free agent in round-robin order wins. Selection
 * core is `selectAgent` (pure/tested); this wires it to DB + Google.
 */
async function assignAgent(
  deps: BookingDeps,
  bucket: Bucket,
  eventType: EventType,
  startIso: string,
  endIso: string,
  preview = false,
): Promise<AssignResult & { candidates: string[] }> {
  const { candidates, memberCount } = await deps.roundRobinCandidates(
    bucket,
    eventType,
    Date.parse(startIso),
    preview,
  );

  const { assignment, anyUnverified } = await selectAgent(
    candidates,
    (userIds) => deps.loadEmails(userIds),
    (emails) => deps.verifyFree(emails, startIso, endIso),
    VERIFY_WAVE_SIZE,
  );
  if (!assignment) {
    // #1300: an EMPTY BUCKET is a misconfiguration and pages; a bucket whose people
    // are simply not on shift is an ordinary evening and must not.
    //
    // The candidate list is already filtered by all three gates, so zero candidates
    // used to mean both, and the alert said "No advisors are configured for this
    // booking type" for every out of hours attempt a bot could make. The pool size
    // is what tells them apart, and it is the only thing that can.
    if (memberCount === 0) throw new NoEligibleAgentsError(bucket.code, bucket.is_test);
    // People exist and none of them can take this time: from the caller's side that
    // is the same instruction as a taken slot, pick another time, so it reuses that
    // error rather than inventing a code the booking API's contract does not carry.
    // No agent was free. If at least one candidate couldn't be VERIFIED (read
    // error / outage), this isn't a genuinely-full slot — surface it distinctly
    // so the caller alerts + lets the lead retry, rather than showing "no times".
    if (anyUnverified) throw new VerifyUnavailableError();
    throw new SlotUnavailableError();
  }
  return { ...assignment, candidates };
}

interface TierAssignResult {
  bucket: Bucket;
  eventType: EventType;
  startIso: string;
  endIso: string;
  userId: string;
  email: string;
  candidates: string[];
  rungsDropped: number;
  /** #2158: the bucket's legal rule matched nobody, so it was dropped and the
   *  tier's whole pool was used. Carried out here rather than recomputed, so the
   *  trace and the notice describe the pool this booking actually came from. */
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
  // true so the cascade routes WITHOUT the #321 shadow-study log / unfair-ordering
  // alert. The real book leaves it false.
  preview = false,
): Promise<TierAssignResult> {
  // Shares walkTierLadder with the availability display cascade (#499), so the two
  // can never drift on the ladder or the rungs-dropped accounting; only the per-rung
  // predicate differs (here: an agent verifies free for the slot).
  let lastErr: unknown = null;
  const winner = await walkTierLadder<Omit<TierAssignResult, "rungsDropped">>(
    requested.bucket.code,
    async (rungCode, i) => {
      const resolved = i === 0 ? requested : await deps.resolveBucketByCode(rungCode);
      if (!resolved) return { hit: false }; // a lower tier with no bucket row: skip
      if (resolved.bucket.is_test && !allowTestBuckets) return { hit: false };
      const { startIso, endIso } = bookingWindow(startInstantIso, resolved.eventType.duration_min);
      try {
        const { userId, email, candidates } = await assignAgent(
          deps, resolved.bucket, resolved.eventType, startIso, endIso, preview,
        );
        return {
          hit: true,
          value: { bucket: resolved.bucket, eventType: resolved.eventType, startIso, endIso, userId, email, candidates },
        };
      } catch (err) {
        if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) {
          lastErr = err; // this tier can't serve the slot; drop a rung
          return { hit: false };
        }
        throw err; // VerifyUnavailableError and anything unexpected: do not mask
      }
    },
  );
  if (winner) return { ...winner.value, rungsDropped: winner.rungsDropped };
  throw lastErr ?? new SlotUnavailableError();
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
}

function webhookPayload(
  deps: BookingDeps,
  booking: Booking,
  bucket: Bucket,
  eventType: EventType,
  reason: BookingReasonMeta | null,
  previousAgentEmail: string | null,
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
      email: booking.attendee_email,
      phone: booking.attendee_phone,
    },
    prefill: booking.prefill,
    manage_url: manageUrl(deps, booking.manage_token),
    reason,
    previous_agent_email: previousAgentEmail,
    routing: routingMetaFromTrace(booking.routing_trace),
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
    webhookPayload(deps, booking, bucket, eventType, reason, extras.previousAgentEmail ?? null),
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
  OWNER_NOTICE: "reassign:owner_notice",
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
    if (ctx) await deps.invalidateSlots(ctx.bucket.code);
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
      { bookingEventId: eventId },
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
    if (ctx) await deps.invalidateSlots(ctx.bucket.code);
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
   * Three outcomes, and they are deliberately not three shades of one:
   *
   *  - NO channel set: the notice is dropped, recorded in the log, and the step
   *    completes. It must not page: the monitor lane already owns "handoffs are
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

    const channel = await deps.loadHandoffChannel();
    if (!channel) {
      log.warn("owner-notice", {
        msg: "no handoff channel is set, so the sales side was not told about an owner reassign",
        booking_id: booking.id,
        outbox_id: row.id,
      });
      return;
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
      return;
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

/** Max simultaneous booking.completed deliveries (Cloudflare subrequest cap). */
const COMPLETION_WEBHOOK_CONCURRENCY = 6;

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
  return findExistingCallForIdentity(
    {
      externalId: input.externalId ?? null,
      salesforceId: input.salesforceId ?? null,
      email: input.attendee.email ?? null,
      phone: input.attendee.phone ?? null,
    },
    deps,
    world,
  );
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

export async function createBooking(
  input: CreateBookingInput,
  deps: BookingDeps,
): Promise<BookingResult> {
  /**
   * Where this confirm's time went (#2321), under SLATE_LOADTEST only.
   *
   * The 2026-09-14 load run measured the request path at a CPU p99 of 4,908ms
   * against a wall p95 of 4,025ms with no cron in the window, so the path is
   * compute bound and nothing in the run could say which part of it. Reading the
   * code names candidates and cannot rank them (L355). This is WALL time and is
   * apportioned only because that run measured the two as roughly equal.
   *
   * With the flag unset it never reads the clock at all, so a production confirm
   * pays nothing rather than paying a little and discarding it.
   */
  // #2310: the lead's calling window, judged in the zone the booker was using.
  // First, before any read or write: it needs nothing but the request, and a
  // refused time must leave nothing behind.
  assertWithinLeadCallingWindow(input.startIso, input.timezone);

  const profile = makeConfirmProfile({
    enabled: isLoadtest(),
    now: () => Date.now(),
    isolateReadyAtMs: ISOLATE_READY_AT_MS,
  });

  // A STABLE key (caller-supplied, or derived from the lead's contact identity)
  // is what lets a re-submit collapse onto the same booking. Anonymous bookings
  // have none (idempotencyKeyFor returns null).
  const stableKey =
    input.idempotencyKey ??
    idempotencyKeyFor({
      bucketCode: input.bucketCode,
      startIso: input.startIso,
      email: input.attendee.email,
      phone: input.attendee.phone,
      salesforceId: input.salesforceId,
    });

  // Fast path: a double-click / retry of the same submit returns the existing
  // active booking instead of creating a second one (+ a second gcal event).
  // Only a stable key can match a prior booking; a synthetic key (below) is fresh
  // per request, so there's nothing to look up.
  if (stableKey) {
    const existing = await profile.time("idempotency-lookup", () =>
      deps.findBookingByIdempotencyKey(stableKey),
    );
    if (existing) {
      return { booking: existing, manageUrl: manageUrl(deps, existing.manage_token) };
    }
  }

  const resolved = await profile.time("resolve-bucket", () =>
    deps.resolveBucketByCode(input.bucketCode),
  );
  if (!resolved) throw new UnknownBucketError();
  const { bucket, eventType } = resolved;

  // A synthetic test bucket (#396) is unbookable on the public path unless the
  // caller may book one: the key-authed direct booking API always may, and the
  // Booker's confirm may for the PUBLIC test bucket alone (#2660). To a real lead
  // a hidden one must look like the bucket doesn't exist (same error as an
  // unknown code, no hint that a hidden bucket is there).
  if (bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();

  // One call per person, ENFORCED (#1337), not reported after the fact. Runs
  // AFTER the idempotency fast path above on purpose: a double-click's second
  // request would otherwise find the booking its own first request just made and
  // decline it, turning a successful confirm into "you already have a call". And
  // after the bucket resolves (#2660), because the gate is asked in that bucket's
  // WORLD: a test booking under an address must never refuse the real lead who
  // owns it, and a tester must never be refused because a lead shares theirs.
  if (input.refuseIfPersonHasCall) {
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
    const inFlight = await deps.loadReservationByKey(stableKey);
    if (inFlight) return completeReservation(deps, inFlight);
  }

  // The tier the availability cache shows for the requested bucket RIGHT NOW,
  // read before assign (and before the confirm's write-through mutates the
  // cache) so we can measure runtime divergence once the booking lands (#827).
  // Best-effort: a null (read failed, or a hidden test bucket) skips the measure.
  const displayedTier = await profile
    .time("displayed-tier", () => deps.displayedTier(input.bucketCode))
    .catch(() => null);

  // Fresh create: cascade down the tier ladder if the requested bucket has no
  // agent free for the slot. A crash before the reservation strands nothing.
  let tier: TierAssignResult;
  try {
    tier = await profile.time("assign-and-verify", () =>
      assignAgentWithTierFallback(deps, { bucket, eventType }, input.startIso, input.allowTestBuckets ?? false),
    );
  } catch (err) {
    // Best-effort: record no-booking attempts so "why did this lead get no slots"
    // is answerable. Awaited so the write is not dropped by the CF runtime; the
    // outer try/catch ensures the original error still propagates unchanged.
    if (
      err instanceof NoEligibleAgentsError ||
      err instanceof VerifyUnavailableError ||
      err instanceof SlotUnavailableError
    ) {
      const outcome =
        err instanceof NoEligibleAgentsError ? "no_eligible_agents" : "no_availability";
      try {
        const pool = await resolveBucketPool(bucket);
        await deps.recordRoutingDecision({
          orgId: bucket.org_id,
          bookingId: null,
          bucketCode: bucket.code,
          bucketId: bucket.id,
          criteria: pool.criteria,
          ...buildRoutingTraceExtras(pool, []),
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
          ...catchallRecord(input.requestedCode, bucket.code),
          outcome,
        });
      } catch {
        // best-effort: never change the thrown booking error
      }
    }
    throw err;
  }
  const bookedBucket = tier.bucket;
  const bookedEventType = tier.eventType;
  const startIso = tier.startIso;
  const endIso = tier.endIso;
  const { userId, email, candidates } = tier;
  const agent = await deps.getUser(userId);
  let traceExtras: ReturnType<typeof buildRoutingTraceExtras> = {
    considered: candidates,
    excluded: [],
  };
  try {
    const pool = await resolveBucketPool(bookedBucket);
    traceExtras = buildRoutingTraceExtras(pool, candidates);
  } catch {
    // best-effort: a transient pool-resolve failure must not fail the booking
  }
  const phone = toE164(input.attendee.phone);
  const manageToken = deps.newManageToken();
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
    attendee_email: input.attendee.email ?? null,
    attendee_phone: phone,
    prefill: input.prefill,
    gcal_event_id: gcalClientId, // the pinned client id IS the stored event id
    manage_token: manageToken,
    idempotency_key: idempotencyKey,
    external_id: input.externalId ?? null,
    routing_trace: {
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
    },
  };
  const event: ReservationPayload["event"] = {
    summary: eventSummary(bookedEventType.name, input.attendee.name ?? null),
    description: eventDescription(phone, manageUrl(deps, manageToken), { isTest: bookedBucket.is_test }),
    start: startIso,
    end: endIso,
    timezone: input.timezone,
    attendeeEmail: input.attendee.email,
    attendeeName: input.attendee.name,
  };

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
  const result = await profile.time("complete-reservation", () =>
    completeReservation(deps, reservation),
  );

  // The apportionment, once, at the end. It carries no contact data: the stage
  // names and their durations, plus what they do NOT account for. Under
  // SLATE_LOADTEST only, so nothing is written on a production confirm.
  const reading = profile.read();
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
    const bookedTier = tierKeyOf(bookedBucket.code);
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
  return result;
}

/**
 * The post-insert side effects a create MUST deliver, factored out so the fresh
 * create and a crash-resume run the SAME sequence (#613). Every step is
 * idempotent — moveBusyBlock replaces any prior block for the booking, and
 * booking.created dedupes on the booking id (`webhookDedupeKey`) so a re-run
 * emits nothing new — so running it inline once, or again from the reservation
 * drain after a crash, reaches the same end state without a duplicate block or a
 * double webhook. Returns the resolved bucket/eventType (or null) so the fresh
 * path can attach its best-effort routing log without a second resolve.
 */
async function deliverCreatedSideEffects(
  deps: BookingDeps,
  booking: Booking,
  bookedCode: string,
): Promise<{ bucket: Bucket; eventType: EventType } | null> {
  if (booking.assigned_user_id) {
    await deps.moveBusyBlock(
      booking.assigned_user_id,
      booking.starts_at,
      booking.ends_at,
      booking.id,
    );
  }
  await deps.invalidateSlots(bookedCode);

  // Re-resolve bucket + eventType for the webhook (works on the drain path too).
  const resolved = await deps.resolveBucketByCode(bookedCode);
  if (resolved) {
    await fire(deps, "booking.created", booking, resolved.bucket, resolved.eventType);
  }
  return resolved;
}

/**
 * Complete a booking from its reservation (#429 P4). Shared by the fresh create,
 * the re-submit resume, and the drain — so a crash anywhere resumes to the same
 * end state. Idempotent: createEvent reuses the event (deterministic id → 409),
 * a booking already inserted short-circuits, and insertBooking keeps the
 * active-slot 23505 handling. Deletes the reservation on success.
 */
async function completeReservation(
  deps: BookingDeps,
  reservation: BookingReservation,
): Promise<BookingResult> {
  const { booking: bookingInsert, event, bucketCode, requestedCode } = reservation.payload;
  const key = bookingInsert.idempotency_key;

  // A resume after the booking was inserted but before the reservation was
  // deleted. A crash here could have landed BEFORE booking.created fired (1336
  // -> 1374), which used to be dropped permanently: short-circuiting to just
  // delete the reservation skipped every post-insert side effect (#613). Instead,
  // re-run the idempotent side effects (busyblock/recompute/notify) so the
  // previously-lost booking.created is delivered exactly once, THEN clean up.
  if (key) {
    const already = await deps.findBookingByIdempotencyKey(key);
    if (already) {
      const bookedCode = already.routing_trace?.bucket_code ?? bucketCode;
      await deliverCreatedSideEffects(deps, already, bookedCode);
      await deps.deleteReservation(reservation.id);
      return { booking: already, manageUrl: manageUrl(deps, already.manage_token) };
    }
  }

  // Create OR reuse the calendar event with the pinned client id.
  const gcalEventId = await deps.createEvent(
    reservation.pinned_agent_email,
    {
      summary: event.summary,
      description: event.description,
      start: event.start,
      end: event.end,
      timezone: event.timezone,
      attendeeEmail: event.attendeeEmail ?? undefined,
      attendeeName: event.attendeeName ?? undefined,
    },
    reservation.gcal_client_id,
  );

  const inserted = await deps.insertBooking({ ...bookingInsert, gcal_event_id: gcalEventId });
  if (!inserted.ok) {
    if (inserted.conflict) {
      // A concurrent duplicate won the idempotency race, or the slot was taken.
      if (key) {
        const winner = await deps.findBookingByIdempotencyKey(key);
        if (winner) {
          await deps.deleteReservation(reservation.id);
          return { booking: winner, manageUrl: manageUrl(deps, winner.manage_token) };
        }
      }
      // Genuinely unavailable: roll back the event + reservation.
      await deleteEventBestEffort(deps, reservation.pinned_agent_email, gcalEventId, null);
      await deps.deleteReservation(reservation.id);
      throw new SlotUnavailableError();
    }
    // Generic (likely transient) failure: roll back the event (a resume
    // re-creates it via the same deterministic id), but LEAVE the reservation
    // pending so the drain retries the insert.
    await deleteEventBestEffort(deps, reservation.pinned_agent_email, gcalEventId, null);
    throw new Error("Failed to persist booking");
  }
  const booking = inserted.booking;

  // #586: the booking now owns this event id, so any source=gcal block for it is a
  // stray mirror a push-sync cached while racing the create (before the booking
  // committed). Delete it, else it would outlive a later cancel (which removes
  // blocks by booking_id, not the null-booking_id mirror) and over-block the freed
  // slot until a full resync. Idempotent (no-op when no mirror exists). Best-effort:
  // the booking has already committed, so a transient cleanup failure must NOT fail
  // it. The sync's slate-id delete and the full-resync purge are the backstops.
  if (booking.assigned_user_id && gcalEventId) {
    try {
      await deps.deleteGcalMirrorBlock(booking.assigned_user_id, gcalEventId);
    } catch {
      // best-effort
    }
  }

  // On a tier-drop the routing_trace records the booked (lower) bucket; on a
  // non-fallback booking it equals bucketCode. Use the persisted value so that
  // invalidateSlots, the webhook, and the routing-decision log all attribute
  // side-effects to the bucket whose availability actually changed.
  const bookedCode = booking.routing_trace?.bucket_code ?? bucketCode;

  // Deliver the busyblock/recompute/notify side effects idempotently — the SAME
  // path a crash-resume takes, so booking.created can't be dropped (#613).
  const resolved = await deliverCreatedSideEffects(deps, booking, bookedCode);
  if (resolved) {
    // Best-effort routing decision log. Awaited so the write is not dropped by the
    // CF runtime; try/catch keeps any transient failure out of the booking response.
    try {
      const chosenAgent = booking.assigned_user_id
        ? await deps.getUser(booking.assigned_user_id)
        : null;
      const rt = booking.routing_trace;
      await deps.recordRoutingDecision({
        orgId: booking.org_id,
        bookingId: booking.id,
        bucketCode: resolved.bucket.code,
        bucketId: resolved.bucket.id,
        criteria: resolved.bucket.criteria,
        considered: rt?.considered ?? [],
        excluded: rt?.excluded ?? [],
        chosenUserId: booking.assigned_user_id,
        chosenAttributes: chosenAgent?.attributes ?? null,
        emptyPoolFallback: rt?.fallback_applied ?? false,
        tierFallback: rt?.tier_fallback ?? false,
        rungsDropped: rt?.rungs_dropped ?? 0,
        requestedTier: rt?.requested_tier ?? null,
        bookedTier: rt?.booked_tier ?? null,
        // Judged against the bucket actually booked, never against the raw value
        // alone: the raw one comes from the client (#1908).
        ...catchallRecord(requestedCode, resolved.bucket.code),
        outcome: "booked",
      });
    } catch {
      // best-effort
    }
    // Best-effort routing fallback alert. Throttled via alert_state; a single tier
    // drop is a quiet notice, two or more tiers escalates. The rung COUNT is
    // deliberately not passed: since #1909 a rung is not a tier, so the alert
    // derives both facts from the two codes itself.
    //
    // A SIDEWAYS OVERFLOW SENDS NOTHING HERE (#2228). It returns null, because on a
    // two person Beyond pool it is the expected path rather than an incident, and
    // the monitor lane's `beyond_overflow_rate` step counts it once a day instead.
    const tierAlert = tierFallbackAlert({
      requestedCode: bucketCode,
      effectiveCode: booking.routing_trace?.bucket_code ?? bucketCode,
    });
    if (tierAlert) {
      // alert-key: tier_fallback:*
      // alert-key: tier_fallback_deep:*
      await sendThrottledAlert(tierAlert.key, tierAlert.cooldownMs, tierAlert.text).catch(() => {});
    }
  }

  await deps.deleteReservation(reservation.id);
  return { booking, manageUrl: manageUrl(deps, booking.manage_token) };
}

/**
 * Drain pending create reservations (#429 P4 / Phase C): a booking whose create
 * crashed after the reservation was written resumes here. Each row is leased
 * (so the drain and an inline re-submit can't both run it), then completed
 * idempotently — completeReservation reuses the pinned event + deletes the row
 * on success. A failure releases the lease so the next tick retries.
 */
export async function processBookingReservations(
  deps: BookingDeps,
  limit: number,
): Promise<{
  processed: number;
  completed: number;
  failed: number;
  stuck: BookingReservation[];
}> {
  const rows = await deps.loadDrainableReservations(limit);
  let completed = 0;
  let failed = 0;
  const stuck: BookingReservation[] = [];
  // Complete reservations concurrently but bounded (AUD-062): each is leased
  // first, so two drains never double-run a row; a large backlog clears in far
  // fewer ticks than a serial await-per-row loop.
  await mapWithConcurrency(rows, RESERVATION_DRAIN_CONCURRENCY, async (reservation) => {
    if (!(await deps.leaseReservation(reservation.id))) return;
    try {
      await completeReservation(deps, reservation);
      completed++;
    } catch (err) {
      failed++;
      // A genuine SlotUnavailable is TERMINAL: completeReservation already deleted
      // the row (the slot was taken), so don't bump/alert - that would schedule a
      // backoff on a row that no longer exists and could fire a "not completing"
      // alert pointing on-call at a deleted row. Only a TRANSIENT failure leaves
      // the row pending: bump attempts + last_error with backoff (#445) so we
      // don't re-hit it every tick; past the alert threshold it's reported stuck.
      if (!(err instanceof SlotUnavailableError)) {
        const attempts = reservation.attempts + 1;
        const lastError = err instanceof Error ? err.message : String(err);
        await deps.bumpReservationAttempt(reservation.id, attempts, lastError);
        if (attempts >= DRAIN_ALERT_AFTER) {
          stuck.push({ ...reservation, attempts, last_error: lastError });
        }
      }
    } finally {
      // Always release, even if the bump above rejected - mirror the outbox
      // drain so a transient bump error can't leak the lease or abort the batch.
      await deps.releaseReservationLease(reservation.id);
    }
  });
  return { processed: rows.length, completed, failed, stuck };
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
 */
export async function processAbandonedReschedulePins(
  deps: BookingDeps,
  graceMs: number,
): Promise<{ swept: number; enqueued: number; dropped: number }> {
  const rows = await deps.loadAbandonedReschedulePins(graceMs);
  let enqueued = 0;
  let dropped = 0;
  for (const row of rows) {
    if (
      row.branch === "reassign" &&
      row.gcal_client_id &&
      row.gcal_client_id !== row.booking_gcal_event_id
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
    await deps.releaseReschedule(row.booking_id);
  }
  return { swept: rows.length, enqueued, dropped };
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
  const identity: PersonIdentity = {
    externalId: input.externalId,
    salesforceId: input.salesforceId ?? null,
    email: input.attendee.email ?? null,
    phone: input.attendee.phone ?? null,
  };
  // The decision is graded in the WORLD of the bucket being booked (#2660), so
  // the bucket has to resolve first. The canary's SMOKE booking then dedupes
  // against its SMOKE2 one (both test) and never against a real lead's, and a
  // real lead's never against a test booking. An unknown or hidden bucket is
  // refused here rather than one step later, which is the same 422 either way.
  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new UnknownBucketError();
  if (resolved.bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();
  const candidates = await deps.findActiveBookingsForPerson(identity, {
    isTest: resolved.bucket.is_test,
  });
  const match = findPersonMatch(identity, candidates);
  return decidePersonBooking({
    startIso: input.startIso,
    match,
    confirmReschedule: input.confirmReschedule,
  });
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
  const decision = await resolvePersonDecision(input, deps);
  if (decision.action === "create") {
    const resolved = await deps.resolveBucketByCode(input.bucketCode);
    if (!resolved) throw new UnknownBucketError();
    if (resolved.bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();
    // Route through the SAME per-slot tier cascade the real book uses
    // (assignAgentWithTierFallback), not a plain single-bucket assign. Otherwise
    // the dry run answers "no eligible" for a busy-but-not-empty top tier that the
    // real book would serve from a lower rung, so preview and book disagree (#541).
    const tier = await assignAgentWithTierFallback(
      deps,
      { bucket: resolved.bucket, eventType: resolved.eventType },
      input.startIso,
      input.allowTestBuckets ?? false,
      true, // preview: read-only, no shadow-study log / unfair-ordering alert
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
 * Routes in preview mode (no shadow-study log / unfair-ordering alert). A busy
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
  | { outcome: "moved"; booking: Booking; manageUrl: string }
  | { outcome: "declined"; reason: BucketChangeDeclineReason };

async function moveToRequestedBucket(
  input: ApiBookingInput,
  existing: Booking,
  deps: BookingDeps,
  opts: { tolerateRefusal?: boolean } = {},
): Promise<BucketMove> {
  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new UnknownBucketError();
  if (resolved.bucket.id === existing.bucket_id) return { outcome: "unchanged" };

  let created: Awaited<ReturnType<typeof createBooking>>;
  try {
    created = await createBooking(input, deps);
  } catch (err) {
    if (opts.tolerateRefusal === false) throw err;
    // Only the two ordinary "no" answers are tolerated. A transient verify
    // outage or anything unexpected must never be reported as a lead who simply
    // could not be moved, because that would be a claim the code never measured.
    if (err instanceof SlotUnavailableError) return { outcome: "declined", reason: "slot_taken" };
    if (err instanceof NoEligibleAgentsError) {
      return { outcome: "declined", reason: "no_eligible_agents" };
    }
    throw err;
  }
  await cancelBooking(existing.manage_token, API_REBOOK_REASON, "system", deps);
  return { outcome: "moved", booking: created.booking, manageUrl: created.manageUrl };
}

export async function bookViaApi(
  input: ApiBookingInput,
  deps: BookingDeps,
): Promise<ApiBookingResult> {
  const decision = await resolvePersonDecision(input, deps);

  switch (decision.action) {
    case "create": {
      const res = await createBooking(input, deps);
      return { outcome: "created", booking: res.booking, manageUrl: res.manageUrl };
    }
    case "dedupe": {
      // #1465: the decision is made on the INSTANT alone, which is right for its
      // own rule (the same instant is the same booking intent) but leaves the
      // bucket with nowhere to be noticed. A re-tiered lead confirming the time
      // they already hold is the ordinary call, and answering 200 deduped left
      // them with the old pool and the old agent while the response said nothing.
      const moved = await moveToRequestedBucket(input, decision.booking, deps);
      if (moved.outcome === "moved") {
        return {
          outcome: "rescheduled",
          booking: moved.booking,
          manageUrl: moved.manageUrl,
        };
      }
      return {
        outcome: "deduped",
        booking: decision.booking,
        manageUrl: manageUrl(deps, decision.booking.manage_token),
        // Undefined when the bucket never changed, so the field means "the
        // change you asked for was dropped" rather than merely "no change".
        ...(moved.outcome === "declined" ? { bucketChangeDeclined: moved.reason } : {}),
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
      const moved = await moveToRequestedBucket(input, decision.booking, deps, {
        tolerateRefusal: false,
      });
      if (moved.outcome === "moved") {
        return { outcome: "rescheduled", booking: moved.booking, manageUrl: moved.manageUrl };
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
        { leadZone: input.timezone },
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
    externalId: b.external_id,
    salesforceId: b.salesforce_id,
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
  contact?: { name?: string; email?: string; phone?: string },
  /**
   * #2310: the zone the lead is looking at the new time in, when the caller
   * knows it: the manage page and the booker's move panel send the zone they
   * are showing, and the direct API sends the zone on its request. Undefined for
   * an admin move, where the screen's zone is the ADMIN's, so the booking's own
   * zone (the one the lead booked in) is the lead's clock instead.
   */
  opts?: { leadZone?: string | null },
): Promise<BookingResult> {
  // #2310: a zone the caller supplied is judged BEFORE the contact write below,
  // so a refused move never leaves the lead's details rewritten behind it. One
  // exception needs the row: a "move" onto the instant the booking already holds
  // is a no-op, not a move, and a call booked before this gate existed may sit
  // outside the window. So only an outside start pays a read here, to tell the
  // two apart. With no zone supplied, the booking's own zone is the lead's clock
  // and it is judged after the load below.
  const suppliedZone = opts?.leadZone ?? null;
  if (suppliedZone !== null && !withinLeadCallingWindow(newStartIso, suppliedZone)) {
    const held = await deps.loadBookingContext(token);
    const sameInstant = held !== null && Date.parse(held.booking.starts_at) === Date.parse(newStartIso);
    if (!sameInstant) throw new OutsideCallingWindowError(leadCallingZone(suppliedZone));
  }
  // Applied first, so everything below reads the details the lead just gave. A
  // refusal here stops the move: writing them is the point of having been given
  // them, and moving the call while silently dropping them is the one outcome
  // this was opened to end (L12).
  let contactChanged: ContactChange | null = null;
  if (contact) {
    const res = await updateBookingContact(token, contact, deps);
    if (!res.ok) throw new ContactRefusedError(res.error);
    contactChanged = contactUnchanged(res.changed) ? null : res.changed;
  }
  // #538: fold the in-place guard's working-hours read into the context load so
  // it costs no extra round-trip on the hot reschedule path.
  const ctx = await deps.loadBookingContext(token, { withWorkingHours: true });
  if (!ctx) throw new Error("Booking not found");
  const { booking, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new Error("This booking can no longer be changed");
  }

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

  try {
    const result = await applyReschedule(
      deps, token, ctx, startIso, endIso, reason, initiator, claim, nowMs, actor,
    );
    return { ...result, contactChanged, isTest: ctx.bucket.is_test };
  } finally {
    await deps.releaseReschedule(booking.id);
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
        next = await assignAgent(deps, bucket, eventType, startIso, endIso);
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

  // The event either branch below may have to CREATE, built once: the in place
  // branch creates it only when the PATCH target is gone, the reassign branch
  // always does, and the two must describe the same call the same way.
  const movedEvent = {
    summary: eventSummary(eventType.name, booking.attendee_name),
    description: eventDescription(booking.attendee_phone, manageUrl(deps, token), { isTest: bucket.is_test }),
    start: startIso,
    end: endIso,
    timezone: booking.timezone,
    attendeeEmail: booking.attendee_email ?? undefined,
    attendeeName: booking.attendee_name ?? undefined,
  };

  // Execute the pinned branch.
  let newGcalEventId = booking.gcal_event_id;
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
      newGcalEventId = await deps.createEvent(
        pin.pinned_agent_email,
        movedEvent,
        await deterministicEventId(`reschedule-recreate:${booking.id}:${pin.reschedule_seq}`, pin.pinned_user_id),
      );
    }
  } else {
    // reassign: CREATE-FIRST the new event with the pinned deterministic id (a
    // resume's repeat insert 409s and GET-and-reuses it -> no duplicate). The OLD
    // event is deleted only AFTER the durable commit below (AUD-044/#518): a
    // delete-first strands the booking on a deleted event if the create or commit
    // fails. On a generic create failure, delete the new event and let the pinned
    // id 409-re-create it on resume (mirrors completeReservation ~996).
    try {
      newGcalEventId = await deps.createEvent(pin.pinned_agent_email, movedEvent, pin.gcal_client_id);
    } catch (err) {
      await deleteEventBestEffort(deps, pin.pinned_agent_email, pin.gcal_client_id, booking.id);
      throw err;
    }
  }

  const agentName =
    pin.branch === "in_place" ? booking.agent_name : (await deps.getUser(pin.pinned_user_id)).name;
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
    },
    { assignedUserId: fromAgentUserId, gcalEventId: fromGcalEventId },
  );
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
      if (pin.branch === "reassign") {
        await deleteEventBestEffort(deps, pin.pinned_agent_email, pin.gcal_client_id, booking.id);
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

  // The booking is committed (updateBooking above) at the NEW time/agent. Deliver
  // the post-commit side effects (slot move, recompute, rescheduled webhook)
  // through the idempotent outbox executor (#429 P3), so a crash here resumes via
  // the drain instead of dropping the webhook or stranding the old slot. Leased
  // around the inline run so a drain tick can't double-run it.
  const steps = rescheduleOutboxSteps();
  const payload = {
    reasonCode: reason.code,
    reasonDetail: reason.detail,
    initiator,
    fromStartsIso,
    fromAgentUserId,
    actorUserId: actor?.userId,
    actingAsUserId: actor?.actingAsUserId,
  };
  const outboxId = await deps.enqueueOutbox({
    booking_id: booking.id,
    action: "reschedule",
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

  return {
    booking: updated,
    manageUrl: manageUrl(deps, token),
    rescheduleDecline: inPlaceDeclineReason ?? undefined,
  };
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
}

export async function reassignBooking(
  bookingId: string,
  agentEmail: string,
  reason: ValidatedReason,
  deps: BookingDeps,
  opts: ReassignOptions = {},
): Promise<BookingResult & { overCap: boolean }> {
  const { overrideCap = false, actor, initiator = "system", allowNonBookable = false } = opts;
  const ctx = await deps.loadBookingById(bookingId);
  if (!ctx) throw new BookingNotFoundError();
  const { booking, bucket, eventType } = ctx;
  if (booking.status === "cancelled" || booking.status === "completed") {
    throw new BookingNotChangeableError();
  }

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
  const gcalClientId = await deterministicEventId(
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
  const newEventId = await deps.createEvent(
    agent.email,
    {
      summary: eventSummary(eventType.name, booking.attendee_name),
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
  );

  // The reassignment audit record is appended server-side in reassign_booking_swap
  // under the row lock (#519): building the final array here off a snapshot read
  // before the swap would let two concurrent reassigns overwrite each other's
  // history entry. We pass only a BASE trace to seed the row if it has none; the
  // swap derives the record (from = the genuinely-current agent under the lock,
  // to = this target, at = now) and appends it onto the row's own current history.
  const baseTrace: RoutingTrace = booking.routing_trace ?? {
    bucket_code: bucket.code,
    bucket_id: bucket.id,
    considered: [],
    chosen_user_id: booking.assigned_user_id ?? "",
    fallback_applied: false,
    reassignments: [],
  };
  // Captured BEFORE the swap for the returned object's local trace view: the
  // agent we're moving away from, as this caller saw it.
  const fromUserId = booking.assigned_user_id;

  let swap: {
    prevGcalEventId: string | null;
    prevAgentEmail: string | null;
    updated: boolean;
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
    });
  } catch (err) {
    // The swap (durable anchor) failed: clean up the event we optimistically
    // created so it isn't orphaned + drop the intent (handled inline), then
    // surface the failure.
    await deleteEventBestEffort(deps, agent.email, newEventId, booking.id);
    await deps.deleteReassignIntent(booking.id, gcalClientId);
    throw err;
  }

  if (!swap.updated) {
    // The booking went terminal (cancelled/completed) concurrently. Clean up the
    // event we optimistically created so it isn't orphaned + drop the intent,
    // then surface it.
    await deleteEventBestEffort(deps, agent.email, newEventId, booking.id);
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

/** Cron sweep: mark finished bookings complete and emit booking.completed. */
/**
 * Complete one loaded batch: flip the due rows and fire booking.completed for
 * exactly the ones THIS call transitioned. Returns how many it transitioned so
 * the drain loop can tell progress (>0) from a stall (0). Assumes `due` is
 * non-empty.
 */
async function completeDueBatch(
  deps: BookingDeps,
  due: BookingContext[],
): Promise<number> {
  // One batched UPDATE for the whole batch instead of a round-trip per booking
  // (#164). The returned ids are the rows THIS call actually flipped, so an
  // overlapping cron tick that already completed some of them won't re-fire
  // their booking.completed — the receiver can't dedupe a second delivery (#163).
  const transitioned = new Set(
    await deps.completeBookingsIfDue(due.map((d) => d.booking.id)),
  );
  const toFire = due.filter((d) => transitioned.has(d.booking.id));

  // Fan booking.completed out with bounded concurrency rather than a serial
  // await per booking — faster under a backlog, but capped so we don't blow
  // the Worker's simultaneous-connection ceiling.
  await mapWithConcurrency(
    toFire,
    COMPLETION_WEBHOOK_CONCURRENCY,
    ({ booking, bucket, eventType }) =>
      fire(
        deps,
        "booking.completed",
        { ...booking, status: "completed" },
        bucket,
        eventType,
      ),
  );
  return toFire.length;
}

/**
 * Drain the finished-booking backlog: load and complete successive batches in
 * one run rather than clearing a single batch per tick and letting the rest
 * wait (#871, follow-up to #223). Each batch flips its rows to `completed`, so
 * the next `loadPastBookingsToComplete` query returns the following rows, so the
 * loop advances on its own and stops as soon as a batch comes back under the
 * cap (nothing more waiting).
 *
 * Two guards keep the loop bounded:
 *   - A batch that transitions ZERO rows makes no progress (only unresolvable
 *     rows remain, already error-logged per row in joinBookingContexts): stop
 *     rather than re-fetch the same set.
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
    const due = await deps.loadPastBookingsToComplete();
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
}

/** One page per booking per day: a lead retyping the same number must not repage. */
export const STALE_PHONE_INVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function updateBookingPhone(
  token: string,
  rawPhone: string,
  deps: BookingDeps,
): Promise<UpdatePhoneResult> {
  const res = await updateBookingContact(token, { phone: rawPhone }, deps);
  return res.ok
    ? { ok: true, phone: res.phone, ...(res.staleInvite ? { staleInvite: res.staleInvite } : {}) }
    : { ok: false, error: res.error };
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
      staleInvite?: { agentEmail: string; bookingId: string };
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
  contact: { name?: string; email?: string; phone?: string },
  deps: BookingDeps,
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
  if (contactUnchanged(changed)) return { ok: true, phone: stored, changed };

  await deps.updateBookingContact(booking.id, {
    ...(changed.name ? { attendee_name: nextName ?? "" } : {}),
    ...(changed.email ? { attendee_email: nextEmail ?? "" } : {}),
    ...(changed.phone ? { attendee_phone: stored } : {}),
  });
  // The in-memory row too, so a caller that goes on to use this context (the move,
  // #2164) builds its calendar event and its webhook payload from the details the
  // lead just gave rather than the ones it read a moment ago.
  if (changed.name) booking.attendee_name = nextName ?? null;
  if (changed.email) booking.attendee_email = nextEmail ?? null;
  if (changed.phone) booking.attendee_phone = stored;

  if (booking.gcal_event_id && booking.agent_email) {
    try {
      await deps.updateEventContact(booking.agent_email, booking.gcal_event_id, {
        // Each field is sent only when it moved, so the PATCH says exactly what
        // changed and `sendUpdates` is decided by whether the invitee did.
        ...(changed.phone
          ? { description: eventDescription(stored, manageUrl(deps, token), { isTest: bucket.is_test }) }
          : {}),
        ...(changed.name ? { summary: eventSummary(eventType.name, nextName ?? null) } : {}),
        ...(changed.email ? { attendeeEmail: nextEmail ?? undefined, attendeeName: nextName ?? undefined } : {}),
      });
    } catch (err) {
      log.warn("manage-contact", {
        msg: "invite not refreshed",
        booking_id: booking.id,
        reason: shortErrorReason(err),
      });
      return {
        ok: true,
        phone: stored,
        changed,
        staleInvite: { agentEmail: booking.agent_email, bookingId: booking.id },
      };
    }
  }
  return { ok: true, phone: stored, changed };
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
