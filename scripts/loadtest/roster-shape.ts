/**
 * The SHAPE of the live roster, so a load run is driven against production's real
 * distribution rather than an even spread (#2243).
 *
 * The old seed spread attributes by a distribution measured on 2026-06-22, and by
 * 2026-09-11 it was wrong in the way that matters most to this test: it gave the
 * Beyond backend 60 percent of the roster, where production gives it TWO agents
 * out of ninety. That is not a rounding difference. Every `x2x` bucket in
 * production resolves to a pool of exactly ONE agent, and a one agent pool is the
 * whole positive control for the burst (one 200 and the rest SLOT_TAKEN): a seed
 * that staffed those pools sixty deep could not produce it at all.
 *
 * Pure. `scripts/loadtest/export-roster-shape.ts` writes one of these out of
 * production read only, and `scripts/test-loadtest-roster-shape.ts` drives the
 * scaling offline.
 */

/** One attribute combination and how many agents hold it. */
export interface ProfileCount {
  /** `users.attributes.debt_team`, ascending. Empty means the agent has none. */
  debtTeam: string[];
  /** `users.attributes.backend_service`, ascending. Empty means none. */
  backendService: string[];
  agents: number;
  /**
   * Kept at EXACTLY this many agents however the roster is scaled.
   *
   * The two Beyond profiles are pinned, and that is the point of the field. Scaled
   * proportionally to 200 agents they become two and three, every `x2x` pool goes
   * two or three deep, and the burst's "exactly one 200" control quietly stops
   * being a control at all while every count still looks plausible (L1).
   */
  pinned?: boolean;
}

export interface RosterShape {
  /** When this was read out of production. A shape is only true of a day. */
  measuredAt: string;
  /** Bookable, live, non-test agents at the moment of measurement. */
  agents: number;
  profiles: ProfileCount[];
  /** Scheduling zone to the number of agents in it. */
  zones: { timezone: string; agents: number }[];
  /**
   * Pool depth per bucket code, as measured. Not an input to the seed: it is what
   * the seed's own output is CHECKED against, so a generator that drifts from the
   * shape is caught by comparing two independently produced numbers rather than by
   * trusting the generator to have applied its own input (L58).
   */
  poolDepths: { code: string; depth: number }[];
}

/**
 * Production, measured 2026-09-11.
 *
 * Baked in rather than required as a file, because the load run has to be
 * reproducible on a machine with no production credentials, and a run that could
 * only happen where somebody holds the secret key is a run nobody does. Point
 * `ROSTER_SHAPE_FILE` at a fresh export to use a newer one.
 *
 * Ninety bookable agents, every one of them in at least one bucket, and no agent
 * without a debt tier: the old generator's "12 percent unrouted" profile describes
 * a roster that no longer exists.
 */
export const PRODUCTION_SHAPE: RosterShape = {
  measuredAt: "2026-09-11",
  agents: 90,
  profiles: [
    { debtTeam: ["low"], backendService: ["achieve"], agents: 31 },
    { debtTeam: ["low", "medium"], backendService: ["achieve"], agents: 23 },
    { debtTeam: ["high", "low", "medium"], backendService: ["achieve"], agents: 16 },
    { debtTeam: ["high", "medium", "very_high"], backendService: ["achieve"], agents: 8 },
    { debtTeam: ["high", "low", "medium", "very_high"], backendService: ["achieve"], agents: 3 },
    { debtTeam: ["high", "medium", "ultra_high", "very_high"], backendService: ["achieve"], agents: 3 },
    { debtTeam: ["high", "ultra_high", "very_high"], backendService: ["achieve"], agents: 2 },
    { debtTeam: ["high", "medium"], backendService: ["achieve"], agents: 2 },
    // The two Beyond profiles, PINNED. Between them they are the only agents any
    // `x2x` bucket can reach, which is what makes every one of those pools exactly
    // one deep and gives the burst its control.
    {
      debtTeam: ["high", "medium", "ultra_high", "very_high"],
      backendService: ["achieve", "beyond"],
      agents: 1,
      pinned: true,
    },
    { debtTeam: ["low"], backendService: ["beyond"], agents: 1, pinned: true },
  ],
  zones: [
    { timezone: "America/New_York", agents: 29 },
    { timezone: "America/Phoenix", agents: 25 },
    { timezone: "America/Denver", agents: 16 },
    { timezone: "America/Los_Angeles", agents: 15 },
    { timezone: "America/Chicago", agents: 5 },
  ],
  poolDepths: [
    { code: "100", depth: 74 },
    { code: "110", depth: 74 },
    { code: "120", depth: 1 },
    { code: "130", depth: 73 },
    { code: "200", depth: 56 },
    { code: "220", depth: 1 },
    { code: "300", depth: 35 },
    { code: "320", depth: 1 },
    { code: "400", depth: 17 },
    { code: "420", depth: 1 },
    { code: "500", depth: 6 },
    { code: "520", depth: 1 },
  ],
};

