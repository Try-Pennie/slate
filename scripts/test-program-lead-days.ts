// The program leads admin page's last 14 Eastern days (#4392). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-program-lead-days.ts
//
// This file pins:
//   1. the ONE Eastern day helper the page, the alerts and the claim SQL share: a day's
//      start in New York, across both DST changes, and the 14 days ending today;
//   2. which day each column counts by: program bookings, those on the placeholder and
//      those with no Regal call by the day of the CALL, the limit refusals and the
//      fallbacks by the day they happened (`program_lead_outcomes.day`);
//   3. that "no Regal call" is the monitor's own verdict (`judgePlaceholderCall`), so a
//      feed with nothing since a call was due is counted apart as not known yet, never
//      as no call and never as a call;
//   4. the empty reading, which the page draws differently from a failed read (L10).
import {
  PLACEHOLDER_DAY_ZONE,
  placeholderCallDay,
  placeholderDayStartMs,
  placeholderDaysBack,
} from "@/lib/booking/program-lead-times";
import {
  PROGRAM_LEAD_DAYS_SHOWN,
  buildProgramLeadDays,
  programLeadDaysEmpty,
  programLeadDaysWindow,
} from "@/lib/admin/program-lead-days";
import { PLACEHOLDER_CALL_GRACE_MS, type PlaceholderBookingRow, type PlaceholderCallRow } from "@/lib/monitor/placeholder-calls";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;
// 2026-10-29 15:00 ET (19:00 UTC, still daylight time).
const NOW = Date.UTC(2026, 9, 29, 19, 0, 0);
const LEAD = "00Q5f00000AbCdEFGH";

// --- 1. the day helper -----------------------------------------------------------------

eq(PLACEHOLDER_DAY_ZONE, "America/New_York", "the day is New York's, as placeholder_day_held counts it");
eq(placeholderDayStartMs("2026-10-29"), Date.UTC(2026, 9, 29, 4, 0), "a daylight time day starts at 04:00 UTC");
eq(placeholderDayStartMs("2026-11-02"), Date.UTC(2026, 10, 2, 5, 0), "a standard time day starts at 05:00 UTC");
eq(
  placeholderDayStartMs("2026-11-02") - placeholderDayStartMs("2026-11-01"),
  25 * 60 * MIN,
  "the day the clocks go back is 25 hours long, so day bounds are never start plus 24 hours",
);
eq(placeholderCallDay(placeholderDayStartMs("2026-11-01")), "2026-11-01", "a day's first instant is on that day");
eq(placeholderCallDay(placeholderDayStartMs("2026-11-02") - 1), "2026-11-01", "and the instant before the next day still is");
{
  const days = placeholderDaysBack(NOW, 14);
  eq(days.length, 14, "fourteen days");
  eq(days[0], "2026-10-29", "newest first, today first");
  eq(days[13], "2026-10-16", "back to the 16th");
  eq(new Set(days).size, 14, "no day twice");
  // Across the change back to standard time, still one entry per calendar day.
  const across = placeholderDaysBack(Date.UTC(2026, 10, 3, 17, 0), 4);
  eq(across, ["2026-11-03", "2026-11-02", "2026-11-01", "2026-10-31"], "one entry per day across the clock change");
}
eq(PROGRAM_LEAD_DAYS_SHOWN, 14, "the page shows the last 14 Eastern days");
{
  const w = programLeadDaysWindow(NOW);
  eq(w.days[0], "2026-10-29", "the window's days are the helper's");
  eq(w.fromIso, new Date(placeholderDayStartMs("2026-10-16")).toISOString(), "it reads calls from the start of the oldest day");
  eq(w.untilIso, new Date(placeholderDayStartMs("2026-10-30")).toISOString(), "to the start of tomorrow, so today's later calls count");
}

// --- 2 and 3. the columns ---------------------------------------------------------------

let n = 0;
function booking(startMs: number, over: Partial<PlaceholderBookingRow> = {}): PlaceholderBookingRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "staff_placed",
    status: "confirmed",
    starts_at: new Date(startMs).toISOString(),
    ends_at: new Date(startMs + 30 * MIN).toISOString(),
    salesforce_id: LEAD,
    agent_name: "Marcia",
    ...over,
  };
}
const at = (day: string, hourEt: number) => placeholderDayStartMs(day) + hourEt * 60 * MIN;
const call = (startMs: number): PlaceholderCallRow => ({ lead_key: LEAD.slice(0, 15), started_at: new Date(startMs).toISOString(), is_ai_agent: false });
const days = placeholderDaysBack(NOW, 14);

