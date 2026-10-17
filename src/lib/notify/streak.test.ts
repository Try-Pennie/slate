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

import { recordFailureStreak, recordConsecutiveStreak, clearFailureStreak, trackConsecutiveStreak } from "./streak";

beforeEach(() => vi.clearAllMocks());

// #726 generalizes the same rate_limit_hit counter to an arbitrary threshold, so a
// bounded sweep can page only after N consecutive saturated ticks. recordFailureStreak
// is now this function at N = 2, which is why it keeps its exact behavior above.
describe("recordConsecutiveStreak", () => {
  it("asks the counter to allow one fewer hit than the alert threshold", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    await recordConsecutiveStreak("sweep", 900, 5);
    // p_max = 4 means the 5th consecutive hit is the first to report over-limit.
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "sweep",
      p_window_seconds: 900,
      p_max: 4,
    });
  });

  it("stays quiet while the streak is under the threshold", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await recordConsecutiveStreak("sweep", 900, 5)).toBe(false);
  });

  it("reports once the streak reaches the threshold", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await recordConsecutiveStreak("sweep", 900, 5)).toBe(true);
  });

  // Failure path: tracking is best-effort, but it must never invent a streak that
  // did not happen (a false page) nor throw into the caller's sweep.
  it("stays quiet when the rpc errors, rather than paging on a tracking failure", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await recordConsecutiveStreak("sweep", 900, 5)).toBe(false);
  });

  it("stays quiet when the rpc throws", async () => {
    rpc.mockRejectedValueOnce(new Error("db down"));
    expect(await recordConsecutiveStreak("sweep", 900, 5)).toBe(false);
  });

  it("treats a threshold of 1 as paging on the very first hit", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await recordConsecutiveStreak("sweep", 900, 1)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "sweep",
      p_window_seconds: 900,
      p_max: 0,
    });
  });
});

// #1493: a caller whose safe side is to SPEAK (the overnight canary, which holds a
// first failure only because it can count on the second) cannot use the boolean
// above, where a tracking failure and "not yet" both read as false. This answers
// the three apart.
describe("trackConsecutiveStreak", () => {
  it("answers below while the streak is under the threshold", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await trackConsecutiveStreak("canary", 900, 2)).toBe("below");
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", { p_key: "canary", p_window_seconds: 900, p_max: 1 });
  });

  it("answers reached once the streak reaches the threshold", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await trackConsecutiveStreak("canary", 900, 2)).toBe("reached");
  });

  it("answers unknown, not below, when the rpc errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await trackConsecutiveStreak("canary", 900, 2)).toBe("unknown");
  });

  it("answers unknown when the rpc throws", async () => {
    rpc.mockRejectedValueOnce(new Error("db down"));
    expect(await trackConsecutiveStreak("canary", 900, 2)).toBe("unknown");
  });

  it("answers unknown when the rpc returns something that is not a boolean", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await trackConsecutiveStreak("canary", 900, 2)).toBe("unknown");
  });
});

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
