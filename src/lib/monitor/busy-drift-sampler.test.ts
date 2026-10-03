import { describe, it, expect, vi } from "vitest";

// #1262, second half: does the cached busy index agree with Google, sampled live?
//
// What is under test is the COMPARISON, because it has one way to be wrong that
// would defeat its whole purpose: freeBusy returns merged anonymous intervals,
// and Slate deliberately never mirrors its own bookings as gcal events
// (#166/#586), so a comparison that unions only google-source cache rows flags
// every Slate booking as a gap. The caller unions ALL sources; these tests pin
// the interval arithmetic and the fail-safe directions.
import {
  uncachedBusy,
  sampleForTick,
  runBusyDriftSample,
  reportBusyDrift,
  persistenceRule,
  formatBusyDriftAlert,
  formatBusyDriftRecovery,
  BUSY_DRIFT_KEY,
  DRIFT_PERSIST_MS,
  type BusyDriftResult,
  type DriftInterval,
} from "./busy-drift-sampler";
import { log } from "@/lib/log";

const at = (h: number, m = 0) =>
  `2026-08-24T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const WINDOW = { windowStartIso: at(0), windowEndIso: at(23) };
const iv = (s: string, e: string): DriftInterval => ({ startIso: s, endIso: e });

describe("uncachedBusy (#1262)", () => {
  it("live busy fully covered by the cache is no gap", () => {
    const out = uncachedBusy({
      cached: [iv(at(9), at(12))],
      live: [iv(at(10), at(11))],
      ...WINDOW,
    });
    expect(out.gaps).toEqual([]);
    expect(out.unreadable).toBe(0);
  });

  it("live busy the cache does not hold is the finding", () => {
    const out = uncachedBusy({ cached: [], live: [iv(at(10), at(11))], ...WINDOW });
    expect(out.gaps).toEqual([iv(at(10), at(11))]);
  });

  it("a partly covered interval reports only the uncovered remainder", () => {
    const out = uncachedBusy({
      cached: [iv(at(10), at(10, 30))],
      live: [iv(at(10), at(11))],
      ...WINDOW,
    });
    expect(out.gaps).toEqual([iv(at(10, 30), at(11))]);
  });

  it("two cached blocks covering an interval between them leave no gap", () => {
    const out = uncachedBusy({
      cached: [iv(at(10), at(10, 30)), iv(at(10, 30), at(11))],
      live: [iv(at(10), at(11))],
      ...WINDOW,
    });
    expect(out.gaps).toEqual([]);
  });

  it("live busy outside the window is not judged: the cache is only bounded inside it", () => {
    const out = uncachedBusy({
      cached: [],
      live: [iv("2026-08-30T10:00:00.000Z", "2026-08-30T11:00:00.000Z")],
      ...WINDOW,
    });
    expect(out.gaps).toEqual([]);
  });

  it("names a gap by when its meeting started, so a meeting already under way keys the same on every tick", () => {
    // The window starts at "now", so a meeting in progress is clipped to a start that
    // moves every tick. Its identity is the meeting's own start, which does not.
    const meeting = iv(at(9), at(11));
    const tickOne = uncachedBusy({ cached: [], live: [meeting], windowStartIso: at(10), windowEndIso: at(23) });
    const tickTwo = uncachedBusy({ cached: [], live: [meeting], windowStartIso: at(10, 5), windowEndIso: at(23) });
    expect(tickOne.gaps[0]!.startIso).toBe(at(10));
    expect(tickOne.firstGapSinceIso).toBe(at(9));
    expect(tickTwo.firstGapSinceIso).toBe(at(9));
    // A gap that starts after a cached block is already stable: it keeps its own start.
    const afterCached = uncachedBusy({ cached: [iv(at(9), at(10, 30))], live: [meeting], windowStartIso: at(10), windowEndIso: at(23) });
    expect(afterCached.firstGapSinceIso).toBe(at(10, 30));
    expect(uncachedBusy({ cached: [], live: [], ...WINDOW }).firstGapSinceIso).toBeNull();
  });

  it("a sliver under the tolerance is boundary jitter, not a gap", () => {
    const out = uncachedBusy({
      cached: [iv(at(10), at(10, 59))],
      live: [iv(at(10), at(11))],
      ...WINDOW,
    });
    expect(out.gaps).toEqual([]);
  });

  it("an unreadable live interval is counted apart, never silently skipped as covered", () => {
    const out = uncachedBusy({
      cached: [],
      live: [iv("garbage", at(11))],
      ...WINDOW,
    });
    expect(out.gaps).toEqual([]);
    expect(out.unreadable).toBe(1);
  });
});

describe("sampleForTick", () => {
  const agents = Array.from({ length: 7 }, (_, i) => ({ email: `a${i}@x.com` }));

  it("walks the whole roster across consecutive ticks", () => {
    const seen = new Set<string>();
    for (let tick = 0; tick < 4; tick++) {
      for (const a of sampleForTick(agents, tick, 2)) seen.add(a.email);
    }
    expect(seen.size).toBe(7);
  });

  it("a roster smaller than the batch is sampled whole every tick", () => {
    expect(sampleForTick(agents.slice(0, 2), 12345, 18)).toHaveLength(2);
  });
});

describe("runBusyDriftSample", () => {
  const base = {
    fromIso: at(0),
    toIso: at(23),
    sample: [{ email: "dana@x.com", userId: "u1" }],
  };

  it("reports the agents it measured and the gaps it found, and only logs", async () => {
    const logged: Record<string, unknown>[] = [];
    const result = await runBusyDriftSample({
      ...base,
      readLive: async () => ({
        agents: [{ email: "dana@x.com", calendarIds: ["dana@x.com"] }],
        busyByCalendar: new Map([
          ["dana@x.com", { busy: [{ start: at(10), end: at(11) }], error: false }],
        ]),
        unreadable: 0,
      }),
      loadCachedBlocks: async () => new Map([["u1", []]]),
      logTick: (fields) => logged.push(fields),
    });
    expect(result.status).toBe("observed");
    expect(result.agentsChecked).toBe(1);
    expect(result.gapAgents).toEqual([
      { email: "dana@x.com", userId: "u1", gaps: 1, gapMinutes: 60, firstGapStartIso: at(10) },
    ]);
    expect(logged.length).toBeGreaterThan(0);
  });

  it("an agent whose calendar read errored is unreadable, never a clean pass", async () => {
    const result = await runBusyDriftSample({
      ...base,
      readLive: async () => ({
        agents: [{ email: "dana@x.com", calendarIds: ["dana@x.com"] }],
        busyByCalendar: new Map([["dana@x.com", { busy: [], error: true }]]),
        unreadable: 0,
      }),
      loadCachedBlocks: async () => new Map([["u1", []]]),
    });
    expect(result.status).toBe("observed");
    expect(result.agentsChecked).toBe(0);
    expect(result.agentsUnreadable).toBe(1);
  });

  it("a dead live read is unreadable for the whole tick, not an empty finding", async () => {
    const result = await runBusyDriftSample({
      ...base,
      readLive: async () => null,
      loadCachedBlocks: async () => new Map(),
    });
    expect(result.status).toBe("unreadable");
  });

  it("a failed cache read is unreadable too: comparing live against nothing finds everything", async () => {
    const result = await runBusyDriftSample({
      ...base,
      readLive: async () => ({
        agents: [{ email: "dana@x.com", calendarIds: ["dana@x.com"] }],
        busyByCalendar: new Map([
          ["dana@x.com", { busy: [{ start: at(10), end: at(11) }], error: false }],
        ]),
        unreadable: 0,
      }),
      loadCachedBlocks: async () => {
        throw new Error("busy_blocks unreadable");
      },
    });
    expect(result.status).toBe("unreadable");
  });
});

// #1591: armed REPORT ONLY (Dan, 2026-10-02). It pages on drift that PERSISTS and
// never writes busy time itself; the sync tools stay the cache's one writer.
//
// Calibration, 7 days of tag=busy-drift lines read from production on 2026-10-03:
// 1,998 ticks, 1,959 with no drift, 38 with one agent and 1 with two (40 findings
// across 26 agents, every one 10 to 40 minutes long). Not one finding was still
// there when its agent was next sampled, about 30 minutes later on a six page
// rotation. So the line between noise and a fault is persistence, not a count per
// tick: a single stuck agent and the ordinary sync lag both read as one agent on
// one tick (L172).
describe("persistenceRule (#1591)", () => {
  it("is the measured 30 minutes: no finding outlived one revisit", () => {
    expect(DRIFT_PERSIST_MS).toBe(30 * 60_000);
  });

  it("on a six page rotation two sightings of one gap already span 30 minutes", () => {
    const r = persistenceRule(6, 5 * 60_000);
    expect(r.hits).toBe(2);
    // The window holds both sightings with a revisit of slack.
    expect(r.windowSeconds).toBeGreaterThanOrEqual(2 * 30 * 60);
  });

  it("a roster sampled whole every tick needs seven sightings, so five minutes of lag never pages", () => {
    const r = persistenceRule(1, 5 * 60_000);
    expect(r.hits).toBe(7);
    expect(r.windowSeconds).toBeGreaterThan(6 * 5 * 60);
  });
});

describe("reportBusyDrift (#1591)", () => {
  const observed = (over: Partial<BusyDriftResult> = {}): BusyDriftResult => ({
    status: "observed",
    agentsChecked: 18,
    agentsUnreadable: 0,
    gapAgents: [],
    ...over,
  });
  const gap = { email: "dana@x.com", userId: "u1", gaps: 1, gapMinutes: 20, firstGapStartIso: at(10) };

  function harness(opts: { hitReturns?: (key: string) => boolean } = {}) {
    const calls = {
      hits: [] as { key: string; windowSeconds: number; alertAt: number }[],
      cleared: [] as string[],
      notified: [] as { key: string; cooldown: number; text: string }[],
      resolved: [] as { key: string; text: string }[],
    };
    const deps = {
      rotationTicks: 6,
      tickMs: 5 * 60_000,
      cooldownMs: 3_600_000,
      hit: async (key: string, windowSeconds: number, alertAt: number) => {
        calls.hits.push({ key, windowSeconds, alertAt });
        return opts.hitReturns ? opts.hitReturns(key) : false;
      },
      clearStreak: async (key: string) => {
        calls.cleared.push(key);
      },
      notify: async (key: string, cooldown: number, text: string) => {
        calls.notified.push({ key, cooldown, text });
      },
      resolve: async (key: string, text: string) => {
        calls.resolved.push({ key, text });
        return true;
      },
    };
    return { calls, deps };
  }

  it("a first sighting is transient: counted, never paged", async () => {
    const { calls, deps } = harness();
    const out = await reportBusyDrift({ ...deps, result: observed({ gapAgents: [gap] }) });
    expect(out.verdict).toBe("transient");
    expect(calls.notified).toEqual([]);
    expect(calls.hits[0]?.key).toBe(`${BUSY_DRIFT_KEY}:seen:u1:${at(10)}`);
    expect(calls.hits[0]?.alertAt).toBe(2);
    // A drift tick breaks the clean run the all clear waits on.
    expect(calls.cleared).toContain(`${BUSY_DRIFT_KEY}:clean`);
    expect(calls.resolved).toEqual([]);
  });

  it("the same gap seen again pages, naming the agent, and never resolves", async () => {
    const { calls, deps } = harness({ hitReturns: (k) => k.includes(":seen:") });
    const out = await reportBusyDrift({ ...deps, result: observed({ gapAgents: [gap] }) });
    expect(out.verdict).toBe("sustained");
    expect(out.sustained).toEqual([gap]);
    expect(calls.notified).toHaveLength(1);
    expect(calls.notified[0]?.key).toBe(BUSY_DRIFT_KEY);
    expect(calls.notified[0]?.cooldown).toBe(3_600_000);
    expect(calls.notified[0]?.text).toContain("dana@x.com");
    expect(calls.resolved).toEqual([]);
  });

  it("a clean tick advances the clean run and does not resolve before a full rotation", async () => {
    const { calls, deps } = harness();
    const out = await reportBusyDrift({ ...deps, result: observed() });
    expect(out.verdict).toBe("clear");
    expect(calls.hits).toEqual([
      { key: `${BUSY_DRIFT_KEY}:clean`, windowSeconds: expect.any(Number), alertAt: 6 },
    ]);
    expect(calls.resolved).toEqual([]);
  });

  it("a full rotation of clean ticks sends the all clear and restarts the run", async () => {
    const { calls, deps } = harness({ hitReturns: (k) => k.endsWith(":clean") });
    const out = await reportBusyDrift({ ...deps, result: observed() });
    expect(out.resolved).toBe(true);
    expect(calls.resolved).toEqual([{ key: BUSY_DRIFT_KEY, text: formatBusyDriftRecovery() }]);
    expect(calls.cleared).toEqual([`${BUSY_DRIFT_KEY}:clean`]);
  });

  // all-clear-proof: each of these measured nothing, so none may end a page.
  it.each([
    ["a skipped or failed step", null],
    ["an unreadable side", { status: "unreadable", agentsChecked: 0, agentsUnreadable: 0, gapAgents: [] }],
    ["a tick that checked nobody", { status: "observed", agentsChecked: 0, agentsUnreadable: 0, gapAgents: [] }],
  ] as const)("%s neither pages, resolves, nor touches a streak", async (_name, result) => {
    const { calls, deps } = harness({ hitReturns: () => true });
    const resolveAlert = vi.fn(async () => true);
    const out = await reportBusyDrift({
      ...deps,
      resolve: resolveAlert,
      result: result as BusyDriftResult | null,
    });
    expect(out.verdict).toBe("unmeasured");
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(calls).toEqual({ hits: [], cleared: [], notified: [], resolved: [] });
  });

  it("a clean tick with an unreadable agent does not count toward the all clear", async () => {
    const { calls, deps } = harness({ hitReturns: () => true });
    const out = await reportBusyDrift({ ...deps, result: observed({ agentsUnreadable: 1 }) });
    expect(out.verdict).toBe("clear");
    expect(calls.hits).toEqual([]);
    expect(calls.resolved).toEqual([]);
  });

  it("a refused page is logged at error, so it never reads like a gap that was not sustained", async () => {
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const { deps } = harness({ hitReturns: (k) => k.includes(":seen:") });
    await reportBusyDrift({
      ...deps,
      result: observed({ gapAgents: [gap] }),
      notify: async () => {
        throw new Error("slack 500");
      },
    });
    expect(errorSpy).toHaveBeenCalledWith("busy-drift", expect.objectContaining({ msg: "page failed to send" }), expect.any(Error));
    errorSpy.mockRestore();
  });

  it("a refused post or a failed resolve never fails the tick", async () => {
    const { deps } = harness({ hitReturns: () => true });
    const out = await reportBusyDrift({
      ...deps,
      notify: async () => {
        throw new Error("slack 500");
      },
      result: observed({ gapAgents: [gap] }),
    });
    expect(out.verdict).toBe("sustained");
    const clean = await reportBusyDrift({
      ...deps,
      resolve: async () => {
        throw new Error("alert_state unreadable");
      },
      result: observed(),
    });
    expect(clean.verdict).toBe("clear");
    expect(clean.resolved).toBe(false);
  });
});

describe("busy drift copy (#1591)", () => {
  it("agrees with its count and carries no dashes", () => {
    const one = formatBusyDriftAlert([
      { email: "dana@x.com", userId: "u1", gaps: 1, gapMinutes: 20, firstGapStartIso: at(10) },
    ]);
    expect(one.startsWith("1 agent's calendar")).toBe(true);
    expect(one).toContain("20 minutes");
    expect(one).not.toMatch(/[\u2014\u2013]/);
    const two = formatBusyDriftAlert([
      { email: "dana@x.com", userId: "u1", gaps: 1, gapMinutes: 20, firstGapStartIso: at(10) },
      { email: "lee@x.com", userId: "u2", gaps: 2, gapMinutes: 45, firstGapStartIso: at(12) },
    ]);
    expect(two.startsWith("2 agents' calendars")).toBe(true);
    expect(two).toContain("lee@x.com");
    expect(formatBusyDriftRecovery()).not.toMatch(/^Slate/);
  });
});
