// Add to calendar links for a lead's call (#2643). One builder feeds every
// consumer: the booking lookup trypennie's booking confirmed page reads, the
// confirm response, and the ICS file served by the manage token. #2165 (Slate's
// own confirmation screen) is meant to read the same builder, so the four links
// can never say four different things about one call (L41).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-calendar-links.ts
import {
  leadCalendarEvent,
  calendarLinks,
  icsDocument,
  icsUrl,
} from "../src/lib/booking/calendar-links.ts";
import { CALENDAR_COPY } from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MANAGE = "https://slate.test/booking/manage/tok123";
const booking = {
  id: "bk-1",
  starts_at: "2026-09-24T15:00:00+00:00",
  ends_at: "2026-09-24T15:30:00+00:00",
  agent_name: "Dana Lee",
  reschedule_seq: 2,
};
const event = leadCalendarEvent(booking, MANAGE);

// --- the event is described from the LEAD's side -----------------------------
{
  eq(event.title, CALENDAR_COPY.title("Dana Lee"), "the title comes from the copy builder");
  assert(event.title.includes("Dana Lee"), "and names the advisor who will call");
  const unnamed = leadCalendarEvent({ ...booking, agent_name: null }, MANAGE);
  eq(unnamed.title, CALENDAR_COPY.title(null), "a booking with no advisor name still gets a whole title");
  assert(!/\bnull\b|undefined|with\s*$/.test(unnamed.title), "and never trails an empty name");
  assert(event.description.includes(MANAGE), "the description carries the manage link, so the entry can move the call");
  eq(event.startsAt, "2026-09-24T15:00:00.000Z", "start normalised to UTC");
  eq(event.endsAt, "2026-09-24T15:30:00.000Z", "end normalised to UTC");
}

// --- web links -------------------------------------------------------------------
const ICS = icsUrl("https://slate.test", "tok123");
eq(ICS, "https://slate.test/api/bookings/tok123/ics", "the ICS lives beside the other manage token routes");
const links = calendarLinks(event, ICS);
{
  const g = new URL(links.google);
  eq(g.origin + g.pathname, "https://calendar.google.com/calendar/render", "Google template endpoint");
  eq(g.searchParams.get("action"), "TEMPLATE", "Google action");
  eq(g.searchParams.get("text"), event.title, "Google title");
  eq(g.searchParams.get("dates"), "20260924T150000Z/20260924T153000Z", "Google dates in compact UTC");
  eq(g.searchParams.get("details"), event.description, "Google details");

  for (const [name, host] of [["outlook", "outlook.live.com"], ["office365", "outlook.office.com"]] as const) {
    const u = new URL(links[name]);
    eq(u.host, host, `${name} host`);
    eq(u.searchParams.get("rru"), "addevent", `${name} opens the add event form`);
    eq(u.searchParams.get("subject"), event.title, `${name} title`);
    eq(u.searchParams.get("startdt"), event.startsAt, `${name} start`);
    eq(u.searchParams.get("enddt"), event.endsAt, `${name} end`);
    eq(u.searchParams.get("body"), event.description, `${name} body`);
  }
  eq(links.ics, ICS, "the ICS link is the manage token route");
}

// --- the ICS document (RFC 5545) ----------------------------------------------------
const STAMP = "2026-09-23T12:00:00.000Z";
{
  const doc = icsDocument(event, STAMP);
  assert(doc.endsWith("\r\n"), "ends with CRLF");
  const rawLines = doc.slice(0, -2).split("\r\n");
  assert(!doc.replace(/\r\n/g, "").includes("\n"), "every line break is CRLF, none bare");
  assert(rawLines.every((l) => new TextEncoder().encode(l).length <= 75), "no line is longer than 75 octets");
  // Unfold (a CRLF followed by one space continues the previous line).
  const lines = doc.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

  eq(lines[0], "BEGIN:VCALENDAR", "opens a calendar");
  eq(lines[lines.length - 1], "END:VCALENDAR", "closes it");
  eq(field("VERSION"), "2.0", "version");
  eq(field("METHOD"), "PUBLISH", "publish, not a meeting request");
  eq(field("UID"), "bk-1@slate.trypennie.app", "stable per booking, so a second download updates the entry");
  eq(field("SEQUENCE"), "2", "sequence follows the reschedule count, so a moved call replaces the old time");
  eq(field("DTSTAMP"), "20260923T120000Z", "stamp is the clock handed in, never read inside");
  eq(field("DTSTART"), "20260924T150000Z", "start");
  eq(field("DTEND"), "20260924T153000Z", "end");
  eq(field("URL"), MANAGE, "the manage link");
  eq(field("SUMMARY"), event.title, "summary is the title");
  eq(field("DESCRIPTION"), event.description.replace(/\n/g, "\\n"), "description newlines are escaped");
  eq(icsDocument(event, STAMP), doc, "deterministic for one clock");
}

// Text values escape the characters RFC 5545 reserves.
{
  const odd = leadCalendarEvent({ ...booking, agent_name: "Lee, Dana; Jr\\" }, MANAGE);
  const doc = icsDocument(odd, STAMP).replace(/\r\n /g, "");
  const summary = doc.split("\r\n").find((l) => l.startsWith("SUMMARY:"))!;
  assert(summary.includes("Lee\\, Dana\\; Jr\\\\"), `commas, semicolons and backslashes are escaped (${summary})`);
}

// A long description folds rather than overflowing, and unfolds back intact.
{
  const long = { ...event, description: "x".repeat(300) + "\nReschedule or cancel: " + MANAGE };
  const doc = icsDocument(long, STAMP);
  assert(doc.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75), "a long value is folded");
  const unfolded = doc.replace(/\r\n /g, "").split("\r\n").find((l) => l.startsWith("DESCRIPTION:"))!;
  eq(unfolded, "DESCRIPTION:" + long.description.replace(/\n/g, "\\n"), "and unfolds to the original value");
}

// A folded multi-byte character is never split mid character.
{
  const accented = { ...event, title: "é".repeat(60) };
  const doc = icsDocument(accented, STAMP);
  assert(!doc.includes("�"), "no replacement characters");
  const unfolded = doc.replace(/\r\n /g, "").split("\r\n").find((l) => l.startsWith("SUMMARY:"))!;
  eq(unfolded, "SUMMARY:" + "é".repeat(60), "multi-byte text survives folding");
}

finish();
