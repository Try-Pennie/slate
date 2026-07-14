import { describe, it, expect, vi, beforeEach } from "vitest";

// #803: a cron invocation killed mid-run (exceededCpu) cannot report its own
// death, so the lanes that never finished are detected by ABSENCE: they stop
// stamping their heartbeat. Roughly 400 invocations were killed before the #760
// fix and nobody noticed for days. This watchdog is the thing that would have
// noticed.
//
// The whole point is monitoring, so its OWN failures must never break a cron
// lane: a watchdog that takes down the sync tick is worse than the silence it
// replaces.

const dispatch = vi.hoisted(() => ({
  sendThrottledAlert: vi.fn(async () => {}),
  sendThrottledInfo: vi.fn(async () => {}),
}));
const heartbeat = vi.hoisted(() => ({
  readAllHeartbeatMs: vi.fn(async (): Promise<Record<string, number | null>> => ({})),
}));

vi.mock("@/lib/notify/dispatch", () => dispatch);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import { alertOnStaleLanes } from "./lane-watchdog";

const MIN = 60_000;
const now = () => Date.now();
const ago = (ms: number) => now() - ms;

const healthy = () => ({
  sync: ago(30_000),
  recompute: ago(30_000),
  outbox: ago(30_000),
  selfheal: ago(30_000),
  complete: ago(2 * MIN),
  watch: ago(2 * MIN),
  monitor: ago(2 * MIN),
});

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
  heartbeat.readAllHeartbeatMs.mockResolvedValue(healthy());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("alertOnStaleLanes (#803)", () => {
  it("stays silent when every lane is stamping", async () => {
    const stale = await alertOnStaleLanes();
    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("alerts on each lane a CPU kill left unfinished, keyed per lane", async () => {
    // sync ran first and stamped; the later lanes in the same invocation died.
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(25 * MIN),
      outbox: ago(25 * MIN),
    });

    const stale = await alertOnStaleLanes();

    expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "recompute"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);

    const calls = dispatch.sendThrottledAlert.mock.calls as unknown as [string, number, string][];
    const keys = calls.map((c) => c[0]);
    // Per-lane keys: one dead lane must not throttle away the alert for another.
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => k.includes("recompute") || k.includes("outbox"))).toBe(true);
    // The text has to name the lane and how long it has been quiet, or the alert
    // is not actionable at 3am.
    const texts = calls.map((c) => c[2]).join(" ");
    expect(texts).toContain("recompute");
    expect(texts).toContain("outbox");
  });

  it("does not alert on a lane that has never stamped (fresh deploy, not a death)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), outbox: null });
    const stale = await alertOnStaleLanes();
    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  // --- Failure paths. The watchdog runs INSIDE a cron lane, so it must never
  // throw: a monitoring failure must not become a cron failure.
  it("swallows a heartbeat-read failure instead of breaking the calling lane", async () => {
    heartbeat.readAllHeartbeatMs.mockRejectedValueOnce(new Error("db unreachable"));

    const stale = await alertOnStaleLanes();

    expect(stale).toEqual([]);
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("swallows an alert failure, and still reports the other stale lanes", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({
      ...healthy(),
      recompute: ago(25 * MIN),
      outbox: ago(25 * MIN),
    });
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack is down"));

    const stale = await alertOnStaleLanes();

    // A failed Slack post must not hide the detection or skip the second lane.
    expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "recompute"]);
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
  });
});
