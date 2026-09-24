// Pure builder for the dedicated smoke-test agent + isolated buckets (#396).
// Unit-tests the row shapes before the I/O seed script (seed-smoke-test.ts)
// ever writes to a real DB: the agent must be bookable/active, the buckets must
// be empty-criteria (so the lone member always matches) and round-robin, and
// every bucket must carry the agent as a member. Deterministic ids make the
// seed idempotent (upsert-on-id) so re-running never duplicates rows.
// Run: node --experimental-strip-types scripts/test-smoke-seed.ts
import {
  buildSmokeSeed,
  PUBLIC_TEST_DAILY_CAP,
  PUBLIC_TEST_EVENT_TYPE_NAME,
} from "./smoke-seed.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { SEED_START_MINUTE, SEED_END_MINUTE } from "../src/lib/schedule-core.ts";
import {
  HIDDEN_TEST_BUCKET_CODES,
  PUBLIC_TEST_BUCKET_CODES,
} from "../src/lib/embed/public-test-bucket.ts";

/** The org's own event type, which the public test bucket's is modelled on. */
const template = {
  description: "Twenty minutes with a senior advisor.",
  regal_type: "call",
  duration_min: 20,
  buffer_before_min: 0,
  buffer_after_min: 5,
  min_notice_min: 120,
  slot_interval_min: 10,
};

const params = {
  orgId: "org-smoke",
  eventTypeId: "evt-smoke",
  eventTypeTemplate: template,
  agentEmail: "smoketest@trypennie.com",
  bucketCodes: [...HIDDEN_TEST_BUCKET_CODES],
  publicBucketCodes: [...PUBLIC_TEST_BUCKET_CODES],
  reassignTargetEmail: "smoketest2@trypennie.com",
};
const seed = buildSmokeSeed(params);
const PUBLIC = PUBLIC_TEST_BUCKET_CODES[0];
const HIDDEN = [...HIDDEN_TEST_BUCKET_CODES];

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
  seed.rules.every(
    (r) => r.start_minute === SEED_START_MINUTE && r.end_minute === SEED_END_MINUTE,
  ),
  "rules run the shared seeded working day, so the canary exercises the day the real roster works",
);
assert(
  seed.rules.every((r) => r.start_minute === 480 && r.end_minute === 1020),
  "and that day is 08:00 to 17:00 (#1299), pinned here so a change to it is deliberate",
);
assert(
  seed.rules.every((r) => seed.schedules.some((s) => s.id === r.schedule_id)),
  "every rule references one of the seeded schedules",
);

// --- Buckets (isolated, empty-criteria, round-robin) ---
assert(seed.buckets.length === 3, "one bucket per requested code, hidden and public alike");
eq(
  seed.buckets.map((b) => b.code).join(","),
  [...HIDDEN, PUBLIC].join(","),
  "buckets carry the hidden codes and then the public one, each read from the shared constant",
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
  seed.buckets.filter((b) => HIDDEN.includes(b.code)).every((b) => b.event_type_id === "evt-smoke"),
  "the hidden buckets keep the org's event type",
);
assert(
  seed.buckets.every((b) => b.org_id === "org-smoke"),
  "every bucket is in the target org",
);

// --- The public test bucket's OWN event type (#2660) ---
// A partner can book it from any host page, so it carries a daily cap of its
// own: a flood of test bookings must not fill the smoke agent's horizon and
// starve the canary of free slots. Everything else is copied from the org's
// event type, so the test booker reads like the real one.
{
  const publicBucket = seed.buckets.find((b) => b.code === PUBLIC);
  assert(!!publicBucket, "the public test bucket is built");
  assert(publicBucket?.is_test === true, "and it is flagged is_test, which is what keeps it off Regal");
  eq(seed.eventTypes.length, 1, "one event type row is built, for the public test bucket");
  const et = seed.eventTypes[0]!;
  eq(publicBucket?.event_type_id, et.id, "the public test bucket points at its own event type");
  assert(et.id !== "evt-smoke", "which is not the org's event type");
  eq(et.name, PUBLIC_TEST_EVENT_TYPE_NAME, "its name says it is a test, so the invite title does too");
  assert(/\btest\b/i.test(et.name), "and the word test is in that name");
  eq(et.daily_cap, PUBLIC_TEST_DAILY_CAP, "it carries the public test cap");
  assert(PUBLIC_TEST_DAILY_CAP >= 1 && PUBLIC_TEST_DAILY_CAP <= 12, "the cap is a small number of calls a day");
  eq(et.duration_min, template.duration_min, "same duration as the org's event type");
  eq(et.min_notice_min, template.min_notice_min, "same notice");
  eq(et.slot_interval_min, template.slot_interval_min, "same slot interval");
  eq(et.buffer_before_min, template.buffer_before_min, "same buffer before");
  eq(et.buffer_after_min, template.buffer_after_min, "same buffer after");
  eq(et.description, template.description, "same description, so the booker's panel reads the same");
  eq(et.regal_type, template.regal_type, "same regal type");
  eq(et.org_id, "org-smoke", "in the target org");
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(et.id),
    "its id is a deterministic v4 shaped uuid, so a re-run upserts in place",
  );
}
assert(
  seed.buckets.every((b) => b.is_test === true),
  "buckets are flagged is_test (hidden from public availability/book, unbookable by real leads)",
);

// --- Membership: the primary agent is in EVERY bucket; the reassign target is
// a bookable fallback in the FIRST bucket (SMOKE) only (#464). ---
assert(
  seed.members.filter((m) => m.user_id === seed.user.id).length === 3,
  "primary agent is a member of all three buckets",
);
assert(
  [...HIDDEN, PUBLIC].every((code) =>
    seed.members.some((m) => m.bucketCode === code && m.user_id === seed.user.id),
  ),
  "the primary agent is a member of every bucket, the public one included",
);
assert(
  seed.members.filter((m) => m.bucketCode === PUBLIC).length === 1,
  "the public test bucket is served by the primary agent ONLY, so the canary's fallback agent is never a partner's advisor",
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
    "reassign target has five Mon-Fri rules on the seeded working day",
  );

  // It joins SMOKE (the first bucket) only — a bookable fallback there, but
  // SMOKE2 stays single-agent.
  const targetMemberships = seed.members.filter((m) => m.user_id === target.id);
  assert(
    targetMemberships.length === 1 && targetMemberships[0].bucketCode === HIDDEN[0],
    "reassign target is a member of the first hidden bucket only (a bookable fallback), not the second and not the public one",
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
assert(again.eventTypes[0]?.id === seed.eventTypes[0]?.id, "the public test event type id is deterministic across runs");

finish();
