import { supabaseAdmin } from "@/lib/supabase/admin";
import { afterResponse } from "@/lib/after-response";
import { outcomeTallyArgs } from "@/lib/monitor/booking-api-outcome";
import { resolveTestTraffic, type TestTraffic } from "@/lib/monitor/test-traffic";

/**
 * Record one booking-attempt outcome into the daily tally (#418).
 *
 * Deferred and best-effort: it runs after the response under waitUntil
 * (afterResponse, #503) so it never blocks or fails a booking, and a failed bump
 * is logged (warn) rather than swallowed. The tally is monitoring, not the booking
 * itself, so a dropped increment only under-counts a "nice to know" panel. Kept out
 * of the pure booking-api-outcome module so that stays node-testable (no next / DB
 * imports).
 *
 * `source` (#1616) is how the row learns whether the attempt was the smoke
 * canary's. It is REQUIRED rather than defaulted, so `tsc` enumerates every
 * recording site the day a new one is added: a site that silently defaulted to
 * "real" would put canary traffic back into the failure rate, which is the exact
 * defect this parameter exists to remove. It is resolved INSIDE the deferred work,
 * so the lookup it costs is paid after the response rather than by the lead.
 */
export function recordApiOutcome(
  outcome: string,
  bucketCode: string,
  errorCode: string | null,
  source: TestTraffic,
): void {
  const atMs = Date.now();
  afterResponse("booking-api-tally", async () => {
    const isTest = await resolveTestTraffic(source);
    const args = outcomeTallyArgs({ outcome, bucketCode, errorCode, isTest, atMs });
    const { error } = await supabaseAdmin().rpc("bump_booking_api_outcome", args);
    if (error) throw new Error(`bump_booking_api_outcome failed: ${error.message}`);
  });
}
