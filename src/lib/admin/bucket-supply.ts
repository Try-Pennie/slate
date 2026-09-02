/**
 * Per bucket, per day: how much availability Slate is OFFERING, and how much it
 * could have offered (#1254).
 *
 * The question this exists for was asked on 2026-08-04 ("are we truly fully
 * booked today across all calendars?") and the only way to answer it was a hand
 * written query against `bucket_slots`. Every surface that already existed
 * answered a nearby question instead: the availability canary says whether the
 * fleet looks broken, `listBucketSlotCounts` says how many slots a bucket has
 * across the WHOLE horizon (so plenty on day three hides nothing today), and the
 * hour grid says whether ANYONE could be booked rather than how deep a given
 * pool is.
 *
 * ## The maximum is not computed here
 *
 * A count of open slots means nothing on its own: nine is thin for one bucket and
 * everything the day had for another. So each day carries the theoretical
 * maximum, and that maximum is produced by running the BOOKER'S OWN
 * `computeBucketSlots` over a single synthetic agent who is on shift for the
 * whole of the org's day and has an empty calendar. Nothing here re-derives how a
 * slot grid is laid out, where the notice cutoff lands, or how a window's last
 * slot is decided (L107): a second definition of that would agree with the booker
 * exactly until one of them changed, and it would drift in the direction that
 * flatters the reading, because the reading is what somebody is looking at.
 *
 * ## Zero and could not read are different answers
 *
 * Every state a cell can be in is named. A day the org is shut, a day with no
 * whole slot left after the notice cutoff, a day past this bucket's own horizon,
 * a bucket whose cached payload could not be measured, and a real zero are five
 * different things and four of them are not "booked solid" (L10). The report
 * itself refuses to be built at all when the org's week cannot be read, because
 * every maximum on the page is derived from it and a page of shares computed
 * against a maximum nobody measured would be believed.
 *
 * Pure (luxon plus pure imports), so `scripts/test-bucket-supply.ts` drives every
 * branch node natively.
 */
import { DateTime } from "luxon";
import { windowOnDate } from "../booking/business-hours.ts";
import {
  computeBucketSlots,
  slotsWithinBusinessHours,
  type BusinessHoursRules,
  type MemberAvailability,
} from "../availability/compute.ts";
import { parseStampMs } from "../date/stamp.ts";
import { searchWindowDays } from "../availability/bookable-days.ts";
import {
  RECOMPUTE_FRESH_MS,
  STALE_ALARM_MS,
} from "../availability/precompute-cron.ts";

/**
 * The event-type numbers the slot grid is laid out from. The same fields the
 * booker reads, taken from the bucket's OWN cached payload, so the maximum is
 * derived from the settings that produced the slots beside it rather than from a
 * separately loaded copy that may have moved since.
 */
export interface SupplyEventType {
  duration_min: number;
  slot_interval_min: number;
  min_notice_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
}

/** A `bucket_slots` row as this module needs it. */
export interface CachedSlotRow {
  bucket_code: string;
  payload: {
    slots?: string[];
    eventType?: Partial<SupplyEventType> | null;
  } | null;
  computed_at: string;
}

/** One column: a concrete date in the ORG's zone, so a real offset and that
 *  week's DST apply. */
export interface SupplyDay {
  /** yyyy-mm-dd in the org's zone. */
  iso: string;
  /** Luxon weekday, 1 = Monday. */
  weekday: number;
}

/**
 * What one bucket is offering on one day.
 *
 * `closed` and `no-capacity` are properties of the DAY, so they are stated even
 * for a bucket whose own cache could not be read: they are known either way, and
 * saying "unknown" about a day the office is shut would be worse than useless.
 */
