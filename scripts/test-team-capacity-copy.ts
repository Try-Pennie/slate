// The words on the Team capacity page (#3936), held to the settled design
// (docs/design/team-capacity.html): the day labels, the line a person sets, the calendar link,
// and a sentence for every reason the page cannot measure.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-team-capacity-copy.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { NEARLY_FULL_DEFAULT_PCT } from "../src/lib/booking/settings.ts";
import {
  calendarHref,
  dayLabel,
  nearlyFullSentence,
  noShiftWords,
  parseNearlyFullPct,
  fullLine,
  pastDaySummary,
  pickedDayLabel,
  UNMEASURABLE_COPY,
  zoneShort,
  advisorsOffLine,
  calendarsNotSyncingLine,
  callsOpenUnit,
  clockWords,
  estimateLine,
  KEY_WORDS,
  NO_PACE_YET,
  NOT_FILLING,
  PACE_UNREADABLE_COPY,
  paceRateLine,
  paceStaleSentence,
  readingsMissedLine,
} from "../src/lib/admin/team-capacity-copy.ts";

const Z = "America/New_York";
// The em and en dash, built from their codes so this file holds neither character.
const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

// --- day labels -----------------------------------------------------------------
eq(dayLabel("2026-10-19", "2026-10-19", Z), { top: "Today", sub: "Mon Oct 19" }, "today by name");
eq(dayLabel("2026-10-20", "2026-10-19", Z), { top: "Tomorrow", sub: "Tue Oct 20" }, "tomorrow by name");
eq(dayLabel("2026-10-21", "2026-10-19", Z), { top: "Wed", sub: "Oct 21" }, "later days by weekday");
eq(dayLabel("2026-11-02", "2026-11-01", Z), { top: "Tomorrow", sub: "Mon Nov 2" }, "across the clock change, the next day is still tomorrow");
eq(pickedDayLabel("2026-10-26", Z), { top: "Mon", sub: "Oct 26" }, "a picked day is never named Today or Tomorrow");

// --- the line -------------------------------------------------------------------
eq(nearlyFullSentence(85), "Nearly full at 85% full or more.", "the line's sentence, word for word from the design");
eq(parseNearlyFullPct(" 85 "), { pct: 85 }, "a whole number in range is the line");
for (const bad of ["", "0", "100", "85.5", "minus three", "eighty", "085"]) {
  assert("error" in parseNearlyFullPct(bad), `"${bad}" is refused`);
}

// --- the rest -----------------------------------------------------------------------
eq(pastDaySummary(36, 1001), "Ended 36% full, with room left for 1,001 more calls.", "a past day's summary, as the design writes it");
eq(pastDaySummary(95, 1), "Ended 95% full, with room left for 1 more call.", "one call left is singular");
eq(pastDaySummary(null, 0), "Nobody was counted this day.", "a day nobody could be counted on never reads as 0% full");
eq([fullLine(37), fullLine(null)], ["37% full", "Nobody counted"], "a card's line, measured or not");
eq(noShiftWords(true), "No shift today", "today's no shift words");
eq(noShiftWords(false), "No shift", "no other day is called today");
eq(zoneShort("America/Phoenix"), "AZ", "Arizona by its short name");
eq(zoneShort("Pacific/Honolulu"), "Honolulu", "a zone off the list by its city, never blank");
{
  const href = new URL(calendarHref("avery@x.com", "2026-10-20", Z));
  eq(href.origin + href.pathname, "https://calendar.google.com/calendar/embed", "the read only calendar view");
  eq(href.searchParams.get("dates"), "20261020/20261021", "on the day shown");
  eq(href.searchParams.get("src"), "avery@x.com", "for that advisor");
}
for (const [reason, copy] of Object.entries(UNMEASURABLE_COPY)) {
  assert(copy.heading.length > 0 && copy.body.length > 0, `${reason} has a heading and a body`);
  assert(!DASHES.test(copy.heading + copy.body), `${reason} has no dashes`);
}
eq(UNMEASURABLE_COPY.calendars, { heading: "Couldn't load advisor calendars", body: "Try reloading in a minute." }, "the failed read wording Dan settled");

