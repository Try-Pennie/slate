import {
  affectedWindow,
  reachedDailyCap,
  spliceRanges,
  widenToLocalDay,
  type SlotLists,
  type SpliceEventType,
  type SpliceRange,
  type SpliceWindow,
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
 * Pure and dependency injected: `scripts/test-booked-splice.ts`.
 */

/** The booking, as the confirm knew it once its busy block had committed. */
export interface BookedTime {
  userId: string;
  startsAt: string;
  endsAt: string;
  /** An instant at or after the booking's busy block committed. Recorded in each row
   *  as the fence an older full compute must respect (see `slot-splice.ts`). */
  fenceAtMs: number;
}

/** One pool the advisor serves, resolved from the batched roster read. */
export interface PoolPlan<C> {
  /** Every code in the pool, the representative first. */
  codes: string[];
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

/** What one code's splice came to. `unchanged` means nothing in the window was
 *  removed, so no write was needed; `changed` means the row moved since the batched
 *  read and the caller re-reads it. */
export type BatchedRowOutcome = SpliceRowOutcome | "unchanged" | "changed";

export interface BookedSpliceDeps<C> {
  now(): number;
  /** The pools the advisor serves, with who each routes to. One batched roster read. */
  loadPlan(userId: string): Promise<PoolPlan<C>[]>;
  /** Schedules and their rules for every member of every pool. One read. */
  loadSchedules(userIds: string[]): Promise<ScheduleRows>;
  /** The per local day booking count, each advisor in their own zone. One RPC. */
  loadDayCounts(
    userIds: string[],
    tzByUser: Record<string, string>,
    from: string,
    to: string,
  ): Promise<Map<string, Map<string, number>>>;
  /** Busy time for every member over the union of the read windows. One (paged) read. */
  loadBusy(userIds: string[], from: string, to: string): Promise<BusyRow[]>;
  /** The shared slot predicate for one pool, over the range's COMPUTE window. */
  compute(pool: PoolPlan<C>, members: MemberAvailability[], range: SpliceRange, nowMs: number): SlotLists;
  /** Every affected code's stored row, in one read. A code with none is absent. */
  readRows(codes: string[]): Promise<Map<string, StoredSlotRow>>;
  /** Splice one code from the row already read (`spliceFromRead`). */
  writeFromRead(
    code: string,
    row: StoredSlotRow,
    w: SpliceWindow,
    judge: SlotLists,
    fenceAtMs: number,
    computeStartedMs: number,
  ): Promise<BatchedRowOutcome>;
  /** Splice one code, reading it afresh (`spliceSlotRow`): the path for a row that
   *  changed under the batched read. */
  writeSplice(
    code: string,
    w: SpliceWindow,
    judge: SlotLists,
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
  /** Pools whose window widened to the advisor's whole day (the booking hit the cap). */
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
  // parse-ok: both come from the stored booking, NOT NULL timestamptz columns.
  const startMs = Date.parse(booked.startsAt);
  // parse-ok: as above.
  const endMs = Date.parse(booked.endsAt);

  const plan = await deps.loadPlan(booked.userId);
  outcome.pools = plan.length;
  if (plan.length === 0) return outcome;

  let pending = new Set(plan.flatMap((p) => p.codes));
  const widened = new Set<PoolPlan<C>>();
  for (let attempt = 0; attempt < COMPUTE_ATTEMPTS && pending.size > 0; attempt++) {
    const pools = plan.filter((p) => p.codes.some((c) => pending.has(c)));
    // Before anything is read, so a booking fenced at or after it is one this round
    // cannot be shown to have seen.
    const computeStartedMs = deps.now();
    const memberIds = [...new Set([booked.userId, ...pools.flatMap((p) => p.memberIds)])];

    const schedules = await deps.loadSchedules(memberIds);
    const tzByUser: Record<string, string> = {};
    for (const s of schedules.schedules) tzByUser[s.user_id] = s.timezone;
    const advisorZone = tzByUser[booked.userId] ?? DEFAULT_ZONE;

    // Each pool's narrow window, and the day it widens to at the cap. The count is
    // read once, over the widest extent any pool could need, so deciding to widen
    // costs no second read.
    const narrow = pools.map((p) => affectedWindow(startMs, endMs, p.eventType));
    const wide = pools.map((p, i) => spliceRanges(widenToLocalDay(narrow[i]!, startMs, advisorZone), p.eventType));
    const countWindow = capCountWindow(
      new Date(Math.min(...wide.map((r) => Date.parse(r.readFrom)))).toISOString(),
      new Date(Math.max(...wide.map((r) => Date.parse(r.readTo)))).toISOString(),
    );
    const dayCounts = await deps.loadDayCounts(memberIds, tzByUser, countWindow.from, countWindow.to);

    const advisor = { timezone: advisorZone, dayCounts: dayCounts.get(booked.userId) ?? new Map<string, number>() };
    const windows = pools.map((p, i) => {
      // The count already includes this booking. At the cap the advisor is refused
      // for the rest of their local day, so the whole day is judged again.
      if (reachedDailyCap(advisor, startMs, p.eventType.daily_cap)) {
        widened.add(p);
        return widenToLocalDay(narrow[i]!, startMs, advisorZone);
      }
      return narrow[i]!;
    });
    const ranges = pools.map((p, i) => spliceRanges(windows[i]!, p.eventType));

    const busy = await deps.loadBusy(
      memberIds,
      new Date(Math.min(...ranges.map((r) => Date.parse(r.readFrom)))).toISOString(),
      new Date(Math.max(...ranges.map((r) => Date.parse(r.readTo)))).toISOString(),
    );
    if (opts.readsOnly) {
      await deps.readRows([...pending]);
      break;
    }

    const nowMs = deps.now();
    const work: { code: string; w: SpliceWindow; judge: SlotLists }[] = [];
    pools.forEach((p, i) => {
      try {
        const members = assembleMemberAvailability(p.memberIds, schedules.schedules, schedules.rules, busy, dayCounts);
        const judge = deps.compute(p, members, ranges[i]!, nowMs);
        for (const code of p.codes) if (pending.has(code)) work.push({ code, w: windows[i]!, judge });
      } catch (err) {
        // One pool's compute cannot cost another pool its splice (L73).
        const codes = p.codes.filter((c) => pending.has(c));
        outcome.failed += codes.length;
        for (const c of codes) pending.delete(c);
        deps.warn(`splice compute for pool ${p.codes.join("+")} failed`, err);
      }
    });

    const rows = await deps.readRows(work.map((x) => x.code));
    const settled = await mapBounded(work, SPLICE_WRITE_CONCURRENCY, async ({ code, w, judge }) => {
      const row = rows.get(code);
      if (!row) return "no-row" as const;
      try {
        const first = await deps.writeFromRead(code, row, w, judge, booked.fenceAtMs, computeStartedMs);
        // The row moved since the batched read: read it afresh, through the
        // single code path's own bounded retries.
        return first === "changed"
          ? await deps.writeSplice(code, w, judge, booked.fenceAtMs, computeStartedMs)
          : first;
      } catch (err) {
        deps.warn(`splice of ${code} threw`, err);
        return "failed" as const;
      }
    });

    const again = new Set<string>();
    for (let i = 0; i < work.length; i++) {
      const code = work[i]!.code;
      const result = settled[i]!;
      if (result === "spliced") {
        outcome.spliced++;
        await deps.invalidate(code).catch((err) => deps.warn(`edge cache drop for ${code} failed`, err));
      } else if (result === "unchanged") outcome.unchanged++;
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
