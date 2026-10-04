// Seed generator for the 200-agent load test (#273 Increment 5). Pure (no DB),
// so the shape + faithfulness of the seed is unit-tested before we ever touch a
// branch DB. Faithful = attrs span all debt tiers so every XBC bucket gets a
// pool; realistic in-window busy_blocks density; deterministic for repeatable runs.
// Run: node --experimental-strip-types scripts/test-loadtest-generate.ts
import { DateTime } from "luxon";
import { generateSeed } from "./loadtest/generate.ts";
import { agentIdsFromPool } from "../src/lib/availability/pool.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { stubCalendarList } from "../src/lib/google/loadtest-stub.ts";
import { selectableCalendarIds } from "../src/lib/google/calendar-select.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// A Monday, so the four day horizon covers Mon to Thu and no weekday is skipped.
// Stated rather than assumed: the generator skips weekends now, so a window that
// straddled one would make every count below a function of the date.
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
// Not a fixed product any more, and the reason is the point. Blocks sit in each
// agent's OWN local day, so the same UTC instant is a different local date per
// zone: at 2026-06-22T00:00:00Z a Pacific agent is still on Sunday, and their four
// day window covers three working days where an Eastern agent's covers four. A
// fixed expectation would have to pick one zone and would then be asserting that
// every agent is in it, which is exactly the thing this replaced.
{
  const zoneByUser = new Map(seed.schedules.map((sc) => [sc.user_id, sc.timezone]));
  const countByUser = new Map<string, number>();
  for (const b of seed.busyBlocks) countByUser.set(b.user_id, (countByUser.get(b.user_id) ?? 0) + 1);
  let mismatched = 0;
  for (const u of seed.users) {
    const start = DateTime.fromMillis(NOW, { zone: zoneByUser.get(u.id)! }).startOf("day");
    let weekdays = 0;
    for (let d = 0; d < p.windowDays; d++) if (start.plus({ days: d }).weekday <= 5) weekdays++;
    if ((countByUser.get(u.id) ?? 0) !== weekdays * p.blocksPerAgentPerDay) mismatched++;
  }
  assert(
    mismatched === 0,
    `every agent gets blocksPerAgentPerDay on each WORKING day of their own local window; ` +
      `${mismatched} agents did not`,
  );
  assert(seed.busyBlocks.length > 200 * 12 * 2, `and the seed is still dense; got ${seed.busyBlocks.length}`);
}

{
  // The other direction, and it needs its own anchor (L159). At midnight UTC every
  // US zone is still on the previous day, so they agree by accident and a seed that
  // ignored zones entirely would satisfy the per agent expectation above. At 06:00Z
  // on a Monday, Eastern is on Monday and Pacific is still on Sunday, so their four
  // day windows cover four working days and three. Only a day aligned seed can
  // produce that.
  const split = generateSeed({ ...p, nowMs: Date.parse("2026-06-22T06:00:00Z") });
  const zoneByUser = new Map(split.schedules.map((sc) => [sc.user_id, sc.timezone]));
  const countByZone = new Map<string, Set<number>>();
  const countByUser = new Map<string, number>();
  for (const b of split.busyBlocks) countByUser.set(b.user_id, (countByUser.get(b.user_id) ?? 0) + 1);
  for (const [user, n] of countByUser) {
    const zone = zoneByUser.get(user)!;
    const set = countByZone.get(zone) ?? new Set<number>();
    set.add(n);
    countByZone.set(zone, set);
  }
  const distinct = new Set([...countByUser.values()]);
  assert(
    distinct.size > 1,
    `at an anchor where the zones are on different local days, their block counts differ; ` +
      `got ${[...distinct].join(", ")}`,
  );
  assert(
    (countByZone.get("America/New_York")?.values().next().value ?? 0) >
      (countByZone.get("America/Los_Angeles")?.values().next().value ?? 0),
    "and it is the zone still on Sunday that gets fewer, which is the alignment working",
  );
}

