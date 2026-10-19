// Team capacity history (#3940, design docs/design/team-capacity.html, requirement 15): each
// advisor's calls saved as they pass, so a past day shows how it ended.
//
// The rules a wrong answer would hide behind a plausible number:
//  - recording a day a tick at a time, at any cadence, saves exactly the calls that packing the
//    whole day at once would, so a past day's room left is never counted twice or missed;
//  - a call booked before it passes is never saved as open, and a calendar changed after it passed
//    never rewrites it;
//  - a missed tick is caught up, but never further back than past busy time is kept, because a
//    pruned block would read as open time;
//  - a not syncing advisor's day is marked so, and time off comes off capacity, as on a coming day.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-capacity-history.ts
import { DateTime } from "luxon";
import { assert, eq, finish } from "./lib/harness.ts";
import { computeBucketSlots, type BusinessHoursRules, type MemberAvailability } from "../src/lib/availability/compute.ts";
import { callsThatFit, dayTotals, type CapacityEventType } from "../src/lib/admin/team-capacity.ts";
import {
  HISTORY_MAX_CATCH_UP_MS,
  historyAdvisor,
  historyDays,
  historyRows,
  historyWindow,
  runHistoryTick,
  type HistoryRow,
  type HistoryTickDeps,
} from "../src/lib/admin/capacity-history.ts";
import { BUSY_PRUNE_KEEP_PAST_HOURS } from "../src/lib/busy/prune-core.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const hours: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
const ev: CapacityEventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };
const tue = DateTime.fromISO("2026-10-20", { zone: ZONE }).startOf("day");
const at = (hm: string, iso = "2026-10-20") => DateTime.fromISO(`${iso}T${hm}`, { zone: ZONE }).toMillis();
const member = (busy: { start: number; end: number }[], userId = "u1", rules = [{ weekday: 2, start_minute: 9 * 60, end_minute: 17 * 60 }]): MemberAvailability => ({
  userId,
  timezone: ZONE,
  rules,
  busy,
  bookingStartsMs: [],
  dayCounts: new Map(),
});
const wholeDayFit = (m: MemberAvailability) =>
  callsThatFit(
    computeBucketSlots({
      members: [m], durationMin: ev.duration_min, bufferBeforeMin: ev.buffer_before_min, bufferAfterMin: ev.buffer_after_min,
      minNoticeMin: ev.min_notice_min, dailyCap: ev.daily_cap, slotIntervalMin: ev.slot_interval_min, businessHours: hours,
      from: tue.toUTC().toISO()!, to: tue.plus({ days: 1 }).toUTC().toISO()!, nowMs: tue.minus({ days: 1 }).toMillis(),
    }),
    ev,
  );

/** Runs the recorder over [startMs, endMs) at the given tick instants, merging rows as the database does. */
function record(members: MemberAvailability[], tickMs: number[], opts: { failing?: Set<string>; timeOff?: Map<string, { startMs: number; endMs: number }[]>; eventType?: CapacityEventType; busyAt?: (nowMs: number) => MemberAvailability[] } = {}) {
  const store = new Map<string, HistoryRow>();
  let cursor: number | null = tickMs[0];
  for (const nowMs of tickMs.slice(1)) {
    const window = historyWindow(cursor, nowMs);
    const eventType = opts.eventType ?? ev;
    const days = historyDays(window, eventType, ZONE);
    const ms = opts.busyAt ? opts.busyAt(nowMs) : members;
    const existing = new Map([...store].map(([k, r]) => [k, r.open_times]));
    const rows = historyRows({
      window,
      days,
      hours,
      eventType,
      roster: ms.map((m) => ({ id: m.userId, name: m.userId, email: `${m.userId}@x.test` })),
      members: ms,
      timeOff: opts.timeOff ?? new Map(),
      failingEmails: opts.failing ?? new Set(),
      existing,
    });
    for (const r of rows) {
      const key = `${r.user_id}|${r.day}`;
      const prev = store.get(key);
      // What record_capacity_history does: open times are a set union, unsynced is sticky.
      const open = [...new Set([...(prev?.open_times ?? []), ...r.open_times])].sort();
      store.set(key, { ...r, open_times: open, unsynced: !!prev?.unsynced || r.unsynced });
    }
    cursor = window.toMs;
  }
  return store;
}
const ticks = (fromMs: number, toMs: number, everyMin: number) => {
  const out: number[] = [];
  for (let t = fromMs; t <= toMs; t += everyMin * MIN) out.push(t);
  return out;
};
const DAY_START = at("00:00");
const DAY_END = at("00:00", "2026-10-21");

