// The Team capacity calculation (#3935, design docs/design/team-capacity.html, requirement 14).
//
// The rules a wrong answer would hide behind a plausible number:
//  - calls open counts calls that FIT, not open start times, which overlap;
//  - packing them in one pass gives exactly what booking them one at a time would;
//  - approved time off comes off capacity, never counts as taken, so it cannot make
//    a day look fuller; time off covering the whole shift makes the advisor Out;
//  - out and not syncing advisors count in neither total, and the percent rounds
//    down, so it never reads 100 while a call is still open.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-team-capacity.ts
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";
import { computeBucketSlots, type BusinessHoursRules, type MemberAvailability } from "../src/lib/availability/compute.ts";
import {
  advisorDay,
  callsThatFit,
  dayFlag,
  dayTotals,
  teamCapacityReport,
  type CapacityEventType,
} from "../src/lib/admin/team-capacity.ts";

const ZONE = "America/New_York";
const hours: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
const ev: CapacityEventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };
const tue = DateTime.fromISO("2026-10-20", { zone: ZONE }).startOf("day");
const DAY_BEFORE = tue.minus({ days: 1 }).toMillis();
const at = (hm: string) => DateTime.fromISO(`2026-10-20T${hm}`, { zone: ZONE }).toMillis();
const member = (busy: { start: number; end: number }[], rules = [{ weekday: 2, start_minute: 9 * 60, end_minute: 17 * 60 }]): MemberAvailability => ({
  userId: "u1",
  timezone: ZONE,
  rules,
  busy,
  bookingStartsMs: [],
  dayCounts: new Map(),
});
const slotsFor = (m: MemberAvailability, nowMs: number) =>
  computeBucketSlots({
    members: [m], durationMin: ev.duration_min, bufferBeforeMin: ev.buffer_before_min, bufferAfterMin: ev.buffer_after_min,
    minNoticeMin: ev.min_notice_min, dailyCap: ev.daily_cap, slotIntervalMin: ev.slot_interval_min, businessHours: hours,
    from: tue.toUTC().toISO()!, to: tue.plus({ days: 1 }).toUTC().toISO()!, nowMs,
  });

// --- calls that fit, in one pass, equal booking them one at a time ---------------
{
  // The slow, obviously right way: book the earliest open time, recompute, repeat.
  const oneAtATime = (m: MemberAvailability) => {
    const picked: string[] = [];
    let cur = m;
    for (let i = 0; i < 200; i++) {
      const s = slotsFor(cur, DAY_BEFORE);
      if (!s.length) break;
      picked.push(s[0]);
      const t = Date.parse(s[0]);
      cur = { ...cur, busy: [...cur.busy, { start: t, end: t + ev.duration_min * 60_000 }] };
    }
    return picked;
  };
  // A seeded spread of calendars: empty, one block, many short blocks, back to back calls.
  let seed = 3935;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const calendars: { start: number; end: number }[][] = [[], [{ start: at("12:00"), end: at("13:00") }]];
  for (let c = 0; c < 40; c++) {
    const blocks: { start: number; end: number }[] = [];
    for (let b = 0; b < 1 + Math.floor(rand() * 8); b++) {
      const start = at("09:00") + Math.floor(rand() * 48) * 10 * 60_000;
      blocks.push({ start, end: start + (1 + Math.floor(rand() * 6)) * 10 * 60_000 });
    }
    calendars.push(blocks);
  }
  for (const busy of calendars) {
    const m = member(busy);
    eq(callsThatFit(slotsFor(m, DAY_BEFORE), ev), oneAtATime(m), `one pass equals one at a time for ${busy.length} busy blocks`);
  }
  // Uneven gaps: the rule must hold when the gap before a call and the gap after differ.
  for (const [before, after] of [[5, 15], [15, 5], [0, 10], [10, 0]]) {
    const uneven = { ...ev, buffer_before_min: before, buffer_after_min: after };
    const slotsU = (m: MemberAvailability) => computeBucketSlots({
      members: [m], durationMin: uneven.duration_min, bufferBeforeMin: before, bufferAfterMin: after,
      minNoticeMin: uneven.min_notice_min, dailyCap: null, slotIntervalMin: uneven.slot_interval_min, businessHours: hours,
      from: tue.toUTC().toISO()!, to: tue.plus({ days: 1 }).toUTC().toISO()!, nowMs: DAY_BEFORE,
    });
    for (const busy of calendars.slice(0, 15)) {
      const picked: string[] = [];
      let cur = member(busy);
      for (let i = 0; i < 200; i++) {
        const s = slotsU(cur);
        if (!s.length) break;
        picked.push(s[0]);
        const t0 = Date.parse(s[0]);
        cur = { ...cur, busy: [...cur.busy, { start: t0, end: t0 + uneven.duration_min * 60_000 }] };
      }
      eq(callsThatFit(slotsU(member(busy)), uneven), picked, `one pass equals one at a time with ${before} minutes before and ${after} after`);
    }
  }
  // An empty 9 to 5 shift fits 16 calls: 20 minutes each, the 10 minute gap before the next.
  eq(callsThatFit(slotsFor(member([]), DAY_BEFORE), ev).length, 16, "an empty eight hour shift fits 16 calls");
  eq(callsThatFit([], ev), [], "no open times fit no calls");
}

