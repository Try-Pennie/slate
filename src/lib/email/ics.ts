/**
 * iCalendar (RFC 5545/5546) builder for the branded booking emails. The ICS is
 * embedded as a text/calendar MIME part so Gmail/Outlook render native
 * Accept/Decline buttons; its UID matches the agent's real Google event
 * (`<gcal_event_id>@google.com`) and its ORGANIZER is the agent, so the lead's
 * RSVP REPLY flows back onto the agent's calendar via standard iMIP.
 *
 * Pure module (relative imports only) — exercised by scripts/test-ics.ts.
 */

export type IcsMethod = "REQUEST" | "CANCEL";

export interface BuildIcsInput {
  method: IcsMethod;
  /** iMIP UID; must match the Google event: `<gcal_event_id>@google.com`. */
  uid: string;
  /** Must strictly increase across updates to the same UID (RFC 5546). */
  sequence: number;
  organizerEmail: string;
  organizerName: string;
  attendeeEmail: string;
  attendeeName: string;
  startIso: string;
  endIso: string;
  /** DTSTAMP source — injected so output is deterministic for tests. */
  nowIso: string;
  summary: string;
  description?: string;
  location?: string;
}

/** RFC 5545 3.3.11 TEXT escaping: backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** ISO timestamp → RFC 5545 UTC date-time (e.g. 20260615T200000Z). */
export function toIcsUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO timestamp: ${iso}`);
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * RFC 5545 3.1 content-line folding: lines longer than 75 octets are split
 * with CRLF + a single space. Folds at UTF-8 octet boundaries (never inside a
 * multi-byte character).
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentOctets = 0;
  // First line gets 75 octets; continuations get 74 (the leading space is 1).
  let limit = 75;
  for (const ch of line) {
    const chOctets = encoder.encode(ch).length;
    if (currentOctets + chOctets > limit) {
      out.push(current);
      current = " ";
      currentOctets = 1;
      limit = 75;
    }
    current += ch;
    currentOctets += chOctets;
  }
  if (current) out.push(current);
  return out.join("\r\n");
}

export function buildIcs(input: BuildIcsInput): string {
  const status = input.method === "CANCEL" ? "CANCELLED" : "CONFIRMED";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Pennie//Slate//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${input.method}`,
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${toIcsUtc(input.nowIso)}`,
    `DTSTART:${toIcsUtc(input.startIso)}`,
    `DTEND:${toIcsUtc(input.endIso)}`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
    ...(input.description
      ? [`DESCRIPTION:${escapeIcsText(input.description)}`]
      : []),
    ...(input.location ? [`LOCATION:${escapeIcsText(input.location)}`] : []),
    `ORGANIZER;CN=${escapeIcsText(input.organizerName)}:mailto:${input.organizerEmail}`,
    `ATTENDEE;CN=${escapeIcsText(input.attendeeName)};ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${input.attendeeEmail}`,
    `STATUS:${status}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
