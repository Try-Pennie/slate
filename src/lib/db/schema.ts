/**
 * Minimal `Database` generic for the typed Supabase client. Rows come from our
 * hand-written types; Insert/Update are permissive partials (generated columns
 * are optional). Replace with `supabase gen types typescript` once linked.
 */
import type {
  AvailabilityRule,
  AvailabilitySchedule,
  Booking,
  Bucket,
  BucketMember,
  BusyBlock,
  EventType,
  GoogleCredentials,
  Organization,
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
      webhook_endpoints: Table<WebhookEndpoint>;
      webhook_deliveries: Table<WebhookDelivery>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
