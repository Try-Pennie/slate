// Booking pace on Team capacity (#4102): a half hourly reading of each day's calls open and how
// many were taken since the last reading.
//
// The rules a wrong answer would hide behind a plausible number:
//  - taken is the drop in calls open, judged at the EARLIER reading's instant against the calendar
//    as it is now, so time passing cancels and a booking for the very next times still counts;
//  - an advisor whose capacity changed between readings (hours, time off, office hours) is left out
//    by the capacity fingerprint, even when the count happens to come out the same;
//  - when too little of the team can be compared, taken is unknown (null with its reason), never 0,
//    and above the floor it is scaled from the comparable advisors to the counted team;
//  - a rerun of the same half hour writes nothing, even after the calendar changed;
//  - a failed read writes nothing.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-capacity-fill.ts
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";
import type { BusinessHoursRules, MemberAvailability } from "../src/lib/availability/compute.ts";
import { advisorDay, capacityStarts, dayTotals, type CapacityEventType } from "../src/lib/admin/team-capacity.ts";
import type { CapacityPeople } from "../src/lib/admin/team-capacity-load.ts";
import { BUSY_PRUNE_KEEP_PAST_HOURS } from "../src/lib/busy/prune-core.ts";
import {
  COMPARABLE_SHARE_FLOOR,
  FILL_MAX_INTERVAL_MS,
  capacityFingerprint,
  fillReadAt,
  fillReadings,
  officeSlot,
  runFillTick,
  type FillLast,
  type FillReadingRow,
  type FillSnapshot,
  type FillTickDeps,
  type FillWrite,
} from "../src/lib/admin/capacity-fill.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const hours: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
// The live setting on 2026-10-22: 20 minute calls on a 10 minute grid, a 10 minute gap each side,
// 5 minutes' notice, no daily cap.
const ev: CapacityEventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };
const TUE = "2026-10-20";
const WED = "2026-10-21";
const at = (hm: string, iso = TUE) => DateTime.fromISO(`${iso}T${hm}`, { zone: ZONE }).toMillis();
const block = (from: string, to: string, iso = TUE) => ({ start: at(from, iso), end: at(to, iso) });
const NINE_TO_FIVE = [2, 3].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 }));
const member = (userId: string, busy: { start: number; end: number }[] = [], rules = NINE_TO_FIVE): MemberAvailability => ({
  userId,
  timezone: ZONE,
  rules,
  busy,
  bookingStartsMs: [],
  dayCounts: new Map(),
});
const people = (members: MemberAvailability[], opts: { failing?: string[]; timeOff?: CapacityPeople["timeOff"] } = {}): CapacityPeople => ({
  roster: members.map((m) => ({ id: m.userId, name: m.userId, email: `${m.userId}@x.test` })),
  members,
  timeOff: opts.timeOff ?? new Map(),
  failingEmails: new Set((opts.failing ?? []).map((id) => `${id}@x.test`)),
});
const read = (readAtMs: number, ppl: CapacityPeople, last: Map<string, FillLast> = new Map(), days = [TUE], hrs = hours) =>
  fillReadings({ readAtMs, windowDays: days, bookerDays: days, hours: hrs, eventType: ev, people: ppl, last });
const lastOf = (r: ReturnType<typeof read>, readAtMs: number): Map<string, FillLast> =>
  new Map(r.last.map((l) => [l.day, { readAtMs, snapshot: l.snapshot }]));
const row = (r: ReturnType<typeof read>, day = TUE) => {
  const found = r.rows.find((x) => x.day === day);
  if (!found) throw new Error(`no reading for ${day}`);
  return found;
};
/** The open count the booker's own rules give one advisor on a day at an instant: the oracle. */
const openAt = (m: MemberAvailability, nowMs: number, iso = TUE) =>
  advisorDay({ member: m, timeOff: [], day: DateTime.fromISO(iso, { zone: ZONE }).startOf("day"), eventType: ev, hours, nowMs }).open;

