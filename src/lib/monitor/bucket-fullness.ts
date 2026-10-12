/**
 * A debt tier that is nearly full, said quietly before it reaches zero (#1256).
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
 * ## The debt tier, never a backend or legal pool (#3637)
 *
 * Dan, 2026-10-12: "all we really care about is the debt bucket. not
 * beyond/achieve or legal". This used to judge every pool the supply page draws,
 * and on 2026-10-12 at 1:40pm ET it said "Low with Beyond: none of 2 starts still
 * open" while those same leads were being offered 63 Low with Achieve times,
 * because a lead whose own pool is full is served by the rest of the tier. With
 * Beyond wound down to one or two people, a single booking took that pool under
 * the line, so it would have named it most days.
 *
 * ## The measurement is the supply report's, not a second one
 *
 * The share comes from `bucketSupplyReport` (#1254), read off the `counted` cells
 * of its tier readings (`TierSupply`): the times the tier's whole pool still
 * offers against the times it could have taken (offered plus booked through any of
 * the tier's codes, as distinct starts on one grid). Nothing here re-derives the
 * slot grid, the notice cutoff or the pooling of bookings (L107).
 *
 * ## The zero case is the booked solid page's (#1412)
 *
 * This owns the warning BEFORE zero; #1412 owns the moment it arrives. That page
 * names a code only when nothing on its whole ladder has a time, so any of a tier's
 * codes on it means the tier is at zero, and the tier is left to it rather than
 * telling the same person the same thing twice in two voices. When the scan's answer
 * is unknown (it was skipped or failed this tick), a tier with nothing open may be on
 * that page, so it is held back too; a tier with something left is still named.
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
import type { BucketSupplyReport } from "../admin/bucket-supply.ts";
import type { ThrottledNotify } from "./alert-deps.ts";

/** alert_state key for the whisper; the settings screen names it too. It and the
 *  function names keep "pool" from before #3637, because the key and the settings
 *  column `pool_nearly_full_open_pct` are stored under it. */
export const POOL_NEARLY_FULL_KEY = "pool_nearly_full";

export interface NearlyFullTier {
  /** The debt tier in words ("Low"). */
  label: string;
  /** Every bucket code in the tier. */
  codes: string[];
  /** Starts still offered across the days the booker shows. */
  open: number;
  /** Starts the tier could have taken across those days: offered plus booked. */
  capacity: number;
  /** The org local dates those are, which the notice names. */
  days: string[];
}

export type PoolFullnessResult =
  | { status: "unmeasured"; why: string }
  | { status: "measured"; judged: number; nearlyFull: NearlyFullTier[] };

/**
 * Which debt tiers are nearly full over the days the booker shows.
 *
 * `openShare` is the line from the monitor settings (#3559): a tier is named when
 * FEWER than that share of its possible starts are still open; exactly the share
 * is not named. `bookedSolidCodes` is what the booked solid page named on this
 * tick, or null when the scan did not reach a verdict.
 *
 * A tier is judged only when EVERY one of its window days was read: one unknown
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
  const nearlyFull: NearlyFullTier[] = [];
  for (const tier of report.tiers) {
    const days = tier.offeredDays;
    if (!days || days.length === 0) continue;
    let open = 0;
    let capacity = 0;
    let readable = true;
    for (const iso of days) {
      const i = column.get(iso);
      const cell = i === undefined ? undefined : tier.cells[i];
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
    // The zero case (#1412): the page owns a tier any of whose codes it named, and
    // an unknown scan might have named any tier with nothing open.
    if (paged !== null && tier.codes.some((c) => paged.has(c))) continue;
    if (paged === null && open === 0) continue;
    nearlyFull.push({ label: tier.label, codes: tier.codes, open, capacity, days });
  }
  return { status: "measured", judged, nearlyFull };
}

/** "Fri Oct 9, Sat Oct 10, Mon Oct 12". The dates are the org's own, so they
 *  need no zone. */
function dayList(days: string[]): string {
  return days.map((iso) => DateTime.fromISO(iso).toFormat("ccc LLL d")).join(", ");
}

function tierLine(t: NearlyFullTier, ownDays: boolean): string {
  const left = t.open === 0 ? "none" : `${t.open}`;
  const when = ownDays ? ` (${dayList(t.days)})` : "";
  return `${t.label}: ${left} of ${t.capacity} starts still open${when}.`;
}

/**
 * The whisper, or "" when no tier is nearly full, so nothing is sent rather than a
 * "0 tiers" post. The days are named once in the opening line and each tier gets
 * one total (Dan, 2026-10-09), so no fact is said twice. Tiers whose booker shows
 * different days (different notice) each name their own on their line instead,
 * because a shared list would claim days a tier's total does not cover.
 */
export function formatPoolNearlyFullNotice(tiers: NearlyFullTier[], openShare: number): string {
  if (!tiers.length) return "";
  const what = tiers.length === 1 ? "1 debt tier has" : `${tiers.length} debt tiers have`;
  const whose = tiers.length === 1 ? "its" : "their";
  const shared = tiers.every((t) => t.days.join() === tiers[0].days.join());
  const where = shared ? ` (${dayList(tiers[0].days)})` : "";
  return (
    `${what} fewer than ${Math.round(openShare * 100)}% of ${whose} possible starts still open ` +
    `across the days leads can book${where}. Nothing is broken: the calendars ` +
    `are filling up, so this is a nudge to add coverage before leads run out of times.\n` +
    tiers.map((t) => tierLine(t, !shared)).join("\n")
  );
}

/**
 * One monitor tick: build the supply report, judge the days the booker shows,
 * whisper if any debt tier is nearly full. A failed load is `unmeasured` and sends
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
          tiers: result.nearlyFull.length ? result.nearlyFull.map((t) => t.label).join(",") : null,
        }
      : { status: "unmeasured", why: result.why },
  );
  return result;
}
