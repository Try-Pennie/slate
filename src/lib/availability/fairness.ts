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
  received: number;
  expected: number;
  deviation: number;
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

/** Compute availability-corrected fairness per bucket and per agent. */
export function computeFairness(
  rows: TraceRow[],
  opts: { minBookings: number },
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

  const byAgent: AgentRollup[] = [...overall.entries()]
    .map(([userId, t]) => ({
      userId,
      received: t.received,
      expected: t.expected,
      deviation: t.received - t.expected,
    }))
    .sort((a, b) => a.deviation - b.deviation);

  return { buckets, byAgent };
}