{
  // Tuesday the 27th: three program calls, two on the placeholder, one of those called.
  const served = booking(at("2026-10-27", 10));
  const missed = booking(at("2026-10-27", 11), { salesforce_id: "00Q5f00000ZZZZZQQQ" });
  const real = booking(at("2026-10-27", 12), { kind: "routed", agent_name: "Ada Example" });
  // 23:30 ET on the 27th is 03:30 UTC on the 28th: it counts on the 27th, the call's
  // Eastern day, never the UTC date.
  const late = booking(at("2026-10-27", 23.5), { kind: "routed", agent_name: "Ada Example" });
  // Today: one still ahead, one due but with a feed that has heard nothing since.
  const ahead = booking(NOW + 60 * MIN);
  const quiet = booking(NOW - 60 * MIN);
  const feedNewestMs = NOW - 50 * MIN; // before `quiet` was due (its end plus the grace)
  const rows = buildProgramLeadDays({
    days,
    bookings: [served, missed, real, late, ahead, quiet],
    calls: [call(at("2026-10-27", 10) + 5 * MIN)],
    feedNewestMs,
    outcomes: [
      { day: "2026-10-27", kind: "limit_refused", occurrences: 4 },
      { day: "2026-10-28", kind: "times_fallback", occurrences: 2 },
      { day: "2026-10-28", kind: "something_new", occurrences: 9 },
    ],
    nowMs: NOW,
  });
  eq(rows.length, 14, "one row per day, every day, including the quiet ones");
  const byDay = new Map(rows.map((r) => [r.day, r]));
  eq(
    byDay.get("2026-10-27"),
    { day: "2026-10-27", bookings: 4, onPlaceholder: 2, noRegalCall: 1, notKnownYet: 0, limitRefused: 4, fallbacks: 0 },
    "the 27th: four program calls by the day of the call, two on the placeholder, one with no Regal call",
  );
  eq(byDay.get("2026-10-28")!.bookings, 0, "the late call is not counted on the UTC date it fell on");
  eq(byDay.get("2026-10-28")!.fallbacks, 2, "a fallback counts on the day it happened");
  eq(byDay.get("2026-10-28")!.limitRefused, 0, "an outcome kind the page does not know is never folded into another");
  const today = byDay.get("2026-10-29")!;
  eq(today.bookings, 2, "today's calls, those still ahead included");
  eq(today.noRegalCall, 0, "a call whose feed has heard nothing since it was due is not a missed call");
  eq(today.notKnownYet, 1, "it is counted apart, as not known yet");
  assert(feedNewestMs < NOW - 30 * MIN + PLACEHOLDER_CALL_GRACE_MS, "control: the feed really is behind the quiet call's due time");
  eq(rows[0]!.day, "2026-10-29", "rows are newest first");
}
{
  // A booking the loader should never hand over, held off anyway.
  const rows = buildProgramLeadDays({
    days,
    bookings: [booking(at("2026-10-27", 10), { status: "cancelled" }), booking(at("2026-09-01", 10))],
    calls: [],
    feedNewestMs: NOW,
    outcomes: [{ day: "2026-09-01", kind: "times_fallback", occurrences: 3 }],
    nowMs: NOW,
  });
  eq(rows.reduce((s, r) => s + r.bookings, 0), 0, "a cancelled call and one outside the 14 days count nowhere");
  eq(rows.reduce((s, r) => s + r.fallbacks, 0), 0, "and neither does an outcome from outside them");
}

// --- 4. empty, which is not the same screen as unreadable -------------------------------

{
  const quiet = buildProgramLeadDays({ days, bookings: [], calls: [], feedNewestMs: null, outcomes: [], nowMs: NOW });
  eq(programLeadDaysEmpty(quiet), true, "fourteen days of nothing is the empty reading");
  const one = buildProgramLeadDays({ days, bookings: [], calls: [], feedNewestMs: null, outcomes: [{ day: "2026-10-20", kind: "times_fallback", occurrences: 1 }], nowMs: NOW });
  eq(programLeadDaysEmpty(one), false, "a single fallback is something to show");
}

finish();
