/**
 * The IO half of the Beyond overflow count (#2228). Kept out of
 * `beyond-overflow.ts` so that module stays node-testable with no `@/` imports.
 *
 * BOTH READS THROW ON ERROR, and that is the whole point of the split. A count
 * that failed comes back as null, and `count ?? 0` would turn it into a perfectly
 * healthy looking zero: no Beyond bookings, nothing to report. That is the defect
 * class in #277, #1134 and #1165, and here it would silence the very notice this
 * file exists to feed. `unwrapCount` throws instead, and the caller reports the
 * tick as unmeasured rather than quiet.
 *
 * WHAT IDENTIFIES AN OVERFLOW. `routing_decisions.requested_code` is the raw
 * `xbc` the lead's link carried and `bucket_code` is the bucket the booking
 * actually landed in, so a Beyond lead taken by an Achieve agent is exactly
 * "requested on a Beyond code, booked on an Achieve one". The two lists are
 * DERIVED from the XBC vocabulary rather than typed out (L41), and the booked
 * side is every Achieve code rather than only the same tier partner, so the
 * drop-and-overflow case (522 to 432) is counted alongside the plain one: it
 * carries the same Colorado consequence and leaving it out would under-report the
 * exposure the notice exists to name.
 *
 * A row whose `requested_code` is null is invisible to this, and that is a real
 * and named limit rather than a bug to chase here: null means the caller did not
 * say (an embed predating #1908), and nothing can recover what was never sent.
 * Every live surface does send it (`src/app/book/page.tsx` and
 * `src/app/booking/[id]/page.tsx` pass the URL's `xbc` straight through, and the
 * booking API passes the validated code), so the population this misses is
 * historical rather than ongoing.
 *
 * THE SMOKE CANARY IS EXCLUDED, as it is in the catch-all count next door.
 * `routing_decisions` has no is_test column, so test-ness is a property of the
 * BUCKET and is reached through an inner join (#1258). A hardcoded list of test
 * bucket codes would be a second definition of which buckets are synthetic,
 * drifting the first time one is added (L41).
 *
 * COST. Two server side counts per tick, no rows returned, exactly as the
 * catch-all rate read beside it. Every lane on this cron's schedule shares one
 * invocation's subrequest budget, so it is named here rather than left to be
 * rediscovered: if that budget ever needs trimming, a 24 hour count read every 5
 * minutes to feed a notice that speaks once a day is an obvious candidate to slow
 * down, and nothing about the check depends on the cadence.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import {
  OVERFLOW_CODES,
  BEYOND_CODES,
  BEYOND_OVERFLOW_WINDOW_HOURS,
  type BeyondOverflowWindow,
} from "@/lib/monitor/beyond-overflow";

/**
 * Count the window: how many Beyond leads were booked, and how many of those went
 * to an Achieve agent.
 *
 * Only rows that produced a BOOKING are counted, on both sides. A routing
 * decision that ended in `no_availability` is a real event but it is not a
 * placement, and mixing the two would make the total something other than
 * "Beyond bookings", which is what the notice says it is.
 */
export async function readBeyondOverflowWindow(nowMs: number): Promise<BeyondOverflowWindow> {
  const since = new Date(nowMs - BEYOND_OVERFLOW_WINDOW_HOURS * 3600_000).toISOString();
  const db = supabaseAdmin();

  const beyondBooked = unwrapCount(
    await db
      .from("routing_decisions")
      .select("id, buckets!inner(is_test)", { count: "exact", head: true })
      .eq("buckets.is_test", false)
      .eq("outcome", "booked")
      .in("requested_code", BEYOND_CODES)
      .gte("created_at", since),
    "routing_decisions beyond booked",
  );
  const overflowed = unwrapCount(
    await db
      .from("routing_decisions")
      .select("id, buckets!inner(is_test)", { count: "exact", head: true })
      .eq("buckets.is_test", false)
      .eq("outcome", "booked")
      .in("requested_code", BEYOND_CODES)
      .in("bucket_code", OVERFLOW_CODES)
      .gte("created_at", since),
    "routing_decisions beyond overflowed",
  );

  return { overflowed, beyondBooked, windowHours: BEYOND_OVERFLOW_WINDOW_HOURS };
}
