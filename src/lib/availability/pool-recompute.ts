import { log } from "@/lib/log";
import type { Bucket } from "@/lib/db/types";
import type { BucketSlots } from "./service";
import { groupByPool, type PoolInput } from "./pool-key";
import { bucketsDueForRecompute, type KnownRow } from "./precompute-cron";

/**
 * Compute a POOL's availability once and store it under every bucket code in
 * that pool (#2245).
 *
 * Sixty codes resolve to fifteen pools, so the every minute recompute lane was
 * running the full multi agent availability compute sixty times to produce
 * fifteen distinct answers, on the lane whose headroom already pages (#2021).
 *
 * The row layout does NOT change: `bucket_slots` keeps one row per code, keyed
 * by `bucket_code` exactly as before, and each row carries its own bucket's
 * identity. That is the whole reason this is safe. The alternative, one row per
 * pool, was weighed and deferred (Dan, 2026-09-11): the stored payload is read
 * back for the routing trace's effective code, the test bucket gate and the
 * empty bucket alert key, so collapsing the rows would put a bucket lookup back
 * on the booker's hot path and move four monitors into pool space, for a saving
 * of forty five small writes. The compute is the cost, and it is shared here.
 *
 * Pure and dependency injected so the identity substitution, the single stamp
 * and every failure path are driven without Supabase or Cloudflare:
 * `scripts/test-pool-recompute.ts`.
 */

/** A bucket, with both the pool inputs that decide WHICH pool it is in and the
 *  row that must be stamped onto its own copy of the answer. */
export interface PooledBucket extends PoolInput {
  code: string;
  bucket: Bucket;
}

export interface PoolRecomputeDeps {
  /** Injected so the stamp is a fixture rather than a race with the real clock. */
  nowMs(): number;
  /** The existing per code compute, run once for the pool's representative.
   *  Resolves to null when it could not answer. */
  compute(code: string): Promise<BucketSlots | null>;
  /** Store one code's row, stamped from when the COMPUTE began (#1048). */
  writeRow(code: string, val: BucketSlots, computedAtMs: number): Promise<void>;
  /** Drop one code's L1 cache entry so the next read serves the fresh row. */
  invalidate(code: string): Promise<void>;
}

export interface PoolRecomputeOutcome {
  /** The code the compute actually ran for, or null when nothing was computed. */
  computedFor: string | null;
  /** The codes whose rows were stored. */
  written: string[];
  /** The codes whose write failed. Empty when the compute itself did not answer:
   *  no individual code is to blame for that, and saying otherwise would send a
   *  reader looking for six write faults that did not happen (L11). */
  failed: string[];
}

export async function recomputePool(
  pool: PooledBucket[],
  deps: PoolRecomputeDeps,
): Promise<PoolRecomputeOutcome> {
  const representative = pool[0];
  if (!representative) return { computedFor: null, written: [], failed: [] };

  // Before the compute reads anything (#1048), so every row this produces
  // describes the state the slots were computed FROM rather than the moment its
  // write happened to land. One instant for the whole pool: the rows really are
  // one answer, and stamping them separately would make a six row pool look like
  // six computes to anything reading freshness.
  const computedAtMs = deps.nowMs();

  let computed: BucketSlots | null = null;
  try {
    computed = await deps.compute(representative.code);
  } catch {
    // Same finding as a null answer, and handled the same way: one pool must not
    // take down a lane sweeping fifteen. The caller logs; the rows that are
    // already there keep serving and the freshness sweep re-queues this pool.
    computed = null;
  }
  // A failed availability read must NOT overwrite good rows with an empty one
  // (#277). Under pooling that degrade would land on all six codes at once, so
  // nothing is written and no cache entry is dropped: the last good answer
  // stands everywhere and the stale bucket alarm is what surfaces it.
  if (!computed) return { computedFor: null, written: [], failed: [] };

  const written: string[] = [];
  const failed: string[] = [];
  for (const member of pool) {
    // The substitution this module exists for. Slots, event type and org name
    // are the shared ANSWER; the bucket row is the member's own IDENTITY, and
    // leaving the representative's on it would have five codes reporting a
    // sixth's bucket everywhere the payload is read back.
    const forMember: BucketSlots = { ...computed, bucket: member.bucket };
    try {
      await deps.writeRow(member.code, forMember, computedAtMs);
      written.push(member.code);
    } catch {
      // One bad write does not cost the other five; the sweep retries this code.
      failed.push(member.code);
    }
    // Dropped even when the write failed, matching what a single code recompute
    // has always done: a stale L1 entry must never outlive the attempt, and the
    // read behind it falls through to the row that is actually stored.
    //
    // Caught rather than allowed to propagate, because this runs AFTER the
    // member's write: letting it throw would abandon every code still to be
    // written over a cache entry that expires within SLOT_TTL_SECONDS anyway.
    await deps
      .invalidate(member.code)
      .catch((err) =>
        log.warn("precompute", { msg: "slot cache invalidate failed", bucket: member.code }, err),
      );
  }

  return { computedFor: representative.code, written, failed };
}

