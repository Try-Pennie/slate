import { describe, it, expect, vi, beforeEach } from "vitest";

// #1151: "retention is stopped" is a CONDITION. `alertRetentionSkipped` opens it
// and `alertRetentionResumed` closes it, and the pair only tells the truth if the
// resume is hung off a run that actually got past the export gate.
//
// The silent path (#1152) is the one that matters here: a lane that SKIPPED
// destroyed nothing, so it has no evidence retention is working and must not
// clear a page saying it stopped. These lanes delete customer data on a
// compliance window, so a false all-clear would end the only signal that the
// window is not being honored.
const { sendThrottledAlert, resolveAlert } = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
  resolveAlert: vi.fn(async (_key: string, _text: string) => true),
}));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));
vi.mock("@/lib/monitor/heartbeat", () => ({ recordHeartbeat: vi.fn(async () => {}) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { alertRetentionSkipped, alertRetentionResumed } from "./retention-lane";

describe("retention lane condition notices", () => {
  beforeEach(() => vi.clearAllMocks());

  it("announces that a lane is deleting again, on its own key", async () => {
    await alertRetentionResumed("prune-bookings-pii");
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert.mock.calls[0][0]).toBe("retention_skipped:prune-bookings-pii");
    expect(resolveAlert.mock.calls[0][1]).toMatch(/deleting again/i);
  });

  it("sends NO all-clear when the lane skipped, since it destroyed nothing", async () => {
    await alertRetentionSkipped("prune-bookings-pii", "mirror not ready");
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("keys the skip and the resume to the SAME lane, so one clears the other", async () => {
    await alertRetentionSkipped("prune-routing", "nothing exported yet");
    await alertRetentionResumed("prune-routing");
    expect(sendThrottledAlert.mock.calls[0][0]).toBe(resolveAlert.mock.calls[0][0]);
  });

  it("never lets a Slack failure escape into the lane it rides on", async () => {
    resolveAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(alertRetentionResumed("prune-webhook-payloads")).resolves.toBeUndefined();
  });
});