// Faithful to prod (#273 calibration): debt_team is CUMULATIVE (an agent on a
// tier also carries the ones below), which is what makes low-tier buckets large
// and concentrates recompute cost there. A single-tier-each seed would understate
// that load and risk a false pass.
const debtArrays = seed.users.map(
  (u) => (u.attributes.debt_team as string[] | undefined) ?? [],
);
const allTiers = new Set(debtArrays.flat());
assert(
  ["low", "medium", "high", "very_high", "ultra_high"].every((t) => allTiers.has(t)),
  "debt-team values across agents cover all five tiers",
);
assert(
  debtArrays.some((a) => a.length >= 3),
  "some agents carry cumulative multi-tier debt arrays (like prod)",
);
const lowCount = debtArrays.filter((a) => a.includes("low")).length;
const ultraCount = debtArrays.filter((a) => a.includes("ultra_high")).length;
assert(
  lowCount > ultraCount,
  "low tier appears in far more agents than ultra_high (the cumulative, lopsided prod shape)",
);
// Measured 2026-09-11: production has NO agent without a debt tier. The seed used
// to generate 12 percent of them from a June distribution, which described a
// roster that no longer exists.
const unrouted = debtArrays.filter((a) => a.length === 0).length;
assert(unrouted === 0, `every seeded agent carries a debt tier, as production does; got ${unrouted}`);

// The Beyond backend is the one that matters most, and it is not a detail of the
// distribution: production holds TWO Beyond agents out of ninety, which is what
// makes every `x2x` bucket resolve to a pool of exactly ONE and gives the burst its
// control (#2243). The old seed gave Beyond 60 percent of the roster, so those
// pools were sixty deep and the control could never have fired.
const backendArrays = seed.users.map(
  (u) => (u.attributes.backend_service as string[] | undefined) ?? [],
);
const beyondAgents = backendArrays.filter((a) => a.includes("beyond")).length;
assert(
  beyondAgents === 2,
  `exactly two Beyond agents at 200, as production has at 90; got ${beyondAgents}`,
);
assert(
  backendArrays.filter((a) => a.includes("achieve")).length > 150,
  "and nearly the whole roster is Achieve, as production is",
);
// The real pool depths, computed through the BOOKER'S OWN predicate over the real
// bucket criteria rather than asserted about the profiles (L58). The seed took the
// shape as an input, so checking it against that same input would only prove the
// arithmetic; this asks the shipped `agentIdsFromPool` what the seeded roster
// actually resolves to, which is the number the run will meet.
{
  const orgAgents = seed.users.map((u) => ({ id: u.id, attributes: u.attributes }));
  const depth = (code: string) =>
    agentIdsFromPool(orgAgents, new Set<string>(), bucketSpecForXbc(code)?.criteria ?? {}).length;

  // Every x2x code demands the Beyond backend, and two agents in the whole roster
  // carry it, so each of those pools is exactly one deep. That is the burst's
  // positive control, and it is the thing the old June distribution destroyed.
  for (const code of ["120", "122", "222", "322", "422", "522"]) {
    eq(depth(code), 1, `the ${code} pool holds exactly one agent, so the burst has its control`);
  }
  // And the ordinary pools are deep and lopsided, tier by tier, as production is.
  assert(depth("112") > 100, `the Low pool is large at 200 agents; got ${depth("112")}`);
  assert(
    depth("112") > depth("212") && depth("212") > depth("312") && depth("312") > depth("412"),
    "and the tiers thin out going up, as the cumulative shape makes them",
  );
  assert(depth("512") >= 1, "the top tier still has somebody in it");
  // No bucket is left with nobody: an unstaffed pool would make every booking on it
  // a refusal, and the run would be measuring a dead bucket.
  const empty = allXbcCodes().filter((c) => depth(c) === 0);
  eq(empty.length, 0, `no seeded bucket routes to nobody; ${empty.slice(0, 5).join(",")}`);
}

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

