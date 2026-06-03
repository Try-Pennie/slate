import type { BookingStatus } from "@/lib/db/types";

/** Canonical payload Slate builds per booking event (stored on the delivery). */
export interface BookingEventPayload {
  booking_id: string;
  salesforce_id: string | null;
  bucket_code: string;
  event_type: string; // display title, e.g. "Senior Loan Advisor Call"
  event_type_slug: string; // Regal `type`, e.g. "call"
  event_description: string | null;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  timezone: string;
  agent: { id: string; name: string | null; email: string };
  attendee: { name: string | null; email: string | null; phone: string | null };
  prefill: Record<string, string>;
  manage_url: string;
}
