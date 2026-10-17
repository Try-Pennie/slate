// The load run's roster SHAPE (#2243), driven offline.
//
// Why it matters more than it looks: the seed's old distribution was measured on
// 2026-06-22 and gave the Beyond backend 60 percent of the roster. Production
// gives it two agents out of ninety, which is what makes every `x2x` bucket resolve
// to a pool of exactly ONE agent, and that one agent pool is the entire positive
// control for the burst (one 200, the rest SLOT_TAKEN). A seed staffing those
// pools sixty deep produces a run that cannot fail the control it was built for.
//
// Run: node --experimental-strip-types scripts/test-loadtest-roster-shape.ts
import {
  PRODUCTION_SHAPE,
  SCALED_200_SHAPE,
  rosterShapeFor,
  seededRosterVerdict,
  rosterLine,
  scaleShape,
  zoneForIndex,
  shapeFromRoster,
  type RosterShape,
} from "./loadtest/roster-shape.ts";
import { generateSeed } from "./loadtest/generate.ts";
import { poolDepthsFrom } from "./loadtest/pool-depth.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the baked shape is internally consistent --------------------------------

{
  const total = PRODUCTION_SHAPE.profiles.reduce((s, p) => s + p.agents, 0);
  eq(total, PRODUCTION_SHAPE.agents, "the profiles account for every measured agent");
  const zones = PRODUCTION_SHAPE.zones.reduce((s, z) => s + z.agents, 0);
  eq(zones, PRODUCTION_SHAPE.agents, "and so do the zones");
  assert(PRODUCTION_SHAPE.zones.length >= 5, "the roster spans several zones, as production does");
  assert(
    PRODUCTION_SHAPE.profiles.every((p) => p.debtTeam.length > 0),
    "every profile carries a debt tier; the old seed's unrouted agents no longer exist",
  );
  // The measured fact the burst rests on.
  const beyond = PRODUCTION_SHAPE.profiles.filter((p) => p.backendService.includes("beyond"));
  eq(beyond.length, 2, "two Beyond profiles");
  eq(
    beyond.reduce((s, p) => s + p.agents, 0),
    2,
    "holding two agents between them, which is what makes an x2x pool one deep",
  );
  assert(beyond.every((p) => p.pinned), "and both are pinned, so scaling cannot dilute them");
}

// --- scaling preserves the proportions and the control -----------------------

{
  for (const target of [90, 150, 200, 400]) {
    const scaled = scaleShape(PRODUCTION_SHAPE, target);
    eq(
      scaled.reduce((s, p) => s + p.agents, 0),
      target,
      `scaling to ${target} produces exactly that many agents`,
    );
    const beyond = scaled.filter((p) => p.backendService.includes("beyond"));
    eq(
      beyond.reduce((s, p) => s + p.agents, 0),
      2,
      `and still exactly two Beyond agents at ${target}, so an x2x pool stays one deep`,
    );
    assert(
      scaled.every((p) => p.agents > 0),
      `no profile is scaled out of existence at ${target}`,
    );
  }
}

{
  // The proportions really are preserved, not merely the total. Low-only is 31 of
  // 90 in production, so it must be about 69 of 200 rather than an even share.
  const scaled = scaleShape(PRODUCTION_SHAPE, 200);
  const lowOnly = scaled.find(
    (p) => p.debtTeam.join() === "low" && p.backendService.join() === "achieve",
  )!;
  assert(
    lowOnly.agents >= 66 && lowOnly.agents <= 72,
    `the largest profile keeps its share (31/90 of 200 is about 69, got ${lowOnly.agents})`,
  );
  // The other direction (L159): an even spread would give it 20, so the assertion
  // above is about the proportion rather than about any large number.
  assert(lowOnly.agents > 200 / scaled.length, "which is well above an even spread");
}

