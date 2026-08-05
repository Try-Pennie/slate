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
const bucket = (code: string) => ({ code }) as Bucket;

function spies() {
  return {
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