/**
 * Production's roster scaled to 200 advisors, the top of the 100 to 200 Slate is
 * designed for (#3829).
 *
 * Checked in as numbers rather than computed at seed time, so the run names the
 * roster it measured and a reader can see it. Every number is what the seed's own
 * scaling makes of `PRODUCTION_SHAPE`, and `scripts/test-loadtest-roster-shape.ts`
 * fails the day they differ: the profiles by `scaleShape`, the zones by
 * `zoneForIndex`, and the depths by seeding it and reading every pool through the
 * booker's predicate. The two Beyond advisors stay pinned, so every `x2x` pool is
 * still exactly one deep and the bursts keep their control.
 *
 * `measuredAt` is production's date, because nothing here was measured on any other
 * day: this is that roster at a size it has not reached.
 */
export const SCALED_200_SHAPE: RosterShape = {
  measuredAt: "2026-09-11",
  agents: 200,
  profiles: [
    { debtTeam: ["low"], backendService: ["achieve"], agents: 70 },
    { debtTeam: ["low", "medium"], backendService: ["achieve"], agents: 52 },
    { debtTeam: ["high", "low", "medium"], backendService: ["achieve"], agents: 36 },
    { debtTeam: ["high", "medium", "very_high"], backendService: ["achieve"], agents: 18 },
    { debtTeam: ["high", "low", "medium", "very_high"], backendService: ["achieve"], agents: 7 },
    { debtTeam: ["high", "medium", "ultra_high", "very_high"], backendService: ["achieve"], agents: 7 },
    { debtTeam: ["high", "ultra_high", "very_high"], backendService: ["achieve"], agents: 4 },
    { debtTeam: ["high", "medium"], backendService: ["achieve"], agents: 4 },
    {
      debtTeam: ["high", "medium", "ultra_high", "very_high"],
      backendService: ["achieve", "beyond"],
      agents: 1,
      pinned: true,
    },
    { debtTeam: ["low"], backendService: ["beyond"], agents: 1, pinned: true },
  ],
  zones: [
    { timezone: "America/New_York", agents: 64 },
    { timezone: "America/Phoenix", agents: 56 },
    { timezone: "America/Denver", agents: 36 },
    { timezone: "America/Los_Angeles", agents: 33 },
    { timezone: "America/Chicago", agents: 11 },
  ],
  poolDepths: [
    { code: "100", depth: 166 },
    { code: "110", depth: 166 },
    { code: "120", depth: 1 },
    { code: "130", depth: 165 },
    { code: "200", depth: 125 },
    { code: "220", depth: 1 },
    { code: "300", depth: 77 },
    { code: "320", depth: 1 },
    { code: "400", depth: 37 },
    { code: "420", depth: 1 },
    { code: "500", depth: 12 },
    { code: "520", depth: 1 },
  ],
};

/** The rosters a run may name, by advisor count. A name not here is refused. */
export const ROSTERS = { "90": PRODUCTION_SHAPE, "200": SCALED_200_SHAPE } as const;
export type RosterName = keyof typeof ROSTERS;

/**
 * The shape a run named (`ROSTER`), production's when it named none. Anything else
 * THROWS rather than falling back, because a run that asked for 200 and seeded 90
 * would pass every bar about a roster nobody chose.
 */
export function rosterShapeFor(name: string | undefined): RosterShape {
  const key = (name ?? "").trim();
  if (key === "") return PRODUCTION_SHAPE;
  if (Object.hasOwn(ROSTERS, key)) return ROSTERS[key as RosterName];
  throw new Error(
    `ROSTER is ${JSON.stringify(name)}, and the rosters checked in are ${Object.keys(ROSTERS).join(" and ")}`,
  );
}

