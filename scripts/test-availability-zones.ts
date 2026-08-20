// #1316: the three availability gates, for an agent and a booker who are NOT in
// the org's timezone.
//
// Slate judges the ORG's business window and the AGENT's working hours in their OWN
// zones and never intersects them. CLAUDE.md records why, and records the exposure
// with it: clipping would be correct only for an agent in the business zone, and
// every live agent is Eastern, so **no production data can tell a correct
// implementation from a broken one**. That is a blind spot, not a known defect.
//
// It acquired a reason to close on 2026-08-06, when cal.com refused more than fifty
// bookings because the times its booker offered were not really free, and the first
// question asked was whether a timezone-based restriction had changed. A zone bug
// produces exactly that symptom: times shown to a customer that are not real.
//
// So this suite is built around instants where the correct answer and the plausible
// wrong one DISAGREE. A case both implementations refuse proves nothing, and most
// obvious zone tests are that kind. The two discriminators, straight from the
// comment in compute.ts:
//
//   1. a morning that is really inside the org's day, which minute-clipping refuses;
//   2. an evening that is really past the org's close, which minute-clipping admits.
//
// Every wall-clock claim here is ASSERTED rather than assumed. A fixture whose
// arithmetic is wrong tests a case that does not exist while passing forever (L48),
// and timezone arithmetic done by hand in a comment is exactly where that happens.
//
// WHAT LIVES WHERE, so a third copy of this reasoning does not appear. Gate 1's own
// suite, scripts/test-business-hours-gate.ts, already covers a Pacific agent against
// the seeded org week and the off-cycle DST gap, from the same non-Eastern angle.
// This file exists for the cases it does not reach: the org's day spanning two of the
// agent's local WEEKDAYS, the spring-forward hour that does not exist, the booker's
// zone being display only, and an agent whose entire working day is the org's night.
// Check both before adding a case to either.
//
// Run: node --experimental-strip-types scripts/test-availability-zones.ts
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  type BusinessHoursRules,
  type MemberAvailability,
  type SlotRules,
  type WorkingRule,
} from "../src/lib/availability/compute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG_ZONE = "America/New_York";

/** A member with no calendar conflicts and no cap: only the two hour gates apply. */
function agent(timezone: string, rules: WorkingRule[]): Pick<
  MemberAvailability,
  "timezone" | "rules" | "busy" | "bookingStartsMs"
> {
  return { timezone, rules, busy: [], bookingStartsMs: [] };
}

function hours(zone: string, weekday: number, startMin: number, endMin: number): BusinessHoursRules {
  // #1363: no date exceptions here; this suite is about the two hour gates and
  // their zones, and a date override would answer for the weekday rule.
  return { zone, rules: [{ weekday, start_minute: startMin, end_minute: endMin }], exceptions: [] };
}

function slotRules(businessHours: BusinessHoursRules, durationMin = 30): SlotRules {
  return {
    durationMin,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    // Zero notice: this suite is about the hour gates, and a notice window would
    // silently answer "min_notice" for every case and prove nothing.
    minNoticeMin: 0,
    dailyCap: null,
    businessHours,
  };
}

const HHMM = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toFormat("ccc HH:mm");
/** An instant, from a wall clock reading in a named zone. */
const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toMillis();
const weekdayOf = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).weekday;

// A moment long before every instant below, so `min_notice` never fires.
const LONG_AGO = at("2026-01-01T00:00", ORG_ZONE);

