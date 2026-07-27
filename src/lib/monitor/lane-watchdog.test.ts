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
  sendThrottledAlert: vi.fn(async (_key: string, _cooldownMs: number, _text: string, _channel?: string) => {}),
  sendThrottledInfo: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
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

  it("alerts (Slack only) when the Snowflake mirror export lane goes stale (#1101)", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(40 * MIN) });
    const stale = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).toContain("snowflake-export");
    const call = dispatch.sendThrottledAlert.mock.calls.find((c) => c[0] === "cron_lane_stale:snowflake-export");
    expect(call).toBeTruthy();
    expect(String(call?.[2])).toMatch(/mirror export lane/);
  });

  it("does not alert when the mirror export lane is fresh", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue({ ...healthy(), "snowflake-export": ago(5 * MIN) });
    const stale = await alertOnStaleLanes();
    expect(stale.map((l) => l.lane)).not.toContain("snowflake-export");
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

  // #525: the booking-smoke canary is a scheduled GitHub Actions workflow that
  // stamps `smoke-canary` on every successful run. If the schedule silently stops
  // (or starts failing before it can stamp), the safety net is gone and nobody
  // knows. The watchdog detects that by absence too, but with canary-specific copy
  // (it is NOT a cron lane and NOT a CPU kill), and it must never touch the
  // external /api/health signal (covered by the health tests: the canary is not in
  // LANE_STALE_BOUNDS_MS).
  describe("canary staleness (#525)", () => {
    it("alerts when the smoke canary has not stamped within its bound", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(120 * MIN), // bound is 90m
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
      const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
        string,
        number,
        string,
      ];
      expect(key).toContain("smoke-canary");
      // Canary-specific copy: names the canary and points at the workflow, not a
      // cron CPU kill.
      expect(text).toMatch(/canary/i);
      expect(text).toMatch(/workflow|Actions|schedule/i);
    });

    it("stays silent when the canary stamped recently", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(20 * MIN),
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    it("does not alert when the canary has never stamped (not yet configured)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": null,
      });
      const stale = await alertOnStaleLanes();
      expect(stale.map((l) => l.lane)).not.toContain("smoke-canary");
      expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
    });

    // #982: the 6h full book/reschedule/cancel pass stamps its OWN
    // `smoke-canary-full` heartbeat. When it goes stale, the copy must be
    // full-pass-specific and point at re-running the FULL pass, not the generic
    // dry-canary message.
    it("alerts with full-pass-specific copy when smoke-canary-full is stale", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(20 * MIN), // dry tick fine
        "smoke-canary-full": ago(9 * 60 * MIN), // bound is 8h
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane)).toContain("smoke-canary-full");
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
      const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
        string,
        number,
        string,
      ];
      expect(key).toContain("smoke-canary-full");
      // Names the full end-to-end pass and how to recover it (mode=full), so the
      // page is actionable and distinct from the dry-tick alert.
      expect(text).toMatch(/full/i);
      expect(text).toMatch(/reschedule|cancel|end to end/i);
      expect(text).toMatch(/mode.*full|Run workflow|Actions/i);
    });

    it("keys the dry and full canary alerts separately (one can't throttle the other)", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        "smoke-canary": ago(120 * MIN),
        "smoke-canary-full": ago(9 * 60 * MIN),
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane).sort()).toEqual(["smoke-canary", "smoke-canary-full"]);
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
      const keys = (dispatch.sendThrottledAlert.mock.calls as unknown as [string, number, string][]).map(
        (c) => c[0],
      );
      expect(new Set(keys).size).toBe(2);
    });

    it("reports both a stale cron lane and a stale canary in one tick", async () => {
      heartbeat.readAllHeartbeatMs.mockResolvedValue({
        ...healthy(),
        outbox: ago(25 * MIN),
        "smoke-canary": ago(120 * MIN),
      });

      const stale = await alertOnStaleLanes();

      expect(stale.map((l) => l.lane).sort()).toEqual(["outbox", "smoke-canary"]);
      expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(2);
    });
  });
});
