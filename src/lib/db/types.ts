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
   * This agent's manager (routes OOO requests). Synced from Salesforce's
   * Agent_Manager picklist (#76); admins can override and the sync never nulls
   * an existing assignment when SF doesn't resolve one.
   */
  manager_id: string | null;
  /** On manager rows: the manager's OOO Google calendar for approval events. */
  ooo_calendar_id: string | null;
  /** Account-tied UI theme; 'system' follows the device setting. */
  theme_preference: ThemePreference;
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
  routing_trace: RoutingTrace | null;
  /** Set ONLY by the reassign API to stack a consult onto a busy owning agent. */
  allow_double_book: boolean;
  created_at: string;
  updated_at: string;
}

/** How a booking routed (for troubleshooting). Stored on bookings.routing_trace. */
export interface RoutingTrace {
  bucket_code: string;
  bucket_id: string;
  /** Free + least-recently-booked-ordered candidate ids that were considered. */
  considered: string[];
  chosen_user_id: string;
  fallback_applied: boolean;
  /** Manual overrides via the reassign API, in order (contact-owner stickiness). */
  reassignments?: { from: string | null; to: string; at: string }[];
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
