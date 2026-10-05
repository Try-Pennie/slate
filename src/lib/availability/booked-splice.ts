import { DateTime } from "luxon";
import {
  affectedWindow,
  atCapBeforeMove,
  reachedDailyCap,
  spliceRanges,
  widenToLocalDay,
  type SlotLists,
  type SpliceEventType,
  type SplicePart,
  type SpliceRange,
} from "./slot-splice.ts";
import { assembleMemberAvailability, capCountWindow, type MemberAvailability } from "./compute.ts";
import type { SpliceRowOutcome, StoredSlotRow } from "./slot-row-write.ts";

export type { SpliceRange };

/**
 * After a booking, take the booked time out of what EVERY pool the booked advisor
 * serves is offering, within seconds, by re-judging only the window it can have
 * changed and splicing that into the stored rows (#3324).
 *
 * It replaced a whole pool recompute over the whole horizon for the booked code's
 * pool alone (#3293). That cost about 1.2s of CPU crowding per booking under load
 * (#3258) and left the advisor's other pools offering the taken time until the lane
 * reached them, up to four minutes. The window here is a call or so either side of
 * the booking, or the advisor's local day when the booking takes them to their cap.
 *
 * **The reads are batched across pools**, so their number does not grow with how many
 * pools the advisor serves (#3324 review: the load run's burst failed on a saturated
 * database, and a per pool shape cost about 77 calls a booking for a four pool
 * advisor and 209 for the twelve pool one). One read each for the roster (buckets
 * with their event types, active manual members, bookable advisors), one for the
 * schedules with their rules, one cap count, one busy read over the union of every
 * pool's window and members, and one read of every affected row. Each pool is then
 * computed in memory from those rows. The only thing that still scales is the row
 * WRITES, one compare and swap per code whose offer actually changed, which a bulk
 * RPC would collapse (see the PR for #3324).
 *
 * **A move splices two windows (#3334).** A reschedule or reassign takes one time and
 * leaves another, and refreshing only the booked code's pool left the new time on
 * offer, and the old one withheld, in every other pool until the lane came round. So
 * the time taken is spliced out of every pool its advisor serves, exactly as for a
 * create, and the time left is re-judged in every pool ITS advisor serves (the same
 * advisor for an in place reschedule) and may go back on offer (`reofferList`). Both
 * come from the same batched reads, so a move costs the reads a create does: one
 * roster read names both advisors' pools, and one busy statement covers both windows
 * however far apart they are. A code both windows touch is written once.
 *
 * Pure and dependency injected: `scripts/test-booked-splice.ts`.
 */

/** A booked call: who holds it, and when. */
export interface HeldTime {
  userId: string;
  startsAt: string;
  endsAt: string;
}

/** The booking, as the confirm knew it once its busy block had committed. */
export interface BookedTime extends HeldTime {
  /** An instant at or after the booking's busy block committed. Recorded in each row
   *  as the fence an older full compute must respect (see `slot-splice.ts`). */
  fenceAtMs: number;
  /** For a reschedule or reassign (#3334): the call as it was before the move, whose
   *  window goes back on offer wherever nothing else holds it. */
  freed?: HeldTime;
}

/** One pool the advisor serves, resolved from the batched roster read. */
export interface PoolPlan<C> {
  /** Every code in the pool, the representative first. */
  codes: string[];
  /** Which of the advisors asked about serve this pool (`loadPlan`). */
  servedBy: string[];
  eventType: SpliceEventType & { daily_cap: number | null };
  /** Who the pool routes to now, the fallback applied, as `eligibleAgentIds` says. */
  memberIds: string[];
  /** Whatever the caller's compute needs about the pool (bucket, event type, Low ids). */
  ctx: C;
}

export interface ScheduleRows {
  schedules: { id: string; user_id: string; timezone: string }[];
  rules: { schedule_id: string; weekday: number; start_minute: number; end_minute: number }[];
}

export type BusyRow = { user_id: string; starts_at: string; ends_at: string };

/** One stretch of time busy blocks are read over, [from, to). */
export interface BusySpan {
  from: string;
  to: string;
}

/** What one code's splice came to. `unchanged` means nothing in its windows
 *  changed, so no write was needed; `changed` means the row moved since the batched
 *  read and the caller re-reads it. */
export type BatchedRowOutcome = SpliceRowOutcome | "unchanged" | "changed";