// --- the window ---------------------------------------------------------------------
{
  const now = at("12:00");
  eq(historyWindow(null, now), { fromMs: now, toMs: now, skippedMs: 0 }, "a first run records nothing before it existed");
  eq(historyWindow(at("11:30"), now), { fromMs: at("11:30"), toMs: now, skippedMs: 0 }, "a tick records what passed since the last");
  eq(historyWindow(now, now), { fromMs: now, toMs: now, skippedMs: 0 }, "a repeated tick records nothing");
  eq(historyWindow(now + 60_000, now), { fromMs: now, toMs: now, skippedMs: 0 }, "a cursor ahead of the clock records nothing and never goes backwards");
  const long = historyWindow(now - 3 * 86_400_000, now);
  eq(long, { fromMs: now - HISTORY_MAX_CATCH_UP_MS, toMs: now, skippedMs: 3 * 86_400_000 - HISTORY_MAX_CATCH_UP_MS }, "a long outage is caught up only as far back as allowed, and the rest is said");
  assert(HISTORY_MAX_CATCH_UP_MS + ev.min_notice_min * MIN < BUSY_PRUNE_KEEP_PAST_HOURS * 3_600_000, "catch up never reaches busy time the prune has already removed");
  eq(historyDays({ fromMs: at("23:30"), toMs: at("00:30", "2026-10-21"), skippedMs: 0 }, ev, ZONE), ["2026-10-20", "2026-10-21"], "a window across midnight records both days");
  eq(historyDays({ fromMs: now, toMs: now, skippedMs: 0 }, ev, ZONE), [], "an empty window touches no day");
}

// --- a tick at a time saves exactly what the whole day packs to --------------------------
{
  let seed = 3940;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const calendars: { start: number; end: number }[][] = [[], [{ start: at("12:00"), end: at("13:00") }]];
  for (let c = 0; c < 25; c++) {
    const blocks: { start: number; end: number }[] = [];
    for (let b = 0; b < 1 + Math.floor(rand() * 8); b++) {
      const start = at("09:00") + Math.floor(rand() * 48) * 10 * MIN;
      blocks.push({ start, end: start + (1 + Math.floor(rand() * 6)) * 10 * MIN });
    }
    calendars.push(blocks);
  }
  const cadences: [string, number[]][] = [
    ["every 30 minutes", ticks(DAY_START - 60 * MIN, DAY_END + 60 * MIN, 30)],
    ["every 5 minutes", ticks(DAY_START - 60 * MIN, DAY_END + 60 * MIN, 5)],
    ["at 7 minute steps", ticks(DAY_START - 60 * MIN, DAY_END + 60 * MIN, 7)],
    ["with a five hour gap", [...ticks(DAY_START - 60 * MIN, at("10:00"), 30), ...ticks(at("15:00"), DAY_END + 60 * MIN, 30)]],
  ];
  for (const busy of calendars) {
    const m = member(busy);
    const want = wholeDayFit(m);
    for (const [name, t] of cadences) {
      const got = record([m], t).get("u1|2026-10-20");
      eq(got?.open_times, want, `${name}, ${busy.length} busy blocks: the day's saved calls equal the whole day packed at once`);
    }
  }
}

