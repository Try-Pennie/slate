import { describe, it, expect, vi } from "vitest";

// The real Slack boundary, so the silent-path proof below is about what actually
// reaches dispatch rather than about an injected spy (#1151/#1152).
const { sendThrottledAlert, resolveAlert } = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));
// A supabase client whose every query fails. Chainable rather than a bare throwing
// `select`, because the sweep now also reads its cooldown from the settings store,
// whose chain is `.select().eq().maybeSingle()`: a stub that throws on the first
// call leaves the sibling read's rejection floating and the run is no longer clean.
// Awaiting ANY point in the chain rejects, which is what "the DB is unreachable"
// actually looks like.
vi.mock("@/lib/supabase/admin", () => {
  const failing = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? (res: unknown, rej: (e: unknown) => void) =>
                Promise.reject(new Error("supabase unreachable")).then(
                  res as undefined,
                  rej,
                )
            : () => failing(),
      },
    );
  return { supabaseAdmin: () => ({ from: () => failing() }) };
});

import { alertOnEmptyBuckets } from "./service";
import { AGGREGATE_BUCKET_CODE } from "./bucket-coverage";
import type { Bucket } from "@/lib/db/types";

// Proactive routing dead-zone sweep (#327). Deps are injected so this exercises
// the decision + fan-out without touching the DB or Slack.
//
// #1151: "this bucket routes to nobody" is a CONDITION, so the sweep also has to
// say when it ends. The all-clear is driven by the MEASURED pool, never by "we
// did not alert this run", and the tests below pin that distinction: a bucket
// with agents clears, a bucket without does not, and a run that measured nothing
// clears nothing.
// #2237: the sweep now pages once per POOL, and a bucket's pool comes from its
// criteria. So a fixture with no criteria would put every bucket in one pool,
// which is a different scenario from the one most cases here are about. Each
// bucket gets criteria of its OWN by default, and the cases that are about
// pooling pass criteria they share.
const bucket = (code: string, criteria?: Record<string, string>) =>
  ({
    id: `b-${code}`,
    code,
    criteria: criteria ?? { debt_team: `team-${code}` },
  }) as unknown as Bucket;

type ActiveMembers = () => Promise<{ bucket_id: string; user_id: string }[]>;

// The hand named members are a parameter rather than something a case overrides
// afterwards, because every case here spreads `spies()` LAST: an override written
// before the spread is silently replaced by the default and the case passes for
// the wrong reason.
function spies(
  // None by default, which is production today: three `bucket_members` rows exist
  // and all three are on the SMOKE fixtures this sweep excludes.
  loadActiveMembers: ActiveMembers = async () => [],
) {
  return {
    loadActiveMembers: vi.fn(loadActiveMembers),
    sendAlert: vi.fn(async (_code: string, _msg: string) => {}),
    clearAlert: vi.fn(async (_code: string, _msg: string) => {}),
    settleSilently: vi.fn(async (_codes: string[]) => {}),
    countBookableAgents: vi.fn(async (): Promise<number | null> => 0),
  };
}

