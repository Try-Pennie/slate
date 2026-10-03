/**
 * A pool that is nearly full for the day, said quietly before it reaches zero (#1256).
 *
 * The booked solid page (#1412) fires when a tier has no times at all. Thin tier
 * staffing (#569) whispers when a tier rests on one or two people. Neither notices a
 * pool that is heavily booked and not yet closed: on 2026-08-04 the 52x pools were
 * down to 9 of 21 starts and nothing anywhere said so.
 *
 * ## The measurement is the supply page's, not a second one
 *
 * The share comes from `bucketSupplyReport` (#1254), the same report /admin/supply
 * draws, read off TODAY's `counted` cell: the times still offered against the times
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
 * Pure (type imports and one relative import), so scripts/test-bucket-fullness.ts
 * drives every branch node natively.
 */
import { supplyPoolGroups, type BucketSupplyReport } from "../admin/bucket-supply.ts";
import type { ThrottledNotify } from "./alert-deps.ts";

/** alert_state key for the whisper; the settings screen names it too. */
export const POOL_NEARLY_FULL_KEY = "pool_nearly_full";

/**
 * Whisper when FEWER THAN this share of a pool's possible starts for the day are
 * still open (Dan, 2026-10-02). Strictly fewer: exactly 10% open is not named.
 */
export const POOL_NEARLY_FULL_OPEN_SHARE = 0.1;

export interface NearlyFullPool {
  /** The pool in words, or null when the roster could not say which pool it is. */
  label: string | null;
  codes: string[];
  /** Starts still offered today. */
  open: number;
  /** Starts the pool could have taken today: offered plus already booked. */
  capacity: number;
}

export type PoolFullnessResult =
  | { status: "unmeasured"; why: string }
  | { status: "measured"; judged: number; nearlyFull: NearlyFullPool[] };

/**
 * Which pools are nearly full today.
 *
 * `bookedSolidCodes` is what the booked solid page named on this tick, or null when
 * the scan did not reach a verdict.
 */
export function judgePoolFullness(input: {
  report: BucketSupplyReport;
  todayIso: string;
  bookedSolidCodes: string[] | null;
}): PoolFullnessResult {
  const { report } = input;
  if (!report.measurable) return { status: "unmeasured", why: `supply report: ${report.reason}` };
  const dayIndex = report.days.findIndex((d) => d.iso === input.todayIso);
  if (dayIndex === -1) return { status: "unmeasured", why: "the report does not hold today" };

  const paged = input.bookedSolidCodes === null ? null : new Set(input.bookedSolidCodes);
  let judged = 0;
  const nearlyFull: NearlyFullPool[] = [];
  for (const group of supplyPoolGroups(report.rows, report.nowMs)) {
    const cell = group.rows[0]?.cells[dayIndex];
    if (!cell || cell.kind !== "counted" || cell.capacity <= 0) continue;
    judged++;
    const open = cell.capacity - cell.booked;
    if (open / cell.capacity >= POOL_NEARLY_FULL_OPEN_SHARE) continue;
    // The zero case (#1412): the page owns a pool it named, and an unknown scan
    // might have named any pool with nothing open.
    if (paged !== null && group.codes.some((c) => paged.has(c))) continue;
    if (paged === null && open === 0) continue;
    nearlyFull.push({ label: group.label, codes: group.codes, open, capacity: cell.capacity });
  }
  return { status: "measured", judged, nearlyFull };
}

function poolLine(p: NearlyFullPool): string {
  const name = p.label ?? `bucket ${p.codes.join(", ")}`;
  const left = p.open === 0 ? "none" : `${p.open}`;
  return `${name}: ${left} of today's ${p.capacity} starts still open.`;
}

/**
 * The whisper, or "" when no pool is nearly full, so nothing is sent rather than a
 * "0 pools" post.
 */
export function formatPoolNearlyFullNotice(pools: NearlyFullPool[]): string {
  if (!pools.length) return "";
  const what = pools.length === 1 ? "1 pool has" : `${pools.length} pools have`;
  return (
    `${what} fewer than ${Math.round(POOL_NEARLY_FULL_OPEN_SHARE * 100)}% of today's ` +
    `possible starts still open. Nothing is broken: the calendars are filling up, so ` +
    `this is a nudge to add coverage before leads run out of times.\n` +
    pools.map(poolLine).join("\n")
  );
}

/**
 * One monitor tick: build the supply report, judge today, whisper if any pool is
 * nearly full. A failed load is `unmeasured` and sends nothing; a refused post never
 * fails the tick.
 */
export async function runPoolFullnessCheck(deps: {
  loadReport: () => Promise<BucketSupplyReport>;
  todayIso: string;
  bookedSolidCodes: string[] | null;
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
    todayIso: deps.todayIso,
    bookedSolidCodes: deps.bookedSolidCodes,
  });
  if (result.status === "measured" && result.nearlyFull.length) {
    await deps
      .notify(POOL_NEARLY_FULL_KEY, deps.cooldownMs, formatPoolNearlyFullNotice(result.nearlyFull))
      .catch(() => {});
  }
  deps.log?.(
    result.status === "measured"
      ? {
          status: "measured",
          judged: result.judged,
          nearly_full: result.nearlyFull.length,
          pools: result.nearlyFull.length ? result.nearlyFull.map((p) => p.codes.join("+")).join(",") : null,
        }
      : { status: "unmeasured", why: result.why },
  );
  return result;
}