// --- booked before it passed, changed after it passed ---------------------------------------
{
  const m = member([]);
  // A call booked at 11:00 at 10:30 is taken; a block added at 16:00 over 9am changes nothing saved.
  const busyAt = (nowMs: number) => [
    member([
      ...(nowMs >= at("10:30") ? [{ start: at("11:00"), end: at("11:20") }] : []),
      ...(nowMs >= at("16:00") ? [{ start: at("09:00"), end: at("10:00") }] : []),
    ]),
  ];
  const saved = record([m], ticks(DAY_START - 60 * MIN, DAY_END, 30), { busyAt }).get("u1|2026-10-20")!;
  assert(!saved.open_times.includes(new Date(at("11:00")).toISOString()), "a call booked before it passed is never saved as open");
  assert(saved.open_times.includes(new Date(at("09:00")).toISOString()), "a calendar changed after a call passed never rewrites it");
  eq(saved.capacity, 16, "capacity is the whole shift's calls, whatever the calendar holds");
  eq(saved.shift_start, new Date(at("09:00")).toISOString(), "the shift's first start");
  eq(saved.shift_end, new Date(at("17:00")).toISOString(), "the shift's end");
}

// --- not syncing, time off, a whole day off, no shift, the daily cap ---------------------------
{
  const span = ticks(DAY_START - 60 * MIN, DAY_END, 30);
  const a = member([], "a");
  const b = member([], "b");
  const c = member([], "c");
  const d = member([], "d", []);
  const failing = new Set<string>();
  const store = record([a, b, c, d], span, {
    timeOff: new Map([
      ["b", [{ startMs: at("13:00"), endMs: at("14:00") }]],
      ["c", [{ startMs: DAY_START, endMs: DAY_END }]],
    ]),
    busyAt: (nowMs) => {
      // a's calendar stops syncing for one tick at noon: the day is marked for good.
      if (nowMs === at("12:00")) failing.add("a@x.test");
      else failing.delete("a@x.test");
      return [a, b, c, d];
    },
    failing,
  });
  eq(store.get("a|2026-10-20")?.unsynced, true, "a calendar that stopped syncing during the day marks the day");
  eq(store.get("b|2026-10-20")?.capacity, 14, "an hour off comes off capacity");
  eq(store.get("b|2026-10-20")?.time_off, [{ start: new Date(at("13:00")).toISOString(), end: new Date(at("14:00")).toISOString() }], "the hour off is kept for drawing");
  assert(!store.get("b|2026-10-20")!.open_times.some((s) => Date.parse(s) >= at("12:40") && Date.parse(s) < at("14:00")), "no call is saved as open during time off");
  eq(store.get("c|2026-10-20")?.is_out, true, "time off over the whole shift is Out");
  eq(store.get("d|2026-10-20")?.no_shift, true, "an advisor with no hours that day is recorded as no shift");
  eq(store.get("d|2026-10-20")?.open_times, [], "and saves no calls");

  const capped = { ...ev, daily_cap: 3 };
  const e = { ...member([], "e"), dayCounts: new Map([["2026-10-20", 1]]) };
  eq(record([e], span, { eventType: capped }).get("e|2026-10-20")?.open_times.length, 2, "a daily cap of 3 with one call booked leaves room for 2");
}

// --- a past day read back -----------------------------------------------------------------
{
  const span = ticks(DAY_START - 60 * MIN, DAY_END, 30);
  const busy = member([{ start: at("09:00"), end: at("12:00") }]);
  const store = record([busy], span);
  const row = store.get("u1|2026-10-20")!;
  const advisor = historyAdvisor({ ...row, name: "Avery", email: "avery@x.test" });
  eq(advisor.days[0].open, row.open_times.length, "a past day's calls open are the saved ones");
  eq(advisor.days[0].openTimes, row.open_times, "and are drawn where they were");
  eq(advisor.days[0].fullShiftStart, row.shift_start, "the shift drawn is the one saved");
  eq(advisor.timezone, ZONE, "beside the zone the advisor was in");
  // The database hands times back in its own spelling; the page compares and draws ISO instants.
  const pg = historyAdvisor({ ...row, open_times: ["2026-10-20T13:00:00+00:00"], time_off: [{ start: "2026-10-20T17:00:00+00:00", end: "2026-10-20T18:00:00+00:00" }], shift_start: "2026-10-20T13:00:00+00:00", name: null, email: "e@x.test" });
  eq([pg.days[0].openTimes, pg.days[0].timeOff, pg.days[0].fullShiftStart, pg.name], [["2026-10-20T13:00:00.000Z"], [{ start: "2026-10-20T17:00:00.000Z", end: "2026-10-20T18:00:00.000Z" }], "2026-10-20T13:00:00.000Z", "e@x.test"], "times read back from the database are ISO instants, and a nameless advisor goes by their address");
  const open = wholeDayFit(busy).length;
  assert(open > 0 && open < 16, "the fixture leaves some room and takes some");
  const totals = dayTotals([advisor], 0);
  eq(totals, { open, capacity: 16, out: 0, notCounted: 0, fullPct: Math.floor((100 * (16 - open)) / 16) }, "a past day's totals: the morning taken out of sixteen calls");
}

