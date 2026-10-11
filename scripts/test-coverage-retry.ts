// #3485 part C: a stranded (unplaceable) coverage call is retried about once an hour by
// re-arming it to `pending`, so the every-5-minute drain re-attempts the live placement.
// This pins the DECISION the retry makes: which items are re-armed, that a cancelled sweep
// is never retried (the time off was called off, so the move must not happen), and that
// nothing is written when there is nothing to retry. The sweep is deliberately NOT
// reactivated (the drain picks up a pending item whatever its sweep's status), so there is
// no reactivation to orchestrate here.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coverage-retry.ts
import {
  retryUnplaceableCoverage,
  selectRetryableUnplaceable,
  type CoverageRetryDeps,
  type RetryableReads,
  type RetryableUnplaceable,
} from "@/lib/booking/coverage-retry";
import { assert, finish } from "./lib/harness.ts";

interface Over {
  /** Item ids that raced away (moved/cancelled) between the read and the re-arm, so the
   *  conditional write does not flip them: the store returns the count it matched. */
  racedIds?: Set<string>;
  deps?: Partial<CoverageRetryDeps>;
}

function fakeDeps(rows: RetryableUnplaceable[], over: Over = {}) {
  const reArmCalls: string[][] = [];
  const raced = over.racedIds ?? new Set<string>();
  const deps: CoverageRetryDeps = {
    loadRetryable: async () => rows,
    reArm: async (ids) => {
      reArmCalls.push(ids);
      // Mirror the store: only still-unplaceable rows are flipped, so a raced id drops out.
      return ids.filter((id) => !raced.has(id)).length;
    },
    ...over.deps,
  };
  return { deps, reArmCalls };
}

const row = (over: Partial<RetryableUnplaceable> = {}): RetryableUnplaceable => ({
  itemId: "i1",
  jobId: "j1",
  jobStatus: "done",
  ...over,
});

// The "still stranded" predicate, the same question the monitor's countStranded answers.
function selectCase(over: {
  item?: Partial<{ id: string; job_id: string; booking_id: string }>;
  holder?: { assignedUserId: string | null; inPool: boolean } | null;
  job?: { status: RetryableUnplaceable["jobStatus"]; outUserId: string; fromRedistribute: boolean } | null;
}): RetryableUnplaceable[] {
  const item = { id: "i1", job_id: "j1", booking_id: "b1", ...over.item };
  const reads: RetryableReads = {
    items: [item],
    holderByBooking: new Map(
      over.holder === null ? [] : [[item.booking_id, over.holder ?? { assignedUserId: "out", inPool: false }]],
    ),
    jobById: new Map(
      over.job === null
        ? []
        : [[item.job_id, over.job ?? { status: "done", outUserId: "out", fromRedistribute: false }]],
    ),
  };
  return selectRetryableUnplaceable(reads);
}