// Busy blocks fall inside the recompute horizon, with sane intervals. The window is
// widened by a day at each end because the blocks are placed in each agent's own
// LOCAL day now: a Pacific agent's Monday 09:00 is Monday 16:00 UTC, and an agent
// east of UTC would start before the UTC day does.
const winStart = NOW - DAY;
const winEnd = NOW + (p.windowDays + 1) * DAY;
assert(
  seed.busyBlocks.every((b) => {
    const s = Date.parse(b.starts_at);
    const e = Date.parse(b.ends_at);
    return s >= winStart && s < winEnd && e > s;
  }),
  "busy_blocks are within the horizon (allowing for local days) and end after they start",
);

// The point of day alignment (#2243): a block must fall inside its OWN agent's
// working day. A fixed UTC offset put a Pacific agent's meetings at 02:00 local,
// where nothing could ever have booked over them, so the seed understated
// contention in exactly the zones the booking run is meant to press.
{
  const zoneByUser = new Map(seed.schedules.map((sc) => [sc.user_id, sc.timezone]));
  const outside = seed.busyBlocks.filter((b) => {
    const zone = zoneByUser.get(b.user_id)!;
    const local = DateTime.fromISO(b.starts_at, { zone });
    const min = local.hour * 60 + local.minute;
    return local.weekday > 5 || min < 540 || min >= 1020;
  });
  assert(
    outside.length === 0,
    `every busy block sits inside its own agent's local Mon-Fri 09:00-17:00; ${outside.length} did not`,
  );
  // The other direction (L159): the agents really are in different zones, so the
  // assertion above is about alignment rather than about one zone trivially
  // agreeing with UTC.
  const zones = new Set(seed.schedules.map((sc) => sc.timezone));
  assert(zones.size >= 4, `the seeded roster spans several zones; got ${zones.size}`);
  // And the UTC hour of a 09:00 local block really does differ between agents,
  // which is the fact a UTC anchored seed could not produce.
  const utcHours = new Set(
    seed.schedules.slice(0, 40).map((sc) => {
      const first = seed.busyBlocks.find((b) => b.user_id === sc.user_id)!;
      return DateTime.fromISO(first.starts_at, { zone: "utc" }).hour;
    }),
  );
  assert(utcHours.size >= 3, `the same local hour lands at different UTC hours; got ${utcHours.size}`);
}
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

// --- the seeded calendar ids are the ones the stub lists (#3103) ----------------
// The seed stored every primary calendar as the literal "primary" while the stub's
// calendar list (since #2380, matching Google) names it by the agent's EMAIL. The
// watch lane's reconcile compares the two, judges "primary" gone, and deletes the
// row and its seeded busy blocks, re-inserting an unhydrated one. Run 37164364760's
// preflight met exactly that: 88 of 90 calendars recreated mid warm up. So the ids
// are tied here to the stub's own answer, through the same selection the reconcile
// uses, rather than to a literal either side could change.
{
  const byUser = new Map<string, string[]>();
  for (const c of seed.agentCalendars) byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c.calendar_id]);
  let mismatched = 0;
  let strayBlocks = 0;
  for (const u of seed.users) {
    const listed = selectableCalendarIds(stubCalendarList(u.email));
    const seeded = byUser.get(u.id) ?? [];
    if (JSON.stringify([...seeded].sort()) !== JSON.stringify([...listed].sort())) mismatched++;
  }
  for (const b of seed.busyBlocks) {
    if (!(byUser.get(b.user_id) ?? []).includes(b.calendar_id)) strayBlocks++;
  }
  eq(mismatched, 0, "every agent's seeded calendar ids are exactly what the stub's calendar list selects for them");
  eq(strayBlocks, 0, "every seeded busy block belongs to one of its agent's seeded calendars");
  assert(!seed.agentCalendars.some((c) => c.calendar_id === "primary"), "no calendar is seeded under the literal alias \"primary\"");

  // A second calendar per agent is something the stub never lists, so the
  // reconcile would delete it on the first watch tick. Refused by name.
  let refused = "";
  try {
    generateSeed({ ...p, calendarsPerAgent: 2 });
  } catch (err) {
    refused = String((err as Error).message);
  }
  assert(/calendarsPerAgent/.test(refused) && /stub/.test(refused), `more than one calendar per agent is refused, naming why (${refused.slice(0, 80)})`);
}

finish();
