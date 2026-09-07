/**
 * The IO half of the catch-all rate page (#1908). Kept out of `catchall-rate.ts`
 * so that module stays node-testable with no `@/` imports.
 *
 * BOTH READS THROW ON ERROR, and that is the whole point of the split. A count
 * that failed comes back as null, and `count ?? 0` would turn it into a perfectly
 * healthy looking zero: no bookings rescued, nothing to report. That is the
 * defect class in #277, #1134 and #1165, and here it would silence the very alert
 * this file exists to feed. `unwrapCount` throws instead, and the caller reports
 * the tick as unmeasured rather than clear.
 *
 * COST. Two server side counts per tick, no rows returned. Every lane on this
 * cron's schedule shares one invocation's subrequest budget, so this is named
 * here rather than left to be rediscovered: if that budget ever needs trimming,
 * a 24 hour rate read every 5 minutes is an obvious candidate to slow down, and
 * nothing about the check depends on the cadence.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import type { CatchallWindow } from "@/lib/monitor/catchall-rate";

/** How far back the rate is measured. A day, because the thing it watches is an
 *  upstream page that has started building links without a routing code, which is
 *  a state that persists rather than a burst. */
export const CATCHALL_WINDOW_HOURS = 24;

/**
 * Count the window: how many bookings were rescued, and how many there were.
 *
 * Only rows that produced a BOOKING are counted, on both sides. A routing
 * decision that ended in `no_availability` is a real event but it is not a
 * booking, and mixing the two would make the denominator something other than
 * "bookings", which is what the threshold was calibrated against.
 */
export async function readCatchallWindow(nowMs: number): Promise<CatchallWindow> {
  const since = new Date(nowMs - CATCHALL_WINDOW_HOURS * 3600_000).toISOString();
  const db = supabaseAdmin();

  const total = unwrapCount(
    await db
      .from("routing_decisions")
      .select("id", { count: "exact", head: true })
      .eq("outcome", "booked")
      .gte("created_at", since),
    "routing_decisions total",
  );
  const catchall = unwrapCount(
    await db
      .from("routing_decisions")
      .select("id", { count: "exact", head: true })
      .eq("outcome", "booked")
      .eq("catchall_applied", true)
      .gte("created_at", since),
    "routing_decisions catchall",
  );

  return { catchall, total, windowHours: CATCHALL_WINDOW_HOURS };
}
