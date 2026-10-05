// #3324: after a booking, re-check only the booked window, in EVERY pool the booked
// advisor serves, and splice the answer into the stored rows.
//
// The refresh it replaces recomputed the booked code's whole pool over the whole
// horizon (about 1.2s of CPU crowding per booking under load, #3258) and touched only
// that one pool, so the advisor's other pools went on offering the taken time for up
// to the lane's four minutes. Dan, 2026-10-05: a just booked time must disappear
// within seconds.
//
// These drive the real slot predicate (`computeBucketSlots`) over a fake roster and a
// fake busy_blocks table, and the real row splice (`spliceSlotRow`) over an in memory
// bucket_slots, so what is asserted is what a lead would be offered afterwards.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booked-splice.ts
import { DateTime } from "luxon";
import {
  spliceBookedTime,
  type BookedTime,
  type BookedSpliceDeps,
  type SpliceRange,
} from "../src/lib/availability/booked-splice.ts";
import {
  affectedWindow,
  widenToLocalDay,
  spliceRanges,
} from "../src/lib/availability/slot-splice.ts";
import { spliceSlotRow } from "../src/lib/availability/slot-row-write.ts";
import {
  assembleMemberAvailability,
  computeBucketSlots,
  type BusinessHoursRules,
  type MemberAvailability,
} from "../src/lib/availability/compute.ts";
import { fakeBucketSlotsTable, type SlotRow } from "./lib/fake-bucket-slots-table.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const HOURS: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
  exceptions: [],
};
const NOW = Date.parse("2026-10-12T12:00:00.000Z"); // Monday 08:00 ET
const et = (hhmm: string, date = "2026-10-13") =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: ZONE }).toUTC().toISO({ suppressMilliseconds: false })!.replace("+00:00", "Z");
const ms = (iso: string) => Date.parse(iso);
const iso = (n: number) => new Date(n).toISOString();

interface Ev {
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  daily_cap: number | null;
  slot_interval_min: number;
}

interface World {
  ev: Ev;
  /** pool key -> codes and the advisors it routes to */
  pools: { codes: string[]; members: string[] }[];
  busy: { user_id: string; starts_at: string; ends_at: string }[];
  bookings: { user_id: string; starts_at: string }[];
}

const A = "advisor-a";
const B = "advisor-b";

function world(ev: Partial<Ev> = {}): World {
  return {
    ev: {
      duration_min: 20,
      buffer_before_min: 0,
      buffer_after_min: 0,
      min_notice_min: 0,
      daily_cap: null,
      slot_interval_min: 10,
      ...ev,
    },
    pools: [
      // The booked code's pool: A and B both serve it.
      { codes: ["101", "102"], members: [A, B] },
      // A pool only A serves: the one the old refresh never touched.
      { codes: ["201", "202"], members: [A] },
    ],
    busy: [],
    bookings: [],
  };
}

