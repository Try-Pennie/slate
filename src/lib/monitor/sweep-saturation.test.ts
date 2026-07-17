import { describe, it, expect, vi, beforeEach } from "vitest";

// #726 wiring: turning one tick's drain count into (clear streak | count it | page).
// The streak counter and the alert dispatcher are mocked; what is under test is the
// decision, which is where the silent-backlog bug lived.
const recordConsecutiveStreak = vi.hoisted(() => vi.fn(async () => false));
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));

import {
  reportSweepSaturation,
  reportCompletionSaturation,
  SATURATION_ALERT_AFTER_TICKS,
  SATURATION_WINDOW_SECONDS,
  COMPLETION_SATURATION_ALERT_AFTER_RUNS,
  COMPLETION_SATURATION_WINDOW_SECONDS,
} from "./sweep-saturation";

const LIMIT = 200;
const KEY = "reconcile_cancelled_saturated";
const run = (drained: number | null) => reportSweepSaturation("cancelled-block reconcile", KEY, drained, LIMIT);

beforeEach(() => vi.clearAllMocks());

describe("reportSweepSaturation (#726)", () => {
  it("clears the streak when a tick drains under its cap", async () => {
    await run(3);
    expect(clearFailureStreak).toHaveBeenCalledWith(KEY);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("counts a saturated tick toward the streak without paging yet", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    await run(LIMIT);
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      KEY,
      SATURATION_WINDOW_SECONDS,
      SATURATION_ALERT_AFTER_TICKS,
    );
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("pages once the saturated streak is sustained", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await run(LIMIT);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const body = sendThrottledAlert.mock.calls[0][2];
    expect(body).toContain("cancelled-block reconcile");
    expect(body).toContain(String(LIMIT));
  });

  // Failure path. A sweep that THREW tells us nothing about the backlog. Counting
  // it as saturation would page on a lie; clearing the streak would erase a real
  // pile-up right when the system is already unhealthy.
  it("neither counts nor clears when the sweep itself failed", async () => {
    await run(null);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  // Monitoring must never take down the lane it watches.
  it("does not throw when the alert dispatch fails", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(run(LIMIT)).resolves.toBeUndefined();
  });
});

// #883: the completion sweep reports its OWN over-budget verdict (a boolean),
// not a drained-vs-cap count, because backlogRemains is the precise signal the
// drain loop already computes. Same streak+page machinery, completion tuning.
describe("reportCompletionSaturation (#883)", () => {
  const CKEY = "completion_sweep_saturated";
  const crun = (backlogRemains: boolean | null) => reportCompletionSaturation(CKEY, backlogRemains);

  it("clears the streak when a run drained the whole backlog", async () => {
    await crun(false);
    expect(clearFailureStreak).toHaveBeenCalledWith(CKEY);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("counts an over-budget run toward the streak without paging yet", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    await crun(true);
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      CKEY,
      COMPLETION_SATURATION_WINDOW_SECONDS,
      COMPLETION_SATURATION_ALERT_AFTER_RUNS,
    );
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("pages once over-budget runs are sustained", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await crun(true);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const body = sendThrottledAlert.mock.calls[0][2];
    expect(body).toContain("completion sweep");
    // The per-run drain budget (200 rows * 25 batches) is named concretely.
    expect(body).toContain("5000");
  });

  // A run that THREW says nothing about the backlog: never counted, never cleared.
  it("neither counts nor clears when backlogRemains is unknown", async () => {
    await crun(null);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("does not throw when the alert dispatch fails", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(crun(true)).resolves.toBeUndefined();
  });
});