export interface BookedSpliceDeps<C> {
  now(): number;
  /** Every pool any of these advisors serves, with who each routes to and which of
   *  them serve it. One batched roster read however many advisors are asked about. */
  loadPlan(userIds: string[]): Promise<PoolPlan<C>[]>;
  /** Schedules and their rules for every member of every pool. One read. */
  loadSchedules(userIds: string[]): Promise<ScheduleRows>;
  /** The per local day booking count, each advisor in their own zone. One RPC. */
  loadDayCounts(
    userIds: string[],
    tzByUser: Record<string, string>,
    from: string,
    to: string,
  ): Promise<Map<string, Map<string, number>>>;
  /** Busy time for every member over the read windows, merged into disjoint spans.
   *  One (paged) read however many spans there are. */
  loadBusy(userIds: string[], spans: BusySpan[]): Promise<BusyRow[]>;
  /** The shared slot predicate for one pool, over the range's COMPUTE window. */
  compute(pool: PoolPlan<C>, members: MemberAvailability[], range: SpliceRange, nowMs: number): SlotLists;
  /** Every affected code's stored row, in one read. A code with none is absent. */
  readRows(codes: string[]): Promise<Map<string, StoredSlotRow>>;
  /** Splice one code from the row already read (`spliceFromRead`). */
  writeFromRead(
    code: string,
    row: StoredSlotRow,
    parts: SplicePart[],
    fenceAtMs: number,
    computeStartedMs: number,
  ): Promise<BatchedRowOutcome>;
  /** Splice one code, reading it afresh (`spliceSlotRow`): the path for a row that
   *  changed under the batched read. */
  writeSplice(
    code: string,
    parts: SplicePart[],
    fenceAtMs: number,
    computeStartedMs: number,
  ): Promise<BatchedRowOutcome>;
  /** Drop one code's edge cache entry, so the next read serves the spliced row. */
  invalidate(code: string): Promise<void>;
  warn(msg: string, err?: unknown): void;
}

export interface BookedSpliceOutcome {
  /** Pools the advisor serves, every one of which was attempted. */
  pools: number;
  /** Codes whose row now has the booked window spliced in. */
  spliced: number;
  /** Codes whose offer the booking did not change, so nothing was written. */
  unchanged: number;
  /** Codes with no row yet, which the lane builds. */
  noRow: number;
  /** Codes whose splice failed; their rows are as they were and the lane covers them. */
  failed: number;
  /** Pools with a window widened to an advisor's whole day: the booking took them to
   *  the cap there, or (a move) took them off it. */
  widened: number;
}

/** How many times the window is computed again because something landed after the
 *  reads began (`recompute`). Past it the code is a failure for the lane. */
const COMPUTE_ATTEMPTS = 2;

/** At most this many row writes in flight at once, so one booking's splice cannot
 *  open a burst of connections on the database every confirm shares. */
export const SPLICE_WRITE_CONCURRENCY = 6;

const DEFAULT_ZONE = "America/New_York";

