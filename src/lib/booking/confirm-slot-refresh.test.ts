import { describe, it, expect, vi, beforeEach } from "vitest";

// #2345: the slot refresh a booking triggers (`invalidateSlots`) was a FLOATING
// promise: `void recomputeBucketSlotsForToday(...)`. That is a whole pool compute,
// seconds of CPU on the load test Worker, started in the MIDDLE of the confirm, so
// it shared the isolate's one thread with the rest of the confirm a lead is waiting
// on, ran on past the response, and was reported by nothing (the load run's per job
// line named only the tally). On Workers a promise still pending when the response
// resolves is not guaranteed to run at all (#191, #503).
//
// These pin both sides of the split: the user-facing paths (which pass a webhook
// scheduler) go through afterResponse under their own name, and the cron drains
// (which pass none) keep the float #503 decided on, because waitUntil there would
// hold the shared minute invocation open for the recompute.

const after = vi.hoisted(() => ({
  afterResponse: vi.fn((_context: string, _work: () => Promise<unknown>) => {}),
  deferWebhookSend: vi.fn(),
}));
vi.mock("@/lib/after-response", () => after);

const slotCache = vi.hoisted(() => ({
  recomputeBucketSlotsForToday: vi.fn(async (_code: string) => {}),
  getBucketSlotsWithFallback: vi.fn(),
  refreshPoolsForAgents: vi.fn(),
}));
vi.mock("@/lib/availability/slot-cache", () => slotCache);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));

import { realDeps } from "./service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a user-facing booking's slot refresh runs after the response (#2345)", () => {
  it("is handed to afterResponse under its own name instead of being started inline", async () => {
    await realDeps(after.deferWebhookSend).invalidateSlots("411");

    expect(after.afterResponse).toHaveBeenCalledTimes(1);
    expect(after.afterResponse.mock.calls[0][0]).toBe("post-confirm-recompute");
    // Nothing has been computed yet: the confirm carries on without sharing its
    // thread with a pool compute.
    expect(slotCache.recomputeBucketSlotsForToday).not.toHaveBeenCalled();

    await after.afterResponse.mock.calls[0][1]();
    expect(slotCache.recomputeBucketSlotsForToday).toHaveBeenCalledWith("411");
  });

  it("lets a failed refresh REJECT, so afterResponse logs it and its profile says it failed", async () => {
    slotCache.recomputeBucketSlotsForToday.mockRejectedValueOnce(new Error("bucket_slots write refused"));

    await realDeps(after.deferWebhookSend).invalidateSlots("411");
    const work = after.afterResponse.mock.calls[0][1];

    // Swallowing it here would have the per job profile report a failed refresh as
    // a free one (L515), and the warning afterResponse writes is the trace (#1049).
    await expect(work()).rejects.toThrow(/write refused/);
  });
});

describe("a cron drain's slot refresh keeps the #503 float", () => {
  it("starts the recompute directly and never asks waitUntil to hold the lane open", async () => {
    await realDeps().invalidateSlots("411");

    expect(after.afterResponse).not.toHaveBeenCalled();
    expect(slotCache.recomputeBucketSlotsForToday).toHaveBeenCalledWith("411");
  });

  it("does not let a failed float reach the drain", async () => {
    slotCache.recomputeBucketSlotsForToday.mockRejectedValueOnce(new Error("refused"));

    await expect(realDeps().invalidateSlots("411")).resolves.toBeUndefined();
  });
});
