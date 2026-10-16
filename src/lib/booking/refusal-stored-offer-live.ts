import { afterResponse } from "@/lib/after-response";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { refreshPoolOf } from "@/lib/availability/slot-cache";
import { refusalTraceOf } from "@/lib/booking/refusal-trace";
import { budgetLeftMs, outsideCallBudget } from "@/lib/call-budget";
import { BOOKING_CLEANUP_BUDGET_MS } from "@/lib/booking/cleanup-allowance";
import { realTimer } from "@/lib/read-within-deadline";
import {
  NOTHING_TO_CHECK,
  startStoredOfferCheck,
  type StoredOfferCheck,
  type StoredSlotRow,
} from "@/lib/booking/refusal-stored-offer";

/**
 * Answer a refused confirm, holding the answer for the refresh of any pool the
 * refusal proves stale (#3366, #3633, #3796). Called inside the route's failure path
 * allowance, with that path as `answer`: the stored row check starts first, so its
 * read and refresh run alongside the refunds and the tally, and once the answer is
 * ready it waits at most for what the allowance has left. A refresh that cannot
 * finish in that time carries on after the response. A refusal that is not
 * `candidate_read_empty`, or an error with no trace, reads nothing and holds nothing.
 * The decision, the log line and the refresh are `refusal-stored-offer.ts`; this
 * binds the one read, the pool refresh and the allowance.
 */
export async function answerAfterRefusalRefresh<T>(err: unknown, answer: () => Promise<T>): Promise<T> {
  const check = startLiveCheck(err);
  let response: T;
  try {
    response = await answer();
  } catch (failed) {
    // No answer to hold: the check goes on after whatever the route answers instead.
    void check.beforeResponse(0);
    throw failed;
  }
  // The allowance is shared by the whole failure path (#3102), so what is left of it
  // is all the lead may wait; outside one, which only a test reaches, its full size.
  await check.beforeResponse(budgetLeftMs() ?? BOOKING_CLEANUP_BUDGET_MS);
  return response;
}

function startLiveCheck(err: unknown): StoredOfferCheck {
  const trace = refusalTraceOf(err);
  if (!trace) return NOTHING_TO_CHECK;
  // Outside the request's budget: the refresh is the coalesced one every booking and
  // push shares, so a cut at this lead's allowance would fail it for all of them, and
  // a refresh still running at the response must carry on rather than be refused.
  return outsideCallBudget(() =>
    startStoredOfferCheck(trace, {
      nowMs: () => Date.now(),
      log,
      // #3633: the same coalesced per pool refresh the booking and push paths use, so
      // a pool proven stale by a refusal shares one recompute with everything else
      // refreshing it inside the window.
      // #3381: named as the refusal's, so the row it writes says who wrote it.
      refreshPool: (code) => refreshPoolOf(code, "refusal"),
      keepAlive: (work) => afterResponse("refusal-stored-offer", () => work),
      timer: realTimer,
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
