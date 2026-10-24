/**
 * Hand-written row types mirroring supabase/migrations/0001_init.sql.
 * (Swap for `supabase gen types typescript` output once a project is linked.)
 */

import type { BookingSource } from "../booking/booking-source.ts";
import type { RoutingCodeRecord } from "../routing/lead-code.ts";
import type { RecordedRefusalStage } from "../booking/refusal-trace.ts";
import type { DemotionChange } from "../booking/demotion-plan.ts";

export type Role = "super_admin" | "admin" | "team_lead" | "manager" | "agent";
/** `hold` (#3248, migration 0167): written by a reroute hold's trigger, carrying
 *  `hold_id`, so the slot cache keeps a held advisor's time off the offer. */
/** `ooo` (#3365, migration 0172): a time off's held window, owned by its request
 *  through `ooo_request_id` and released with it by a trigger. Its own source so
 *  no sweep of 'slate' booking rows or 'gcal' mirrors can take it. */
export type BusySource = "slate" | "gcal" | "hold" | "ooo";
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
  /**
   * A booking moved to another advisor at the SAME time (#2368). Its own event
   * rather than a reschedule, because a reassign never changes the time and
   * every Regal journey listening for a time change was firing on one that had
   * not happened.
   */
  | "booking.reassigned"
  /**
   * A lead corrected the number their advisor will call, from the manage page,
   * with NO reschedule beside it (#1512). A correction made with a reschedule
   * rides that `booking.rescheduled` instead (#2164, Dan's call 2026-09-10), so
   * this is emitted by the manage page's own phone control (#1341), and by a move
   * whose correction was saved but which then failed or moved nothing (#4031).
   */
  | "booking.contact_updated"
  /**
   * Whether Slate can route a lead to an agent changed (#2085). Not a booking at
   * all, so its payload and its Regal body are a different family: a traits only
   * body keyed on the agent's email, with no event name. Sent only when the
   * DERIVED value (`isRoutable`: bookable and not deactivated) moves, from the one
   * helper that owns both writes, `src/lib/bookable/routable-write.ts`.
   */
  | "agent.bookable_changed";
export type DeliveryStatus = "pending" | "success" | "failed";

