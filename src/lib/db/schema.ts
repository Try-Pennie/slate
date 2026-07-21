/**
 * Minimal `Database` generic for the typed Supabase client. Rows come from our
 * hand-written types; Insert/Update are permissive partials (generated columns
 * are optional). Replace with `supabase gen types typescript` once linked.
 */
import type {
  AgentCalendar,
  AlertState,
  AuditEntry,
  AvailabilityRule,
  AvailabilitySchedule,
  Booking,
  BookingEvent,
  BookingOutbox,
  BookingReservation,
  BookingApiOutcomeDaily,
  Bucket,
  BucketMember,
  BucketSlotsRow,
  BulkReassignItem,
  BulkReassignJob,
  BusyBlock,
  EventType,
  LaneHeartbeat,
  SelfhealScanCursor,
  MonitorAlertConfig,
  MonitorSettings,
  OooRequest,
  Organization,
  PendingEventDeletion,
  RateLimit,
  ReassignIntent,
  RescheduleLock,
  RoutingDecision,
  RoutingTrace,
  SyncLock,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from "@/lib/db/types";

// PostgREST embed relationship (#354): the same shape postgrest-js's
// GenericRelationship expects. Hand-declared per table (in the FK-holder table)
// so nested `.select()` embeds are type-checked instead of cast through unknown.
type Relationship = {
  foreignKeyName: string;
  columns: string[];
  isOneToOne?: boolean;
  referencedRelation: string;
  referencedColumns: string[];
};

// Intersecting with Record<string, unknown> gives our interfaces the implicit
// index signature postgrest-js's GenericTable requires (interfaces lack one),
// while keeping named columns for `.select()` results and insert payloads.
// `Rels` carries this table's embed relationships (default none).
type Table<Row, Rels extends Relationship[] = []> = {
  Row: Row & Record<string, unknown>;
  Insert: Partial<Row> & Record<string, unknown>;
  Update: Partial<Row> & Record<string, unknown>;
  Relationships: Rels;
};

export interface Database {
  public: {
    Tables: {
      organizations: Table<Organization>;
      users: Table<User>;
      event_types: Table<EventType>;
      buckets: Table<
        Bucket,
        [
          {
            foreignKeyName: "buckets_event_type_id_fkey";
            columns: ["event_type_id"];
            isOneToOne: false;
            referencedRelation: "event_types";
            referencedColumns: ["id"];
          },
        ]
      >;
      bucket_members: Table<BucketMember>;
      availability_schedules: Table<AvailabilitySchedule>;
      availability_rules: Table<
        AvailabilityRule,
        [
          {
            foreignKeyName: "availability_rules_schedule_id_fkey";
            columns: ["schedule_id"];
            isOneToOne: false;
            referencedRelation: "availability_schedules";
            referencedColumns: ["id"];
          },
        ]
      >;
      busy_blocks: Table<BusyBlock>;
      bookings: Table<Booking>;
      booking_events: Table<BookingEvent>;
      ooo_requests: Table<OooRequest>;
      webhook_endpoints: Table<WebhookEndpoint>;
      webhook_deliveries: Table<WebhookDelivery>;
      alert_state: Table<AlertState>;
      agent_calendars: Table<AgentCalendar>;
      audit_log: Table<AuditEntry>;
      sync_locks: Table<SyncLock>;
      rate_limits: Table<RateLimit>;
      reschedule_locks: Table<RescheduleLock>;
      reassign_intents: Table<ReassignIntent>;
      bucket_slots: Table<BucketSlotsRow>;
      pending_event_deletions: Table<PendingEventDeletion>;
      booking_outbox: Table<BookingOutbox>;
      booking_reservations: Table<BookingReservation>;
      booking_api_outcome_daily: Table<BookingApiOutcomeDaily>;
      routing_decisions: Table<RoutingDecision>;
      lane_heartbeats: Table<LaneHeartbeat>;
      selfheal_scan_cursor: Table<SelfhealScanCursor>;
      bulk_reassign_jobs: Table<BulkReassignJob>;
      bulk_reassign_items: Table<
        BulkReassignItem,
        [
          {
            foreignKeyName: "bulk_reassign_items_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "bulk_reassign_jobs";
            referencedColumns: ["id"];
          },
        ]
      >;
      monitor_settings: Table<MonitorSettings>;
      monitor_alert_config: Table<MonitorAlertConfig>;
    };
    Views: Record<string, never>;
    Functions: {
      /** The full set of migration versions this database has applied, as the repo's
       *  NNNN prefixes (#516, #814, migration 0072). PostgREST cannot see the
       *  supabase_migrations schema, so the prod lag check reads it through this
       *  SECURITY DEFINER function and diffs it against the shipped set to catch a
       *  migration missing from the middle, not just a trailing one. */
      applied_migration_versions: {
        Args: Record<string, never>;
        Returns: string[] | null;
      };
      /** #832: per-agent, per-local-day booking count for the daily cap. Returns a
       *  jsonb map "<user_id>|<YYYY-MM-DD>" -> count (a single row, so it never hits
       *  PostgREST's 1000-row SETOF cap). Caller passes each agent's tz. */
      count_bookings_per_local_day: {
        Args: {
          p_user_ids: string[];
          p_tz_by_user: Record<string, string>;
          p_from: string;
          p_to: string;
        };
        Returns: Record<string, number> | null;
      };
      /** #418: atomic per-call increment of the booking-API outcome tally
       *  (INSERT ... ON CONFLICT DO UPDATE count + 1). */
      bump_booking_api_outcome: {
        Args: { p_day: string; p_outcome: string; p_bucket: string; p_error_code: string };
        Returns: undefined;
      };
      /** #418: the aggregated outcome mix over [p_since, today] as a single jsonb
       *  row ({ by_outcome, by_error }) so it never hits the 1000-row SETOF cap. */
      booking_api_outcome_mix: {
        Args: { p_since: string };
        Returns: { by_outcome?: Record<string, number>; by_error?: Record<string, number> } | null;
      };
      rate_limit_hit: {
        Args: { p_key: string; p_window_seconds: number; p_max: number };
        Returns: boolean;
      };
      rate_limit_refund: {
        Args: { p_key: string };
        Returns: undefined;
      };
      move_busy_block: {
        Args: {
          p_booking_id: string;
          p_user_id: string;
          p_starts_at: string;
          p_ends_at: string;
        };
        Returns: undefined;
      };
      reassign_booking_swap: {
        Args: {
          p_booking_id: string;
          p_user_id: string;
          p_agent_name: string | null;
          p_agent_email: string;
          p_gcal_event_id: string;
          p_routing_trace: RoutingTrace;
          /** Which reassign_intents row the swap stamps with the replaced event +
           *  swapped_at, in its own transaction (#759, migration 0069). */
          p_gcal_client_id: string;
        };
        Returns: {
          prev_gcal_event_id: string | null;
          prev_agent_email: string | null;
          updated: boolean;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
