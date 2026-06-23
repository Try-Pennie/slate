import { describe, it, expect, vi } from "vitest";
import { alertOnEmptyBuckets } from "./service";
import type { Bucket } from "@/lib/db/types";

// Proactive routing dead-zone sweep (#327). Deps are injected so this exercises
// the decision + fan-out without touching the DB or Slack.
const bucket = (code: string) => ({ code }) as Bucket;

describe("alertOnEmptyBuckets", () => {
  it("alerts, naming every bucket that resolves to zero eligible agents", async () => {
    const sendAlert = vi.fn(async (_msg: string) => {});
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412"), bucket("511")],
      countEligible: async (b) => (b.code === "411" ? 3 : 0),
      sendAlert,
    });
    expect(res.empty.sort()).toEqual(["412", "511"]);
    expect(sendAlert).toHaveBeenCalledOnce();
    const msg = sendAlert.mock.calls[0][0];
    expect(msg).toContain("412");
    expect(msg).toContain("511");
  });

  it("does not alert when every bucket has an eligible agent", async () => {
    const sendAlert = vi.fn(async (_msg: string) => {});
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [bucket("411"), bucket("412")],
      countEligible: async () => 2,
      sendAlert,
    });
    expect(res.empty).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("handles an empty roster without alerting", async () => {
    const sendAlert = vi.fn(async (_msg: string) => {});
    const res = await alertOnEmptyBuckets({
      loadBuckets: async () => [],
      countEligible: async () => 0,
      sendAlert,
    });
    expect(res.empty).toEqual([]);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