// --- the half hour a run reads, and where it falls in the office's day ----------------------------
{
  eq(fillReadAt(at("12:08")), at("12:00"), "the 12:08 run reads at 12:00");
  eq(fillReadAt(at("12:38")), at("12:30"), "the 12:38 run reads at 12:30");
  eq(fillReadAt(at("12:30")), at("12:30"), "a run on the half hour reads at it");
  eq(officeSlot(at("12:00"), ZONE), { slotOfDay: 24, weekday: 2 }, "noon on a Tuesday is half hour 24, weekday 2, in the office's zone");
  eq(officeSlot(at("00:00", WED), ZONE), { slotOfDay: 0, weekday: 3 }, "midnight starts the next day at half hour 0");
  // 2026-11-01 the clocks go back at 2:00 EDT: 01:30 happens twice, and both are half hour 3.
  const firstHalf = DateTime.fromISO("2026-11-01T01:30:00-04:00").toMillis();
  const secondHalf = DateTime.fromISO("2026-11-01T01:30:00-05:00").toMillis();
  eq([officeSlot(firstHalf, ZONE), officeSlot(secondHalf, ZONE)], [{ slotOfDay: 3, weekday: 7 }, { slotOfDay: 3, weekday: 7 }], "on the day the clocks go back, both 01:30s are the office's half hour 3");
  assert(FILL_MAX_INTERVAL_MS < BUSY_PRUNE_KEEP_PAST_HOURS * 3_600_000, "a late run never reaches back into busy time the prune has removed");
  eq(COMPARABLE_SHARE_FLOOR, 0.8, "the comparable share floor starts at 80%");
}

// --- the capacity fingerprint ----------------------------------------------------------------
{
  const m = member("u1");
  const input = { member: m, timeOff: [], day: DateTime.fromISO(TUE, { zone: ZONE }).startOf("day"), eventType: ev, hours, nowMs: at("11:30") };
  eq(capacityStarts(input).length, advisorDay(input).capacity, "the capacity starts are the ones advisorDay counts");
  const a = capacityFingerprint(capacityStarts(input));
  eq(capacityFingerprint(capacityStarts(input)), a, "the same starts give the same fingerprint");
  const moved = capacityStarts({ ...input, member: member("u1", [], NINE_TO_FIVE.map((r) => ({ ...r, start_minute: 10 * 60, end_minute: 18 * 60 }))) });
  assert(capacityFingerprint(moved) !== a, "moved hours give a different fingerprint");
  assert(capacityFingerprint([]) !== capacityFingerprint(["2026-10-20T16:00:00.000Z"]), "an empty day differs from a one call day");
}

// --- taken is the drop in open, judged at the earlier instant -----------------------------------
{
  // Time passing alone: nobody books between 11:30 and 12:00.
  const m = member("u1");
  const first = read(at("11:30"), people([m]));
  eq(row(first).taken, null, "the first reading of a day has nothing to compare with");
  eq(row(first).taken_reason, "first-reading", "and says so");
  const second = read(at("12:00"), people([m]), lastOf(first, at("11:30")));
  eq(row(second).taken, 0, "time passing alone takes nothing on today");
  // The fixture would catch the later instant mistake: 11:40 passed between the readings.
  assert(openAt(m, at("11:30")) - openAt(m, at("12:00")) > 0, "comparing at the later instant would have counted the passing call as taken");
  eq(row(second).prev_read_at, new Date(at("11:30")).toISOString(), "the reading names the instant it was compared from");

  // A booking for the very next time, made between the readings: the 11:40 call.
  const booked = member("u1", [block("11:40", "12:00")]);
  const next = read(at("12:00"), people([booked]), lastOf(first, at("11:30")));
  eq(row(next).taken, 1, "a booking for the very next time is counted, though it has started by the next reading");

  // An off grid booking at 14:20 takes two of the packed calls.
  const offGrid = member("u1", [block("14:20", "14:40")]);
  const want = openAt(m, at("11:30")) - openAt(offGrid, at("11:30"));
  eq(want, 2, "the fixture: one booking off the packing grid leaves two fewer calls that fit");
  eq(row(read(at("12:00"), people([offGrid]), lastOf(first, at("11:30")))).taken, 2, "taken is the drop in open, not one per booking");

  // A cancellation gives the time back.
  const wasBooked = read(at("11:30"), people([member("u1", [block("13:10", "13:30")])]));
  eq(row(read(at("12:00"), people([m]), lastOf(wasBooked, at("11:30")))).taken, -1, "a cancellation is negative");

  // A missed run: the readings an hour apart still measure, with a booking at 11:40 made in it.
  const hourAgo = read(at("11:00"), people([m]));
  const late = read(at("12:00"), people([booked]), lastOf(hourAgo, at("11:00")));
  eq([row(late).taken, row(late).taken_reason, row(late).prev_read_at], [1, null, new Date(at("11:00")).toISOString()], "a 60 minute gap still measures, from the instant it was read");

  // Too long: past a day, the earlier calendar may already be pruned.
  const old = read(at("11:30") - FILL_MAX_INTERVAL_MS - 30 * MIN, people([m]), new Map(), [TUE]);
  const stale = read(at("12:00"), people([m]), lastOf(old, at("11:30") - FILL_MAX_INTERVAL_MS - 30 * MIN));
  eq([row(stale).taken, row(stale).taken_reason], [null, "too-long-since"], "a reading more than a day after the last is not compared");
  eq(stale.last.length, 1, "and the snapshot still moves on, so the next one measures");
}

