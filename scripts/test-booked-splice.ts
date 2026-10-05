// #3324: after a booking, re-check only the booked window, in EVERY pool the booked
// advisor serves, and splice the answer into the stored rows.
//
// The refresh it replaces recomputed the booked code's whole pool over the whole
// horizon (about 1.2s of CPU crowding per booking under load, #3258) and touched only
// that one pool, so the advisor's other pools went on offering the taken time for up
// to the lane's four minutes. Dan, 2026-10-05: a just booked time must disappear
// within seconds.
//
// And it must not move that cost onto the database (#3324 review): the reads are one
// batch per booking whatever the advisor's pool count, and only a row whose offer
// changed is written. The call budget is asserted here, at two pools and at twelve.
//
// These drive the real slot predicate (`computeBucketSlots`) over a fake roster and a
// fake busy_blocks table, and the real row splice over an in memory bucket_slots, so
// what is asserted is what a lead would be offered afterwards.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booked-splice.ts
import { DateTime } from "luxon";
import { spliceBookedTime, type BookedTime, type BookedSpliceDeps } from "../src/lib/availability/booked-splice.ts";
import { affectedWindow, widenToLocalDay, spliceRanges } from "../src/lib/availability/slot-splice.ts";
import { readSlotRows, spliceFromRead, spliceSlotRow } from "../src/lib/availability/slot-row-write.ts";
import {
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
  DateTime.fromISO(`${date}T${hhmm}`, { zone: ZONE }).toUTC().toISO()!.replace("+00:00", "Z");
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

function membersOf(w: World, userIds: string[], busy: World["busy"]): MemberAvailability[] {
  const counts = dayCounts(w);
  return userIds.map((userId) => ({
    userId,
    timezone: ZONE,
    rules: rules.filter((r) => r.schedule_id === `s-${userId}`),
    busy: busy.filter((b) => b.user_id === userId).map((b) => ({ start: ms(b.starts_at), end: ms(b.ends_at) })),
    bookingStartsMs: [],
    dayCounts: counts.get(userId) ?? new Map(),
  }));
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
  const from = et("00:00");
  const to = et("00:00", "2026-10-14");
  return w.pools.flatMap((p) => {
    const slots = computeOver(w, membersOf(w, p.members, w.busy), from, to);
    return p.codes.map((code) => ({
      bucket_code: code,
      payload: { bucket: { code }, eventType: { duration_min: w.ev.duration_min }, orgName: "Pennie", slots },
      computed_at: iso(NOW - 60_000),
      invalidated_at: null,
    }));
  });
}

/** Every call that would reach the database, by kind, in the order made. */
interface Calls {
  log: string[];
  busyRows: number;
  busyWindows: [string, string][];
}

interface Harness {
  table: ReturnType<typeof fakeBucketSlotsTable>;
  calls: Calls;
  warnings: string[];
  invalidated: string[];
  deps: BookedSpliceDeps<null>;
  /** Database statements: the batched reads plus every row read and write. */
  dbCalls(): number;
}

function harness(w: World, rows: SlotRow[]): Harness {
  const table = fakeBucketSlotsTable(rows);
  const calls: Calls = { log: [], busyRows: 0, busyWindows: [] };
  const warnings: string[] = [];
  const invalidated: string[] = [];
  let clock = NOW;
  const deps: BookedSpliceDeps<null> = {
    now: () => (clock += 1),
    // Three statements in production: buckets with their event types, the active
    // manual members, the bookable advisors.
    loadPlan: async (userId) => {
      calls.log.push("buckets", "bucket_members", "users");
      return w.pools
        .filter((p) => p.members.includes(userId))
        .map((p) => ({ codes: p.codes, eventType: w.ev, memberIds: p.members, ctx: null }));
    },
    loadSchedules: async (ids) => {
      calls.log.push("availability_schedules");
      return {
        schedules: schedules.filter((s) => ids.includes(s.user_id)),
        rules: rules.filter((r) => ids.some((u) => r.schedule_id === `s-${u}`)),
      };
    },
    loadDayCounts: async () => {
      calls.log.push("count_bookings_per_local_day");
      return dayCounts(w);
    },
    loadBusy: async (ids, from, to) => {
      calls.log.push("busy_blocks");
      calls.busyWindows.push([from, to]);
      const hit = w.busy.filter((b) => ids.includes(b.user_id) && ms(b.starts_at) < ms(to) && ms(b.ends_at) > ms(from));
      calls.busyRows += hit.length;
      return hit;
    },
    compute: (_pool, members, range) => ({ slots: computeOver(w, members, range.computeFrom, range.computeTo) }),
    readRows: (codes) => readSlotRows(table.db, codes),
    writeFromRead: (code, row, win, judge, fenceAtMs, startedMs) =>
      spliceFromRead(table.db, code, row, win, judge, fenceAtMs, startedMs),
    writeSplice: (code, win, judge, fenceAtMs, startedMs) =>
      spliceSlotRow(table.db, code, win, judge, fenceAtMs, startedMs),
    invalidate: async (code) => {
      invalidated.push(code);
    },
    warn: (msg) => warnings.push(msg),
  };
  return {
    table,
    calls,
    warnings,
    invalidated,
    deps,
    dbCalls: () =>
      calls.log.length + table.statements.select + table.statements.update + table.statements.insert,
  };
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
  eq(outcome.spliced, 2, "the pool only A serves had its codes spliced");
  eq(outcome.unchanged, 2, "and the shared pool, where B is still free, needed no write");
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
  eq(h.invalidated.sort(), ["201", "202"], "each spliced code's edge cache entry is dropped, and only those");
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
  assert(
    (before.find((r) => r.bucket_code === "201")!.payload as { slots: string[] }).slots.includes(et("15:00")),
    "control: 15:00 is on offer before the booking",
  );
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.widened, 2, "the booking took A to their cap, so both pools widened");
  const s = slotsOf(h, "201");
  assert(!s.includes(et("15:00")), "a time hours away on the same day is gone from A's own pool");
  assert(!s.includes(et("09:00")), "and so is the first time of the day");
  assert(slotsOf(h, "101").includes(et("15:00")), "while B still offers it in the shared pool");
  eq(h.calls.log.filter((c) => c === "busy_blocks").length, 1, "widening costs no second busy read");
  eq(h.calls.log.filter((c) => c === "count_bookings_per_local_day").length, 1, "nor a second count");
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
  // A full week of busy time for both advisors, one block an hour.
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
  // One busy read for both pools over [09:40, 10:40): A's booking, plus the 09:40
  // block for each advisor. Nowhere near the week.
  eq(h.calls.log.filter((c) => c === "busy_blocks").length, 1, "one busy read for every pool together");
  eq(h.calls.busyRows, 3, "returning only the rows inside the window");
  assert(h.calls.busyRows * 10 < total, `a small fraction of the ${total + 1} rows a whole horizon read would see`);
  eq(h.calls.busyWindows, [[et("09:40"), et("10:40")]], "over exactly the booked window");
}

