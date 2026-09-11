import { describe, it, expect, vi, beforeEach } from "vitest";

// The empty-bucket sweep's REAL dependencies, as opposed to the injected ones the
// decision tests use. Two things can only be proved here, because both live in the
// wiring rather than in the pure decision:
//
//   1. the page's cooldown comes from the settings store, not a constant (L3: a
//      stored setting nothing reads looks exactly like a working control), and
//   2. the sweep measures the buckets that route real leads, so the count in the
//      page is a number that can be reconciled against the roster.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
  settleAlertsSilently: vi.fn(async (_keys: string[]) => {}),
}));
vi.mock("@/lib/notify/dispatch", () => dispatch);

const WEEK_MIN = 10080;
const settings = vi.hoisted(() => ({
  loadMonitorSettings: vi.fn(async () => ({
    cooldownMs: { empty_buckets: 10080 * 60_000 } as Record<string, number>,
    floors: { floor30: 5, floor120: 20 },
    lowVolumeArmed: false,
  })),
}));
vi.mock("@/lib/monitor/settings", () => settings);

// Two real buckets and one SMOKE test bucket. The mock HONOURS an is_test filter,
// so what the sweep asks for is what decides which of them it sees.
const buckets = vi.hoisted(() => [
  // Distinct criteria, so each is its own POOL (#2237). A bucket's pool comes
  // from its criteria, and three buckets with none would be one pool, which is a
  // different scenario from the one these cases are about.
  { code: "411", org_id: "o1", is_test: false, criteria: { debt_team: "very_high" } },
  { code: "412", org_id: "o1", is_test: false, criteria: { debt_team: "high" } },
  { code: "SMOKE1", org_id: "o1", is_test: true, criteria: { debt_team: "smoke" } },
]);
const bucketFilters = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (_t: string) => ({
      select: () => ({
        // Awaited with no filter: every bucket, test fixtures included.
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: buckets, error: null }).then(res),
        eq: (col: string, val: unknown) => {
          bucketFilters(col, val);
          const kept = buckets.filter((b) => (b as Record<string, unknown>)[col] === val);
          return Promise.resolve({ data: kept, error: null });
        },
      }),
    }),
  }),
}));
// 411 is dead, 412 has somebody, and the SMOKE bucket is dead too. One dead bucket
// out of two real ones is deliberately NOT a broad outage, so a single run covers
// the per-bucket page and the aggregate's all-clear at once.
vi.mock("./eligible-cache.ts", () => ({
  eligibleAgentIdsCached: vi.fn(async (b: { code: string }) => ({
    ids: b.code === "412" ? ["u1"] : [],
    fallbackApplied: false,
  })),
}));

import { alertOnEmptyBuckets } from "./service";

beforeEach(() => vi.clearAllMocks());

describe("the empty-bucket page's cooldown", () => {
  it("throttles on the stored setting, not on a constant in the code", async () => {
    await alertOnEmptyBuckets();
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldownMs] = dispatch.sendThrottledAlert.mock.calls[0];
    expect(key).toBe("empty_buckets:411");
    expect(cooldownMs).toBe(WEEK_MIN * 60_000);
  });

  it("reads the store once per sweep, not once per bucket", async () => {
    // Sixty buckets used to mean sixty of everything. The settings read is resolved
    // for the run, so a wide roster does not multiply it.
    await alertOnEmptyBuckets();
    expect(settings.loadMonitorSettings).toHaveBeenCalledTimes(1);
  });
});

describe("which buckets the sweep measures", () => {
  it("leaves the SMOKE test buckets out entirely", async () => {
    const res = await alertOnEmptyBuckets();
    // The test bucket is dead in this fixture too and must still not page: the canary
    // is what watches it, and a page about a fixture is noise to whoever is deciding
    // whether real leads can be routed.
    expect(res.empty).toEqual(["411"]);
    expect(bucketFilters).toHaveBeenCalledWith("is_test", false);
    const paged = dispatch.sendThrottledAlert.mock.calls.map(([k]) => k);
    expect(paged).not.toContain("empty_buckets:SMOKE1");
  });

  it("counts only the real buckets in the message, so the number matches the roster", async () => {
    // The count is the one thing a reader checks against what they believe they have.
    // Three buckets exist, two of them route real leads, and one of those two is
    // dead: "1 of 2", never "2 of 3", which would count a fixture as a lead route.
    await alertOnEmptyBuckets();
    const aggregateClear = dispatch.resolveAlert.mock.calls.find(
      ([key]) => key === "empty_buckets:all",
    );
    expect(aggregateClear?.[1]).toContain("1 of 2 pools");
    expect(aggregateClear?.[1]).not.toMatch(/of 3\b/);
  });
});
