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
}));
const notify = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async () => {}),
  settleAlertsSilently: vi.fn(async () => {}),
}));
const eligibleAgentIdsCached = vi.hoisted(() => vi.fn(async () => ({ ids: [] as string[] })));

const from = vi.hoisted(() =>
  vi.fn(() => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "in", "limit", "order"]) {
      q[method] = () => q;
    }
    q.then = (resolve: (r: unknown) => unknown) => Promise.resolve(rows.result).then(resolve);
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
  return { id: `b-${code}`, code, org_id: "o1", is_test: false };
}

describe("alertOnEmptyBuckets roster read (wired, not injected)", () => {
  beforeEach(() => {
    notify.sendThrottledAlert.mockClear();
    notify.resolveAlert.mockClear();
    notify.settleAlertsSilently.mockClear();
    eligibleAgentIdsCached.mockReset();
    eligibleAgentIdsCached.mockResolvedValue({ ids: [] });
    rows.result = { data: [], error: null };
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