// =====================================================================
// 1. A Pacific agent against an Eastern business window
// =====================================================================
{
  const DAY = "2026-08-10"; // a summer Monday: both US zones are on DST
  const weekday = weekdayOf(DAY, ORG_ZONE);
  eq(weekday, 1, `${DAY} is a Monday in the org's zone (the fixture's own arithmetic, checked)`);

  // Org open 09:00 to 17:00 Eastern. Agent works 08:00 to 16:00 PACIFIC, which is
  // 11:00 to 19:00 Eastern: overlapping the org's day, but offset from it.
  const org = hours(ORG_ZONE, weekday, 9 * 60, 17 * 60);
  const pacific = agent("America/Los_Angeles", [
    { weekday, start_minute: 8 * 60, end_minute: 16 * 60 },
  ]);
  const rules = slotRules(org);

  // Confirm the offset the whole case rests on, so a DST rule change in either
  // zone makes this test say so rather than quietly testing something else.
  const noon = at(`${DAY}T12:00`, ORG_ZONE);
  eq(
    DateTime.fromMillis(noon, { zone: "America/Los_Angeles" }).hour,
    9,
    "the two US zones are three hours apart on this date",
  );

  // --- DISCRIMINATOR 1: a morning that is really inside the org's day ------
  // 08:00 Pacific is 11:00 Eastern, comfortably inside the org's 09:00 to 17:00.
  // Clipping the agent's minutes against the org's (start = max(08:00, 09:00) read
  // as 09:00 LOCAL) would refuse this, and it would look like a correct guard.
  {
    const startMs = at(`${DAY}T08:00`, "America/Los_Angeles");
    eq(HHMM(startMs, ORG_ZONE), "Mon 11:00", "08:00 Pacific really is 11:00 Eastern");
    eq(
      bookableSlotReason(pacific, rules, startMs, LONG_AGO),
      null,
      "#1316: an agent's early morning that falls inside the org's day IS bookable",
    );
  }

  // --- DISCRIMINATOR 2: an evening that is really past the org's close ------
  // 15:30 Pacific is 18:30 Eastern. The agent is on shift until 16:00 their time,
  // and minute-clipping (end = min(16:00, 17:00) read as 16:00 LOCAL) would ADMIT
  // this: a time offered to a customer when the org is shut.
  {
    const startMs = at(`${DAY}T15:30`, "America/Los_Angeles");
    eq(HHMM(startMs, ORG_ZONE), "Mon 18:30", "15:30 Pacific really is 18:30 Eastern");
    eq(
      bookableSlotReason(pacific, rules, startMs, LONG_AGO),
      "business_hours",
      "#1316: an agent still on shift after the ORG has closed is refused, and named as the org's closure",
    );
  }

  // The two gates give DIFFERENT answers, which is the point of keeping them apart.
  {
    const beforeShift = at(`${DAY}T07:00`, "America/Los_Angeles"); // 10:00 Eastern
    eq(
      bookableSlotReason(pacific, rules, beforeShift, LONG_AGO),
      "working_hours",
      "the org is open but this agent is not yet on shift, which is a roster answer, not an org one",
    );
  }

  // The boundaries themselves, since a slot must FIT entirely inside both windows.
  {
    const endsExactlyAtOrgClose = at(`${DAY}T13:30`, "America/Los_Angeles"); // 16:30 ET
    eq(
      bookableSlotReason(pacific, rules, endsExactlyAtOrgClose, LONG_AGO),
      null,
      "a slot ending exactly at the org's closing time fits",
    );
    const overrunsOrgClose = at(`${DAY}T13:45`, "America/Los_Angeles"); // 16:45 ET, ends 17:15
    eq(
      bookableSlotReason(pacific, rules, overrunsOrgClose, LONG_AGO),
      "business_hours",
      "a slot that would END after the org closes is refused, not merely one that starts late",
    );
  }
}

// =====================================================================
// 2. The org's day spanning TWO of the agent's local weekdays
// =====================================================================
// The sharpest case, and one no amount of same-zone reasoning gets right. Tokyo is
// thirteen hours ahead of Eastern in summer, so the org's Monday afternoon is the
// agent's Tuesday morning. An implementation that looked up the agent's rule using
// the ORG's weekday would find no Monday rule and refuse a slot that is genuinely
// inside both windows.
{
  const ORG_DAY = "2026-08-10"; // Monday, Eastern
  const orgWeekday = weekdayOf(ORG_DAY, ORG_ZONE);
  const org = hours(ORG_ZONE, orgWeekday, 9 * 60, 17 * 60);
  const rules = slotRules(org);

  // 05:30 Tuesday in Tokyo. Asserted, not assumed, in both zones.
  const startMs = at("2026-08-11T05:30", "Asia/Tokyo");
  eq(HHMM(startMs, "Asia/Tokyo"), "Tue 05:30", "the instant is Tuesday morning in Tokyo");
  eq(HHMM(startMs, ORG_ZONE), "Mon 16:30", "and the SAME instant is Monday afternoon in the org's zone");

  const tokyoWeekday = DateTime.fromMillis(startMs, { zone: "Asia/Tokyo" }).weekday;
  assert(tokyoWeekday !== orgWeekday, "the agent's weekday and the org's really do differ here");

  const tokyo = agent("Asia/Tokyo", [
    { weekday: tokyoWeekday, start_minute: 5 * 60, end_minute: 7 * 60 },
  ]);
  eq(
    bookableSlotReason(tokyo, rules, startMs, LONG_AGO),
    null,
    "#1316: an agent whose LOCAL weekday differs from the org's is judged on their own day, and this is bookable",
  );

  // And the mirror: the agent's Monday rule must not be read for this instant. If
  // the weekday were taken from the org, this would wrongly pass.
  const tokyoWrongDay = agent("Asia/Tokyo", [
    { weekday: orgWeekday, start_minute: 5 * 60, end_minute: 7 * 60 },
  ]);
  eq(
    bookableSlotReason(tokyoWrongDay, rules, startMs, LONG_AGO),
    "working_hours",
    "an agent rostered on their own Monday is NOT on shift during their Tuesday morning",
  );
}

