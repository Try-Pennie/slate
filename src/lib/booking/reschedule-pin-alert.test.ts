import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AbandonedPinSweep, StrandedInvite } from "./orchestration";

// #757: the abandoned-reschedule-pin sweep used to clean up in total silence, so a
// reschedule that crashed and was never retried simply vanished: the booking stayed
// at its ORIGINAL time and nobody was told. Its sibling (the #518 reassign-intent
// sweep) already alerts on a genuinely-lost reassign. This pins the same fail-loud
// posture on the reschedule sweep, and, just as importantly, pins the case where it
// must STAY quiet, because an alert that cries wolf gets ignored.

const sweep = (over: Partial<AbandonedPinSweep>): AbandonedPinSweep => ({
  swept: 0,
  enqueued: 0,
  dropped: 0,
  invitesPutBack: 0,
  strandedInvites: [],
  ...over,
});

const processAbandonedReschedulePins = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn(async (_k: string, _ms: number, _msg: string) => {}));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: alert }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  appUrl: () => "https://slate.test",
}));
vi.mock("@/lib/booking/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/orchestration")>()),
  processAbandonedReschedulePins,
}));

import { sweepAbandonedReschedulePins } from "./service";

const STRANDED: StrandedInvite = {
  bookingId: "bk-7",
  advisorEmail: "dana@x.test",
  bookedStartsAt: "2026-10-19T20:05:00.000Z",
  targetStartsAt: "2026-10-20T14:00:00.000Z",
  inviteStartsAt: "2026-10-20T14:00:00.000Z",
  reason: "refused",
  detail: "403 forbiddenForNonOrganizer",
};

beforeEach(() => {
  vi.clearAllMocks();
  processAbandonedReschedulePins.mockResolvedValue(sweep({}));
});

describe("sweepAbandonedReschedulePins", () => {
  it("alerts when it cleans up a reschedule that was genuinely lost", async () => {
    processAbandonedReschedulePins.mockResolvedValue(sweep({ swept: 3, enqueued: 1, dropped: 2 }));

    await sweepAbandonedReschedulePins();

    expect(alert).toHaveBeenCalledOnce();
    const message = String(alert.mock.calls[0][2]);
    expect(message).toContain("2");
    // The alert has to say what state the booking is in, or it is not actionable:
    // the meeting is still at its ORIGINAL time and the move has to be re-run.
    expect(message).toMatch(/original/i);
    expect(message).not.toMatch(/moved it back/);
  });

  it("stays quiet when the sweep only freed stale locks and dropped nothing", async () => {
    processAbandonedReschedulePins.mockResolvedValue(sweep({ swept: 5, enqueued: 2, dropped: 0 }));

    await sweepAbandonedReschedulePins();

    expect(alert).not.toHaveBeenCalled();
  });

  it("survives a failing alert: the notify path cannot break the sweep lane", async () => {
    const result = sweep({ swept: 1, enqueued: 0, dropped: 1 });
    processAbandonedReschedulePins.mockResolvedValue(result);
    alert.mockRejectedValueOnce(new Error("slack down") as never);

    await expect(sweepAbandonedReschedulePins()).resolves.toEqual(result);
  });

  // #3924: the lead was emailed the crashed move's time and then the original one,
  // which whoever re-runs the move needs to know.
  it("says when a lost move's lead invite was put back", async () => {
    processAbandonedReschedulePins.mockResolvedValue(sweep({ swept: 1, dropped: 1, invitesPutBack: 1 }));

    await sweepAbandonedReschedulePins();

    expect(alert).toHaveBeenCalledOnce();
    expect(String(alert.mock.calls[0][2])).toMatch(/moved it back to the original time and the lead was emailed/);
  });

  it("posts each invite it could not put back on its own key, naming the booking", async () => {
    processAbandonedReschedulePins.mockResolvedValue(
      sweep({
        swept: 2,
        dropped: 2,
        strandedInvites: [STRANDED, { ...STRANDED, bookingId: "bk-8", reason: "unreadable", inviteStartsAt: null }],
      }),
    );

    await sweepAbandonedReschedulePins();

    const stranded = alert.mock.calls.filter((c) => String(c[0]).startsWith("reschedule_invite_stranded:"));
    expect(stranded.map((c) => c[0])).toEqual([
      `reschedule_invite_stranded:bk-7:${Date.parse(STRANDED.targetStartsAt)}`,
      `reschedule_invite_stranded:bk-8:${Date.parse(STRANDED.targetStartsAt)}`,
    ]);
    expect(String(stranded[0][2])).toContain("403 forbiddenForNonOrganizer");
    expect(String(stranded[0][2])).toContain("https://slate.test/admin/bookings/bk-7");
    expect(String(stranded[1][2])).toContain("could not read the invite");
  });

  it("a stranded invite whose post fails does not stop the next one being posted", async () => {
    processAbandonedReschedulePins.mockResolvedValue(
      sweep({ swept: 2, strandedInvites: [STRANDED, { ...STRANDED, bookingId: "bk-8" }] }),
    );
    alert.mockRejectedValueOnce(new Error("slack down") as never);

    await expect(sweepAbandonedReschedulePins()).resolves.toBeDefined();
    expect(alert).toHaveBeenCalledTimes(2);
  });
});
