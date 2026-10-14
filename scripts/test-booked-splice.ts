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
// #3334: a reschedule or reassign splices BOTH of its windows the same way: the time
// taken out of every pool its advisor serves, the time left back into every pool the
// old advisor serves, from the same seven reads.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booked-splice.ts
import { DateTime } from "luxon";
import { spliceBookedTime, type BookedTime, type BookedSpliceDeps } from "../src/lib/availability/booked-splice.ts";
import { affectedWindow, widenToLocalDay, spliceRanges } from "../src/lib/availability/slot-splice.ts";
import { readSlotRows, spliceFromRead, spliceSlotRow, writeSlotRow } from "../src/lib/availability/slot-row-write.ts";
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

/** Every pool's rows, as a full compute over the whole day (or `days` days from
 *  Tuesday) would store them. */
function storedRows(w: World, days = 1): SlotRow[] {
  const from = et("00:00");
  const to = DateTime.fromISO("2026-10-13T00:00", { zone: ZONE }).plus({ days }).toUTC().toISO()!.replace("+00:00", "Z");
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
    loadPlan: async (userIds) => {
      calls.log.push("buckets", "bucket_members", "users");
      return w.pools
        .filter((p) => p.members.some((m) => userIds.includes(m)))
        .map((p) => ({
          codes: p.codes,
          servedBy: userIds.filter((u) => p.members.includes(u)),
          eventType: w.ev,
          memberIds: p.members,
          ctx: null,
        }));
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
    loadBusy: async (ids, spans) => {
      calls.log.push("busy_blocks");
      for (const s of spans) calls.busyWindows.push([s.from, s.to]);
      const hit = w.busy.filter(
        (b) => ids.includes(b.user_id) && spans.some((s) => ms(b.starts_at) < ms(s.to) && ms(b.ends_at) > ms(s.from)),
      );
      calls.busyRows += hit.length;
      return hit;
    },
    compute: (_pool, members, range) => ({ slots: computeOver(w, members, range.computeFrom, range.computeTo) }),
    readRows: (codes) => readSlotRows(table.db, codes),
    writeFromRead: (code, row, parts, fenceAtMs, startedMs) =>
      spliceFromRead(table.db, code, row, parts, fenceAtMs, startedMs),
    writeSplice: (code, parts, fenceAtMs, startedMs) => spliceSlotRow(table.db, code, parts, fenceAtMs, startedMs),
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

/**
 * Move a booking (#3334): its busy block and its cap count go from `from` to `to`,
 * exactly as the reschedule and reassign commits leave them before the refresh runs,
 * and the splice is told both the time taken and the time left.
 */
function move(w: World, from: { user: string; start: string }, to: { user: string; start: string }): BookedTime {
  const dur = w.ev.duration_min * 60_000;
  w.busy = w.busy.filter((b) => !(b.user_id === from.user && b.starts_at === from.start));
  w.bookings = w.bookings.filter((b) => !(b.user_id === from.user && b.starts_at === from.start));
  const end = iso(ms(to.start) + dur);
  w.busy.push({ user_id: to.user, starts_at: to.start, ends_at: end });
  w.bookings.push({ user_id: to.user, starts_at: to.start });
  return {
    userId: to.user,
    startsAt: to.start,
    endsAt: end,
    fenceAtMs: NOW,
    freed: { userId: from.user, startsAt: from.start, endsAt: iso(ms(from.start) + dur) },
  };
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

// --- a move: the time left goes back on offer, the time taken comes off (#3334) ---------
//
// A reschedule or reassign used to refresh only the booked code's pool, so the moved
// booking's NEW time stayed offered in the advisor's other pools, and its OLD time
// stayed withheld, until the lane reached them. Now both windows are spliced, in every
// pool either advisor serves, from the same batched reads a create makes.
{
  // An in place reschedule: A moves their own call from 10:00 to 14:00.
  const w = world();
  book(w, A, et("10:00"));
  const before = storedRows(w);
  assert(!(before.find((r) => r.bucket_code === "201")!.payload as { slots: string[] }).slots.includes(et("10:00")), "control: A's own pool withholds A's booked 10:00");
  const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("14:00") });
  const h = harness(w, before);
  const outcome = await spliceBookedTime(moved, h.deps);

  eq(outcome.pools, 2, "both of A's pools were visited");
  for (const code of ["201", "202"]) {
    const s = slotsOf(h, code);
    assert(s.includes(et("10:00")), `${code}: the time A left is back on offer`);
    assert(s.includes(et("09:50")), `${code}: and so is the start whose call ran into it`);
    assert(!s.includes(et("14:00")), `${code}: the time A moved to is gone`);
    assert(!s.includes(et("13:50")), `${code}: and so is the start whose call would run into it`);
    assert(s.includes(et("15:00")), `${code}: and the rest of the day is untouched`);
  }
  for (const code of ["101", "102"]) {
    assert(slotsOf(h, code).includes(et("14:00")), `${code}: B is still free at 14:00, so it stays on offer`);
  }
  eq(outcome.spliced, 2, "the pool only A serves was spliced");
  eq(outcome.unchanged, 2, "and the shared pool, which B kept offering throughout, needed no write");
  eq(h.table.statements.update, 2, "one compare and swap per changed code, carrying both windows");
  eq(h.calls.log.length + h.table.statements.select, 7, "and the same seven reads a create makes");
  eq(h.calls.busyWindows.length, 2, "busy time read over the two windows, which are hours apart");
  eq(h.invalidated.sort(), ["201", "202"], "each spliced code's edge cache entry is dropped");
}
{
  // A cross advisor reassign: A's 10:00 goes to B at the same time.
  const w = world();
  w.pools.push({ codes: ["301", "302"], members: [B] });
  book(w, A, et("10:00"));
  const before = storedRows(w);
  assert(
    (before.find((r) => r.bucket_code === "301")!.payload as { slots: string[] }).slots.includes(et("10:00")),
    "control: B's own pool offers 10:00 before the reassign",
  );
  const moved = move(w, { user: A, start: et("10:00") }, { user: B, start: et("10:00") });
  const h = harness(w, before);
  const outcome = await spliceBookedTime(moved, h.deps);

  eq(outcome.pools, 3, "every pool either advisor serves was visited");
  for (const code of ["201", "202"]) {
    assert(slotsOf(h, code).includes(et("10:00")), `${code}: the old advisor's pool offers the time again`);
  }
  for (const code of ["301", "302"]) {
    assert(!slotsOf(h, code).includes(et("10:00")), `${code}: the new advisor's pool no longer offers it`);
  }
  for (const code of ["101", "102"]) {
    assert(slotsOf(h, code).includes(et("10:00")), `${code}: the shared pool offers it throughout (A is free now)`);
  }
  eq(outcome.spliced, 4, "the two single advisor pools were spliced");
  eq(outcome.unchanged, 2, "and the shared one needed no write");
  eq(h.calls.log.filter((c) => c === "users").length, 1, "both advisors' pools come from ONE roster read");
  eq(h.calls.log.length + h.table.statements.select, 7, "and the reads are still seven");
}
{
  // The cap: A was at their cap of one on Tuesday, so every Tuesday time was refused
  // them. Moving the call to Wednesday frees the whole day, which is judged again.
  const w = world({ daily_cap: 1 });
  book(w, A, et("10:00"));
  w.busy.push({ user_id: B, starts_at: et("15:00"), ends_at: et("15:20") });
  const before = storedRows(w, 2);
  const shared = (before.find((r) => r.bucket_code === "101")!.payload as { slots: string[] }).slots;
  assert(!shared.includes(et("15:00")), "control: nobody could take 15:00 Tuesday (A capped, B busy)");
  const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("10:00", "2026-10-14") });
  const h = harness(w, before);
  const outcome = await spliceBookedTime(moved, h.deps);

  assert(slotsOf(h, "101").includes(et("15:00")), "hours from the freed call, 15:00 Tuesday is offered again");
  assert(
    !slotsOf(h, "201").includes(et("15:00", "2026-10-14")),
    "and the taken side widens too: Wednesday is closed in A's own pool",
  );
  // A's own pool offered NOTHING on Tuesday while A was capped, so Tuesday is a day
  // the stored strip does not have. Re-opening it waits for the next full compute.
  assert(
    !slotsOf(h, "201").some((t) => t.startsWith("2026-10-13")),
    "a day the row did not offer is not opened by a splice",
  );
  eq(outcome.widened, 2, "both pools widened");
  eq(h.calls.log.filter((c) => c === "count_bookings_per_local_day").length, 1, "from one cap count");
}
{
  // CONTROL for the freed widening: a move within the same day leaves A at the cap,
  // so nothing else on Tuesday may come back.
  const w = world({ daily_cap: 1 });
  book(w, A, et("10:00"));
  w.busy.push({ user_id: B, starts_at: et("15:00"), ends_at: et("15:20") });
  const before = storedRows(w);
  const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("11:00") });
  const h = harness(w, before);
  await spliceBookedTime(moved, h.deps);
  assert(!slotsOf(h, "101").includes(et("15:00")), "A is still at the cap on Tuesday, so 15:00 stays withheld");
  assert(slotsOf(h, "101").includes(et("10:00")), "while the time A left, which B is free for, is offered");
}
{
  // And a same day move UNDER the cap judges only the two calls' neighbourhoods: the
  // count read after the move still includes the booking on that day, so it does not
  // read as one fewer than before. Widening there would be correct but a whole day's
  // compute for nothing.
  const w = world({ daily_cap: 2 });
  book(w, A, et("10:00"));
  const before = storedRows(w);
  const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("11:00") });
  const h = harness(w, before);
  const outcome = await spliceBookedTime(moved, h.deps);
  eq(outcome.widened, 0, "one booking under a cap of two, moved within its day, widens nothing");
  assert(slotsOf(h, "201").includes(et("15:00")), "and a time hours away stays on offer");
}
{
  // The fence covers both windows on every code: a full compute that began before the
  // move and lands after its splice cannot put the NEW time back.
  const w = world();
  book(w, A, et("10:00"));
  const before = storedRows(w);
  const stale = storedRows(w); // what a compute that read before the move would write
  const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("14:00") });
  const h = harness(w, before);
  await spliceBookedTime(moved, h.deps);
  for (const code of ["201", "202"]) {
    const row = stale.find((r) => r.bucket_code === code)!;
    eq(await writeSlotRow(h.table.db, code, row.payload, NOW - 1, "lane"), "written", `${code}: the older compute lands`);
    assert(!slotsOf(h, code).includes(et("14:00")), `${code}: and the moved booking's new time stays gone`);
  }
}
{
  // A move whose two times are days apart reads busy time over the two windows only,
  // still in one statement, and the reads stay seven at twelve pools.
  for (const [pools, sole] of [
    [4, 1],
    [12, 3],
  ] as const) {
    const w = poolWorld(pools, sole);
    book(w, A, et("10:00"));
    const before = storedRows(w, 3);
    const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("14:00", "2026-10-15") });
    const h = harness(w, before);
    const outcome = await spliceBookedTime(moved, h.deps);
    eq(h.calls.log.length + h.table.statements.select, BATCHED_READS, `${pools} pools: a move makes the same seven reads`);
    eq(h.calls.log.filter((c) => c === "busy_blocks").length, 1, `${pools} pools: one busy statement`);
    eq(
      h.calls.busyWindows,
      [
        [et("09:40"), et("10:40")],
        [et("13:40", "2026-10-15"), et("14:40", "2026-10-15")],
      ],
      `${pools} pools: over the two windows, never the days between them`,
    );
    eq(h.table.statements.update, sole * 4, `${pools} pools: one write per code whose offer changed`);
    eq(outcome.spliced, sole * 4, `${pools} pools: A's own pools were spliced`);
  }
}
{
  // The reads only arm makes the same reads for a move and writes nothing.
  const w = world({ daily_cap: 1 });
  book(w, A, et("10:00"));
  const before = storedRows(w);
  const snapshot = JSON.stringify(before);
  const moved = move(w, { user: A, start: et("10:00") }, { user: A, start: et("14:00") });
  const on = harness(w, storedRows(w));
  await spliceBookedTime(moved, on.deps);
  const reads = harness(w, before);
  await spliceBookedTime(moved, reads.deps, { readsOnly: true });
  eq(reads.calls.log, on.calls.log, "reads only makes the move's batched reads");
  eq(reads.calls.busyWindows, on.calls.busyWindows, "over the same windows");
  eq(reads.table.statements.update, 0, "and writes no row");
  eq(JSON.stringify(reads.table.rows), snapshot, "leaving every row as it was");
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

// --- the edge cache drops run together, not one after another (#3332 review) ----------
// An advisor in twelve pools can splice dozens of codes, and each code's cached offer
// stays served until its drop lands, so a drop must not wait for the one before it.
{
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const started: string[] = [];
  const releases: (() => void)[] = [];
  let released = false;
  // A drop that starts after the release lands at once, so a serial loop fails the
  // assertion below and still finishes rather than hanging the run.
  h.deps.invalidate = (code) =>
    new Promise<void>((resolve) => {
      started.push(code);
      if (released) resolve();
      else releases.push(resolve);
    });
  // The handler is attached now, so a rejection during the waits below is caught here (L749).
  const settled = spliceBookedTime(booked, h.deps).then(
    (outcome) => ({ outcome, err: null }),
    (err: unknown) => ({ outcome: null, err }),
  );
  // Wait on the condition, bounded by turns of the event loop rather than wall time (L290).
  for (let turn = 0; turn < 500 && started.length < 2; turn++) await new Promise((r) => setImmediate(r));
  eq([...started].sort(), ["201", "202"], "both spliced codes' drops started while neither had finished");
  released = true;
  for (const release of releases) release();
  const { outcome, err } = await settled;
  eq(err, null, "and the splice finished once they landed");
  eq(outcome?.spliced, 2, "with both codes spliced");
}

// --- one drop failing costs the other code nothing ----------------------------------
{
  const w = world();
  const before = storedRows(w);
  const booked = book(w, A, et("10:00"));
  const h = harness(w, before);
  const dropped: string[] = [];
  h.deps.invalidate = async (code) => {
    if (code === "201") throw new Error("cache unavailable");
    dropped.push(code);
  };
  const outcome = await spliceBookedTime(booked, h.deps);
  eq(outcome.spliced, 2, "a failed drop does not unsplice a stored row");
  eq(outcome.failed, 0, "nor count the code as failed, since its row is right");
  eq(dropped, ["202"], "the other code's entry is still dropped");
  assert(
    h.warnings.some((m) => m === "edge cache drop for 201 failed"),
    "and the failed drop is logged, naming its code",
  );
}

finish();
