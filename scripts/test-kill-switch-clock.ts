// The clock check the nightly kill switch proof makes before it pauses anything (#3920).
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-kill-switch-clock.ts
//
// THE DEFECT THIS GUARDS. The proof pauses public booking for about two seconds, so its
// cron sits in the small hours. GitHub started it 4.5 to 9.5 hours late on every run for a
// month (7:32 to 12:40 Eastern), so every morning it paused live booking inside business
// hours, and on 2026-10-19 the booking route answered two requests at 10:35 AM Eastern with
// "bookings are paused" (L386: a cron's declared time is not when it runs). Nothing the
// workflow declares can stop that, so the command asks the clock itself, against the org's
// own hours, before it writes the flag.
//
// Driven here with no network, no database and no real clock: every instant is a fixed
// epoch, and the week is the seeded one plus hand written exceptions.
import { DateTime } from "luxon";
import {
  SEEDED_BUSINESS_HOURS,
  BUSINESS_ZONE,
  type BusinessHoursException,
  type BusinessWindow,
} from "../src/lib/booking/business-hours.ts";
import {
  judgeDrillClock,
  drillClockExit,
  drillClockSummaryLine,
  exceptionsConsultedFrom,
  readOrgHours,
  appendStepSummary,
  DRILL_MARGIN_MINUTES,
  type OrgHoursReading,
} from "./lib/kill-switch-clock.ts";
import { KILL_SWITCH_EXIT } from "./lib/kill-switch-live-control.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Printable ASCII only: no em dash, no en dash, no emoji, and no narrow space from Intl. */
const PLAIN = /^[\x20-\x7E\n]*$/;

const at = (iso: string): number => {
  const ms = DateTime.fromISO(iso, { zone: BUSINESS_ZONE }).toMillis();
  if (!Number.isFinite(ms)) throw new Error(`bad fixture instant ${iso}`);
  return ms;
};

const seeded = (exceptions: BusinessHoursException[] = [], rules: BusinessWindow[] = SEEDED_BUSINESS_HOURS): OrgHoursReading => ({
  ok: true,
  hours: { zone: BUSINESS_ZONE, rules, exceptions },
});

const shut = (on_date: string): BusinessHoursException => ({
  on_date,
  is_open: false,
  start_minute: null,
  end_minute: null,
  note: "Christmas Day",
});

const kindAt = (reading: OrgHoursReading, iso: string): string => judgeDrillClock(reading, at(iso)).kind;

// --- the margin is the one the workflow comment and the docs state -------------
eq(DRILL_MARGIN_MINUTES, 30, "the margin either side of the open window is thirty minutes");

// --- inside the open window ----------------------------------------------------
// 2026-10-19 is a Monday, and 10:35 Eastern is the instant the issue measured the drill
// refusing two requests at.
eq(kindAt(seeded(), "2026-10-19T10:35:56"), "inside-hours", "Monday 10:35 Eastern is inside the org's hours, so nothing is paused");
eq(kindAt(seeded(), "2026-10-17T12:00:00"), "inside-hours", "Saturday noon is inside too: the seeded week opens Monday to Saturday");

// --- outside it ----------------------------------------------------------------
eq(kindAt(seeded(), "2026-10-20T03:30:00"), "clear", "Tuesday 03:30 Eastern is outside the hours, so the drill may run");
eq(kindAt(seeded(), "2026-10-19T23:00:00"), "clear", "Monday 23:00 is outside too");

// --- a weekend day the org is shut -----------------------------------------------
eq(kindAt(seeded(), "2026-10-18T12:00:00"), "clear", "Sunday noon is clear: Sunday is shut in the seeded week");

// --- a closed date -------------------------------------------------------------
// 2026-12-25 is a Friday, normally open.
eq(kindAt(seeded(), "2026-12-25T12:00:00"), "inside-hours", "control: a Friday noon with no exception is inside the hours");
eq(
  kindAt(seeded([shut("2026-12-25")]), "2026-12-25T12:00:00"),
  "clear",
  "the same instant is clear once the date is recorded as closed, because the exception beats the weekday",
);
// And an exception that OPENS a shut Sunday closes the drill's window on it.
eq(
  kindAt(
    seeded([{ on_date: "2026-12-27", is_open: true, start_minute: 10 * 60, end_minute: 14 * 60, note: "one off Sunday" }]),
    "2026-12-27T11:00:00",
  ),
  "inside-hours",
  "a Sunday opened by an exception is inside the hours, so the exception is read both ways",
);

