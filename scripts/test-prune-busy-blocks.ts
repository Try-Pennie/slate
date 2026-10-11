// The busy_blocks prune (#1252 past, #1265 future): cutoff maths, the per-run bound,
// and the failure paths.
//
// WHY THE PRUNE EXISTS. `busy_blocks` is the cached index availability reads, and it
// only ever grew: the Google sync stores every event the delta stream reports, including
// recurring instances expanded years ahead, so 403k rows were cached on 2026-08-04 while
// only 3,646 sat inside the 4-day window anything can read.
//
// TWO ends are safe to delete, each for its own reason. The PAST: every reader requires
// `ends_at > now`, so a finished block is unreadable and time only moves one way. The
// FUTURE out-of-window tail (#1265): once #1264's write filter stops ADDING blocks past
// the cache window, the delta can no longer re-add what is removed, so the backlog is
// safe to clear. The cutoff/gate below pin the inequality that keeps it provably clear of
// anything readable (`starts_at < now + horizon`). Before #1264 the future was NOT safe:
// a far-future block deleted while the delta still re-added it would churn.
import {
  BUSY_PRUNE_BATCH_ROWS,
  BUSY_PRUNE_KEEP_PAST_HOURS,
  BUSY_PRUNE_MAX_ROWS_PER_RUN,
  BUSY_FUTURE_PRUNE_GATE_GRACE_MS,
  busyPruneCutoffIso,
  busyFuturePruneCutoffIso,
  busyFuturePruneGateIso,
  pruneInBatches,
} from "../src/lib/busy/prune-core.ts";
import { BOOTSTRAP_LOOKBACK_MS, BUSY_WINDOW_AHEAD_DAYS } from "../src/lib/google/sync-coalesce.ts";
import { WRITE_WINDOW_MARGIN_MS } from "../src/lib/google/sync-core.ts";
import { HORIZON_MAX } from "../src/lib/booking/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- cutoff ---------------------------------------------------------------

eq(
  busyPruneCutoffIso("2026-08-04T12:00:00.000Z", 36),
  "2026-08-03T00:00:00.000Z",
  "cutoff is nowIso minus the keep-past window, in UTC",
);

// The invariant that keeps the prune and the sync from fighting each other. A
// bootstrap re-fetches from `now - BOOTSTRAP_LOOKBACK_MS`, so pruning anything
// newer than that would delete rows the very next bootstrap re-adds: churn that
// burns the write budget forever and never converges.
assert(
  BUSY_PRUNE_KEEP_PAST_HOURS * 60 * 60_000 > BOOTSTRAP_LOOKBACK_MS,
  "keep-past window exceeds the bootstrap lookback, so a pruned row is never re-added",
);

// --- the future cutoff + hydration gate (#1265) ---------------------------
const DAY = 24 * 60 * 60_000;
const nowIso = "2026-10-11T12:00:00.000Z";
const nowMs = Date.parse(nowIso);
const futureCutoffMs = Date.parse(busyFuturePruneCutoffIso(nowIso, BUSY_WINDOW_AHEAD_DAYS, WRITE_WINDOW_MARGIN_MS));
const gateMs = Date.parse(busyFuturePruneGateIso(nowIso, HORIZON_MAX));

// The future cutoff equals the write filter's keepTo (now + ahead + margin) EXACTLY, so
// #1264 (stops adding past it) and #1265 (removes the backlog past it) never churn.
eq(
  futureCutoffMs,
  nowMs + BUSY_WINDOW_AHEAD_DAYS * DAY + WRITE_WINDOW_MARGIN_MS,
  "the future cutoff is the write filter's keep boundary, so the two never fight",
);

// THE LOAD-BEARING INEQUALITY. Readable requires starts_at < now + horizon, at most
// now + HORIZON_MAX. The cutoff must sit strictly beyond that, so no readable block is
// ever prunable however large the horizon is set.
assert(
  futureCutoffMs > nowMs + HORIZON_MAX * DAY,
  "the future cutoff is strictly beyond the largest readable instant, so nothing readable is pruned",
);

// The hydration gate sits past the max horizon by the grace, so a calendar is eligible
// only once its window reaches beyond every slot a lead could book, never while it is
// merely level with the horizon.
eq(gateMs, nowMs + HORIZON_MAX * DAY + BUSY_FUTURE_PRUNE_GATE_GRACE_MS, "the gate is now + HORIZON_MAX + grace");
assert(gateMs > nowMs + HORIZON_MAX * DAY, "the gate is strictly past the largest readable instant");

// --- the per-run bound ----------------------------------------------------

