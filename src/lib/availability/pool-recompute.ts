import { log } from "@/lib/log";
import type { Bucket } from "@/lib/db/types";
import type { BucketSlots } from "./service";
import { groupByPool, type PoolInput } from "./pool-key";
import { bucketsDueForRecompute, type KnownRow } from "./precompute-cron";
import type { SlotRowWriteOutcome } from "./slot-row-write";

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
  /**
   * When the eligibility list the compute used was READ, asked once the compute
   * has answered (#3388). Null when nothing older than the compute's own start was
   * used, which is every live path. Only the recompute lane reads eligibility
   * through the 60 second cache, and a list read there 50 seconds ago is 50 seconds
   * old whatever the clock said when the compute began (L751).
   */
  eligibilityReadAtMs?(): number | null;
  /** Store one code's row, stamped from when the COMPUTE began (#1048), or from when
   *  its eligibility list was read if that was earlier (#3388). Answers what
   *  the write did, because a database REFUSAL is an answer rather than a throw
   *  (#3119): `failed` lands the code in `failed[]` exactly as a throw does. */
  writeRow(code: string, val: BucketSlots, computedAtMs: number): Promise<SlotRowWriteOutcome>;
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
  /** How far before the compute's start its rows were stamped, because the
   *  eligibility list it used was read earlier (#3388); null when they were stamped
   *  at the start. Reported so the lane can log how often, and by how much, its rows
   *  read older than the compute, which is what moves its due set. */
  stampLagMs: number | null;
}

export async function recomputePool(
  pool: PooledBucket[],
  deps: PoolRecomputeDeps,
): Promise<PoolRecomputeOutcome> {
  const representative = pool[0];
  if (!representative) return { computedFor: null, written: [], failed: [], stampLagMs: null };

  // Before the compute reads anything (#1048), so every row this produces
  // describes the state the slots were computed FROM rather than the moment its
  // write happened to land. One instant for the whole pool: the rows really are
  // one answer, and stamping them separately would make a six row pool look like
  // six computes to anything reading freshness.
  const startedMs = deps.nowMs();

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
  if (!computed) return { computedFor: null, written: [], failed: [], stampLagMs: null };

  // #3388: the rows describe the state they were computed FROM, and a cached
  // eligibility list is part of that state as of when it was read. So the stamp is
  // the earlier of the two. Without this the #1048 gate below judged a list read 50
  // seconds ago as newer than a row a live path wrote 20 seconds ago, and the older
  // answer won. A live path reports no read time and keeps its start, as before.
  const readAtMs = deps.eligibilityReadAtMs?.() ?? null;
  const computedAtMs =
    readAtMs !== null && Number.isFinite(readAtMs) ? Math.min(startedMs, readAtMs) : startedMs;

  const written: string[] = [];
  const failed: string[] = [];
  for (const member of pool) {
    // The substitution this module exists for. Slots, event type and org name
    // are the shared ANSWER; the bucket row is the member's own IDENTITY, and
    // leaving the representative's on it would have five codes reporting a
    // sixth's bucket everywhere the payload is read back.
    const forMember: BucketSlots = { ...computed, bucket: member.bucket };
    try {
      // `kept-newer` is a success: a fresher row already stands for this code. So is
      // `invalidated` (#3118): a save landed mid compute and the row stays due.
      const outcome = await deps.writeRow(member.code, forMember, computedAtMs);
      if (outcome === "failed") failed.push(member.code);
      else written.push(member.code);
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

  const stampLagMs = computedAtMs < startedMs ? startedMs - computedAtMs : null;
  return { computedFor: representative.code, written, failed, stampLagMs };
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

/** The seams `recomputeTouchedPools` runs through, injected so the budget and the
 *  debounce are driven by a fixture clock rather than the real one. */
export interface TouchedPoolsDeps {
  nowMs(): number;
  /** No pool is STARTED at or past this instant; the rest are deferred. */
  deadlineMs: number;
  /** Refresh one whole pool: one compute, written to every code in it. Resolves to
   *  how many codes' rows were written; zero means nothing landed. */
  recomputePool(pool: PooledBucket[]): Promise<number>;
  /** When each pool key was last started in this isolate. */
  lastRunAt: Map<string, number>;
  /** A pool started less than this long ago is skipped. */
  skipMs: number;
  /**
   * The most pools this call may START (#2357), the ceiling that holds when the
   * deadline cannot. A Worker's clock returns the time of the last I/O and does not
   * advance during execution, so a fan-out whose cost is CPU can read the deadline
   * as unreached for its whole length. Required, so every caller states its own
   * ceiling; anything not finite and positive starts nothing rather than everything.
   */
  maxPools: number;
}

export interface TouchedPoolsOutcome {
  refreshed: number;
  /** Not started because the budget or the count ran out; the every minute lane
   *  owns them. */
  deferred: number;
  failed: number;
  /** Skipped because this isolate started the same pool moments ago. */
  debounced: number;
}

/**
 * Refresh the pools a set of bucket codes falls in, one compute per POOL, inside a
 * budget and a count (#2922, #2357).
 *
 * Two kinds of caller. The push and OOO paths pass the codes one agent's calendar
 * or time off can move, after the response. The sync lane and the self heal
 * reconcile sweeps pass the codes a whole tick's changed agents touch, on the
 * every minute cron.
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
export async function recomputeTouchedPools(
  agentCodes: string[],
  allBuckets: PooledBucket[],
  deps: TouchedPoolsDeps,
): Promise<TouchedPoolsOutcome> {
  const outcome: TouchedPoolsOutcome = { refreshed: 0, deferred: 0, failed: 0, debounced: 0 };
  // NaN, zero and negatives all mean "start nothing", stated once here so no
  // comparison below can read NaN as no ceiling at all (L50).
  const maxPools = Number.isNaN(deps.maxPools) || deps.maxPools <= 0 ? 0 : deps.maxPools;
  let started = 0;
  const wanted = new Set(agentCodes);
  const pools = [...groupByPool(allBuckets)].filter(([, members]) =>
    members.some((m) => wanted.has(m.code)),
  );
  for (const [key, pool] of pools) {
    const now = deps.nowMs();
    if (now >= deps.deadlineMs || started >= maxPools) {
      outcome.deferred++;
      continue;
    }
    // Debounced BEFORE the count is spent: a skipped pool cost no compute, which is
    // the thing the count bounds, so it leaves its place to the next pool.
    if (now - (deps.lastRunAt.get(key) ?? -Infinity) < deps.skipMs) {
      outcome.debounced++;
      continue;
    }
    started++;
    // Stamped before the compute so a burst of pushes in this isolate computes the
    // pool once, and cleared again on a failure: the debounce stands for "this pool
    // was just refreshed", which a failure is not, so the next push must try again.
    deps.lastRunAt.set(key, now);
    try {
      const written = await deps.recomputePool(pool);
      if (written > 0) {
        outcome.refreshed++;
      } else {
        // A compute that answered nothing, or writes that all failed, landed no row.
        // Counting it as refreshed would have the refresh's log line claim work
        // that never happened (L11).
        outcome.failed++;
        deps.lastRunAt.delete(key);
        log.warn("precompute", { msg: "agent pool recompute wrote no rows", bucket: pool[0].code });
      }
    } catch (err) {
      outcome.failed++;
      deps.lastRunAt.delete(key);
      log.warn("precompute", { msg: "agent pool recompute failed", bucket: pool[0].code }, err);
    }
  }
  return outcome;
}
