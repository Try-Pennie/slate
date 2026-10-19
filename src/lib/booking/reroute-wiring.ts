/**
 * Two refusals in the reroute's live wiring (`realRerouteDeps` in service.ts), moved
 * here so a node suite can drive them without the whole service (#1643, following
 * the #1241 pattern in `coverage-sweep-actor.ts`).
 *
 * Both lived as single lines inside a dependency object nothing exported, so no test
 * could reach them, and deleting either changed nothing any suite could see.
 */
import type { ClaimRerouteHoldRefusal } from "@/lib/db/reroute-hold-refusals";
import { DailyCapExceededError } from "@/lib/booking/orchestration";

export interface ClaimedRerouteHold {
  refused: ClaimRerouteHoldRefusal | null;
  result: Record<string, unknown> | null;
  agentUserId: string | null;
  targetBucketId: string | null;
}

/**
 * The one row `claim_reroute_hold` answers with. The function always returns a row,
 * a refusal word or a claim, so an answer with none is a fault and is refused by
 * name: read as an empty claim it would carry on with no advisor and no bucket, and
 * a confirm would proceed on a hold it never established.
 */
export function readClaimedRerouteHold(rows: unknown, bookingId: string): ClaimedRerouteHold {
  const row = (rows as
    | {
        agent_user_id: string | null;
        target_bucket_id: string | null;
        refused: ClaimRerouteHoldRefusal | null;
        result: Record<string, unknown> | null;
      }[]
    | null
    | undefined)?.[0];
  if (!row) throw new Error(`claim_reroute_hold returned no row for booking ${bookingId}`);
  return { refused: row.refused, result: row.result, agentUserId: row.agent_user_id, targetBucketId: row.target_bucket_id };
}

/**
 * What a reroute's reassign came to. An advisor at their daily cap is the one
 * refusal answered as an outcome, `over_cap`, because it is thrown before any calendar
 * event exists, so nothing is left to clean up and the reroute searches again. Every
 * other failure is thrown on as itself: the reroute reads a hold that ran out off the
 * error's class and code, and `moved` off a reassign that did not happen would report
 * the call as moved to an advisor it is not with.
 */
export async function rerouteReassignOutcome(reassign: () => Promise<unknown>): Promise<"moved" | "over_cap"> {
  try {
    await reassign();
    return "moved";
  } catch (err) {
    if (err instanceof DailyCapExceededError) return "over_cap";
    throw err;
  }
}