/** A fake store of prunable ids that hands out bounded pages and forgets deletes. */
function fakeStore(total: number) {
  const state = {
    remaining: total,
    selectLimits: [] as number[],
    deletedBatches: [] as number[],
  };
  return {
    state,
    selectIds: async (limit: number): Promise<string[]> => {
      state.selectLimits.push(limit);
      const n = Math.min(limit, state.remaining);
      return Array.from({ length: n }, (_, i) => `id-${state.remaining - i}`);
    },
    deleteIds: async (ids: string[]): Promise<number> => {
      state.deletedBatches.push(ids.length);
      state.remaining -= ids.length;
      return ids.length;
    },
  };
}

{
  // More prunable rows than one run may take: stop at the cap and SAY so, rather
  // than reporting a clean finish that reads as "nothing left to do".
  const store = fakeStore(BUSY_PRUNE_MAX_ROWS_PER_RUN + BUSY_PRUNE_BATCH_ROWS);
  const report = await pruneInBatches({
    selectIds: store.selectIds,
    deleteIds: store.deleteIds,
    withinBudget: () => true,
  });
  eq(report.pruned, BUSY_PRUNE_MAX_ROWS_PER_RUN, "stops at the per-run row cap");
  eq(report.capped, true, "reports capped when rows are still left behind");
  assert(
    store.state.selectLimits.every((l) => l <= BUSY_PRUNE_BATCH_ROWS),
    "never asks for more than one batch at a time (bounded single-page reads)",
  );
  eq(
    store.state.selectLimits.reduce((a, b) => a + b, 0),
    BUSY_PRUNE_MAX_ROWS_PER_RUN,
    "never reads past the cap, so the last batch is trimmed to fit",
  );
}

{
  // The steady state: fewer prunable rows than the cap, so the run drains them and
  // reports NOT capped. That is the signal the backlog has actually cleared.
  const store = fakeStore(BUSY_PRUNE_BATCH_ROWS + 7);
  const report = await pruneInBatches({
    selectIds: store.selectIds,
    deleteIds: store.deleteIds,
    withinBudget: () => true,
  });
  eq(report.pruned, BUSY_PRUNE_BATCH_ROWS + 7, "drains everything prunable when under the cap");
  eq(report.capped, false, "not capped once a short batch proves the backlog is gone");
  eq(report.batches, 2, "one full batch then the short remainder");
}

{
  // Nothing to do: no delete is attempted at all, and it is not a capped run.
  const store = fakeStore(0);
  const report = await pruneInBatches({
    selectIds: store.selectIds,
    deleteIds: store.deleteIds,
    withinBudget: () => true,
  });
  eq(report.pruned, 0, "prunes nothing when nothing is old enough");
  eq(report.capped, false, "an empty run is not a capped run");
  eq(store.state.deletedBatches.length, 0, "issues no delete when there is nothing to delete");
}

{
  // The shared invocation budget is the real ceiling (the retention lanes share one
  // Worker invocation), so the budget must be able to stop the loop between batches.
  const store = fakeStore(BUSY_PRUNE_MAX_ROWS_PER_RUN);
  let checks = 0;
  const report = await pruneInBatches({
    selectIds: store.selectIds,
    deleteIds: store.deleteIds,
    withinBudget: () => ++checks <= 1,
  });
  eq(report.batches, 1, "stops after one batch when the budget runs out");
  eq(report.capped, true, "a budget-stopped run reports capped");
}

// --- failure paths --------------------------------------------------------

{
  // A delete that fails must NOT be reported as a run that pruned some rows and
  // finished. #1165: a failed `count: "exact"` delete comes back null, and the
  // `count ?? 0` every call site writes turns that into a healthy-looking zero,
  // indistinguishable from having had nothing to clean.
  let threw = false;
  try {
    await pruneInBatches({
      selectIds: async () => ["a", "b"],
      deleteIds: async () => {
        throw new Error("delete failed");
      },
      withinBudget: () => true,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a failing delete propagates instead of reporting a clean run");
}

{
  // Non-progress guard: ids came back but the delete removed none of them, so the
  // read and the write disagree. Looping again would spin on the same rows for the
  // whole budget; failing loud is the only honest option.
  let threw = false;
  try {
    await pruneInBatches({
      selectIds: async () => ["a", "b"],
      deleteIds: async () => 0,
      withinBudget: () => true,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a delete that removes nothing while rows are selected fails loud");
}

{
  // A read that fails must abort the run rather than look like an empty backlog.
  let threw = false;
  try {
    await pruneInBatches({
      selectIds: async () => {
        throw new Error("read failed");
      },
      deleteIds: async () => 0,
      withinBudget: () => true,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a failing candidate read propagates instead of reporting zero prunable");
}

finish();
