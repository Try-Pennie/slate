/**
 * Pure logic for the routing fairness report (#348): availability-corrected
 * per-agent fairness, computed from each booking's `routing_trace.considered`
 * (the free, eligible candidate set already recorded at assignment time, see
 * orchestration.ts). No `@/` imports so scripts/test-routing-fairness.ts can run
 * it node-native; the DB read + formatting live in the report script.
 *
 * Why availability-corrected: the router only balances among the agents FREE for
 * each slot, so raw "bookings per agent" punishes agents who are rarely free. For
 * each booking an agent was a candidate for, a perfectly fair split would have
 * given them 1/(candidate count) of it; an agent's EXPECTED bookings is the sum
 * of that over only the bookings they were actually a candidate for. received vs
 * expected is then a fair judgement regardless of how often the agent is free.
 */

/** One booking's routing outcome: which pool, who got it, and who was eligible. */
export interface TraceRow {
  bucketCode: string;
  chosenUserId: string;
  /** The free + eligible candidate ids that were considered (routing_trace). */
  considered: string[];
}

export interface AgentFairness {
  userId: string;
  /** Bookings this agent was a candidate for (the fair denominator). */
  opportunities: number;
  /** Bookings this agent actually got. */
  received: number;
  /** Bookings a perfectly fair split would have given them: the sum of
   *  1/(candidate count) over the bookings they were a candidate for. */
  expected: number;
  /** received - expected. Negative = under-served, positive = over-served. */
  deviation: number;
}

export interface BucketFairness {
  bucketCode: string;
  bookings: number;
  /** True when there are too few bookings to read anything into the skew. */
  insufficient: boolean;
  /** Agents sorted most-under-served first (ascending deviation). */
  agents: AgentFairness[];
}

export interface AgentRollup {
  userId: string;
  /** Bookings credited to this agent by the router (ranker decisions only). */
  received: number;
  expected: number;
  deviation: number;
  /** ALL bookings currently assigned to this agent in the period, including
   *  ones gained via manual reassign or reschedule (which carry no routing
   *  candidacy). The commission-relevant count; `received` understates it. */
  rawReceived: number;
}

export interface FairnessReport {
  buckets: BucketFairness[];
  /** Per-agent totals across all buckets (the commission-relevant view). */
  byAgent: AgentRollup[];
}

interface Tally {
  opportunities: number;
  received: number;
  expected: number;
}

function emptyTally(): Tally {
  return { opportunities: 0, received: 0, expected: 0 };
}

/**
 * Compute availability-corrected fairness per bucket and per agent.
 *
 * @param opts.rawAssignments - Optional list of the current `assigned_user_id`
 *   for EVERY commission-relevant booking in the period (regardless of
 *   routing_trace). When supplied, each agent rollup reports `rawReceived` and
 *   agents who only received bookings via reassign/reschedule still appear.
 */
export function computeFairness(
  rows: TraceRow[],
  opts: { minBookings: number; rawAssignments?: string[] },
): FairnessReport {
  const perBucket = new Map<string, Map<string, Tally>>();
  const bookingCount = new Map<string, number>();
  const overall = new Map<string, Tally>();

  const bump = (m: Map<string, Tally>, id: string): Tally => {
    const t = m.get(id) ?? emptyTally();
    m.set(id, t);
    return t;
  };

  for (const row of rows) {
    const bucketAgents = perBucket.get(row.bucketCode) ?? new Map<string, Tally>();
    perBucket.set(row.bucketCode, bucketAgents);
    bookingCount.set(row.bucketCode, (bookingCount.get(row.bucketCode) ?? 0) + 1);

    const share = row.considered.length > 0 ? 1 / row.considered.length : 0;
    for (const id of row.considered) {
      const bt = bump(bucketAgents, id);
      bt.opportunities += 1;
      bt.expected += share;
      const ot = bump(overall, id);
      ot.opportunities += 1;
      ot.expected += share;
    }
    bump(bucketAgents, row.chosenUserId).received += 1;
    bump(overall, row.chosenUserId).received += 1;
  }

  const buckets: BucketFairness[] = [...perBucket.entries()]
    .map(([bucketCode, agentMap]) => {
      const bookings = bookingCount.get(bucketCode) ?? 0;
      const agents: AgentFairness[] = [...agentMap.entries()]
        .map(([userId, t]) => ({
          userId,
          opportunities: t.opportunities,
          received: t.received,
          expected: t.expected,
          deviation: t.received - t.expected,
        }))
        .sort((a, b) => a.deviation - b.deviation);
      return { bucketCode, bookings, insufficient: bookings < opts.minBookings, agents };
    })
    .sort((a, b) => (a.bucketCode < b.bucketCode ? -1 : a.bucketCode > b.bucketCode ? 1 : 0));

  // Raw bookings-received count per agent (#424): counts the current
  // assigned_user_id of every booking, so reassign/reschedule credit is not
  // lost the way the ranker-only `received` total loses it.
  const rawCount = new Map<string, number>();
  for (const id of opts.rawAssignments ?? []) {
    if (!id) continue;
    rawCount.set(id, (rawCount.get(id) ?? 0) + 1);
  }

  // Union of ranker-credited agents and raw-assigned agents, so an agent who
  // only ever received via a manual reassign still surfaces in the rollup.
  const rollupIds = new Set<string>([...overall.keys(), ...rawCount.keys()]);
  const byAgent: AgentRollup[] = [...rollupIds]
    .map((userId) => {
      const t = overall.get(userId) ?? emptyTally();
      return {
        userId,
        received: t.received,
        expected: t.expected,
        deviation: t.received - t.expected,
        rawReceived: rawCount.get(userId) ?? 0,
      };
    })
    .sort((a, b) => a.deviation - b.deviation);

  return { buckets, byAgent };
}

/**
 * Strip synthetic test entities (#460) from the fairness inputs before the math.
 *
 * The smoke-test agent (`users.is_test`) and its isolated buckets
 * (`buckets.is_test`) are real, bookable rows so the key-authed smoke test can
 * route to them, but they must never be counted in cross-bucket or org-wide
 * fairness reporting. Per-bucket fairness already ignores them (they live in
 * their own SMOKE buckets), but the org-wide per-agent rollup and any raw
 * bookings-received total would otherwise credit the synthetic agent.
 *
 * A row is synthetic when its booking landed in a test bucket OR was won by a
 * test agent; either way it is dropped. Surviving real rows also have any test
 * agent stripped from their `considered` set (defensive: test agents are only
 * ever pool members of test buckets, so in practice this is a no-op). Raw
 * assignments are filtered by test agent id, matching how the read-side gates
 * exclude with `is_test = false`.
 */
export function excludeTestEntities(
  rows: TraceRow[],
  rawAssignments: string[],
  opts: { testUserIds: Iterable<string>; testBucketCodes: Iterable<string> },
): { rows: TraceRow[]; rawAssignments: string[] } {
  const testUsers = new Set(opts.testUserIds);
  const testBuckets = new Set(opts.testBucketCodes);

  const cleanedRows = rows
    .filter((r) => !testBuckets.has(r.bucketCode) && !testUsers.has(r.chosenUserId))
    .map((r) => ({ ...r, considered: r.considered.filter((id) => !testUsers.has(id)) }));

  const cleanedRaw = rawAssignments.filter((id) => !testUsers.has(id));

  return { rows: cleanedRows, rawAssignments: cleanedRaw };
}