const schedules = [A, B].map((u) => ({ id: `s-${u}`, user_id: u, timezone: ZONE }));
const rules = [A, B].flatMap((u) =>
  [1, 2, 3, 4, 5].map((weekday) => ({ schedule_id: `s-${u}`, weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
);

function dayCounts(w: World): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const b of w.bookings) {
    const day = DateTime.fromISO(b.starts_at, { zone: ZONE }).toISODate()!;
    const per = out.get(b.user_id) ?? new Map<string, number>();
    per.set(day, (per.get(day) ?? 0) + 1);
    out.set(b.user_id, per);
  }
  return out;
}

/** A busy_blocks read over [from, to), counting the rows it returns. */
function readBusy(w: World, userIds: string[], from: string, to: string, counter: { rows: number; reads: number }) {
  counter.reads++;
  const hit = w.busy.filter(
    (b) => userIds.includes(b.user_id) && ms(b.starts_at) < ms(to) && ms(b.ends_at) > ms(from),
  );
  counter.rows += hit.length;
  return hit;
}

function membersFor(w: World, userIds: string[], from: string, to: string, counter: { rows: number; reads: number }) {
  return assembleMemberAvailability(userIds, schedules, rules, readBusy(w, userIds, from, to, counter), dayCounts(w));
}

function computeOver(w: World, members: MemberAvailability[], from: string, to: string) {
  return computeBucketSlots({
    members,
    durationMin: w.ev.duration_min,
    bufferBeforeMin: w.ev.buffer_before_min,
    bufferAfterMin: w.ev.buffer_after_min,
    minNoticeMin: w.ev.min_notice_min,
    dailyCap: w.ev.daily_cap,
    slotIntervalMin: w.ev.slot_interval_min,
    businessHours: HOURS,
    from,
    to,
    nowMs: NOW,
  });
}

/** Every pool's rows, as a full compute over the whole day would store them. */
function storedRows(w: World): SlotRow[] {
  const counter = { rows: 0, reads: 0 };
  const from = et("00:00");
  const to = et("00:00", "2026-10-14");
  return w.pools.flatMap((p) => {
    const slots = computeOver(w, membersFor(w, p.members, from, to, counter), from, to);
    return p.codes.map((code) => ({
      bucket_code: code,
      payload: { bucket: { code }, eventType: { duration_min: w.ev.duration_min }, orgName: "Pennie", slots },
      computed_at: iso(NOW - 60_000),
      invalidated_at: null,
    }));
  });
}

interface Harness {
  table: ReturnType<typeof fakeBucketSlotsTable>;
  counter: { rows: number; reads: number };
  ranges: SpliceRange[];
  warnings: string[];
  invalidated: string[];
  deps: BookedSpliceDeps<{ code: string; eventType: Ev }, { members: MemberAvailability[]; pool: string[] }>;
}

function harness(w: World, rows: SlotRow[], over: Partial<Harness["deps"]> = {}): Harness {
  const table = fakeBucketSlotsTable(rows);
  const counter = { rows: 0, reads: 0 };
  const ranges: SpliceRange[] = [];
  const warnings: string[] = [];
  const invalidated: string[] = [];
  let clock = NOW;
  const deps: Harness["deps"] = {
    now: () => (clock += 1),
    agentPools: async (userId) =>
      w.pools.filter((p) => p.members.includes(userId)).map((p) => p.codes),
    resolve: async (code) => ({ code, eventType: w.ev }),
    load: async (_resolved, code, range) => {
      ranges.push(range);
      const pool = w.pools.find((p) => p.codes.includes(code))!.members;
      return { members: membersFor(w, pool, range.readFrom, range.readTo, counter), pool };
    },
    compute: (loaded, range) => ({ slots: computeOver(w, loaded.members, range.computeFrom, range.computeTo) }),
    writeSplice: (code, window, computed, fenceAtMs, startedMs) =>
      spliceSlotRow(table.db, code, window, computed, fenceAtMs, startedMs),
    invalidate: async (code) => {
      invalidated.push(code);
    },
    warn: (msg) => warnings.push(msg),
    ...over,
  };
  return { table, counter, ranges, warnings, invalidated, deps };
}

/** Book A at `start` for the event's duration: the busy block and the cap count. */
function book(w: World, user: string, start: string): BookedTime {
  const end = iso(ms(start) + w.ev.duration_min * 60_000);
  w.busy.push({ user_id: user, starts_at: start, ends_at: end });
  w.bookings.push({ user_id: user, starts_at: start });
  return { userId: user, startsAt: start, endsAt: end, fenceAtMs: NOW };
}

const slotsOf = (h: Harness, code: string) =>
  (h.table.rows.find((r) => r.bucket_code === code)!.payload as { slots: string[] }).slots;

// --- the window arithmetic ------------------------------------------------------
{
  const w = affectedWindow(ms(et("10:00")), ms(et("10:20")), {
    duration_min: 20,
    buffer_before_min: 10,
    buffer_after_min: 10,
  });
  // A start S is touched when [S - 10m, S + 20m + 10m) overlaps [10:00, 10:20).
  eq(iso(w.fromMs), et("09:30"), "the window opens a call plus its after buffer before the booking");
  eq(iso(w.lastStartMs), et("10:30"), "and closes the before buffer after it");
  const r = spliceRanges(w, { duration_min: 20, buffer_before_min: 10, buffer_after_min: 10 });
  eq(r.computeFrom, et("09:30"), "the compute starts at the first touched start");
  eq(r.computeTo, et("10:50"), "and ends one call after the last, so that start can be judged");
  eq(r.readFrom, et("09:20"), "busy time is read a before buffer earlier");
  eq(r.readTo, et("11:00"), "and an after buffer later, so an edge start's buffers are judged too");

  const day = widenToLocalDay(w, ms(et("10:00")), ZONE);
  eq(iso(day.fromMs), et("00:00"), "at the cap the window reaches back to the advisor's local midnight");
  eq(day.lastStartMs, ms(et("00:00", "2026-10-14")) - 1, "and up to their next one");
}

// --- every pool the advisor serves -----------------------------------------------
{
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const outcome = await spliceBookedTime(booked, h.deps);

  eq(outcome.pools, 2, "both of A's pools were visited");
  eq(outcome.spliced, 4, "and every code in each was spliced");
  for (const code of ["201", "202"]) {
    assert(!slotsOf(h, code).includes(et("10:00")), `${code}: the booked time is gone from a pool other than the booked code's`);
    assert(!slotsOf(h, code).includes(et("09:50")), `${code}: and so is the start whose call would run into it`);
    assert(slotsOf(h, code).includes(et("10:20")), `${code}: the start right after the call stays (no buffer)`);
    assert(slotsOf(h, code).includes(et("15:00")), `${code}: and the rest of the day is untouched`);
  }
  for (const code of ["101", "102"]) {
    assert(slotsOf(h, code).includes(et("10:00")), `${code}: a time another advisor is still free for stays on offer`);
  }
  eq(
    h.table.rows.map((r) => r.computed_at),
    before.map(() => iso(NOW - 60_000)),
    "no row's computed_at moved: a splice is not a full compute",
  );
  eq(h.invalidated.sort(), ["101", "102", "201", "202"], "each spliced code's edge cache entry is dropped");
}

// --- buffers take the neighbouring starts with them ---------------------------------
{
  const w = world({ buffer_before_min: 10, buffer_after_min: 10 });
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  await spliceBookedTime(booked, h.deps);
  const s = slotsOf(h, "201");
  for (const t of ["09:40", "09:50", "10:00", "10:10", "10:20"]) {
    assert(!s.includes(et(t)), `with ten minute buffers, ${t} is gone`);
  }
  for (const t of ["09:30", "10:30"]) {
    assert(s.includes(et(t)), `and ${t}, whose buffers clear the call, stays`);
  }
}

// --- the daily cap widens the window to the whole local day ---------------------
{
  const w = world({ daily_cap: 1 });
  const before = storedRows(w);
  assert(slotsOf(harness(w, before), "201").includes(et("15:00")), "control: 15:00 is on offer before the booking");
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.widened, 2, "the booking took A to their cap, so both pools widened");
  const s = slotsOf(h, "201");
  assert(!s.includes(et("15:00")), "a time hours away on the same day is gone from A's own pool");
  assert(!s.includes(et("09:00")), "and so is the first time of the day");
  assert(slotsOf(h, "101").includes(et("15:00")), "while B still offers it in the shared pool");
}
{
  // CONTROL for the widening: under the cap, the far time stays.
  const w = world({ daily_cap: 2 });
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.widened, 0, "one booking under a cap of two widens nothing");
  assert(slotsOf(h, "201").includes(et("15:00")), "so a time hours away stays on offer");
}