// --- the booking pace words, settled in #4101 ------------------------------------------------------
eq([advisorsOffLine(1), advisorsOffLine(6)], ["1 advisor off", "6 advisors off"], "time off, replacing 6 out (decision 9)");
eq([calendarsNotSyncingLine(1), calendarsNotSyncingLine(2)], ["1 calendar not syncing", "2 calendars not syncing"], "not syncing, replacing 1 not counted (decision 10)");
eq(clockWords(Date.parse("2026-10-20T01:30:00Z"), Z, "2026-10-19"), "9:30pm", "later today is bare (decision 3)");
eq(clockWords(Date.parse("2026-10-20T13:30:00Z"), Z, "2026-10-19"), "9:30am Tue", "another day carries its weekday after the time");
eq(clockWords(Date.parse("2026-10-19T16:00:00Z"), Z, "2026-10-19"), "12pm", "noon on the hour drops its minutes");
eq(clockWords(Date.parse("2026-10-20T04:00:00Z"), Z, "2026-10-19"), "12am Tue", "and so does midnight, which is the next day");
eq(paceRateLine(18.3), "Filling at 18 an hour", "the pace line (decision 1)");
eq(estimateLine("line", { atMs: Date.parse("2026-10-20T01:30:00Z") }, Z, "2026-10-19"), "Full by 9:30pm at this pace", "the straight line (decision 2)");
eq(estimateLine("line", "wont-fill", Z, "2026-10-19"), "Won't fill at this pace", "won't get there");
eq(estimateLine("pattern", { atMs: Date.parse("2026-10-20T01:30:00Z") }, Z, "2026-10-19"), "Full by 9:30pm", "the pattern, no qualifier (decision 4)");
eq(estimateLine("pattern", "wont-fill", Z, "2026-10-19"), "Won't fill", "the pattern that won't get there");
eq(readingsMissedLine(Date.parse("2026-10-19T22:30:00Z"), Z, "2026-10-19"), "Readings missed, pace back by 6:30pm", "after a gap (decision 8)");
eq(paceStaleSentence(Date.parse("2026-10-19T17:30:00Z"), Z, "2026-10-19"), "Couldn't update how fast the days are filling since 1:30pm.", "out of date (decision 13)");
eq(PACE_UNREADABLE_COPY, { heading: "Couldn't load how fast the days are filling.", body: "Try reloading in a minute." }, "can't load (decision 12)");
eq([NOT_FILLING, NO_PACE_YET], ["Not filling right now", "Pace shows after 3 hours of readings"], "not filling and no pace yet (decisions 6 and 7)");
eq(KEY_WORDS, { busy: "Busy", open: "Open", off: "Not working", past: "Past" }, "the key's words (decision 14)");
eq([KEY_WORDS.open, callsOpenUnit(2).trim()], ["Open", "calls open"], "one word for a call that still fits (decision 15)");
for (const words of [NOT_FILLING, NO_PACE_YET, PACE_UNREADABLE_COPY.heading, PACE_UNREADABLE_COPY.body, ...Object.values(KEY_WORDS)]) {
  assert(!DASHES.test(words), `"${words}" has no dashes`);
}

// --- the default line is the column's own default ------------------------------------------------
{
  const sql = readFileSync(new URL("../supabase/migrations/0192_capacity_nearly_full_pct.sql", import.meta.url), "utf8");
  const m = /capacity_nearly_full_pct smallint not null default (\d+)/.exec(sql);
  assert(m !== null, "the migration declares the column's default");
  eq(Number(m?.[1]), NEARLY_FULL_DEFAULT_PCT, "the code's default line is the column default, so a missing row and a new one agree");
}

finish();
