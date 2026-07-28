// Per-calendar sync health transition (#273 Phase 1): each calendar tracks its
// last error, a consecutive-failure streak, and last success so the operator
// can tell a transient blip from a persistent problem and an alert can NAME the
// failing agent. nextSyncState is pure so the transition is unit-tested.
// Run: node --experimental-strip-types scripts/test-sync-health.ts
import {
  nextSyncState,
  laneHealthUpdate,
  type CalSyncHealth,
} from "../src/lib/google/sync-health.ts";
import { assert, finish } from "./lib/harness.ts";

const NOW = "2026-06-19T12:00:00Z";

// Success clears the streak + error and stamps last_success_at.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 3,
    last_success_at: "2026-06-18T00:00:00Z",
    last_sync_error: "boom",
    last_failure_kind: "transient",
  };
  const next = nextSyncState(prev, { ok: true }, NOW);
  assert(next.consecutive_failures === 0, "success resets the failure streak to 0");
  assert(next.last_success_at === NOW, "success stamps last_success_at = now");
  assert(next.last_sync_error === null, "success clears the last error");
  assert(next.last_failure_kind === null, "success clears the failure classification (#916)");
}

// First failure: streak 0 -> 1, error recorded, last_success_at preserved.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 0,
    last_success_at: "2026-06-18T00:00:00Z",
    last_sync_error: null,
    last_failure_kind: null,
  };
  const next = nextSyncState(prev, { ok: false, error: "404 not found", kind: "gone" }, NOW);
  assert(next.consecutive_failures === 1, "first failure increments the streak to 1");
  assert(next.last_sync_error === "404 not found", "failure records the error message");
  assert(next.last_failure_kind === "gone", "failure records its classification (#916)");
  assert(
    next.last_success_at === "2026-06-18T00:00:00Z",
    "failure preserves the last success time (so an alert can show how long it's been down)",
  );
}

// An unclassified failure (kind omitted) records a null kind, which the paging
// policy treats conservatively as gone so a pre-#916 streak never goes silent.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 0,
    last_success_at: null,
    last_sync_error: null,
    last_failure_kind: null,
  };
  const next = nextSyncState(prev, { ok: false, error: "boom" }, NOW);
  assert(next.last_failure_kind === null, "an unclassified failure records a null kind");
}

// Consecutive failures accumulate.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 2,
    last_success_at: null,
    last_sync_error: "prev",
    last_failure_kind: "transient",
  };
  const next = nextSyncState(prev, { ok: false, error: "again", kind: "transient" }, NOW);
  assert(next.consecutive_failures === 3, "consecutive failures accumulate (2 -> 3)");
  assert(next.last_success_at === null, "a never-succeeded calendar keeps last_success_at null");
}

// #1150: the transition is shared, but each lane stores it in its OWN columns.
// One shared column let the 1-min sync lane zero the ~5-min watch lane's streak
// on its next success, so a renewal failure could never reach a paging threshold.
{
  const state: CalSyncHealth = {
    consecutive_failures: 4,
    last_success_at: NOW,
    last_sync_error: "boom",
    last_failure_kind: "transient",
  };

  const sync = laneHealthUpdate("sync", state);
  assert(sync.consecutive_failures === 4, "the sync lane writes consecutive_failures");
  assert(sync.last_success_at === NOW, "the sync lane writes last_success_at");
  assert(sync.last_sync_error === "boom", "the sync lane writes last_sync_error");
  assert(sync.last_failure_kind === "transient", "the sync lane writes last_failure_kind");
  assert(
    !Object.keys(sync).some((k) => k.startsWith("watch_")),
    "a sync write touches NO watch column, so it cannot clear a renewal streak",
  );

  const watch = laneHealthUpdate("watch", state);
  assert(watch.watch_consecutive_failures === 4, "the watch lane writes watch_consecutive_failures");
  assert(watch.watch_last_success_at === NOW, "the watch lane writes watch_last_success_at");
  assert(watch.watch_last_error === "boom", "the watch lane writes watch_last_error");
  assert(
    watch.watch_last_failure_kind === "transient",
    "the watch lane writes watch_last_failure_kind",
  );
  assert(
    !("consecutive_failures" in watch) &&
      !("last_success_at" in watch) &&
      !("last_sync_error" in watch) &&
      !("last_failure_kind" in watch),
    "a watch write touches NO sync column, so it cannot clear a sync streak",
  );

  // The two column sets must not overlap at all: one shared name is the bug.
  const shared = Object.keys(sync).filter((k) => k in watch);
  assert(shared.length === 0, `the lanes share no column (got: ${shared.join(", ")})`);
}

finish();
