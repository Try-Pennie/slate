import { describe, it, expect, vi, beforeEach } from "vitest";

// #1239: the two coverage bindings the manager's notice depends on. The
// orchestration suite drives these as in-memory fakes, so it proves what the flow
// does with an answer and nothing about whether the real binding produces that
// answer (L3: built is not wired).
//
// The one that matters is the failure path. `previewBulkReassign` throws on a read
// error, and a binding that let that become 0 would put the notice into its SILENT
// state, which a manager reads as "nothing will move" on the screen where they are
// deciding whether to approve.
const booking = vi.hoisted(() => ({
  previewBulkReassign: vi.fn(),
  startBulkReassign: vi.fn(),
  stopCoverageSweepForRequest: vi.fn(),
}));
vi.mock("@/lib/booking/service", () => booking);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { realDeps } from "@/lib/ooo/service";

beforeEach(() => vi.clearAllMocks());

describe("countCoverageBookings (the pending notice's count)", () => {
  it("passes the measured count through", async () => {
    booking.previewBulkReassign.mockResolvedValueOnce(4);

    const count = await realDeps().countCoverageBookings({
      outUserId: "u1",
      startIso: "2026-09-01T13:00:00Z",
      endIso: "2026-09-01T21:00:00Z",
    });

    expect(count).toBe(4);
    expect(booking.previewBulkReassign).toHaveBeenCalledWith(
      "u1",
      "2026-09-01T13:00:00Z",
      "2026-09-01T21:00:00Z",
    );
  });

  it("answers null, never 0, when the count cannot be read", async () => {
    booking.previewBulkReassign.mockRejectedValueOnce(new Error("PostgREST said no"));

    const count = await realDeps().countCoverageBookings({
      outUserId: "u1",
      startIso: "2026-09-01T13:00:00Z",
      endIso: "2026-09-01T21:00:00Z",
    });

    expect(count).toBeNull();
    expect(count).not.toBe(0);
  });
});

describe("startCoverageSweep (what the approved edit reports)", () => {
  it("describes the rows the sweep actually snapshotted", async () => {
    booking.startBulkReassign.mockResolvedValueOnce({
      jobId: "job1",
      itemCount: 2,
      snapshot: [
        {
          id: "bk1",
          starts_at: "2026-09-01T14:00:00Z",
          ends_at: "2026-09-01T14:30:00Z",
          attendee_name: "Jane Smith",
        },
        {
          id: "bk2",
          starts_at: "2026-09-01T16:00:00Z",
          ends_at: "2026-09-01T16:30:00Z",
          attendee_name: null,
        },
      ],
    });

    const outcome = await realDeps().startCoverageSweep({
      requestId: "r1",
      outUserId: "u1",
      startIso: "2026-09-01T13:00:00Z",
      endIso: "2026-09-01T21:00:00Z",
      createdBy: "mgr1",
    });

    expect(outcome.queued).toBe(2);
    expect(outcome.moves).toEqual([
      {
        startsAtIso: "2026-09-01T14:00:00Z",
        endsAtIso: "2026-09-01T14:30:00Z",
        attendeeName: "Jane Smith",
      },
      {
        startsAtIso: "2026-09-01T16:00:00Z",
        endsAtIso: "2026-09-01T16:30:00Z",
        attendeeName: null,
      },
    ]);
  });
});

describe("stopCoverageSweep (what cancelling reports)", () => {
  it("passes the two counts through, keyed on the request", async () => {
    booking.stopCoverageSweepForRequest.mockResolvedValueOnce({
      jobs: 1,
      stopped: 2,
      alreadyMoved: 3,
    });

    const outcome = await realDeps().stopCoverageSweep({ requestId: "r1" });

    expect(booking.stopCoverageSweepForRequest).toHaveBeenCalledWith("r1");
    expect(outcome).toEqual({ stopped: 2, alreadyMoved: 3 });
  });

  it("lets a failure THROW rather than answering a stop that never happened", async () => {
    // The orchestration catches this, pages, and tells the reader it could not be
    // confirmed. A binding that swallowed it here would answer `stopped: 0`, which
    // reads exactly like a sweep that had nothing left to stop, on the one message
    // saying whether customers are still being handed to other advisors.
    booking.stopCoverageSweepForRequest.mockRejectedValueOnce(new Error("PostgREST said no"));

    await expect(realDeps().stopCoverageSweep({ requestId: "r1" })).rejects.toThrow(
      /PostgREST said no/,
    );
  });
});