export type SupplyCell =
  /** The org is shut. Nothing was ever going to be offered. */
  | { kind: "closed" }
  /**
   * The org is open but no whole appointment fits between the notice cutoff and
   * the close. Today after the last bookable start looks exactly like a fully
   * booked day in a raw count, and it is the opposite of a problem.
   */
  | { kind: "no-capacity" }
  /**
   * Past this bucket's own horizon: it already found its allowance of bookable
   * days earlier in the window, so nothing was computed this far out. A zero here
   * would read as booked solid (the same trap `withinHorizon` exists for in the
   * hour grid).
   */
  | { kind: "beyond-horizon" }
  /** This bucket's cached payload could not be measured. NOT zero. */
  | { kind: "unknown" }
  /** A real measurement. `share` is `open / max`, and `max` is always > 0. */
  | { kind: "counted"; open: number; max: number; share: number };

/**
 * How a bucket's cached row read.
 *
 * `missing` (no row at all) and `unreadable` (a row whose payload carries no slot
 * list or no event type) are kept apart because they call for different things: a
 * bucket that has never been computed is waiting on the recompute lane, and one
 * whose payload we cannot parse is a data problem.
 */
export type BucketCacheState = "measured" | "missing" | "unreadable";

/**
 * How long ago this bucket was recomputed, judged against the recompute lane's
 * OWN windows rather than a number invented here, so widening the lane's
 * freshness window moves this readout with it.
 */
export type SupplyFreshness = "fresh" | "aging" | "stale" | "unknown";

export interface BucketSupplyRow {
  code: string;
  name: string;
  /**
   * Eligible agents by the same criteria match ROUTING uses, not
   * `bucket_members` (which holds three rows in production and is not the
   * eligibility source). `null` means the roster could not be read, which is not
   * zero agents.
   */
  depth: number | null;
  /** Depth minus the eligible agents who are out today. `null` as above. */
  effectiveDepth: number | null;
  cacheState: BucketCacheState;
  /** Epoch ms of the last recompute; null when there is no row, or its stamp
   *  could not be read. */
  computedAtMs: number | null;
  freshness: SupplyFreshness;
  /** One cell per entry of `days`, in the same order. */
  cells: SupplyCell[];
}

/**
 * The whole report, or the reason there is no report.
 *
 * A union rather than a `measurable` flag beside the rows, so a caller cannot
 * render a table it was never handed.
 */
export type BucketSupplyReport =
  | {
      measurable: false;
      /**
       * `business-hours`: the org's week could not be read, so no maximum on the
       * page could be derived and no share could be honest.
       * `slot-cache`: `bucket_slots` could not be read, so nothing is known about
       * what is being offered.
       * `booking-horizon`: the org's horizon could not be read (#1654). It sets
       * both how many day columns exist and where each bucket's own allowance
       * runs out, so a guessed one does not make a share unavailable, it silently
       * changes what every share MEANS. That is the worst of the three to get
       * wrong, because the resulting number looks entirely normal.
       */
      reason: "business-hours" | "slot-cache" | "booking-horizon";
    }
  | {
      measurable: true;
      zone: string;
      horizonDays: number;
      days: SupplyDay[];
      rows: BucketSupplyRow[];
      /** False when the bucket list could not be read, so the rows came from the
       *  cache and a never-computed bucket is missing from the page entirely. */
      bucketListReadable: boolean;
      /** False when the roster read failed: every `depth` is null, and the page
       *  must say why rather than showing a column of blanks. */
      depthReadable: boolean;
    };

/** A bucket as the bucket list supplies it. */
export interface SupplyBucket {
  code: string;
  name: string;
}

/** The eligible-agent depth routing would resolve for one bucket. */
export interface SupplyDepth {
  depth: number;
  effectiveDepth: number;
}

