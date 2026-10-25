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
import { scheduleAnchorMs } from "../availability/slot-row-times.ts";
import { searchWindowDays } from "../availability/bookable-days.ts";
import {
  RECOMPUTE_FRESH_MS,
  STALE_ALARM_MS,
} from "../availability/precompute-cron.ts";
import { groupRowsByPool, type PoolGroup } from "./pool-rows.ts";
import { rungExcludesLow, tierLadder, wholeTierPoolCode } from "../routing/tiers.ts";
import { DEBT_TIER } from "../xbc.ts";
import { offeredWindowFor, servedSlotsForRung } from "../availability/offered-window.ts";
import { computedAtLabel } from "./bucket-supply-copy.ts";
import type { PoolCalls } from "./bucket-calls.ts";

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
    /** #2842: the times an advisor WITHOUT Low is free, which is what a rung
     *  below a top tier lead's own tier offers that lead. Absent offers nothing. */
    slotsWithoutLow?: string[];
    eventType?: Partial<SupplyEventType> | null;
  } | null;
  computed_at: string;
  /** When the compute that wrote the row began (#3388, migration 0202); absent when
   *  the column is not there yet or the row predates it. */
  compute_started_at?: string | null;
}

/**
 * The instant the "Last computed" column and its freshness grade judge a row by
 * (#3388): when its compute STARTED, through the same anchor the recompute lane
 * schedules from and the stale alarm pages on, because this grade promises never
 * to disagree with that alarm about what stale means. The stamp can sit up to one
 * eligibility cache lifetime earlier when the lane used a cached list; the column
 * says when the row was computed, which is the start. Null when the stamp cannot be
 * read, so the row reads as unknown rather than fresh.
 */
export function supplyComputedAtMs(row: Pick<CachedSlotRow, "computed_at" | "compute_started_at">): number | null {
  const stampMs = parseStampMs(row.computed_at);
  if (stampMs === null) return null;
  return scheduleAnchorMs(stampMs, parseStampMs(row.compute_started_at ?? null));
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
  /**
   * Something behind this day could not be read: the bucket's cached payload, its
   * bookings, or (on the page, #3939) the roster or its advisors' calendars. NOT zero.
   */
  | { kind: "unknown" }
  /**
   * The day could hold appointments and this bucket has none of them: nothing
   * offered and nothing booked (#1937), or, on the page (#3939), its advisors
   * hold no calls that day (nobody working it, or everyone out or not syncing).
   *
   * Its own answer rather than a zero share, because there is no ceiling to be a
   * share OF, and because it is the state worth acting on: a booked out bucket
   * is a full share and a healthy one, while this is nobody being available at
   * all. A bare 0% would read as the first.
   */
  | { kind: "nobody-available" }
  /**
   * A day inside the booker's offered window on which this pool has nothing,
   * while it HAS times on another window day (2026-10-02). The booker serves the
   * pool itself, so its leads are offered those other days: nobody is turned
   * away, and it is not the one to act on.
   */
  | { kind: "other-days" }
  /**
   * A day inside the offered window, for a pool with nothing in the whole
   * window, where a lower rung of the router's ladder has a window time
   * (2026-10-02). The booker serves that one rung for the whole window, so every
   * empty window day names it. Not "nobody available": nobody is turned away.
   *
   * `toPool` is that rung's pool in words, or null for a rung outside the
   * routing matrix. Never a code.
   */
  | { kind: "overflows"; toPool: string | null }
  /**
   * A real measurement (#1937): how many of the times this bucket could have
   * taken an appointment at were actually booked.
   *
   * On the page (#3939, `callsByCode` given) it is in CALLS instead: `booked` is
   * the calls taken by anything on the pool's advisors' calendars and `capacity`
   * the calls their shifts could hold, Team capacity's measure. What follows
   * describes the start time measure the monitor's nearly full check still reads.
   *
   * `capacity` is what is still OFFERED plus what is already TAKEN, both counted
   * as distinct start times on the same grid from the same source, which is the
   * whole reason the two are comparable. `share` is `booked / capacity` and is
   * therefore always between 0 and 1, by construction rather than by clamping.
   *
   * It used to be the times the whole POOL was offering over the slots that fit
   * for ONE synthetic ideal agent, and the ratio of those two ran to 189%.
   */
  | { kind: "counted"; booked: number; capacity: number; share: number };

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
   * The routing POOL this code belongs to, carried from staffing depth
   * (`TierDepth.poolKey`) rather than derived a second way, so this page and the
   * tiers page can never disagree about which codes are one pool. When the
   * roster could not be read there is no key to carry, and the row gets one of
   * its own (`bucket:<code>`), which can never match a real key or a sibling's:
   * the code then stands alone rather than joining a guessed pool.
   */
  poolKey: string;
  /** The pool in words ("Low with Beyond"), or null when its criteria are not
   *  the routing matrix or the roster could not be read. */
  poolLabel: string | null;
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
  /**
   * True when nothing on the ladder has a time inside the offered window but the
   * booker's last resort would offer this pool's leads a later day. Its window
   * days stay red, because that is the alerting case, and the row says so.
   */
  offeredLater: boolean;
  /**
   * The org local dates the booker shows a lead on this code (#3559), from the
   * same `offeredWindowFor` call that bounds the cover judgement. The nearly full
   * pool notice judges and names exactly these. Null when the row could not be
   * read or the org has no such days, never a guessed window.
   */
  offeredDays: string[] | null;
  /** One cell per entry of `days`, in the same order. */
  cells: SupplyCell[];
}

