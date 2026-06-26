import { describe, it, expect, vi, beforeEach } from "vitest";

// streak.ts maps the #31 rate_limit_hit result to the #43 consecutive-failure
// decision, best-effort (a tracking miss must never break the caller). The DB is
// mocked; the logic under test is the under-limit -> quiet / over-limit -> alert
// mapping plus the error/throw guards, and that clear deletes by key.
const rpc = vi.hoisted(() => vi.fn());
const eq = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const del = vi.hoisted(() => vi.fn(() => ({ eq })));
const from = vi.hoisted(() => vi.fn(() => ({ delete: del })));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ rpc, from }),
}));

import { recordFailureStreak, clearFailureStreak } from "./streak";

beforeEach(() => vi.clearAllMocks());

describe("recordFailureStreak", () => {
  it("stays quiet on the first failure (still under the limit)", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await recordFailureStreak("cron_agents_failures", 100)).toBe(false);
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "cron_agents_failures",
      p_window_seconds: 100,
      p_max: 1,
    });
  });

  it("alerts once the failures are consecutive (over the limit)", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await recordFailureStreak("k", 100)).toBe(true);
  });

  it("stays quiet (best-effort) when the rpc returns an error", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await recordFailureStreak("k", 100)).toBe(false);
  });

  it("stays quiet (best-effort) when the rpc throws", async () => {
    rpc.mockRejectedValueOnce(new Error("db down"));
    expect(await recordFailureStreak("k", 100)).toBe(false);
  });
});

describe("clearFailureStreak", () => {
  it("deletes the streak row for the given key", async () => {
    await clearFailureStreak("cron_agents_failures");
    expect(from).toHaveBeenCalledWith("rate_limits");
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith("key", "cron_agents_failures");
  });

  it("swallows errors so a tracking miss never breaks the caller", async () => {
    eq.mockRejectedValueOnce(new Error("delete failed"));
    await expect(clearFailureStreak("k")).resolves.toBeUndefined();
  });
});
