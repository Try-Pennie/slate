/**
 * A pool that is nearly full, said quietly before it reaches zero (#1256).
 *
 * The booked solid page (#1412) fires when a tier has no times at all. Thin tier
 * staffing (#569) whispers when a tier rests on one or two people. Neither notices a
 * pool that is heavily booked and not yet closed: on 2026-08-04 the 52x pools were
 * down to 9 of 21 starts and nothing anywhere said so.
 *
 * ## Over the days the booker shows, added up (#3559)
 *
 * It used to judge TODAY alone, which named ten pools at 8:01am on Friday
 * 2026-10-09 because today was full while Saturday and Monday, both on every
 * lead's strip, had room. Dan, that morning: judge "the next x days, x being the
 * number of days shown the booker at the time of the check", and add them up, so
 * the notice fires when the whole strip a lead sees is nearly gone. The days are
 * the row's `offeredDays`, which the supply report takes from `offeredWindowFor`,
 * the function the booker cuts its strip with, so a change to the offered days
 * moves this notice with it.
 *
 * ## The measurement is the supply page's, not a second one
 *
 * The share comes from `bucketSupplyReport` (#1254), the same report /admin/supply
 * draws, read off its `counted` cells: the times still offered against the times
 * the pool could have taken (offered plus already booked, as distinct starts on one
 * grid). Nothing here re-derives the slot grid, the notice cutoff or the pooling of
 * bookings across a pool's codes (L107). A pool's codes carry one reading, so the
 * pool is judged once and named once, by `supplyPoolGroups`, the grouping the page
 * itself uses.
 *
 * ## The zero case is the booked solid page's (#1412)
 *
 * This owns the warning BEFORE zero; #1412 owns the moment it arrives. So a pool
 * whose codes the booked solid page named on this tick is left to it, rather than
 * telling the same person the same thing twice in two voices. When the scan's answer
 * is unknown (it was skipped or failed this tick), a pool with nothing open may be on
 * that page, so it is held back too; a pool with something left is still named.
 *
 * ## A whisper, never a page
 *
 * Dan, 2026-10-02: quiet info, live from day one. A full calendar is a good outcome
 * and the action is staffing, not a fix. Info notices never resolve.
 *
 * Pure (luxon, type imports and relative imports), so scripts/test-bucket-fullness.ts
 * drives every branch node natively.
 */
import { DateTime } from "luxon";
import { supplyPoolGroups, type BucketSupplyReport } from "../admin/bucket-supply.ts";
import type { ThrottledNotify } from "./alert-deps.ts";

/** alert_state key for the whisper; the settings screen names it too. */
export const POOL_NEARLY_FULL_KEY = "pool_nearly_full";

export interface NearlyFullPool {
  /** The pool in words, or null when the roster could not say which pool it is. */
  label: string | null;
  codes: string[];
  /** Starts still offered across the days the booker shows. */
  open: number;
  /** Starts the pool could have taken across those days: offered plus booked. */
  capacity: number;
  /** The org local dates those are, which the notice names. */
  days: string[];
}

export type PoolFullnessResult =
  | { status: "unmeasured"; why: string }
  | { status: "measured"; judged: number; nearlyFull: NearlyFullPool[] };

/**
 * Which pools are nearly full over the days the booker shows.
 *
 * `openShare` is the line from the monitor settings (#3559): a pool is named when
 * FEWER than that share of its possible starts are still open; exactly the share
 * is not named. `bookedSolidCodes` is what the booked solid page named on this
 * tick, or null when the scan did not reach a verdict.
 *
 * A pool is judged only when EVERY one of its window days was read: one unknown
 * day, or a day the report does not hold, would put a share over part of the
 * strip in front of somebody as the whole of it (L530). A closed day, or one with
 * nothing countable, adds nothing to either side.
 */
