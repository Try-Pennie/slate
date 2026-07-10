/**
 * Hand-written row types mirroring supabase/migrations/0001_init.sql.
 * (Swap for `supabase gen types typescript` output once a project is linked.)
 */

export type Role = "super_admin" | "admin" | "team_lead" | "manager" | "agent";
export type BusySource = "slate" | "gcal";
export type OooStatus = "pending" | "approved" | "rejected" | "cancelled";
export type ThemePreference = "system" | "light" | "dark";
export type BookingStatus =
  | "confirmed"
  | "rescheduled"
  | "cancelled"
  | "completed";
export type WebhookEvent =
  | "booking.created"
  | "booking.rescheduled"
  | "booking.cancelled"
  | "booking.completed";
export type DeliveryStatus = "pending" | "success" | "failed";

export interface Organization {
  id: string;
  name: string;
  default_timezone: string;
  default_start_minute: number;
  default_end_minute: number;
  default_weekdays: number[];
  booker_layout: string;
  created_at: string;
}

/** Routing attributes, e.g. { debt_team: ["ultra_high"], role: "sales_agent" }. */
export type Attributes = Record<string, string | number | boolean | string[]>;
/** Bucket attribute filter; every key must match (see matchesCriteria). */
export type Criteria = Record<string, string | number | boolean | string[]>;

export interface User {
  id: string;
  org_id: string;
  /** Set only for users who log in (admins); null for synced agents. */
  auth_user_id: string | null;
  email: string;
  name: string | null;
  role: Role;
  google_sub: string | null;
  /** Google profile picture URL from OAuth metadata; null until first login. */
  avatar_url: string | null;
  attributes: Attributes;
  /** Whether this agent can receive bookings (gates the round-robin pool). */
  bookable: boolean;
  /**
   * Offboarding marker (#265): when set, the user has left and is excluded from
   * the booking pool, round-robin, sync/watch loop, admin roster, and manager
   * picker — but the row is retained so history (bookings, OOO) stays intact.
   * null = active; reactivation (rehire) sets it back to null. Orthogonal to
   * `bookable` (on-shift axis): a deactivated user is never routable regardless.
   */
  deactivated_at: string | null;
  /** When the backstop sync cron last processed this agent (#238 rotation); null = never. */
  last_synced_at: string | null;
  /**
   * This agent's manager (routes OOO requests). Synced from Salesforce's
   * Agent_Manager picklist (#76); admins can override and the sync never nulls
   * an existing assignment when SF doesn't resolve one.
   */
  manager_id: string | null;
  /** On manager rows: the manager's OOO Google calendar for approval events. */
  ooo_calendar_id: string | null;
  /** Account-tied UI theme; 'system' follows the device setting. */
  theme_preference: ThemePreference;
  /** Synthetic smoke-test agent (#396): hidden from internal UI; stays bookable
   *  only inside its own test buckets via the key-authed smoke test. */
  is_test: boolean;
  created_at: string;
}