/**
 * One DEBT TIER as a single reading (#3637), which is what the nearly full
 * notice judges.
 *
 * Dan, 2026-10-12: "all we really care about is the debt bucket. not
 * beyond/achieve or legal". A lead whose own Beyond or Achieve pool is full is
 * served by the rest of the tier (`tierLadder`), so judging those pools one by one
 * named "Low with Beyond: none of 2 starts still open" while the same leads were
 * being offered 63 times.
 *
 * The offered times are the tier's WHOLE pool's (`wholeTierPoolCode`, which
 * selects every agent in the debt team whatever their backend), so every
 * advisor's open time is in it exactly once and nothing is added up across pools
 * that share people. The booked times are every code in the tier's, because a
 * call taken through a Beyond or Achieve code was taken by somebody in that whole
 * pool; the pool's own row keeps only its own pool's bookings, as the supply page
 * draws it.
 *
 * A tier whose whole pool code is not a bucket here has no reading at all, rather
 * than one of its narrower pools standing in for it.
 */
export interface TierSupply {
  /** The debt tier digit, "1" (Low) to "5" (Ultra High). */
  tier: string;
  /** The tier in words, from `DEBT_TIER`. */
  label: string;
  /** Every bucket code in the tier on this report, ascending. */
  codes: string[];
  /** The days the booker shows on the whole pool code, as `BucketSupplyRow`. */
  offeredDays: string[] | null;
  /** One cell per entry of `days`, counted as a row's are. */
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
       * changes what every share MEANS. It and the offered open days below are
       * the worst of these to get wrong, because the resulting number looks
       * entirely normal.
       * `offered-open-days`: the stored offered open days could not be read
       * (#3922). They set the window every row's cover and the nearly full notice
       * are judged over, so a guessed count fails the same way the horizon does.
       */
      reason: "business-hours" | "slot-cache" | "booking-horizon" | "offered-open-days";
    }
  | {
      measurable: true;
      zone: string;
      horizonDays: number;
      /** The stored offered open days the window was counted with (#3922), so
       *  the page's words name the count the booker is using. */
      offeredOpenDays: number;
      /**
       * The instant every freshness state on the page was judged against
       * (#1938).
       *
       * Carried rather than re-read where the stamps are RENDERED, because
       * "Stale" and "2 min ago" are two readings of one measurement and a second
       * clock read lets them disagree: a row can be judged fresh here and
       * rendered as an age past the alarm a moment later (L134).
       */
      nowMs: number;
      days: SupplyDay[];
      rows: BucketSupplyRow[];
      /** One reading per debt tier, highest tier first (#3637). */
      tiers: TierSupply[];
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
  /** Staffing depth's own pool key and label for this code (#2237). */
  poolKey: string;
  poolLabel: string | null;
}

export interface BucketSupplyInput {
  /** The org's week and its date exceptions. */
  hours: BusinessHoursRules;
  /** Bookable days the booker is configured to offer. */
  horizonDays: number;
  /**
   * The stored offered open days (#3922), or null when that read failed, which
   * makes the whole report unmeasurable rather than judged over a guessed window.
   */
  offeredOpenDays: number | null;
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
  /**
   * The start times already booked, by bucket code and then by date in the org's
   * zone (#1937). A code or a date simply absent means none were booked, which is
   * a real answer.
   *
   * `null` means the bookings could NOT be read, and it makes every cell unknown
   * rather than reporting zero booked: a zero here would read as "nothing is
   * taken" across every bucket at once, which is exactly what a healthy quiet
   * day looks like (L11).
   */
  bookedByCodeAndDate: Map<string, Map<string, string[]>> | null;
  /**
   * Each code's calls per day (#3939, `callsByCode`): when given, a measured day is calls taken by
   * anything on the pool's advisors' calendars out of the calls their shifts could hold, Team
   * capacity's own measure. Null means the calendars could not be read, so every open day is
   * unknown. Left out, a day is booked start times out of possible start times, which is what the
   * monitor's nearly full check (`pool_fullness`) reads every five minutes without a calendar read.
   */
  callsByCode?: Map<string, Map<string, PoolCalls>> | null;
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
  if (input.offeredOpenDays === null) return { measurable: false, reason: "offered-open-days" };
  const offeredOpenDays = input.offeredOpenDays;

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

