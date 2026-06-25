// Pure builder for the dedicated smoke-test agent + isolated buckets (#396).
// Unit-tests the row shapes before the I/O seed script (seed-smoke-test.ts)
// ever writes to a real DB: the agent must be bookable/active, the buckets must
// be empty-criteria (so the lone member always matches) and round-robin, and
// every bucket must carry the agent as a member. Deterministic ids make the
// seed idempotent (upsert-on-id) so re-running never duplicates rows.
// Run: node --experimental-strip-types scripts/test-smoke-seed.ts
import { buildSmokeSeed } from "./smoke-seed.ts";

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error("FAIL:", m);
    failures++;
  } else console.log("ok:", m);
};

const params = {
  orgId: "org-smoke",
  eventTypeId: "evt-smoke",
  agentEmail: "smoketest@trypennie.com",
  bucketCodes: ["SMOKE", "SMOKE2"],
};
const seed = buildSmokeSeed(params);

// --- Agent ---
assert(seed.user.email === "smoketest@trypennie.com", "agent email is the smoketest mailbox");
assert(seed.user.role === "agent", "agent row has role 'agent'");
assert(seed.user.org_id === "org-smoke", "agent is in the target org");
assert(seed.user.bookable === true, "agent is bookable (in the round-robin pool)");
assert(seed.user.deactivated_at === null, "agent is active (not deactivated)");
assert(
  Object.keys(seed.user.attributes).length === 0,
  "agent has no routing attributes (matches empty-criteria buckets)",
);
assert(seed.user.is_test === true, "agent is flagged is_test (hidden from UI, real leads can't book)");

// --- Schedule + rules (so the agent actually has open slots) ---
assert(seed.schedule.user_id === seed.user.id, "schedule belongs to the agent");
assert(seed.schedule.timezone === "America/New_York", "schedule defaults to America/New_York");
assert(seed.rules.length === 5, "five weekday availability rules (Mon-Fri)");
assert(
  seed.rules.every((r) => r.schedule_id === seed.schedule.id),
  "every rule references the agent's schedule",
);
assert(
  seed.rules.map((r) => r.weekday).join(",") === "1,2,3,4,5",
  "rules cover weekdays Mon(1)..Fri(5)",
);
assert(
  seed.rules.every((r) => r.start_minute === 540 && r.end_minute === 1020),
  "rules are 9:00-17:00 (minutes 540-1020), like default working hours",
);

// --- Buckets (isolated, empty-criteria, round-robin) ---
assert(seed.buckets.length === 2, "one bucket per requested code");
assert(
  seed.buckets.map((b) => b.code).join(",") === "SMOKE,SMOKE2",
  "buckets carry the requested codes",
);
assert(
  seed.buckets.every((b) => Object.keys(b.criteria).length === 0),
  "buckets have EMPTY criteria so the lone member always matches",
);
assert(
  seed.buckets.every((b) => b.assignment === "round_robin"),
  "buckets are round-robin",
);
assert(
  seed.buckets.every((b) => b.event_type_id === "evt-smoke" && b.org_id === "org-smoke"),
  "buckets reference the org's event type",
);
assert(
  seed.buckets.every((b) => b.is_test === true),
  "buckets are flagged is_test (hidden from public availability/book, unbookable by real leads)",
);

// --- Membership: the agent is the sole member of EVERY bucket ---
assert(seed.members.length === 2, "one membership row per bucket");
assert(
  seed.members.every((m) => m.user_id === seed.user.id),
  "every membership points at the smoke agent",
);
assert(
  ["SMOKE", "SMOKE2"].every((code) => seed.members.some((m) => m.bucketCode === code)),
  "the agent is a member of every bucket",
);

// --- Idempotency: deterministic ids so re-running upserts in place ---
const again = buildSmokeSeed(params);
assert(again.user.id === seed.user.id, "agent id is deterministic across runs");
assert(again.schedule.id === seed.schedule.id, "schedule id is deterministic across runs");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