// --- one advisor's day --------------------------------------------------------------
{
  const plain = advisorDay({ member: member([{ start: at("12:00"), end: at("13:00") }]), timeOff: [], day: tue, eventType: ev, hours, nowMs: DAY_BEFORE });
  eq(plain.capacity, 16, "capacity is what the empty shift could hold");
  assert(plain.open < plain.capacity, "a blocked hour leaves fewer calls open than capacity");
  eq(plain.out, false, "an advisor with a shift and no time off is not out");
  eq(plain.noShift, false, "and has a shift");
  eq(plain.openTimes.length, plain.open, "every call counted open has its time");

  const lunchOff = advisorDay({ member: member([]), timeOff: [{ startMs: at("12:00"), endMs: at("13:00") }], day: tue, eventType: ev, hours, nowMs: DAY_BEFORE });
  eq(lunchOff.open, lunchOff.capacity, "approved time off comes off capacity, so the rest of an empty day reads empty, not fuller");
  assert(lunchOff.capacity < 16, "and the hour off is not capacity");
  eq(lunchOff.timeOff.length, 1, "the hour off is kept for drawing");

  const allDay = advisorDay({ member: member([]), timeOff: [{ startMs: at("00:00"), endMs: tue.plus({ days: 1 }).toMillis() }], day: tue, eventType: ev, hours, nowMs: DAY_BEFORE });
  eq(allDay.out, true, "time off covering the whole shift is Out");

  const off = advisorDay({ member: member([], []), timeOff: [], day: tue, eventType: ev, hours, nowMs: DAY_BEFORE });
  eq(off.noShift, true, "working hours holding nothing that day is no shift");
  eq(off.capacity, 0, "with no capacity");

  const capped = advisorDay({
    member: { ...member([]), dayCounts: new Map([["2026-10-20", 1]]) }, timeOff: [], day: tue,
    eventType: { ...ev, daily_cap: 3 }, hours, nowMs: DAY_BEFORE,
  });
  eq([capped.open, capped.capacity], [2, 3], "a daily cap of 3 with one call booked leaves 2 open of 3, not the shift's 16");

  const afternoon = advisorDay({ member: member([]), timeOff: [], day: tue, eventType: ev, hours, nowMs: at("13:00") });
  assert(afternoon.capacity < 16 && afternoon.capacity > 0, "today counts only time still ahead");
  eq(afternoon.fullShiftStart !== null && Date.parse(afternoon.fullShiftStart) < at("13:00"), true, "while the whole shift is still known for drawing");
}

// --- the team's day totals ----------------------------------------------------------
{
  const day = (open: number, capacity: number, out = false) => ({ iso: "2026-10-20", open, capacity, out, noShift: capacity === 0 && !out, openTimes: [], shiftStart: null, shiftEnd: null, fullShiftStart: null, fullShiftEnd: null, timeOff: [] });
  const t = dayTotals([
    { unsynced: false, days: [day(3, 16)] },
    { unsynced: false, days: [day(0, 16)] },
    { unsynced: false, days: [day(0, 0, true)] },
    { unsynced: true, days: [day(10, 16)] },
  ], 0);
  eq([t.open, t.capacity, t.out, t.notCounted], [3, 32, 1, 1], "out and not syncing advisors count in neither total");
  eq(t.fullPct, 90, "90.6% full reads 90");
  eq(dayTotals([{ unsynced: false, days: [day(3, 20)] }], 0).fullPct, 85, "exactly 85% reads 85, never 84 from floating point");
  eq(dayTotals([{ unsynced: false, days: [day(1, 1000)] }], 0).fullPct, 99, "one call left never reads 100");
  eq(dayTotals([{ unsynced: false, days: [day(0, 16)] }], 0).fullPct, 100, "no call left reads 100");
  eq(dayTotals([{ unsynced: false, days: [day(0, 0, true)] }], 0).fullPct, null, "nobody working has no percent, never 0 or 100");

  eq(dayFlag({ open: 0, capacity: 32, fullPct: 100 }, 85), "full", "no calls left is Full");
  eq(dayFlag({ open: 3, capacity: 32, fullPct: 90 }, 85), "nearly-full", "at or over the line is nearly full");
  eq(dayFlag({ open: 20, capacity: 32, fullPct: 37 }, 85), null, "under the line is not flagged");
  eq(dayFlag({ open: 0, capacity: 0, fullPct: null }, 85), null, "a day nobody works is not flagged full");
}

// --- the report, assembled from the reads ---------------------------------------------
{
  const roster = [
    { id: "b", name: "Blake Abbott", email: "blake@x.com" },
    { id: "a", name: "Avery Calder", email: "avery@x.com" },
    { id: "c", name: null, email: "casey@x.com" },
  ];
  const members = [{ ...member([]), userId: "b" }, { ...member([{ start: at("10:00"), end: at("11:00") }]), userId: "a" }, { ...member([], []), userId: "c" }];
  const r = teamCapacityReport({
    days: ["2026-10-20"], roster, members, timeOff: new Map([["b", [{ startMs: at("12:00"), endMs: at("13:00") }]]]),
    failingEmails: new Set(["casey@x.com"]), eventType: ev, hours, nowMs: DAY_BEFORE,
  });
  eq(r.advisors.map((a) => a.name), ["Avery Calder", "Blake Abbott", "casey@x.com"], "advisors are ordered by name, an unnamed one by email");
  eq(r.advisors.map((a) => a.unsynced), [false, false, true], "a calendar not syncing is marked on its advisor");
  eq(r.advisors[1].days[0].timeOff.length, 1, "each advisor gets their own time off");
  let threw = false;
  try {
    teamCapacityReport({ days: ["2026-10-20"], roster: [{ id: "z", name: "Zed", email: "z@x.com" }], members: [], timeOff: new Map(), failingEmails: new Set(), eventType: ev, hours, nowMs: DAY_BEFORE });
  } catch { threw = true; }
  assert(threw, "an advisor the availability read returned no row for is a failed read, never drawn as no shift");
  eq(r.days, ["2026-10-20"], "the days are the ones asked for, in order");
}

finish();
