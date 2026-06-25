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
  Bucket,
  BucketMember,
  BucketSlotsRow,
  BusyBlock,
  EventType,
  GoogleCredentials,
  OooRequest,
  Organization,
  PendingEventDeletion,
  RateLimit,
  RescheduleLock,
  SyncLock,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from "@/lib/db/types";

// Intersecting with Record<string, unknown> gives our interfaces the implicit
// index signature postgrest-js's GenericTable requires (interfaces lack one),
// while keeping named columns for `.select()` results and insert payloads.
type Table<Row> = {
  Row: Row & Record<string, unknown>;
  Insert: Partial<Row> & Record<string, unknown>;
  Update: Partial<Row> & Record<string, unknown>;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      organizations: Table<Organization>;
      users: Table<User>;
      google_credentials: Table<GoogleCredentials>;
      event_types: Table<EventType>;
      buckets: Table<Bucket>;
      bucket_members: Table<BucketMember>;
      availability_schedules: Table<AvailabilitySchedule>;
      availability_rules: Table<AvailabilityRule>;
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
      bucket_slots: Table<BucketSlotsRow>;
      pending_event_deletions: Table<PendingEventDeletion>;
      booking_outbox: Table<BookingOutbox>;
      booking_reservations: Table<BookingReservation>;
    };
    Views: Record<string, never>;
    Functions: {
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
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