// --- the call budget does not grow with the advisor's pools (#3324 review) -------------
//
// The per pool shape this replaced made about 9 statements a pool plus a read and a
// write per code: 77 for a four pool advisor, 209 for the twelve pool one. The batched
// reads are a constant SEVEN (three roster reads, schedules, the cap count, busy time,
// the affected rows), and a row is written only when its offer changed.
const BATCHED_READS = 7;
function poolWorld(poolCount: number, soleAdvisorPools: number): World {
  const w = world();
  w.pools = Array.from({ length: poolCount }, (_, i) => ({
    codes: [0, 1, 2, 3].map((j) => `${i + 1}0${j}`),
    // The first `soleAdvisorPools` pools are A's alone; the rest are shared with B.
    members: i < soleAdvisorPools ? [A] : [A, B],
  }));
  return w;
}
for (const [pools, sole] of [
  [4, 1],
  [12, 3],
  [12, 12],
] as const) {
  const w = poolWorld(pools, sole);
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const outcome = await spliceBookedTime(booked, h.deps);
  const reads = h.calls.log.length + h.table.statements.select;
  eq(reads, BATCHED_READS, `${pools} pools: the reads are the same seven whatever the pool count`);
  eq(h.table.statements.update, sole * 4, `${pools} pools, ${sole} changed: one write per code whose offer changed`);
  eq(outcome.spliced + outcome.unchanged, pools * 4, `${pools} pools: every code was judged`);
  assert(
    h.dbCalls() <= BATCHED_READS + outcome.spliced,
    `${pools} pools: database calls stay within ${BATCHED_READS} plus one per changed code (${h.dbCalls()})`,
  );
}