  // A pool's booked times, combined across EVERY code of the pool (2026-10-02).
  //
  // The offered times belong to the pool: the recompute lane computes a pool
  // once and writes the same answer under each of its codes. A booking, though,
  // is stored against the code the lead came in on. Counting each code's own
  // bookings therefore dropped every time taken through a sibling code out of
  // the ceiling entirely (it is no longer offered, and it was not "this code's"
  // booking either), so each code understated its pool. Measured that day, the
  // Low pool held 50 routed bookings under 111 and 171 under 112.
  //
  // Only codes whose pool is KNOWN are combined. With the roster unreadable the
  // key is the code's own, so a code counts only its own bookings, which is the
  // most this page can honestly say without knowing the pools.
  const poolKeyOf = (code: string): string =>
    input.depthByCode?.get(code)?.poolKey ?? `bucket:${code}`;
  const bookedByPoolAndDate = new Map<string, Map<string, string[]>>();
  for (const [code, byDate] of input.bookedByCodeAndDate ?? []) {
    const key = poolKeyOf(code);
    const pooled = bookedByPoolAndDate.get(key) ?? new Map<string, string[]>();
    for (const [iso, starts] of byDate) pooled.set(iso, [...(pooled.get(iso) ?? []), ...starts]);
    bookedByPoolAndDate.set(key, pooled);
  }
  // The same bookings by DEBT TIER (#3637), for the tier readings: every code in a
  // tier, whatever its backend or legal digit.
  const bookedByTierAndDate = new Map<string, Map<string, string[]>>();
  for (const [code, byDate] of input.bookedByCodeAndDate ?? []) {
    if (!XBC_CODE.test(code)) continue;
    const pooled = bookedByTierAndDate.get(code[0]!) ?? new Map<string, string[]>();
    for (const [iso, starts] of byDate) pooled.set(iso, [...(pooled.get(iso) ?? []), ...starts]);
    bookedByTierAndDate.set(code[0]!, pooled);
  }
  const tierReadings: TierSupply[] = [];

