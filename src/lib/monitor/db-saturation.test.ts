import { describe, it, expect, vi, beforeEach } from "vitest";

// #3588: the database's own memory pressure must page directly, early, instead of
// surfacing as the availability latency a lead already felt. What is under test is the
// DECISION: the Prometheus parse (a missing or garbage metric is unreadable, never a
// guessed number), the judge (ok/warn/page by the percent of memory in use, swap
// corroborating), and that a reading it cannot take does NEITHER page nor clear (#1134,
// #1169).
const recordConsecutiveStreak = vi.hoisted(() =>
  vi.fn(async (_key: string, _windowSeconds: number, _afterTicks: number) => false),
);
const clearFailureStreak = vi.hoisted(() => vi.fn(async (_key: string) => {}));
const sendThrottledAlert = vi.hoisted(() => vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}));
const sendThrottledInfo = vi.hoisted(() => vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}));
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));
const supabaseSecretKey = vi.hoisted(() => vi.fn(() => "sb_secret_test_key"));
const publicSupabaseUrl = vi.hoisted(() => vi.fn(() => "https://ref.supabase.co"));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, sendThrottledInfo, resolveAlert }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/env", () => ({ supabaseSecretKey, publicSupabaseUrl }));

import {
  parseDbMemoryMetrics,
  judgeDbSaturation,
  swapWarrantsWhisper,
  commitLimitWarrantsWhisper,
  formatDbSaturationAlert,
  formatDbSaturationRecovery,
  formatDbSaturationWarn,
  runDbSaturationCheck,
  fetchDbSaturationMetrics,
  DB_SATURATION_KEY,
  DB_SATURATION_WARN_KEY,
  DB_METRIC_NAMES,
  type DbMemoryReading,
} from "./db-saturation";

const GB = 1024 * 1024 * 1024;

/** A realistic metrics body at a given total/available memory and swap, in node_exporter
 *  shape. It also carries the commit accounting gauges, which the check must ignore. */
const body = (
  total: number,
  available: number,
  swapTotal: number,
  swapFree: number,
  commit: { committed: number; limit: number } = { committed: 0.5 * GB, limit: 1 * GB },
): string =>
  [
    "# HELP node_memory_MemTotal_bytes Memory information field MemTotal_bytes.",
    "# TYPE node_memory_MemTotal_bytes gauge",
    `${DB_METRIC_NAMES.total} ${total}`,
    `${DB_METRIC_NAMES.available} ${available}`,
    `${DB_METRIC_NAMES.swapTotal} ${swapTotal}`,
    `${DB_METRIC_NAMES.swapFree} ${swapFree}`,
    "node_memory_MemFree_bytes 123456",
    `${DB_METRIC_NAMES.committed} ${commit.committed}`,
    `${DB_METRIC_NAMES.commitLimit} ${commit.limit}`,
  ].join("\n");

