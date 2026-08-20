/**
 * Which hours of which days anyone can actually be booked (#1302).
 *
 * On 2026-08-05 the entire roster fell out of the bookable pool and the only way
 * to establish it was a hand written query. The product's own answer was sixty
 * identical pages saying individual buckets were empty, which is the same fact
 * told sixty times and never once told as the fact it was.
 *
 * The reason a grid is worth building rather than another alert: an empty hour
 * has several DIFFERENT causes, and they need different people to do different
 * things. The org is shut. Nobody is rostered. Everybody rostered is booked. Or
 * we could not read the roster at all. Those arrive at every existing surface as
 * the same silence, and this is the surface that separates them.
 *
 * It computes NO coverage of its own. `coverageForWeek` (#1297) already answers
 * "for each open hour, how many bookable agents are on shift", with the zone
 * discipline that question needs, and a second walk here would be a second
 * definition of one predicate, agreeing with the settings screen and the roster
 * alarm right up until the three drifted (L107). This module joins that readout
 * to the cached slots and decides what each cell MEANS.
 *
 * Pure (luxon plus one pure import), so `scripts/test-availability-grid.ts`
 * drives every branch node-native.
 */
import { DateTime } from "luxon";
import type { CoverageDay } from "../booking/business-hours-coverage.ts";
import { slotsWithinBusinessHours, type BusinessHoursRules } from "../availability/compute.ts";

/** One column: a concrete date, so a real zone offset and that week's DST apply. */
export interface GridDayInput {
  /** yyyy-mm-dd in the ORG's zone. */
  iso: string;
  /** Luxon weekday, 1 = Monday. */
  weekday: number;
  /**
   * Is this date inside the booking horizon? Beyond it nothing is offered yet,
   * which is NOT the same as everything being taken, and a grid that scored the
   * two alike would report a fully staffed Friday as booked solid.
   */
  withinHorizon: boolean;
  /**
   * This weekday's coverage, from `coverageForWeek` for the week this date falls
   * in. `null` means the roster could not be READ, which is not zero agents:
   * `loadCoverageAgents` throws rather than returning an empty pool precisely so
   * that difference survives to here, and an unreadable roster rendered as
   * "nobody covers this" sends somebody to fix a roster that was fine.
   */
  coverage: CoverageDay | null;
}

/**
 * What one hour of one day is, and why.
 *
 * Six states rather than a number, because the number is the least useful part:
 * zero is the answer in four of these and each one is somebody else's job.
 */
export type GridCell =
  /** The roster could not be read, so nothing about this hour was measured. */
  | { kind: "unknown" }
  /** The org is not open then. Nothing to staff, nothing to fix. */
  | { kind: "closed" }
  /** Open, and no bookable agent is on shift. A schedule or a hire fixes it. */
  | { kind: "unrostered" }
  /** Staffed, but past the booking horizon, so no times are offered yet. */
  | { kind: "beyond-horizon"; agents: number }
  /** Staffed, inside the horizon, and no bucket is offering a start. Booked out. */
  | { kind: "booked"; agents: number }
  /** Bookable now: agents on shift and at least one bucket offering a start. */
  | { kind: "open"; agents: number; buckets: number };

export interface AvailabilityGrid {
  /** The hours the org is open at any point in the range, ascending. */
  hours: number[];
  /** One entry per day, in the order given, each holding a cell per hour. */
  days: { iso: string; weekday: number; cells: GridCell[] }[];
  /** False when the roster could not be read, so every cell is `unknown`. */
  measurable: boolean;
}

/**
 * The key `bucketsOfferingByHour` produces and `buildAvailabilityGrid` reads.
 * One function so the two can never disagree about the shape.
 */
export function dayHourKey(iso: string, hour: number): string {
  return `${iso}:${hour}`;
}

/**
 * How many buckets are offering at least one start in each day and hour.
 *
 * Buckets rather than raw starts, because a start time is the SAME time in most
 * of the sixty buckets and summing them would report sixty for one bookable
 * moment. "How many of the sixty pools a lead could land in can be booked at
 * 10:00 on Tuesday" is the question an operator actually has.
 *
 * Filtered through the org's current hours, exactly as the read path filters
 * them (#1296), so this counts what is being OFFERED rather than what happens to
 * be sitting in the cache. A payload with no duration cannot be judged against
 * the window at all, so it contributes nothing rather than a number it did not
 * earn.
 */
export function bucketsOfferingByHour(
  rows: { payload: { slots?: string[]; eventType?: { duration_min?: number } } | null }[],
  businessHours: BusinessHoursRules,
  zone: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const slots = row.payload?.slots;
    const durationMin = row.payload?.eventType?.duration_min;
    if (slots === undefined || typeof durationMin !== "number") continue;
    // One bucket contributes at most once per hour, however many starts it holds
    // in it, which is what makes the number a count of pools rather than of times.
    const seen = new Set<string>();
    for (const iso of slotsWithinBusinessHours(slots, durationMin, businessHours)) {
      const dt = DateTime.fromISO(iso, { zone });
      if (!dt.isValid) continue;
      seen.add(dayHourKey(dt.toISODate() ?? "", dt.hour));
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function buildAvailabilityGrid(input: {
  days: GridDayInput[];
  bucketsByDayHour: Map<string, number>;
}): AvailabilityGrid {
  // Unreadable is decided for the WHOLE grid, not per cell. A grid where some
  // days were measured and others were not would invite reading the measured
  // half as the answer, and the roster is one read: if it failed, it failed for
  // every day in the range.
  const measurable = input.days.every((d) => d.coverage !== null);

  // The hour axis is the union of every open hour in the range, so a Saturday
  // that opens later does not silently crop the weekdays' early hours, and a
  // week with no open hours at all renders as an empty grid rather than as a
  // grid of closed cells pretending to be a measurement.
  const hourSet = new Set<number>();
  for (const day of input.days) {
    for (const h of day.coverage?.hours ?? []) hourSet.add(h.hour);
  }
  const hours = [...hourSet].sort((a, b) => a - b);

  const days = input.days.map((day) => ({
    iso: day.iso,
    weekday: day.weekday,
    cells: hours.map((hour): GridCell => {
      if (!measurable || day.coverage === null) return { kind: "unknown" };
      if (!day.coverage.is_open) return { kind: "closed" };
      const entry = day.coverage.hours.find((h) => h.hour === hour);
      // An open day still has hours outside its own window, and those are closed
      // in exactly the sense the whole column is: the org is not open then.
      if (!entry) return { kind: "closed" };
      if (entry.agents === 0) return { kind: "unrostered" };
      if (!day.withinHorizon) return { kind: "beyond-horizon", agents: entry.agents };
      const buckets = input.bucketsByDayHour.get(dayHourKey(day.iso, hour)) ?? 0;
      if (buckets === 0) return { kind: "booked", agents: entry.agents };
      return { kind: "open", agents: entry.agents, buckets };
    }),
  }));

  return { hours, days, measurable };
}

/** How many cells of each kind, for the summary line above the grid. */
export function gridTotals(grid: AvailabilityGrid): Record<GridCell["kind"], number> {
  const totals: Record<GridCell["kind"], number> = {
    unknown: 0,
    closed: 0,
    unrostered: 0,
    "beyond-horizon": 0,
    booked: 0,
    open: 0,
  };
  for (const day of grid.days) for (const cell of day.cells) totals[cell.kind]++;
  return totals;
}
