import { CALENDAR_COPY } from "./booker-copy.ts";

/**
 * Add to calendar links for a lead's call (#2643).
 *
 * The one builder behind every place a lead can save their call: the booking
 * lookup trypennie's booking confirmed page reads, the confirm response, and the
 * ICS file served by the manage token, and Slate's own confirmation screen and
 * manage page (#2165, through `AddToCalendar`). Pure: the clock is handed in, so
 * the ICS is deterministic.
 */

/** The call as it goes on the lead's calendar. Times are UTC ISO instants. */
export interface LeadCalendarEvent {
  uid: string;
  /** Bumped on every reschedule, so a re-downloaded file replaces the old time. */
  sequence: number;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  /** The manage page, where the lead can move or cancel the call. */
  url: string;
}

export interface CalendarLinks {
  google: string;
  outlook: string;
  office365: string;
  ics: string;
}

export function leadCalendarEvent(
  booking: {
    id: string;
    starts_at: string;
    ends_at: string;
    agent_name: string | null;
    reschedule_seq?: number;
  },
  manageUrl: string,
): LeadCalendarEvent {
  return {
    uid: `${booking.id}@slate.trypennie.app`,
    sequence: booking.reschedule_seq ?? 0,
    title: CALENDAR_COPY.title(booking.agent_name),
    description: CALENDAR_COPY.description(manageUrl),
    // toISOString throws on an unreadable instant, which is the right way to fail:
    // a calendar entry at a wrong time is worse than no calendar links at all.
    startsAt: new Date(booking.starts_at).toISOString(),
    endsAt: new Date(booking.ends_at).toISOString(),
    url: manageUrl,
  };
}

/** Where the ICS file for a booking is served: by its manage token, so a browser
 *  button can fetch it with no API key. */
export function icsUrl(appBaseUrl: string, manageToken: string): string {
  return `${appBaseUrl}/api/bookings/${manageToken}/ics`;
}

/** 2026-09-24T15:00:00.000Z -> 20260924T150000Z, the form Google and ICS take. */
function compactUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function outlookCompose(host: string, event: LeadCalendarEvent): string {
  const q = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.title,
    startdt: event.startsAt,
    enddt: event.endsAt,
    body: event.description,
  });
  return `https://${host}/calendar/0/action/compose?${q}`;
}

export function calendarLinks(event: LeadCalendarEvent, ics: string): CalendarLinks {
  const google = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${compactUtc(event.startsAt)}/${compactUtc(event.endsAt)}`,
    details: event.description,
  });
  return {
    google: `https://calendar.google.com/calendar/render?${google}`,
    outlook: outlookCompose("outlook.live.com", event),
    office365: outlookCompose("outlook.office.com", event),
    ics,
  };
}

/** RFC 5545 TEXT escaping: backslash first, then the reserved characters. */
function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/**
 * Fold a content line to 75 octets (RFC 5545 3.1). A continuation line starts
 * with one space, which counts toward its 75, and a character is never split
 * across two lines, so multi-byte text survives.
 */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** The ICS file for one call. `stampIso` is DTSTAMP, the moment the file was made. */
export function icsDocument(event: LeadCalendarEvent, stampIso: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pennie//Slate//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${compactUtc(stampIso)}`,
    `DTSTART:${compactUtc(event.startsAt)}`,
    `DTEND:${compactUtc(event.endsAt)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `URL:${event.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
