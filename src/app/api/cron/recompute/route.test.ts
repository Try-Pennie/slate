import { describe, it, expect, vi, beforeEach } from "vitest";

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
  listAllBucketCodes: vi.fn(async () => []),
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
  bucketsDueForRecompute: vi.fn(() => []),
  staleBuckets: vi.fn(() => []),
  recomputeHeadroom: vi.fn(() => ({ drained: true, utilizationPct: 0 })),
  recomputeDueBuckets: vi.fn(async () => 0),
}));
const slotCache = vi.hoisted(() => ({ recomputeBucketSlotsForToday: vi.fn(async () => {}) }));
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

import { GET } from "./route";

const req = () => ({}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/recompute", () => {
  it("returns 401 and does no work when the cron bearer is missing or wrong", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(locks.acquireLock).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).not.toHaveBeenCalled();
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
    expect(String(stalePages()[0][2])).toMatch(/unreadable/i);
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
