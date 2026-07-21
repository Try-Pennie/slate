import { describe, it, expect, vi, beforeEach } from "vitest";

// #974: the bulk-reassign service wrappers. The store (DB reads/writes) is
// mocked so this exercises only the service composition: startBulkReassign
// resolving the out agent's org and mapping the job input (and its not-found
// branch), previewBulkReassign counting, and getBulkReassignProgress delegating
// to the pure builder with the loaded rows.
const store = vi.hoisted(() => ({
  loadUserOrgId: vi.fn(),
  createBulkReassignJob: vi.fn(),
  coverageBookingIds: vi.fn(),
  loadBulkReassignJob: vi.fn(),
  loadBulkReassignItems: vi.fn(),
  loadActionableBookingContext: vi.fn(),
  // Also imported by service.ts (engine deps); unused here but must exist.
  commitBulkReassignItemOutcome: vi.fn(),
  loadBookingSnapshot: vi.fn(),
  loadPendingBulkReassignItems: vi.fn(),
  markBulkReassignJobDoneIfDrained: vi.fn(),
}));
vi.mock("@/lib/booking/bulk-reassign-store", () => store);

import {
  getBulkReassignProgress,
  previewBulkReassign,
  startBulkReassign,
} from "@/lib/booking/service";
import { AgentNotAvailableError } from "@/lib/booking/orchestration";

const reason = { code: "coverage", detail: null };
const actor = { userId: "mgr1", actingAsUserId: null };

beforeEach(() => vi.clearAllMocks());

describe("startBulkReassign", () => {
  it("resolves the out agent's org and maps the job input", async () => {
    store.loadUserOrgId.mockResolvedValueOnce("org9");
    store.createBulkReassignJob.mockResolvedValueOnce({ jobId: "job1", itemCount: 4 });
    const res = await startBulkReassign({
      outUserId: "out1",
      rangeStartIso: "2026-07-25T00:00:00.000Z",
      rangeEndIso: null,
      reason,
      actor,
    });
    expect(res).toEqual({ jobId: "job1", itemCount: 4 });
    expect(store.createBulkReassignJob).toHaveBeenCalledWith({
      orgId: "org9",
      outUserId: "out1",
      rangeStartIso: "2026-07-25T00:00:00.000Z",
      rangeEndIso: null,
      reasonCode: "coverage",
      reasonDetail: null,
      createdBy: "mgr1",
      actingAsUserId: null,
    });
  });

  it("throws when the out agent does not exist (no job is created)", async () => {
    store.loadUserOrgId.mockResolvedValueOnce(null);
    await expect(
      startBulkReassign({ outUserId: "gone", rangeStartIso: "x", rangeEndIso: null, reason, actor }),
    ).rejects.toBeInstanceOf(AgentNotAvailableError);
    expect(store.createBulkReassignJob).not.toHaveBeenCalled();
  });
});

describe("previewBulkReassign", () => {
  it("returns the count of coverage bookings in range", async () => {
    store.coverageBookingIds.mockResolvedValueOnce(["a", "b", "c"]);
    const n = await previewBulkReassign("out1", "2026-07-25T00:00:00.000Z", null);
    expect(n).toBe(3);
    expect(store.coverageBookingIds).toHaveBeenCalledWith("out1", "2026-07-25T00:00:00.000Z", null);
  });
});

describe("getBulkReassignProgress", () => {
  it("returns null for an unknown job", async () => {
    store.loadBulkReassignJob.mockResolvedValueOnce(null);
    expect(await getBulkReassignProgress("nope")).toBeNull();
    expect(store.loadBulkReassignItems).not.toHaveBeenCalled();
  });

  it("composes job + summary + the actionable list with booking context", async () => {
    store.loadBulkReassignJob.mockResolvedValueOnce({ id: "job1", out_user_id: "out1", status: "active" });
    store.loadBulkReassignItems.mockResolvedValueOnce([
      { id: "i1", job_id: "job1", booking_id: "bkA", status: "moved", target_user_id: "cov", detail: null, attempts: 1 },
      { id: "i2", job_id: "job1", booking_id: "bkB", status: "unplaceable", target_user_id: null, detail: "no agent free", attempts: 1 },
    ]);
    store.loadActionableBookingContext.mockResolvedValueOnce(
      new Map([["bkB", { startsAt: "2026-07-25T17:00:00.000Z", attendeeName: "Kris" }]]),
    );
    const prog = await getBulkReassignProgress("job1");
    expect(prog?.summary.counts.moved).toBe(1);
    expect(prog?.actionable).toEqual([
      {
        bookingId: "bkB",
        status: "unplaceable",
        detail: "no agent free",
        startsAt: "2026-07-25T17:00:00.000Z",
        attendeeName: "Kris",
      },
    ]);
    // Only the actionable booking ids are looked up for display context.
    expect(store.loadActionableBookingContext).toHaveBeenCalledWith(["bkB"]);
  });
});
