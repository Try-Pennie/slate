import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3325: the confirm line asks which pool a code is in through `peekPoolKey`, a look at
// the grouping this server holds, and `warmPoolKeys` refreshes that grouping at most one
// read at a time, after the response.
//
// #3460 changed where a server's grouping can come from. #3325 shipped "a confirm never
// reads before its line", and the test that pinned it ("knows nothing on a fresh
// isolate, and never reads to find out") is retired rather than adjusted: a confirm on a
// server holding nothing now waits, within a short bound, for the grouping the recompute
// lane published (#3355 items 1 and 2, `confirm-line-live.ts`). What this file pins is
// the server's half: the grouping its own read installs, the snapshot installed beside
// it, which of the two wins, and that its own read publishes what it read.

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
const publish = vi.hoisted(() => ({ publishPoolGroupingAfterResponse: vi.fn() }));
vi.mock("@/lib/booking/pool-grouping-live", () => publish);

function pooled(code: string, debtTeam: string) {
  return { code, bucket: { id: `id-${code}`, code }, orgId: "org-1", eventTypeId: "event-1", criteria: { debt_team: debtTeam }, fallbackUserId: null, memberIds: [] };
}

const T0 = new Date("2026-10-05T12:00:00.000Z").getTime();

describe("the server's pool grouping (#3325, #3460)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    precompute.listPoolBuckets.mockReset();
    precompute.listPoolBuckets.mockResolvedValue([pooled("510", "high"), pooled("511", "high"), pooled("410", "mid")]);
    publish.publishPoolGroupingAfterResponse.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("answers a snapshot installed into it, under the snapshot's own read time, and expires it with that time", async () => {
    const { peekPoolKey, lineGroupingStore } = await import("./slot-cache");
    expect(peekPoolKey("510")).toBeUndefined();
    expect(lineGroupingStore.install([["510", "pool-high"], ["511", "pool-high"]], T0 - 50_000, "snapshot")).toBe(true);
    expect(peekPoolKey("510")).toBe("pool-high");
    expect(peekPoolKey("410")).toBeNull();
    vi.setSystemTime(new Date(T0 + 10_001));
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

  it("publishes what its own read found, after the response, under the read's start time", async () => {
    const { warmPoolKeys, lineGroupingStore } = await import("./slot-cache");
    await warmPoolKeys();
    expect(publish.publishPoolGroupingAfterResponse).toHaveBeenCalledTimes(1);
    const [entries, readAtMs] = publish.publishPoolGroupingAfterResponse.mock.calls[0]!;
    expect((entries as [string, string][]).map(([c]) => c)).toEqual(["410", "510", "511"]);
    expect(readAtMs).toBe(T0);
    expect(lineGroupingStore.held()).toEqual({ readAtMs: T0, origin: "read" });
  });

  it("never puts an older read back over a newer snapshot that landed while it was reading (L751)", async () => {
    let release: (rows: unknown[]) => void = () => {};
    precompute.listPoolBuckets.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { warmPoolKeys, lineGroupingStore, peekPoolKey } = await import("./slot-cache");
    const warming = warmPoolKeys();
    // The read started at T0; a snapshot read a second later lands before it finishes.
    lineGroupingStore.install([["510", "pool-from-snapshot"], ["511", "pool-from-snapshot"], ["410", "pool-mid"]], T0 + 1_000, "snapshot");
    release([pooled("510", "high"), pooled("511", "high"), pooled("410", "mid")]);
    await warming;
    expect(lineGroupingStore.held()).toEqual({ readAtMs: T0 + 1_000, origin: "snapshot" });
    expect(peekPoolKey("510")).toBe("pool-from-snapshot");
  });

  it("installs and publishes nothing from an empty bucket list, which would read every code as a gap", async () => {
    precompute.listPoolBuckets.mockResolvedValue([]);
    const { warmPoolKeys, peekPoolKey } = await import("./slot-cache");
    await warmPoolKeys();
    expect(peekPoolKey("510")).toBeUndefined();
    expect(publish.publishPoolGroupingAfterResponse).not.toHaveBeenCalled();
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

  it("skips the warm up when a fresh snapshot is already held, so the snapshot saves the two table reads", async () => {
    const { warmPoolKeys, lineGroupingStore } = await import("./slot-cache");
    lineGroupingStore.install([["510", "pool-high"]], T0 - 5_000, "snapshot");
    await warmPoolKeys();
    expect(precompute.listPoolBuckets).not.toHaveBeenCalled();
  });

  it("stays unknown, never empty, when the warm up's read fails", async () => {
    precompute.listPoolBuckets.mockRejectedValueOnce(new Error("read failed"));
    const { peekPoolKey, warmPoolKeys } = await import("./slot-cache");
    await expect(warmPoolKeys()).rejects.toThrow("read failed");
    expect(peekPoolKey("510")).toBeUndefined();
    expect(publish.publishPoolGroupingAfterResponse).not.toHaveBeenCalled();
  });
});
