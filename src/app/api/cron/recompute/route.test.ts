import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Denial guard for the recompute cron (#676) + heartbeat wiring (#685). An
// unauthenticated caller is rejected with 401 before any lock or bucket work; a
// successful tick stamps the 'recompute' lane's dead-man's-switch heartbeat.
// The recompute LOGIC lives in the precompute-cron unit tests; this pins glue.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => false) }));
const locks = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => "lease"),
  releaseLock: vi.fn(async () => {}),
}));
// Drained headroom + no due/stale buckets = the quiet happy path (no alerts).
const admin = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({
    from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
    // The behind-streak tracker on the NOT-drained path (#1151 tests drive it).
    rpc: async () => ({ data: true, error: null }),
  })),
}));
const pace = vi.hoisted(() => ({ withinBudget: vi.fn(() => true) }));
const precompute = vi.hoisted(() => ({
  listPoolBuckets: vi.fn(async () => [] as unknown[]),
  listKnownBucketSlotRows: vi.fn(async () => []),
  // #1301/#1304: the deliberate-invalidation marker. `absent` is the NORMAL state
  // (nobody invalidated anything), and it is deliberately distinct from
  // `unreadable`, which is a failed read and gets a few ticks of tolerance.
  readMassInvalidationMarker: vi.fn(async (): Promise<{ state: string; atMs?: number }> => ({
    state: "absent",
  })),
  clearMassInvalidation: vi.fn(async () => {}),
}));
const precomputeCron = vi.hoisted(() => ({
  bucketsDueForRecompute: vi.fn((..._a: unknown[]) => [] as string[]),
  staleBuckets: vi.fn(() => []),
  recomputeHeadroom: vi.fn(() => ({ drained: true, utilizationPct: 0 })),
  recomputeDueBuckets: vi.fn(async (..._a: unknown[]) => 0),
}));
const slotCache = vi.hoisted(() => ({
  recomputeBucketSlotsForToday: vi.fn(async () => {}),
  recomputePoolSlotsForToday: vi.fn(async (..._a: unknown[]) => 0),
}));
const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveRecovered: vi.fn(async (_r: { key: string; text: string }[]) => [] as string[]),
}));
const alerts = vi.hoisted(() => ({ isConsecutiveFailure: vi.fn(() => false) }));
const heartbeat = vi.hoisted(() => ({ recordHeartbeat: vi.fn(async () => {}) }));

vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/locks", () => locks);
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/google/sync-pace", () => pace);
vi.mock("@/lib/google/sync-coalesce", () => ({ RECOMPUTE_LOCK_TTL_MS: 1000 }));
vi.mock("@/lib/availability/precompute", () => precompute);
// Spread the REAL module so `staleBucketPage` stays real: the grace decision is
// what these tests are about, and a mocked verdict would only prove the mock.
vi.mock("@/lib/availability/precompute-cron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/availability/precompute-cron")>()),
  ...precomputeCron,
}));
vi.mock("@/lib/availability/slot-cache", () => slotCache);
vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/notify/alerts", () => alerts);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);
// #3460: the pool grouping publish. Its own decisions (refusing an empty grouping, what
// counts as published) are pinned by pool-grouping-live.test.ts; here it is a seam.
const grouping = vi.hoisted(() => ({
  publishPoolGrouping: vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean; kind: string }> => ({ ok: true, kind: "stored" })),
}));
vi.mock("@/lib/booking/pool-grouping-live", () => grouping);
// #3388: the lane reads eligibility through the DATED cache reader, so its rows can be
// stamped from when the list was read.
const eligibleCache = vi.hoisted(() => ({
  readEligibleCached: vi.fn(async (_b: unknown) => ({
    agents: { ids: ["a1"], fallbackApplied: false },
    readAtMs: 1,
  })),
}));
vi.mock("@/lib/availability/eligible-cache", () => eligibleCache);

