import { DateTime } from "luxon";
import { ID_BATCH_ROWS } from "@/lib/db/id-batch";

/**
 * Pure core of the `busy_blocks` past-row prune (#1252). Kept dependency-free so
 * the node runner drives it directly, with the store injected.
 *
 * `busy_blocks` is the cached availability index and it only ever grew: the Google
 * sync stores every event its delta stream reports, and a bootstrap with
 * `singleEvents=true` and no `timeMax` expands recurring series years ahead. On
 * 2026-08-04 the table held 403k rows / 247 MB while just 3,646 sat inside the
 * 4-day window any reader can see, and `purgeVanished` pages EVERY cached block for
 * a calendar on each full resync, so the size is paid for in subrequests too.
 *
 * This prune deliberately covers the PAST ONLY. Every reader requires
 * `ends_at > now` (`availability/service.ts`, `booking/service.ts`, staffing
 * depth), so a finished block is already unreadable, and time moves one way: it can
 * never come back into a window. Future rows are NOT safe to delete here, because
 * incremental sync reports only CHANGES: a far-future block that is deleted is
 * never re-added when the horizon reaches it, and the agent would then look free
 * during a real meeting. Shrinking the future side needs a rolling re-bootstrap so
 * the stored window can advance, which is tracked separately.
 */

/**
 * How much finished busy time to keep. It MUST exceed the sync's bootstrap
 * lookback (`BOOTSTRAP_LOOKBACK_MS`, 24h): a bootstrap re-fetches from
 * `now - lookback`, so pruning anything newer would delete rows the next bootstrap
 * immediately re-adds, and the two would churn against each other forever without
 * converging. The margin is asserted in scripts/test-prune-busy-blocks.ts rather
 * than left to this comment.
 */
export const BUSY_PRUNE_KEEP_PAST_HOURS = 36;

/**
 * Ids per select/delete round, from the one shared budget (#1259).
 *
 * This shipped as 500 and was WRONG: 500 uuids is an 18,578-byte request URL, which
 * prod PostgREST refuses outright, so the lane would have thrown on every run and
 * pruned nothing. It was justified by pointing at `WRITE_CHUNK` (500) in
 * google/sync.ts, but that carries ~27-character Google event ids rather than
 * 36-character uuids, so the precedent did not transfer. `ID_BATCH_ROWS` is measured
 * against the real limit and shared, so the two cannot drift again.
 */
export const BUSY_PRUNE_BATCH_ROWS = ID_BATCH_ROWS;

/**
 * Ceiling on rows removed per run, so the lane's cost is bounded no matter how large
 * the backlog is.
 *
 * The binding constraint is the SUBREQUEST budget of the daily 03:00 invocation, which
 * this lane shares with the three retention lanes. Each round costs two subrequests (a
 * candidate read and a delete), so at 200 ids per round this cap is 100 rounds and 200
 * subrequests, leaving the rest of the shared budget alone. Wall clock is roughly 9
 * seconds (the candidate read measured ~70 ms per batch), well inside the lane's own
 * 40-second budget.
 *
 * The 68,805-row backlog measured on 2026-08-04 therefore clears over about four
 * nightly runs, after which the daily volume is a few hundred rows. Lowered from
 * 30,000 when the round size dropped to a URL-safe 200 (#1259): keeping the row cap
 * while tripling the round count would have tripled the subrequest cost instead.
 */
export const BUSY_PRUNE_MAX_ROWS_PER_RUN = 20_000;

/** ISO cutoff: blocks that ended before this are prunable. */
export function busyPruneCutoffIso(
  nowIso: string,
  keepPastHours: number = BUSY_PRUNE_KEEP_PAST_HOURS,
): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .minus({ hours: keepPastHours })
    .toUTC()
    .toISO({ suppressMilliseconds: false })!;
}

export interface PruneReport {
  /** Rows the store confirmed it deleted. */
  pruned: number;
  /** Select/delete rounds actually issued. */
  batches: number;
  /**
   * True when the run stopped on its row cap or its time budget with a full batch
   * still coming back, so prunable rows remain. Reported (and logged) rather than
   * left implicit: a capped run and a drained run both return a healthy 200, and
   * without this the difference is invisible, which is how a cap that is set too
   * low reads as "the backlog is clear".
   */
  capped: boolean;
}

export interface PruneDeps {
  /** Oldest prunable ids, at most `limit` of them. Throws on a read error. */
  selectIds: (limit: number) => Promise<string[]>;
  /** Delete exactly these ids, returning how many rows went. Throws on error. */
  deleteIds: (ids: string[]) => Promise<number>;
  /** Checked BEFORE each round, so the loop never overruns by more than one. */
  withinBudget: () => boolean;
  batchRows?: number;
  maxRows?: number;
}

/**
 * Delete prunable rows in bounded rounds until the backlog is drained, the row cap
 * is reached, or the time budget runs out.
 *
 * Both stores errors propagate: a read that failed must not read as an empty
 * backlog, and a delete that failed must not read as a run with nothing to clean
 * (#1165, where a failed `count: "exact"` delete came back null and `count ?? 0`
 * turned it into a healthy-looking zero).
 */
export async function pruneInBatches(deps: PruneDeps): Promise<PruneReport> {
  const batchRows = deps.batchRows ?? BUSY_PRUNE_BATCH_ROWS;
  const maxRows = deps.maxRows ?? BUSY_PRUNE_MAX_ROWS_PER_RUN;
  let pruned = 0;
  let batches = 0;
  let drained = false;

  while (pruned < maxRows && deps.withinBudget()) {
    const want = Math.min(batchRows, maxRows - pruned);
    const ids = await deps.selectIds(want);
    if (ids.length < want) drained = true;
    if (ids.length === 0) break;
    batches++;
    const deleted = await deps.deleteIds(ids);
    // The read found rows the write then did not touch, so the two disagree about
    // what is prunable. Looping would re-select the same ids and spin for the whole
    // budget, so stop loudly instead of quietly burning the run. A PARTIAL delete
    // is fine and expected (a concurrent run may have taken some already).
    if (deleted === 0) {
      throw new Error(
        `busy_blocks prune made no progress: selected ${ids.length} rows, deleted 0`,
      );
    }
    pruned += deleted;
    if (drained) break;
  }

  return { pruned, batches, capped: !drained };
}