export function judgePoolFullness(input: {
  report: BucketSupplyReport;
  bookedSolidCodes: string[] | null;
  openShare: number;
}): PoolFullnessResult {
  const { report } = input;
  if (!report.measurable) return { status: "unmeasured", why: `supply report: ${report.reason}` };
  const column = new Map(report.days.map((d, i) => [d.iso, i]));

  const paged = input.bookedSolidCodes === null ? null : new Set(input.bookedSolidCodes);
  let judged = 0;
  const nearlyFull: NearlyFullPool[] = [];
  for (const group of supplyPoolGroups(report.rows, report.nowMs)) {
    const row = group.rows[0];
    const days = row?.offeredDays;
    if (!row || !days || days.length === 0) continue;
    let open = 0;
    let capacity = 0;
    let readable = true;
    for (const iso of days) {
      const i = column.get(iso);
      const cell = i === undefined ? undefined : row.cells[i];
      if (!cell || cell.kind === "unknown") {
        readable = false;
        break;
      }
      if (cell.kind !== "counted" || cell.capacity <= 0) continue;
      open += cell.capacity - cell.booked;
      capacity += cell.capacity;
    }
    if (!readable || capacity <= 0) continue;
    judged++;
    if (open / capacity >= input.openShare) continue;
    // The zero case (#1412): the page owns a pool it named, and an unknown scan
    // might have named any pool with nothing open.
    if (paged !== null && group.codes.some((c) => paged.has(c))) continue;
    if (paged === null && open === 0) continue;
    nearlyFull.push({ label: group.label, codes: group.codes, open, capacity, days });
  }
  return { status: "measured", judged, nearlyFull };
}

function poolLine(p: NearlyFullPool): string {
  const name = p.label ?? `bucket ${p.codes.join(", ")}`;
  const left = p.open === 0 ? "none" : `${p.open}`;
  return `${name}: ${left} of ${p.capacity} starts still open.`;
}

/** "Fri Oct 9, Sat Oct 10, Mon Oct 12": every pool's days, once each, in order.
 *  The dates are the org's own, so they need no zone. */
function dayList(pools: NearlyFullPool[]): string {
  const isos = [...new Set(pools.flatMap((p) => p.days))].sort();
  return isos.map((iso) => DateTime.fromISO(iso).toFormat("ccc LLL d")).join(", ");
}

/**
 * The whisper, or "" when no pool is nearly full, so nothing is sent rather than a
 * "0 pools" post. The days are named once in the opening line and each pool gets
 * one total (Dan, 2026-10-09), so no fact is said twice.
 */
export function formatPoolNearlyFullNotice(pools: NearlyFullPool[], openShare: number): string {
  if (!pools.length) return "";
  const what = pools.length === 1 ? "1 pool has" : `${pools.length} pools have`;
  const whose = pools.length === 1 ? "its" : "their";
  return (
    `${what} fewer than ${Math.round(openShare * 100)}% of ${whose} possible starts still open ` +
    `across the days leads can book (${dayList(pools)}). Nothing is broken: the calendars ` +
    `are filling up, so this is a nudge to add coverage before leads run out of times.\n` +
    pools.map(poolLine).join("\n")
  );
}

/**
 * One monitor tick: build the supply report, judge the days the booker shows,
 * whisper if any pool is nearly full. A failed load is `unmeasured` and sends
 * nothing; a refused post never fails the tick.
 */
export async function runPoolFullnessCheck(deps: {
  loadReport: () => Promise<BucketSupplyReport>;
  bookedSolidCodes: string[] | null;
  /** The line from the monitor settings, as a fraction. */
  openShare: number;
  notify: ThrottledNotify;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<PoolFullnessResult> {
  let report: BucketSupplyReport;
  try {
    report = await deps.loadReport();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.log?.({ status: "unmeasured", why });
    return { status: "unmeasured", why };
  }
  const result = judgePoolFullness({
    report,
    bookedSolidCodes: deps.bookedSolidCodes,
    openShare: deps.openShare,
  });
  if (result.status === "measured" && result.nearlyFull.length) {
    await deps
      .notify(POOL_NEARLY_FULL_KEY, deps.cooldownMs, formatPoolNearlyFullNotice(result.nearlyFull, deps.openShare))
      // A failed post keeps the tick alive, and is logged so it never reads like a
      // notice that was not due.
      .catch((err: unknown) => deps.log?.({ status: "notify-failed", why: err instanceof Error ? err.message : String(err) }));
  }
  deps.log?.(
    result.status === "measured"
      ? {
          status: "measured",
          judged: result.judged,
          nearly_full: result.nearlyFull.length,
          open_share: deps.openShare,
          pools: result.nearlyFull.length ? result.nearlyFull.map((p) => p.codes.join("+")).join(",") : null,
        }
      : { status: "unmeasured", why: result.why },
  );
  return result;
}
