// Per-calendar sync health transition (#273 Phase 1): each calendar tracks its
// last error, a consecutive-failure streak, and last success so the operator
// can tell a transient blip from a persistent problem and an alert can NAME the
// failing agent. nextSyncState is pure so the transition is unit-tested.
// Run: node --experimental-strip-types scripts/test-sync-health.ts
import { nextSyncState, type CalSyncHealth } from "../src/lib/google/sync-health.ts";
import { assert, finish } from "./lib/harness.ts";

const NOW = "2026-06-19T12:00:00Z";

// Success clears the streak + error and stamps last_success_at.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 3,
    last_success_at: "2026-06-18T00:00:00Z",
    last_sync_error: "boom",
  };
  const next = nextSyncState(prev, { ok: true }, NOW);
  assert(next.consecutive_failures === 0, "success resets the failure streak to 0");
  assert(next.last_success_at === NOW, "success stamps last_success_at = now");
  assert(next.last_sync_error === null, "success clears the last error");
}

// First failure: streak 0 -> 1, error recorded, last_success_at preserved.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 0,
    last_success_at: "2026-06-18T00:00:00Z",
    last_sync_error: null,
  };
  const next = nextSyncState(prev, { ok: false, error: "404 not found" }, NOW);
  assert(next.consecutive_failures === 1, "first failure increments the streak to 1");
  assert(next.last_sync_error === "404 not found", "failure records the error message");
  assert(
    next.last_success_at === "2026-06-18T00:00:00Z",
    "failure preserves the last success time (so an alert can show how long it's been down)",
  );
}

// Consecutive failures accumulate.
{
  const prev: CalSyncHealth = {
    consecutive_failures: 2,
    last_success_at: null,
    last_sync_error: "prev",
  };
  const next = nextSyncState(prev, { ok: false, error: "again" }, NOW);
  assert(next.consecutive_failures === 3, "consecutive failures accumulate (2 -> 3)");
  assert(next.last_success_at === null, "a never-succeeded calendar keeps last_success_at null");
}

finish();
