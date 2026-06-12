import { getDelegatedToken } from "@/lib/google/dwd";
import { buildIcs, type IcsMethod } from "./ics.ts";
import { buildMime } from "./mime.ts";
import {
  renderBookingEmail,
  type BookingEmailKind,
} from "./templates.ts";
import type { Booking, EventType } from "@/lib/db/types";

/**
 * Sends the branded booking email FROM THE AGENT'S OWN GMAIL via domain-wide
 * delegation (gmail.send scope), with an embedded iMIP invitation tied to the
 * agent's real Google event (UID = `<gcal_event_id>@google.com`, ORGANIZER =
 * agent). From == organizer is what makes Gmail render the native
 * Accept/Decline buttons and route the lead's RSVP back onto the real event.
 *
 * Throws on any failure — the caller (booking service) owns the fallback
 * (make Google send its native invite) so the lead is never left unnotified.
 */

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface BookingEmailContext {
  booking: Booking;
  eventType: EventType;
  manageUrl: string;
}

function methodFor(kind: BookingEmailKind): IcsMethod {
  return kind === "cancelled" ? "CANCEL" : "REQUEST";
}

/**
 * iMIP SEQUENCE: 0 for the initial REQUEST; every later update to the same UID
 * must carry a strictly higher value (RFC 5546). Bookings carry no reschedule
 * counter, so updates use seconds-since-epoch at send time — monotonic across
 * reschedules and always >= the last REQUEST when the CANCEL goes out, which
 * is all clients need to treat the update as newer.
 */
function sequenceFor(kind: BookingEmailKind, nowMs: number): number {
  return kind === "created" ? 0 : Math.floor(nowMs / 1000);
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendBrandedBookingEmail(
  kind: BookingEmailKind,
  ctx: BookingEmailContext,
): Promise<void> {
  const { booking, eventType, manageUrl } = ctx;
  if (!booking.attendee_email) return; // nobody to email
  if (!booking.agent_email || !booking.gcal_event_id) {
    throw new Error("booking has no agent email / calendar event to invite from");
  }

  const now = Date.now();
  const { subject, html, text } = renderBookingEmail({
    kind,
    agentName: booking.agent_name,
    attendeeName: booking.attendee_name,
    eventTypeName: eventType.name,
    startIso: booking.starts_at,
    timezone: booking.timezone,
    durationMin: eventType.duration_min,
    manageUrl,
  });

  const method = methodFor(kind);
  const ics = buildIcs({
    method,
    uid: `${booking.gcal_event_id}@google.com`,
    sequence: sequenceFor(kind, now),
    organizerEmail: booking.agent_email,
    organizerName: booking.agent_name ?? booking.agent_email,
    attendeeEmail: booking.attendee_email,
    attendeeName: booking.attendee_name ?? booking.attendee_email,
    startIso: booking.starts_at,
    endIso: booking.ends_at,
    nowIso: new Date(now).toISOString(),
    summary: `${eventType.name}${
      booking.attendee_name ? ` with ${booking.attendee_name}` : ""
    }`,
    description: `Manage your booking: ${manageUrl}`,
    location: "Phone call",
  });

  const mime = buildMime({
    from: booking.agent_email,
    fromName: booking.agent_name ?? booking.agent_email,
    to: booking.attendee_email,
    toName: booking.attendee_name ?? booking.attendee_email,
    subject,
    html,
    text,
    ics,
    icsMethod: method,
  });

  const token = await getDelegatedToken(booking.agent_email, [GMAIL_SEND_SCOPE]);
  const res = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw: base64Url(mime) }),
  });
  if (!res.ok) {
    throw new Error(
      `gmail send failed for ${booking.agent_email}: ${res.status} ${await res.text()}`,
    );
  }
}
