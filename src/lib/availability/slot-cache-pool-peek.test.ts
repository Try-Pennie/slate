import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3325: the confirm line asks which pool a code is in WITHOUT waiting for a read,
// because a confirm joining its line before any read is the whole point (#3257). So
// the per isolate grouping the post confirm refresh already keeps is offered as a
// look that never reads (`peekPoolKey`) and a warm up that reads at most once at a
// time (`warmPoolKeys`), scheduled after the response. These pin both.

const precompute = vi.hoisted(() => ({
  listPoolBuckets: vi.fn(async (): Promise<unknown[]> => []),
  bucketsForAgent: vi.fn(),
  computeBucketSlotsForWindow: vi.fn(),
  writeBucketSlotsRow: vi.fn(),
  storeBucketSlotsRow: vi.fn(),
  recomputeBucketSlots: vi.fn(),
  readBucketSlotsRow: vi.fn(),
  touchedBucketCodes: vi.fn(),
}));
vi.mock("./precompute", () => precompute);
vi.mock("./service", () => ({ getBucketSlots: vi.fn() }));
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function pooled(code: string, debtTeam: string) {
  return { code, bucket: { id: `id-${code}`, code }, orgId: "org-1", eventTypeId: "event-1", criteria: { debt_team: debtTeam }, fallbackUserId: null, memberIds: [] };
}

describe("peekPoolKey and warmPoolKeys (#3325)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    precompute.listPoolBuckets.mockReset();
    precompute.listPoolBuckets.mockResolvedValue([pooled("510", "high"), pooled("511", "high"), pooled("410", "mid")]);
  });
  afterEach(() => vi.useRealTimers());

  it("knows nothing on a fresh isolate, and never reads to find out", async () => {
    const { peekPoolKey } = await import("./slot-cache");
    expect(peekPoolKey("510")).toBeUndefined();
    expect(precompute.listPoolBuckets).not.toHaveBeenCalled();
  });

  it("answers from one warm up: a pool for a known code, null for a code with no bucket", async () => {
    const { peekPoolKey, warmPoolKeys } = await import("./slot-cache");
    await Promise.all([warmPoolKeys(), warmPoolKeys(), warmPoolKeys()]);
    expect(precompute.listPoolBuckets).toHaveBeenCalledTimes(1);
    expect(typeof peekPoolKey("510")).toBe("string");
    expect(peekPoolKey("510")).toBe(peekPoolKey("511"));
    expect(peekPoolKey("510")).not.toBe(peekPoolKey("410"));
    expect(peekPoolKey("999")).toBeNull();
  });

  it("goes back to unknown once the grouping is a minute old, and a warm up refreshes it", async () => {
    const { peekPoolKey, warmPoolKeys } = await import("./slot-cache");
    await warmPoolKeys();
    vi.setSystemTime(new Date("2026-10-05T12:01:01.000Z"));
    expect(peekPoolKey("510")).toBeUndefined();
    await warmPoolKeys();
    expect(precompute.listPoolBuckets).toHaveBeenCalledTimes(2);
    expect(typeof peekPoolKey("510")).toBe("string");
  });

  it("stays unknown, never empty, when the warm up's read fails", async () => {
    precompute.listPoolBuckets.mockRejectedValueOnce(new Error("read failed"));
    const { peekPoolKey, warmPoolKeys } = await import("./slot-cache");
    await expect(warmPoolKeys()).rejects.toThrow("read failed");
    expect(peekPoolKey("510")).toBeUndefined();
  });
});