  // Each code's times as the BOOKER would serve them on a rung (#1296 hours
  // filter, then `servedSlotsForRung`, the booker's own Low exclusion for a rung
  // below a top tier lead's tier), as epoch milliseconds. Read from the cache
  // rows already loaded, so judging the ladder costs no read. Memoised, because
  // sixty codes share a dozen rungs. Null for a row the booker could not serve
  // from (no row, or no readable event type), which is no rescue either way.
  const driverCodes = new Set(drivers.map((d) => d.code));
  const servedMemo = new Map<string, number[] | null>();
  const servedMs = (requestedCode: string, rungCode: string): number[] | null => {
    const memoKey = `${rungCode}|${rungExcludesLow(requestedCode, rungCode)}`;
    if (servedMemo.has(memoKey)) return servedMemo.get(memoKey)!;
    const row = rowByCode.get(rungCode);
    const eventType = row ? eventTypeOf(row) : null;
    const slots = row?.payload?.slots;
    let out: number[] | null = null;
    if (row && eventType !== null && Array.isArray(slots)) {
      const list = servedSlotsForRung(requestedCode, rungCode, {
        slots,
        ...(row.payload?.slotsWithoutLow ? { slotsWithoutLow: row.payload.slotsWithoutLow } : {}),
      });
      out = [];
      for (const iso of slotsWithinBusinessHours(list, eventType.duration_min, hours)) {
        const ms = parseStampMs(iso);
        if (ms !== null) out.push(ms);
      }
    }
    servedMemo.set(memoKey, out);
    return out;
  };

  /**
   * What the booker serves a lead on `code` (Dan, 2026-10-02: the page matches
   * today's booker). `getBucketSlotsWithFallback` offers the next N open days,
   * N the stored offered open days (#3922; `offeredWindowEndFor`, the same function),
   * walks the router's ladder (`tierLadder`) and serves the FIRST rung with any
   * time inside that window, and only that rung. When no rung has one, its last
   * resort offers times past the window, own tier first.
   *
   * So: `self` when the pool has a window time of its own, the first lower rung
   * with one otherwise, or null when none does, with `offeredLater` saying
   * whether the last resort would find anything. Lower rungs that are not a real
   * bucket on this page (a test bucket, or one the list does not hold) are
   * skipped, as the booker skips test buckets.
   *
   * The bucket's fallback agent is not a separate cover: when its criteria match
   * nobody, the fallback agent IS the pool, so its times are already in the
   * pool's own list.
   */
  const servedBy = (
    code: string,
    windowEndMs: number | null,
  ): { winner: "self" | { toPool: string | null } | null; offeredLater: boolean } => {
    const ladder = tierLadder(code).filter((rung, i) => i === 0 || driverCodes.has(rung));
    const inWindow = (ms: number) => windowEndMs === null || ms < windowEndMs;
    for (const [i, rung] of ladder.entries()) {
      if ((servedMs(code, rung) ?? []).some(inWindow)) {
        return {
          winner: i === 0 ? "self" : { toPool: input.depthByCode?.get(rung)?.poolLabel ?? null },
          offeredLater: false,
        };
      }
    }
    // No window at all means the booker had no last resort to reach for.
    const offeredLater =
      windowEndMs !== null && ladder.some((rung) => (servedMs(code, rung) ?? []).length > 0);
    return { winner: null, offeredLater };
  };