describe("parseDbMemoryMetrics (#3588)", () => {
  it("reads the four memory gauges from a Prometheus body", () => {
    const r = parseDbMemoryMetrics(body(7.54 * GB, 5.87 * GB, 2 * GB, 1.8 * GB));
    expect(r.totalBytes).toBe(7.54 * GB);
    expect(r.availableBytes).toBe(5.87 * GB);
    expect(r.swapTotalBytes).toBe(2 * GB);
    expect(r.swapFreeBytes).toBe(1.8 * GB);
  });

  it("reads the commit accounting gauges, and leaves them null when absent", () => {
    const r = parseDbMemoryMetrics(body(1 * GB, 0.5 * GB, 1 * GB, 1 * GB, { committed: 3.85 * GB, limit: 4.77 * GB }));
    expect(r.committedBytes).toBe(3.85 * GB);
    expect(r.commitLimitBytes).toBe(4.77 * GB);
    const bare = parseDbMemoryMetrics(`${DB_METRIC_NAMES.total} 100\n${DB_METRIC_NAMES.available} 50`);
    expect([bare.committedBytes, bare.commitLimitBytes]).toEqual([null, null]);
  });

  it("tolerates a label set on the gauge line", () => {
    const text = `${DB_METRIC_NAMES.available}{instance="db"} 42\n${DB_METRIC_NAMES.total} 100`;
    expect(parseDbMemoryMetrics(text).availableBytes).toBe(42);
  });

  it("tolerates an optional Prometheus timestamp trailing the value", () => {
    const text = `${DB_METRIC_NAMES.available} 42 1700000000000\n${DB_METRIC_NAMES.total} 100`;
    expect(parseDbMemoryMetrics(text).availableBytes).toBe(42);
    expect(parseDbMemoryMetrics(text).totalBytes).toBe(100);
  });

  it("returns null for a metric that is absent, never a guess", () => {
    const text = `${DB_METRIC_NAMES.available} 42`; // no total/swap lines
    const r = parseDbMemoryMetrics(text);
    expect(r.availableBytes).toBe(42);
    expect(r.totalBytes).toBeNull();
    expect(r.swapTotalBytes).toBeNull();
  });

  it("returns null for a non-numeric value", () => {
    const text = `${DB_METRIC_NAMES.available} not-a-number\n${DB_METRIC_NAMES.total} 100`;
    expect(parseDbMemoryMetrics(text).availableBytes).toBeNull();
  });

  it("does not match a metric name as a substring of another", () => {
    // Only a longer-named metric is present; the short name must not match inside it.
    const text = "node_memory_MemAvailable_bytes_total 999";
    expect(parseDbMemoryMetrics(text).availableBytes).toBeNull();
  });

  it("reads a garbage body as all nulls, which the judge turns into unreadable", () => {
    const r = parseDbMemoryMetrics("<html>502 Bad Gateway</html>");
    expect([r.totalBytes, r.availableBytes, r.swapTotalBytes, r.swapFreeBytes]).toEqual([null, null, null, null]);
  });
});