/**
 * Which pools the recompute lane owes work to, least recently computed first.
 *
 * This asks the freshness question of the POOL, and that is the whole of it. The
 * jitter (#1247) deliberately gives every bucket code its own phase inside the
 * freshness window so the due set arrives level rather than in clumps, which
 * means a six code pool has six deadlines spread across the window. Recomputing
 * the pool whenever ANY member reached its own deadline would rewrite all six
 * rows at the first one, resetting every clock into the next deadline a minute
 * later: the pool would come due roughly every quarter window (the jitter's
 * floor) instead of every window, and the lane would do MORE work than it did
 * before pooling. `scripts/test-pool-due.ts` drives three windows a minute at a
 * time and fails on exactly that.
 *
 * So each pool stands in for one bucket: its key supplies the phase, and its
 * OLDEST member supplies the last computed time, because a pool is only as fresh
 * as the code within it that has waited longest. The decision itself is
 * `bucketsDueForRecompute`, unchanged and already tested, rather than a second
 * copy of the grid arithmetic beside it.
 *
 * A pool with any member holding no row at all is due AT ONCE and is not given a
 * last computed time: that code is offering nothing until the pool is built, and
 * there is no timestamp to phase anyway.
 */
export function poolsDueForRecompute(
  known: KnownRow[],
  pools: Map<string, PooledBucket[]>,
  nowMs: number,
  freshMs: number,
  jitterFraction?: number,
): PooledBucket[][] {
  const computedAt = new Map(known.map((k) => [k.code, k.computedAtMs]));
  const keys: string[] = [];
  const poolRows: KnownRow[] = [];
  for (const [key, members] of pools) {
    keys.push(key);
    let oldest: number | undefined;
    let anyMissing = false;
    for (const m of members) {
      const at = computedAt.get(m.code);
      if (at === undefined) {
        anyMissing = true;
        break;
      }
      oldest = oldest === undefined ? at : Math.min(oldest, at);
    }
    // Left OUT of the known rows on purpose when a row is missing: an unknown
    // key is what `bucketsDueForRecompute` reads as due immediately.
    if (!anyMissing && oldest !== undefined) poolRows.push({ code: key, computedAtMs: oldest });
  }
  // Codes in `known` that no bucket carries any more (a retired code whose row
  // outlived it) cannot reach this: the enumeration is the POOLS, never the
  // stored rows, so a leftover row can never put work on the lane.
  const dueKeys = bucketsDueForRecompute(poolRows, keys, nowMs, freshMs, jitterFraction);
  return dueKeys.flatMap((k) => {
    const pool = pools.get(k);
    return pool ? [pool] : [];
  });
}

/** The seams `recomputeAgentPools` runs through, injected so the budget and the
 *  debounce are driven by a fixture clock rather than the real one. */
export interface AgentPoolsDeps {
  nowMs(): number;
  /** No pool is STARTED at or past this instant; the rest are deferred. */
  deadlineMs: number;
  /** Refresh one whole pool: one compute, written to every code in it. */
  recomputePool(pool: PooledBucket[]): Promise<unknown>;
  /** When each pool key was last started in this isolate. */
  lastRunAt: Map<string, number>;
  /** A pool started less than this long ago is skipped. */
  skipMs: number;
}

export interface AgentPoolsOutcome {
  refreshed: number;
  /** Not started because the budget ran out; the every minute lane owns them. */
  deferred: number;
  failed: number;
  /** Skipped because this isolate started the same pool moments ago. */
  debounced: number;
}

/**
 * Refresh the pools an agent's calendar or time off can move (#2922), for the
 * push and OOO paths that run after the response.
 *
 * Those paths used to recompute every CODE the agent is in, one after another,
 * with the whole multi agent compute each time (about four seconds). An agent in
 * eight codes spent about thirty seconds, which is where Cloudflare cancels post
 * response work, so 88% of push refreshes in the hour measured on 2026-09-30 were
 * cut off and the change waited for the recompute lane instead. The saving here
 * is the lane's own (#2245): siblings in a pool share one answer, so one compute
 * per pool refreshes every code the agent touches, siblings included.
 *
 * The budget is checked before each pool rather than trusted: a pool left
 * unstarted is counted and left to the lane, which refreshes every pool inside
 * its four minute freshness window, whereas one started past the limit is
 * cancelled mid write and reported by nothing. Each pool has its own failure
 * boundary (L73), and the debounce stands in for the per code one this replaces,
 * so a burst of pushes for one agent computes a pool once.
 */
export async function recomputeAgentPools(
  agentCodes: string[],
  allBuckets: PooledBucket[],
  deps: AgentPoolsDeps,
): Promise<AgentPoolsOutcome> {
  const outcome: AgentPoolsOutcome = { refreshed: 0, deferred: 0, failed: 0, debounced: 0 };
  const wanted = new Set(agentCodes);
  const pools = [...groupByPool(allBuckets)].filter(([, members]) =>
    members.some((m) => wanted.has(m.code)),
  );
  for (const [key, pool] of pools) {
    const now = deps.nowMs();
    if (now >= deps.deadlineMs) {
      outcome.deferred++;
      continue;
    }
    if (now - (deps.lastRunAt.get(key) ?? -Infinity) < deps.skipMs) {
      outcome.debounced++;
      continue;
    }
    deps.lastRunAt.set(key, now);
    try {
      await deps.recomputePool(pool);
      outcome.refreshed++;
    } catch (err) {
      outcome.failed++;
      log.warn("precompute", { msg: "agent pool recompute failed", bucket: pool[0].code }, err);
    }
  }
  return outcome;
}
