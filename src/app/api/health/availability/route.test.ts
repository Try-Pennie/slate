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
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

// The route only reads code + effectiveDepth off each TierDepth.
const depth = (code: string, effectiveDepth: number) => ({ code, effectiveDepth });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/health/availability", () => {
  it("returns 200 ok when every staffed bucket has cached times", async () => {
    staffing.loadTierDepths.mockResolvedValue([depth("100", 69), depth("205", 4)]);
    precompute.listBucketSlotCounts.mockResolvedValue([
      { code: "100", slots: 142 },
      { code: "205", slots: 12 },
    ]);

    const res = await GET();
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

    const res = await GET();
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

    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("fails loud: a read error returns 503, never a healthy 200", async () => {
    staffing.loadTierDepths.mockRejectedValue(new Error("db down"));
    precompute.listBucketSlotCounts.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.reason).toBe("check_error");
  });
});