describe("judgeDbSaturation (#3588)", () => {
  // 1 GB of RAM makes the percent in use read straight off the available figure.
  const read = (over: Partial<DbMemoryReading> = {}): DbMemoryReading => ({
    totalBytes: 1 * GB,
    availableBytes: 0.5 * GB,
    swapTotalBytes: 1 * GB,
    swapFreeBytes: 1 * GB, // no swap used
    committedBytes: 0.5 * GB,
    commitLimitBytes: 1 * GB,
    ...over,
  });

  it("is ok below the warn threshold", () => {
    expect(judgeDbSaturation(read({ availableBytes: 0.3 * GB })).status).toBe("ok"); // 70% in use
  });

  it("warns from 80% in use up to but not including 90", () => {
    expect(judgeDbSaturation(read({ availableBytes: 0.2 * GB })).status).toBe("warn");
    expect(judgeDbSaturation(read({ availableBytes: 0.101 * GB })).status).toBe("warn");
  });

  it("pages at 90% in use and above", () => {
    expect(judgeDbSaturation(read({ availableBytes: 0.1 * GB })).status).toBe("page");
    expect(judgeDbSaturation(read({ availableBytes: 0.05 * GB })).status).toBe("page");
  });

  it("reads the 2026-10-29 Large instance as ok: 80% committed against the commit limit, 22% in use", () => {
    // The live reading behind the false whisper. Committed_AS was 3.85 GB against a 4.77 GB
    // CommitLimit, but Supabase runs the default heuristic overcommit, where CommitLimit is
    // never enforced, and on Large it sits BELOW physical RAM (half of 7.54 GB plus 1 GB of
    // swap). Memory actually in use was 1.67 GB of 7.54 GB, nothing swapped.
    const v = judgeDbSaturation(
      parseDbMemoryMetrics(
        [
          `${DB_METRIC_NAMES.total} ${7.54 * GB}`,
          `${DB_METRIC_NAMES.available} ${5.87 * GB}`,
          `${DB_METRIC_NAMES.swapTotal} ${1 * GB}`,
          `${DB_METRIC_NAMES.swapFree} ${1 * GB}`,
          `node_memory_Committed_AS_bytes ${3.85 * GB}`,
          `node_memory_CommitLimit_bytes ${4.77 * GB}`,
        ].join("\n"),
      ),
    );
    expect(v.status).toBe("ok");
    expect(Math.round(v.usedPct ?? -1)).toBe(22);
    expect(swapWarrantsWhisper(v.swapUsedPct)).toBe(false);
  });

  it("keeps the status MEMORY-only: swap in use does not change the status, it is reported apart", () => {
    const v = judgeDbSaturation(read({ swapFreeBytes: 0.8 * GB })); // 50% in use, 20% swap used
    expect(v.status).toBe("ok");
    expect(Math.round(v.swapUsedPct ?? -1)).toBe(20);
    expect(swapWarrantsWhisper(v.swapUsedPct)).toBe(true); // the swap is what the runner whispers on
  });

  it("never lets swap drive the status, even at 100% used (memory in use decides the page)", () => {
    const v = judgeDbSaturation(read({ swapFreeBytes: 0 })); // 100% swap used
    expect(v.status).toBe("ok");
    expect(swapWarrantsWhisper(v.swapUsedPct)).toBe(true);
  });

  it("swapWarrantsWhisper is false below the swap line and for a null", () => {
    expect(swapWarrantsWhisper(5)).toBe(false);
    expect(swapWarrantsWhisper(10)).toBe(true);
    expect(swapWarrantsWhisper(null)).toBe(false);
  });

  it("is unreadable when total or available memory is missing, or the figures cannot be true", () => {
    expect(judgeDbSaturation(read({ totalBytes: null })).status).toBe("unreadable");
    expect(judgeDbSaturation(read({ availableBytes: null })).status).toBe("unreadable");
    expect(judgeDbSaturation(read({ totalBytes: 0 })).status).toBe("unreadable");
    // More available than exists, or a negative figure, is a broken read, never a healthy one.
    expect(judgeDbSaturation(read({ availableBytes: 2 * GB })).status).toBe("unreadable");
    expect(judgeDbSaturation(read({ availableBytes: -1 })).status).toBe("unreadable");
  });

  it("reports committed memory against the commit limit but never lets it drive the status", () => {
    // A hedge, not a judge: Supabase's image appears to leave the kernel's heuristic
    // overcommit on, where the limit is not enforced, but that could not be read from the
    // live database. So the figure only ever whispers, at 95, and never pages.
    const v = judgeDbSaturation(read({ committedBytes: 0.99 * GB }));
    expect(v.status).toBe("ok");
    expect(Math.round(v.committedPct ?? -1)).toBe(99);
    expect(commitLimitWarrantsWhisper(v.committedPct)).toBe(true);
  });

  it("a missing or zero commit limit is no reading of it, and never makes the whole check unreadable", () => {
    for (const over of [{ committedBytes: null }, { commitLimitBytes: null }, { commitLimitBytes: 0 }]) {
      const v = judgeDbSaturation(read(over));
      expect(v.status).toBe("ok");
      expect(v.committedPct).toBeNull();
    }
  });

  it("commitLimitWarrantsWhisper fires from 95, and not on the 2026-10-29 reading of 80.7", () => {
    expect(commitLimitWarrantsWhisper(80.7)).toBe(false);
    expect(commitLimitWarrantsWhisper(94.9)).toBe(false);
    expect(commitLimitWarrantsWhisper(95)).toBe(true);
    expect(commitLimitWarrantsWhisper(null)).toBe(false);
  });

  it("treats absent swap as zero pressure, judging on memory in use alone", () => {
    const v = judgeDbSaturation(read({ swapTotalBytes: null, swapFreeBytes: null }));
    expect(v.status).toBe("ok");
    expect(v.swapUsedPct).toBe(0);
  });
});

