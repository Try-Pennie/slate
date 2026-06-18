import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
  MAX_ONBOARDS_PER_TICK,
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

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
