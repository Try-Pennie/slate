// ICS builder tests: golden REQUEST + CANCEL output, RFC 5545 line folding,
// text escaping, UID/SEQUENCE wiring, and UTC date-time formatting.
// Run: node --experimental-strip-types scripts/test-ics.ts
import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  toIcsUtc,
} from "../src/lib/email/ics.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

/** Reverse RFC 5545 folding: CRLF + single space joins back. */
function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "");
}

const base = {
  uid: "abc123def456@google.com",
  sequence: 0,
  organizerEmail: "agent@trypennie.com",
  organizerName: "Avery Agent",
  attendeeEmail: "lead@example.com",
  attendeeName: "Kris Lead",
  startIso: "2026-06-15T20:00:00.000Z",
  endIso: "2026-06-15T20:30:00.000Z",
  nowIso: "2026-06-10T12:34:56.000Z",
  summary: "Senior Loan Advisor Call with Kris Lead",
  description: "Manage your booking: https://slate.test/booking/manage/tok1",
  location: "Phone call",
};

// --- REQUEST golden ---
{
  const ics = buildIcs({ ...base, method: "REQUEST" });
  const lines = unfold(ics).split("\r\n");

  assert(ics.endsWith("\r\n"), "REQUEST: ends with CRLF");
  assert(!/(^|[^\r])\n/.test(ics), "REQUEST: every newline is CRLF");
  assert(lines[0] === "BEGIN:VCALENDAR", "REQUEST: starts with BEGIN:VCALENDAR");
  assert(lines.includes("PRODID:-//Pennie//Slate//EN"), "REQUEST: PRODID is Pennie//Slate");
  assert(lines.includes("METHOD:REQUEST"), "REQUEST: METHOD:REQUEST in VCALENDAR");
  assert(lines.includes("UID:abc123def456@google.com"), "REQUEST: UID matches the Google event");
  assert(lines.includes("SEQUENCE:0"), "REQUEST: SEQUENCE 0 for the initial invite");
  assert(lines.includes("DTSTAMP:20260610T123456Z"), "REQUEST: DTSTAMP from the injected nowIso");
  assert(lines.includes("DTSTART:20260615T200000Z"), "REQUEST: DTSTART in compact UTC form");
  assert(lines.includes("DTEND:20260615T203000Z"), "REQUEST: DTEND in compact UTC form");
  assert(lines.includes("STATUS:CONFIRMED"), "REQUEST: STATUS:CONFIRMED");
  assert(
    lines.includes("ORGANIZER;CN=Avery Agent:mailto:agent@trypennie.com"),
    "REQUEST: ORGANIZER is the agent with CN",
  );
  assert(
    lines.includes(
      "ATTENDEE;CN=Kris Lead;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:lead@example.com",
    ),
    "REQUEST: ATTENDEE has RSVP=TRUE and PARTSTAT=NEEDS-ACTION",
  );
  assert(lines.includes("LOCATION:Phone call"), "REQUEST: LOCATION present");
  assert(
    lines[lines.length - 2] === "END:VCALENDAR" || lines[lines.length - 1] === "END:VCALENDAR",
    "REQUEST: ends with END:VCALENDAR",
  );

  // Every physical line obeys the 75-octet limit.
  const physical = ics.split("\r\n");
  const enc = new TextEncoder();
  assert(
    physical.every((l) => enc.encode(l).length <= 75),
    "REQUEST: every physical line is <= 75 octets (folded)",
  );
  // The long DESCRIPTION actually folded and unfolds back intact.
  assert(
    unfold(ics).includes(
      "DESCRIPTION:Manage your booking: https://slate.test/booking/manage/tok1",
    ),
    "REQUEST: folded DESCRIPTION unfolds to the original text",
  );
}

// --- CANCEL golden ---
{
  const ics = buildIcs({ ...base, method: "CANCEL", sequence: 1765800000 });
  const lines = unfold(ics).split("\r\n");
  assert(lines.includes("METHOD:CANCEL"), "CANCEL: METHOD:CANCEL");
  assert(lines.includes("STATUS:CANCELLED"), "CANCEL: STATUS:CANCELLED");
  assert(lines.includes("SEQUENCE:1765800000"), "CANCEL: carries the bumped SEQUENCE");
  assert(lines.includes("UID:abc123def456@google.com"), "CANCEL: same UID as the invite");
}

// --- escaping ---
{
  const ics = buildIcs({
    ...base,
    method: "REQUEST",
    summary: "Call; with, special\nchars\\here",
  });
  assert(
    unfold(ics).includes("SUMMARY:Call\\; with\\, special\\nchars\\\\here"),
    "escaping: semicolons, commas, newlines, backslashes",
  );
  assert(
    escapeIcsText("a,b;c\nd\\e") === "a\\,b\\;c\\nd\\\\e",
    "escapeIcsText: escapes all four specials",
  );
}

// --- folding unit ---
{
  const short = "SUMMARY:short";
  assert(foldIcsLine(short) === short, "fold: short lines untouched");

  const long = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldIcsLine(long);
  const enc = new TextEncoder();
  assert(
    folded.split("\r\n").every((l) => enc.encode(l).length <= 75),
    "fold: long line splits into <=75 octet chunks",
  );
  assert(
    folded.split("\r\n").slice(1).every((l) => l.startsWith(" ")),
    "fold: continuations start with a space",
  );
  assert(folded.replace(/\r\n /g, "") === long, "fold: unfolding restores the original");

  // Multi-byte safety: never folds inside a UTF-8 character.
  const emoji = "DESCRIPTION:" + "é".repeat(100);
  const foldedEmoji = foldIcsLine(emoji);
  assert(
    foldedEmoji.replace(/\r\n /g, "") === emoji &&
      foldedEmoji.split("\r\n").every((l) => enc.encode(l).length <= 75),
    "fold: folds at UTF-8 octet boundaries",
  );
}

// --- toIcsUtc ---
{
  assert(toIcsUtc("2026-06-15T20:00:00.000Z") === "20260615T200000Z", "toIcsUtc: Z input");
  assert(
    toIcsUtc("2026-06-15T16:00:00.000-04:00") === "20260615T200000Z",
    "toIcsUtc: offset input normalizes to UTC",
  );
  let threw = false;
  try {
    toIcsUtc("not a date");
  } catch {
    threw = true;
  }
  assert(threw, "toIcsUtc: throws on garbage");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