describe("the db-saturation copy (#3588)", () => {
  const verdict = (inUse: number, swapUsed: number, committed = 0.5) =>
    judgeDbSaturation({
      totalBytes: 1 * GB,
      availableBytes: (1 - inUse) * GB,
      swapTotalBytes: 1 * GB,
      swapFreeBytes: (1 - swapUsed) * GB,
      committedBytes: committed * GB,
      commitLimitBytes: 1 * GB,
    });
  const v = verdict(0.92, 0.5);
  for (const [name, text] of [
    ["alert", formatDbSaturationAlert(v)],
    ["warn", formatDbSaturationWarn(v)],
    ["recovery", formatDbSaturationRecovery()],
  ] as const) {
    it(`${name} copy leaks no undefined/NaN and does not open with Slate`, () => {
      expect(text).not.toMatch(/undefined|NaN|\[object Object\]/);
      expect(text.startsWith("Slate")).toBe(false);
      expect(text.length).toBeGreaterThan(0);
    });
  }

  it("no copy speaks of committed memory or a ceiling unless the commit limit is what tripped it", () => {
    for (const text of [formatDbSaturationAlert(v), formatDbSaturationWarn(v), formatDbSaturationRecovery()]) {
      expect(text).not.toMatch(/committed|ceiling/i);
    }
  });

  it("the page names the percent of memory in use", () => {
    expect(formatDbSaturationAlert(v)).toContain("92% of its memory is in use");
  });

  it("a warn on memory alone names that line and says nothing of swapping", () => {
    // The 2026-10-29 whisper said "a database that is swapping is already working harder
    // than it should" with swap at 0%: a sentence about a cause that was not present (L11).
    const text = formatDbSaturationWarn(verdict(0.85, 0));
    expect(text).toContain("85% of its memory is in use");
    expect(text).toContain("past the 80% early warning line");
    expect(text).not.toMatch(/swapping/i);
  });

  it("a warn on swap alone names the swap and does not claim memory crossed its line", () => {
    const text = formatDbSaturationWarn(verdict(0.5, 1));
    expect(text).toContain("50% of its memory is in use");
    expect(text).toContain("100% of its swap");
    expect(text).not.toContain("past the 80% early warning line");
  });

  it("a warn on the commit limit alone says what it is, that it may not be enforced, and does not call memory tight", () => {
    const text = formatDbSaturationWarn(verdict(0.3, 0, 0.97));
    expect(text).toContain("97% of the kernel's commit limit");
    expect(text).toContain("new connections");
    expect(text).toContain("30% of its memory is in use");
    expect(text).not.toMatch(/getting tight|swapping/i);
    expect(text).not.toContain("past the 80% early warning line");
  });

  it("the commit limit stays out of a warn it did not trip", () => {
    expect(formatDbSaturationWarn(verdict(0.85, 0, 0.9))).not.toMatch(/commit limit/i);
  });

  it("a warn on both names both", () => {
    const text = formatDbSaturationWarn(verdict(0.85, 0.4));
    expect(text).toContain("past the 80% early warning line");
    expect(text).toContain("40% of its swap");
  });
});

