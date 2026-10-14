import { afterResponse } from "@/lib/after-response";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { refreshPoolOf } from "@/lib/availability/slot-cache";
import { refusalTraceOf } from "@/lib/booking/refusal-trace";
import { checkStoredOffer, storedOfferCodes, type StoredSlotRow } from "@/lib/booking/refusal-stored-offer";

/**
 * Schedule the stored row check for a refused confirm (#3366), after the response so
 * the lead's 409 never waits on it. A refusal that is not `candidate_read_empty`, or
 * an error with no trace, schedules nothing and reads nothing. The decision, the log
 * line and the refresh are `refusal-stored-offer.ts`; this binds the one read and the
 * pool refresh.
 */
export function scheduleStoredOfferCheck(err: unknown): void {
  const trace = refusalTraceOf(err);
  if (!trace || storedOfferCodes(trace) === null) return;
  afterResponse("refusal-stored-offer", () =>
    checkStoredOffer(trace, {
      nowMs: () => Date.now(),
      log,
      // #3633: the same coalesced per pool refresh the booking and push paths use, so
      // a pool proven stale by a refusal shares one recompute with everything else
      // refreshing it inside the window.
      // #3381: named as the refusal's, so the row it writes says who wrote it.
      refreshPool: (code) => refreshPoolOf(code, "refusal"),
      // One primary key read of the ladder's rows: at most a handful of codes, and
      // `bucket_slots` holds one row per bucket, so it can never reach a page cap.
      readRows: async (codes) =>
        (unwrap(
          await supabaseAdmin()
            .from("bucket_slots")
            .select("bucket_code, payload, computed_at")
            .in("bucket_code", codes),
          "refusalStoredOffer",
        ) ?? []) as StoredSlotRow[],
    }),
  );
}