{
  // A roster too small to hold the control is REFUSED, never quietly reshaped. A
  // seed that dropped the pinned profiles would look right and could not run the
  // burst.
  let threw = false;
  try {
    scaleShape(PRODUCTION_SHAPE, 3);
  } catch {
    threw = true;
  }
  assert(threw, "a roster too small for the pinned profiles is refused");
  let zeroThrew = false;
  try {
    scaleShape(PRODUCTION_SHAPE, 0);
  } catch {
    zeroThrew = true;
  }
  assert(zeroThrew, "and so is a roster of nobody");
}

// --- zones are interleaved, not blocked --------------------------------------

{
  const zones = new Set<string>();
  for (let i = 0; i < 20; i++) zones.add(zoneForIndex(PRODUCTION_SHAPE, i, 200));
  assert(
    zones.size >= 4,
    `the first 20 agents span several zones (got ${zones.size}); blocked assignment would make ` +
      "every early agent Eastern and a small run would never exercise a working day that is a " +
      "different span of UTC per agent",
  );
  // Deterministic, so two runs of the seed produce the same roster.
  eq(
    zoneForIndex(PRODUCTION_SHAPE, 7, 200),
    zoneForIndex(PRODUCTION_SHAPE, 7, 200),
    "the same index always gets the same zone",
  );
  // And it is a zone the shape actually names, never an invented one.
  const named = new Set(PRODUCTION_SHAPE.zones.map((z) => z.timezone));
  for (let i = 0; i < 50; i++) {
    assert(named.has(zoneForIndex(PRODUCTION_SHAPE, i, 200)), `agent ${i} gets a measured zone`);
  }
}

{
  // A shape with no zones at all still answers, rather than producing an agent with
  // no timezone that every downstream read would treat as a fault.
  const bare: RosterShape = { ...PRODUCTION_SHAPE, zones: [] };
  assert(zoneForIndex(bare, 0, 10).length > 0, "a shape with no zones still names one");
}

// --- building a shape out of a live roster reading ---------------------------

const agent = (debt: string[], backend: string[], timezone = "America/New_York") => ({
  id: `u-${Math.random()}`,
  attributes: { debt_team: debt, backend_service: backend },
  timezone,
});

{
  const built = shapeFromRoster({
    measuredAt: "2026-09-11",
    poolDepths: [
      { code: "112", depth: 3 },
      { code: "122", depth: 1 },
    ],
    agents: [
      agent(["low"], ["achieve"]),
      agent(["low"], ["achieve"], "America/Phoenix"),
      agent(["low"], ["achieve"], "America/Phoenix"),
      agent(["low"], ["beyond"]),
    ],
  });
  assert(built.ok, "a real roster builds a shape");
  if (!built.ok) throw new Error("unreachable");
  eq(built.shape.agents, 4, "every agent read is counted");
  eq(built.shape.profiles.length, 2, "agents with the same attributes are one profile");
  eq(built.shape.profiles[0]!.agents, 3, "the largest profile comes first");
  eq(built.shape.zones[0]!.timezone, "America/New_York", "zones are counted and ordered");
  // The pinning rule, which is the whole reason this is not a one line aggregation:
  // the profile holding the only agent a one deep pool can draw on must survive
  // scaling, or the burst's control is diluted away.
  const beyond = built.shape.profiles.find((p) => p.backendService.includes("beyond"))!;
  assert(beyond.pinned === true, "the profile staffing the thinnest pool is pinned");
  const achieve = built.shape.profiles.find((p) => p.backendService.join() === "achieve")!;
  assert(achieve.pinned !== true, "and a profile with plenty of agents is not");
  // Which backend is scarce is READ from the depths, not assumed to be Beyond, so
  // the rule keeps working when the routing matrix changes.
  const scaled = scaleShape(built.shape, 100);
  eq(
    scaled.find((p) => p.backendService.includes("beyond"))!.agents,
    1,
    "so scaling to 100 agents leaves the thin pool exactly one deep",
  );
}

