/**
 * Low booking volume floors FITTED to measured traffic, per weekday and hour (#1956).
 *
 * WHY. The floors used to be two hand typed numbers, 5 bookings in 30 minutes and
 * 20 in 120, written into the code by whoever wrote the file, and one number for
 * every hour of the week. Booking volume is not flat: a flat floor either fires
 * every quiet Saturday evening or sleeps through a dead Tuesday afternoon, and
 * neither of those gets an alarm armed. Dan, 2026-09-04: "it should not be my
 * responsibility to know what the expected minimum bookings are."
 *
 * WHAT. A baseline holds one floor pair per weekday and hour, judged in the zone
 * the traffic was measured in. Each floor is fitted from the distribution of real
 * window counts in that weekday's hour band, never from a mean (L172, L711): the
 * alarm is cleared or not cleared by ONE window, so the quiet end of the spread is
 * what decides it.
 *
 * The fit takes the LOWER of two estimates, both deliberately conservative:
 *
 * - the empirical tail: the `tailQuantile` of every real window count in the band,
 *   so a floor is one the measured weeks actually cleared nearly every time;
 * - a Poisson floor on a LOW rate (the band's `rateQuantile`), so a thin band with
 *   few samples cannot produce a floor its own chance variation breaches.
 *
 * A floor of 0 means the band is too thin to judge and that window cannot breach
 * there. That is stated on /admin/alerts rather than hidden, because an alarm that
 * is quiet by construction must read differently from one that is quiet because
 * nothing is wrong (L678).
 *
 * WHOSE TRAFFIC. A baseline is fitted to exactly the traffic SLATE carries: a floor
 * fitted to more pages than Slate serves is one it can never clear, and one fitted
 * to fewer is slow to see an outage. The scope is part of the baseline and is shown
 * with it (`scripts/lib/volume-floor-scope.ts`).
 *
 * No `@/` imports, so node scripts can run it directly.
 */
import { DateTime } from "luxon";

/** The width of one bucket in a measured series, in minutes. */
export const SERIES_BUCKET_MINUTES = 5;

/** The two windows the alarm judges, mirrored from booking-volume.ts. */
const SHORT_MIN = 30;
const LONG_MIN = 120;

/**
 * Bookings counted per consecutive bucket from `startMs`.
 *
 * Counts, not timestamps: this is what a replay needs, and it carries nothing about
 * any lead, so it can be committed as a fixture.
 */
export interface BookingSeries {
  startMs: number;
  bucketMinutes: number;
  counts: number[];
}

/** One weekday and hour's fitted floors, plus the typical long window it was fitted against. */
export interface FloorCell {
  floor30: number;
  floor120: number;
  /** The median 120 minute count in this band, so a reader can see how far below normal the floor sits. */
  typical120: number;
}

export interface VolumeBaseline {
  /** Where the bookings were counted. */
  source: "calcom" | "slate";
  /** The day the measurement was taken, YYYY-MM-DD. */
  measuredOn: string;
  /** The span the bookings were read over, as YYYY-MM-DD dates. */
  fromDate: string;
  toDate: string;
  /** The IANA zone the weekday and hour were judged in. */
  zone: string;
  /** Whose traffic the floors were fitted to, in plain words. */
  scope: string;
  /** That scope's share of its whole debt tier's bookings, 0 to 1, or null when it is the whole tier. */
  tierShare: number | null;
  /** Bookings the fit was made from. */
  bookings: number;
  /** Floors per weekday (index 0 is Monday, Luxon's 1) and hour (0 to 23). */
  cells: FloorCell[][];
}

/** The fit's knobs, in one place so the admin page and the tests read the same numbers. */
export const FLOOR_FIT = {
  /** The share of real windows allowed to sit below the floor, per band. */
  tailQuantile: 0.02,
  /** The low rate the Poisson guard is taken at. */
  rateQuantile: 0.25,
  /** The chance a window at that low rate may breach by luck alone. */
  poissonAlpha: 0.001,
  /** Hours either side pooled into a band, within one weekday. */
  bandHalfWidth: 1,
  /** Weeks a band needs before its single lowest week is left out of the fit. */
  minWeeksToDropOne: 6,
} as const;

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
}

/**
 * The largest k for which a Poisson count at `lambda` falls below k with probability
 * at most `alpha`. Zero when even k = 1 would breach too often.
 */
