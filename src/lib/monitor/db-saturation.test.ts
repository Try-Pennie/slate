import { describe, it, expect, vi, beforeEach } from "vitest";

// #3588: the database's own memory pressure must page directly, early, instead of
// surfacing as the availability latency a lead already felt. What is under test is the
// DECISION: the Prometheus parse (a missing or garbage metric is unreadable, never a
// guessed number), the judge (ok/warn/page by committed percent, swap corroborating), and
// that a reading it cannot take does NEITHER page nor clear (#1134, #1169).
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

/** A realistic metrics body at a given committed/limit and swap, in node_exporter shape. */
const body = (committed: number, limit: number, swapTotal: number, swapFree: number): string =>
  [
    "# HELP node_memory_Committed_AS_bytes committed address space",
    "# TYPE node_memory_Committed_AS_bytes gauge",
    `${DB_METRIC_NAMES.committed} ${committed}`,
    `${DB_METRIC_NAMES.limit} ${limit}`,
    `${DB_METRIC_NAMES.swapTotal} ${swapTotal}`,
    `${DB_METRIC_NAMES.swapFree} ${swapFree}`,
    "node_memory_MemFree_bytes 123456",
  ].join("\n");

describe("parseDbMemoryMetrics (#3588)", () => {
  it("reads the four memory gauges from a Prometheus body", () => {
    const r = parseDbMemoryMetrics(body(1.55 * GB, 1.69 * GB, 2 * GB, 1.8 * GB));
    expect(r.committedBytes).toBe(1.55 * GB);
    expect(r.limitBytes).toBe(1.69 * GB);
    expect(r.swapTotalBytes).toBe(2 * GB);
    expect(r.swapFreeBytes).toBe(1.8 * GB);
  });

  it("tolerates a label set on the gauge line", () => {
    const text = `${DB_METRIC_NAMES.committed}{instance="db"} 42\n${DB_METRIC_NAMES.limit} 100`;
    expect(parseDbMemoryMetrics(text).committedBytes).toBe(42);
  });

  it("tolerates an optional Prometheus timestamp trailing the value", () => {
    const text = `${DB_METRIC_NAMES.committed} 42 1700000000000\n${DB_METRIC_NAMES.limit} 100`;
    expect(parseDbMemoryMetrics(text).committedBytes).toBe(42);
    expect(parseDbMemoryMetrics(text).limitBytes).toBe(100);
  });

  it("returns null for a metric that is absent, never a guess", () => {
    const text = `${DB_METRIC_NAMES.committed} 42`; // no limit/swap lines
    const r = parseDbMemoryMetrics(text);
    expect(r.committedBytes).toBe(42);
    expect(r.limitBytes).toBeNull();
    expect(r.swapTotalBytes).toBeNull();
  });

  it("returns null for a non-numeric value", () => {
    const text = `${DB_METRIC_NAMES.committed} not-a-number\n${DB_METRIC_NAMES.limit} 100`;
    expect(parseDbMemoryMetrics(text).committedBytes).toBeNull();
  });

  it("does not match a metric name as a substring of another", () => {
    // Only a longer-named metric is present; the short name must not match inside it.
    const text = "node_memory_Committed_AS_bytes_total 999";
    expect(parseDbMemoryMetrics(text).committedBytes).toBeNull();
  });

  it("reads a garbage body as all nulls, which the judge turns into unreadable", () => {
    const r = parseDbMemoryMetrics("<html>502 Bad Gateway</html>");
    expect([r.committedBytes, r.limitBytes, r.swapTotalBytes, r.swapFreeBytes]).toEqual([null, null, null, null]);
  });
});

