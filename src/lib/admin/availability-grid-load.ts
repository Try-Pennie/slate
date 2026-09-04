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
import { type CoverageAgent } from "@/lib/booking/business-hours-coverage";
import { loadCoverageAgents } from "@/lib/booking/business-hours-coverage-load";
import { approvedTimeOffIntervals } from "@/lib/ooo/approved-overlap";
import { HORIZON_DAYS } from "@/lib/availability/slot-cache";
import { isOrgOpen, memoisedOrgOpen } from "@/lib/availability/compute";
import {
  buildAvailabilityGrid,
  bucketsOfferingByHour,
  gridDayInputs,
  type AvailabilityGrid,
} from "@/lib/admin/availability-grid";

/** How many days the grid shows. A fortnight is more than the four day horizon on
 *  purpose: the rostering half of the answer is measurable well past the horizon,
 *  and it is the half somebody can act on today. */
export const GRID_DAYS = 14;

export async function loadAvailabilityGrid(now: DateTime = DateTime.now()): Promise<AvailabilityGrid> {
  const db = supabaseAdmin();
  const today = now.setZone(BUSINESS_ZONE).startOf("day");

  const dates = Array.from({ length: GRID_DAYS }, (_, i) => today.plus({ days: i }));

  // The org's week AND its date exceptions (#1363): each date below is resolved
  // through `windowOnDate`, so a closed holiday renders as closed rather than as
  // a staffing gap, and a date opened against the pattern renders its own window
  // (#1581). `loadBusinessHours` returns only the OPEN windows, so a weekday
  // missing from it is a closed day rather than an unreadable one.
  // #1846: the reads run TOGETHER rather than one after another. Measured against
  // live Supabase, the page spent 839ms in seven strictly serial reads, and the
  // slot cache does not depend on the roster or on the hours, nor the roster on
  // the hours. Three independent chains, so they are three awaits in parallel.
  //
  // The roster chain stays a chain: leave is fetched for the same range the pool
  // is read for, and it stays inside one try so a failure of EITHER renders as
  // "could not check" rather than as an empty roster, which is the whole point of
  // this loader.
  const [businessHours, agents, slotRows] = await Promise.all([
    loadBusinessHours(),
    (async (): Promise<CoverageAgent[] | null> => {
      try {
        const pool = await loadCoverageAgents(db);
        // Approved time off across the whole range (#1582), attached per agent so
        // a day the team is away renders as away rather than as fully staffed.
        // Inside the same try: if leave cannot be read, rendering "fully staffed"
        // would be the exact defect this read exists to fix, so the grid says
        // "could not check" instead.
        const out = await approvedTimeOffIntervals(
          today.toISO() ?? "",
          today.plus({ days: GRID_DAYS }).toISO() ?? "",
        );
        return pool.map((a) => ({ ...a, out: out.get(a.userId) ?? [] }));
      } catch {
        // The pool, its rules, or its leave could not be read. NOT an empty
        // roster: every cell must say it was not measured.
        return null;
      }
    })(),
    // What is being OFFERED, filtered through the org's current hours exactly as
    // the read path filters it (#1296). A read error here IS fatal, as it was
    // before: `unwrap` throws, and this rejecting rejects the whole page rather
    // than rendering a grid with no offered times, which would read as booked out.
    (async () =>
      unwrap(
        await db.from("bucket_slots").select("payload"),
        "availability grid slots",
      ) as { payload: { slots?: string[]; eventType?: { duration_min?: number } } | null }[] | null)(),
  ]);

  // #1846: ONE memo across all sixty-odd buckets. The judge's answer depends only
  // on the window against a week that is fixed for this request, and the same
  // start time appears in most of the buckets, so asking once per distinct window
  // rather than once per slot string is where 2 seconds of Worker CPU went. Built
  // here and discarded with the request, never module level: the hours are read
  // per request and can change between them (#1296).
  const bucketsByDayHour = bucketsOfferingByHour(
    slotRows ?? [],
    businessHours,
    BUSINESS_ZONE,
    memoisedOrgOpen((startMs, endMs) => isOrgOpen(businessHours, startMs, endMs)),
  );

  const days = gridDayInputs({
    hours: businessHours,
    zone: BUSINESS_ZONE,
    dates: dates.map((d) => d.toISODate() ?? ""),
    horizonEndIso: today.plus({ days: HORIZON_DAYS }).toISODate() ?? "",
    agents,
  });

  return buildAvailabilityGrid({ days, bucketsByDayHour });
}
