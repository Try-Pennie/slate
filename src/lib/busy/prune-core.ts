import { DateTime } from "luxon";

/**
 * Pure core of the `busy_blocks` prune (#1252 past rows, #1265 future out-of-window
 * rows). Kept dependency-free so the node runner drives it directly, with the store
 * injected; the route supplies the selects and deletes for each clause.
 *
 * `busy_blocks` is the cached availability index and it only ever grew: the Google
 * sync stores every event its delta stream reports, and a bootstrap with
 * `singleEvents=true` and no `timeMax` expands recurring series years ahead. On
 * 2026-08-04 the table held 403k rows / 247 MB while just 3,646 sat inside the
 * 4-day window any reader can see, and `purgeVanished` pages EVERY cached block for
 * a calendar on each full resync, so the size is paid for in subrequests too.
 *
 * There are two prunable ends, and each is safe for a different reason:
 *
 *  - the PAST (#1252): every reader requires `ends_at > now`, so a finished block is
 *    already unreadable and time only moves one way, it can never come back into a
 *    window. `busyPruneCutoffIso` keeps a window wider than the bootstrap lookback so
 *    the prune and the sync cannot churn.
 *  - the FUTURE out-of-window tail (#1265): once #1264's write filter stops ADDING
 *    blocks past the cache window, the delta can no longer re-add what is removed, so
 *    the existing backlog is safe to delete. `busyFuturePruneCutoffIso` /
 *    `busyFuturePruneGateIso` below are the bound and the per-calendar hydration gate
 *    that make it provable no readable block (which needs `starts_at < now + horizon`)
 *    is ever in scope. Before #1264 shipped this was NOT safe: a far-future block
 *    deleted while the delta still re-added it would churn, and one deleted before
 *    hydration covered its window would leave the agent looking free during a real
 *    meeting.
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
 * Candidate rows to READ per round. A genuine row limit, and nothing more (#1321).
 *
 * It used to double as the delete's URL budget, which is what made it dangerous:
 * a number that has to satisfy both a subrequest budget and a request-URL ceiling
 * gets tuned for one and silently breaks the other. It shipped as 500 for exactly
 * that reason, carried over from `WRITE_CHUNK` in google/sync.ts, whose ~27
 * character Google event ids made 500 fine there and an 18,578-byte URL here that
 * prod PostgREST refuses outright, so the lane would have thrown on every run and
 * pruned nothing (#1259).
 *
 * The delete now chunks by measured BYTES through `chunkIdsByUrlBudget`, so this
 * number can only ever cost subrequests and wall clock, never a refused request.
 * 200 keeps each round's read cheap on a budget four retention lanes share.
 */
export const BUSY_PRUNE_BATCH_ROWS = 200;

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
 *
 * #1265: the future out-of-window prune shares this ONE cap with the past prune rather
 * than carrying its own, so the two together still delete at most 20,000 rows (about 200
 * delete subrequests) per invocation. The future phase adds one candidate read per
 * eligible calendar (roster-bounded, ~150), which is the only extra subrequest cost on
 * top of the shared delete budget.
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

/**
 * How far past the horizon a calendar's hydrated window must reach before its future
 * tail may be pruned (#1265). The grace sits above the max bookable horizon, never near
 * it, so a calendar that has only just caught up to the horizon is still held back.
 */
export const BUSY_FUTURE_PRUNE_GATE_GRACE_MS = 24 * 60 * 60_000;

/**
 * The FUTURE cutoff (#1265): a gcal block starting at or after this is beyond what any
 * reader can see and beyond the write filter's keep boundary, so it is safe to prune.
 *
 * `aheadDays` and `marginMs` are passed in (BUSY_WINDOW_AHEAD_DAYS, WRITE_WINDOW_MARGIN_MS
 * at the call site) rather than imported, so this pure module takes on no dependency on
 * the sync layer that imports it. Kept EQUAL to the write filter's keepTo so the two
 * never churn: #1264 stops ADDING past this line, this REMOVES the backlog past it.
 */
export function busyFuturePruneCutoffIso(nowIso: string, aheadDays: number, marginMs: number): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .plus({ days: aheadDays, milliseconds: marginMs })
    .toUTC()
    .toISO({ suppressMilliseconds: false })!;
}

/**
 * The hydration gate (#1265): a calendar may have its future tail pruned only when its
 * `sync_window_to` is STRICTLY AFTER this instant, so it is provable that nothing
 * readable is ever deleted. Readable requires `starts_at < now + horizon <= now +
 * horizonMaxDays`, and this gate is `now + horizonMaxDays + grace`, so an eligible
 * calendar's window reaches past every slot a lead could book, and the future cutoff
 * above is further out still.
 */
export function busyFuturePruneGateIso(
  nowIso: string,
  horizonMaxDays: number,
  graceMs: number = BUSY_FUTURE_PRUNE_GATE_GRACE_MS,
): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .plus({ days: horizonMaxDays, milliseconds: graceMs })
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
  /** Delete exactly these ids, returning how many rows went. Throws on error.
   *  Chunks by measured URL bytes internally, so the caller's round size is free
   *  to be a plain row count (#1321). */
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