import { GET } from "./route";
import { POOL_GROUPING_LANE } from "@/lib/monitor/health";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/recompute", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
  });

  // #3460: the lane publishes the pool grouping it ALREADY reads, so cold servers can key
  // their confirm line from it. Before its lock, because a tick that finds the lock held
  // is skipped, and a skipped minute must not leave the snapshot to go stale (L614).
  describe("the pool grouping publish (#3460)", () => {
    const rows = [
      { code: "510", orgId: "o", eventTypeId: "e", criteria: { debt_team: "high" }, fallbackUserId: null, memberIds: [] },
      { code: "511", orgId: "o", eventTypeId: "e", criteria: { debt_team: "high" }, fallbackUserId: null, memberIds: [] },
    ];
    beforeEach(() => {
      cron.isAuthorizedCron.mockReturnValue(true);
      precompute.listPoolBuckets.mockResolvedValue(rows);
      grouping.publishPoolGrouping.mockResolvedValue({ ok: true, kind: "stored" });
      locks.acquireLock.mockResolvedValue("lease");
    });
    afterEach(() => {
      // Back to the file's defaults, so no later case inherits an authorised caller or rows.
      cron.isAuthorizedCron.mockReturnValue(false);
      precompute.listPoolBuckets.mockResolvedValue([]);
    });

    it("publishes the grouping it read, stamped with the read's start, before it takes its lock", async () => {
      const before = Date.now();
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(grouping.publishPoolGrouping).toHaveBeenCalledTimes(1);
      const [entries, readAtMs] = grouping.publishPoolGrouping.mock.calls[0]!;
      expect((entries as [string, string][]).map(([c]) => c)).toEqual(["510", "511"]);
      expect(readAtMs as number).toBeGreaterThanOrEqual(before);
      expect(grouping.publishPoolGrouping.mock.invocationCallOrder[0]!).toBeLessThan(locks.acquireLock.mock.invocationCallOrder[0]!);
      // With NO new read: the lane's one bucket list feeds both the publish and the recompute.
      expect(precompute.listPoolBuckets).toHaveBeenCalledTimes(1);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith(POOL_GROUPING_LANE);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("recompute");
    });

    it("still publishes on a tick skipped for an overlapping run", async () => {
      locks.acquireLock.mockResolvedValueOnce(null as never);
      const res = await GET(req());
      expect(await res.json()).toEqual({ skipped: "overlapping-run" });
      expect(grouping.publishPoolGrouping).toHaveBeenCalledTimes(1);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith(POOL_GROUPING_LANE);
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith("recompute");
    });

    // Review of #3470: a transient failure of the publish's read must never take down the
    // recompute lane. The read sits in its own step boundary; on failure nothing is
    // published, and the tick runs exactly as it did before #3460, reading the buckets
    // inside its own handling.
    it("leaves the tick's result and status unchanged when the publish's read fails", async () => {
      const baseline = await GET(req());
      const baselineBody = await baseline.json();
      vi.clearAllMocks();
      precompute.listPoolBuckets.mockRejectedValueOnce(new Error("bucket read timed out"));
      const res = await GET(req());
      expect(res.status).toBe(baseline.status);
      expect(await res.json()).toEqual(baselineBody);
      expect(grouping.publishPoolGrouping).not.toHaveBeenCalled();
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith(POOL_GROUPING_LANE);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("recompute");
      // The lane read for itself, as it always has, after the publish's read failed.
      expect(precompute.listPoolBuckets).toHaveBeenCalledTimes(2);
    });

    it("still fails the tick, as before #3460, when the lane's OWN read fails too", async () => {
      precompute.listPoolBuckets.mockRejectedValue(new Error("buckets unreadable"));
      await expect(GET(req())).rejects.toThrow("buckets unreadable");
      expect(locks.releaseLock).toHaveBeenCalled();
      precompute.listPoolBuckets.mockResolvedValue(rows);
    });

    // Review of #3470: a publish the directory KEPT a newer snapshot over says the
    // directory is fresh, not that THIS publisher's read is, so it stamps nothing.
    it("stamps the grouping heartbeat only when the directory stored this tick's snapshot", async () => {
      grouping.publishPoolGrouping.mockResolvedValueOnce({ ok: true, kind: "kept" });
      await GET(req());
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith(POOL_GROUPING_LANE);
      vi.clearAllMocks();
      await GET(req());
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith(POOL_GROUPING_LANE);
    });

    it("stamps no grouping heartbeat for a publish that did not land, and the lane carries on", async () => {
      grouping.publishPoolGrouping.mockResolvedValueOnce({ ok: false, kind: "unreachable" });
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith(POOL_GROUPING_LANE);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("recompute");
    });

    it("never lets a publish that throws take the lane down (its own step boundary, L73)", async () => {
      grouping.publishPoolGrouping.mockRejectedValueOnce(new Error("publish exploded"));
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(heartbeat.recordHeartbeat).not.toHaveBeenCalledWith(POOL_GROUPING_LANE);
      expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("recompute");
    });
  });

  // Multi-lane dead-man's switch (#685): a successful tick stamps THIS lane.
  it("stamps the 'recompute' heartbeat on a successful tick", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith("recompute");
  });

  // #1151: both of this lane's alerts describe CONDITIONS, so a healthy cycle
  // says they are over. Which conditions get cleared is driven by what the cycle
  // MEASURED, never by "we did not alert this tick". Since #2021 the headroom
  // side is a STREAK: one caught-up cycle is the wobble the page has to survive,
  // so the all-clear waits until the re-arm streak (driven here through the
  // `rate_limit_hit` double, keyed so the wrong streak cannot answer for it) has
  // reached its window.
  const rpcAnsweringReachedFor = (reachedKey: string) =>
    ({
      from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
      rpc: async (_fn: string, args: { p_key: string }) => ({
        data: args.p_key !== reachedKey,
        error: null,
      }),
    }) as never;

  it("clears only the stale condition on a drained cycle whose re-arm streak is not yet full", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys).toEqual(["bucket_slots_stale"]);
  });

  it("clears both conditions once the lane has kept up for the whole re-arm window", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue(rpcAnsweringReachedFor("cron_recompute_drained"));
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys.sort()).toEqual(["bucket_slots_stale", "recompute_headroom"]);
  });

  it("does not page on a behind cycle until the behind streak has reached its window", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.recomputeHeadroom.mockReturnValueOnce({ drained: false, utilizationPct: 110 });
    await GET(req());
    expect(dispatch.sendThrottledAlert.mock.calls.filter(([k]) => k === "recompute_headroom")).toHaveLength(0);
  });

  it("pages once the lane has been behind for the whole behind window", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue(rpcAnsweringReachedFor("cron_recompute_behind"));
    precomputeCron.recomputeHeadroom.mockReturnValueOnce({ drained: false, utilizationPct: 110 });
    await GET(req());
    const pages = dispatch.sendThrottledAlert.mock.calls.filter(([k]) => k === "recompute_headroom");
    expect(pages).toHaveLength(1);
    expect(String(pages[0][2])).toMatch(/minutes running/);
  });

  it("does not let a full re-arm streak fire the page, nor a full behind streak the all-clear", async () => {
    // The two streaks are under their own keys; a reached answer on the wrong one
    // must move nothing.
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue(rpcAnsweringReachedFor("cron_recompute_behind"));
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys).toEqual(["bucket_slots_stale"]);
    expect(dispatch.sendThrottledAlert.mock.calls.filter(([k]) => k === "recompute_headroom")).toHaveLength(0);
  });

  it("clears only the stale condition when the cycle did NOT drain its due list", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.recomputeHeadroom.mockReturnValueOnce({ drained: false, utilizationPct: 99 });
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys).toEqual(["bucket_slots_stale"]);
  });

  // The silent path (#1152): rows still stale means the condition is NOT over, so
  // that key must not be cleared even though the other one can be.
  it("clears only the headroom condition while rows are still stale", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue(rpcAnsweringReachedFor("cron_recompute_drained"));
    precomputeCron.staleBuckets.mockReturnValueOnce(["411", "412"] as never);
    await GET(req());
    const keys = (dispatch.resolveRecovered.mock.calls[0]?.[0] ?? []).map((r) => r.key);
    expect(keys).toEqual(["recompute_headroom"]);
  });

  // The silent path (#1152): a cycle that is BOTH behind and still stale has
  // measured nothing healthy, so it must announce nothing.
  it("sends NO all-clear when the cycle is behind and rows are still stale", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.recomputeHeadroom.mockReturnValueOnce({ drained: false, utilizationPct: 99 });
    precomputeCron.staleBuckets.mockReturnValueOnce(["411"] as never);
    await GET(req());
    expect(dispatch.resolveRecovered).not.toHaveBeenCalled();
  });

  it("still returns 200 when the heartbeat stamp fails (best-effort)", async () => {
    cron.isAuthorizedCron.mockReturnValueOnce(true);
    heartbeat.recordHeartbeat.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

// #1301: saving a booking setting marks EVERY bucket stale on purpose, and this
// lane cannot drain the whole roster inside the ~2 minutes between the freshness
// window and the stale alarm, so the save used to page about a condition it had
// just created. The real decision runs here (only the marker read is faked), so
// these pin the shipping path rather than a mocked verdict.
describe("the stale alarm during a deliberate invalidation", () => {
  const stalePages = () =>
    dispatch.sendThrottledAlert.mock.calls.filter(([key]) => key === "bucket_slots_stale");

  it("does not page while a recent invalidation is still draining", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411", "412", "511"] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "at", atMs: Date.now() - 30_000 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(stalePages()).toHaveLength(0);
  });

  it("pages anyway once the drain has had its grace and is still behind", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411", "412"] as never);
    // 20 minutes, past the 15 minute grace: this is no longer a draining save, it
    // is the fall-behind the alarm exists for.
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "at", atMs: Date.now() - 20 * 60_000 });
    await GET(req());
    expect(stalePages()).toHaveLength(1);
  });

  it("still pages immediately when nothing explains the staleness", async () => {
    // The regression guard: the grace must not have quietly become a blanket delay
    // on every stale alarm.
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411"] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "absent" });
    await GET(req());
    expect(stalePages()).toHaveLength(1);
  });

  it("rides out an unreadable marker for a few ticks, then pages (#1304)", async () => {
    // Dan: "retry and page only after three consecutive failures", so a transient
    // database blip does not wake anyone. The streak lives in `rate_limit_hit`,
    // which the admin double answers, so `data: true` here means UNDER the
    // threshold and the tick must stay quiet.
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue({
      from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411"] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "unreadable" });
    await GET(req());
    expect(stalePages()).toHaveLength(0);
  });

  it("pages once the marker has been unreadable on enough consecutive ticks", async () => {
    // `data: false` is over the threshold: the streak reached its tolerance. A
    // withheld page past that point means the booker serves stale times with
    // nothing saying so.
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue({
      from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
      rpc: async () => ({ data: false, error: null }),
    } as never);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411"] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "unreadable" });
    await GET(req());
    expect(stalePages()).toHaveLength(1);
    // And the copy must not claim a measured fall-behind: nothing about the drain
    // was measured, because the value that would have explained it is unavailable.
    // #2815: the plain wording says the check "could not be read".
    expect(String(stalePages()[0][2])).toMatch(/could not be read/i);
  });

  it("still pages immediately for an ABSENT marker, whatever the unreadable streak says", async () => {
    // The tolerance must apply ONLY to a failed read. Absent is the normal state,
    // so letting it inherit the delay would make this alarm three minutes late
    // every time it mattered.
    cron.isAuthorizedCron.mockReturnValue(true);
    admin.supabaseAdmin.mockReturnValue({
      from: () => ({ delete: () => ({ eq: async () => ({}) }) }),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    precomputeCron.staleBuckets.mockReturnValueOnce(["411"] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "absent" });
    await GET(req());
    expect(stalePages()).toHaveLength(1);
  });

  it("drops the marker once the drain has finished, so the next staleness pages at once", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.staleBuckets.mockReturnValueOnce([] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "at", atMs: Date.now() - 30_000 });
    await GET(req());
    expect(precompute.clearMassInvalidation).toHaveBeenCalledTimes(1);
  });

  it("does not touch the marker on an ordinary healthy tick", async () => {
    // No marker on record, so no delete: this lane runs every minute and shares a
    // subrequest budget with three others.
    cron.isAuthorizedCron.mockReturnValue(true);
    precomputeCron.staleBuckets.mockReturnValueOnce([] as never);
    precompute.readMassInvalidationMarker.mockResolvedValueOnce({ state: "absent" });
    await GET(req());
    expect(precompute.clearMassInvalidation).not.toHaveBeenCalled();
  });
});