  const rows: BucketSupplyRow[] = drivers.map((d) => {
    const row = rowByCode.get(d.code);
    const poolKey = poolKeyOf(d.code);
    const eventType = row ? eventTypeOf(row) : null;
    const slots = row?.payload?.slots;
    const cacheState: BucketCacheState =
      row === undefined
        ? "missing"
        : eventType !== null && Array.isArray(slots)
          ? "measured"
          : "unreadable";
    const computedAtMs = row ? supplyComputedAtMs(row) : null;

    // The times already taken, by date. An unreadable read makes every cell
    // unknown below rather than reporting a zero nobody measured.
    const bookedByDate = bookedByPoolAndDate.get(poolKey) ?? new Map<string, string[]>();
    const bookingsReadable = input.bookedByCodeAndDate !== null;

    let cells: SupplyCell[];
    // Only the whole tier pool code carries its tier's reading (#3637).
    const tierDigit = XBC_CODE.test(d.code) && d.code === wholeTierPoolCode(d.code[0]!) ? d.code[0]! : null;
    let tierCells: SupplyCell[] | null = null;
    let offeredLater = false;
    let offeredDays: string[] | null = null;
    if (cacheState !== "measured" || eventType === null || !Array.isArray(slots) || !bookingsReadable) {
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
      // The INSTANTS, not a count, because they have to be unioned with the times
      // already booked, and keyed by epoch milliseconds rather than by their text
      // (#1937). The cache writes "2026-08-04T17:20:00.000Z" and Postgres hands
      // back "2026-08-04T17:20:00+00:00" for the same moment, so a set of strings
      // would never match a single one of them and every booked time would look
      // like a time nobody was offering.
      const openByDate = new Map<string, Set<number>>();
      for (const iso of served) {
        const dt = DateTime.fromISO(iso, { zone: hours.zone });
        if (!dt.isValid) continue;
        const key = dt.toISODate();
        if (key === null) continue;
        const set = openByDate.get(key) ?? new Set<number>();
        set.add(dt.toMillis());
        openByDate.set(key, set);
      }
      // This bucket's answer was trimmed to the first `horizonDays` days that
      // produced times, so a later day may hold nothing simply because the
      // allowance was already spent. That is not a booked-out day.
      const daysWithSlots = [...openByDate.keys()].sort();
      const lastOfferedDate = daysWithSlots[daysWithSlots.length - 1] ?? null;
      const allowanceSpent = daysWithSlots.length >= input.horizonDays;

      // The window is the requested bucket's own, as the booker computes it from
      // the requested event type's notice.
      const window = offeredWindowFor(hours, nowMs, eventType.min_notice_min, offeredOpenDays);
      const windowEndMs = window?.endMs ?? null;
      offeredDays = window?.days ?? null;
      const plan = servedBy(d.code, windowEndMs);
      offeredLater = plan.offeredLater;
      // A day is in the window when it starts before the window closes. A day
      // past it keeps its own state: what the booker offers there is only its
      // last resort, so the cover judgement must not reach it.
      const inWindowDay = (iso: string) =>
        windowEndMs === null ||
        DateTime.fromISO(iso, { zone: hours.zone }).startOf("day").toMillis() < windowEndMs;

      const cellsFor = (bookedOn: Map<string, string[]>): SupplyCell[] => days.map((day) => {
        const dayRoom = capacityFor(eventType, day);
        if (dayRoom.state === "closed") return { kind: "closed" };
        // The org's own day still decides whether an appointment could EVER have
        // started here, which is what tells "the day is over" apart from "booked
        // out". It is no longer the denominator.
        if (dayRoom.max === 0) return { kind: "no-capacity" };

        const offered = openByDate.get(day.iso) ?? new Set<number>();
        // DISTINCT START TIMES, not calls: two calls booked at one start (two
        // agents, or two codes of the pool) are one taken time, because the
        // ceiling is counted in start times too and a share of calls over a
        // ceiling of times could run past 1.
        //
        // Read to the same epoch key as the offered times, and an unreadable
        // stamp is DROPPED rather than becoming a NaN that joins nothing and
        // inflates the ceiling by one (L50).
        const taken = new Set<number>();
        for (const iso of bookedOn.get(day.iso) ?? []) {
          const ms = parseStampMs(iso);
          if (ms !== null) taken.add(ms);
        }
        if (
          offered.size === 0 &&
          taken.size === 0 &&
          allowanceSpent &&
          lastOfferedDate !== null &&
          day.iso > lastOfferedDate
        ) {
          return { kind: "beyond-horizon" };
        }

        // The ceiling is the UNION, so a time that is both offered and booked is
        // counted once. Without that a double count would put the share back
        // over 1 by a different route.
        const possible = new Set(offered);
        for (const t of taken) possible.add(t);
        if (possible.size === 0) {
          if (!inWindowDay(day.iso) || plan.winner === null) return { kind: "nobody-available" };
          return plan.winner === "self"
            ? { kind: "other-days" }
            : { kind: "overflows", toPool: plan.winner.toPool };
        }

        // In calls, when the page handed them over (#3939): the cover judgement above still reads
        // the slot cache, because which pool serves a lead is the booker's question, while how full
        // a pool's day is comes from its advisors' calendars, as on Team capacity.
        if (input.callsByCode !== undefined) {
          const reading = input.callsByCode === null ? undefined : input.callsByCode.get(d.code)?.get(day.iso);
          if (reading === undefined) return { kind: "unknown" };
          if (reading.capacity === 0) return { kind: "nobody-available" };
          return { kind: "counted", booked: reading.taken, capacity: reading.capacity, share: reading.taken / reading.capacity };
        }
        return {
          kind: "counted",
          booked: taken.size,
          capacity: possible.size,
          share: taken.size / possible.size,
        };
      });
      cells = cellsFor(bookedByDate);
      if (tierDigit !== null) tierCells = cellsFor(bookedByTierAndDate.get(tierDigit) ?? new Map());
    }
    if (tierDigit !== null) {
      tierReadings.push({
        tier: tierDigit,
        label: DEBT_TIER[tierDigit]!.label,
        codes: drivers
          .map((b) => b.code)
          .filter((c) => XBC_CODE.test(c) && c[0] === tierDigit)
          .sort(),
        offeredDays,
        cells: tierCells ?? cells,
      });
    }

    const depth = input.depthByCode?.get(d.code) ?? null;
    return {
      code: d.code,
      name: d.name,
      poolKey,
      poolLabel: depth?.poolLabel ?? null,
      depth: depth?.depth ?? null,
      effectiveDepth: depth?.effectiveDepth ?? null,
      cacheState,
      computedAtMs,
      freshness: freshnessOf(computedAtMs, nowMs),
      offeredLater,
      offeredDays,
      cells,
    };
  });