export function poissonFloor(lambda: number, alpha: number): number {
  if (!(lambda > 0)) return 0;
  let k = 0;
  let pmf = Math.exp(-lambda); // P(X = 0)
  let below = 0; // P(X < k)
  // Walk up while P(X < k + 1) stays within alpha.
  while (below + pmf <= alpha) {
    below += pmf;
    k += 1;
    pmf = (pmf * lambda) / k;
    if (k > 10_000) break;
  }
  return k;
}

/**
 * Every real window count, grouped by the weekday and hour of the tick that would
 * have judged it. A tick is taken at every bucket boundary once a full long window
 * of history exists, which is how the lane sees the world: the check runs every few
 * minutes and asks about the minutes just gone.
 */
export interface CellSamples {
  c30: number[];
  c120: number[];
  /** The local week each sample fell in, as "YYYY-Www", parallel to the counts. */
  week: string[];
}

export function windowCountsByCell(series: BookingSeries, zone: string): CellSamples[][] {
  const per = series.bucketMinutes;
  if (SHORT_MIN % per !== 0 || LONG_MIN % per !== 0) {
    throw new Error(`a ${per} minute bucket cannot tile the ${SHORT_MIN} and ${LONG_MIN} minute windows`);
  }
  const shortN = SHORT_MIN / per;
  const longN = LONG_MIN / per;
  const cells: CellSamples[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ c30: [], c120: [], week: [] })),
  );
  // Prefix sums, so each window is two reads rather than a loop.
  const prefix = [0];
  for (const n of series.counts) prefix.push(prefix[prefix.length - 1]! + n);
  for (let i = longN; i <= series.counts.length; i++) {
    const tickMs = series.startMs + i * per * 60_000;
    const dt = DateTime.fromMillis(tickMs, { zone });
    const cell = cells[dt.weekday - 1]![dt.hour]!;
    cell.c30.push(prefix[i]! - prefix[i - shortN]!);
    cell.c120.push(prefix[i]! - prefix[i - longN]!);
    cell.week.push(`${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`);
  }
  return cells;
}

/** Fit one floor from a band's real window counts. */
function fitFloor(samples: number[]): number {
  if (samples.length === 0) return 0;
  const tail = quantile(samples, FLOOR_FIT.tailQuantile);
  const guard = poissonFloor(quantile(samples, FLOOR_FIT.rateQuantile), FLOOR_FIT.poissonAlpha);
  return Math.max(0, Math.min(tail, guard));
}

/**
 * The week whose band sat lowest, when there are enough weeks to spare one.
 *
 * Dropped from the fit on purpose. Nine weeks of a weekday band include the odd day
 * traffic halved all day (measured: Tuesday 2026-08-04 and Friday 2026-08-07 each ran
 * at under half their usual volume), and the tail of a fit that keeps it is set by
 * that one day. A floor fitted to the worst day on record is a floor the alarm can
 * only cross on a day worse than any outage it has seen, which is an alarm fitted
 * to stay quiet. The replay reports what it would have said on those days.
 */
function worstWeek(weeks: string[], counts: number[]): string | null {
  const byWeek = new Map<string, number[]>();
  weeks.forEach((w, i) => byWeek.set(w, [...(byWeek.get(w) ?? []), counts[i]!]));
  if (byWeek.size < FLOOR_FIT.minWeeksToDropOne) return null;
  let worst: string | null = null;
  let worstMedian = Infinity;
  for (const [w, values] of byWeek) {
    const m = quantile(values, 0.5);
    if (m < worstMedian) {
      worstMedian = m;
      worst = w;
    }
  }
  return worst;
}

/** Fit every weekday and hour's floors from a measured series. */
export function fitFloorCells(series: BookingSeries, zone: string): FloorCell[][] {
  const raw = windowCountsByCell(series, zone);
  return raw.map((day) =>
    day.map((_, hour) => {
      const band: CellSamples = { c30: [], c120: [], week: [] };
      for (let h = hour - FLOOR_FIT.bandHalfWidth; h <= hour + FLOOR_FIT.bandHalfWidth; h++) {
        if (h < 0 || h > 23) continue;
        band.c30.push(...day[h]!.c30);
        band.c120.push(...day[h]!.c120);
        band.week.push(...day[h]!.week);
      }
      const drop = worstWeek(band.week, band.c120);
      const keep = (values: number[]) => values.filter((_, i) => band.week[i] !== drop);
      return {
        floor30: fitFloor(keep(band.c30)),
        floor120: fitFloor(keep(band.c120)),
        typical120: quantile(band.c120, 0.5),
      };
    }),
  );
}

