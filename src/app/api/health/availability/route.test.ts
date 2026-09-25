import { describe, it, expect, vi, beforeEach } from "vitest";

// #749: the availability canary returns 200 when the booker is offering times and
// 503 when a staffed tier is silently empty or the read fails (fail-loud). The pure
// decision is covered by scripts/test-availability-canary.ts; here we prove the
// route wires the loaders to it and never reads a failure as healthy.
const staffing = vi.hoisted(() => ({ loadTierDepths: vi.fn() }));
const precompute = vi.hoisted(() => ({ listBucketSlotCounts: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/routing/staffing-depth-load", () => staffing);
vi.mock("@/lib/availability/precompute", () => precompute);
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));
// #1228: the uptime heartbeat noodge stamps through this endpoint.
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async (_lane: string) => {}) }));
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { GET } from "./route";

const KEY = "uptime-heartbeat-test-key";
const req = (authorization?: string) =>
  new Request("https://slate.test/api/health/availability", {
    headers: authorization === undefined ? {} : { authorization },
  });

// The route only reads code + effectiveDepth off each TierDepth.
const depth = (code: string, effectiveDepth: number) => ({ code, effectiveDepth });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UPTIME_HEARTBEAT_KEY = KEY;
  heartbeat.recordHeartbeat.mockResolvedValue(undefined);
});

describe("GET /api/health/availability", () => {
  it("returns 200 ok when every staffed bucket has cached times", async () => {
    staffing.loadTierDepths.mockResolvedValue([depth("100", 69), depth("205", 4)]);
    precompute.listBucketSlotCounts.mockResolvedValue([
      { code: "100", slots: 142 },
      { code: "205", slots: 12 },
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.brokenBuckets).toHaveLength(0);
  });

  it("returns 503 degraded and names the broken tier when a well-staffed bucket is empty", async () => {
    staffing.loadTierDepths.mockResolvedValue([depth("100", 8), depth("205", 4)]);
    precompute.listBucketSlotCounts.mockResolvedValue([
      { code: "100", slots: 0 },
      { code: "205", slots: 12 },
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.reason).toBe("tier_broken");
    expect(body.brokenBuckets).toEqual([{ code: "100", effectiveDepth: 8, slots: 0 }]);
  });

  it("does NOT page when a single tiny bucket is empty (below the strong floor)", async () => {
    staffing.loadTierDepths.mockResolvedValue([depth("100", 69), depth("900", 1)]);
    precompute.listBucketSlotCounts.mockResolvedValue([
      { code: "100", slots: 142 },
      { code: "900", slots: 0 },
    ]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("fails loud: a read error returns 503, never a healthy 200", async () => {
    staffing.loadTierDepths.mockRejectedValue(new Error("db down"));
    precompute.listBucketSlotCounts.mockResolvedValue([]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.reason).toBe("check_error");
  });

  it("#1629: an unreadable roster reports the counts as null, never as zero", async () => {
    // The shape `loadTierDepths` now throws with. Before #1629 it resolved `[]`
    // here, which took the HEALTHY branch: 200, reason "ok", staffedBuckets 0,
    // indistinguishable from a fleet that genuinely has no staffed buckets.
    staffing.loadTierDepths.mockRejectedValue(
      new Error('read failed [staffing depth buckets]: connection reset'),
    );
    precompute.listBucketSlotCounts.mockResolvedValue([{ code: "100", slots: 142 }]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.reason).toBe("check_error");
    // A count that could not be measured is null. Not 0, and not absent: to a
    // JSON reader an absent count reads the same as a zero one.
    expect(body).toHaveProperty("staffedBuckets", null);
    expect(body).toHaveProperty("unknownBuckets", null);
    // Nothing may be NAMED as broken off a reading that was never taken.
    expect(body.brokenBuckets).toEqual([]);
  });
});

describe("GET /api/health/availability uptime heartbeat (#1228)", () => {
  const healthyFleet = () => {
    staffing.loadTierDepths.mockResolvedValue([depth("100", 69)]);
    precompute.listBucketSlotCounts.mockResolvedValue([{ code: "100", slots: 142 }]);
  };

  it("stamps uptime:availability-canary when the request carries the heartbeat key", async () => {
    healthyFleet();
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("uptime:availability-canary");
  });

  it("does not stamp without a key, and answers exactly as it would have", async () => {
    healthyFleet();
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("does not stamp on a wrong key, and still answers normally", async () => {
    healthyFleet();
    const res = await GET(req(`Bearer not-${KEY}`));
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("never stamps when the deployment holds no key", async () => {
    healthyFleet();
    process.env.UPTIME_HEARTBEAT_KEY = "";
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  it("still stamps, and still answers 503, when the canary's own read fails", async () => {
    // noodge reached the endpoint, which is all the heartbeat claims. The verdict
    // is noodge's to alert on, from the status code.
    staffing.loadTierDepths.mockRejectedValue(new Error("db down"));
    precompute.listBucketSlotCounts.mockResolvedValue([]);
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(503);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("uptime:availability-canary");
  });

  it("answers normally when the stamp write fails, and logs the failure", async () => {
    healthyFleet();
    heartbeat.recordHeartbeat.mockRejectedValue(new Error("supabase unreachable"));
    const res = await GET(req(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(log.error.mock.calls.some((c) => c[0] === "uptime-heartbeat")).toBe(true);
  });
});
