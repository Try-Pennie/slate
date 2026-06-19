import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
  mapWithConcurrency,
  MAX_ONBOARDS_PER_TICK,
  SYNC_CONCURRENCY,
  type SyncAgent,
} from "../src/lib/google/sync-pace.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

// withinBudget
ok(withinBudget(100, 200) === true, "within budget when now < deadline");
ok(withinBudget(200, 200) === false, "at deadline is out of budget");
ok(withinBudget(250, 200) === false, "past deadline is out of budget");
ok(withinBudget(999, null) === true, "null deadline always has budget");

// cap is a small positive number
ok(
  MAX_ONBOARDS_PER_TICK > 0 && MAX_ONBOARDS_PER_TICK <= 25,
  "onboard cap is a small positive number",
);

// orderAgentsForTick: never-synced first, then oldest-synced first, stable
const agents: SyncAgent[] = [
  { userId: "synced-old", hasCalendars: true, lastSyncedMs: 1000 },
  { userId: "never-a", hasCalendars: false, lastSyncedMs: null },
  { userId: "synced-new", hasCalendars: true, lastSyncedMs: 5000 },
  { userId: "never-b", hasCalendars: false, lastSyncedMs: null },
];
const order = orderAgentsForTick(agents).map((a) => a.userId);
ok(order[0] === "never-a" && order[1] === "never-b", "never-synced agents first, stable order");
ok(order[2] === "synced-old" && order[3] === "synced-new", "then oldest-synced first (rotation)");
ok(agents[0].userId === "synced-old", "orderAgentsForTick does not mutate input");

// shouldOnboard: only un-onboarded agents, only under the cap
const newAgent: SyncAgent = { userId: "n", hasCalendars: false, lastSyncedMs: null };
const oldAgent: SyncAgent = { userId: "o", hasCalendars: true, lastSyncedMs: 1 };
ok(shouldOnboard(newAgent, 0, 3) === true, "onboard a new agent under the cap");
ok(shouldOnboard(newAgent, 3, 3) === false, "do not onboard once the cap is reached");
ok(shouldOnboard(oldAgent, 0, 3) === false, "never 'onboard' an already-onboarded agent");

// SYNC_CONCURRENCY: a small positive cap, comfortably under the Worker
// subrequest ceiling even when every agent fans out several Google/DB calls.
ok(SYNC_CONCURRENCY > 1 && SYNC_CONCURRENCY <= 20, "sync concurrency is a small positive cap");

// mapWithConcurrency: processes all items when unbounded, index-aligned results.
{
  const { results, processed, truncated } = await mapWithConcurrency(
    ["a", "b", "c"],
    2,
    async (x) => x.toUpperCase(),
  );
  ok(
    JSON.stringify(results) === JSON.stringify(["A", "B", "C"]),
    "mapWithConcurrency returns results in item order",
  );
  ok(processed === 3 && truncated === false, "processes every item when within budget");
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
  ok(maxInFlight === 2, "honors the concurrency cap (never more than 2 in flight)");
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
  ok(processed === 3 && truncated === true, "stops starting new items once the deadline passes");
}

// mapWithConcurrency: empty input is a no-op, not truncated.
{
  const { processed, truncated } = await mapWithConcurrency([], 4, async (x) => x);
  ok(processed === 0 && truncated === false, "empty input processes nothing and is not truncated");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
