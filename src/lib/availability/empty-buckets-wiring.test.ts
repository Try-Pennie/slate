import { describe, it, expect, vi, beforeEach } from "vitest";

// #1641: the empty-bucket sweep's REAL roster read, as it is wired rather than as
// an injected fake.
//
// empty-buckets.test.ts already proves the decision half: a sweep whose
// loadBuckets throws clears nothing, and a sweep that sees no buckets pages about
// nothing. Neither could say anything about the wiring, and the wiring was the
// defect: the read was written as `(await ...).data ?? []`, so a failed query
// arrived as ZERO buckets rather than as a throw, and the correct handling of a
// throw was never reached. An unreadable roster and a roster with nothing in it
// took the same branch, which on a monitor watching for an empty roster is the
// worst possible pair to confuse.
//
// Both directions in one fixture: an unreadable roster must reject and say
// nothing, and the same fixture reading normally must still find and judge the
// buckets (L159).

const rows = vi.hoisted(() => ({
  result: { data: [] as unknown[], error: null as { message: string } | null },
  members: { data: [] as unknown[], error: null as { message: string } | null },
}));
const notify = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _ms: number, _text: string) => {}),
  resolveAlert: vi.fn(async () => {}),
  settleAlertsSilently: vi.fn(async () => {}),
}));
const eligibleAgentIdsCached = vi.hoisted(() =>
  vi.fn(async (_b: { code: string }) => ({ ids: [] as string[] })),
);

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "in", "limit", "order"]) {
      q[method] = () => q;
    }
    const result = () => (table === "bucket_members" ? rows.members : rows.result);
    q.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return q;
  }),
);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/notify/dispatch", () => notify);
vi.mock("@/lib/monitor/settings", () => ({
  loadMonitorSettings: async () => ({ cooldownMs: { empty_buckets: 1000 } }),
}));
vi.mock("./eligible-cache.ts", () => ({ eligibleAgentIdsCached }));

import { alertOnEmptyBuckets } from "@/lib/availability/service";

function bucket(code: string) {
  // One shared set of criteria, so these two are one pool unless something else
  // separates them. That "something else" is what #2253 is about.
  return { id: `b-${code}`, code, org_id: "o1", is_test: false, criteria: { debt_team: "low" } };
}

describe("alertOnEmptyBuckets roster read (wired, not injected)", () => {
  beforeEach(() => {
    notify.sendThrottledAlert.mockClear();
    notify.resolveAlert.mockClear();
    notify.settleAlertsSilently.mockClear();
    eligibleAgentIdsCached.mockReset();
    eligibleAgentIdsCached.mockResolvedValue({ ids: [] });
    rows.result = { data: [], error: null };
    rows.members = { data: [], error: null };
  });

  it("rejects and says nothing at all when the roster read errors", async () => {
    rows.result = { data: null as never, error: { message: 'relation "buckets" does not exist' } };

    await expect(alertOnEmptyBuckets()).rejects.toThrow(/empty-bucket sweep roster/);

    // The half that matters as much as the throw: a run that measured no pool
    // must neither page about a dead zone nor announce that one has cleared.
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
    expect(notify.resolveAlert).not.toHaveBeenCalled();
    expect(notify.settleAlertsSilently).not.toHaveBeenCalled();
  });

  it("still reads the roster and judges it when the query succeeds", async () => {
    rows.result = { data: [bucket("411")], error: null };
    eligibleAgentIdsCached.mockResolvedValue({ ids: [] });

    const res = await alertOnEmptyBuckets();

    // Same fixture, healthy read: the bucket really is seen and really is judged,
    // so the silence asserted above is a suppressed page rather than a sweep that
    // could never have produced one.
    expect(res.empty).toEqual(["411"]);
    expect(notify.sendThrottledAlert).toHaveBeenCalled();
  });

  it("treats a genuinely empty roster as no buckets rather than a failure", async () => {
    rows.result = { data: [], error: null };
    const res = await alertOnEmptyBuckets();
    expect(res.empty).toEqual([]);
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });
});

// #2253: the member read is wired the same way, and for the same reason. A
// swallowed error here arrives as "nobody is named on any bucket", which is the
// coarse pool key this read replaced, restored in silence on the one run that
// could not check.
describe("alertOnEmptyBuckets member read (wired, not injected)", () => {
  beforeEach(() => {
    notify.sendThrottledAlert.mockClear();
    notify.resolveAlert.mockClear();
    notify.settleAlertsSilently.mockClear();
    eligibleAgentIdsCached.mockReset();
    eligibleAgentIdsCached.mockResolvedValue({ ids: [] });
    rows.result = { data: [bucket("111"), bucket("112")], error: null };
    rows.members = { data: [], error: null };
    from.mockClear();
  });

  it("rejects and says nothing at all when the member read errors", async () => {
    rows.members = {
      data: null as never,
      error: { message: 'relation "bucket_members" does not exist' },
    };

    await expect(alertOnEmptyBuckets()).rejects.toThrow(/empty-bucket sweep members/);

    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
    expect(notify.resolveAlert).not.toHaveBeenCalled();
    expect(notify.settleAlertsSilently).not.toHaveBeenCalled();
  });

  it("really asks bucket_members, and asks once for the whole sweep", async () => {
    // Both halves in one fixture (L159): the same wiring reading normally must
    // reach the table, or the rejection above proves nothing about this read.
    await alertOnEmptyBuckets();
    const tables = from.mock.calls.map((c) => c[0]);
    expect(tables).toContain("bucket_members");
    // Sixty buckets must not cost sixty member reads.
    expect(tables.filter((t) => t === "bucket_members")).toHaveLength(1);
  });

  it("splits the pool when one of two identical buckets is hand-staffed", async () => {
    // The end to end shape of the defect, through the real wiring: 112 is staffed
    // only by the person named on it, so 111 is its own pool and pages alone.
    rows.members = { data: [{ bucket_id: "b-112", user_id: "u1" }], error: null };
    eligibleAgentIdsCached.mockImplementation(async (b: { code: string }) => ({
      ids: b.code === "112" ? ["u1"] : [],
    }));

    const res = await alertOnEmptyBuckets();

    expect(res.empty).toEqual(["111"]);
    const paged = notify.sendThrottledAlert.mock.calls.map((c) => c[0]);
    expect(paged).toContain("empty_buckets:111");
    expect(paged).not.toContain("empty_buckets:112");
  });
});