// --- the comparable share, the floor and the scaling ------------------------------------------
{
  const five = ["a", "b", "c", "d", "e"].map((id) => member(id, [], NINE_TO_FIVE));
  const prev = read(at("11:30", WED) - 86_400_000, people(five), new Map(), [WED]);
  const prevLast = lastOf(prev, at("11:30", WED) - 86_400_000);
  const nowMs = at("12:00", WED) - 86_400_000;

  // a's Wednesday moves an hour later: the same sixteen calls, at other times. b takes one booking.
  const movedA = member("a", [], [NINE_TO_FIVE[0], { weekday: 3, start_minute: 10 * 60, end_minute: 18 * 60 }]);
  eq(openAt(movedA, nowMs, WED), openAt(five[0], nowMs, WED), "the fixture: a's moved day holds the same count of calls");
  const bookedB = member("b", [block("09:00", "09:20", WED)]);
  const moved = read(nowMs, people([movedA, bookedB, ...five.slice(2)]), prevLast, [WED]);
  const r = row(moved, WED);
  eq(r.excluded_capacity_changed, 1, "a same count hours move is excluded by the fingerprint");
  eq(r.comparable_share, 0.8, "four of five equal shifts can be compared");
  eq(r.taken, 1.25, "one call taken among four comparable advisors is scaled to the counted five");
  eq(r.taken_reason, null, "at the floor, taken is measured");

  // An office hours edit changes every advisor's capacity: unknown, never 0.
  const edited: BusinessHoursRules = { ...hours, rules: hours.rules.map((x) => ({ ...x, start_minute: 10 * 60 })) };
  const orgWide = row(read(nowMs, people(five), prevLast, [WED], edited), WED);
  eq([orgWide.taken, orgWide.taken_reason, orgWide.comparable_share, orgWide.excluded_capacity_changed], [null, "too-few-comparable", 0, 5], "an office hours edit gives null with its reason, never 0");

  // A bulk time off approval: three of five off for the afternoon.
  const afternoon = { startMs: at("13:00", WED), endMs: at("17:00", WED) };
  const timeOff = new Map(["a", "b", "c"].map((id) => [id, [afternoon]]));
  const bulk = row(read(nowMs, people(five, { timeOff }), prevLast, [WED]), WED);
  eq([bulk.taken, bulk.taken_reason, bulk.excluded_capacity_changed], [null, "too-few-comparable", 3], "a bulk time off approval gives null, never 0");

  // An advisor whose calendar stopped syncing is left out of the comparison and of the snapshot.
  const notSyncing = read(nowMs, people(five, { failing: ["e"] }), prevLast, [WED]);
  const ns = row(notSyncing, WED);
  eq([ns.excluded_not_syncing, ns.taken, ns.comparable_share], [1, 0, 0.8], "a not syncing advisor is excluded and the rest still measure");
  assert(!("e" in notSyncing.last[0].snapshot), "and is left out of the snapshot the next reading compares with");

  // An advisor who left the pool between readings.
  const left = row(read(nowMs, people(five.slice(0, 4)), prevLast, [WED]), WED);
  eq([left.excluded_left_pool, left.comparable_share, left.taken], [1, 0.8, 0], "an advisor who left the pool is excluded");

  // Under the floor by one advisor in five plus one: three of four comparable is 75%.
  const four = five.slice(0, 4);
  const prev4 = lastOf(read(at("11:30", WED) - 86_400_000, people(four), new Map(), [WED]), at("11:30", WED) - 86_400_000);
  const under = row(read(nowMs, people(four, { failing: ["d"] }), prev4, [WED]), WED);
  eq([under.taken, under.taken_reason, under.comparable_share], [null, "too-few-comparable", 0.75], "three of four comparable is under the floor");
}