// --- the edges of the margin, to the millisecond ---------------------------------
// Monday 2026-10-19 opens at 08:00 EDT, so the margin starts at 07:30.
{
  const edge = at("2026-10-19T07:30:00");
  eq(judgeDrillClock(seeded(), edge).kind, "inside-hours", "exactly thirty minutes before opening is inside the margin");
  eq(judgeDrillClock(seeded(), edge - 1).kind, "clear", "one millisecond earlier is clear");
}
// It closes at 20:00, so the margin ends at 20:30, exclusive.
{
  const edge = at("2026-10-19T20:30:00");
  eq(judgeDrillClock(seeded(), edge - 1).kind, "inside-hours", "one millisecond before thirty minutes after closing is inside the margin");
  eq(judgeDrillClock(seeded(), edge).kind, "clear", "exactly thirty minutes after closing is clear");
}
// The same edges the day after the clocks went back (2026-11-01), so the margin is judged on
// the org's wall clock in whichever offset applies rather than on a fixed UTC hour.
{
  const edge = at("2026-11-02T07:30:00");
  eq(DateTime.fromMillis(edge, { zone: "UTC" }).hour, 12, "fixture check: 07:30 Eastern is 12:30 UTC in November");
  eq(judgeDrillClock(seeded(), edge).kind, "inside-hours", "in standard time, thirty minutes before opening is inside the margin");
  eq(judgeDrillClock(seeded(), edge - 1).kind, "clear", "and one millisecond earlier is clear");
}

// --- a window that touches midnight is judged across the day boundary ------------
// A day open until 24:00 carries its margin past midnight into the NEXT date, and a day
// opening at 00:00 carries its margin back into the PREVIOUS one. Asking only today's
// window would miss both, which is why yesterday and tomorrow are consulted.
{
  const lateMonday = seeded([], [{ weekday: 1, start_minute: 18 * 60, end_minute: 1440 }]);
  eq(kindAt(lateMonday, "2026-10-20T00:15:00"), "inside-hours", "Tuesday 00:15 is inside the margin of a Monday open until midnight");
  eq(kindAt(lateMonday, "2026-10-20T00:30:00"), "clear", "and Tuesday 00:30 is clear");
  const earlyTuesday = seeded([], [{ weekday: 2, start_minute: 0, end_minute: 6 * 60 }]);
  eq(kindAt(earlyTuesday, "2026-10-19T23:45:00"), "inside-hours", "Monday 23:45 is inside the margin of a Tuesday opening at midnight");
  eq(kindAt(earlyTuesday, "2026-10-19T23:29:00"), "clear", "and Monday 23:29 is clear");
}

// --- hours that cannot be read never pause anything ------------------------------
{
  const unreadable = judgeDrillClock({ ok: false, reason: "business_hours: relation does not exist" }, at("2026-10-20T03:30:00"));
  eq(unreadable.kind, "hours-unreadable", "an unreadable week is its own answer, at an instant that would otherwise be clear");
  assert(unreadable.detail.includes("relation does not exist"), "and carries the reason the read gave");

  const badZone = judgeDrillClock(
    { ok: true, hours: { zone: "Not/AZone", rules: SEEDED_BUSINESS_HOURS, exceptions: [] } },
    at("2026-10-20T03:30:00"),
  );
  eq(badZone.kind, "hours-unreadable", "a zone the clock cannot be read in is unreadable rather than clear");

  const noClock = judgeDrillClock(seeded(), Number.NaN);
  eq(noClock.kind, "hours-unreadable", "an unreadable clock is unreadable rather than clear");
}

// --- which exit each answer leaves on --------------------------------------------
{
  eq(drillClockExit(judgeDrillClock(seeded(), at("2026-10-20T03:30:00"))), null, "a clear clock does not end the run: the drill goes on");
  eq(
    drillClockExit(judgeDrillClock(seeded(), at("2026-10-19T10:35:00"))),
    KILL_SWITCH_EXIT.insideBusinessHours,
    "inside the hours ends on the skip code",
  );
  eq(
    drillClockExit(judgeDrillClock({ ok: false, reason: "x" }, at("2026-10-20T03:30:00"))),
    KILL_SWITCH_EXIT.hoursUnreadable,
    "unreadable hours end on their own code, never the skip code: one is the design working and the other is a read that failed (L11)",
  );
  assert(
    (KILL_SWITCH_EXIT.insideBusinessHours as number) !== KILL_SWITCH_EXIT.hoursUnreadable,
    "the two codes differ",
  );
}