  // Debt tier first, then TROUBLE, then the rest of the code (#1938, #1942).
  // Both orderings were asked for and they compose: Dan scans by tier, and
  // inside a tier the rows worth acting on come first instead of sitting at
  // whatever position their code happens to give them. Slotting trouble between
  // the tier and the backend digit is why this is a comparator rather than a
  // widened `xbcOrder`: the tier has to stay the outer key or the groups break.
  rows.sort(
    (a, b) =>
      tierOrder(a.code) - tierOrder(b.code) ||
      troubleRank(a, 0) - troubleRank(b, 0) ||
      xbcOrder(a.code) - xbcOrder(b.code) ||
      a.code.localeCompare(b.code),
  );

  return {
    measurable: true,
    zone: hours.zone,
    horizonDays: input.horizonDays,
    offeredOpenDays,
    nowMs,
    days,
    rows,
    tiers: tierReadings.sort((a, b) => Number(b.tier) - Number(a.tier)),
    bucketListReadable: input.buckets !== null,
    depthReadable: input.depthByCode !== null,
  };
}

const XBC_CODE = /^[1-5][0-3][0-2]$/;

/**
 * Sort key: DEBT TIER first and DESCENDING, then the backend digit, then legal
 * (#1942).
 *
 * Dan on 2026-09-04: "don't order this page by backend param, that's not the
 * important part. we want to see debt bucket desc. so ultra high should be shown
 * first and low last." The debt tier is the axis he scans by, and it was third
 * in the key, behind a digit he does not read the page for.
 *
 * The descent is built into the KEY as `5 - tier` rather than by negating the
 * result or reversing the comparator, and that is not a style choice. An
 * unreadable code sorts LAST by returning `MAX_SAFE_INTEGER`, which is a
 * deliberate decision (such a row is kept and put at the end rather than
 * dropped), and any of the naive ways to reverse an ascending sort sends that
 * sentinel to the FRONT: the page would open with the one row nobody can read.
 * Keeping the key ascending keeps the sentinel meaning what it says.
 */
export function xbcOrder(code: string): number {
  if (!XBC_CODE.test(code)) return Number.MAX_SAFE_INTEGER;
  const [tier, backend, legal] = code.split("").map(Number);
  // Tiers run 1 to 5, so `5 - tier` puts Ultra High (5) at 0 and Low (1) at 4.
  return (5 - tier) * 100 + backend * 10 + legal;
}

/**
 * The OUTER sort key, and the same descent `xbcOrder` builds in, on its own so
 * a second key can sit under it without breaking the grouping (#1938).
 *
 * An unreadable code sorts last here for the same reason it does there: such a
 * row is kept and put at the end rather than dropped.
 */
export function tierOrder(code: string): number {
  if (!XBC_CODE.test(code)) return Number.MAX_SAFE_INTEGER;
  return 5 - Number(code[0]);
}

/**
 * How much this row is asking somebody to do something, lowest first (#1938).
 *
 * A first-time reader's only real question is "which of these is in trouble",
 * and sixty rows of near identical numbers in code order cannot answer it. The
 * ranking is over states that are ALREADY named on the page, never over a
 * threshold invented here: nobody available is the one state the key calls "the
 * one to act on", a cell that could not be checked is the one that is not a
 * measurement at all, and a stale or never computed row is the one whose numbers
 * may not be what the booker is serving.
 *
 * A day the office is shut leaves every row at the same rank, which is correct:
 * on a Sunday no bucket is in trouble and the tier order stands alone.
 */
export function troubleRank(row: BucketSupplyRow, dayIndex: number): number {
  const cell = row.cells[dayIndex];
  if (cell?.kind === "nobody-available") return 0;
  if (!cell || cell.kind === "unknown") return 1;
  if (row.freshness === "stale" || row.freshness === "unknown") return 2;
  return 3;
}

/** The debt tier digit a row groups under, or null for a code that is not an XBC. */
export function debtTierDigitOf(code: string): string | null {
  return XBC_CODE.test(code) ? code[0] : null;
}

/** The backend digit of an XBC code, or null. Still the secondary sort, and
 *  still worth naming: see the measurement beside the table's grouping. */
export function backendDigitOf(code: string): string | null {
  return XBC_CODE.test(code) ? code[1] : null;
}

/** Totals for the summary line, each one refusing to count what it could not
 *  measure. */
/**
 * The headline counts for one day.
 *
 * THESE INVERTED WITH THE METRIC (#1937). They used to be `fullyOpen`,
 * `partial` and `empty`, read off how much was OFFERED, and `fullyOpen` was
 * `cell.open >= cell.max`: every bucket whose share ran over 100% counted as
 * "offering the whole of today", so the summary line was as unreadable as the
 * cells it summed. Dan's screenshot said "18 offering the whole of today" and
 * some of those 18 were offering 189% of a number that was not their capacity.
 *
 * `nobodyAvailable` is the one worth acting on and is counted separately from
 * `measured`, because a bucket with no capacity at all has no share to average
 * in with the others.
 */
/**
 * Whether the day the summary counts is one the office is SHUT on (#1938).
 *
 * Every count in `SupplyTotals` refuses to count what it could not measure, and
 * on a closed day there is nothing to measure, so all six of them read zero.
 * That renders identically to a working day on which nothing was found, and
 * those are different screens (L10): one is "the office is closed", the other is
 * "sixty pools were checked and none of them is in this state".
 *
 * Judged from the CELLS rather than from the counts being zero, because zero
 * rows would satisfy the counts too and means something else again.
 */
export function dayIsClosed(rows: BucketSupplyRow[], dayIndex: number): boolean {
  return rows.length > 0 && rows.every((r) => r.cells[dayIndex]?.kind === "closed");
}

export interface SupplyTotals {
  measured: number;
  unmeasured: number;
  saturated: number;
  partBooked: number;
  nothingBooked: number;
  nobodyAvailable: number;
  /** Empty that day with its leads caught elsewhere. Never in `nobodyAvailable`,
   *  and never in `measured` either, since it has no share. */
  overflows: number;
  /** Empty that day with its leads offered this pool's other window days. Kept
   *  apart from both of the above for the same reasons. */
  otherDays: number;
  stale: number;
}

/**
 * Whether two rows carry the same READING: every field the table renders except
 * the bucket's identity (its code and name), which is exactly what pooling
 * folds. Rows of one pool agree by construction now that a pool's bookings are
 * combined, which is why this has to be able to say no: the day they do not (a
 * code recomputed on its own and not yet caught up), the screen must show the
 * disagreement rather than pick a winner (L131).
 *
 * The age is compared as it RENDERS ("2 min ago"), because two codes written a
 * few seconds apart read identically and splitting them would show a manager
 * two rows with the same words and the same numbers. Fields are listed rather
 * than walked, so a field added to the row joins only when somebody decides.
 */
export function sameSupplyReading(a: BucketSupplyRow, b: BucketSupplyRow, nowMs: number): boolean {
  return (
    a.poolLabel === b.poolLabel &&
    a.depth === b.depth &&
    a.effectiveDepth === b.effectiveDepth &&
    a.cacheState === b.cacheState &&
    a.freshness === b.freshness &&
    a.offeredLater === b.offeredLater &&
    // #3559: the nearly full notice judges a group by its first row's days, so
    // codes whose booker shows different days are different readings.
    (a.offeredDays ?? []).join() === (b.offeredDays ?? []).join() &&
    (a.offeredDays === null) === (b.offeredDays === null) &&
    computedAtLabel(a.freshness, a.computedAtMs, nowMs).label ===
      computedAtLabel(b.freshness, b.computedAtMs, nowMs).label &&
    a.cells.length === b.cells.length &&
    a.cells.every((cell, i) => sameCell(cell, b.cells[i]!))
  );
}

function sameCell(a: SupplyCell, b: SupplyCell): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "counted" && b.kind === "counted") {
    return a.booked === b.booked && a.capacity === b.capacity;
  }
  if (a.kind === "overflows" && b.kind === "overflows") return a.toPool === b.toPool;
  return true;
}