// --- what a reading and a snapshot hold -------------------------------------------------------
{
  const out = new Map([["c", [{ startMs: at("00:00"), endMs: at("00:00", WED) }]]]);
  const r = read(at("12:00"), people([member("a"), member("b", [block("13:00", "14:00")]), member("c")], { timeOff: out, failing: ["b"] }), new Map(), [TUE, WED]);
  const tue = row(r, TUE);
  const totals = dayTotals(
    [member("a"), member("b")].map((m, i) => ({
      unsynced: i === 1,
      days: [advisorDay({ member: m, timeOff: [], day: DateTime.fromISO(TUE, { zone: ZONE }).startOf("day"), eventType: ev, hours, nowMs: at("12:00") })],
    })),
    0,
  );
  eq([tue.open, tue.capacity], [totals.open, totals.capacity], "open and capacity are the page's day totals: an out or not syncing advisor counts in neither");
  eq(Object.keys(r.last.find((l) => l.day === TUE)!.snapshot), ["a"], "the snapshot holds only counted advisors");
  eq([tue.day_position, row(r, WED).day_position], [0, 1], "each day's position among the booker's days");
  eq([tue.slot_of_day, tue.weekday], [24, 2], "the half hour and weekday of the reading in the office's zone");
  const afterCutoff = fillReadings({ readAtMs: at("19:00"), windowDays: [TUE, WED], bookerDays: [WED], hours, eventType: ev, people: people([member("a")]), last: new Map() });
  eq([row(afterCutoff, TUE).day_position, row(afterCutoff, WED).day_position], [null, 0], "today after the cutoff is on the page but is none of the booker's days");
  let threw = false;
  try {
    fillReadings({ readAtMs: at("12:00"), windowDays: [TUE], bookerDays: [TUE], hours, eventType: ev, people: { ...people([member("a")]), members: [] }, last: new Map() });
  } catch {
    threw = true;
  }
  assert(threw, "an availability read missing an advisor is a failed read, never an advisor with no room");
}