// --- the compute is bounded to the window --------------------------------------------
{
  const w = world();
  // A full week of busy time for both advisors, two blocks an hour.
  for (let d = 12; d <= 16; d++) {
    for (let hr = 9; hr < 17; hr++) {
      for (const u of [A, B]) {
        const s = et(`${String(hr).padStart(2, "0")}:40`, `2026-10-${d}`);
        w.busy.push({ user_id: u, starts_at: s, ends_at: iso(ms(s) + 10 * 60_000) });
      }
    }
  }
  const total = w.busy.length;
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  await spliceBookedTime(booked, h.deps);
  // Two pools, each reading [09:40, 10:40) of busy time: A's booking, plus the 09:40
  // block for each advisor in the pool. Nowhere near the week.
  eq(h.counter.reads, 2, "one busy read per pool");
  eq(h.counter.rows, 5, "and only the rows inside the window (3 for the shared pool, 2 for A's own)");
  assert(h.counter.rows * 10 < total, `a small fraction of the ${total + 1} rows a whole horizon read would see`);
  for (const r of h.ranges) {
    assert(ms(r.readTo) - ms(r.readFrom) <= 60 * 60_000, "no read window is longer than an hour here");
  }
}

// --- failures ------------------------------------------------------------------------
{
  // A splice whose write fails leaves the row exactly as it was, says so, and the
  // other pool is still spliced: one bad pool cannot cost another its splice.
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const snapshot = JSON.stringify(before);
  const h = harness(w, before, {});
  const real = h.deps.writeSplice;
  h.deps.writeSplice = async (code, ...rest) => (code.startsWith("1") ? "failed" : real(code, ...rest));
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.failed, 2, "the two refused codes are counted as failed");
  eq(outcome.spliced, 2, "and the other pool's codes were still spliced");
  eq(
    JSON.stringify(h.table.rows.filter((r) => r.bucket_code.startsWith("1"))),
    JSON.stringify(JSON.parse(snapshot).filter((r: SlotRow) => r.bucket_code.startsWith("1"))),
    "the refused rows are exactly as they were",
  );
  assert(h.warnings.some((m) => /101/.test(m)), "and the refusal is logged by code");
}
{
  // A pool whose read throws is a failure of that pool alone.
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const real = h.deps.load;
  h.deps.load = async (r, code, range) => {
    if (code === "101") throw new Error("busy_blocks read failed");
    return real(r, code, range);
  };
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.failed, 2, "the pool that could not be read counts its codes as failed");
  assert(!slotsOf(h, "201").includes(et("10:00")), "and A's other pool is still spliced");
  assert(h.warnings.some((m) => /busy_blocks read failed/.test(m)), "and the cause is logged");
}
{
  // A row that does not exist yet is not invented: the lane builds it.
  const w = world();
  const before = storedRows(w).filter((r) => r.bucket_code !== "202");
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.noRow, 1, "a code with no row is counted as such");
  assert(!h.table.rows.some((r) => r.bucket_code === "202"), "and no row is created for it");
}

