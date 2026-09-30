import { describe, it, expect, vi, beforeEach } from "vitest";

// #2544: turning one complete-lane tick's two sweep outcomes into
// (clear the streak | count it | page). The streak counter and the dispatcher are
// mocked; what is under test is the decision, which is where the silence lived:
// a sweep that threw every five minutes was a `log.error` and a `"error"` in the
// JSON body, and paged nobody.
const recordConsecutiveStreak = vi.hoisted(() => vi.fn(async () => false));
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveRecovered = vi.hoisted(() =>
  vi.fn(async (_recovered: { key: string; text: string }[]) => [] as string[]),
);

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveRecovered }));

import {
  reportSweepFailures,
  COMPLETION_SWEEP_FAILING_KEY,
  WEBHOOK_RETRY_SWEEP_FAILING_KEY,
  SWEEP_FAILURE_ALERT_AFTER_RUNS,
  SWEEP_FAILURE_WINDOW_SECONDS,
} from "./sweep-failure";

const completion = (ok: boolean) => ({ key: COMPLETION_SWEEP_FAILING_KEY, ok });
const retry = (ok: boolean) => ({ key: WEBHOOK_RETRY_SWEEP_FAILING_KEY, ok });

beforeEach(() => vi.clearAllMocks());

describe("reportSweepFailures (#2544)", () => {
  it("clears both streaks when both sweeps came back with a result", async () => {
    await reportSweepFailures([completion(true), retry(true)]);
    expect(clearFailureStreak).toHaveBeenCalledWith(COMPLETION_SWEEP_FAILING_KEY);
    expect(clearFailureStreak).toHaveBeenCalledWith(WEBHOOK_RETRY_SWEEP_FAILING_KEY);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("settles both all-clears in ONE alert_state read", async () => {
    // The complete lane shares a subrequest budget with three other lanes, so a
    // resolve per key would be two reads every five minutes for rows that almost
    // never exist.
    await reportSweepFailures([completion(true), retry(true)]);
    expect(resolveRecovered).toHaveBeenCalledTimes(1);
    expect(resolveRecovered.mock.calls[0]![0].map((r) => r.key).sort()).toEqual(
      [COMPLETION_SWEEP_FAILING_KEY, WEBHOOK_RETRY_SWEEP_FAILING_KEY].sort(),
    );
  });

  it("counts a failed sweep toward its streak without paging yet", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    await reportSweepFailures([completion(false)]);
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      COMPLETION_SWEEP_FAILING_KEY,
      SWEEP_FAILURE_WINDOW_SECONDS,
      SWEEP_FAILURE_ALERT_AFTER_RUNS,
    );
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("pages once the failing streak is sustained, naming what stops happening", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await reportSweepFailures([completion(false)]);
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , body] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe(COMPLETION_SWEEP_FAILING_KEY);
    expect(body).toContain("complete");
    // The page has to say what a reader LOSES, not merely that a sweep is erroring.
    expect(body).toContain("counting as upcoming");
    expect(body).toContain(String(SWEEP_FAILURE_ALERT_AFTER_RUNS));
  });

  it("gives the two sweeps different words, because they cost different things", async () => {
    recordConsecutiveStreak.mockResolvedValue(true);
    await reportSweepFailures([completion(false)]);
    await reportSweepFailures([retry(false)]);
    const bodies = sendThrottledAlert.mock.calls.map((c) => c[2]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toEqual(bodies[1]);
    expect(bodies[1]).toContain("webhook");
  });

  // THE FAILURE PATH. A sweep that threw measured nothing about its own health
  // being restored, so it must clear nothing: an all-clear hangs off a measured
  // healthy result, never off "we did not alert this tick" (#1134, #1152).
  it("never clears or all-clears on the tick a sweep failed", async () => {
    await reportSweepFailures([completion(false), retry(false)]);
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(resolveRecovered).not.toHaveBeenCalled();
  });

  it("all-clears only the sweep that recovered when its sibling is still failing", async () => {
    await reportSweepFailures([completion(true), retry(false)]);
    expect(clearFailureStreak).toHaveBeenCalledTimes(1);
    expect(clearFailureStreak).toHaveBeenCalledWith(COMPLETION_SWEEP_FAILING_KEY);
    expect(resolveRecovered).toHaveBeenCalledTimes(1);
    expect(resolveRecovered.mock.calls[0]![0].map((r) => r.key)).toEqual([
      COMPLETION_SWEEP_FAILING_KEY,
    ]);
  });

  // Monitoring must never take down the lane it watches (L71).
  it("survives a dispatcher that throws", async () => {
    resolveRecovered.mockRejectedValueOnce(new Error("slack down"));
    recordConsecutiveStreak.mockRejectedValueOnce(new Error("rpc down"));
    await expect(reportSweepFailures([completion(true), retry(false)])).resolves.toBeUndefined();
  });
});
