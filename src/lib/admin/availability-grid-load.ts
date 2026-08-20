/**
 * The reads behind the availability grid (#1302).
 *
 * Every one of them already exists for something else: the org's week, the
 * coverage readout the settings screen and the roster alarm share, and the slot
 * cache the booker reads. Nothing new is stored, and nothing here computes
 * coverage of its own (L107).
 *
 * The one rule that matters: the roster read THROWS rather than returning an
 * empty pool, and that has to survive to the screen as "could not check" rather
 * than as "nobody covers this". A grid quietly rendering an unreadable roster as
 * a wall of gaps would send somebody to fix a roster that was fine, which is the
 * failure the grid exists to prevent, facing the other way.
 */
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { coverageForWeek, type CoverageDay } from "@/lib/booking/business-hours-coverage";
import { loadCoverageAgents } from "@/lib/booking/business-hours-coverage-load";
import { HORIZON_DAYS } from "@/lib/availability/slot-cache";
import {
  buildAvailabilityGrid,
  bucketsOfferingByHour,
  type AvailabilityGrid,
  type GridDayInput,
} from "@/lib/admin/availability-grid";

/** How many days the grid shows. A fortnight is more than the four day horizon on
 *  purpose: the rostering half of the answer is measurable well past the horizon,
 *  and it is the half somebody can act on today. */
export const GRID_DAYS = 14;

export async function loadAvailabilityGrid(now: DateTime = DateTime.now()): Promise<AvailabilityGrid> {
  const db = supabaseAdmin();
  const today = now.setZone(BUSINESS_ZONE).startOf("day");

  const dates = Array.from({ length: GRID_DAYS }, (_, i) => today.plus({ days: i }));

  // The org's week, as stored. `loadBusinessHours` returns only the OPEN windows,
  // so a weekday missing from it is a closed day rather than an unreadable one.
  const businessHours = await loadBusinessHours();
  const openByWeekday = new Map(businessHours.rules.map((r) => [r.weekday, r]));
  const weekRows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const rule = openByWeekday.get(weekday);
    return {
      weekday,
      is_open: rule !== undefined,
      start_minute: rule?.start_minute ?? 0,
      end_minute: rule?.end_minute ?? 0,
    };
  });

  // Coverage is evaluated per WEEK against concrete dates, so a fortnight that
  // crosses a DST boundary is judged on each week's real offsets rather than on
  // one week's applied to both.
  let coverageByWeekAndDay: Map<string, CoverageDay> | null = new Map();
  try {
    const agents = await loadCoverageAgents(db);
    for (const monday of new Set(dates.map((d) => d.startOf("week").toISODate() ?? ""))) {
      const readout = coverageForWeek({
        businessHours: weekRows,
        zone: BUSINESS_ZONE,
        agents,
        weekStartIso: monday,
      });
      if (!readout.ok) {
        coverageByWeekAndDay = null;
        break;
      }
      for (const day of readout.days) coverageByWeekAndDay.set(`${monday}:${day.weekday}`, day);
    }
  } catch {
    // The pool or its rules could not be read. NOT an empty roster: every cell
    // must say it was not measured.
    coverageByWeekAndDay = null;
  }

  // What is being OFFERED, filtered through the org's current hours exactly as
  // the read path filters it (#1296). A read error here is not fatal to the grid:
  // the rostering half is still worth showing, and an hour with no cached row
  // already renders as booked, which is what a lead would see.
  const slotRows = unwrap(
    await db.from("bucket_slots").select("payload"),
    "availability grid slots",
  ) as { payload: { slots?: string[]; eventType?: { duration_min?: number } } | null }[] | null;
  const bucketsByDayHour = bucketsOfferingByHour(slotRows ?? [], businessHours, BUSINESS_ZONE);

  const horizonEnd = today.plus({ days: HORIZON_DAYS });
  const days: GridDayInput[] = dates.map((date) => {
    const monday = date.startOf("week").toISODate() ?? "";
    return {
      iso: date.toISODate() ?? "",
      weekday: date.weekday,
      withinHorizon: date < horizonEnd,
      coverage: coverageByWeekAndDay?.get(`${monday}:${date.weekday}`) ?? null,
    };
  });

  return buildAvailabilityGrid({ days, bucketsByDayHour });
}
