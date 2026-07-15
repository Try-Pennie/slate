import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
  watchAgentsForTick,
  agentsWithChanges,
  mapWithConcurrency,
  MAX_ONBOARDS_PER_TICK,
  MAX_AGENTS_PER_SYNC_TICK,
  MAX_TOUCHED_AGENTS,
  SYNC_CONCURRENCY,
  type SyncAgent,
} from "../src/lib/google/sync-pace.ts";
import { assert, finish } from "./lib/harness.ts";

// withinBudget
assert(withinBudget(100, 200) === true, "within budget when now < deadline");
assert(withinBudget(200, 200) === false, "at deadline is out of budget");
assert(withinBudget(250, 200) === false, "past deadline is out of budget");
assert(withinBudget(999, null) === true, "null deadline always has budget");

// cap is a small positive number
assert(
  MAX_ONBOARDS_PER_TICK > 0 && MAX_ONBOARDS_PER_TICK <= 25,
  "onboard cap is a small positive number",
);

// Per-tick agent cap (#273 Inc 5): bounds total subrequests per invocation so
// the sync lane drains the roster across ticks instead of all-at-once at 200.
assert(
  MAX_AGENTS_PER_SYNC_TICK > 0 && MAX_AGENTS_PER_SYNC_TICK < 200,
  "per-tick agent cap is positive and below the 200-agent target (so it drains across ticks)",
);
// orderAgentsForTick + a slice to the cap = least-recently-synced processed
// first, the rest deferred to next tick (rotation guarantees coverage).
{
  const many: SyncAgent[] = Array.from({ length: 150 }, (_, i) => ({
    userId: `u${i}`,
    hasCalendars: true,
    lastSyncedMs: i, // ascending => already in rotation order
  }));
  const thisTick = orderAgentsForTick(many).slice(0, MAX_AGENTS_PER_SYNC_TICK);
  assert(thisTick.length === MAX_AGENTS_PER_SYNC_TICK, "a tick processes at most the cap");
  assert(thisTick[0].userId === "u0", "oldest-synced agent is processed first (rotation)");
}

// orderAgentsForTick: never-synced first, then oldest-synced first, stable
const agents: SyncAgent[] = [
  { userId: "synced-old", hasCalendars: true, lastSyncedMs: 1000 },
  { userId: "never-a", hasCalendars: false, lastSyncedMs: null },
  { userId: "synced-new", hasCalendars: true, lastSyncedMs: 5000 },
  { userId: "never-b", hasCalendars: false, lastSyncedMs: null },
];
const order = orderAgentsForTick(agents).map((a) => a.userId);
assert(order[0] === "never-a" && order[1] === "never-b", "never-synced agents first, stable order");
assert(order[2] === "synced-old" && order[3] === "synced-new", "then oldest-synced first (rotation)");
assert(agents[0].userId === "synced-old", "orderAgentsForTick does not mutate input");

// shouldOnboard: only un-onboarded agents, only under the cap
const newAgent: SyncAgent = { userId: "n", hasCalendars: false, lastSyncedMs: null };
const oldAgent: SyncAgent = { userId: "o", hasCalendars: true, lastSyncedMs: 1 };
assert(shouldOnboard(newAgent, 0, 3) === true, "onboard a new agent under the cap");
assert(shouldOnboard(newAgent, 3, 3) === false, "do not onboard once the cap is reached");
assert(shouldOnboard(oldAgent, 0, 3) === false, "never 'onboard' an already-onboarded agent");

// watchAgentsForTick (#302): the watch lane runs concurrently, so the onboarding
// cap can't be a running counter inside the loop — pre-select here instead.
// All already-onboarded agents + at most `cap` brand-new, order preserved.
{
  const mixed: SyncAgent[] = [
    { userId: "new1", hasCalendars: false, lastSyncedMs: null },
    { userId: "old1", hasCalendars: true, lastSyncedMs: 1 },
    { userId: "new2", hasCalendars: false, lastSyncedMs: null },
    { userId: "old2", hasCalendars: true, lastSyncedMs: 2 },
    { userId: "new3", hasCalendars: false, lastSyncedMs: null },
  ];
  const sel = watchAgentsForTick(mixed, 2).map((a) => a.userId);
  assert(
    JSON.stringify(sel) === JSON.stringify(["new1", "old1", "new2", "old2"]),
    `all onboarded + first 2 new, order preserved, new3 deferred; got ${JSON.stringify(sel)}`,
  );
  assert(!sel.includes("new3"), "brand-new agents beyond the onboard cap are deferred to next tick");
}
assert(
  watchAgentsForTick(
    [{ userId: "o", hasCalendars: true, lastSyncedMs: 1 }],
    0,
  ).length === 1,
  "already-onboarded agents are always included (onboard cap only gates new ones)",
);

// agentsWithChanges (#296): after a sync tick, which agents actually had a
// calendar change (synced > 0) — those whose buckets the backstop should
// refresh now (capped, so a burst can't blow the subrequest budget).
{
  const results = [
    { userId: "a", synced: 0 },
    { userId: "b", synced: 3 },
    { userId: "c" }, // undefined synced (errored) -> not a change
    { userId: "d", synced: 1 },
  ];
  assert(
    JSON.stringify(agentsWithChanges(results, 10)) === JSON.stringify(["b", "d"]),
    "only agents whose sync returned changes (synced > 0)",
  );
  assert(agentsWithChanges(results, 1).length === 1, "capped to the limit");
  assert(MAX_TOUCHED_AGENTS > 0, "touched-agent cap is a positive bound");
}

// SYNC_CONCURRENCY: a small positive cap, comfortably under the Worker
// subrequest ceiling even when every agent fans out several Google/DB calls.
assert(SYNC_CONCURRENCY > 1 && SYNC_CONCURRENCY <= 20, "sync concurrency is a small positive cap");

// mapWithConcurrency: processes all items when unbounded, index-aligned results.
{
  const { results, processed, truncated } = await mapWithConcurrency(
    ["a", "b", "c"],
    2,
    async (x) => x.toUpperCase(),
  );
  assert(
    JSON.stringify(results) === JSON.stringify(["A", "B", "C"]),
    "mapWithConcurrency returns results in item order",
  );
  assert(processed === 3 && truncated === false, "processes every item when within budget");
}

// mapWithConcurrency: never runs more than `cap` workers at once.
{
  let inFlight = 0;
  let maxInFlight = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    await Promise.resolve();
    inFlight--;
    return x;
  });
  assert(maxInFlight === 2, "honors the concurrency cap (never more than 2 in flight)");
}

// mapWithConcurrency: stops STARTING new items past the deadline (truncates).
// cap=1 keeps the injected clock deterministic (one worker, sequential now()).
{
  let t = 0;
  const { processed, truncated } = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    1,
    async (x) => x,
    { deadlineMs: 25, now: () => (t += 10) - 10 }, // 0,10,20,30,... at each check
  );
  assert(processed === 3 && truncated === true, "stops starting new items once the deadline passes");
}

// mapWithConcurrency: empty input is a no-op, not truncated.
{
  const { processed, truncated } = await mapWithConcurrency([], 4, async (x) => x);
  assert(processed === 0 && truncated === false, "empty input processes nothing and is not truncated");
}

finish();