export interface BucketSupplyInput {
  /** The org's week and its date exceptions. */
  hours: BusinessHoursRules;
  /** Bookable days the booker is configured to offer. */
  horizonDays: number;
  nowMs: number;
  /**
   * Every non-test bucket, or `null` when the bucket list could not be read.
   * Null does NOT mean there are no buckets: the rows then come from the cache
   * instead, which loses only the buckets that have never been computed.
   */
  buckets: SupplyBucket[] | null;
  /**
   * Eligible-agent depth by bucket code, matching how ROUTING selects (the
   * criteria match), never `bucket_members`, which holds three rows in
   * production and is not the eligibility source. `null` means the roster could
   * not be read; a code simply absent from a readable map is also unknown rather
   * than zero.
   */
  depthByCode: Map<string, SupplyDepth> | null;
  /** Cached rows, or `null` when `bucket_slots` could not be read. */
  cacheRows: CachedSlotRow[] | null;
}

/** The theoretical maximum for one day, or the fact that there was never a day. */
export type DayCapacity = { state: "closed" } | { state: "open"; max: number };

/**
 * How many appointments the org's day could hold at all, for this event type.
 *
 * Runs `computeBucketSlots`, the booker's own slot walk, over ONE synthetic agent
 * who is on shift for exactly the org's window on this date and whose calendar is
 * empty. So the grid step, the notice cutoff, the "does the last slot still fit
 * before close" rule and the DST-correct wall-clock arithmetic are all the real
 * ones, and any change to them moves this number the same day it moves the
 * booker.
 *
 * The synthetic agent's shift is taken from `windowOnDate`, never from the weekly
 * pattern, so a date exception that OPENS a normally shut day gives a real
 * maximum rather than zero, and one that CLOSES a day reads as closed.
 *
 * Throws on an unusable date rather than reporting a closed day: a closed day is
 * a real answer about the org and must never be what a parsing failure looks
 * like.
 */
export function dayCapacity(
  hours: BusinessHoursRules,
  eventType: SupplyEventType,
  isoDate: string,
  nowMs: number,
): DayCapacity {
  const day = DateTime.fromISO(isoDate, { zone: hours.zone }).startOf("day");
  if (!day.isValid) throw new Error(`bucket supply: unusable date ${isoDate}`);
  const window = windowOnDate(hours, isoDate, day.weekday);
  if (!window) return { state: "closed" };

  const ideal: MemberAvailability = {
    userId: "theoretical-maximum",
    timezone: hours.zone,
    rules: [
      {
        weekday: day.weekday,
        start_minute: window.start_minute,
        end_minute: window.end_minute,
      },
    ],
    busy: [],
    bookingStartsMs: [],
    // An empty map is authoritative (zero bookings), and the cap is off anyway.
    dayCounts: new Map<string, number>(),
  };

  const slots = computeBucketSlots({
    members: [ideal],
    durationMin: eventType.duration_min,
    bufferBeforeMin: eventType.buffer_before_min,
    bufferAfterMin: eventType.buffer_after_min,
    minNoticeMin: eventType.min_notice_min,
    // Uncapped on purpose: the daily cap limits one AGENT, and the maximum here
    // is what the day itself could hold.
    dailyCap: null,
    slotIntervalMin: eventType.slot_interval_min,
    businessHours: hours,
    from: day.toISO() ?? "",
    to: day.plus({ days: 1 }).toISO() ?? "",
    nowMs,
  });
  return { state: "open", max: slots.length };
}

/** The dates a report covers: the whole window the cache was computed over, so a
 *  day trimmed off a bucket's own answer is still a visible column. */
export function supplyDays(hours: BusinessHoursRules, horizonDays: number, nowMs: number): SupplyDay[] {
  const today = DateTime.fromMillis(nowMs, { zone: hours.zone }).startOf("day");
  return Array.from({ length: searchWindowDays(horizonDays) }, (_, i) => {
    const d = today.plus({ days: i });
    return { iso: d.toISODate() ?? "", weekday: d.weekday };
  });
}

/**
 * How stale this bucket's row is, against the recompute lane's own windows.
 *
 * Inside the freshness window is `fresh`; past it but not yet at the point the
 * staleness alarm fires is `aging` (normal aging, the lane has not been given its
 * chance yet); past the alarm is `stale`, which is the same threshold that pages,
 * so the page and this readout can never disagree about what stale means.
 */
