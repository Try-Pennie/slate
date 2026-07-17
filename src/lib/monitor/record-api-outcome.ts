import { supabaseAdmin } from "@/lib/supabase/admin";
import { afterResponse } from "@/lib/after-response";
import { outcomeTallyArgs } from "@/lib/monitor/booking-api-outcome";

/**
 * Record one direct-booking-API outcome into the daily tally (#418).
 *
 * Deferred and best-effort: it runs after the response under waitUntil
 * (afterResponse, #503) so it never blocks or fails a booking, and a failed bump
 * is logged (warn) rather than swallowed. The tally is monitoring, not the booking
 * itself, so a dropped increment only under-counts a "nice to know" panel. Kept out
 * of the pure booking-api-outcome module so that stays node-testable (no next / DB
 * imports).
 */
export function recordApiOutcome(
  outcome: string,
  bucketCode: string,
  errorCode: string | null,
): void {
  const args = outcomeTallyArgs(outcome, bucketCode, errorCode, Date.now());
  afterResponse("booking-api-tally", async () => {
    const { error } = await supabaseAdmin().rpc("bump_booking_api_outcome", args);
    if (error) throw new Error(`bump_booking_api_outcome failed: ${error.message}`);
  });
}
