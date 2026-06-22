// Seed generator for the 200-agent load test (#273 Increment 5). Pure (no DB),
// so the shape + faithfulness of the seed is unit-tested before we ever touch a
// branch DB. Faithful = attrs span all debt tiers so every XBC bucket gets a
// pool; realistic in-window busy_blocks density; deterministic for repeatable runs.
// Run: node --experimental-strip-types scripts/test-loadtest-generate.ts
import { generateSeed } from "./loadtest/generate.ts";

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error("FAIL:", m);
    failures++;
  } else console.log("ok:", m);
};

const NOW = Date.parse("2026-06-22T00:00:00Z");
const DAY = 86_400_000;
const p = {
  agentCount: 200,
  orgId: "org-loadtest",
  nowMs: NOW,
  windowDays: 4,
  blocksPerAgentPerDay: 12,
  calendarsPerAgent: 1,
};
const seed = generateSeed(p);

assert(seed.users.length === 200, "one user row per agent");
assert(seed.schedules.length === 200, "one availability_schedule per agent");
assert(seed.rules.length === 200 * 5, "five weekday availability rules per agent");
assert(seed.agentCalendars.length === 200, "one agent_calendar per agent (calendarsPerAgent=1)");
assert(
  seed.busyBlocks.length === 200 * 12 * 4,
  `~blocksPerAgentPerDay * windowDays * agents busy_blocks; got ${seed.busyBlocks.length}`,
);

// Attributes span all five debt tiers so buckets across every tier get a pool.
const tiers = new Set(seed.users.map((u) => u.attributes.debt_team));
assert(
  ["low", "medium", "high", "very_high", "ultra_high"].every((t) => tiers.has(t)),
  "agent attributes cover all five debt tiers",
);

// Every user is bookable + active (so the lanes actually process them).
assert(
  seed.users.every((u) => u.bookable === true && u.deactivated_at === null),
  "every seeded agent is bookable and active",
);

// Cross-references resolve: every schedule/calendar/block points at a real user.
const userIds = new Set(seed.users.map((u) => u.id));
assert(
  seed.schedules.every((s) => userIds.has(s.user_id)) &&
    seed.agentCalendars.every((c) => userIds.has(c.user_id)) &&
    seed.busyBlocks.every((b) => userIds.has(b.user_id)),
  "schedules, calendars, and busy_blocks all reference seeded users",
);
const scheduleIds = new Set(seed.schedules.map((s) => s.id));
assert(seed.rules.every((r) => scheduleIds.has(r.schedule_id)), "rules reference seeded schedules");

// Busy blocks fall inside the recompute horizon, with sane intervals.
const winStart = NOW;
const winEnd = NOW + p.windowDays * DAY;
assert(
  seed.busyBlocks.every((b) => {
    const s = Date.parse(b.starts_at);
    const e = Date.parse(b.ends_at);
    return s >= winStart && s < winEnd && e > s;
  }),
  "busy_blocks are within [now, now+windowDays] and end after they start",
);
assert(
  seed.busyBlocks.every((b) => b.source === "gcal" || b.source === "slate"),
  "busy_blocks carry a valid source",
);

// Determinism: same params -> identical output (repeatable load runs).
const again = generateSeed(p);
assert(
  again.users[0].id === seed.users[0].id && again.users[0].email === seed.users[0].email,
  "generation is deterministic for the same params",
);
assert(
  new Set(seed.users.map((u) => u.email)).size === 200,
  "agent emails are unique",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