export function freshnessOf(computedAtMs: number | null, nowMs: number): SupplyFreshness {
  if (computedAtMs === null) return "unknown";
  const age = nowMs - computedAtMs;
  if (age < RECOMPUTE_FRESH_MS) return "fresh";
  if (age < STALE_ALARM_MS) return "aging";
  return "stale";
}

/** The event type from a cached payload, or null when it is not all there. */
function eventTypeOf(row: CachedSlotRow): SupplyEventType | null {
  const e = row.payload?.eventType;
  if (!e) return null;
  const nums = [
    e.duration_min,
    e.slot_interval_min,
    e.min_notice_min,
    e.buffer_before_min,
    e.buffer_after_min,
  ];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((e.duration_min as number) <= 0 || (e.slot_interval_min as number) <= 0) return null;
  return {
    duration_min: e.duration_min as number,
    slot_interval_min: e.slot_interval_min as number,
    min_notice_min: e.min_notice_min as number,
    buffer_before_min: e.buffer_before_min as number,
    buffer_after_min: e.buffer_after_min as number,
  };
}

/**
 * The report.
 *
 * Row order is by XBC digit, grouped by the BACKEND digit (the middle one),
 * because that is where the real pattern clustered on 2026-08-04: every one of
 * the fifteen partially blocked buckets was an `x2y` (Beyond) code, and it thinned
 * as the debt tier rose. Within a group the codes run in order, so the tier
 * degradation reads straight down the column. A code that is not a valid XBC
 * sorts last rather than being dropped.
 */