{
  // No thin pool, nothing to pin. A rule that pinned regardless would freeze a
  // profile's size for no reason and distort every scaled roster.
  const built = shapeFromRoster({
    measuredAt: "2026-09-11",
    poolDepths: [{ code: "112", depth: 9 }],
    agents: [agent(["low"], ["achieve"]), agent(["low"], ["beyond"]), agent(["low"], ["beyond"])],
  });
  assert(built.ok, "a roster with no thin pool still builds");
  if (!built.ok) throw new Error("unreachable");
  assert(built.shape.profiles.every((p) => p.pinned !== true), "and pins nothing");
}

{
  // Refused, never exported. A shape of nobody seeds a roster of nobody, and every
  // later run reports a dead routing matrix that nothing about the run caused (L98).
  const noAgents = shapeFromRoster({ measuredAt: "d", agents: [], poolDepths: [{ code: "1", depth: 1 }] });
  assert(!noAgents.ok, "an empty roster is refused");
  const noBuckets = shapeFromRoster({ measuredAt: "d", agents: [agent(["low"], ["achieve"])], poolDepths: [] });
  assert(!noBuckets.ok, "and so is a roster with no buckets to measure depth against");
  assert(
    !noAgents.ok && !noBuckets.ok && noAgents.why !== noBuckets.why,
    "each with its own reason, since they send different people to different places",
  );
}

{
  // An agent carrying no attributes at all, and one with no schedule, are read
  // without throwing: both are real states in a roster and neither is a shape fault.
  const built = shapeFromRoster({
    measuredAt: "d",
    poolDepths: [{ code: "112", depth: 1 }],
    agents: [
      { id: "a", attributes: null, timezone: null },
      { id: "b", attributes: {}, timezone: "America/Denver" },
    ],
  });
  assert(built.ok, "an agent with no attributes or no schedule does not break the export");
  if (!built.ok) throw new Error("unreachable");
  eq(built.shape.agents, 2, "both are still counted as agents");
  eq(built.shape.zones.length, 1, "but only the one with a schedule is counted in a zone");
}

// --- the 200 advisor roster is checked in, and it IS production scaled (#3829) ---

/** What the seed would produce for a shape, read through the booker's own pool predicate. */
function seededDepths(shape: RosterShape): Map<string, number> {
  const seed = generateSeed({
    agentCount: shape.agents,
    orgId: "o",
    nowMs: Date.UTC(2026, 9, 14, 12),
    windowDays: 1,
    blocksPerAgentPerDay: 1,
    shape,
  });
  const buckets = allXbcCodes().map((code) => ({
    id: code,
    code,
    criteria: bucketSpecForXbc(code)?.criteria ?? {},
  }));
  const depths = poolDepthsFrom({
    agents: seed.users.map((u) => ({ id: u.id, attributes: u.attributes })),
    buckets,
    members: [],
  });
  return new Map(depths.map((d) => [d.code, d.depth]));
}

