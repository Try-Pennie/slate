import { describe, it, expect, vi } from "vitest";

// The real Slack boundary, so the silent-path proof below is about what actually
// reaches dispatch rather than about an injected spy (#1151/#1152).
const { sendThrottledAlert, resolveAlert } = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: async () => {
        throw new Error("supabase unreachable");
      },
    }),
  }),
}));

import { alertOnEmptyBuckets } from "./service";
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
  };
}

describe("alertOnEmptyBuckets", () => {
  it("alerts ONCE PER bucket that resolves to zero eligible agents", async () => {
    const { sendAlert, clearAlert } = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412"), bucket("511")],
      countEligible: async (b) => (b.code === "411" ? 3 : 0),
      sendAlert,
      clearAlert,
    });
    expect(res.empty.sort()).toEqual(["412", "511"]);
    // One alert per dead bucket (so simultaneous dead zones each surface).
    expect(sendAlert).toHaveBeenCalledTimes(2);
    const byCode = Object.fromEntries(sendAlert.mock.calls.map(([code, msg]) => [code, msg]));
    expect(byCode["412"]).toContain("412");
    expect(byCode["511"]).toContain("511");
    // The healthy bucket in the same run gets the all-clear; the dead ones must not.
    expect(clearAlert.mock.calls.map(([code]) => code)).toEqual(["411"]);
  });

  it("does not alert when every bucket has an eligible agent, and clears them all", async () => {
    const { sendAlert, clearAlert } = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412")],
      countEligible: async () => 2,
      sendAlert,
      clearAlert,
    });
    expect(res.empty).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(clearAlert.mock.calls.map(([code]) => code).sort()).toEqual(["411", "412"]);
  });

  it("names the agent count in the all-clear, since one agent is not the same as ten", async () => {
    const { sendAlert, clearAlert } = spies();
    await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411")],
      countEligible: async () => 1,
      sendAlert,
      clearAlert,
    });
    expect(clearAlert.mock.calls[0][1]).toContain("1 eligible bookable agent");
  });

  it("handles an empty roster without alerting or clearing anything", async () => {
    const { sendAlert, clearAlert } = spies();
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [],
      countEligible: async () => 0,
      sendAlert,
      clearAlert,
    });
    expect(res.empty).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
    // The silent path that matters: no buckets were measured, so nothing is
    // known to be healthy, so no page may be cleared.
    expect(clearAlert).not.toHaveBeenCalled();
  });

  it("clears nothing when the bucket read fails, since a failed run measured no pool", async () => {
    const { sendAlert, clearAlert } = spies();
    await expect(
      alertOnEmptyBuckets({
        loadBuckets: async () => {
          throw new Error("supabase unreachable");
        },
        countEligible: async () => 5,
        sendAlert,
        clearAlert,
      }),
    ).rejects.toThrow(/unreachable/);
    expect(clearAlert).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
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