describe("judgeDbSaturation (#3588)", () => {
  const read = (over: Partial<DbMemoryReading> = {}): DbMemoryReading => ({
    committedBytes: 0.5 * GB,
    limitBytes: 1 * GB,
    swapTotalBytes: 1 * GB,
    swapFreeBytes: 1 * GB, // no swap used
    ...over,
  });

  it("is ok below the warn threshold", () => {
    expect(judgeDbSaturation(read({ committedBytes: 0.7 * GB })).status).toBe("ok");
  });

  it("warns from 80 up to but not including 90", () => {
    expect(judgeDbSaturation(read({ committedBytes: 0.8 * GB })).status).toBe("warn");
    expect(judgeDbSaturation(read({ committedBytes: 0.899 * GB })).status).toBe("warn");
  });

  it("pages at 90 and above (the 2026-10-10 incident sat at ~92)", () => {
    expect(judgeDbSaturation(read({ committedBytes: 0.9 * GB })).status).toBe("page");
    expect(judgeDbSaturation(read({ committedBytes: 0.92 * GB })).status).toBe("page");
  });

  it("keeps the status COMMITTED-only: swap in use does not change the status, it is reported apart", () => {
    const v = judgeDbSaturation(read({ committedBytes: 0.5 * GB, swapFreeBytes: 0.8 * GB })); // 20% swap used
    expect(v.status).toBe("ok"); // committed is 50%, so the committed-only status is ok
    expect(Math.round(v.swapUsedPct ?? -1)).toBe(20);
    expect(swapWarrantsWhisper(v.swapUsedPct)).toBe(true); // the swap is what the runner whispers on
  });

  it("never lets swap drive the status, even at 100% used (committed decides the page)", () => {
    const v = judgeDbSaturation(read({ committedBytes: 0.5 * GB, swapFreeBytes: 0 })); // 100% swap used
    expect(v.status).toBe("ok");
    expect(swapWarrantsWhisper(v.swapUsedPct)).toBe(true);
  });

  it("swapWarrantsWhisper is false below the swap line and for a null", () => {
    expect(swapWarrantsWhisper(5)).toBe(false);
    expect(swapWarrantsWhisper(10)).toBe(true);
    expect(swapWarrantsWhisper(null)).toBe(false);
  });

  it("is unreadable when committed or the ceiling is missing", () => {
    expect(judgeDbSaturation(read({ committedBytes: null })).status).toBe("unreadable");
    expect(judgeDbSaturation(read({ limitBytes: null })).status).toBe("unreadable");
    expect(judgeDbSaturation(read({ limitBytes: 0 })).status).toBe("unreadable");
  });

  it("treats absent swap as zero pressure, judging on committed alone", () => {
    const v = judgeDbSaturation(read({ committedBytes: 0.5 * GB, swapTotalBytes: null, swapFreeBytes: null }));
    expect(v.status).toBe("ok");
    expect(v.swapUsedPct).toBe(0);
  });
});

describe("the db-saturation copy (#3588)", () => {
  const v = judgeDbSaturation({ committedBytes: 0.92 * GB, limitBytes: 1 * GB, swapTotalBytes: 1 * GB, swapFreeBytes: 0.5 * GB });
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

  it("the warn copy prints the real figures and frames the two lines as a disjunction, not a false claim", () => {
    // committed 50%, swap 100% used -> warn on swap alone. The copy must print the ACTUAL
    // committed figure and must not state committed crossed its line, because here it did
    // not; it names both thresholds as a disjunction instead (L11).
    const v = judgeDbSaturation({ committedBytes: 0.5 * GB, limitBytes: 1 * GB, swapTotalBytes: 1 * GB, swapFreeBytes: 0 });
    const text = formatDbSaturationWarn(v);
    expect(text).toContain("committed memory is at 50%"); // the real committed figure, stated plainly
    expect(text).toContain("swap is 100% used"); // the real swap figure
    // The disjunction names both lines without asserting committed specifically exceeded 80.
    expect(text).toContain("committed over 80%, or swap over 10% used");
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
    const res = await run(async () => body(0.5 * GB, 1 * GB, 1 * GB, 1 * GB));
    expect(res.status).toBe("clear");
    expect(clearFailureStreak).toHaveBeenCalledWith(DB_SATURATION_KEY);
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String));
    expect(sendThrottledInfo).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("whispers in the warn band and resets the page streak, but does NOT resolve a standing page (hysteresis)", async () => {
    const res = await run(async () => body(0.85 * GB, 1 * GB, 1 * GB, 1 * GB));
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
    const res = await run(async () => body(0.7 * GB, 1 * GB, 1 * GB, 1 * GB)); // 70%, below the 80 warn line
    expect(res.status).toBe("clear");
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String));
    expect(sendThrottledInfo).not.toHaveBeenCalled();
  });

  it("resolves the page when committed recovers EVEN IF swap is still in use, and keeps whispering", async () => {
    // committed 60% (recovered), swap 100% used. Residual swap must not hold the committed
    // page open: the page resolves on committed alone, and the swap keeps whispering.
    const res = await run(async () => body(0.6 * GB, 1 * GB, 1 * GB, 0));
    expect(res.status).toBe("warn"); // still whispering about swap
    expect(resolveAlert).toHaveBeenCalledWith(DB_SATURATION_KEY, expect.any(String)); // but the page IS resolved
    expect(sendThrottledInfo).toHaveBeenCalledWith(DB_SATURATION_WARN_KEY, 60 * 60_000, expect.any(String));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("does not page on one tick over the threshold, only on a sustained streak", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false); // first tick: not sustained
    const res = await run(async () => body(0.92 * GB, 1 * GB, 1 * GB, 1 * GB));
    expect(res.status).toBe("saturated");
    expect(recordConsecutiveStreak).toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled(); // a page tick never clears
  });

  it("pages once the streak is sustained", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true); // sustained
    const res = await run(async () => body(0.92 * GB, 1 * GB, 1 * GB, 1 * GB));
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