// --- a splice told its answer may be stale computes again, a bounded number of times ---
{
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const real = h.deps.writeSplice;
  let refusals = 0;
  h.deps.writeSplice = async (code, ...rest) => {
    if (code === "201" && refusals === 0) {
      refusals++;
      return "recompute";
    }
    return real(code, ...rest);
  };
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.spliced, 4, "a code told to recompute is spliced on the second compute");
  eq(h.counter.reads, 3, "which read its pool's window once more, and only that pool's");
  assert(!slotsOf(h, "201").includes(et("10:00")), "and its booked time is gone");
}
{
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const real = h.deps.writeSplice;
  h.deps.writeSplice = async (code, ...rest) => (code === "201" ? "recompute" : real(code, ...rest));
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.failed, 1, "a code that is stale on every attempt is a failure for the lane, not a loop");
  eq(h.counter.reads, 3, "after one more compute");
}

// --- the reads only arm makes the same reads and writes nothing -----------------------
{
  const w = world({ daily_cap: 1 });
  const before = storedRows(w);
  const snapshot = JSON.stringify(before);
  const booked = book(w, A, et("10:00"));
  const on = harness(w, storedRows(w));
  await spliceBookedTime(booked, on.deps);
  const reads = harness(w, before);
  const outcome = await spliceBookedTime(booked, reads.deps, { readsOnly: true });
  eq(reads.ranges, on.ranges, "reads only reads exactly the windows the splice reads, the cap widening included");
  eq(reads.table.statements.update, 0, "and writes no row");
  eq(JSON.stringify(reads.table.rows), snapshot, "leaving every row as it was");
  eq(reads.invalidated, [], "and drops no edge cache entry");
  eq(outcome.spliced, 0, "and reports nothing spliced");
}

finish();