export function bucketSupplyReport(input: BucketSupplyInput): BucketSupplyReport {
  if (input.cacheRows === null) return { measurable: false, reason: "slot-cache" };

  const { hours, nowMs } = input;
  const days = supplyDays(hours, input.horizonDays, nowMs);

  const rowByCode = new Map(input.cacheRows.map((r) => [r.bucket_code, r]));

  // One maximum per (event type, date). Every bucket normally shares one event
  // type, so this turns ~360 slot walks into a handful.
  const maxCache = new Map<string, DayCapacity>();
  const capacityFor = (e: SupplyEventType, day: SupplyDay): DayCapacity => {
    const key = `${e.duration_min}|${e.slot_interval_min}|${e.min_notice_min}|${day.iso}`;
    const hit = maxCache.get(key);
    if (hit) return hit;
    const val = dayCapacity(hours, e, day.iso, nowMs);
    maxCache.set(key, val);
    return val;
  };

  const closedByDate = new Map<string, boolean>();
  for (const day of days) {
    closedByDate.set(day.iso, windowOnDate(hours, day.iso, day.weekday) === null);
  }

  // The roster is the natural driver: it is the list of real buckets, and it
  // carries the eligibility depth. When it could not be read the cache's own
  // codes drive instead, so the page still reports supply and says the depth
  // column is unknown, rather than showing nothing at all.
  const drivers: SupplyBucket[] =
    input.buckets !== null
      ? input.buckets.map((b) => ({ code: b.code, name: b.name }))
      : [...rowByCode.keys()].map((code) => ({ code, name: code }));

  const rows: BucketSupplyRow[] = drivers.map((d) => {
    const row = rowByCode.get(d.code);
    const eventType = row ? eventTypeOf(row) : null;
    const slots = row?.payload?.slots;
    const cacheState: BucketCacheState =
      row === undefined
        ? "missing"
        : eventType !== null && Array.isArray(slots)
          ? "measured"
          : "unreadable";
    const computedAtMs = row ? parseStampMs(row.computed_at) : null;

    let cells: SupplyCell[];
    if (cacheState !== "measured" || eventType === null || !Array.isArray(slots)) {
      // A day the org is shut is known whatever the cache says; everything else
      // about this bucket is not.
      cells = days.map((day) =>
        closedByDate.get(day.iso) ? { kind: "closed" as const } : { kind: "unknown" as const },
      );
    } else {
      // Count what is SERVED, not what is stored (#1296): the read path filters
      // the cached payload through the org's current hours, so counting the raw
      // list would measure times nobody is being offered.
      const served = slotsWithinBusinessHours(slots, eventType.duration_min, hours);
      const openByDate = new Map<string, number>();
      for (const iso of served) {
        const dt = DateTime.fromISO(iso, { zone: hours.zone });
        if (!dt.isValid) continue;
        const key = dt.toISODate();
        if (key === null) continue;
        openByDate.set(key, (openByDate.get(key) ?? 0) + 1);
      }
      // This bucket's answer was trimmed to the first `horizonDays` days that
      // produced times, so a later day may hold nothing simply because the
      // allowance was already spent. That is not a booked-out day.
      const daysWithSlots = [...openByDate.keys()].sort();
      const lastOfferedDate = daysWithSlots[daysWithSlots.length - 1] ?? null;
      const allowanceSpent = daysWithSlots.length >= input.horizonDays;

      cells = days.map((day) => {
        const capacity = capacityFor(eventType, day);
        if (capacity.state === "closed") return { kind: "closed" };
        if (capacity.max === 0) return { kind: "no-capacity" };
        const open = openByDate.get(day.iso) ?? 0;
        if (
          open === 0 &&
          allowanceSpent &&
          lastOfferedDate !== null &&
          day.iso > lastOfferedDate
        ) {
          return { kind: "beyond-horizon" };
        }
        return { kind: "counted", open, max: capacity.max, share: open / capacity.max };
      });
    }

    const depth = input.depthByCode?.get(d.code) ?? null;
    return {
      code: d.code,
      name: d.name,
      depth: depth?.depth ?? null,
      effectiveDepth: depth?.effectiveDepth ?? null,
      cacheState,
      computedAtMs,
      freshness: freshnessOf(computedAtMs, nowMs),
      cells,
    };
  });

  rows.sort((a, b) => xbcOrder(a.code) - xbcOrder(b.code) || a.code.localeCompare(b.code));

  return {
    measurable: true,
    zone: hours.zone,
    horizonDays: input.horizonDays,
    days,
    rows,
    bucketListReadable: input.buckets !== null,
    depthReadable: input.depthByCode !== null,
  };
}

const XBC_CODE = /^[1-5][0-3][0-2]$/;

/** Sort key: backend digit first (the grouping), then debt tier, then legal. */
export function xbcOrder(code: string): number {
  if (!XBC_CODE.test(code)) return Number.MAX_SAFE_INTEGER;
  const [adv, bes, leg] = code.split("").map(Number);
  return bes * 100 + adv * 10 + leg;
}

/** The backend digit a row groups under, or null for a code that is not an XBC. */
export function backendDigitOf(code: string): string | null {
  return XBC_CODE.test(code) ? code[1] : null;
}

/** Totals for the summary line, each one refusing to count what it could not
 *  measure. */
export function supplyTotals(
  rows: BucketSupplyRow[],
  dayIndex: number,
): {
  measured: number;
  unmeasured: number;
  fullyOpen: number;
  partial: number;
  empty: number;
  stale: number;
} {
  let measured = 0;
  let unmeasured = 0;
  let fullyOpen = 0;
  let partial = 0;
  let empty = 0;
  let stale = 0;
  for (const row of rows) {
    if (row.freshness === "stale" || row.freshness === "unknown") stale++;
    const cell = row.cells[dayIndex];
    if (!cell || cell.kind === "unknown") {
      unmeasured++;
      continue;
    }
    if (cell.kind !== "counted") continue;
    measured++;
    if (cell.open === 0) empty++;
    else if (cell.open >= cell.max) fullyOpen++;
    else partial++;
  }
  return { measured, unmeasured, fullyOpen, partial, empty, stale };
}