// --- one run against its reads and its write ----------------------------------------------------
{
  /**
   * The database as record_capacity_fill leaves it: readings inserted on conflict do nothing, and
   * the snapshots written only when the org's latest snapshot is still the one the run read from and
   * the run's half hour is later than it.
   */
  const makeStore = () => {
    const readings = new Map<string, FillReadingRow & { read_at: string }>();
    const last = new Map<string, FillLast>();
    const latest = () => (last.size ? Math.max(...[...last.values()].map((l) => l.readAtMs)) : null);
    const write = async (w: FillWrite): Promise<boolean> => {
      const now = latest();
      if (now !== w.prevReadAtMs || (now !== null && w.readAtMs <= now)) return false;
      for (const r of w.rows) {
        const key = `${w.readAtMs}|${r.day}`;
        if (!readings.has(key)) readings.set(key, { ...r, read_at: new Date(w.readAtMs).toISOString() });
      }
      for (const l of w.last) {
        const prev = last.get(l.day);
        if (!prev || prev.readAtMs < w.readAtMs) last.set(l.day, { readAtMs: w.readAtMs, snapshot: l.snapshot });
      }
      return true;
    };
    return { readings, last, latest, write };
  };
  const office = { hours, eventType: ev };
  let calendar = [member("u1")];
  const writes: FillWrite[] = [];
  const store = makeStore();
  const deps = (nowMs: number, over: Partial<FillTickDeps> = {}): FillTickDeps => ({
    nowMs,
    loadRules: async () => ({ ok: true, value: office }),
    readOfferedDays: async () => 2,
    readLast: async (days) => ({ latestReadAtMs: store.latest(), byDay: new Map([...store.last].filter(([d]) => days.includes(d))) }),
    loadPeople: async () => ({ ok: true, value: people(calendar) }),
    write: async (w) => {
      writes.push(w);
      return store.write(w);
    },
    ...over,
  });
  const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));

  const first = await runFillTick(deps(at("11:38")));
  eq([first.state, first.wrote, first.readAtMs, first.days], ["recorded", true, at("11:30"), [TUE, WED]], "the first run reads at 11:30 and writes");
  eq(store.readings.size, 2, "one reading per page day");
  eq([...store.readings.values()].map((r) => r.taken_reason), ["first-reading", "first-reading"], "with nothing to compare against yet");
  eq(store.last.size, 2, "and a snapshot per day for the next run");

  calendar = [member("u1", [block("11:40", "12:00")])];
  const second = await runFillTick(deps(at("12:08")));
  eq([second.state, second.wrote], ["recorded", true], "the next half hour writes");
  const noon = store.readings.get(`${at("12:00")}|${TUE}`)!;
  eq([noon.taken, noon.prev_read_at], [1, new Date(at("11:30")).toISOString()], "and measures the booking made since 11:30");
  eq(writes.at(-1)!.prevReadAtMs, at("11:30"), "against the snapshot it read");

  // A rerun of the 12:00 half hour after the calendar changed again leaves every row as it was.
  const before = JSON.stringify([[...store.readings], [...store.last]]);
  calendar = [member("u1", [block("11:40", "12:00"), block("13:10", "13:30")])];
  const writesBefore = writes.length;
  const rerun = await runFillTick(deps(at("12:20")));
  eq([rerun.state, rerun.wrote], ["already-recorded", false], "a rerun of the same half hour records nothing");
  eq(writes.length, writesBefore, "and does not even try to write");
  eq(JSON.stringify([[...store.readings], [...store.last]]), before, "every reading and snapshot is unchanged after the calendar changed");
  // Even a write that got past the run's own check is refused by the store's.
  const forced = await store.write({ readAtMs: at("12:00"), prevReadAtMs: at("12:00"), rows: [], last: [{ day: TUE, snapshot: {} }] });
  eq([forced, JSON.stringify([[...store.readings], [...store.last]])], [false, before], "the record refuses a second write of a half hour it holds");
  const raced = await store.write({ readAtMs: at("12:30"), prevReadAtMs: at("11:30"), rows: [], last: [{ day: TUE, snapshot: {} }] });
  eq([raced, JSON.stringify([[...store.readings], [...store.last]])], [false, before], "and a write from a run that read an older snapshot");

  // Failed reads write nothing.
  const failures: [string, Partial<FillTickDeps>][] = [
    ["office hours", { loadRules: async () => ({ ok: false, reason: "business-hours", err: new Error("boom") }) }],
    ["the days offered", { readOfferedDays: async () => null }],
    ["the days offered (throws)", { readOfferedDays: async () => { throw new Error("refused"); } }],
    ["the last readings", { readLast: async () => { throw new Error("refused"); } }],
    ["calendars", { loadPeople: async () => ({ ok: false, reason: "calendars", err: new Error("boom") }) }],
    ["time off", { loadPeople: async () => ({ ok: false, reason: "time-off", err: new Error("boom") }) }],
    ["calendar sync", { loadPeople: async () => ({ ok: false, reason: "calendar-sync" }) }],
    ["roster", { loadPeople: async () => ({ ok: false, reason: "roster", err: new Error("boom") }) }],
  ];
  for (const [name, over] of failures) {
    const n = writes.length;
    const msg = await rejects(runFillTick(deps(at("12:38"), over)));
    assert(msg !== null, `a failed read of ${name} fails the run`);
    eq(writes.length, n, `and writes nothing (${name})`);
  }
  const refused = await rejects(runFillTick(deps(at("12:38"), { write: async () => { throw new Error("write refused"); } })));
  assert(refused !== null, "a refused write fails the run");

  // States, not failures: nothing to measure, nothing written, and the run is still healthy.
  const n = writes.length;
  const nobody = await runFillTick(deps(at("12:38"), { loadPeople: async () => ({ ok: false, reason: "no-advisors" }) }));
  eq([nobody.state, nobody.wrote, writes.length], ["no-advisors", false, n], "nobody bookable writes nothing");
  const closed = await runFillTick(deps(at("12:38"), { loadRules: async () => ({ ok: true, value: { hours: { ...hours, rules: [] }, eventType: ev } }) }));
  eq([closed.state, closed.wrote, writes.length], ["no-open-days", false, n], "an office week with no open day writes nothing");

  // Another run got there first: said, not thrown.
  const lost = await runFillTick(deps(at("12:38"), { write: async () => false }));
  eq([lost.state, lost.wrote], ["lost-race", false], "a write the record refused is reported as another run's");
}

// A snapshot's type, so the fixture above cannot drift from what the store parses.
const _shape: FillSnapshot = { u1: { open: 1, capacity: 2, fp: "x" } };
void _shape;

finish();
