import { describe, it, expect, vi, beforeEach } from "vitest";

// The empty-bucket page's cooldown is UI-tunable (#571's mechanism), and this is
// the proof it is WIRED and not merely declared (L3): the sweep's real deps must
// throttle on the value in the store, not on the constant they used to carry. A
// stored setting nothing reads looks exactly like a working control.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => true),
  settleAlertsSilently: vi.fn(async () => {}),
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

// One bucket in the roster; nobody eligible for it. One bucket is deliberately not
// a broad outage, so this exercises the per-bucket page, which is the one whose
// cooldown produced the flood.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (_t: string) => ({
      select: async () => ({ data: [{ code: "411", org_id: "o1" }], error: null }),
    }),
  }),
}));
vi.mock("./eligible-cache.ts", () => ({
  eligibleAgentIdsCached: vi.fn(async () => ({ ids: [], fallbackApplied: false })),
}));

import { alertOnEmptyBuckets } from "./service";

beforeEach(() => vi.clearAllMocks());

describe("the empty-bucket page's cooldown", () => {
  it("throttles on the stored setting, not on a constant in the code", async () => {
    const res = await alertOnEmptyBuckets();
    expect(res.empty).toEqual(["411"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldownMs] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
    ];
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
