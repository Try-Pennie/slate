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
  BookingHandoff,
  OwnerAlertEvent,
  RegalCallEvent,
  BookingOutbox,
  BookingReservation,
  BookingApiOutcomeDaily,
  BookingSettings,
  BusinessHoursRow,
  BusinessHoursExceptionRow,
  Bucket,
  BucketMember,
  BucketSlotsRow,
  BulkReassignItem,
  BulkReassignJob,
  BusyBlock,
  EventType,
  LaneHeartbeat,
  SelfhealScanCursor,
  BookingFailureRateState,
  ExportCursor,
  MonitorAlertConfig,
  MonitorSettings,
  ReasonOptionRow,
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
      // The low-volume monitor embeds the bucket to exclude the smoke canary's
      // bookings (#1258); a booking is a test booking when its bucket is one, so
      // that count is an inner join rather than a column predicate.
      bookings: Table<
        Booking,
        [
          {
            foreignKeyName: "bookings_bucket_id_fkey";
            columns: ["bucket_id"];
            isOneToOne: false;
            referencedRelation: "buckets";
            referencedColumns: ["id"];
          },
        ]
      >;
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
      booking_handoffs: Table<BookingHandoff>;
      owner_alert_events: Table<OwnerAlertEvent>;
      regal_call_events: Table<RegalCallEvent>;
      bucket_slots: Table<BucketSlotsRow>;
      pending_event_deletions: Table<PendingEventDeletion>;
      booking_outbox: Table<BookingOutbox>;
      booking_reservations: Table<BookingReservation>;
      booking_api_outcome_daily: Table<BookingApiOutcomeDaily>;
      booking_failure_rate_state: Table<BookingFailureRateState>;
      // The embed is what lets the catch-all rate exclude the smoke canary's own
      // bookings (#1908): `routing_decisions` has no is_test column, so test-ness
      // is a property of the BUCKET and has to be reached through the join.
      routing_decisions: Table<
        RoutingDecision,
        [
          {
            foreignKeyName: "routing_decisions_bucket_id_fkey";
            columns: ["bucket_id"];
            isOneToOne: false;
            referencedRelation: "buckets";
            referencedColumns: ["id"];
          },
        ]
      >;
      lane_heartbeats: Table<LaneHeartbeat>;
      selfheal_scan_cursor: Table<SelfhealScanCursor>;
      export_cursor: Table<ExportCursor>;
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
      reason_options: Table<ReasonOptionRow>;
      booking_settings: Table<BookingSettings>;
      business_hours: Table<BusinessHoursRow>;
      business_hours_exceptions: Table<BusinessHoursExceptionRow>;
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
       *  (INSERT ... ON CONFLICT DO UPDATE count + 1). `p_is_test` (#1616,
       *  migration 0108) marks the smoke canary's own attempts; it is part of the
       *  conflict target, so a test row and a real one never collapse into one. */
      bump_booking_api_outcome: {
        Args: {
          p_day: string;
          p_outcome: string;
          p_bucket: string;
          p_error_code: string;
          p_is_test: boolean;
        };
        Returns: undefined;
      };
      /** #418: the aggregated outcome mix over [p_since, today] as a single jsonb
       *  row ({ by_outcome, by_error }) so it never hits the 1000-row SETOF cap.
       *  `p_include_test` (#1616) defaults to false in the database as well, so the
       *  safe direction is what a forgetful caller gets; `test_total` always counts
       *  the window's test attempts, so a panel that hides them can say how many. */
      booking_api_outcome_mix: {
        Args: { p_since: string; p_include_test?: boolean };
        Returns: {
          by_outcome?: Record<string, number>;
          by_error?: Record<string, number>;
          test_total?: number;
        } | null;
      };
      /** #990/#989: how often each reason has been picked since p_since. Returns a
       *  jsonb map "<action>|<reason_code>" -> count (a single row, so it never hits
       *  PostgREST's 1000-row SETOF cap). Shared by the retire-guard hint and report. */
      reason_usage_counts: {
        Args: { p_since: string };
        Returns: Record<string, number> | null;
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
      /** Replaces a schedule's weekly rules in ONE transaction (#1293, migration
       *  0097), so a failure cannot leave an agent with no rules and therefore no
       *  availability. Refuses an empty set in the database, not just in the
       *  caller. Returns how many rules landed, so the caller can refuse to claim
       *  success on a count it did not ask for. */
      replace_availability_rules: {
        Args: {
          p_schedule_id: string;
          p_rules: { weekday: number; start_minute: number; end_minute: number }[];
          /** Who is writing (#1753, migration 0117): seed, agent, admin or
           *  calcom-import. Required, so an unstamped week cannot be written. */
          p_source: "seed" | "agent" | "admin" | "calcom-import";
        };
        Returns: number;
      };
      /** Replaces an agent's timezone AND their whole week in ONE transaction
       *  (#2002, migration 0129). The zone used to be upserted separately and
       *  committed on its own, so a failed rules write left the new zone over the
       *  old hours and moved every bookable hour by the offset between them. It
       *  resolves the schedule row by user, then goes through
       *  `replace_availability_rules`, so there is still one place that replaces a
       *  week. `p_expected` is checked inside the transaction, because a count
       *  compared by the caller can only be compared once the write has committed. */
      replace_user_schedule: {
        Args: {
          p_user_id: string;
          p_timezone: string;
          p_rules: { weekday: number; start_minute: number; end_minute: number }[];
          p_source: "seed" | "agent" | "admin" | "calcom-import";
          p_expected: number;
        };
        Returns: number;
      };
      /** Every SECURITY DEFINER function in `public` with whether the two web roles hold
       *  EXECUTE on it (#2447, migration 0130). The repository guard cannot see a grant made
       *  by hand or a function defined in no migration, so the monitor lane asks the
       *  database. Returns rows, never a verdict: which functions are excused, and on what
       *  grounds, is decided in `src/lib/monitor/definer-grants.ts`. */
      definer_function_web_grants: {
        Args: Record<string, never>;
        Returns: {
          name: string;
          args: string;
          returns: string;
          anon_execute: boolean;
          authenticated_execute: boolean;
        }[];
      };
      /** Replaces a bucket's manual members in ONE transaction (#1930, migration
       *  0114), so a failure cannot leave a routing pool with nobody in it while
       *  the save reads as done. Unlike `replace_availability_rules` it does NOT
       *  refuse an empty set: a bucket with no manual members routes by attribute
       *  criteria instead, which is the ordinary case. Returns how many members
       *  landed, deduplicated, so the caller can refuse to claim success on a
       *  count it did not ask for. */
      replace_bucket_members: {
        Args: {
          p_bucket_id: string;
          p_user_ids: string[];
        };
        Returns: number;
      };
      /**
       * Decide whether a named booking is really a duplicate and, when it is, cancel
       * it and enqueue its cancel outbox row in ONE transaction (#2369, migration
       * 0124). Checking and cancelling as two steps could leave a lead with no call
       * at all, and the loaders the route would otherwise reach swallow a read error
       * to null, which on this path reads as "this lead has no other call".
       *
       * Returns a single jsonb object, never a row set, so it can never meet
       * PostgREST's 1000 row cap. `outcome` is one of the words
       * `src/lib/booking/duplicate-cancel.ts` enumerates; `outboxId` is present only
       * on a cancel. A reply that does not read as that shape is a 503, never an
       * outcome.
       */
      cancel_duplicate_booking: {
        Args: {
          p_booking_id: string;
          /** The instant "upcoming" and "already started" are judged against, passed
           *  in rather than read from the database clock so a test can pin it. */
          p_now: string;
        };
        Returns: {
          outcome: string;
          outboxId?: string | null;
          candidateIds?: string[];
          weakerMatch?: string | null;
        } | null;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