// #2245: the lane's saving is that it runs the availability compute once per
// POOL rather than once per code. Sixty codes resolve to fifteen pools, so three
// quarters of this lane's work was duplicated.
//
// The pure halves (which codes share a pool, when a pool falls due, how one
// answer is written to every code with its own identity) are node tested. What
// is only visible here is the WIRING: that the lane groups before it dispatches,
// and hands the whole pool over rather than one code at a time. A regression to
// per code dispatch leaves every pure test green.
describe("one compute per pool", () => {
  const pooled = (code: string, criteria: Record<string, string>) => ({
    code,
    bucket: { id: `id-${code}`, code, criteria },
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria,
    fallbackUserId: null,
    memberIds: [] as string[],
  });
  const matrix = [
    ...["100", "101", "102", "110", "111", "112"].map((c) => pooled(c, { debt_team: "low" })),
    ...["120", "121", "122"].map((c) =>
      pooled(c, { debt_team: "low", backend_service: "beyond" }),
    ),
  ];

  /**
   * Stand in for the drain, which has its own unit tests: run every unit and SUM
   * what each reported, which is the real function's contract since a unit
   * stands for a whole pool. A stand in that returned the unit COUNT would let
   * the route's reported total be wrong while this file stayed green.
   */
  const drainAll = async (
    units: unknown[],
    run: (u: unknown) => Promise<number | void>,
  ): Promise<number> => {
    let total = 0;
    for (const u of units) {
      const v = await run(u);
      total += typeof v === "number" ? v : 1;
    }
    return total;
  };

  it("dispatches whole pools, not codes", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precompute.listPoolBuckets.mockResolvedValueOnce(matrix);
    precomputeCron.bucketsDueForRecompute.mockImplementation(
      (...a: unknown[]) => a[1] as string[],
    );
    precomputeCron.recomputeDueBuckets.mockImplementationOnce(drainAll as never);

    await GET(req());

    expect(slotCache.recomputePoolSlotsForToday).toHaveBeenCalledTimes(2);
    const dispatched = slotCache.recomputePoolSlotsForToday.mock.calls
      .map((call) => (call[0] as { code: string }[]).map((b) => b.code).sort().join(" "))
      .sort();
    expect(dispatched).toEqual(["100 101 102 110 111 112", "120 121 122"]);
    // #3381: every row the lane writes says the lane wrote it.
    expect(slotCache.recomputePoolSlotsForToday.mock.calls.map((call) => call[1])).toEqual(["lane", "lane"]);
    // #3388: the reader handed to each pool is the dated cache reader, whose answer
    // carries the read time the pool's rows are stamped from.
    const reader = slotCache.recomputePoolSlotsForToday.mock.calls[0]![2] as (b: unknown) => Promise<unknown>;
    const bucket = { id: "id-100" };
    await expect(reader(bucket)).resolves.toEqual({ agents: { ids: ["a1"], fallbackApplied: false }, readAtMs: 1 });
    expect(eligibleCache.readEligibleCached).toHaveBeenCalledWith(bucket);
  });

  it("reports every pool's writes, not just the last one to finish", async () => {
    // The defect this pins shipped on 2026-09-11. The route accumulated with
    // `recomputed += await ...` inside a concurrent wave, which reads the
    // variable BEFORE awaiting, so both pools added to zero and the second
    // overwrote the first. Production reported one pool's worth as the whole
    // cycle, judged itself behind on every tick, and was five cycles from a page
    // about a fall behind that was not happening.
    //
    // The drain here runs both units CONCURRENTLY, because a serial stand in
    // cannot reproduce a lost update.
    cron.isAuthorizedCron.mockReturnValue(true);
    precompute.listPoolBuckets.mockResolvedValueOnce(matrix);
    precomputeCron.bucketsDueForRecompute.mockImplementation(
      (...a: unknown[]) => a[1] as string[],
    );
    precomputeCron.recomputeDueBuckets.mockImplementationOnce((async (
      units: unknown[],
      run: (u: unknown) => Promise<number | void>,
    ) => {
      const settled = await Promise.all(units.map((u) => run(u)));
      return settled.reduce<number>((n, v) => n + (typeof v === "number" ? v : 1), 0);
    }) as never);
    slotCache.recomputePoolSlotsForToday.mockImplementation(async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 0));
      return (a[0] as unknown[]).length;
    });

    const body = await (await GET(req())).json();
    // Six codes in the Low pool plus three in Low with Beyond.
    expect(body.recomputed).toBe(9);
    expect(body.due).toBe(9);
    expect(body.drained).toBe(true);
  });

  it("still reports its totals in BUCKETS, so the headroom numbers keep their meaning", async () => {
    cron.isAuthorizedCron.mockReturnValue(true);
    precompute.listPoolBuckets.mockResolvedValueOnce(matrix);
    precomputeCron.bucketsDueForRecompute.mockImplementation(
      (...a: unknown[]) => a[1] as string[],
    );
    precomputeCron.recomputeDueBuckets.mockImplementationOnce(drainAll as never);
    slotCache.recomputePoolSlotsForToday.mockImplementation(
      async (...a: unknown[]) => (a[0] as unknown[]).length,
    );

    const body = await (await GET(req())).json();
    expect(body.buckets).toBe(9);
    expect(body.due).toBe(9);
    expect(body.recomputed).toBe(9);
  });
});
