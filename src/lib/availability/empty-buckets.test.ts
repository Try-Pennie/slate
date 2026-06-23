import { describe, it, expect, vi } from "vitest";
import { alertOnEmptyBuckets } from "./service";
import type { Bucket } from "@/lib/db/types";

// Proactive routing dead-zone sweep (#327). Deps are injected so this exercises
// the decision + fan-out without touching the DB or Slack.
const bucket = (code: string) => ({ code }) as Bucket;

describe("alertOnEmptyBuckets", () => {
  it("alerts ONCE PER bucket that resolves to zero eligible agents", async () => {
    const sendAlert = vi.fn(async (_code: string, _msg: string) => {});
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412"), bucket("511")],
      countEligible: async (b) => (b.code === "411" ? 3 : 0),
      sendAlert,
    });
    expect(res.empty.sort()).toEqual(["412", "511"]);
    // One alert per dead bucket (so simultaneous dead zones each surface).
    expect(sendAlert).toHaveBeenCalledTimes(2);
    const byCode = Object.fromEntries(sendAlert.mock.calls.map(([code, msg]) => [code, msg]));
    expect(byCode["412"]).toContain("412");
    expect(byCode["511"]).toContain("511");
  });

  it("does not alert when every bucket has an eligible agent", async () => {
    const sendAlert = vi.fn(async (_code: string, _msg: string) => {});
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412")],
      countEligible: async () => 2,
      sendAlert,
    });
    expect(res.empty).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("handles an empty roster without alerting", async () => {
    const sendAlert = vi.fn(async (_code: string, _msg: string) => {});
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [],
      countEligible: async () => 0,
      sendAlert,
    });
    expect(res.empty).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