export interface OooRequest {
  id: string;
  org_id: string;
  user_id: string;
  /** Manager snapshot at submit time. */
  manager_id: string | null;
  starts_at: string;
  ends_at: string;
  /** Display timezone the agent submitted in; notifications render in it. */
  display_tz_id: string;
  display_tz_label: string;
  /** Whether the agent picked "all day" (stored, not inferred from the times). */
  all_day: boolean;
  reason: string;
  notes: string | null;
  status: OooStatus;
  rejection_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  cancelled_at: string | null;
  /** Post-approval artifact ids, stored for deterministic undo. */
  manager_event_id: string | null;
  manager_event_calendar_id: string | null;
  agent_event_id: string | null;
  busy_block_id: string | null;
  calcom_synced: boolean;
  /** Per-effect outcome map, e.g. { manager_event: "ok", calcom: "skipped" }. */
  side_effects: Record<string, string>;
  /** Where the manager Slack notification landed, so its status can be edited. */
  slack_channel: string | null;
  slack_ts: string | null;
  /** Sheet request_id from the one-time import (idempotency key). */
  legacy_request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoogleCredentials {
  id: string;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null;
  calendar_id: string;
  watch_channel_id: string | null;
  watch_resource_id: string | null;
  watch_expiration: string | null;
  sync_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventType {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  regal_type: string;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  daily_cap: number | null;
  slot_interval_min: number;
  created_at: string;
}

export interface Bucket {
  id: string;
  org_id: string;
  code: string;
  name: string;
  event_type_id: string;
  assignment: "round_robin";
  criteria: Criteria;
  /** Optional cal.com routing-form UUID this bucket maps to (drop-in swap, #15). */
  routing_form_id: string | null;
  /** Agent to route to when no agent matches the bucket's criteria/members. */
  fallback_user_id: string | null;
  /** Synthetic smoke-test bucket (#396): hidden from public availability + the
   *  /book page, and unbookable via the public path; only the key-authed smoke
   *  test may book it. */
  is_test: boolean;
  created_at: string;
}

export interface BucketMember {
  id: string;
  bucket_id: string;
  user_id: string;
  weight: number;
  active: boolean;
  created_at: string;
}

export interface AvailabilitySchedule {
  id: string;
  user_id: string;
  timezone: string;
  created_at: string;
}

/** weekday: 1=Mon .. 7=Sun (Luxon). Minutes are local to the schedule timezone. */
export interface AvailabilityRule {
  id: string;
  schedule_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface AlertState {
  key: string;
  last_sent_at: string;
}

/** Per-alert cooldown override (#571); a missing row = use the coded default. */
export interface MonitorSettings {
  key: string;
  cooldown_min: number | null;
  updated_at: string;
  updated_by: string | null;
}

/** Single-row global monitor config (#571): low-volume floors + the app-wide
 *  default Slack channels. Null column = unset = fall through to env/default. */
export interface MonitorAlertConfig {
  id: number;
  floor_30: number | null;
  floor_120: number | null;
  alerts_channel: string | null;
  info_channel: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Cross-request lock row (#30); a claim is stale after its TTL. */
export interface SyncLock {
  key: string;
  claimed_at: string;
}

/**
 * Short-lived idempotency lock for token reschedules (one row per in-flight
 * booking + target instant). The winner of a double-submit holds it for the
 * operation; the loser no-ops. Reclaimed once `claimed_at` ages out.
 */
export interface RescheduleLock {
  booking_id: string;
  target_starts_at: string;
  claimed_at: string;
  // #439 (migration 0053): per-booking lease-pin. Null until a reschedule pins
  // its chosen target agent + deterministic Google client id; read back verbatim
  // on a crash-resume so the retry reuses the SAME agent + event (never recompute).
  pinned_user_id: string | null;
  pinned_agent_email: string | null;
  gcal_client_id: string | null;
  branch: "in_place" | "reassign" | null;
  reschedule_seq: number | null;
  lease_until: string | null;
}

/** Crash-safe standalone-reassign create intent (#518, migration 0065). Written
 *  before reassignBooking's createEvent, deleted on success, swept if abandoned.
 *  `prev_*` are filled after the swap (the replaced event to finish deleting). */
export interface ReassignIntent {
  id: string;
  booking_id: string;
  pinned_agent_email: string;
  gcal_client_id: string;
  prev_agent_email: string | null;
  prev_gcal_event_id: string | null;
  lease_until: string;
  created_at: string;
}

/** Fixed-window rate-limit counter (#31); one row per key, reset in place. */
export interface RateLimit {
  key: string;
  window_start: string;
  count: number;
}

export interface BusyBlock {
  id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  source: BusySource;
  gcal_event_id: string | null;
  calendar_id: string | null;
  booking_id: string | null;
  created_at: string;
}

/** Per-calendar Google sync + push state for an agent (one row per calendar). */
export interface AgentCalendar {
  id: string;
  user_id: string;
  calendar_id: string;
  sync_token: string | null;
  watch_channel_id: string | null;
  watch_resource_id: string | null;
  watch_expiration: string | null;
  /** Changes arrived while another request held the sync claim (#30). */
  sync_pending: boolean;
  /** Per-calendar sync claim; stale after CALENDAR_CLAIM_TTL_MS. */
  sync_claimed_at: string | null;
  /** Diagnostics (#273): last error message from sync/watch, or null if healthy. */
  last_sync_error: string | null;
  /** Diagnostics (#273): consecutive failed passes; 0 when last attempt succeeded. */
  consecutive_failures: number;
  /** Diagnostics (#273): last time this calendar synced/renewed cleanly. */
  last_success_at: string | null;
  created_at: string;
}

export interface Booking {
  id: string;
  org_id: string;
  bucket_id: string;
  event_type_id: string;
  assigned_user_id: string | null;
  agent_name: string | null;
  agent_email: string | null;
  starts_at: string;
  ends_at: string;
  /**
   * The ORIGINAL scheduled time, preserved immutably across reschedules so
   * show-rate can be measured against it (#300/ADR 0001). Set at creation;
   * reschedule never touches it. Null for historical rows whose original time
   * predates this column and is unrecoverable (see migration 0041).
   */
  original_starts_at: string | null;
  original_ends_at: string | null;
  timezone: string;
  status: BookingStatus;
  salesforce_id: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  prefill: Record<string, string>;
  gcal_event_id: string | null;
  manage_token: string;
  idempotency_key: string | null;
  /** External caller's stable per-person id (direct booking API, #357). Null for
   *  embed/human bookings, which are matched by identity instead. */
  external_id: string | null;
  routing_trace: RoutingTrace | null;
  /** Set ONLY by the reassign API to stack a consult onto a busy owning agent. */
  allow_double_book: boolean;
  /** Monotonic count of COMMITTED reschedules (#439, migration 0053). Mixed into
   *  the deterministic reschedule event id so an oscillating reschedule can't
   *  reuse a tombstoned Google id. 0 for a never-rescheduled booking. */
  reschedule_seq: number;
  created_at: string;
  updated_at: string;
}

/** Why a candidate was excluded from a routing decision. */
export type RoutingExcludeReason = "criteria_miss" | "no_availability";

export interface RoutingExclusion {
  user_id: string;
  reason: RoutingExcludeReason;
}

/** How a booking routed (for troubleshooting). Stored on bookings.routing_trace. */
export interface RoutingTrace {
  bucket_code: string;
  bucket_id: string;
  considered: string[];
  chosen_user_id: string;
  fallback_applied: boolean;
  reassignments?: { from: string | null; to: string; at: string }[];
  // Explainability (Plan 1):
  excluded?: RoutingExclusion[];
  // Tier-drop fields — populated by Plan 2, default false/0/null here:
  tier_fallback?: boolean;
  requested_tier?: string | null;
  booked_tier?: string | null;
  rungs_dropped?: number;
}

/** One routing decision, including attempts that produced no booking. */
export interface RoutingDecision {
  id: string;
  org_id: string;
  booking_id: string | null;
  bucket_code: string;
  bucket_id: string | null;
  requested_tier: string | null;
  booked_tier: string | null;
  chosen_user_id: string | null;
  considered: string[];
  excluded: RoutingExclusion[];
  empty_pool_fallback: boolean;
  tier_fallback: boolean;
  rungs_dropped: number;
  outcome: "booked" | "no_availability" | "no_eligible_agents" | "error";
  created_at: string;
}

/** What a booking_events row records. */
export type BookingEventAction = "rescheduled" | "cancelled" | "reassigned";
/** Who drove a booking_events row. */
export type BookingEventInitiator = "customer" | "agent" | "admin" | "system";

/**
 * Append-only history of how a booking moved (#326/#300, ADR 0001): one row per
 * reschedule / cancel / reassign, with the reason, who did it, the time change,
 * and any agent change. Reporting reads `action` (a reassign also emits
 * booking.rescheduled but must NOT count as a customer reschedule).
 */
export interface BookingEvent {
  id: string;
  booking_id: string;
  action: BookingEventAction;
  initiator: BookingEventInitiator;
  /** Stable analytics code; one of the action's reason options (or "other"). */
  reason_code: string;
  /** Free text for the "Other" option; null otherwise. */
  reason_detail: string | null;
  from_starts_at: string | null;
  to_starts_at: string | null;
  from_agent_user_id: string | null;
  to_agent_user_id: string | null;
  /** Staff user accountable for an admin action (#549); null for customer/system.
   *  Under impersonation this is the REAL admin (see acting_as_user_id). */
  actor_user_id: string | null;
  /** The user an admin acted AS via impersonation (#549); null otherwise. */
  acting_as_user_id: string | null;
  /** Signed minutes from the action to the appointment; negative = after it. */
  lead_time_minutes: number | null;
  /** The booking's reschedule generation when this event was recorded (#614,
   *  migration 0061). Versions the rescheduled-webhook dedupe key so an
   *  oscillation back to a previously-used time isn't swallowed. Null for
   *  historical rows and for cancel/reassign events (they don't version by seq). */
  reschedule_seq: number | null;
  created_at: string;
}

export type WebhookFormat = "generic" | "regal";

export interface WebhookEndpoint {
  id: string;
  org_id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  format: WebhookFormat;
  /** For format='regal': the value sent in the Authorization header. */
  auth_header: string | null;
  active: boolean;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  org_id: string;
  actor_id: string | null;
  action: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  last_response: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SPIKE (spike/precompute-bucket-slots): one pre-unioned BucketSlots blob per
 * bucket, read by PK on the availability hot path. `payload` is a stored
 * BucketSlots (validated on read by shapePrecomputedRow).
 */
export interface BucketSlotsRow {
  bucket_code: string;
  payload: unknown;
  computed_at: string;
}

export interface PendingEventDeletion {
  id: string;
  calendar_email: string;
  gcal_event_id: string;
  booking_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The booking change-path mutation an outbox row drives to completion (#429).
 *  No 'create': the create path uses booking_reservations as its durable intent
 *  (#613), never an outbox row. */
export type BookingOutboxAction = "cancel" | "reschedule" | "reassign";
export type OutboxStepState = "pending" | "done" | "failed";

/** One side effect of a mutation, tracked so the drain resumes only what's left. */
export interface OutboxStep {
  name: string;
  state: OutboxStepState;
  error?: string | null;
}

/**
 * Mutation context carried on an outbox row so a drained step doesn't depend on
 * booking state the mutation already changed. Fields are per-action and optional.
 */
export interface OutboxPayload {
  reasonCode?: string;
  reasonDetail?: string | null;
  initiator?: BookingEventInitiator;
  fromStartsIso?: string;
  fromAgentUserId?: string | null;
  /** Staff user accountable for an admin action (#549); carried so the drained
   *  history-write step records it even on a crash-resume. */
  actorUserId?: string | null;
  /** The user an admin acted AS via impersonation (#549). */
  actingAsUserId?: string | null;
}

/**
 * Durable intent record for a booking mutation (#429 P2). Written at the
 * mutation's atomic commit point; a dedicated drain lane resumes any row that
 * isn't `delivered`, re-running only its not-`done` steps idempotently. `steps`
 * carries every datum the drain needs to resume without re-reading mutable
 * booking state. `booking_id` is nullable for the create-reservation case (the
 * row exists before the booking does).
 */
export interface BookingOutbox {
  id: string;
  booking_id: string | null;
  action: BookingOutboxAction;
  status: "pending" | "delivered";
  steps: OutboxStep[];
  payload: OutboxPayload;
  lease_until: string | null;
  attempts: number;
  last_error: string | null;
  /** Earliest time the drain may re-attempt this row (#445 backoff); null = now. */
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingOutboxInsert {
  booking_id: string | null;
  action: BookingOutboxAction;
  steps: OutboxStep[];
  payload: OutboxPayload;
}

/** The row createBooking persists. (Lives here, not orchestration, so the
 *  reservation payload can reference it without a circular import.) */
export type BookingInsert = {
  org_id: string;
  bucket_id: string;
  event_type_id: string;
  assigned_user_id: string;
  agent_name: string | null;
  agent_email: string | null;
  starts_at: string;
  ends_at: string;
  /** Immutable original scheduled time (#300); set = starts/ends at creation. */
  original_starts_at: string;
  original_ends_at: string;
  timezone: string;
  status: "confirmed";
  salesforce_id: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  prefill: Record<string, string>;
  gcal_event_id: string;
  manage_token: string;
  idempotency_key: string | null;
  external_id: string | null;
  routing_trace: RoutingTrace;
};

/** The calendar-event input, captured in a reservation so a resume re-creates
 *  the SAME event (with the pinned client id) without re-deriving it. */
export interface ReservationEventInput {
  summary: string;
  description: string;
  start: string;
  end: string;
  timezone: string;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
}

/** Everything a resume needs to complete the booking WITHOUT re-running the
 *  non-deterministic assignAgent (#429 P4): the exact booking row to insert (its
 *  gcal_event_id is the pinned client id), the calendar-event input, and the
 *  bucket code (to recompute + re-resolve bucket/eventType for the webhook). */
export interface ReservationPayload {
  booking: BookingInsert;
  event: ReservationEventInput;
  bucketCode: string;
}

/**
 * Intent-first create reservation (#429 P4). Written as the FIRST durable act of
 * a booking; pins the agent + a deterministic Google client event id before the
 * calendar event exists. Deleted on successful delivery; the drain resumes any
 * left pending. `idempotency_key` is UNIQUE — the concurrency arbiter.
 */
export interface BookingReservation {
  id: string;
  idempotency_key: string;
  pinned_user_id: string;
  pinned_agent_email: string;
  gcal_client_id: string;
  payload: ReservationPayload;
  status: "pending" | "delivered";
  lease_until: string | null;
  attempts: number;
  last_error: string | null;
  /** Earliest time the drain may re-attempt this row (#445 backoff); null = now. */
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export type BookingReservationInsert = {
  idempotency_key: string;
  pinned_user_id: string;
  pinned_agent_email: string;
  gcal_client_id: string;
  payload: ReservationPayload;
};

/** Dead-man's switch heartbeat (#420): one row per cron lane, stamped each tick. */
export interface LaneHeartbeat {
  lane: string;
  last_ran_at: string;
}

/** Rotating scan offset for a bounded self-heal sweep (#512): one row per sweep,
 *  advanced across ticks so the scan eventually covers rows past the first page. */
export interface SelfhealScanCursor {
  key: string;
  next_offset: number;
  updated_at: string;
}
