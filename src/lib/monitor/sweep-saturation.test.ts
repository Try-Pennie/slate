import { describe, it, expect, vi, beforeEach } from "vitest";

// #726 wiring: turning one tick's drain count into (clear streak | count it | page).
// The streak counter and the alert dispatcher are mocked; what is under test is the
// decision, which is where the silent-backlog bug lived.
const recordConsecutiveStreak = vi.hoisted(() => vi.fn(async () => false));
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);

const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));

import {
  reportSweepSaturation,
  reportCompletionSaturation,
  reportDeletionSaturation,
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

  // #1134: an under-cap tick is the sweep keeping up, which is what recovery
  // looks like from the inside. Crucially this path IS reachable when healthy:
  // a recovery gated on the sweep still being saturated could never fire.
  it("says the backlog cleared when a tick comes back under its cap", async () => {
    await run(3);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(KEY);
    expect(text).toContain("cancelled-block reconcile");
    expect(text).toMatch(/caught up|cleared|keeping up/i);
    // The all-clear must not repeat the remediation from the page it clears.
    expect(text).not.toMatch(/raise the per tick cap/i);
  });

  // THE failure path. A sweep that threw says nothing about the backlog, so it
  // must not announce recovery any more than it counts as saturation.
  it("never announces recovery when the sweep itself failed", async () => {
    await run(null);
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("does not throw when the recovery notice fails to send", async () => {
    resolveAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(run(3)).resolves.toBeUndefined();
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

  it("says the backlog cleared when a run drains inside its budget", async () => {
    await crun(false);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(CKEY);
    expect(text).toContain("completion sweep");
    // The page warned that finished bookings were still counting as upcoming, so
    // the all-clear has to answer that specific worry.
    expect(text).toMatch(/counting as upcoming/i);
  });

  it("never announces recovery when the run's verdict is unknown", async () => {
    await crun(null);
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});

// #888: the deletion drain loads a page of up to `limit` rows and attempts every
// one, so its saturation signal is the size of the page it LOADED (deleted +
// failed), not the number it managed to delete. The reporter owns that sum on
// purpose: see the all-failed case below for why a caller must never decide it.
describe("reportDeletionSaturation (#888)", () => {
  const DKEY = "deletion_drain_saturated";
  const DLIMIT = 20;
  const drun = (drain: { deleted: number; failed: number } | null) =>
    reportDeletionSaturation(DKEY, drain, DLIMIT);

  it("clears the streak when a tick drains a partial page", async () => {
    await drun({ deleted: 3, failed: 1 });
    expect(clearFailureStreak).toHaveBeenCalledWith(DKEY);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("counts a full page toward the streak without paging yet", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    await drun({ deleted: DLIMIT, failed: 0 });
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      DKEY,
      SATURATION_WINDOW_SECONDS,
      SATURATION_ALERT_AFTER_TICKS,
    );
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("pages once the saturated streak is sustained", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await drun({ deleted: DLIMIT, failed: 0 });
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const body = sendThrottledAlert.mock.calls[0][2];
    expect(body).toContain("deletion");
    expect(body).toContain(String(DLIMIT));
  });

  // THE failure path this issue exists for. Every row in a full page failing is
  // the WORST case: the backlog cannot drain at all. Keying saturation off the
  // delete count alone would read deleted=0, call the tick healthy, and clear the
  // streak on exactly the ticks where the queue is most stuck.
  it("counts a full page of failures as saturated, not as a drained backlog", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await drun({ deleted: 0, failed: DLIMIT });
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).toHaveBeenCalledWith(
      DKEY,
      SATURATION_WINDOW_SECONDS,
      SATURATION_ALERT_AFTER_TICKS,
    );
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  // A mixed full page is still a full page: the loader had at least `limit` rows.
  it("counts a mixed full page as saturated", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    await drun({ deleted: 12, failed: 8 });
    expect(recordConsecutiveStreak).toHaveBeenCalledTimes(1);
    expect(clearFailureStreak).not.toHaveBeenCalled();
  });

  // A drain that THREW says nothing about the backlog: never counted, never cleared.
  it("neither counts nor clears when the drain itself failed", async () => {
    await drun(null);
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("does not throw when the alert dispatch fails", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    sendThrottledAlert.mockRejectedValueOnce(new Error("slack down"));
    await expect(drun({ deleted: DLIMIT, failed: 0 })).resolves.toBeUndefined();
  });

  it("says the queue cleared when a tick drains a partial page", async () => {
    await drun({ deleted: 3, failed: 1 });
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const [key, text] = resolveAlert.mock.calls[0];
    expect(key).toBe(DKEY);
    expect(text).toMatch(/deletion/i);
  });

  // The all-failed page is saturated, so it must never all-clear either. This is
  // the same trap as the streak: deleted=0 looks like a quiet tick.
  it("never announces recovery on a full page that failed every row", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    await drun({ deleted: 0, failed: DLIMIT });
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("never announces recovery when the drain itself failed", async () => {
    await drun(null);
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});