/**
 * The rows as POOLS: one group per pool whose codes agree, and one per row where
 * they do not. The manager view renders these, and the totals count them, so the
 * "across N pools" line and the counts under it are about the same things.
 */
export function supplyPoolGroups(rows: BucketSupplyRow[], nowMs: number): PoolGroup<BucketSupplyRow>[] {
  return groupRowsByPool(rows, (a, b) => sameSupplyReading(a, b, nowMs));
}

/**
 * The headline counts, one per POOL reading rather than one per code.
 *
 * Since a pool's bookings are combined, its six codes carry one measurement six
 * times, and counting rows would report one booked out pool as six. So each
 * group from `supplyPoolGroups` counts once, through its first row; a pool whose
 * codes disagree is split there, and each disagreeing reading counts, because
 * picking one would drop a measurement the page exists to report.
 */
export function supplyTotals(groups: PoolGroup<BucketSupplyRow>[], dayIndex: number): SupplyTotals {
  // Takes the GROUPS rather than the rows, so the table groups once and the
  // counts are about exactly the pools it draws.
  const rows = groups.map((g) => g.rows[0]!);
  let measured = 0;
  let unmeasured = 0;
  let saturated = 0;
  let partBooked = 0;
  let nothingBooked = 0;
  let nobodyAvailable = 0;
  let overflows = 0;
  let otherDays = 0;
  let stale = 0;
  for (const row of rows) {
    if (row.freshness === "stale" || row.freshness === "unknown") stale++;
    const cell = row.cells[dayIndex];
    if (!cell || cell.kind === "unknown") {
      unmeasured++;
      continue;
    }
    if (cell.kind === "nobody-available") {
      nobodyAvailable++;
      continue;
    }
    if (cell.kind === "overflows") {
      overflows++;
      continue;
    }
    if (cell.kind === "other-days") {
      otherDays++;
      continue;
    }
    if (cell.kind !== "counted") continue;
    measured++;
    if (cell.booked === 0) nothingBooked++;
    else if (cell.booked >= cell.capacity) saturated++;
    else partBooked++;
  }
  return { measured, unmeasured, saturated, partBooked, nothingBooked, nobodyAvailable, overflows, otherDays, stale };
}