async function run() {
  // --- selectRetryableUnplaceable: the still-stranded predicate (L342) ---
  // Still on the out agent, time-off sweep: stranded, retried.
  assert(selectCase({}).length === 1, "a call still on the out agent is retryable");
  // Booking no longer active/upcoming (absent from the map): not retryable.
  assert(selectCase({ holder: null }).length === 0, "a passed or inactive booking is not retryable");
  // Job row missing: not retryable (cannot judge it).
  assert(selectCase({ job: null }).length === 0, "an item with no job row is dropped");
  // Already moved off the out agent: not stranded.
  assert(
    selectCase({ holder: { assignedUserId: "someone-else", inPool: false } }).length === 0,
    "a call already moved off the out agent is not retryable",
  );
  // #3597: a Redistribute sweep whose agent is back in the pool is covered, not stranded.
  assert(
    selectCase({
      holder: { assignedUserId: "out", inPool: true },
      job: { status: "done", outUserId: "out", fromRedistribute: true },
    }).length === 0,
    "a Redistribute call whose agent is back in the pool is not retryable (#3597)",
  );
  // But a TIME-OFF sweep's call is retried even with the agent in the pool (they are away).
  assert(
    selectCase({
      holder: { assignedUserId: "out", inPool: true },
      job: { status: "done", outUserId: "out", fromRedistribute: false },
    }).length === 1,
    "a time-off call is still retryable while the agent is in the pool (they are away)",
  );

  // Re-arms every upcoming unplaceable item.
  {
    const { deps, reArmCalls } = fakeDeps([
      row({ itemId: "i1", jobId: "j1", jobStatus: "done" }),
      row({ itemId: "i2", jobId: "j1", jobStatus: "done" }),
    ]);
    const summary = await retryUnplaceableCoverage(deps);
    assert(summary.reArmed === 2, "both items re-armed");
    assert(summary.considered === 2, "both rows considered");
    assert(reArmCalls[0].join(",") === "i1,i2", "re-arm carries both item ids");
  }

  // A cancelled sweep is never retried: the time off was cancelled or narrowed, so the
  // move must not happen. Its item is excluded from the re-arm.
  {
    const { deps, reArmCalls } = fakeDeps([
      row({ itemId: "i1", jobId: "jlive", jobStatus: "done" }),
      row({ itemId: "i2", jobId: "jcancel", jobStatus: "cancelled" }),
    ]);
    const summary = await retryUnplaceableCoverage(deps);
    assert(summary.reArmed === 1, "only the live sweep's item is re-armed");
    assert(reArmCalls[0].join(",") === "i1", "the cancelled sweep's item is excluded");
  }

  // An item that raced to moved/cancelled between the read and the write is not re-armed:
  // the store's conditional update matches nothing for it.
  {
    const { deps } = fakeDeps(
      [
        row({ itemId: "i1", jobId: "jkept", jobStatus: "done" }),
        row({ itemId: "i2", jobId: "jraced", jobStatus: "done" }),
      ],
      { racedIds: new Set(["i2"]) },
    );
    const summary = await retryUnplaceableCoverage(deps);
    assert(summary.reArmed === 1, "only the surviving item counts as re-armed");
    assert(summary.considered === 2, "both were considered");
  }

  // An active sweep's unplaceable item is re-armed just the same (no reactivation needed).
  {
    const { deps } = fakeDeps([row({ itemId: "i1", jobId: "jactive", jobStatus: "active" })]);
    const summary = await retryUnplaceableCoverage(deps);
    assert(summary.reArmed === 1, "the active sweep's item is re-armed");
  }

  // If the re-arm throws, it propagates so the lane catches and retries next hour.
  {
    const { deps } = fakeDeps([row({ jobStatus: "done" })], {
      deps: {
        reArm: async () => {
          throw new Error("re-arm write failed");
        },
      },
    });
    let threw = false;
    try {
      await retryUnplaceableCoverage(deps);
    } catch {
      threw = true;
    }
    assert(threw, "a re-arm failure propagates to the lane");
  }

  // Nothing retryable: no write attempted.
  {
    let wrote = false;
    const { deps } = fakeDeps([], {
      deps: {
        reArm: async (ids) => {
          wrote = true;
          return ids.length;
        },
      },
    });
    const summary = await retryUnplaceableCoverage(deps);
    assert(summary.reArmed === 0 && summary.considered === 0, "nothing re-armed");
    assert(!wrote, "no write is attempted when there is nothing to retry");
  }

  // Only cancelled rows: still no write (the live set is empty), but they are counted.
  {
    let wrote = false;
    const { deps } = fakeDeps([row({ jobStatus: "cancelled" })], {
      deps: {
        reArm: async (ids) => {
          wrote = true;
          return ids.length;
        },
      },
    });
    const summary = await retryUnplaceableCoverage(deps);
    assert(summary.reArmed === 0, "a cancelled-only read re-arms nothing");
    assert(summary.considered === 1, "the cancelled row is still counted as considered");
    assert(!wrote, "no re-arm write when every row is cancelled");
  }
}

await run();
finish();