// =====================================================================
// 3. A DST boundary where only ONE of the two zones has moved (L39)
// =====================================================================
// Between the US and UK clock changes the usual five hour gap is four. An agent in
// London against an Eastern org therefore sits an hour off its normal position for
// about three weeks a year, twice: exactly the window where a hardcoded offset, or a
// window computed once and reused, gives a wrong answer that corrects itself later.
{
  const GAP_DAY = "2026-03-16"; // after the US change (Mar 8), before the UK's (Mar 29)
  const weekday = weekdayOf(GAP_DAY, ORG_ZONE);

  const noon = at(`${GAP_DAY}T12:00`, ORG_ZONE);
  const londonHour = DateTime.fromMillis(noon, { zone: "Europe/London" }).hour;
  eq(londonHour, 16, "during the gap London is FOUR hours ahead of Eastern, not the usual five");
  // The same reading outside the gap, to prove the gap is a real anomaly rather
  // than this test having picked an ordinary date.
  const summerNoon = at("2026-08-10T12:00", ORG_ZONE);
  eq(
    DateTime.fromMillis(summerNoon, { zone: "Europe/London" }).hour,
    17,
    "and five hours ahead once both zones have changed",
  );

  const org = hours(ORG_ZONE, weekday, 9 * 60, 17 * 60);
  const rules = slotRules(org);
  const london = agent("Europe/London", [
    { weekday, start_minute: 13 * 60, end_minute: 21 * 60 },
  ]);

  // 20:30 London is 16:30 Eastern during the gap: inside the org's day.
  const inGap = at(`${GAP_DAY}T20:30`, "Europe/London");
  eq(HHMM(inGap, ORG_ZONE), "Mon 16:30", "20:30 London is 16:30 Eastern during the gap");
  eq(
    bookableSlotReason(london, rules, inGap, LONG_AGO),
    null,
    "#1316: during the DST gap, a late London evening still lands inside the org's afternoon",
  );

  // The same LOCAL time once both zones have changed is 15:30 Eastern, still open,
  // so the case that discriminates is the one an hour later.
  const pastCloseInGap = at(`${GAP_DAY}T21:00`, "Europe/London"); // 17:00 Eastern
  eq(HHMM(pastCloseInGap, ORG_ZONE), "Mon 17:00", "21:00 London is exactly the org's closing time");
  eq(
    bookableSlotReason(london, rules, pastCloseInGap, LONG_AGO),
    "business_hours",
    "a slot starting exactly at the org's close cannot fit inside it",
  );
}

// =====================================================================
// 4. The hour that does not exist (spring forward, in the AGENT's zone)
// =====================================================================
// On the US spring-forward morning, 02:00 to 03:00 local never happens. A working
// rule covering it must not admit a slot that has no instant, and must not throw.
{
  const SPRING = "2026-03-08"; // US clocks go forward at 02:00 local
  const weekday = weekdayOf(SPRING, ORG_ZONE);

  // Prove the hour really is missing on this date, or the case below is vacuous.
  const twoAm = DateTime.fromISO(`${SPRING}T02:30`, { zone: ORG_ZONE });
  assert(
    !twoAm.isValid || twoAm.hour !== 2,
    "02:30 does not exist in the org's zone on the spring-forward date",
  );

  // The org is open across the whole morning; the agent is rostered 01:00 to 05:00.
  const org = hours(ORG_ZONE, weekday, 0, 23 * 60 + 59);
  const rules = slotRules(org);
  const eastern = agent(ORG_ZONE, [{ weekday, start_minute: 60, end_minute: 5 * 60 }]);

  // 01:30 exists, 03:30 exists, and the wall clock jumps straight between them.
  const before = at(`${SPRING}T01:30`, ORG_ZONE);
  const after = at(`${SPRING}T03:30`, ORG_ZONE);
  eq((after - before) / 60000, 60, "only one real hour separates 01:30 and 03:30 that morning");

  eq(bookableSlotReason(eastern, rules, before, LONG_AGO), null, "01:30 is bookable");
  eq(bookableSlotReason(eastern, rules, after, LONG_AGO), null, "03:30 is bookable");
}