// --- what it says ------------------------------------------------------------------
{
  const inside = judgeDrillClock(seeded(), at("2026-10-19T10:35:56"));
  assert(/10:35 AM/.test(inside.detail), `the skip names the instant it was judged at, in the org's clock: ${inside.detail}`);
  assert(/8:00 AM/.test(inside.detail) && /8:00 PM/.test(inside.detail), "and the day's open window it fell inside");
  assert(/not paused|nothing was paused/i.test(inside.detail), "and says booking was left alone");
  const clear = judgeDrillClock(seeded(), at("2026-10-20T03:30:00"));
  const unreadable = judgeDrillClock({ ok: false, reason: "timeout" }, at("2026-10-20T03:30:00"));
  assert(/could not/i.test(unreadable.detail) && /not paused|nothing was paused/i.test(unreadable.detail), "unreadable says it could not check and paused nothing");

  const lines = [inside, clear, unreadable].map(drillClockSummaryLine);
  eq(new Set(lines).size, 3, "each answer writes its own job summary line");
  for (const line of lines) {
    assert(PLAIN.test(line), `summary line is plain ASCII: ${JSON.stringify(line)}`);
    assert(!/undefined|NaN|\[object Object\]/.test(line), "summary line renders no placeholder leak");
  }
  for (const d of [inside, clear, unreadable]) assert(PLAIN.test(d.detail), `detail is plain ASCII: ${JSON.stringify(d.detail)}`);
  assert(/skipped/i.test(drillClockSummaryLine(inside)), "the skip's summary line says it skipped");
}

// --- the exceptions read reaches back to yesterday --------------------------------
// The midnight cases above need yesterday's exception, so the read must start there.
eq(exceptionsConsultedFrom(at("2026-10-20T00:15:00")), "2026-10-19", "the exceptions read starts at yesterday in the org's zone");
eq(exceptionsConsultedFrom(Number.NaN), null, "and an unreadable clock names no date rather than a guessed one");

// --- the reads the command makes ---------------------------------------------------
// Driven through injected readers, because the command's own are the booker's database
// reads. Every way the read can fail must come back as unreadable, never as a week.
{
  const now = at("2026-10-20T00:15:00");
  const asked: string[] = [];
  const good = await readOrgHours(now, {
    loadRows: async () => [],
    loadExceptions: async (from) => {
      asked.push(from);
      return [shut("2026-10-19")];
    },
    resolve: (_rows, exceptions) => ({ zone: BUSINESS_ZONE, rules: SEEDED_BUSINESS_HOURS, exceptions }),
  });
  eq(asked.join(","), "2026-10-19", "the exceptions are read from yesterday in the org's zone");
  assert(good.ok && good.hours.exceptions.length === 1, "and what was read reaches the judgement");

  const rowsFail = await readOrgHours(now, {
    loadRows: async () => {
      throw new Error("business_hours: connection refused");
    },
    loadExceptions: async () => [],
    resolve: () => ({ zone: BUSINESS_ZONE, rules: SEEDED_BUSINESS_HOURS, exceptions: [] }),
  });
  assert(!rowsFail.ok && rowsFail.reason.includes("connection refused"), "a failed week read is unreadable, carrying its reason");
  eq(judgeDrillClock(rowsFail, at("2026-10-20T03:30:00")).kind, "hours-unreadable", "and the drill stands down on it, at an hour that would otherwise be clear");

  const exceptionsFail = await readOrgHours(now, {
    loadRows: async () => [],
    loadExceptions: async () => {
      throw new Error("business_hours_exceptions: timeout");
    },
    resolve: () => ({ zone: BUSINESS_ZONE, rules: SEEDED_BUSINESS_HOURS, exceptions: [] }),
  });
  assert(!exceptionsFail.ok, "a failed exceptions read is unreadable too: a closed date nobody could read must not read as open");

  const refused = await readOrgHours(now, {
    loadRows: async () => [],
    loadExceptions: async () => [],
    resolve: () => {
      throw new Error("business hours are unusable: weekday 9");
    },
  });
  assert(!refused.ok && refused.reason.includes("unusable"), "a week the resolver refuses is unreadable rather than replaced by a default");

  const noClock = await readOrgHours(Number.NaN, {
    loadRows: async () => [],
    loadExceptions: async () => [],
    resolve: () => ({ zone: BUSINESS_ZONE, rules: SEEDED_BUSINESS_HOURS, exceptions: [] }),
  });
  assert(!noClock.ok, "an unreadable clock reads nothing and is unreadable");
}

// --- the job summary line ------------------------------------------------------------
{
  const written: string[] = [];
  const ok = appendStepSummary("/summary", "line one", (_p, t) => written.push(t));
  assert(ok.written && written[0] === "line one\n", "a summary line is appended with its newline");
  const none = appendStepSummary(undefined, "line", () => {
    throw new Error("must not be called");
  });
  assert(!none.written && none.why.length > 0, "with no summary path nothing is written, and it says why");
  const broken = appendStepSummary("/summary", "line", () => {
    throw new Error("EACCES");
  });
  assert(!broken.written && broken.why.includes("EACCES"), "a write that fails is reported rather than thrown, so the run still records its verdict");
}

finish();