/**
 * Whether the advisors a branch holds are the roster a run named (#3829).
 *
 * The seed runs before the workflow and on another machine, so the workflow cannot
 * know what was seeded except by counting it. A run asked for 200 on a branch seeded
 * with 90 would pass every bar about the wrong roster and print 200 in its header,
 * so a mismatch is refused, naming both numbers.
 */
export function seededRosterVerdict(input: {
  seeded: number;
  named: string | undefined;
}): { ok: true; advisors: number; shape: RosterShape } | { ok: false; why: string } {
  let shape: RosterShape;
  try {
    shape = rosterShapeFor(input.named);
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }
  if (input.seeded !== shape.agents) {
    return {
      ok: false,
      why:
        `the branch holds ${input.seeded} bookable advisors and this run names the ${shape.agents} ` +
        `advisor roster; seed it with ROSTER=${shape.agents}, or dispatch with roster ${input.seeded}`,
    };
  }
  return { ok: true, advisors: input.seeded, shape };
}

/**
 * The report's roster line (#3829): how many advisors the burst setup COUNTED on the
 * branch and how many steady drivers that sized. A hand run passes no count, and says
 * so rather than claiming production's roster it never checked.
 */
export function rosterLine(advisors: string | undefined, steadyDrivers: number): string {
  const n = (advisors ?? "").trim();
  const driven = `driven by ${steadyDrivers} steady drivers (#3829).`;
  if (n === "") return `Roster: not counted (a hand run), ${driven}`;
  const which = n === String(PRODUCTION_SHAPE.agents) ? "production's" : `production's mix scaled from ${PRODUCTION_SHAPE.agents}`;
  return `Roster: **${n} advisors**, ${which}, ${driven}`;
}

/**
 * Scale a shape to a target headcount, preserving the proportions and NOT the
 * pinned profiles.
 *
 * Largest remainder rather than rounding each independently: rounding every
 * profile on its own leaves the total short or over by a handful, and the seed
 * would then produce a roster whose size is a function of the arithmetic rather
 * than of the number asked for.
 *
 * A scale DOWN that cannot fit the pinned profiles is refused rather than silently
 * dropping them, because the pinned ones are the control: losing them produces a
 * seed that looks right and cannot exercise the burst.
 */
export function scaleShape(shape: RosterShape, target: number): ProfileCount[] {
  if (target <= 0) throw new Error(`a roster of ${target} agents is not a roster`);
  const pinned = shape.profiles.filter((p) => p.pinned);
  const rest = shape.profiles.filter((p) => !p.pinned);
  const pinnedTotal = pinned.reduce((s, p) => s + p.agents, 0);
  if (target < pinnedTotal + rest.length) {
    throw new Error(
      `a roster of ${target} cannot hold the ${pinnedTotal} pinned agents and one of each of the ` +
        `${rest.length} other profiles; the pinned profiles are the burst's control and are not dropped`,
    );
  }
  const room = target - pinnedTotal;
  const restTotal = rest.reduce((s, p) => s + p.agents, 0);
  const exact = rest.map((p) => (p.agents / restTotal) * room);
  const floors = exact.map((n) => Math.floor(n));
  let left = room - floors.reduce((s, n) => s + n, 0);
  // Largest remainder, and ties broken by the bigger profile so the order is the
  // same on every machine: a seed whose roster depends on sort stability is not
  // reproducible.
  const order = exact
    .map((n, i) => ({ i, frac: n - Math.floor(n), size: rest[i]!.agents }))
    .sort((a, b) => b.frac - a.frac || b.size - a.size || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i]!++;
    left--;
  }
  return [
    ...rest.map((p, i) => ({ ...p, agents: floors[i]! })),
    ...pinned.map((p) => ({ ...p })),
  ];
}

/**
 * The zone for each agent index, in the shape's proportions.
 *
 * Interleaved rather than blocked, so any prefix of the roster carries every zone.
 * A blocked assignment makes "the first 20 agents" all Eastern, and the very thing
 * the day aligned busy blocks exist to exercise (a working day that is a different
 * span of UTC per agent) would be absent from every small run.
 */