// =====================================================================
// 5. The BOOKER's timezone is not an input to any gate
// =====================================================================
// A customer's zone decides how a time is displayed, never whether it is offered.
// This is worth pinning because it is the assumption cal.com's incident turned on,
// and because the gates take an instant, so nothing about the reader can reach them.
{
  const DAY = "2026-08-10";
  const weekday = weekdayOf(DAY, ORG_ZONE);
  const org = hours(ORG_ZONE, weekday, 9 * 60, 17 * 60);
  const rules = slotRules(org);
  const eastern = agent(ORG_ZONE, [{ weekday, start_minute: 9 * 60, end_minute: 17 * 60 }]);

  const startMs = at(`${DAY}T14:00`, ORG_ZONE);
  const verdict = bookableSlotReason(eastern, rules, startMs, LONG_AGO);
  eq(verdict, null, "the slot is bookable");

  // The same instant, read by customers in four zones. Each sees a different wall
  // clock; none of them changes the verdict, because the verdict is about an instant.
  const readings = ["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"].map(
    (zone) => HHMM(startMs, zone),
  );
  eq(new Set(readings).size, 4, "the four customers really do see four different wall clocks");
  for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
    eq(
      bookableSlotReason(eastern, rules, startMs, LONG_AGO),
      verdict,
      `a customer in ${zone} is offered exactly the same instant (their zone is display, not a gate)`,
    );
  }
}

// =====================================================================
// 6. The gates are independent, not an intersection, at the extremes
// =====================================================================
// The property in one line: a slot needs BOTH windows to contain it, each judged
// where it lives. So an agent whose whole shift sits outside the org's day is never
// bookable, however long their shift is, and an org whose whole day sits outside the
// agent's shift is never bookable either. Neither is expressible as one window.
{
  const DAY = "2026-08-10";
  const weekday = weekdayOf(DAY, ORG_ZONE);
  const org = hours(ORG_ZONE, weekday, 9 * 60, 17 * 60);
  const rules = slotRules(org);

  // A Tokyo agent working their own 09:00 to 17:00: entirely the org's night.
  const tokyoDayShift = agent("Asia/Tokyo", [
    { weekday: weekdayOf("2026-08-11", "Asia/Tokyo"), start_minute: 9 * 60, end_minute: 17 * 60 },
  ]);
  let offered = 0;
  for (let h = 9; h < 17; h++) {
    const ms = at(`2026-08-11T${String(h).padStart(2, "0")}:00`, "Asia/Tokyo");
    if (bookableSlotReason(tokyoDayShift, rules, ms, LONG_AGO) === null) offered++;
  }
  eq(offered, 0, "#1316: an agent whose entire working day is the org's night is offered nothing");

  // And the same agent DOES become bookable when their shift really does overlap,
  // so the zero above is a real refusal rather than the fixture being unbookable
  // for some unrelated reason.
  const tokyoNightShift = agent("Asia/Tokyo", [
    { weekday: weekdayOf("2026-08-11", "Asia/Tokyo"), start_minute: 22 * 60, end_minute: 23 * 60 + 59 },
    { weekday: weekdayOf("2026-08-11", "Asia/Tokyo"), start_minute: 5 * 60, end_minute: 7 * 60 },
  ]);
  const overlapping = at("2026-08-11T05:30", "Asia/Tokyo"); // Mon 16:30 Eastern
  eq(
    bookableSlotReason(tokyoNightShift, rules, overlapping, LONG_AGO),
    null,
    "the same agent on an early shift that overlaps the org's afternoon IS offered that time",
  );
}

finish();