describe("runDbSaturationCheck (#3588)", () => {
  beforeEach(() => vi.clearAllMocks());
  const run = (loadMetrics: () => Promise<string>) =>
    runDbSaturationCheck({
      loadMetrics,
      cooldownMs: { page: 30 * 60_000, warn: 60 * 60_000 },
    });

  it("lets a metrics read error THROW (so the step-failure watchdog catches a blind spot), clearing nothing first", async () => {
    await expect(
      run(async () => {
        throw new Error("502");
      }),
    ).rejects.toThrow();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled(); // a blind tick must never clear a real page
    expect(clearFailureStreak).not.toHaveBeenCalled();
  });

  it("THROWS on an unparseable body (a renamed metric or an error page), rather than reading healthy", async () => {
    await expect(run(async () => "<html>bad gateway</html>")).rejects.toThrow(/unparseable|cannot be scored/i);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("clears the page condition on a measured healthy reading", async () => {
    const res = await run(async () => body(1 * GB, 0.5 * GB, 1 * GB, 1 * GB));
    expect(res.status).toBe("clear");
    expect(clearFailureStreak).toHaveBeenCalledWith(DB_SATURATION_KEY);
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String));
    expect(sendThrottledInfo).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("whispers in the warn band and resets the page streak, but does NOT resolve a standing page (hysteresis)", async () => {
    const res = await run(async () => body(1 * GB, 0.15 * GB, 1 * GB, 1 * GB));
    expect(res.status).toBe("warn");
    // Hysteresis: a reading at 85 is still elevated, so the page must not all-clear here, or a
    // reading oscillating across 90 would page and resolve over and over.
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).toHaveBeenCalledWith(DB_SATURATION_KEY); // debounce the page streak
    // The whisper throttles on the WARN cooldown, not the page's (they are tuned apart).
    expect(sendThrottledInfo).toHaveBeenCalledWith(DB_SATURATION_WARN_KEY, 60 * 60_000, expect.any(String));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("resolves the page only once the reading is fully back under the warn line (ok)", async () => {
    const res = await run(async () => body(1 * GB, 0.3 * GB, 1 * GB, 1 * GB)); // 70% in use, below the 80 warn line
    expect(res.status).toBe("clear");
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String));
    expect(sendThrottledInfo).not.toHaveBeenCalled();
  });

  it("resolves the page when memory in use recovers EVEN IF swap is still in use, and keeps whispering", async () => {
    // 60% in use (recovered), swap 100% used. Residual swap must not hold the memory page
    // open: the page resolves on memory in use alone, and the swap keeps whispering.
    const res = await run(async () => body(1 * GB, 0.4 * GB, 1 * GB, 0));
    expect(res.status).toBe("warn"); // still whispering about swap
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String)); // but the page IS resolved
    expect(sendThrottledInfo).toHaveBeenCalledWith(DB_SATURATION_WARN_KEY, 60 * 60_000, expect.any(String));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("whispers on committed memory near the commit limit with memory and swap healthy, and still resolves the page", async () => {
    const res = await run(async () => body(1 * GB, 0.7 * GB, 1 * GB, 1 * GB, { committed: 0.96 * GB, limit: 1 * GB }));
    expect(res.status).toBe("warn");
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String));
    expect(sendThrottledInfo).toHaveBeenCalledWith(DB_SATURATION_WARN_KEY, 60 * 60_000, expect.stringContaining("commit limit"));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("does not page on one tick over the threshold, only on a sustained streak", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false); // first tick: not sustained
    const res = await run(async () => body(1 * GB, 0.08 * GB, 1 * GB, 1 * GB));
    expect(res.status).toBe("saturated");
    expect(recordConsecutiveStreak).toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled(); // a page tick never clears
  });

  it("pages once the streak is sustained", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true); // sustained
    const res = await run(async () => body(1 * GB, 0.08 * GB, 1 * GB, 1 * GB));
    expect(res.status).toBe("saturated");
    // The page throttles on the PAGE cooldown.
    expect(sendThrottledAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, 30 * 60_000, expect.any(String));
  });
});

describe("fetchDbSaturationMetrics (#3588)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the privileged endpoint with Basic auth built from the Supabase secret key", async () => {
    // The load-bearing wiring: the password is the SAME secret key the whole server holds
    // (supabaseSecretKey), so there is no new secret to set, and the host is the app's own
    // NEXT_PUBLIC_SUPABASE_URL (publicSupabaseUrl). Proven here rather than asserted (L3).
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => "metrics body" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const out = await fetchDbSaturationMetrics();
      expect(out).toBe("metrics body");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://ref.supabase.co/customer/v1/privileged/metrics");
      const expectedAuth = "Basic " + Buffer.from("service_role:sb_secret_test_key").toString("base64");
      expect((init as RequestInit).headers).toMatchObject({ Authorization: expectedAuth });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on a non-ok response (a wrong key's 401 or a dead endpoint), so it pages loud rather than reading blind", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, status: 401, text: async () => "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchDbSaturationMetrics()).rejects.toThrow(/401/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not double the slash when the configured URL has a trailing one", async () => {
    publicSupabaseUrl.mockReturnValueOnce("https://ref.supabase.co/");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchDbSaturationMetrics();
      expect(fetchMock.mock.calls[0]![0]).toBe("https://ref.supabase.co/customer/v1/privileged/metrics");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