export interface Organization {
  id: string;
  name: string;
  /**
   * The single org a login resolves to (#1648). At most one row may have this
   * true, enforced by `organizations_single_default_idx` (migration 0110), so a
   * second default org is impossible rather than merely unlikely.
   */
  is_default: boolean;
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
   * The Salesforce sync planned to make this person bookable (they were moved to
   * Sales or given a first debt team) and the activation gate refused, usually
   * for a Google calendar that does not exist yet (#2071). Retried every sync
   * while set; cleared by any explicit bookable write, the sync's or a person's.
   * null = no flip is owed.
   */
  bookable_pending_since: string | null;
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
  /**
   * This person's Salesforce `User.Id`, the shared cross system key (#1587).
   *
   * Written by the hourly roster sync and NEVER cleared or overwritten: a
   * disagreement between what Salesforce says and what Slate holds is reported,
   * not rewritten, because the two ways one arises (a recreated Salesforce user,
   * or an email reassigned to a different person) need opposite corrections.
   *
   * `null` means unknown, and it is the whole reason the column is nullable. A
   * consumer must REFUSE a null rather than fall back to an email or name match
   * (L75), which is the substitution the key exists to remove. Read it only
   * through `requireSalesforceUserId` (`@/lib/salesforce/user-id-link`);
   * `scripts/test-salesforce-user-id-contract.ts` enforces that.
   */
  salesforce_user_id: string | null;
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

/**
 * #2890 (migration 0153): a window cal.com still blocks because its removal was
 * skipped while cal.com was retired. The override sweep takes it out once cal.com
 * is live and stamps `resolved_at`.
 */
export interface CalcomOverrideRemoval {
  id: string;
  request_id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  /** The removal outcome that left the block behind. */
  reason: string;
  /** The latest attempt to take it out, null until one runs. */
  last_outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * #3919 (migration 0189): one change to a Slate booking's invite that its advisor
 * made in Google Calendar, and what Slate did. Read and written only by
 * `src/lib/google/invite-move-deps.ts`; the rules are `invite-moves.ts`.
 */
export interface BookingInviteChange {
  id: string;
  booking_id: string;
  user_id: string;
  gcal_event_id: string;
  kind: "moved" | "resized";
  move_number: number | null;
  // `report_full_read` from migration 0194 (#3925).
  action: "revert" | "leave_second_move" | "leave_near_start" | "report_resize" | "report_launch" | "report_full_read";
  outcome: "reverted" | "revert_refused" | "event_gone" | null;
  outcome_detail: string | null;
  booked_starts_at: string;
  booked_ends_at: string;
  event_starts_at: string;
  event_ends_at: string;
  event_updated: string;
  detected_at: string;
}

/**
 * #3940 (migration 0191): one advisor's office day as Team capacity history saved it.
 * Written only through `record_capacity_history`; the rules are
 * `src/lib/admin/capacity-history.ts`.
 */
export interface CapacityHistoryDay {
  user_id: string;
  day: string;
  timezone: string;
  capacity: number;
  open_times: string[];
  is_out: boolean;
  no_shift: boolean;
  unsynced: boolean;
  shift_start: string | null;
  shift_end: string | null;
  time_off: { start: string; end: string }[];
  updated_at: string;
}

/**
 * #4102 (migration 0198): one booking pace reading, per org, half hour and page day. Written only
 * through `record_capacity_fill`; the rules are `src/lib/admin/capacity-fill.ts`.
 */
export interface CapacityFillReading {
  org_id: string;
  read_at: string;
  day: string;
  day_position: number | null;
  slot_of_day: number;
  weekday: number;
  prev_read_at: string | null;
  /** numeric: PostgREST returns it as a number. Null with `taken_reason`. */
  taken: number | null;
  taken_reason: "first-reading" | "too-long-since" | "too-few-comparable" | "no-capacity" | null;
  open: number;
  capacity: number;
  comparable_share: number | null;
  excluded_not_syncing: number;
  excluded_left_pool: number;
  excluded_capacity_changed: number;
  /** #4103 (migration 0199) writes these; null on a row saved before it. */
  pace_per_hour: number | null;
  pace_state: string | null;
  /** The half hour a missed pace returns, when pace_state is readings-missed. */
  pace_back_at: string | null;
  estimate_line_at: string | null;
  estimate_line_state: string | null;
  estimate_pattern_at: string | null;
  estimate_pattern_state: string | null;
  estimate_method: string | null;
  estimate_cells_fallen_back: number | null;
  /** #4190 (migration 0201): from 95%, the walk to no call open; null under 95% and before it. */
  estimate_last_line_state: string | null;
  estimate_last_line_at: string | null;
  estimate_last_pattern_state: string | null;
  estimate_last_pattern_at: string | null;
  estimate_last_method: string | null;
  created_at: string;
}

/** #4102 (migration 0198): a page day's last booking pace snapshot, moved only forward. */
export interface CapacityFillLast {
  org_id: string;
  day: string;
  read_at: string;
  snapshot: Record<string, { open: number; capacity: number; fp: string }>;
}

/** #3940 (migration 0191): how far the capacity-history lane has recorded, per org. */
export interface CapacityHistoryCursor {
  org_id: string;
  recorded_through: string;
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
  /** The row's version (#3122, migration 0161): an editor sends back the value it
   *  loaded and the write lands only while the row still holds it. */
  updated_at: string;
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

/** #2073, migration 0144: one agent's booking link token. Server only. */
export interface AgentLink {
  user_id: string;
  token: string;
  created_at: string;
  rotated_at: string | null;
  rotated_by: string | null;
}

/**
 * #3026: an advisor link's readable name (migration 0155). Reserved for good:
 * `user_id` is null once that user is deleted, and the name is never given to
 * anybody else.
 */
export interface AgentLinkName {
  name: string;
  user_id: string | null;
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
  /** Who last wrote this week (#1753, migration 0117); null = before the stamp existed. */
  hours_source: "seed" | "agent" | "admin" | "calcom-import" | null;
  hours_set_at: string | null;
  /** The week's version (#3122, migration 0161), moved by every write of the week. */
  updated_at: string;
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
  /** #3801 (0184): what a condition's last post named; null before 0184 or on a marker row. */
  subjects?: string[] | null;
  /** #3801 (0184): the last post's band, higher is worse; null when it had none. */
  band?: number | null;
  /** #3801 (0184): when the condition was first posted, for the reminder line. */
  opened_at?: string | null;
}

/** A configurable reschedule/cancel/reassign reason option (#346). Codes are the
 *  stable analytics taxonomy; `active=false` is a soft-retire; `locked` marks a
 *  system row an admin may not rename/retire ('other', 'owner_reassignment'). */
export interface ReasonOptionRow {
  action: "reschedule" | "cancel" | "reassign";
  code: string;
  label: string;
  sort_order: number;
  active: boolean;
  locked: boolean;
  /** A code only Slate itself writes (#2369, migration 0124). Never offered in a
   *  customer or admin picker; still valid for the machine paths and still rendered
   *  as a label in history. */
  system_only: boolean;
  updated_at: string;
  updated_by: string | null;
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
  /** #2739: the day the ramp ended (YYYY-MM-DD), declared on /admin/alerts. Null =
   *  not declared, so nothing is learned and the cal.com floors stay in force. */
  volume_ramp_end_on: string | null;
  /** #2739: the monitor lane's last refit of the low volume floors, as written by
   *  `runVolumeRelearn` (`StoredVolumeLearning`). Validated on every read, never
   *  trusted as typed. Null = never refit. */
  volume_learning: unknown;
  alerts_channel: string | null;
  info_channel: string | null;
  /** #575: UI arm/disarm for the low-booking-volume alert. Null = unset (fall
   *  through to env then the disarmed default). */
  low_volume_armed: boolean | null;
  /** #1313: UI arm/disarm for the booking-failure-rate page. Null = unset (fall
   *  through to env then the disarmed default, per L56's observe-first rule). */
  failure_rate_armed: boolean | null;
  /** #1315: UI arm/disarm for the availability-truth page. Null = unset (fall
   *  through to the disarmed default, per L56's observe-first rule). */
  availability_drift_armed: boolean | null;
  /** #2318: is the "waiting to become bookable" page armed? Null = disarmed. */
  awaiting_activation_armed: boolean | null;
  /** #2593: is the "booked below the lead's tier" page armed? Null = disarmed. */
  below_lead_tier_armed: boolean | null;
  /** #2090: are the Regal call alerts armed? Null = disarmed (set on /admin/alerts, #2695). */
  regal_calls_armed: boolean | null;
  /** #3227: open times inside the window a paged debt tier needs before its page
   *  may end. Null = unset (the coded 3). */
  empty_tier_recovery_min_times: number | null;
  /** #3227: minutes the tier must hold that many before the all clear. Null =
   *  unset (the coded 30). */
  empty_tier_recovery_hold_min: number | null;
  /** #3559: the nearly full pool line, in whole percent: a pool is named when
   *  fewer than this share of its starts across the days the booker shows are
   *  still open. Null = unset (the coded 10). */
  pool_nearly_full_open_pct: number | null;
  /** #1454: UI arm/disarm for the roster-coverage page. Null = unset (fall
   *  through to the disarmed default, which here is about the roster being dark
   *  before cutover rather than about calibration: see migration 0102). */
  roster_coverage_armed: boolean | null;
  /** #2367: the Slack channel booking handoffs are posted to for the sales side.
   *  Null = unset, with NO fallback to the alerts or info channel; unset while a
   *  handoff is open pages the alerts channel (migration 0123). */
  handoff_channel: string | null;
  /** #2875 (migration 0147): cal.com no longer takes bookings, so every cal.com
   *  lane is retired. NOT NULL DEFAULT false; read through
   *  `src/lib/calcom/retirement.ts`, written only by `setCalcomRetired`. */
  calcom_retired: boolean;
  /** Migration 0188: post the owner reassign notice (#2372) to the handoff
   *  channel. NOT NULL DEFAULT false; read through `loadOwnerReassignNoticeOn`,
   *  written by `setMonitorSettings`. */
  owner_reassign_notice_on: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** Single-row direct-booking config (#1015, migration 0086): the default bucket a
 *  keyed direct-booking caller falls back to when it passes no XBC. A null
 *  default_bucket_code = unset (the caller fails loud rather than guessing). */
export interface BookingSettings {
  id: number;
  default_bucket_code: string | null;
  /** #216: org-wide booking horizon in days (how far ahead leads can book).
   *  Null = unset; the resolver falls back to env then the coded default. */
  horizon_days: number | null;
  /** #3922, migration 0190: how many open days every lead is offered. NOT NULL
   *  DEFAULT 3 with a 1 to 7 check; `horizon_days` holds this plus the last resort's
   *  extra days. Read through `src/lib/booking/days-offered-load.ts`. */
  offered_open_days: number;
  /** #3936, migration 0192: the percent of a day's capacity at which Team capacity
   *  flags the day nearly full. NOT NULL DEFAULT 85 with a 1 to 99 check. Read
   *  through `readNearlyFullPct` in `src/lib/booking/settings.ts`. */
  capacity_nearly_full_pct: number;
  /** #2297: the public booking kill switch. True stops the embed's booking WRITE
   *  (availability, sync, the key-authed API, reschedule and cancel all keep
   *  running). Stored NOT NULL DEFAULT false, so a row that predates the column
   *  reads as open rather than silently holding every booking. */
  public_booking_paused: boolean;
  /** #2366, migration 0132: when `public_booking_paused` last went from false to
   *  true, or null while booking is running. Maintained by a database trigger, not
   *  by application code, because three writers reach the flag and a stamp each has
   *  to opt into is one the next writer forgets. It is NOT `updated_at`, which is
   *  shared with the other columns on this row, so editing the horizon would push
   *  the pause clock forward. */
  public_booking_paused_at: string | null;
  /** #3137, migration 0162: the frame lock. True gives the booker and every page it
   *  moves to inside its frame a `frame-ancestors` of Slate plus the allow list.
   *  NOT NULL DEFAULT false: a row that predates it frames exactly as before. */
  frame_lock_enabled: boolean;
  /** #3325, migration 0169: the shared confirm line. True puts every confirm for one
   *  time in one line shared by every isolate. NOT NULL DEFAULT false: a row that
   *  predates it confirms exactly as before. Read through the cached switch in
   *  `src/lib/booking/shared-line-switch-core.ts`. */
  shared_confirm_line: boolean;
  /** #3582, migration 0179: the go-live switch for the reroute-on-ineligibility trigger.
   *  True lets the hourly Twilio sync stamp a tier/backend demotion and, after the
   *  debounce, move the agent's lost-pool bookings. NOT NULL DEFAULT false: off until an
   *  admin turns it on, and the whole demotion lifecycle is inert while off. */
  demotion_reroute_enabled: boolean;
  /** #3706, migration 0195: the prerender switch. True lets widget.js build the booker
   *  frame, hidden, when a host page calls prerender at page load. NOT NULL DEFAULT
   *  false: a prerender is a no op until an admin turns it on. Read through
   *  `src/lib/embed/prerender-switch.ts`. */
  embed_prerender_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** #3137, migration 0162: framed booker page loads per day, framing origin and booker
 *  page. Origins only (or `self` / `unstated` / `(other)`), never a path or an id. A
 *  type alias so it satisfies the typed client's row constraint. */
export type FrameOriginDaily = {
  day: string;
  origin: string;
  surface: string;
  loads: number;
  /** Counts against the per day cap on distinct hosts; false for the fixed set of
   *  exact allow list hosts, `self`, `unstated` and `(other)`. */
  capped: boolean;
  last_seen: string;
};

/** One weekday of the org's business hours (#1294, migration 0098): gate 1 of the
 *  three booking gates. Exactly seven rows, keyed on the Luxon weekday (1 = Monday).
 *  Minutes from local midnight, in the coded org zone (never stored per row).
 *  `is_open` false closes that day, which is different from the row being absent:
 *  an EMPTY table is unconfigured and falls back to the seeded week. */
export interface BusinessHoursRow {
  weekday: number;
  is_open: boolean;
  start_minute: number;
  end_minute: number;
  updated_at: string;
  updated_by: string | null;
}

/** A specific date that overrides the weekly pattern (#1363, migration 0106). The
 *  window is null on a closed date; the table's own constraint enforces the pair. */
export interface BusinessHoursExceptionRow {
  on_date: string;
  is_open: boolean;
  start_minute: number | null;
  end_minute: number | null;
  note: string | null;
  created_at: string;
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
  /** Set once the swap COMMITTED (#758). Null means the new event was never
   *  adopted, which is what makes an abandoned intent a genuinely-lost reassign
   *  rather than one that succeeded and was later superseded. */
  swapped_at: string | null;
  lease_until: string;
  created_at: string;
}

/** What a booking handoff is waiting on a person for (#2367, migration 0123). The
 *  migration's CHECK holds the same list; `src/lib/handoffs/kinds.ts` enumerates it
 *  as values, and `scripts/test-booking-handoffs.ts` holds the two together. */
export type BookingHandoffKind = "duplicate-unresolved" | "owner-reassign-refused";

export type BookingHandoffStatus = "open" | "resolved";

/** A booking waiting on a person (#2367). At most one OPEN row per (booking_id, kind); a recurrence after a resolve is a new row. `detail`
 *  is jsonb, read back through the per kind readers in `src/lib/handoffs/kinds.ts`
 *  rather than trusted as typed. It carries no lead contact data. */
export interface BookingHandoff {
  id: string;
  booking_id: string;
  kind: BookingHandoffKind;
  detail: Record<string, unknown>;
  status: BookingHandoffStatus;
  resolved_reason: string | null;
  resolved_at: string | null;
  created_at: string;
  /** Set only once a post to the handoff channel SUCCEEDED. */
  notified_at: string | null;
  notify_attempts: number;
  /** A short human reason for the last failed post, never a raw body. */
  last_notify_error: string | null;
}

/**
 * The advisor only "previously pitched" calendar alert (#2371).
 *
 * Written BEFORE the Google event and updated with its id afterwards, so a crash
 * between the two leaves a row pointing at nothing rather than an event nothing
 * points at. At most one LIVE row (removed_at is null) per booking, enforced by a
 * partial unique index; removed rows stay as the history of who held the call.
 *
 * Carries no lead data by design, which is what keeps it outside the erasure
 * function and the Snowflake mirror (migration 0126).
 */
export interface OwnerAlertEvent {
  id: string;
  booking_id: string;
  /** The advisor whose calendar the alert is on. */
  user_id: string;
  /** Null until Google answers, and forever on a definitively refused calendar. */
  gcal_event_id: string | null;
  /** The advisor's own calendar address: the calendar written to, and the identity
   *  the write and the later removal are made as. */
  calendar_id: string;
  created_at: string;
  /** Set when the alert has been taken back off the calendar. */
  removed_at: string | null;
  /** Why Google was never touched: a `gone` or `not-provisioned` calendar. */
  skip_reason: string | null;
}

/** #2090: one received Regal `call.completed` event, under the one reason it was
 *  kept or dropped. Holds no lead data; the agent email is staff data and is set
 *  only on a candidate row. The reason vocabulary is `REGAL_CALL_REASONS`
 *  (src/lib/regal/inbound-call.ts), held equal to the migration's CHECK. */
export interface RegalCallEvent {
  id: string;
  /** Regal's top level eventId; unique. Null when the body carried none. */
  event_id: string | null;
  reason: string;
  agent_email: string | null;
  occurred_at: string | null;
  received_at: string;
}

/** #3027: one person's photo as read from the Google directory (migration 0156).
 *  No row means never read. The image columns are set exactly when state is
 *  'photo'. Read the bytes only where they are served (see advisor-photos/store). */
export interface AdvisorPhotoRow {
  user_id: string;
  state: "photo" | "none";
  bytes_b64: string | null;
  mime: "image/jpeg" | "image/png" | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  checked_at: string;
  changed_at: string;
  last_error: string | null;
  failing_since: string | null;
}

/** #2944: one completed Regal call's outcome, kept 120 days for the show rate.
 *  The lead is an external Salesforce Lead id key; no contact data. */
export interface RegalCallOutcome {
  id: string;
  /** Regal's top level eventId; unique and never null. */
  event_id: string;
  /** The lead's Salesforce Lead id, first 15 characters. */
  lead_key: string;
  started_at: string;
  talk_time_s: number;
  conversation_happened: boolean | null;
  direction: string | null;
  call_type: string | null;
  disposition: string | null;
  is_ai_agent: boolean;
  agent_email: string | null;
  received_at: string;
}

/** #2090: one person whose Regal calls are not reported while Slate does not
 *  route to them. Every entry carries its reason, who added it and when. */
export interface RegalCallIgnore {
  user_id: string;
  reason: string;
  added_by: string | null;
  added_at: string;
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
  /**
   * The approved time off this row was written for (#1464). A slate-source block
   * with no booking used to mean "orphan, free it"; the OOO fallback is a second
   * writer of exactly that shape and it is the ONLY thing blocking the window when
   * the agent's calendar event could not be created, so it needs an owner the
   * reconcile sweep and the pool-exit prune can see.
   */
  ooo_request_id: string | null;
  /** The reroute hold a `hold` block was written for (#3248); null on every other row. */
  hold_id?: string | null;
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
  /** SYNC diagnostics (#273): last error from the 1-min events.list pass. */
  last_sync_error: string | null;
  /** SYNC diagnostics (#273): consecutive failed passes; 0 when last attempt succeeded. */
  consecutive_failures: number;
  /** SYNC diagnostics (#273): last time this calendar synced cleanly. */
  last_success_at: string | null;
  /** SYNC diagnostics (#916): classification of the last failure ('gone' |
   *  'transient'), or null when the last attempt succeeded / predates #916. */
  last_failure_kind: "gone" | "not-provisioned" | "transient" | null;
  /** WATCH diagnostics (#1150): the same four facts for the ~5-min push-channel
   *  renewal lane, kept in their OWN columns. Sharing one counter let a
   *  successful sync clear a renewal failure within the minute, so a watch-only
   *  failure could never reach a paging threshold. Days-old values are NORMAL
   *  here: a healthy channel is only renewed within 3 days of its ~7-day expiry. */
  watch_consecutive_failures: number;
  watch_last_success_at: string | null;
  watch_last_error: string | null;
  watch_last_failure_kind: "gone" | "not-provisioned" | "transient" | null;
  /** HYDRATION (#1260): when a bootstrap was last ATTEMPTED, stamped before the
   *  fetch so it moves even when the fetch fails. Drives rotation fairness only.
   *  Without it, ordering by coverage lets a revoked calendar stay the oldest
   *  forever and be picked first every tick, starving the healthy ones behind it.
   *  Null means never attempted, which reads as due. */
  last_bootstrap_attempt_at: string | null;
  /** HYDRATION (#1260): the `timeMax` ACTUALLY SENT on the last SUCCESSFUL
   *  bootstrap, so it can only ever describe a request that really happened.
   *  Authorizes the out-of-window prune (#1265) and feeds the coverage alert
   *  (#1262). Null means no coverage has been established, never "covered up to
   *  the default window": every reader maps null to the fail-safe side. */
  sync_window_to: string | null;
  created_at: string;
}

/** #2073: how a booking was made. See `Booking.kind`. */
export type BookingKind = "routed" | "agent_link";

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
  /** The first name the lead answered (#2549, migration 0145); null for every row
   *  made before it, and for a caller that sends one name. Never a split. */
  attendee_first_name: string | null;
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
  /**
   * Where the booking came from (#2072): the page named by the link's `source`,
   * or `not-given` (the link carried none) or `unrecognised` (it named a page
   * Slate does not know). NULL for a booking made before sources were recorded,
   * which is a different fact from `not-given`. See booking-source.ts.
   */
  source: BookingSource | null;
  /**
   * The origin (never the path) of the page that framed the booker (#2728), from
   * `document.referrer`, reduced on the server by `readReferrerOrigin`. Judged
   * beside `prefill.parentOrigin` by the off site check. NULL when the booker was
   * not framed, the referrer was stripped, the booking came through the API or an
   * admin, or it predates the column.
   */
  referrer_origin: string | null;
  /**
   * Whether the booking was ROUTED through a bucket pool or booked through an
   * agent's own named link (#2073, migration 0144). Every reader that reasons
   * about routed bookings (the volume alarms, the per page volume, the bucket
   * share ranking) filters on it; the named booking still sits in a bucket only
   * because bucket_id is NOT NULL and the event type is the bucket's.
   */
  kind: BookingKind;
  /**
   * The appointment START a 24 hour reminder email has been sent about (#2359).
   *
   * A TIMESTAMP rather than a flag, so a booking that moves earns a fresh reminder
   * for its new time with nobody clearing anything: the stored value simply stops
   * matching `starts_at`. Null means none sent. Written BEFORE the send, so a crash
   * between the two costs a reminder rather than delivering a second copy.
   */
  reminder_sent_for: string | null;
  /** Set ONLY by the reassign API to stack a consult onto a busy owning agent. */
  allow_double_book: boolean;
  /** Monotonic count of COMMITTED reschedules (#439, migration 0053). Mixed into
   *  the deterministic reschedule event id so an oscillating reschedule can't
   *  reuse a tombstoned Google id. 0 for a never-rescheduled booking. */
  reschedule_seq: number;
  /**
   * The booking that REPLACED this one (#3672, migration 0200): set only when the
   * booking API moved the call to another bucket (`moveToRequestedBucket`), which
   * makes a new booking under a new token and cancels this one. Written in the same
   * statement as the cancel, so a cancelled row never lacks it and a live one never
   * has it. The manage page, the calendar file and the rebook route follow it, so a
   * link the lead already holds opens the call they still have. Null on every other
   * booking, including one cancelled any other way.
   */
  replaced_by_booking_id: string | null;
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
  /** The tier the booker had on show for the requested code when the lead
   *  confirmed (the `shownTier` it handed back, #3495, else `deps.displayedTier`),
   *  so a drop can be told apart as "the
   *  lead's tier had times on show and lost the last one at confirm" or "the
   *  lead's tier had no times at all" (2026-10-02). Null when the read found
   *  nothing or failed; absent on bookings made before it was recorded. */
  displayed_tier?: string | null;
  /** Where the routed code came from (#2638): the link, the lead's Salesforce
   *  XBC, or the catch-all with the reason Salesforce could not supply one.
   *  Written only by the booker's confirm; absent means nobody said. */
  code_source?: RoutingCodeRecord;
  /** #2281: advisors this confirm was first given whose insert lost the overlap
   *  race (#2274), in the order tried, before `chosen_user_id` took the booking.
   *  From the rung it booked and, since #3338, from rungs above it it walked down
   *  from. Absent when the first choice won. */
  race_lost?: string[];
  /** #3338: the confirm dropped a rung BEHIND other confirms for the same time:
   *  `race` when it walked down after losing the insert race on a rung above,
   *  `line` when it waited in the slot's confirm line while the ones ahead of it
   *  booked and then dropped, `claimed` (#3489 step 3) when it walked past a rung
   *  whose free advisors other confirms in flight held. Absent for any other booking, so each branch is
   *  counted apart among the drops on /admin/routing (`tier-drop-counts.ts`). */
  dropped_behind?: "race" | "line" | "claimed";
  /** #3247: one entry per bucket correction, holding the values the top level
   *  carried BEFORE it, so the original routing is never lost when the trace is
   *  rewritten to name the corrected bucket. Written only by reassign_booking_swap. */
  reroutes?: RoutingReroute[];
}

/** The routing a bucket correction replaced (#3247), plus where it went. */
export interface RoutingReroute {
  bucket_code: string | null;
  bucket_id: string | null;
  requested_tier: string | null;
  booked_tier: string | null;
  tier_fallback: boolean | null;
  rungs_dropped: number | null;
  to_bucket_code: string;
  requested_code: string;
  /** True when the agent did not change (only the bucket was corrected). */
  kept: boolean;
  at: string;
}

/**
 * A reroute hold (#3247, migration 0166): an advisor held at a booking's own
 * buffered window for five minutes while an admin confirms a bucket correction.
 * Its own table, never a bookings row, so no booking reader ever sees one.
 */
export interface RerouteHold {
  id: string;
  org_id: string;
  booking_id: string;
  agent_user_id: string;
  buffered_starts_at: string;
  buffered_ends_at: string;
  booking_starts_at: string;
  booking_ends_at: string;
  reschedule_seq: number;
  requested_bucket_id: string;
  target_bucket_id: string;
  rungs_dropped: number;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  consumed_at: string | null;
  result: Record<string, unknown> | null;
}

/** One rung of a refused confirm's ladder, as stored (#3272). Null is "not reached". */
export interface RoutingStageCount {
  code: string;
  members: number | null;
  read: number | null;
  claimed: number | null;
  checked: number | null;
  stage: string;
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
  /** The `xbc` the lead's link carried, or null when the caller did not say
   *  (#1908). An empty string means the lead arrived with no code at all, which
   *  is the defect being measured; null means nobody told us either way. */
  requested_code: string | null;
  /** Whether the catch-all routed this lead to the Low pool because their code
   *  was blank or unreadable (#1908). A rescued lead and one who genuinely asked
   *  for Low share a bucket, so only this tells them apart. */
  catchall_applied: boolean;
  tier_fallback: boolean;
  rungs_dropped: number;
  /** #3272 (migration 0168), on a refused confirm only: the instant the lead asked
   *  for, the stage that refused it, and per rung what each stage left. */
  requested_start: string | null;
  refusal_stage: RecordedRefusalStage | null;
  stage_counts: RoutingStageCount[] | null;
  /** The refused lead's Salesforce lead id in its 15 character form (#3276), so a
   *  volume of refusals can be counted in people. Null when the request named none. */
  lead_id: string | null;
  /** #3797 (migration 0186), on a judged `candidate_read_empty` refusal only: whether it
   *  was a proven lost race, the list stamp it was judged against, and the codes whose
   *  stored row still offered the refused time (the row proofs). Null otherwise. */
  offer_verdict: "race" | "stale_offer" | "unknown" | null;
  served_computed_at: string | null;
  stale_row_codes: string[] | null;
  /** `rerouted` (#3247, migration 0166) is an admin correcting a booking's bucket:
   *  its own outcome, so the monitors counting `booked` as bookings never count one
   *  booking twice. */
  outcome: "booked" | "no_availability" | "no_eligible_agents" | "error" | "rerouted";
  created_at: string;
}

/** What a booking_events row records. */
export type BookingEventAction = "rescheduled" | "cancelled" | "reassigned" | "bucket_corrected";
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
  /** A bucket correction (#3247, migration 0166): the bucket the booking left and
   *  the one it landed in. Null on every other action. No foreign key, because the
   *  table is append only and a SET NULL on bucket delete would raise. */
  from_bucket_id?: string | null;
  to_bucket_id?: string | null;
  created_at: string;
}

export type WebhookFormat = "generic" | "regal";

export interface WebhookEndpoint {
  id: string;
  org_id: string;
  url: string;
  /** Null since migration 0163 (#3091): the signing secret is the Worker secret WEBHOOK_SIGNING_SECRET. */
  secret: string | null;
  events: WebhookEvent[];
  format: WebhookFormat;
  /** Null since migration 0163 (#3091): the Regal key is the Worker secret REGAL_WEBHOOK_KEY. */
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
  /** Position in the #3090 hash chain, 1, 2, 3, ... Set by the trigger, never by a caller. */
  chain_seq: number;
  /** SHA-256 hex of the previous row's chain_hash plus this row's content. Set by the trigger. */
  chain_hash: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  last_response: string | null;
  /** Recorded but never POSTed (is_test bucket booking, #459). No send path may deliver it. */
  suppressed: boolean;
  /** The stored payload's contact data has been erased (#1140, migration 0088). The
   *  column has existed since then; it was missing from this interface until #2369,
   *  which is invisible while nothing checks a select's column list against it. */
  payload_erased: boolean;
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
  /** When a settings save last marked this row stale (#3118, migration 0161). */
  invalidated_at: string | null;
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
  /**
   * #2440: on a `done` step whose side effect was deliberately NOT performed, why.
   * Absent on a step that did its work. Kept in the existing jsonb, so it needs no
   * migration, and it survives an erasure, which clears only `error` (0093).
   */
  withheld?: string | null;
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
  /**
   * The email of the agent the booking was assigned to BEFORE a reassign
   * (#2368), captured at enqueue time because by the time the NOTIFY step runs
   * the booking row already holds the new agent. Absent on a row enqueued before
   * this field existed, which the payload carries through as null rather than
   * guessing at somebody.
   */
  fromAgentEmail?: string | null;
  /** Staff user accountable for an admin action (#549); carried so the drained
   *  history-write step records it even on a crash-resume. */
  actorUserId?: string | null;
  /** The user an admin acted AS via impersonation (#549). */
  actingAsUserId?: string | null;
  /** A reroute move's bucket before and after (#3249), for the history row. Absent
   *  on a plain reassign, which changes no bucket. */
  fromBucketId?: string | null;
  toBucketId?: string | null;
  /**
   * The number a reschedule's own contact correction replaced (#2164, #4031),
   * present only when the move really changed the lead's phone. The NOTIFY step puts
   * it on the `booking.rescheduled` payload, which is what tells Regal to name the
   * new number primary and subscribed. Carried here because the booking row already
   * holds the new number by the time that step (or a drain re-run of it) reads it.
   */
  previousAttendeePhone?: string | null;
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
  /** The first name the lead answered (#2549, migration 0145); null for every row
   *  made before it, and for a caller that sends one name. Never a split. */
  attendee_first_name: string | null;
  attendee_email: string | null;
  attendee_phone: string | null;
  prefill: Record<string, string>;
  gcal_event_id: string;
  manage_token: string;
  idempotency_key: string | null;
  external_id: string | null;
  /** Null on a named link booking (#2073): nothing was routed, so there is no
   *  trace to record, and a fabricated one would read as a routing decision. */
  routing_trace: RoutingTrace | null;
  /** #2073: routed, or booked through an agent's own named link. */
  kind: BookingKind;
  /** #2072: always written by createBooking, read off the link on the server. */
  source: BookingSource;
  /** #2728: always written by createBooking, reduced on the server; null when the
   *  booker sent no framing page. */
  referrer_origin: string | null;
};

/** The calendar-event input, captured in a reservation so a resume re-creates
 *  the SAME event (with the pinned client id) without re-deriving it. */
export interface ReservationEventInput {
  summary: string;
  description: string;
  /**
   * #3376: the invite's location, the lead's phone as stored. Optional because a
   * reservation written before it existed has none, and the drain must resume
   * that row rather than refuse it.
   */
  location?: string | null;
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
  /**
   * The `xbc` the lead's link carried, when the caller knew it (#1908). Carried
   * on the RESERVATION rather than read from the request, because a booking the
   * drain resumes after a crash has no request left to read, and it should still
   * be recorded as a rescued lead.
   *
   * Optional: rows written before this field existed do not have it, and the
   * drain must resume those rather than refuse them.
   */
  requestedCode?: string;
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

/** #418: a daily tally of direct-booking-API outcomes, keyed by
 *  (day, outcome, bucket_code, error_code). Written by the bump RPC, read
 *  aggregated by the mix RPC. Server-only (RLS default-deny). */
export interface BookingApiOutcomeDaily {
  id: string;
  day: string;
  outcome: string;
  bucket_code: string;
  error_code: string;
  /**
   * #1616, migration 0108: whether the attempt was the smoke canary's rather than
   * a customer's. Decided at the point of recording from the bucket it belongs to,
   * because the manage-token reschedule path records an EMPTY bucket_code and so
   * cannot be identified by one. Part of the row's unique key.
   */
  is_test: boolean;
  /**
   * #2752, migration 0143: the host page the attempt came from, judged at the
   * point of recording by `bookingHostClass` (the off site page's own predicate).
   * `offsite` attempts are left out of the failure rate; rows written before 0143
   * read `none`, which still counts. Part of the row's unique key.
   */
  host_class: "production" | "offsite" | "none";
  count: number;
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

/** Which host each booking API caller last authenticated from (#2717, migration
 *  0140). One row per (caller, host_kind); the shape and its vocabulary live with
 *  the code that writes and judges it. */
export type { CallerSeenRow as ApiCallerSeen } from "@/lib/booking/caller-seen";
export type { PilotOfferRow as PilotOfferSample } from "@/lib/monitor/pilot-offers";
export type { PilotSettingsRow as PilotSettingsSample } from "@/lib/monitor/pilot-settings-samples";

/** The texting line each lead was given after Call me now (#3718, migration 0183):
 *  one row per lead, keyed on the 15 character Lead id. */
export interface LeadTextingLine {
  lead_key: string;
  line: string;
  given_at: string;
  replaced_at: string | null;
}

/** Dead-man's switch heartbeat (#420): one row per cron lane, stamped each tick. */
export interface LaneHeartbeat {
  lane: string;
  last_ran_at: string;
}

/** The rolling failure-rate window (#1313, migration 0099). ONE row: the last
 *  reading of the daily tally (the baseline the next delta is measured against,
 *  carrying its ET `day` so the midnight counter reset is detectable) plus
 *  `samples`, the window of per-interval deltas the page is judged on. */
export interface BookingFailureRateState {
  key: string;
  day: string;
  attempts: number;
  failures: number;
  by_code: Record<string, number>;
  /** #1442/#1450/#1709, migration 0113: the cumulative self-inflicted refusal
   *  counts from the last reading, which is the baseline the next tick
   *  differences against. Never part of the booking failure share. */
  refusals: Record<string, number>;
  samples: {
    atMs: number;
    attempts: number;
    failures: number;
    byCode: Record<string, number>;
    /** Optional: a sample written before 0113 has none, which reads as "not
     *  measured in that interval", not as zero refusals. */
    refusals?: Record<string, number>;
    /** The reminder lane's row only: bookings released to be retried, by id, with
     *  the code each failed with. Optional, so older samples read as none. */
    retried?: Record<string, string>;
    /** The reminder lane's row only: how a booking handed back earlier in the
     *  window ended, `sent` or `kept`. Optional, so older samples read as none. */
    settled?: Record<string, string>;
    /** The booking lane's row only (#3275): a page (`live`) went out on this tick.
     *  Optional, so older samples read as nobody told. */
    told?: "live";
  }[];
  updated_at: string;
}

/** Where the monitor lane's audit_log hash chain walk is (#3090, migration 0160).
 *  One row. `pass_*` is how far the current walk from the start has got, and
 *  `anchor_*` the furthest row a complete walk has verified, with its hash then. */
export interface AuditLogChainVerify {
  singleton: boolean;
  pass_seq: number;
  pass_hash: string;
  anchor_seq: number;
  anchor_hash: string;
  last_full_pass_at: string | null;
  updated_at: string;
}

/** Rotating scan offset for a bounded self-heal sweep (#512): one row per sweep,
 *  advanced across ticks so the scan eventually covers rows past the first page. */
export interface SelfhealScanCursor {
  key: string;
  next_offset: number;
  updated_at: string;
}

/** Resumable watermark for the Snowflake export lane (#1098, migration 0090).
 *  `key` is the scope (bare table name for the incremental lane, a
 *  'backfill:<table>' prefix for the backfill lane). `last_ts` is the last
 *  exported created_at (append-only tables) or updated_at (mutable tables), with
 *  `last_id` as the tie-break at that timestamp. Both null before the first
 *  export. */
export interface ExportCursor {
  key: string;
  last_ts: string | null;
  last_id: string | null;
  updated_at: string;
}

/**
 * A sweep's lifecycle. `cancelled` (#1665) is terminal exactly as `done` is, and
 * separate from it on purpose: `done` means every item reached an outcome,
 * `cancelled` means the time off that caused the sweep was cancelled or narrowed
 * and the remaining appointments must not move. Only `active` is ever drained.
 */
export type BulkReassignJobStatus = "active" | "done" | "cancelled";

/** One bulk coverage-reassign sweep (#973, #562): move every active upcoming
 *  booking assigned to `out_user_id` in [range_start, range_end) onto a
 *  live-verified covering agent. `range_end` null = open-ended (now onward).
 *  Server-only (RLS default-deny). */
export interface BulkReassignJob {
  id: string;
  org_id: string;
  out_user_id: string;
  range_start: string;
  range_end: string | null;
  reason_code: string;
  reason_detail: string | null;
  status: BulkReassignJobStatus;
  created_by: string | null;
  acting_as_user_id: string | null;
  /** The approved time-off request that triggered this sweep (#1235); NULL for an
   *  admin-initiated one. Unique per (request, window), so a re-approval of a
   *  changed window may sweep again but the same window never twice. */
  ooo_request_id: string | null;
  /** The offboarding deactivation that triggered this sweep (#1241): the agent's
   *  `deactivated_at` at the moment the lifecycle API deactivated them. NULL for a
   *  sweep a person started or one an approved time-off request caused. Unique per
   *  (agent, deactivation), so a retried or concurrent offboarding call converges
   *  on one sweep. Also the record of WHY such a job has no `created_by`: it has no
   *  human actor and its moves are recorded as system-initiated. */
  offboarding_deactivated_at: string | null;
  /** The Twilio redistribute pool exit that triggered this sweep (#2115): the
   *  moment the hourly roster sync marked the agent, stored on their own
   *  `attributes.redistribute_at` in the same write. NULL for every other sweep.
   *  Unique per (agent, mark), so a sync that crashed mid flip converges on one
   *  sweep. Also the record of WHY such a job has no `created_by`. */
  redistribute_marked_at: string | null;
  /** The Twilio tier/pool demotion that triggered this sweep (#3582): the moment the
   *  hourly roster sync recorded the agent lost eligibility a held booking needs,
   *  stored on their own `attributes.demotion_marked_at` in the same write as the
   *  narrowed tiers. NULL for every other sweep. Unique per (agent, demotion), so a
   *  retried or crashed sync converges on one sweep, and the record of WHY such a job
   *  has no `created_by`. */
  demotion_marked_at: string | null;
  /** What that demotion changed (#3615, migration 0180): the debt tiers and backend held
   *  before (saved with the mark) and the ones the sweep acted on. NULL for any other sweep, or
   *  for a demotion whose earlier tiers were never saved. */
  demotion_change: DemotionChange | null;
  created_at: string;
  updated_at: string;
}

export type BulkReassignItemStatus =
  | "pending"
  | "moved"
  | "unplaceable"
  | "skipped"
  | "failed"
  /** Still waiting to move when the time off was cancelled (#1665), so it never
   *  moved and the appointment stays where it was. Distinct from `skipped`, which
   *  is a fact about the BOOKING (cancelled or completed before we got to it)
   *  rather than about the sweep. */
  | "cancelled";

/** One booking to move within a bulk-reassign job (#973). `target_user_id` is the
 *  covering agent once moved; `detail` explains an unplaceable/skipped/failed
 *  outcome. UNIQUE(job_id, booking_id) makes item creation idempotent. */
export interface BulkReassignItem {
  id: string;
  job_id: string;
  booking_id: string;
  status: BulkReassignItemStatus;
  target_user_id: string | null;
  detail: string | null;
  attempts: number;
  /** When an admin moved this call back to the sweep's original advisor (#3615, migration
   *  0181); null until then. Optional on the type because rows read before 0181 lack it. */
  reverted_at?: string | null;
  /** The admin who moved it back (#3615); null until then. */
  reverted_by?: string | null;
  created_at: string;
  updated_at: string;
}