describe("alertOnEmptyBuckets", () => {
  it("alerts ONCE PER bucket that resolves to zero eligible agents", async () => {
    const s = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412"), bucket("511")],
      countEligible: async (b) => (b.code === "411" ? 3 : 0),
      ...s,
    });
    expect(res.empty.sort()).toEqual(["412", "511"]);
    // One alert per dead bucket (so simultaneous dead zones each surface).
    const pages = s.sendAlert.mock.calls.filter(([code]) => code !== AGGREGATE_BUCKET_CODE);
    expect(pages).toHaveLength(2);
    const byCode = Object.fromEntries(pages.map(([code, msg]) => [code, msg]));
    expect(byCode["412"]).toContain("412");
    expect(byCode["511"]).toContain("511");
    // The healthy bucket in the same run gets the all-clear; the dead ones must not.
    expect(
      s.clearAlert.mock.calls.map(([code]) => code).filter((c) => c !== AGGREGATE_BUCKET_CODE),
    ).toEqual(["411"]);
  });

  // #2237: sixty codes route through fifteen pools, so a tier with nobody in it
  // is ONE finding. It used to arrive as six near identical pages, each naming a
  // code and none naming the thing to fix. The pure decision is node tested; what
  // only shows here is that the sweep really groups before it fans out.
  it("pages ONCE for a pool of six codes, not once per code", async () => {
    const s = spies();
    const low = { debt_team: "low" };
    const codes = ["100", "101", "102", "110", "111", "112"];
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [
        ...codes.map((c) => bucket(c, low)),
        bucket("300", { debt_team: "high" }),
      ],
      countEligible: async (b) => (b.code === "300" ? 4 : 0),
      ...s,
    });

    expect(res.empty.sort()).toEqual(codes);
    const pages = s.sendAlert.mock.calls.filter(([code]) => code !== AGGREGATE_BUCKET_CODE);
    expect(pages).toHaveLength(1);
    // Keyed on the pool's lowest code, so the same page is thrown under the same
    // key on every sweep and can actually be cleared.
    expect(pages[0]?.[0]).toBe("100");
    // And it names every code it speaks for, because those are what the landing
    // pages send.
    for (const c of codes) expect(pages[0]?.[1]).toContain(c);
    expect(pages[0]?.[1]).toContain("Low");

    // The five it speaks for are settled without a notice each, rather than left
    // holding markers that would post five all-clears on recovery.
    expect(s.settleSilently).toHaveBeenCalledTimes(1);
    expect(s.settleSilently.mock.calls[0]?.[0].sort()).toEqual(codes.slice(1));
  });

  it("does not alert when every bucket has an eligible agent, and clears them all", async () => {
    const s = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412")],
      countEligible: async () => 2,
      ...s,
    });
    expect(res.empty).toEqual([]);
    expect(s.sendAlert).not.toHaveBeenCalled();
    expect(
      s.clearAlert.mock.calls
        .map(([code]) => code)
        .filter((c) => c !== AGGREGATE_BUCKET_CODE)
        .sort(),
    ).toEqual(["411", "412"]);
  });

  it("names the agent count in the all-clear, since one agent is not the same as ten", async () => {
    const s = spies();
    await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411")],
      countEligible: async () => 1,
      ...s,
    });
    expect(s.clearAlert.mock.calls[0][1]).toContain("1 eligible bookable agent");
  });

  it("handles an empty roster without alerting or clearing anything", async () => {
    const s = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [],
      countEligible: async () => 0,
      ...s,
    });
    expect(res.empty).toEqual([]);
    expect(s.sendAlert).not.toHaveBeenCalled();
    // The silent path that matters: no buckets were measured, so nothing is
    // known to be healthy, so no page may be cleared.
    expect(s.clearAlert).not.toHaveBeenCalled();
    expect(s.settleSilently).not.toHaveBeenCalled();
  });

  it("clears nothing when the bucket read fails, since a failed run measured no pool", async () => {
    const s = spies();
    await expect(
      alertOnEmptyBuckets({
        loadBuckets: async () => {
          throw new Error("supabase unreachable");
        },
        countEligible: async () => 5,
        ...s,
      }),
    ).rejects.toThrow(/unreachable/);
    expect(s.clearAlert).not.toHaveBeenCalled();
    expect(s.sendAlert).not.toHaveBeenCalled();
    expect(s.settleSilently).not.toHaveBeenCalled();
  });
});

// A broad outage is ONE page, not sixty (L36). The per-bucket key exists so two
// dead zones never suppress each other, which is right for two and is how 60
// buckets sharing one cause (nobody in the roster is bookable) became 60 messages
// a wave, every wave, until someone muted the alert.
describe("alertOnEmptyBuckets when the whole roster is dark", () => {
  const sixty = Array.from({ length: 60 }, (_, i) => bucket(`b${i}`));

  it("pages once for the set instead of once per bucket", async () => {
    const s = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async () => 0,
      ...s,
    });
    expect(res.empty).toHaveLength(60);
    expect(s.sendAlert).toHaveBeenCalledTimes(1);
    const [code, text] = s.sendAlert.mock.calls[0];
    expect(code).toBe(AGGREGATE_BUCKET_CODE);
    expect(text).toContain("60");
    // The measured shared cause is named, so the reader is not left to diagnose
    // it from sixty identical lines.
    expect(text).toMatch(/no agent|nobody/i);
    expect(res.aggregated).toBe(true);
  });

  it("settles the individual pages silently, so switching modes posts no second flood", async () => {
    const s = spies();
    await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async () => 0,
      ...s,
    });
    expect(s.settleSilently).toHaveBeenCalledTimes(1);
    expect(s.settleSilently.mock.calls[0][0]).toHaveLength(60);
    // Every one of those buckets was already paging under its own key; clearing
    // them the normal way would post 60 all-clears, which is the flood again.
    expect(s.clearAlert).not.toHaveBeenCalled();
  });

  it("does not blame the roster when agents ARE bookable", async () => {
    const s = spies();
    s.countBookableAgents.mockResolvedValue(40);
    await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async () => 0,
      ...s,
    });
    const [, text] = s.sendAlert.mock.calls[0];
    expect(text).toContain("40");
    expect(text).not.toMatch(/no agent is bookable|nobody is bookable/i);
  });

  it("states an unreadable agent count as unreadable rather than scoring it as zero", async () => {
    const s = spies();
    // The count read failed. Zero agents and "could not tell" are different facts,
    // and the page may claim only the one it measured (#1152, L11).
    s.countBookableAgents.mockResolvedValue(null);
    await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async () => 0,
      ...s,
    });
    const [, text] = s.sendAlert.mock.calls[0];
    expect(text).toMatch(/could not be read|not established|unknown/i);
    expect(text).not.toMatch(/no agent is bookable|nobody is bookable/i);
  });

  it("still pages the set when the agent count read throws", async () => {
    const s = spies();
    s.countBookableAgents.mockRejectedValue(new Error("supabase unreachable"));
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async () => 0,
      ...s,
    });
    // The page is the point; a failed cause lookup must not swallow it.
    expect(s.sendAlert).toHaveBeenCalledTimes(1);
    expect(res.aggregated).toBe(true);
  });

  it("clears the aggregate with one notice when the buckets come back", async () => {
    const s = spies();
    await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async () => 3,
      ...s,
    });
    const aggregateClears = s.clearAlert.mock.calls.filter(
      ([code]) => code === AGGREGATE_BUCKET_CODE,
    );
    expect(aggregateClears).toHaveLength(1);
    expect(aggregateClears[0][1]).not.toMatch(/still/i);
  });

  it("says how many are still dead when the count drops below the aggregate threshold", async () => {
    const s = spies();
    // Three of sixty remain dead: the systemic page is over, but "all clear" would
    // be a lie, and those three page individually from here.
    await alertOnEmptyBuckets({
      loadBuckets: async () => sixty,
      countEligible: async (b) => (["b0", "b1", "b2"].includes(b.code) ? 0 : 2),
      ...s,
    });
    const aggregateClear = s.clearAlert.mock.calls.find(
      ([code]) => code === AGGREGATE_BUCKET_CODE,
    );
    expect(aggregateClear?.[1]).toContain("3");
    expect(aggregateClear?.[1]).toMatch(/still/i);
    expect(
      s.sendAlert.mock.calls.filter(([code]) => code !== AGGREGATE_BUCKET_CODE),
    ).toHaveLength(3);
  });
});