export async function spliceBookedTime<C>(
  booked: BookedTime,
  deps: BookedSpliceDeps<C>,
  opts: { readsOnly?: boolean } = {},
): Promise<BookedSpliceOutcome> {
  const outcome: BookedSpliceOutcome = { pools: 0, spliced: 0, unchanged: 0, noRow: 0, failed: 0, widened: 0 };
  // The time taken first, then the time left: where the two windows overlap, the
  // freed window's answer (authoritative both ways) is the one that stands.
  const sides: Side[] = [sideOf(booked, false)];
  if (booked.freed) sides.push(sideOf(booked.freed, true));
  const advisors = [...new Set(sides.map((s) => s.userId))];

  const plan = await deps.loadPlan(advisors);
  outcome.pools = plan.length;
  if (plan.length === 0) return outcome;

  let pending = new Set(plan.flatMap((p) => p.codes));
  const widened = new Set<PoolPlan<C>>();
  for (let attempt = 0; attempt < COMPUTE_ATTEMPTS && pending.size > 0; attempt++) {
    const pools = plan.filter((p) => p.codes.some((c) => pending.has(c)));
    // Before anything is read, so a booking fenced at or after it is one this round
    // cannot be shown to have seen.
    const computeStartedMs = deps.now();
    const memberIds = [...new Set([...advisors, ...pools.flatMap((p) => p.memberIds)])];

    const schedules = await deps.loadSchedules(memberIds);
    const tzByUser: Record<string, string> = {};
    for (const s of schedules.schedules) tzByUser[s.user_id] = s.timezone;
    const zoneOf = (userId: string) => tzByUser[userId] ?? DEFAULT_ZONE;

    // Every window to judge: each side in each pool its advisor serves. Each has a
    // narrow window and the day it widens to at the cap. The count is read once,
    // over the widest extent any of them could need, so deciding to widen costs no
    // second read.
    const jobs = pools.flatMap((pool) =>
      sides
        .filter((side) => pool.servedBy.includes(side.userId))
        .map((side) => ({ pool, side, narrow: affectedWindow(side.startMs, side.endMs, pool.eventType) })),
    );
    const wide = jobs.map((j) =>
      spliceRanges(widenToLocalDay(j.narrow, j.side.startMs, zoneOf(j.side.userId)), j.pool.eventType),
    );
    const countWindow = capCountWindow(
      new Date(Math.min(...wide.map((r) => Date.parse(r.readFrom)))).toISOString(),
      new Date(Math.max(...wide.map((r) => Date.parse(r.readTo)))).toISOString(),
    );
    const dayCounts = await deps.loadDayCounts(memberIds, tzByUser, countWindow.from, countWindow.to);

    const windows = jobs.map(({ pool, side, narrow }) => {
      const zone = zoneOf(side.userId);
      const member = { timezone: zone, dayCounts: dayCounts.get(side.userId) ?? new Map<string, number>() };
      const cap = pool.eventType.daily_cap;
      // The count already includes the booking where it now is. At the cap the
      // advisor is refused for the rest of that local day, so the whole day is
      // judged again; and a move OFF a capped day may have opened the whole of it.
      const atCap = side.reoffer
        ? atCapBeforeMove(member, side.startMs, cap, stillCountedThere(booked, side, zone))
        : reachedDailyCap(member, side.startMs, cap);
      if (!atCap) return narrow;
      widened.add(pool);
      return widenToLocalDay(narrow, side.startMs, zone);
    });
    const ranges = jobs.map((j, i) => spliceRanges(windows[i]!, j.pool.eventType));

    const busy = await deps.loadBusy(memberIds, busySpans(ranges));
    if (opts.readsOnly) {
      await deps.readRows([...pending]);
      break;
    }

    const nowMs = deps.now();
    const work: { code: string; parts: SplicePart[] }[] = [];
    for (const p of pools) {
      try {
        const members = assembleMemberAvailability(p.memberIds, schedules.schedules, schedules.rules, busy, dayCounts);
        const parts: SplicePart[] = [];
        jobs.forEach((j, i) => {
          if (j.pool !== p) return;
          const judge = deps.compute(p, members, ranges[i]!, nowMs);
          parts.push(j.side.reoffer ? { w: windows[i]!, judge, reoffer: true } : { w: windows[i]!, judge });
        });
        for (const code of p.codes) if (pending.has(code)) work.push({ code, parts });
      } catch (err) {
        // One pool's compute cannot cost another pool its splice (L73).
        const codes = p.codes.filter((c) => pending.has(c));
        outcome.failed += codes.length;
        for (const c of codes) pending.delete(c);
        deps.warn(`splice compute for pool ${p.codes.join("+")} failed`, err);
      }
    }

    const rows = await deps.readRows(work.map((x) => x.code));
    const settled = await mapBounded(work, SPLICE_WRITE_CONCURRENCY, async ({ code, parts }) => {
      const row = rows.get(code);
      if (!row) return "no-row" as const;
      let result: BatchedRowOutcome;
      try {
        const first = await deps.writeFromRead(code, row, parts, booked.fenceAtMs, computeStartedMs);
        // The row moved since the batched read: read it afresh, through the
        // single code path's own bounded retries.
        result = first === "changed"
          ? await deps.writeSplice(code, parts, booked.fenceAtMs, computeStartedMs)
          : first;
      } catch (err) {
        deps.warn(`splice of ${code} threw`, err);
        return "failed" as const;
      }
      // Dropped the moment this code's row is stored, beside the other codes' writes,
      // rather than one after another once every write is done: each code's cached
      // offer is served until its own drop lands (#3332 review).
      if (result === "spliced") {
        await deps.invalidate(code).catch((err) => deps.warn(`edge cache drop for ${code} failed`, err));
      }
      return result;
    });

    const again = new Set<string>();
    for (let i = 0; i < work.length; i++) {
      const code = work[i]!.code;
      const result = settled[i]!;
      if (result === "spliced") outcome.spliced++;
      else if (result === "unchanged") outcome.unchanged++;
      else if (result === "no-row") outcome.noRow++;
      else if (result === "recompute" && attempt + 1 < COMPUTE_ATTEMPTS) again.add(code);
      else {
        outcome.failed++;
        deps.warn(`splice of ${code} was not stored (${result}); its row is unchanged and the lane covers it`);
      }
    }
    pending = again;
  }
  outcome.widened = widened.size;
  return outcome;
}

/** One side of a booking: the time it now holds, or (a move) the time it left. */
interface Side {
  userId: string;
  startMs: number;
  endMs: number;
  reoffer: boolean;
}

function sideOf(t: HeldTime, reoffer: boolean): Side {
  // parse-ok: both come from the stored booking, NOT NULL timestamptz columns.
  return { userId: t.userId, startMs: Date.parse(t.startsAt), endMs: Date.parse(t.endsAt), reoffer };
}

/** Whether the moved booking still counts on the freed start's local day: it stayed
 *  with the same advisor, on the same day in their zone. */
function stillCountedThere(booked: BookedTime, freed: Side, zone: string): boolean {
  if (booked.userId !== freed.userId) return false;
  const day = (ms: number) => DateTime.fromMillis(ms, { zone }).toISODate();
  // parse-ok: from the stored booking, a NOT NULL timestamptz column.
  return day(Date.parse(booked.startsAt)) === day(freed.startMs);
}

/**
 * The read windows as the fewest disjoint spans: overlapping or touching ranges are
 * merged, so a create (whose every pool's window contains the booked call) reads one
 * span, and a move whose two times are days apart reads two rather than every busy
 * block between them.
 */
export function busySpans(ranges: Pick<SpliceRange, "readFrom" | "readTo">[]): BusySpan[] {
  const sorted = ranges
    .map((r) => ({ from: Date.parse(r.readFrom), to: Date.parse(r.readTo) }))
    .sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out.map((r) => ({ from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString() }));
}

/** `fn` over `items` with at most `limit` in flight, results in input order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