/**
 * Cells from the rows a generated baseline module stores, one [floor30, floor120,
 * typical120] triple per hour and one row per weekday from Monday (#2738).
 */
export function cellsFromRows(rows: [number, number, number][][]): FloorCell[][] {
  return rows.map((day) => day.map(([floor30, floor120, typical120]) => ({ floor30, floor120, typical120 })));
}

/** Where the tick sits in the baseline's week, judged in the baseline's own zone. */
export function cellAt(baseline: Pick<VolumeBaseline, "zone">, nowMs: number): { weekday: number; hour: number } {
  const dt = DateTime.fromMillis(nowMs, { zone: baseline.zone });
  return { weekday: dt.weekday, hour: dt.hour };
}

/** A floor a person set, and where it was set. */
export interface FloorOverride {
  value: number;
  origin: "stored" | "env";
}

/**
 * Everything that decides the floors at a given moment: the measured baseline, and
 * any value a person set in its place. An override replaces the measured floor at
 * EVERY hour, which is exactly why the page shows it as an override of a measured
 * value rather than as the primary input.
 */
export interface FloorPolicy {
  baseline: VolumeBaseline;
  override30: FloorOverride | null;
  override120: FloorOverride | null;
}

export interface FloorsNow {
  floor30: number;
  floor120: number;
  measured30: number;
  measured120: number;
  weekday: number;
  hour: number;
  /**
   * Where a value standing in for the measured floor was set, per window, or null
   * when the measured floor is the one judged. The ORIGIN rather than a boolean,
   * because "set on the settings page" and "set in the deployment" send a reader
   * to two different places to change it (L11).
   */
  override30: FloorOverride["origin"] | null;
  override120: FloorOverride["origin"] | null;
}

/** The floors the alarm judges against at `nowMs`. */
export function floorsFor(policy: FloorPolicy, nowMs: number): FloorsNow {
  const { weekday, hour } = cellAt(policy.baseline, nowMs);
  const cell = policy.baseline.cells[weekday - 1]?.[hour];
  // A baseline missing a cell is a malformed file, not a quiet hour: refuse it
  // loudly rather than read the gap as a floor of zero (L215).
  if (!cell) throw new Error(`volume baseline has no floors for weekday ${weekday} hour ${hour}`);
  return {
    floor30: policy.override30?.value ?? cell.floor30,
    floor120: policy.override120?.value ?? cell.floor120,
    measured30: cell.floor30,
    measured120: cell.floor120,
    weekday,
    hour,
    override30: policy.override30?.origin ?? null,
    override120: policy.override120?.origin ?? null,
  };
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A clock hour as a person says it: "9am", "12pm". */
export function hourLabel(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  return `${h}${hour % 24 < 12 ? "am" : "pm"}`;
}

/** "Mondays 2pm to 3pm", the band a floor was measured for, as a person says it. */
export function bandLabel(weekday: number, hour: number): string {
  return `${WEEKDAY_NAMES[weekday - 1]}s ${hourLabel(hour)} to ${hourLabel((hour + 1) % 24)}`;
}

export { WEEKDAY_NAMES };

/**
 * Where an override was set, as the alert says it. Keyed on the origin so `tsc`
 * names a third origin the day one is added, rather than it borrowing a wording.
 */
export const FLOOR_BASIS: Record<FloorOverride["origin"], string> = {
  stored: "set by hand on the alerts settings page",
  env: "set in the deployment's settings",
};

/** The floors a tick judges against, each with the words saying where it came from. */
export interface JudgedFloors {
  floor30: number;
  floor120: number;
  basis30: string;
  basis120: string;
}

/**
 * Where each floor came from, in the words a page carries (#1956). A reader told
 * "expected at least 7" has to know whether 7 is what this hour normally clears or
 * a number somebody typed, because the two send them to different places.
 */
export function judgedFloors(now: FloorsNow): JudgedFloors {
  // Worded to follow either "expected at least 7, ..." or "Both floors were ...".
  const measured = `measured for ${bandLabel(now.weekday, now.hour)}`;
  const basis = (origin: FloorOverride["origin"] | null): string =>
    origin === "stored" ? FLOOR_BASIS.stored : origin === "env" ? FLOOR_BASIS.env : measured;
  return {
    floor30: now.floor30,
    floor120: now.floor120,
    basis30: basis(now.override30),
    basis120: basis(now.override120),
  };
}
