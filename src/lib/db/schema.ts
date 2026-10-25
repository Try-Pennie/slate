/**
 * Minimal `Database` generic for the typed Supabase client. Rows come from our
 * hand-written types; Insert/Update are permissive partials (generated columns
 * are optional). Replace with `supabase gen types typescript` once linked.
 */
import type {
  ClaimRerouteHoldRefusal,
  PlaceRerouteHoldRefusal,
  RerouteSwapRefusal,
} from "./reroute-hold-refusals";
import type {
  CalcomOverrideRemoval,
  BookingInviteChange,
  CapacityHistoryCursor,
  CapacityFillLast,
  CapacityFillReading,
  CapacityHistoryDay,
  AgentCalendar,
  AgentLink,
  AgentLinkName,
  AlertState,
  ApiCallerSeen,
  FrameOriginDaily,
  PilotOfferSample,
  PilotSettingsSample,
  LeadTextingLine,
  AuditEntry,
  AvailabilityRule,
  AvailabilitySchedule,
  Booking,
  BookingEvent,
  BookingHandoff,
  OwnerAlertEvent,
  RegalCallEvent,
  RegalCallOutcome,
  AdvisorPhotoRow,
  RegalCallIgnore,
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
  AuditLogChainVerify,
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
  RerouteHold,
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
      agent_links: Table<AgentLink>;
      agent_link_names: Table<AgentLinkName>;
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
          {
            // #3304: the reconcile missing sweep embeds the assigned agent to skip
            // a booking whose agent has left the pool (migration 0004 names it).
            foreignKeyName: "bookings_assigned_user_id_fkey";
            columns: ["assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ]
      >;
      booking_events: Table<BookingEvent>;
      ooo_requests: Table<OooRequest>;
      calcom_override_removals: Table<CalcomOverrideRemoval>;
      /** #3919 (migration 0189): invite changes an advisor made in Google Calendar. */
      booking_invite_changes: Table<BookingInviteChange>;
      /** #3940 (migration 0191): Team capacity history, one row per advisor and office day. */
      capacity_history: Table<
        CapacityHistoryDay,
        [
          {
            // #3940: a saved day is read back with its advisor's name and org.
            foreignKeyName: "capacity_history_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ]
      >;
      capacity_history_cursor: Table<CapacityHistoryCursor>;
      /** #4102 (migration 0198): a booking pace reading per org, half hour and page day. */
      capacity_fill_readings: Table<CapacityFillReading>;
      /** #4102 (migration 0198): each page day's last snapshot, what the next reading compares with. */
      capacity_fill_last: Table<CapacityFillLast>;
      webhook_endpoints: Table<WebhookEndpoint>;
      webhook_deliveries: Table<WebhookDelivery>;
      alert_state: Table<AlertState>;
      agent_calendars: Table<AgentCalendar>;
      audit_log: Table<AuditEntry>;
      sync_locks: Table<SyncLock>;
      rate_limits: Table<RateLimit>;
      reschedule_locks: Table<RescheduleLock>;
      reassign_intents: Table<ReassignIntent>;
      /** #3247 (migration 0166): an advisor held at a booking's window while an
       *  admin confirms a bucket correction. Server only, default deny. */
      reroute_holds: Table<RerouteHold>;
      booking_handoffs: Table<BookingHandoff>;
      owner_alert_events: Table<OwnerAlertEvent>;
      regal_call_events: Table<RegalCallEvent>;
      regal_call_outcomes: Table<RegalCallOutcome>;
      advisor_photos: Table<
        AdvisorPhotoRow,
        [
          {
            // #3027: the photo route serves a hash only while an ACTIVE user holds it.
            foreignKeyName: "advisor_photos_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ]
      >;
      regal_call_ignores: Table<RegalCallIgnore>;
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
      api_caller_seen: Table<ApiCallerSeen>;
      frame_origin_daily: Table<FrameOriginDaily>;
      pilot_offer_samples: Table<PilotOfferSample>;
      pilot_settings_samples: Table<PilotSettingsSample>;
      lead_texting_lines: Table<LeadTextingLine>;
      selfheal_scan_cursor: Table<SelfhealScanCursor>;
      audit_log_chain_verify: Table<AuditLogChainVerify>;
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
      /** #3124 (migration 0193): routed real bookings per minute since the epoch over
       *  [p_from, p_to), as one jsonb array of [minute, bookings], so the read never meets
       *  the row cap. Judged by `slateMinutesFrom` before anything counts it. */
      routed_bookings_per_minute: {
        Args: { p_from: string; p_to: string };
        Returns: unknown;
      };
      /** #3936 (migration 0192): the past days capacity history holds for an org, from
       *  `p_from` on, as one array, so the read never meets the row cap. */
      capacity_history_days: {
        Args: { p_org: string; p_from: string };
        Returns: string[];
      };
      /** #4102 (migration 0198): one run's booking pace readings and snapshots, written only
       *  when the org's latest snapshot is still p_prev_read_at and p_read_at is later. Returns
       *  whether it wrote. */
      record_capacity_fill: {
        Args: { p_org: string; p_read_at: string; p_prev_read_at: string | null; p_rows: unknown; p_last: unknown };
        Returns: boolean;
      };
      /** #4103 (migration 0199): the pattern's cells from readings since p_since, as one jsonb
       *  array of { day_position, slot_of_day, weekday, avg_taken, samples }. */
      capacity_fill_pattern: {
        Args: { p_org: string; p_since: string };
        Returns: unknown;
      };
      /** #3940 (migration 0191): one capacity-history tick's rows merged in (open times as a
       *  set union, unsynced sticky) and the org's cursor moved forward, in one transaction.
       *  Returns the rows written. */
      record_capacity_history: {
        Args: { p_org: string; p_rows: unknown; p_through: string };
        Returns: number;
      };
      /** The full set of migration versions this database has applied, as the repo's
       *  NNNN prefixes (#516, #814, migration 0072). PostgREST cannot see the
       *  supabase_migrations schema, so the prod lag check reads it through this
       *  SECURITY DEFINER function and diffs it against the shipped set to catch a
       *  migration missing from the middle, not just a trailing one. */
      applied_migration_versions: {
        Args: Record<string, never>;
        Returns: string[] | null;
      };
      /** #2090 (migration 0138): events received at or after `p_since`, per reason.
       *  One row per reason at most, so eleven rows, far below PostgREST's cap. */
      regal_call_reason_counts: {
        Args: { p_since: string };
        Returns: { reason: string; events: number }[];
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
          /** #2752, migration 0143: 'production' | 'offsite' | 'none'. */
          p_host_class: "production" | "offsite" | "none";
        };
        Returns: undefined;
      };
      /** #3137 (migration 0162): add one batch of framed booker loads to the day's
       *  (origin, surface) rows, the day taken in `p_zone`. Bounded per day and self
       *  pruning; see the migration. Returns how many rows of the batch it dropped as
       *  invalid, each judged on its own so one bad row never aborts the batch. */
      record_frame_origins: {
        Args: {
          p_zone: string;
          p_rows: { origin: string; surface: string; loads: number; capped: boolean }[];
        };
        Returns: number;
      };
      /** #418: the aggregated outcome mix over [p_since, today] as a single jsonb
       *  row ({ by_outcome, by_error }) so it never hits the 1000-row SETOF cap.
       *  `p_include_test` (#1616) defaults to false in the database as well, so the
       *  safe direction is what a forgetful caller gets; `test_total` always counts
       *  the window's test attempts, so a panel that hides them can say how many.
       *  `p_include_offsite` (#2752, migration 0143) defaults to false the same way,
       *  leaving out real bucket attempts from a page that is not the production site. */
      booking_api_outcome_mix: {
        Args: { p_since: string; p_include_test?: boolean; p_include_offsite?: boolean };
        Returns: {
          by_outcome?: Record<string, number>;
          by_error?: Record<string, number>;
          test_total?: number;
          /** #2752: real bucket attempts from off site hosts, counted whichever way
           *  `p_include_offsite` is set. */
          offsite_total?: number;
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
      // #3109: deletes dead limiter rows, returning how many.
      prune_rate_limits: {
        Args: { p_prefixes: string[]; p_older_than_seconds: number };
        Returns: number;
      };
      /** #3592 (migration 0204): the reconcile-missing sweep's re-create as one statement,
       *  inserting only for bookings still active, settled and in pool; returns the rows
       *  it inserted. Bounded by the sweep's page of candidate ids. */
      recreate_missing_busy_blocks: {
        Args: {
          p_booking_ids: string[];
          p_created_before: string;
        };
        Returns: { booking_id: string; user_id: string }[];
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
          p_routing_trace: RoutingTrace | null;
          /** Which reassign_intents row the swap stamps with the replaced event +
           *  swapped_at, in its own transaction (#759, migration 0069). */
          p_gcal_client_id: string | null;
          /*
           * The bucket aware form (#3247, migration 0166) takes the seven below as
           * well, and it is ALL SEVEN OR NONE: the two overloads are told apart by
           * their argument names, so a call naming only some of these matches
           * neither and fails at the database. None is defaulted in SQL, on
           * purpose, so a seven argument call never collides with the new form.
           * `p_bucket_id` null is the plain reassign; a move needs a claimed live
           * hold in `p_hold_id`; a keep passes the current agent and no hold.
           */
          p_bucket_id?: string | null;
          p_requested_bucket_id?: string | null;
          p_requested_tier?: string | null;
          p_booked_tier?: string | null;
          p_rungs_dropped?: number | null;
          p_hold_id?: string | null;
          /** Merged into the consumed hold's stored result. */
          p_result?: Record<string, unknown> | null;
          /*
           * #1677, migration 0196: the sixteen argument form also takes the state the
           * reassign was decided on, both or neither, and refuses with `booking_moved`
           * under the row lock when the booking no longer has it. Sent only with all
           * fourteen above.
           */
          p_expected_user_id?: string;
          p_expected_starts_at?: string;
        };
        Returns: {
          prev_gcal_event_id: string | null;
          prev_agent_email: string | null;
          updated: boolean;
          /** Only the bucket aware form returns it: null on success, else a word. */
          refused?: RerouteSwapRefusal | null;
        }[];
      };
      /** Holds an advisor at a booking's buffered window for five minutes (#3247,
       *  migration 0166). Returns a refusal word instead of raising. */
      place_reroute_hold: {
        Args: {
          p_org_id: string;
          p_booking_id: string;
          p_agent_user_id: string;
          p_requested_bucket_id: string;
          p_target_bucket_id: string;
          p_rungs_dropped: number;
          p_created_by: string | null;
        };
        Returns: { hold_id: string | null; expires_at: string | null; refused: PlaceRerouteHoldRefusal | null }[];
      };
      /** Live reroute holds near a window, expiry judged on the database clock (#3248). */
      live_reroute_holds: {
        Args: { p_user_ids: string[]; p_from: string; p_to: string };
        Returns: {
          agent_user_id: string;
          booking_id: string;
          booking_starts_at: string;
          booking_ends_at: string;
          buffered_starts_at: string;
          buffered_ends_at: string;
        }[];
      };
      /** Removes expired holds' busy blocks and names the advisors freed (#3248,
       *  migration 0167). The hold rows are kept. */
      prune_expired_reroute_hold_blocks: {
        Args: Record<string, never>;
        Returns: { user_id: string }[];
      };
      /** The first step of a reroute confirm (#3247): checks the hold and extends it
       *  to a two minute confirm lease. A consumed hold returns its stored result. */
      claim_reroute_hold: {
        Args: { p_org_id: string; p_booking_id: string; p_hold_id: string };
        Returns: {
          hold_id: string | null;
          agent_user_id: string | null;
          target_bucket_id: string | null;
          expires_at: string | null;
          refused: ClaimRerouteHoldRefusal | null;
          result: Record<string, unknown> | null;
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
       *  compared by the caller can only be compared once the write has committed.
       *
       *  Two forms (#2702, migration 0157). With `p_only_if_source` it first locks the
       *  row and refuses with SQLSTATE SL409 unless `hours_source` still equals it
       *  (null = still unstamped), so an import never overwrites a week somebody
       *  edited while it ran. Without it, the unguarded form every save uses. */
      replace_user_schedule: {
        Args:
          | {
              p_user_id: string;
              p_timezone: string;
              p_rules: { weekday: number; start_minute: number; end_minute: number }[];
              p_source: "seed" | "agent" | "admin" | "calcom-import";
              p_expected: number;
            }
          | {
              p_user_id: string;
              p_timezone: string;
              p_rules: { weekday: number; start_minute: number; end_minute: number }[];
              p_source: "seed" | "agent" | "admin" | "calcom-import";
              p_expected: number;
              p_only_if_source: "seed" | "agent" | "admin" | "calcom-import" | null;
            };
        Returns: number;
      };
      /** #3122, migration 0161: the week write guarded on the schedule row's
       *  `updated_at` the form loaded (null = the form was drawn with no row).
       *  Raises SQLSTATE SL409 when the row holds another. */
      replace_user_schedule_if_unchanged: {
        Args: {
          p_user_id: string;
          p_timezone: string;
          p_rules: { weekday: number; start_minute: number; end_minute: number }[];
          p_source: "seed" | "agent" | "admin" | "calcom-import";
          p_expected: number;
          p_loaded_updated_at: string | null;
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
       * #3495, migration 0174: a fresh booking's save after its calendar event, in one
       * transaction. Answers {status: committed, booking, enqueue, failed,
       * reservation_deleted} or {status: conflict, winner}, read by `readCommitAnswer`.
       */
      commit_fresh_booking: {
        Args: {
          p_booking: unknown;
          p_reservation_id: string;
          p_webhook: unknown;
          p_routing: unknown;
        };
        Returns: unknown;
      };
      /**
       * #3476, migration 0175: a lead's active bookings for every signal at once (each
       * strong id against both id columns, the escaped email, the E.164 phone) in the
       * named world, `real`, `test` or `both`. Answers a jsonb array of bookings rows
       * with `is_test`, read by `readPersonBookings`.
       */
      find_active_bookings_for_person: {
        // A world and the code it needs are one value (L544): `bucket` (#3489) reads in
        // the world of the bucket named by `p_bucket_code`, which a named world never
        // carries. The database refuses either mismatch (22023);
        // `person-lookup-args.type-test.ts` keeps the types refusing them too.
        Args: {
          p_ids: string[];
          p_email_like: string | null;
          p_phone: string | null;
        } & ({ p_world: "real" | "test" | "both"; p_bucket_code?: never } | { p_world: "bucket"; p_bucket_code: string });
        Returns: unknown;
      };
      /**
       * #3489, migration 0176: everything the candidate read needs for every rung of a
       * ladder in one request, over the caller's superset windows. Read by
       * `ladderInputsFrom` (src/lib/availability/ladder-inputs.ts).
       */
      ladder_candidate_inputs: {
        Args: {
          p_codes: string[];
          p_busy_from: string;
          p_busy_to: string;
          p_cap_from: string;
          p_cap_to: string;
          p_share_from: string;
          p_share_to: string;
          p_exceptions_from: string;
        };
        Returns: unknown;
      };
      /**
       * #3495, migration 0173: one delivery per active endpoint subscribed to the event,
       * deduped on (endpoint, event, dedupe_key), suppression decided by the caller per
       * format. Answers {subscribers, deliveries}, read by `readEnqueueAnswer`.
       */
      enqueue_webhook_deliveries: {
        Args: {
          p_org_id: string;
          p_event: string;
          p_payload: unknown;
          p_dedupe_key: string | null;
          p_suppression: unknown;
        };
        Returns: unknown;
      };
      /**
       * #3265, migration 0171: the gated reschedule and its outbox row in one transaction.
       * Returns the outbox row's id when the move applied; null when the guard matched nothing.
       */
      commit_reschedule: {
        Args: {
          p_booking_id: string;
          p_guard_assigned: string | null;
          p_guard_event: string | null;
          p_starts_at: string;
          p_ends_at: string;
          p_assigned_user_id: string;
          p_agent_name: string | null;
          p_agent_email: string | null;
          p_gcal_event_id: string;
          p_reschedule_seq: number;
          p_set_routing_trace: boolean;
          p_routing_trace: unknown;
          p_steps: unknown;
          p_payload: unknown;
        };
        Returns: string | null;
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
