import { describe, it, expect, vi, beforeEach } from "vitest";

// #757: the abandoned-reschedule-pin sweep used to clean up in total silence, so a
// reschedule that crashed and was never retried simply vanished: the booking stayed
// at its ORIGINAL time and nobody was told. Its sibling (the #518 reassign-intent
// sweep) already alerts on a genuinely-lost reassign. This pins the same fail-loud
// posture on the reschedule sweep, and, just as importantly, pins the case where it
// must STAY quiet, because an alert that cries wolf gets ignored.

const processAbandonedReschedulePins = vi.hoisted(() =>
  vi.fn(async () => ({ swept: 0, enqueued: 0, dropped: 0 })),
);
const alert = vi.hoisted(() => vi.fn(async (_k: string, _ms: number, _msg: string) => {}));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: alert }));
vi.mock("@/lib/booking/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/orchestration")>()),
  processAbandonedReschedulePins,
}));

import { sweepAbandonedReschedulePins } from "./service";

beforeEach(() => {
  vi.clearAllMocks();
  processAbandonedReschedulePins.mockResolvedValue({ swept: 0, enqueued: 0, dropped: 0 });
});

describe("sweepAbandonedReschedulePins", () => {
  it("alerts when it cleans up a reschedule that was genuinely lost", async () => {
    processAbandonedReschedulePins.mockResolvedValue({ swept: 3, enqueued: 1, dropped: 2 });

    await sweepAbandonedReschedulePins();

    expect(alert).toHaveBeenCalledOnce();
    const message = String(alert.mock.calls[0][2]);
    expect(message).toContain("2");
    // The alert has to say what state the booking is in, or it is not actionable:
    // the meeting is still at its ORIGINAL time and the move has to be re-run.
    expect(message).toMatch(/original/i);
  });

  it("stays quiet when the sweep only freed stale locks and dropped nothing", async () => {
    processAbandonedReschedulePins.mockResolvedValue({ swept: 5, enqueued: 2, dropped: 0 });

    await sweepAbandonedReschedulePins();

    expect(alert).not.toHaveBeenCalled();
  });

  it("survives a failing alert: the notify path cannot break the sweep lane", async () => {
    processAbandonedReschedulePins.mockResolvedValue({ swept: 1, enqueued: 0, dropped: 1 });
    alert.mockRejectedValueOnce(new Error("slack down") as never);

    await expect(sweepAbandonedReschedulePins()).resolves.toEqual({
      swept: 1,
      enqueued: 0,
      dropped: 1,
    });
  });
});