{
  eq(SCALED_200_SHAPE.agents, 200, "the scaled roster is 200 advisors");
  eq(
    SCALED_200_SHAPE.profiles.reduce((s, p) => s + p.agents, 0),
    200,
    "its profiles account for every one of them",
  );
  eq(
    SCALED_200_SHAPE.zones.reduce((s, z) => s + z.agents, 0),
    200,
    "and so do its zones",
  );
  // The checked in numbers are what scaling production gives, not a hand made mix: a
  // literal that drifted from the scaling would name a roster the seed never builds.
  eq(
    JSON.stringify(SCALED_200_SHAPE.profiles),
    JSON.stringify(scaleShape(PRODUCTION_SHAPE, 200)),
    "the profiles are production's scaled to 200 by the seed's own scaling",
  );
  const zoneCounts = new Map<string, number>();
  for (let i = 0; i < 200; i++) {
    const z = zoneForIndex(SCALED_200_SHAPE, i, 200);
    zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
  }
  for (const z of SCALED_200_SHAPE.zones) {
    eq(zoneCounts.get(z.timezone), z.agents, `the seed puts ${z.agents} advisors in ${z.timezone}`);
  }
  // Production's zone proportions kept: Eastern 29 of 90 is about 64 of 200.
  const east = SCALED_200_SHAPE.zones.find((z) => z.timezone === "America/New_York")!;
  assert(east.agents >= 62 && east.agents <= 66, `Eastern keeps its share (got ${east.agents})`);

  // The depths it records are the ones the seed produces, through the same predicate
  // the burst setup measures with, and the Beyond pools stay ONE deep, the control.
  const seeded = seededDepths(SCALED_200_SHAPE);
  for (const d of SCALED_200_SHAPE.poolDepths) {
    eq(seeded.get(d.code), d.depth, `code ${d.code} seeds ${d.depth} deep at 200`);
  }
  for (const code of ["120", "220", "320", "420", "520"]) {
    eq(seeded.get(code), 1, `code ${code} is still one deep at 200 advisors`);
  }
  // And production's own recorded depths are what the seed produces at 90, so the
  // two shapes are produced by one generator rather than each by its own story.
  const at90 = seededDepths(PRODUCTION_SHAPE);
  for (const d of PRODUCTION_SHAPE.poolDepths) {
    eq(at90.get(d.code), d.depth, `code ${d.code} seeds ${d.depth} deep at 90`);
  }
}

{
  // Chosen by name, and anything else refused rather than falling back to 90: a run
  // that asked for 200 and seeded 90 would pass every bar about the wrong roster.
  assert(rosterShapeFor(undefined) === PRODUCTION_SHAPE, "no roster named is production's");
  assert(rosterShapeFor("") === PRODUCTION_SHAPE, "an empty one too");
  assert(rosterShapeFor("90") === PRODUCTION_SHAPE, "90 is production's");
  assert(rosterShapeFor("200") === SCALED_200_SHAPE, "200 is the scaled roster");
  let threw = false;
  try {
    rosterShapeFor("150");
  } catch {
    threw = true;
  }
  assert(threw, "a roster nobody checked in is refused");
}

{
  // The run names the roster it MEASURED (#3829): the burst setup counts the advisors
  // the branch holds and refuses a run whose count is not the roster it was asked for.
  const ok = seededRosterVerdict({ seeded: 200, named: "200" });
  assert(ok.ok && ok.advisors === 200, "200 seeded under a 200 run is that roster");
  const ninety = seededRosterVerdict({ seeded: 90, named: "" });
  assert(ninety.ok && ninety.advisors === 90, "90 seeded with no roster named is production's");
  const short = seededRosterVerdict({ seeded: 90, named: "200" });
  assert(!short.ok, "a 200 run on a branch seeded with 90 is refused");
  assert(!short.ok && /90/.test(short.why) && /200/.test(short.why), "naming both counts");
  const over = seededRosterVerdict({ seeded: 200, named: "90" });
  assert(!over.ok, "and so is a 90 run on a branch seeded with 200");
  const unknown = seededRosterVerdict({ seeded: 150, named: "150" });
  assert(!unknown.ok, "a roster nobody checked in is refused rather than thrown");
  const none = seededRosterVerdict({ seeded: 0, named: "90" });
  assert(!none.ok, "and a branch holding nobody is refused");
}

{
  // The report names the roster it measured and how hard it was driven, so a 200 run
  // is never read against a 90 one (#3829).
  eq(
    rosterLine("200", 9),
    "Roster: **200 advisors**, production's mix scaled from 90, driven by 9 steady drivers (#3829).",
    "a 200 run says so",
  );
  eq(
    rosterLine("90", 4),
    "Roster: **90 advisors**, production's, driven by 4 steady drivers (#3829).",
    "a 90 run says so",
  );
  eq(
    rosterLine(undefined, 4),
    "Roster: not counted (a hand run), driven by 4 steady drivers (#3829).",
    "and a hand run says it was not counted rather than claiming a roster",
  );
}

finish();
