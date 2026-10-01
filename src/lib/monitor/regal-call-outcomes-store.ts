/**
 * The stored side of the call outcome check (#2944, #2950): how many HUMAN outcome
 * rows were received since an instant. It must count the same population as
 * `humanCallsFrom` counts on the received side, so an AI call and a call with
 * nobody on it are left out here too; counting them would let them stand in for
 * advisor calls that were lost.
 *
 * A head count, so no rows come back and the 1,000 row cap cannot shorten it, and a
 * failed count THROWS with the database's reason rather than reading as zero.
 * Driven against a recording fake by scripts/test-regal-call-outcomes-store.ts.
 */
import { unwrapCount, type DbCountResult } from "@/lib/db/result";

interface CountChain extends PromiseLike<DbCountResult> {
  gte(column: string, value: string): CountChain;
  eq(column: string, value: boolean): CountChain;
  not(column: string, operator: string, value: null): CountChain;
}

export interface OutcomeCountDb {
  from(table: "regal_call_outcomes"): {
    select(columns: string, options: { count: "exact"; head: true }): CountChain;
  };
}

export async function countHumanOutcomesSince(db: OutcomeCountDb, sinceIso: string): Promise<number> {
  return unwrapCount(
    await db
      .from("regal_call_outcomes")
      .select("id", { count: "exact", head: true })
      .gte("received_at", sinceIso)
      .eq("is_ai_agent", false)
      .not("agent_email", "is", null),
    "monitor regal call outcome count",
  );
}