export function zoneForIndex(shape: RosterShape, index: number, target: number): string {
  if (shape.zones.length === 0) return "America/New_York";
  const total = shape.zones.reduce((s, z) => s + z.agents, 0);
  const counts = shape.zones.map((z) => Math.max(1, Math.round((z.agents / total) * target)));
  const cycle: string[] = [];
  // One pass per zone per round, so the sequence repeats every `sum(counts)`
  // agents with each zone appearing in proportion.
  const remaining = [...counts];
  while (remaining.some((n) => n > 0)) {
    for (let z = 0; z < remaining.length; z++) {
      if (remaining[z]! > 0) {
        cycle.push(shape.zones[z]!.timezone);
        remaining[z]!--;
      }
    }
  }
  return cycle[index % cycle.length]!;
}

/** One live agent as the exporter reads them. */
export interface MeasuredAgent {
  id: string;
  attributes: Record<string, unknown> | null;
  timezone: string | null;
}

/**
 * Build a shape from a live roster reading.
 *
 * Pure over what was read, so `scripts/test-loadtest-roster-shape.ts` drives the
 * refusal and the pinning with no database. The two decisions worth having a test
 * for:
 *
 * - an EMPTY roster or an empty bucket list is REFUSED, never exported. A shape of
 *   nobody seeds a roster of nobody, and every later run reports a dead routing
 *   matrix that nothing about the run caused (L98);
 * - a profile is PINNED when it holds the only agents that can staff a pool, which
 *   is to say when some pool is one or two deep and this profile carries the
 *   backend that pool demands. Those are the ones a scaled seed must keep at their
 *   measured size, because scaling them dilutes the one agent pools and quietly
 *   removes the burst's control.
 */
export function shapeFromRoster(input: {
  agents: MeasuredAgent[];
  poolDepths: { code: string; depth: number }[];
  measuredAt: string;
}): { ok: true; shape: RosterShape } | { ok: false; why: string } {
  if (input.agents.length === 0) {
    return { ok: false, why: "no bookable agents were read, and a shape of nobody is never exported" };
  }
  if (input.poolDepths.length === 0) {
    return { ok: false, why: "no real buckets were read, so no pool depth could be measured" };
  }

  const list = (v: unknown): string[] =>
    Array.isArray(v) ? [...(v as string[])].map(String).sort() : typeof v === "string" ? [v] : [];

  const byProfile = new Map<string, ProfileCount>();
  for (const a of input.agents) {
    const attrs = a.attributes ?? {};
    const debtTeam = list(attrs.debt_team);
    const backendService = list(attrs.backend_service);
    const key = `${debtTeam.join(",")}|${backendService.join(",")}`;
    const row = byProfile.get(key) ?? { debtTeam, backendService, agents: 0 };
    row.agents++;
    byProfile.set(key, row);
  }

  const byZone = new Map<string, number>();
  for (const a of input.agents) {
    if (!a.timezone) continue;
    byZone.set(a.timezone, (byZone.get(a.timezone) ?? 0) + 1);
  }

  // Which backends the THIN pools depend on, read from the depths rather than
  // assumed to be Beyond: the routing matrix can change, and a rule naming one
  // backend would stop pinning the day a different one became the scarce thing.
  const thinnest = Math.min(...input.poolDepths.map((p) => p.depth));
  const scarce = new Set<string>();
  if (thinnest <= 2) {
    for (const p of byProfile.values()) {
      // A profile held by at most as many agents as the thinnest pool is deep is one
      // whose dilution would change that depth.
      if (p.agents <= Math.max(1, thinnest)) for (const b of p.backendService) scarce.add(b);
    }
  }

  const profiles = [...byProfile.values()]
    .sort((a, b) => b.agents - a.agents || a.debtTeam.join().localeCompare(b.debtTeam.join()))
    .map((p) => (p.backendService.some((b) => scarce.has(b)) ? { ...p, pinned: true } : { ...p }));

  return {
    ok: true,
    shape: {
      measuredAt: input.measuredAt,
      agents: input.agents.length,
      profiles,
      zones: [...byZone.entries()]
        .map(([timezone, agents]) => ({ timezone, agents }))
        .sort((a, b) => b.agents - a.agents || a.timezone.localeCompare(b.timezone)),
      poolDepths: [...input.poolDepths].sort((a, b) => a.code.localeCompare(b.code)),
    },
  };
}
