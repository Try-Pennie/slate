import { describe, it, expect } from "vitest";

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
  type DriftInterval,
} from "./busy-drift-sampler";

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
      { email: "dana@x.com", gaps: 1, gapMinutes: 60 },
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