// --- failures ------------------------------------------------------------------------
{
  // A splice whose write fails leaves the row exactly as it was, says so, and the
  // other pool is still spliced: one bad code cannot cost another its splice.
  const w = world();
  w.pools[0]!.members = [A];
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const snapshot = JSON.stringify(before.filter((r) => r.bucket_code.startsWith("1")));
  const h = harness(w, before);
  const real = h.deps.writeFromRead;
  h.deps.writeFromRead = async (code, ...rest) => (code.startsWith("1") ? "failed" : real(code, ...rest));
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.failed, 2, "the two refused codes are counted as failed");
  eq(outcome.spliced, 2, "and the other pool's codes were still spliced");
  eq(
    JSON.stringify(h.table.rows.filter((r) => r.bucket_code.startsWith("1"))),
    snapshot,
    "the refused rows are exactly as they were",
  );
  assert(h.warnings.some((m) => /101/.test(m)), "and the refusal is logged by code");
}
{
  // A pool whose compute throws is a failure of that pool alone.
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const real = h.deps.compute;
  h.deps.compute = (pool, ...rest) => {
    if (pool.codes.includes("101")) throw new Error("compute blew up");
    return real(pool, ...rest);
  };
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.failed, 2, "the pool that could not be computed counts its codes as failed");
  assert(!slotsOf(h, "201").includes(et("10:00")), "and A's other pool is still spliced");
  assert(h.warnings.some((m) => /101/.test(m)), "and the failure is logged by pool");
}
{
  // A batched read that fails throws, so the caller reports the splice as failed and
  // the lane covers every code; nothing is written on a partial picture.
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  h.deps.loadBusy = async () => {
    throw new Error("busy_blocks read failed");
  };
  let threw = "";
  await spliceBookedTime(booked, h.deps).catch((e: Error) => (threw = e.message));
  eq(threw, "busy_blocks read failed", "a failed batched read is thrown, never read as no busy time");
  eq(h.table.statements.update, 0, "and nothing was written");
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
  const real = h.deps.writeFromRead;
  let refusals = 0;
  h.deps.writeFromRead = async (code, ...rest) => {
    if (code === "201" && refusals === 0) {
      refusals++;
      return "recompute";
    }
    return real(code, ...rest);
  };
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.spliced, 2, "a code told to recompute is spliced on the second compute");
  eq(h.calls.log.filter((c) => c === "busy_blocks").length, 2, "which read busy time once more");
  assert(!slotsOf(h, "201").includes(et("10:00")), "and its booked time is gone");
}
{
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const real = h.deps.writeFromRead;
  h.deps.writeFromRead = async (code, ...rest) => (code === "201" ? "recompute" : real(code, ...rest));
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.failed, 1, "a code that is stale on every attempt is a failure for the lane, not a loop");
  eq(h.calls.log.filter((c) => c === "busy_blocks").length, 2, "after one more compute");
}
{
  // A row that moved under the batched read is read afresh and still spliced.
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  h.table.beforeNextUpdate(() => {
    h.table.rows.find((r) => r.bucket_code === "201")!.computed_at = iso(NOW - 30_000);
  });
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.spliced, 2, "the code whose row moved was spliced on a fresh read");
  assert(!slotsOf(h, "201").includes(et("10:00")), "and its booked time is gone");
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
  eq(reads.calls.log, on.calls.log, "reads only makes exactly the batched reads the splice makes");
  eq(reads.calls.busyWindows, on.calls.busyWindows, "over the same windows, the cap widening included");
  eq(reads.table.statements.select, 1, "and the one row read");
  eq(reads.table.statements.update, 0, "and writes no row");
  eq(JSON.stringify(reads.table.rows), snapshot, "leaving every row as it was");
  eq(reads.invalidated, [], "and drops no edge cache entry");
  eq(outcome.spliced, 0, "and reports nothing spliced");
}

finish();
