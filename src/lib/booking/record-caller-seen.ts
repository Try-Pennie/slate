import { supabaseAdmin } from "@/lib/supabase/admin";
import { afterResponse } from "@/lib/after-response";
import { makeCallerSeenRecorder } from "@/lib/booking/caller-seen";

/**
 * The recorder the booking API's authorizer calls on every success (#2717), wired to
 * the real table and scheduler. The decisions (what host a request came from, the
 * once an hour throttle, releasing it on a failed write) live in the pure
 * `caller-seen.ts`, driven by scripts/test-caller-seen.ts.
 *
 * The write runs under `afterResponse` (waitUntil on Workers), so it never delays a
 * booking and a failure is logged at warn rather than reaching the request. A missed
 * stamp costs nothing but a slightly older "last seen", and the next success retries.
 */
export const recordCallerSeen = makeCallerSeenRecorder({
  write: async (row) => {
    const { error } = await supabaseAdmin()
      .from("api_caller_seen")
      .upsert(row, { onConflict: "caller,host_kind" });
    if (error) throw new Error(`api_caller_seen upsert failed: ${error.message}`);
  },
  defer: (work) => afterResponse("api-caller-seen", work),
  now: () => Date.now(),
});
