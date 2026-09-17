/**
 * The two reads the debt tier alarm judges (#2505), kept apart from the judging
 * so the decision stays node-testable and the IO has one home.
 *
 * WHY THE COUNT IS CRITERIA ONLY, and why that is the most important line in this
 * file. The obvious way to count a tier is `eligibleAgentIds` for its whole pool
 * code, which is what the empty bucket sweep uses. That function resolves a
 * BUCKET, not a criteria set: `agentIdsFromPool` matches
 * `manualMemberIds.has(a.id) || matchesCriteria(...)`, and `applyFallback` runs on
 * top. So ONE person hand named on bucket `511`, or a `fallback_user_id` pointing
 * at one agent, would make the whole Ultra High tier read as staffed and mute the
 * page, while a lead on `512` is NOT served by that member, because an
 * unconstrained code gains no same tier rung (#2486). That is word for word the
 * silence #2253 was opened about, and `bucket-coverage.ts` already records the
 * shape in its own docstring.
 *
 * It is latent rather than live today (measured 2026-09-17: 0 buckets carry a
 * `fallback_user_id`, and all 3 active `bucket_members` rows are on test buckets),
 * and the admin page offers to name a person on any row, so it is one click from
 * real.
 *
 * THE CRITERIA COME FROM THE SPEC, NOT FROM A ROW. `bucketSpecForXbc` derives them
 * from the code, so a `buckets` row that is missing, deleted or flagged
 * `is_test` cannot decide whether a debt tier is staffed. A read of the row would
 * make an absent bucket look like an empty tier, which is a page about our own
 * configuration worded as a customer outage.
 *
 * TEST AGENTS ARE EXCLUDED for the same reason the empty bucket sweep excludes
 * them: the two SMOKE fixtures are deliberately bookable so the canary keeps
 * proving the funnel, and a fixture answering "is this tier staffed" with a yes
 * is a number nobody can reconcile against the roster.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { agentIdsFromPool } from "@/lib/availability/pool";
import { bucketSpecForXbc, DEBT_TIER } from "@/lib/xbc";
import { wholeTierPoolCode } from "@/lib/routing/tiers";
import type { Attributes } from "@/lib/db/types";
import type { SlotHealth } from "@/lib/monitor/slot-health";
import type { TierReading } from "@/lib/monitor/tier-staffing";

/** Every debt tier digit, from the shared vocabulary rather than typed out, so a
 *  sixth tier is covered by construction rather than silently unwatched (L96). */
export const DEBT_TIERS: string[] = Object.keys(DEBT_TIER).sort();

/**
 * How many bookable agents each debt tier has, by criteria alone.
 *
 * THROWS on an unreadable roster rather than returning an empty map, because an
 * empty map read as zeros would page every tier at once off a query that never
 * ran (#277, #1629). The lane contains the throw and the alarm reports every tier
 * unmeasured, which is the honest outcome.
 */
export async function loadTierAgentCounts(): Promise<Map<string, number>> {
  const db = supabaseAdmin();
  // cap-safe: the roster is bounded by the design target of 100 to 200 agents, and
  // `users` is on the guard's roster-bounded allowlist for exactly that reason.
  const rows = (unwrap(
    await db
      .from("users")
      .select("id, attributes")
      .eq("bookable", true)
      .eq("is_test", false)
      .is("deactivated_at", null),
    "tier staffing roster",
  ) ?? []) as { id: string; attributes: Attributes }[];
  const agents = rows.map((r) => ({ id: r.id, attributes: r.attributes }));
  const counts = new Map<string, number>();
  for (const tier of DEBT_TIERS) {
    const spec = bucketSpecForXbc(wholeTierPoolCode(tier));
    if (!spec) continue;
    // No manual members and no fallback: see the header. An empty Set is the
    // statement, not an omission.
    counts.set(tier, agentIdsFromPool(agents, new Set(), spec.criteria).length);
  }
  return counts;
}

/**
 * Assemble what the judge needs, from the two reads the lane already holds.
 *
 * PURE, so every combination of a failed read is driven directly. A `null` for
 * either input means that read failed, and it arrives at the judge as
 * `measured: false` rather than as a zero, which is the whole distinction the
 * alarm rests on (L215).
 */
export function tierReadings(input: {
  agentCounts: Map<string, number> | null;
  slotByCode: Map<string, SlotHealth> | null;
}): TierReading[] {
  return DEBT_TIERS.map((tier) => {
    const label = DEBT_TIER[tier]?.label ?? tier;
    // A tier absent from a map that WAS read is a genuine zero for the roster (no
    // agent carries it) but is UNMEASURED for the slots (no cached row for the
    // tier's pool code, so nothing says what it is offering). The two differ
    // because one map is built from every tier and the other from whatever rows
    // exist.
    const count = input.agentCounts?.get(tier);
    const health = input.slotByCode?.get(wholeTierPoolCode(tier));
    return {
      tier,
      label,
      agents: input.agentCounts === null ? { measured: false } : { measured: true, count: count ?? 0 },
      slots:
        input.slotByCode === null || health === undefined || health.slotCount === null
          ? { measured: false }
          : { measured: true, firstSlotMs: health.firstSlotMs },
    };
  });
}