// --- one tick against its reads and its write ------------------------------------------------
{
  const people = { roster: [{ id: "u1", name: "Avery", email: "a@x.test" }], members: [member([])], timeOff: new Map(), failingEmails: new Set<string>() };
  const writes: { rows: HistoryRow[]; throughMs: number }[] = [];
  const deps = (over: Partial<HistoryTickDeps> = {}): HistoryTickDeps => ({
    nowMs: at("12:00"),
    readCursor: async () => at("11:30"),
    loadRules: async () => ({ ok: true, value: { hours, eventType: ev } }),
    loadPeople: async () => ({ ok: true, value: people }),
    readSaved: async () => new Map(),
    write: async (rows, throughMs) => {
      writes.push({ rows, throughMs });
      return rows.length;
    },
    ...over,
  });
  const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));

  writes.length = 0;
  const ok = await runHistoryTick(deps());
  eq(ok.rows, 1, "a tick writes a row per advisor and day it touched");
  eq(writes[0].throughMs, at("12:00"), "and moves the cursor to now, in the same write");
  // From 11:30 with five minutes' notice, starts from 11:35 to before 12:05 stopped being bookable:
  // on the ten minute grid the first call fits at 11:40 and the next not before 12:10.
  eq(writes[0].rows[0].open_times, [new Date(at("11:40")).toISOString()], "saving the calls that stopped being bookable since the last tick");

  writes.length = 0;
  const first = await runHistoryTick(deps({ readCursor: async () => null }));
  eq([first.rows, writes.length, writes[0]?.rows.length, writes[0]?.throughMs], [0, 1, 0, at("12:00")], "a first run saves nothing and starts the cursor now");

  writes.length = 0;
  const nobody = await runHistoryTick(deps({ loadPeople: async () => ({ ok: false, reason: "no-advisors" }) }));
  eq([nobody.nobodyBookable, writes[0]?.rows.length, writes[0]?.throughMs], [true, 0, at("12:00")], "nobody bookable saves nothing and moves on");

  for (const reason of ["calendars", "time-off", "calendar-sync", "roster"] as const) {
    writes.length = 0;
    const msg = await rejects(runHistoryTick(deps({ loadPeople: async () => ({ ok: false, reason, err: new Error("boom") }) })));
    assert(msg !== null && msg.includes(reason), `a failed ${reason} read fails the tick and names it`);
    eq(writes.length, 0, `and writes nothing, so the cursor stays and the next tick covers this stretch (${reason})`);
  }
  writes.length = 0;
  assert((await rejects(runHistoryTick(deps({ loadRules: async () => ({ ok: false, reason: "business-hours" }) })))) !== null, "unreadable office hours fail the tick");
  eq(writes.length, 0, "and write nothing");
  assert((await rejects(runHistoryTick(deps({ readSaved: async () => { throw new Error("read refused"); } })))) !== null, "an unreadable record of saved calls fails the tick rather than packing from nothing");
  eq(writes.length, 0, "and writes nothing");
  assert((await rejects(runHistoryTick(deps({ write: async () => { throw new Error("write refused"); } })))) !== null, "a refused write fails the tick");

  const late = await runHistoryTick(deps({ readCursor: async () => at("12:00") - 3 * 86_400_000 }));
  eq(late.skippedMs, 3 * 86_400_000 - HISTORY_MAX_CATCH_UP_MS, "a long outage reports the stretch it could not save");
}

finish();