// The silent path at the REAL dispatch boundary (#1152): with the default deps,
// whose bucket read is wired to fail here, the sweep measures no pool at all and
// so must announce no recovery. A bucket that could not be counted is not a
// bucket known to be healthy.
describe("alertOnEmptyBuckets against the real notify boundary", () => {
  it("sends no all-clear when the bucket read fails", async () => {
    await expect(alertOnEmptyBuckets()).rejects.toThrow();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });
});

// #2253: a bucket staffed ONLY by somebody named on it by hand.
//
// The sweep's pool key used to leave manual members out, because the sweep had no
// member list to work from. That made its key COARSER than the one the recompute
// lane, the tiers page and the staffing depth use, and `emptyPools` reports a pool
// only when EVERY code in it is empty. So an unstaffed bucket sharing a pool with
// a hand staffed one was neither paged nor cleared: it fell out of the sweep
// entirely, which is an alarm failing OPEN and in silence.
//
// It could not bite while production carried its three `bucket_members` rows on
// the two SMOKE buckets the sweep excludes. It bites the moment anybody names a
// person on a real bucket, which the admin page offers on every row.
describe("alertOnEmptyBuckets with a hand-named member (#2253)", () => {
  const low = { debt_team: "low" };

  it("still pages for the unstaffed sibling of a hand-staffed bucket", async () => {
    // 112's only agent is the person named on it; 111's criteria match nobody.
    const s = spies(async () => [{ bucket_id: "b-112", user_id: "u1" }]);
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("111", low), bucket("112", low)],
      countEligible: async (b) => (b.code === "112" ? 1 : 0),
      ...s,
    });

    expect(res.empty).toEqual(["111"]);
    const pages = s.sendAlert.mock.calls.filter(([code]) => code !== AGGREGATE_BUCKET_CODE);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.[0]).toBe("111");
    // It speaks for 111 alone. Naming 112 would send somebody to check a booking
    // link that routes perfectly well.
    expect(pages[0]?.[1]).toContain("111");
    expect(pages[0]?.[1]).not.toContain("112");
    // And the hand staffed one is measured healthy, so its own page may clear.
    expect(
      s.clearAlert.mock.calls.map(([code]) => code).filter((c) => c !== AGGREGATE_BUCKET_CODE),
    ).toEqual(["112"]);
  });

  it("still pools the codes whose hand-named members agree", async () => {
    // The other direction (L159): the member list is part of the key, not a
    // reason to stop pooling. Two codes named the same person, so they are one
    // pool and one page, exactly as two codes naming nobody are.
    const s = spies(async () => [
      { bucket_id: "b-111", user_id: "u1" },
      { bucket_id: "b-112", user_id: "u1" },
    ]);
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("111", low), bucket("112", low)],
      countEligible: async () => 0,
      ...s,
    });

    expect(res.empty.sort()).toEqual(["111", "112"]);
    const pages = s.sendAlert.mock.calls.filter(([code]) => code !== AGGREGATE_BUCKET_CODE);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.[0]).toBe("111");
    expect(pages[0]?.[1]).toContain("112");
  });

  it("clears nothing when the member read fails, since the pools were never resolved", async () => {
    // Falling back to an empty member list would be the coarse key again, silently,
    // which is the exact fail-open this fixes (L215). The roster read already
    // behaves this way and the two must not disagree.
    const s = spies(async () => {
      throw new Error("supabase unreachable");
    });
    await expect(
      alertOnEmptyBuckets({
        loadBuckets: async () => [bucket("111", low), bucket("112", low)],
        countEligible: async () => 0,
        ...s,
      }),
    ).rejects.toThrow(/unreachable/);
    expect(s.sendAlert).not.toHaveBeenCalled();
    expect(s.clearAlert).not.toHaveBeenCalled();
    expect(s.settleSilently).not.toHaveBeenCalled();
  });
});
