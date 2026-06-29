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
  reassignTargetEmail: "smoketest2@trypennie.com",
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

// --- Schedules + rules (so each agent actually has open slots) ---
const primarySchedule = seed.schedules.find((s) => s.user_id === seed.user.id);
assert(!!primarySchedule, "the primary agent has a schedule");
assert(primarySchedule?.timezone === "America/New_York", "primary schedule defaults to America/New_York");
const primaryRules = seed.rules.filter((r) => r.schedule_id === primarySchedule?.id);
assert(primaryRules.length === 5, "primary agent has five weekday rules (Mon-Fri)");
assert(
  primaryRules.map((r) => r.weekday).sort().join(",") === "1,2,3,4,5",
  "primary rules cover weekdays Mon(1)..Fri(5)",
);
assert(
  seed.rules.every((r) => r.start_minute === 540 && r.end_minute === 1020),
  "rules are 9:00-17:00 (minutes 540-1020), like default working hours",
);
assert(
  seed.rules.every((r) => seed.schedules.some((s) => s.id === r.schedule_id)),
  "every rule references one of the seeded schedules",
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

// --- Membership: the primary agent is in EVERY bucket; the reassign target is
// a bookable fallback in the FIRST bucket (SMOKE) only (#464). ---
assert(
  seed.members.filter((m) => m.user_id === seed.user.id).length === 2,
  "primary agent is a member of both buckets",
);
assert(
  ["SMOKE", "SMOKE2"].every((code) =>
    seed.members.some((m) => m.bucketCode === code && m.user_id === seed.user.id),
  ),
  "the primary agent is a member of every bucket",
);

// --- Reassign target (#450) + SMOKE fallback agent (#464): a SECOND bookable
// test agent. It is the explicit target of the reassign scenario AND a bookable
// member of the FIRST bucket (SMOKE), so round-robin CAN pick it — giving SMOKE
// a real fallback for the reschedule-stickiness (#523) scenario. It must exist,
// be bookable + is_test, be distinct from the primary, have its own working
// hours, and join SMOKE but NOT SMOKE2 (keeping SMOKE2 single-agent). ---
const target = seed.reassignTarget;
assert(!!target, "a reassign-target agent is built when reassignTargetEmail is given");
if (target) {
  assert(target.email === "smoketest2@trypennie.com", "reassign target uses the second smoke mailbox");
  assert(target.role === "agent", "reassign target has role 'agent'");
  assert(target.org_id === "org-smoke", "reassign target is in the target org");
  assert(target.bookable === true, "reassign target is bookable (reassignBooking rejects non-bookable)");
  assert(target.deactivated_at === null, "reassign target is active");
  assert(target.is_test === true, "reassign target is flagged is_test (hidden from UI, real leads can't book)");
  assert(target.id !== seed.user.id, "reassign target is a DISTINCT agent (reassign no-ops onto the same agent)");

  // It now has its OWN schedule + working hours so round-robin can pick it.
  const targetSchedule = seed.schedules.find((s) => s.user_id === target.id);
  assert(!!targetSchedule, "reassign target has its own schedule (bookable as a SMOKE fallback)");
  assert(
    seed.rules.filter((r) => r.schedule_id === targetSchedule?.id).length === 5,
    "reassign target has five Mon-Fri rules (9:00-17:00)",
  );

  // It joins SMOKE (the first bucket) only — a bookable fallback there, but
  // SMOKE2 stays single-agent.
  const targetMemberships = seed.members.filter((m) => m.user_id === target.id);
  assert(
    targetMemberships.length === 1 && targetMemberships[0].bucketCode === "SMOKE",
    "reassign target is a member of SMOKE only (a bookable fallback), not SMOKE2",
  );
}

// No reassign target when the email is omitted: no target user, schedule, or
// membership — a single-agent seed (older posture stays valid).
const noTarget = buildSmokeSeed({ ...params, reassignTargetEmail: undefined });
assert(noTarget.reassignTarget === null, "no reassign target when reassignTargetEmail is omitted");
assert(noTarget.schedules.length === 1, "omitting the target seeds a single schedule");
assert(
  noTarget.members.every((m) => m.user_id === noTarget.user.id),
  "omitting the target leaves only the primary agent's memberships",
);

// --- Idempotency: deterministic ids so re-running upserts in place ---
const again = buildSmokeSeed(params);
assert(again.user.id === seed.user.id, "agent id is deterministic across runs");
assert(
  again.schedules.map((s) => s.id).sort().join(",") === seed.schedules.map((s) => s.id).sort().join(","),
  "schedule ids are deterministic across runs",
);
assert(again.reassignTarget?.id === seed.reassignTarget?.id, "reassign target id is deterministic across runs");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
